#!/usr/bin/env python3
"""Mochi 同步服务的端到端测试。

在临时数据目录里起一个真实的服务进程，跑完整链路，结束后清理。
不碰正式数据。

    python3 test_server.py
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

PORT = 39217
BASE = f"http://127.0.0.1:{PORT}"
INVITE = "test-invite-code"
HERE = Path(__file__).parent

passed = failed = 0


def chk(name, cond, info=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"  PASS  {name}" + (f"  {info}" if info else ""))
    else:
        failed += 1
        print(f"  FAIL  {name}" + (f"  {info}" if info else ""))


def call(method, path, body=None, token=None, raw=None, ctype="application/json"):
    """返回 (status, 解析后的 body)。HTTP 错误也返回而不是抛异常。"""
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(BASE + path, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", ctype)
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            payload = r.read()
            ct = r.headers.get("Content-Type", "")
            return r.status, (json.loads(payload) if "json" in ct else payload)
    except urllib.error.HTTPError as e:
        payload = e.read()
        try:
            return e.code, json.loads(payload)
        except json.JSONDecodeError:
            return e.code, payload


def main():
    tmp = tempfile.mkdtemp(prefix="mochi-test-")
    env = {**os.environ, "MOCHI_DATA": tmp, "MOCHI_PORT": str(PORT),
           "MOCHI_INVITE_CODE": INVITE, "MOCHI_ORIGINS": "https://semon-guo.github.io,http://localhost:5173"}
    proc = subprocess.Popen([sys.executable, str(HERE / "mochi_server.py")], env=env,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        # 等服务起来
        for _ in range(50):
            try:
                if call("GET", "/api/health")[0] == 200:
                    break
            except Exception:
                time.sleep(0.1)
        else:
            out = proc.stdout.read() if proc.poll() is not None else "(仍在运行但不响应)"
            print("服务启动失败:\n", out)
            return 1

        print("\n── 认证 ──")
        s, r = call("GET", "/api/health")
        chk("健康检查", s == 200 and r.get("ok") is True)

        s, r = call("POST", "/api/register", {"username": "prof", "password": "prof-passwd-1",
                                              "displayName": "导师", "inviteCode": INVITE})
        chk("注册一律是学生，不能靠抢注拿到导师权限", s == 200 and r["user"]["role"] == "student",
            r.get("user", {}).get("role"))

        # 导师角色只能在服务器上授予（set_role.py 走数据库，不经过接口）
        rc = subprocess.run([sys.executable, str(HERE / "set_role.py"), "prof", "advisor"],
                            env=env, capture_output=True, text=True)
        chk("set_role.py 能授予导师角色", rc.returncode == 0, rc.stdout.strip() or rc.stderr.strip())
        s, r = call("POST", "/api/login", {"username": "prof", "password": "prof-passwd-1"})
        advisor = r.get("token")
        chk("授予后登录拿到导师身份", s == 200 and r["user"]["role"] == "advisor",
            r.get("user", {}).get("role"))

        s, r = call("POST", "/api/register", {"username": "stu1", "password": "stu1-passwd-1", "displayName": "学生甲"})
        chk("没有邀请码注册被拒", s == 403, f"HTTP {s}")

        s, r = call("POST", "/api/register",
                    {"username": "stu1", "password": "stu1-passwd-1", "displayName": "学生甲", "inviteCode": INVITE})
        stu1 = r.get("token")
        chk("带邀请码注册成功且是学生", s == 200 and r["user"]["role"] == "student", r.get("user", {}).get("role"))

        s, r = call("POST", "/api/register",
                    {"username": "stu2", "password": "stu2-passwd-1", "displayName": "学生乙", "inviteCode": INVITE})
        stu2 = r.get("token")
        chk("第二个学生注册成功", s == 200)

        s, r = call("POST", "/api/register",
                    {"username": "stu1", "password": "another-passwd", "inviteCode": INVITE})
        chk("重复用户名被拒", s == 409, f"HTTP {s}")

        s, r = call("POST", "/api/register", {"username": "x", "password": "short", "inviteCode": INVITE})
        chk("弱密码/短用户名被拒", s == 400, f"HTTP {s}")

        s, r = call("POST", "/api/login", {"username": "stu1", "password": "wrong-password"})
        chk("密码错误被拒", s == 401, f"HTTP {s}")

        s, r = call("POST", "/api/login", {"username": "stu1", "password": "stu1-passwd-1"})
        chk("登录成功", s == 200 and "token" in r)

        s, r = call("GET", "/api/sync")
        chk("未登录访问同步接口 → 401", s == 401, f"HTTP {s}")

        print("\n── 暴力破解防护 ──")
        for i in range(8):
            call("POST", "/api/login", {"username": "stu2", "password": f"guess{i}"})
        s, r = call("POST", "/api/login", {"username": "stu2", "password": f"guess-more"})
        chk("连续失败后被限速锁定", s == 429, f"HTTP {s} {r.get('error','')}")
        s, r = call("POST", "/api/login", {"username": "stu2", "password": "stu2-passwd-1"})
        chk("锁定期内正确密码也拒绝（防绕过）", s == 429, f"HTTP {s}")
        s, r = call("POST", "/api/register", {"username": "sneaky", "password": "sneaky-pass-1", "inviteCode": "wrong"})
        chk("错误邀请码也被限速计数", s in (403, 429), f"HTTP {s}")

        print("\n── 同步 ──")
        now = int(time.time() * 1000)
        s, r = call("POST", "/api/sync", {
            "projects": [{"id": "p1", "updatedAt": now, "data": {"name": "编码孔径成像"}}],
            "records": [{"id": "r1", "updatedAt": now, "data": {"projectId": "p1", "text": "标定完成", "weather": "晴"}}],
        }, token=stu1)
        chk("学生推送记录", s == 200 and r["applied"] == 2, f"applied={r.get('applied')}")
        seq_after_push = r.get("seq")

        s, r = call("GET", "/api/sync?since=0", token=stu1)
        chk("学生拉回自己的记录", s == 200 and len(r["projects"]) == 1 and len(r["records"]) == 1)
        chk("记录内容正确", r["records"][0]["data"]["text"] == "标定完成", r["records"][0]["data"].get("text"))

        s, r = call("GET", f"/api/sync?since={seq_after_push}", token=stu1)
        chk("增量拉取不重复返回", s == 200 and not r["projects"] and not r["records"])

        s, r = call("GET", "/api/sync?since=0", token=stu2)
        chk("学生乙看不到学生甲的记录", s == 200 and not r["projects"] and not r["records"],
            f"projects={len(r.get('projects', []))} records={len(r.get('records', []))}")

        s, r = call("GET", "/api/sync?since=0", token=advisor)
        chk("导师能看到学生的记录", s == 200 and len(r["projects"]) == 1 and len(r["records"]) == 1,
            f"projects={len(r.get('projects', []))} records={len(r.get('records', []))}")
        chk("导师看到的记录带 ownerId", r["records"][0].get("ownerId") is not None)

        print("\n── 冲突与权限 ──")
        s, r = call("POST", "/api/sync",
                    {"records": [{"id": "r1", "updatedAt": now - 1000, "data": {"text": "旧版本"}}]}, token=stu1)
        chk("更旧的改动被跳过（LWW）", s == 200 and r["skipped"] == 1 and r["applied"] == 0,
            f"applied={r.get('applied')} skipped={r.get('skipped')}")

        s, r = call("GET", "/api/sync?since=0", token=stu1)
        chk("旧改动没有覆盖新内容", r["records"][0]["data"]["text"] == "标定完成")

        s, r = call("POST", "/api/sync",
                    {"records": [{"id": "r1", "updatedAt": now + 5000, "data": {"text": "补充了暗场校正"}}]}, token=stu1)
        chk("更新的改动被接受", s == 200 and r["applied"] == 1)

        s, r = call("POST", "/api/sync",
                    {"records": [{"id": "r1", "updatedAt": now + 9999, "data": {"text": "别人乱改"}}]}, token=stu2)
        chk("学生乙不能改学生甲的记录", s == 200 and r["applied"] == 0 and len(r["rejected"]) == 1,
            str(r.get("rejected")))

        s, r = call("POST", "/api/sync",
                    {"records": [{"id": "r1", "updatedAt": now + 99999, "data": {"text": "导师改学生的"}}]}, token=advisor)
        chk("导师也不能改学生的记录（只读）", s == 200 and r["applied"] == 0 and len(r["rejected"]) == 1)

        s, r = call("GET", "/api/sync?since=0", token=stu1)
        chk("记录内容未被他人篡改", r["records"][0]["data"]["text"] == "补充了暗场校正",
            r["records"][0]["data"].get("text"))

        print("\n── 删除墓碑 ──")
        s, r = call("POST", "/api/sync",
                    {"records": [{"id": "r1", "updatedAt": now + 20000, "deletedAt": now + 20000}]}, token=stu1)
        chk("删除被接受", s == 200 and r["applied"] == 1)
        s, r = call("GET", "/api/sync?since=0", token=stu1)
        chk("删除以墓碑形式同步（data 为 null）",
            len(r["records"]) == 1 and r["records"][0]["data"] is None and r["records"][0]["deletedAt"],
            str(r["records"][0].get("deletedAt")))

        print("\n── 照片 ──")
        s, r = call("POST", "/api/photo/ph1", raw=b"\xff\xd8\xff\xe0fake-jpeg", token=stu1, ctype="image/jpeg")
        chk("元数据不存在时不能上传照片", s == 404, f"HTTP {s}")

        s, r = call("POST", "/api/sync",
                    {"photos": [{"id": "ph1", "updatedAt": now, "data": {}}]}, token=stu1)
        chk("先同步照片元数据", s == 200 and r["applied"] == 1)

        blob = b"\xff\xd8\xff\xe0" + b"fake-jpeg-content" * 10
        s, r = call("POST", "/api/photo/ph1", raw=blob, token=stu1, ctype="image/jpeg")
        chk("上传照片二进制", s == 200 and r.get("size") == len(blob), f"size={r.get('size')}")

        s, r = call("GET", "/api/photo/ph1", token=stu1)
        chk("本人能下载照片", s == 200 and r == blob)

        s, r = call("GET", "/api/photo/ph1", token=advisor)
        chk("导师能下载学生的照片", s == 200 and r == blob)

        s, r = call("GET", "/api/photo/ph1", token=stu2)
        chk("其他学生不能下载", s == 404, f"HTTP {s}")

        s, r = call("POST", "/api/photo/ph1", raw=b"hijack", token=stu2, ctype="image/jpeg")
        chk("其他学生不能覆盖上传", s == 403, f"HTTP {s}")

        print("\n── 待办：同步但导师不可见 ──")
        s, r = call("POST", "/api/sync", {
            "todos": [{"id": "td1", "updatedAt": now, "data": {
                "text": "跑柱子", "elapsed": 3600,
                "timeline": [{"type": "start", "at": now}, {"type": "pause", "at": now + 60}]}}],
        }, token=stu1)
        chk("学生能同步自己的待办", s == 200 and r["applied"] == 1, f"applied={r.get('applied')}")

        s, r = call("GET", "/api/sync?since=0", token=stu1)
        chk("本人拉得回自己的待办", len(r.get("todos", [])) == 1, f"n={len(r.get('todos', []))}")
        chk("待办内容完整（含计时）", r["todos"][0]["data"].get("elapsed") == 3600)

        s, r = call("GET", "/api/sync?since=0", token=advisor)
        chk("导师看不到学生的待办", len(r.get("todos", [])) == 0, f"n={len(r.get('todos', []))}")
        chk("但导师仍看得到实验记录", len(r.get("records", [])) >= 1, f"n={len(r.get('records', []))}")

        s, r = call("GET", "/api/sync?since=0", token=stu2)
        chk("其他学生也看不到", len(r.get("todos", [])) == 0, f"n={len(r.get('todos', []))}")

        s, r = call("POST", "/api/sync",
                    {"todos": [{"id": "td1", "updatedAt": now + 999, "data": {"text": "改别人的待办"}}]},
                    token=advisor)
        chk("导师不能改学生的待办", r["applied"] == 0 and len(r["rejected"]) == 1)

        print("\n── 导师视角 ──")
        s, r = call("GET", "/api/users", token=advisor)
        chk("导师能列出成员", s == 200 and len(r["users"]) == 3, f"n={len(r.get('users', []))}")
        s, r = call("GET", "/api/users", token=stu1)
        chk("学生不能列出成员", s == 403, f"HTTP {s}")

        print(f"\n{'='*46}\n通过 {passed} 项，失败 {failed} 项\n{'='*46}")
        return 1 if failed else 0
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
