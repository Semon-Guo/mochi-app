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
           "MOCHI_INVITE_CODE": INVITE,
           "MOCHI_ORIGINS": "https://semon-guo.github.io,http://localhost:5173"}
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

        print("\n── 推送订阅与提醒 ──")
        s, r = call("GET", "/api/health")
        chk("健康检查报告推送状态", "push" in r, f"push={r.get('push')}")
        push_on = r.get("push")

        s, r = call("GET", "/api/push/key")
        chk("能取到 VAPID 公钥", s == 200 and (r.get("key") or not push_on),
            f"enabled={r.get('enabled')}")
        if push_on:
            import base64 as _b64
            chk("公钥是 65 字节未压缩点",
                len(_b64.urlsafe_b64decode(r["key"] + "=" * (-len(r["key"]) % 4))) == 65)

        FAKE_SUB = {"endpoint": "https://web.push.apple.com/fake-endpoint-aaa",
                    "keys": {"p256dh": "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
                             "auth": "BTBZMqHH6r4Tts7J_aSIgg"}}
        s, r = call("POST", "/api/push/subscribe", {"subscription": FAKE_SUB})
        chk("未登录不能订阅", s == 401, f"HTTP {s}")

        s, r = call("POST", "/api/push/subscribe", {"subscription": FAKE_SUB}, token=stu1)
        chk("登录后可订阅", s == 200 and r.get("ok"), f"HTTP {s}")
        sub_id = r.get("id")
        s, r = call("POST", "/api/push/subscribe", {"subscription": FAKE_SUB}, token=stu1)
        chk("同一 endpoint 重复订阅不会堆积", r.get("id") == sub_id)

        s, r = call("POST", "/api/push/subscribe", {"subscription": {"endpoint": "http://x", "keys": {}}}, token=stu1)
        chk("残缺的订阅被拒", s == 400, f"HTTP {s}")

        s, r = call("POST", "/api/reminders", {"reminders": [
            {"id": "td1", "dueAt": now + 3600_000, "title": "⏰ 跑柱子", "body": "主线 · 预期 60m"},
            {"id": "td9", "dueAt": now + 7200_000, "title": "⏰ 写综述"},
        ]}, token=stu1)
        chk("上传提醒", s == 200 and r.get("count") == 2, f"count={r.get('count')}")

        s, r = call("POST", "/api/reminders", {"reminders": [
            {"id": "td1", "dueAt": now + 3600_000, "title": "⏰ 跑柱子"},
        ]}, token=stu1)
        chk("全量替换：删掉的提醒不再保留", s == 200 and r.get("count") == 1, f"count={r.get('count')}")

        s, r = call("POST", "/api/reminders", {"reminders": [{"id": "bad"}]}, token=stu1)
        chk("缺少 dueAt 的条目被跳过", s == 200 and r.get("count") == 0, f"count={r.get('count')}")

        s, r = call("POST", "/api/push/test", {}, token=stu2)
        chk("没订阅的用户测试推送会明确报错", s in (400, 503), f"HTTP {s}")

        s, r = call("POST", "/api/push/unsubscribe", {"endpoint": FAKE_SUB["endpoint"]}, token=stu1)
        chk("可以退订", s == 200 and r.get("ok"))

        # Apple 会校验 VAPID 的 sub：mailto:...@*.invalid 会被 403 BadJwtToken 拒掉
        import subprocess as _sp
        _out = _sp.run([sys.executable, "-c",
                        "import sys; sys.path.insert(0,'.'); "
                        "import mochi_server as m; print(m.VAPID_SUBJECT)"],
                       capture_output=True, text=True, cwd=str(HERE), env=env).stdout.strip()
        chk("VAPID sub 不是会被推送服务拒绝的 .invalid 域名",
            ".invalid" not in _out and (_out.startswith("https://") or _out.startswith("mailto:")), _out)

        print("\n── keep-alive 连接不会被未读的请求体污染 ──")
        # 有的处理分支不看请求体，残留字节会被当成下一个请求的起始行（曾导致 501）
        for _ in range(3):
            call("POST", "/api/push/test", {"noise": "x" * 200}, token=stu1)
        s, r = call("GET", "/api/health")
        chk("连发几个带 body 的请求后接口仍正常", s == 200 and r.get("ok") is True, f"HTTP {s}")
        s, r = call("GET", "/api/me", token=stu1)
        chk("认证接口也未受影响", s == 200, f"HTTP {s}")

        print("\n── 管理员任命角色 ──")
        subprocess.run([sys.executable, str(HERE / "set_role.py"), "prof", "admin"],
                       env=env, capture_output=True, text=True)
        s, r = call("POST", "/api/login", {"username": "prof", "password": "prof-passwd-1"})
        admin = r.get("token")
        chk("管理员登录", s == 200 and r["user"]["role"] == "admin", r.get("user", {}).get("role"))

        s, r = call("POST", "/api/register", {"username": "prof2", "password": "prof2-passwd-1",
                                              "displayName": "待任命", "inviteCode": INVITE})
        prof2_id = r["user"]["id"]
        chk("注册一律是学生（导师码已取消）", r["user"]["role"] == "student", r["user"]["role"])

        s, r = call("POST", "/api/admin/role", {"userId": prof2_id, "role": "advisor"}, token=stu1)
        chk("非管理员不能任命", s == 403, f"HTTP {s}")

        s, r = call("POST", "/api/admin/role", {"userId": prof2_id, "role": "advisor"}, token=admin)
        chk("管理员直接任命为导师", s == 200 and r["user"]["role"] == "advisor", r["user"]["role"])

        s, r = call("POST", "/api/login", {"username": "prof2", "password": "prof2-passwd-1"})
        prof2 = r.get("token")
        s, r = call("GET", "/api/overview", token=prof2)
        chk("任命后立即拿到全组读取权限", s == 200 and "members" in r, f"HTTP {s}")

        s, r = call("POST", "/api/admin/role", {"userId": prof2_id, "role": "student"}, token=admin)
        chk("能收回为学生", s == 200 and r["user"]["role"] == "student")

        me = call("GET", "/api/me", token=admin)[1]["user"]
        s, r = call("POST", "/api/admin/role", {"userId": me["id"], "role": "student"}, token=admin)
        chk("不能修改自己的角色（否则会把自己锁在门外）", s == 403, f"HTTP {s}")
        s, r = call("POST", "/api/admin/role", {"userId": "nonexistent", "role": "advisor"}, token=admin)
        chk("对不存在的用户报 404", s == 404, f"HTTP {s}")

        print("\n── 重置密码与吊销会话 ──")
        s, r = call("POST", "/api/admin/reset-password", {"userId": prof2_id}, token=stu1)
        chk("非管理员不能重置密码", s == 403, f"HTTP {s}")
        s, r = call("POST", "/api/admin/reset-password", {"userId": prof2_id}, token=admin)
        temp = r.get("tempPassword")
        chk("管理员重置出临时密码", s == 200 and len(temp or "") >= 8, f"len={len(temp or '')}")
        s, r = call("GET", "/api/me", token=prof2)
        chk("重置后旧会话立即失效", s == 401, f"HTTP {s}")
        s, r = call("POST", "/api/login", {"username": "prof2", "password": temp})
        prof2 = r.get("token")
        chk("能用临时密码登录", s == 200, f"HTTP {s}")

        s, r = call("POST", "/api/password", {"oldPassword": "wrong", "newPassword": "brand-new-1"},
                    token=prof2)
        chk("改密码要验旧密码", s == 401, f"HTTP {s}")
        s, r = call("POST", "/api/password", {"oldPassword": temp, "newPassword": "short"}, token=prof2)
        chk("新密码太短被拒", s == 400, f"HTTP {s}")
        s, r = call("POST", "/api/password", {"oldPassword": temp, "newPassword": "brand-new-pass-1"},
                    token=prof2)
        chk("本人能改密码", s == 200 and r.get("ok"))
        s, r = call("POST", "/api/login", {"username": "prof2", "password": "brand-new-pass-1"})
        prof2 = r.get("token")
        chk("新密码可用", s == 200)

        s, r = call("POST", "/api/admin/revoke-sessions", {"userId": prof2_id}, token=admin)
        chk("能吊销某人全部会话", s == 200 and r.get("revoked", 0) >= 1, f"n={r.get('revoked')}")
        s, r = call("GET", "/api/me", token=prof2)
        chk("吊销后 token 立即失效", s == 401, f"HTTP {s}")

        print("\n── 邀请码管理 ──")
        s, r = call("GET", "/api/admin/invite", token=stu1)
        chk("非管理员看不到邀请码", s == 403, f"HTTP {s}")
        s, r = call("GET", "/api/admin/invite", token=admin)
        chk("管理员能查看当前邀请码", s == 200 and r.get("code") == INVITE, r.get("code"))
        s, r = call("POST", "/api/admin/invite", {"code": "short"}, token=admin)
        chk("过短的邀请码被拒", s == 400, f"HTTP {s}")
        s, r = call("POST", "/api/admin/invite", {"code": "brand-new-invite"}, token=admin)
        chk("能更换邀请码", s == 200 and r.get("code") == "brand-new-invite")
        s, r = call("POST", "/api/register", {"username": "newbie", "password": "newbie-pass-1",
                                              "inviteCode": INVITE})
        chk("旧邀请码立即失效", s in (403, 429), f"HTTP {s}")
        s, r = call("POST", "/api/register", {"username": "newbie", "password": "newbie-pass-1",
                                              "inviteCode": "brand-new-invite"})
        chk("新邀请码可用（无需重启服务）", s == 200, f"HTTP {s}")
        newbie_id = r.get("user", {}).get("id")

        print("\n── 移除成员 ──")
        call("POST", "/api/sync", {"records": [
            {"id": "nb1", "updatedAt": now, "data": {"at": now, "text": "新人的记录"}}]},
            token=r.get("token"))
        s, r = call("POST", "/api/admin/remove", {"userId": newbie_id}, token=stu1)
        chk("非管理员不能移除成员", s == 403, f"HTTP {s}")
        s, r = call("POST", "/api/admin/remove", {"userId": newbie_id}, token=admin)
        chk("管理员能移除成员", s == 200 and r.get("ok"), f"HTTP {s}")
        chk("连同其数据一并删除", (r.get("removed") or {}).get("records") == 1,
            str(r.get("removed")))
        s, r = call("GET", "/api/users", token=admin)
        chk("成员列表里不再有他", not any(u["username"] == "newbie" for u in r.get("users", [])))
        s, r = call("POST", "/api/admin/remove", {"userId": me["id"]}, token=admin)
        chk("不能删除自己", s == 403, f"HTTP {s}")

        print("\n── 服务器状态与审计日志 ──")
        s, r = call("GET", "/api/admin/status", token=stu1)
        chk("非管理员看不到服务器状态", s == 403, f"HTTP {s}")
        s, r = call("GET", "/api/admin/status", token=admin)
        chk("能查看服务器状态", s == 200 and "counts" in r, f"HTTP {s}")
        chk("含磁盘信息", (r.get("disk") or {}).get("freeBytes", 0) > 0)
        chk("含数据量统计", r["counts"].get("users", 0) > 0, str(r["counts"].get("users")))

        s, r = call("GET", "/api/admin/audit", token=stu1)
        chk("非管理员看不到审计日志", s == 403, f"HTTP {s}")
        s, r = call("GET", "/api/admin/audit", token=admin)
        acts = [e["action"] for e in r.get("entries", [])]
        chk("管理操作都留了痕", s == 200 and "改角色" in acts and "移除成员" in acts,
            "，".join(dict.fromkeys(acts))[:70])
        chk("审计记录带操作者", all(e.get("actor") for e in r.get("entries", [])))

        print("\n── 头像与资料 ──")
        TINY = "data:image/jpeg;base64," + "A" * 200
        s, r = call("POST", "/api/avatar", {"avatar": TINY})
        chk("未登录不能改头像", s == 401, f"HTTP {s}")

        s, r = call("POST", "/api/avatar", {"avatar": TINY}, token=stu1)
        chk("设置头像", s == 200 and r["user"].get("avatar") == TINY, f"HTTP {s}")

        s, r = call("GET", "/api/me", token=stu1)
        chk("/api/me 返回头像", r["user"].get("avatar") == TINY)

        s, r = call("POST", "/api/avatar", {"avatar": "javascript:alert(1)"}, token=stu1)
        chk("非图片 data URL 被拒", s == 400, f"HTTP {s}")

        s, r = call("POST", "/api/avatar", {"avatar": "data:image/jpeg;base64," + "A" * 200000}, token=stu1)
        chk("超大头像被拒", s == 413, f"HTTP {s}")

        s, r = call("POST", "/api/avatar", {"avatar": None}, token=stu1)
        chk("可以清除头像", s == 200 and not r["user"].get("avatar"))
        call("POST", "/api/avatar", {"avatar": TINY}, token=stu1)

        s, r = call("POST", "/api/profile", {"displayName": "学生甲改名"}, token=stu1)
        chk("能改显示名", s == 200 and r["user"]["displayName"] == "学生甲改名")
        s, r = call("POST", "/api/profile", {"displayName": ""}, token=stu1)
        chk("空显示名被拒", s == 400, f"HTTP {s}")

        s, r = call("GET", "/api/users", token=admin)
        who = {u["username"]: u for u in r.get("users", [])}
        chk("导师看到的成员列表带头像", who.get("stu1", {}).get("avatar") == TINY)
        chk("管理员排在最前", r["users"][0]["role"] == "admin", r["users"][0]["role"])

        print("\n── 导师概览聚合 ──")
        # 前面的墓碑测试把 stu1 唯一那条记录删了，这里补一条真实数据再统计
        call("POST", "/api/sync", {"records": [
            {"id": "r-ov", "updatedAt": now + 30000,
             "data": {"projectId": "p1", "at": now + 30000, "text": "概览统计用"}}]}, token=stu1)
        s, r = call("GET", "/api/overview", token=stu1)
        chk("学生不能看概览", s == 403, f"HTTP {s}")

        s, r = call("GET", "/api/overview", token=advisor)
        chk("导师能取概览", s == 200 and "members" in r, f"HTTP {s}")
        m = {x["username"]: x for x in r.get("members", [])}
        chk("统计了每人的项目数", m.get("stu1", {}).get("projects") == 1,
            str(m.get("stu1", {}).get("projects")))
        chk("统计了每人的记录数", m.get("stu1", {}).get("records") >= 1,
            str(m.get("stu1", {}).get("records")))
        chk("给出最后活跃时间", m.get("stu1", {}).get("lastAt", 0) > 0)
        chk("没记录的成员计数为 0", m.get("stu2", {}).get("records") == 0,
            str(m.get("stu2", {}).get("records")))

        print("\n── 导师视角 ──")
        s, r = call("GET", "/api/users", token=advisor)
        # 不写死人数：后面每加一个测试账号都会让硬编码的断言失败
        names = {u["username"] for u in r.get("users", [])}
        chk("导师能列出成员", s == 200 and {"prof", "stu1", "stu2"} <= names,
            f"n={len(names)}")
        s, r = call("GET", "/api/users", token=stu1)
        chk("学生不能列出成员", s == 403, f"HTTP {s}")

        # 放在最后：限速按 IP 计数，而测试里所有请求都来自 127.0.0.1，
        # 一旦锁定就会把后面每个需要登录的用例都连坐掉
        print("\n── 暴力破解防护（放最后，会锁住本机 IP）──")
        for i in range(8):
            call("POST", "/api/login", {"username": "stu2", "password": f"guess{i}"})
        s, r = call("POST", "/api/login", {"username": "stu2", "password": "guess-more"})
        chk("连续失败后被限速锁定", s == 429, f"HTTP {s} {r.get('error','')}")
        s, r = call("POST", "/api/login", {"username": "stu2", "password": "stu2-passwd-1"})
        chk("锁定期内正确密码也拒绝（防绕过）", s == 429, f"HTTP {s}")
        s, r = call("POST", "/api/register", {"username": "sneaky", "password": "sneaky-pass-1",
                                              "inviteCode": "wrong"})
        chk("错误邀请码也被限速计数", s in (403, 429), f"HTTP {s}")

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
