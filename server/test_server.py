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


def call_h(method, path, token=None, headers=None):
    """需要看响应头（Range、Content-Disposition）时用这个，返回 (status, body, headers)。"""
    req = urllib.request.Request(BASE + path, method=method)
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, r.read(), dict(r.headers)
    except urllib.error.HTTPError as e:
        return e.code, e.read(), dict(e.headers)


def main():
    tmp = tempfile.mkdtemp(prefix="mochi-test-")
    env = {**os.environ, "MOCHI_DATA": tmp, "MOCHI_PORT": str(PORT),
           "MOCHI_INVITE_CODE": INVITE,
           "MOCHI_ORIGINS": "https://semon-guo.github.io,http://localhost:5173",
           # 数据文件的上限调到 MB 级，配额一超就报——不然验一次要真搬几个 G；
           # 宽限期归零，让孤儿回收在同一次运行里就能观察到
           "MOCHI_MAX_FILE_MB": "2", "MOCHI_USER_QUOTA_MB": "3", "MOCHI_ORPHAN_GRACE_H": "0"}
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
        stu2_id = r.get("user", {}).get("id")
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
        # 存成独立变量：后面还有好几段测试会覆盖 r
        newbie_id = r.get("user", {}).get("id")
        newbie_tok = r.get("token")

        print("\n── 离组归档（不删数据）──")
        s, r = call("POST", "/api/register", {"username": "leaver", "password": "leaver-pass-1",
                                              "displayName": "毕业生", "inviteCode": "brand-new-invite"})
        leaver_id = r["user"]["id"]
        leaver_tok = r["token"]
        call("POST", "/api/sync", {
            "projects": [{"id": "lp1", "updatedAt": now, "data": {"name": "毕业生的项目"}}],
            "records": [{"id": "lr1", "updatedAt": now,
                         "data": {"projectId": "lp1", "at": now, "text": "毕业生的实验记录"}}],
        }, token=leaver_tok)

        s, r = call("POST", "/api/admin/archive", {"userId": leaver_id}, token=stu1)
        chk("非管理员不能标记离组", s == 403, f"HTTP {s}")

        s, r = call("POST", "/api/admin/archive", {"userId": leaver_id}, token=admin)
        chk("标记离组成功", s == 200 and r["user"].get("archivedAt"), f"HTTP {s}")

        s, r = call("GET", "/api/me", token=leaver_tok)
        chk("离组后其会话被吊销", s == 401, f"HTTP {s}")

        s, r = call("GET", "/api/overview", token=admin)
        lv = next((x for x in r["members"] if x["username"] == "leaver"), None)
        chk("离组成员仍在成员数据里（带 archivedAt）", lv and lv.get("archivedAt"), str(bool(lv)))
        chk("其记录数完好保留", lv and lv.get("records") == 1, str(lv and lv.get("records")))
        chk("其项目数完好保留", lv and lv.get("projects") == 1, str(lv and lv.get("projects")))

        s, r = call("GET", "/api/sync?since=0", token=admin)
        chk("导师仍能同步到离组成员的记录",
            any(x["id"] == "lr1" for x in r.get("records", [])),
            f"records={len(r.get('records', []))}")

        s, r = call("POST", "/api/admin/archive", {"userId": leaver_id, "archived": False}, token=admin)
        chk("能恢复在组", s == 200 and not r["user"].get("archivedAt"))
        call("POST", "/api/admin/archive", {"userId": leaver_id}, token=admin)

        print("\n── 谁算科研成员 ──")
        s, r = call("GET", "/api/overview", token=admin)
        who = {x["username"]: x for x in r["members"]}
        chk("纯管理账号（无任何记录）不算科研成员", who["prof"].get("inGroup") is False,
            str(who["prof"].get("inGroup")))
        chk("学生一律算科研成员", who["stu2"].get("inGroup") is True,
            str(who["stu2"].get("inGroup")))
        chk("有记录的人算科研成员", who["stu1"].get("inGroup") is True,
            str(who["stu1"].get("inGroup")))

        print("\n── 彻底删除（仅用于清理误注册）──")
        call("POST", "/api/sync", {"records": [
            {"id": "nb1", "updatedAt": now, "data": {"at": now, "text": "新人的记录"}}]},
            token=newbie_tok)
        s, r = call("POST", "/api/admin/remove", {"userId": newbie_id}, token=stu1)
        chk("非管理员不能移除成员", s == 403, f"HTTP {s}")
        s, r = call("POST", "/api/admin/remove", {"userId": newbie_id}, token=admin)
        chk("管理员能彻底删除账号", s == 200 and r.get("ok"), f"HTTP {s}")
        chk("连同其数据一并删除", (r.get("removed") or {}).get("records") == 1,
            str(r.get("removed")))
        s, r = call("GET", "/api/users", token=admin)
        chk("成员列表里不再有他", not any(u["username"] == "newbie" for u in r.get("users", [])))
        s, r = call("POST", "/api/admin/remove", {"userId": me["id"]}, token=admin)
        chk("不能删除自己", s == 403, f"HTTP {s}")
        s, r = call("POST", "/api/admin/archive", {"userId": me["id"]}, token=admin)
        chk("不能把自己标记为离组", s == 403, f"HTTP {s}")

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
        chk("管理操作都留了痕", s == 200 and "改角色" in acts and "标记离组" in acts,
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

        print("\n── 共享项目：导师建、把学生拉进来 ──")
        # 导师建的项目归导师所有，学生只有进了成员名单才拉得到——
        # 拉不到就意味着他在自己的 app 里看不见这个项目，没法往里记。
        s, r = call("POST", "/api/sync", {"projects": [
            {"id": "shared1", "updatedAt": now + 50000,
             "data": {"name": "组级项目：光场重建", "members": []}}]}, token=admin)
        chk("导师能建项目", s == 200 and r["applied"] == 1, str(r.get("rejected")))

        s, r = call("GET", "/api/sync?since=0", token=stu2)
        chk("没进名单的学生拉不到这个项目",
            not any(p["id"] == "shared1" for p in r.get("projects", [])))

        s, r = call("POST", "/api/sync", {"projects": [
            {"id": "shared1", "updatedAt": now + 51000,
             "data": {"name": "组级项目：光场重建", "members": [stu2_id]}}]}, token=admin)
        chk("导师能把学生纳入项目", s == 200 and r["applied"] == 1)

        s, r = call("GET", "/api/sync?since=0", token=stu2)
        got = [p for p in r.get("projects", []) if p["id"] == "shared1"]
        chk("纳入后学生就拉得到了", len(got) == 1 and got[0]["data"]["name"].startswith("组级项目"))
        chk("学生看得到成员名单", got and got[0]["data"].get("members") == [stu2_id])

        s, r = call("POST", "/api/sync", {"projects": [
            {"id": "shared1", "updatedAt": now + 52000, "data": {"name": "改名字", "members": []}}]},
            token=stu2)
        chk("学生改不了不属于自己的项目", s == 200 and r["rejected"], str(r))

        s, r = call("POST", "/api/sync", {"records": [
            {"id": "r-shared", "updatedAt": now + 53000,
             "data": {"projectId": "shared1", "at": now + 53000, "text": "在组级项目里记一条"}}]},
            token=stu2)
        chk("学生能往共享项目里记录", s == 200 and r["applied"] == 1)

        s, r = call("POST", "/api/sync", {"projects": [
            {"id": "shared1", "updatedAt": now + 54000, "data": {"name": "组级项目", "members": []}}]},
            token=admin)
        s, r = call("GET", "/api/sync?since=0", token=stu2)
        chk("移出名单后学生就拉不到了",
            not any(p["id"] == "shared1" for p in r.get("projects", [])))

        print("\n── 重点节点：老师定，全组共享 ──")
        s, r = call("POST", "/api/sync", {"milestones": [
            {"id": "ms-stu", "updatedAt": now + 70000,
             "data": {"at": now + 86400000, "title": "学生自己加的", "kind": "other"}}]}, token=stu1)
        chk("学生建不了重点节点", s == 200 and not r["applied"] and r["rejected"], str(r))

        s, r = call("POST", "/api/sync", {"milestones": [
            {"id": "ms1", "updatedAt": now + 70000,
             "data": {"at": now + 4 * 86400000, "title": "Optica 投稿截止",
                      "kind": "deadline", "projectId": "p1"}}]}, token=admin)
        chk("导师能建重点节点", s == 200 and r["applied"] == 1, str(r.get("rejected")))

        for who, name in ((stu1, "学生甲"), (stu2, "学生乙"), (admin, "管理员")):
            s, r = call("GET", "/api/sync?since=0", token=who)
            chk(f"{name}都看得到（组里的日程是共同信息）",
                any(m["id"] == "ms1" for m in r.get("milestones", [])))

        s, r = call("POST", "/api/sync", {"milestones": [
            {"id": "ms1", "updatedAt": now + 71000, "data": {"title": "学生改一下试试"}}]}, token=stu2)
        chk("学生改不了", s == 200 and not r["applied"] and r["rejected"], str(r.get("rejected")))

        s, r = call("GET", "/api/sync?since=0", token=stu1)
        got = [m for m in r.get("milestones", []) if m["id"] == "ms1"][0]
        chk("学生那边的内容没被改动", got["data"]["title"] == "Optica 投稿截止", got["data"]["title"])

        s, r = call("POST", "/api/sync", {"milestones": [
            {"id": "ms1", "updatedAt": now + 72000,
             "data": {"at": now + 5 * 86400000, "title": "Optica 投稿截止（延期）",
                      "kind": "deadline"}}]}, token=admin)
        chk("导师能改（换了导师之后，前一任定的日程不该冻在那儿）",
            s == 200 and r["applied"] == 1, str(r.get("rejected")))

        print("\n── 导师回复与点赞 ──")
        s, r = call("POST", "/api/sync", {"comments": [
            {"id": "cm1", "updatedAt": now + 60000,
             "data": {"recordId": "r-ov", "kind": "reply", "text": "暗场校正做了吗？"}}]}, token=admin)
        chk("导师能对学生的记录回复", s == 200 and r["applied"] == 1, str(r.get("rejected")))

        s, r = call("GET", "/api/sync?since=0", token=stu1)
        mine = [x for x in r.get("comments", []) if x["id"] == "cm1"]
        chk("回复能被记录的作者拉到（这条评论的 owner 是导师，不是他）", len(mine) == 1, str(r.get("comments")))
        chk("回复内容正确", mine and mine[0]["data"]["text"] == "暗场校正做了吗？")

        s, r = call("GET", "/api/sync?since=0", token=stu2)
        chk("无关的学生拉不到别人记录下的回复",
            not any(x["id"] == "cm1" for x in r.get("comments", [])))

        s, r = call("POST", "/api/sync", {"comments": [
            {"id": "cm2", "updatedAt": now + 61000,
             "data": {"recordId": "r-ov", "kind": "like"}}]}, token=admin)
        chk("点赞也是一条评论", s == 200 and r["applied"] == 1)

        s, r = call("POST", "/api/sync", {"comments": [
            {"id": "cm3", "updatedAt": now + 62000,
             "data": {"recordId": "r-ov", "kind": "reply", "text": "我来偷看"}}]}, token=stu2)
        chk("学生不能评论别人的记录", s == 200 and r["rejected"] and not r["applied"], str(r))

        s, r = call("POST", "/api/sync", {"comments": [
            {"id": "cm4", "updatedAt": now + 63000,
             "data": {"recordId": "no-such-record", "kind": "reply", "text": "挂在不存在的记录上"}}]},
            token=admin)
        chk("挂在不存在的记录上被拒", s == 200 and r["rejected"] and not r["applied"], str(r))

        s, r = call("POST", "/api/sync", {"comments": [
            {"id": "cm2", "updatedAt": now + 64000, "deletedAt": now + 64000}]}, token=admin)
        chk("能取消赞", s == 200 and r["applied"] == 1)
        s, r = call("GET", "/api/sync?since=0", token=stu1)
        tomb = [x for x in r.get("comments", []) if x["id"] == "cm2"]
        chk("取消赞的墓碑作者也能拉到（否则赞会永远留在他屏幕上）",
            len(tomb) == 1 and tomb[0]["data"] is None, str(tomb))

        print("\n── 数据文件：分块上传 ──")
        DATA = b"idx,psnr,ssim\n" + b"".join(
            f"{i},{28 + i % 7}.{i % 100:02d},0.9{i % 10}\n".encode() for i in range(3000))
        half = len(DATA) // 2

        s, r = call("POST", "/api/file/f1?offset=0", raw=DATA, token=stu1, ctype="text/csv")
        chk("没登记就直接传被拒", s == 409, f"HTTP {s}")

        s, r = call("POST", "/api/file/f1/init",
                    {"name": "psnr_sweep.csv", "size": len(DATA), "mime": "text/csv"}, token=stu1)
        chk("登记后拿到续传点 0", s == 200 and r.get("received") == 0 and r.get("done") is False, str(r))

        s, r = call("POST", "/api/file/f1?offset=0", raw=DATA[:half], token=stu1, ctype="text/csv")
        chk("收下第一块", s == 200 and r.get("received") == half and not r.get("done"), str(r))

        s, r = call("POST", "/api/file/f1?offset=0", raw=DATA[half:], token=stu1, ctype="text/csv")
        chk("偏移对不上时拒收并报出真实进度", s == 409 and str(half) in r.get("error", ""),
            f"HTTP {s} {r.get('error')}")

        s, r = call("POST", "/api/file/f1/init",
                    {"name": "psnr_sweep.csv", "size": len(DATA), "mime": "text/csv"}, token=stu1)
        chk("断线后重新登记，续传点就是已收到的字节数", s == 200 and r.get("received") == half, str(r))

        s, r = call("POST", f"/api/file/f1?offset={half}", raw=DATA[half:], token=stu1, ctype="text/csv")
        chk("补齐后标记完成", s == 200 and r.get("done") and r.get("received") == len(DATA), str(r))

        s, r = call("POST", "/api/file/f1/init",
                    {"name": "psnr_sweep.csv", "size": len(DATA), "mime": "text/csv"}, token=stu1)
        chk("重复挑同一个文件直接复用，不重传", s == 200 and r.get("done") is True, str(r))

        s, r = call("POST", "/api/file/short/init", {"name": "t.bin", "size": 10}, token=stu1)
        s, r = call("POST", "/api/file/short?offset=0", raw=b"0" * 40, token=stu1)
        chk("写超出登记大小被拒（不然能拿它撑爆磁盘）", s == 400, f"HTTP {s}")
        call("POST", "/api/file/short/drop", token=stu1)

        print("\n── 数据文件：下载与权限 ──")
        s, r = call("GET", "/api/file/f1", token=stu1)
        chk("本人能下载，内容逐字节一致", s == 200 and r == DATA, f"HTTP {s}")

        s, r = call("GET", "/api/file/f1", token=admin)
        chk("组内可读者（导师/管理员）能下载学生的数据文件", s == 200 and r == DATA, f"HTTP {s}")

        s, r = call("GET", "/api/file/f1", token=stu2)
        chk("其他学生下不到", s == 404, f"HTTP {s}")

        s, r = call("POST", "/api/file/f1/init", {"name": "偷.csv", "size": 10}, token=stu2)
        chk("其他学生不能占用同一个编号", s == 403, f"HTTP {s}")

        s, r = call("POST", "/api/file/f1/drop", token=stu2)
        chk("其他学生不能删别人的文件", s == 403, f"HTTP {s}")

        s, r = call("POST", "/api/file/f1/ticket", token=stu1)
        url = r.get("url", "")
        chk("能换到下载票", s == 200 and url.startswith("/api/file/f1?ticket="), url[:40])

        st, body, h = call_h("GET", url)
        chk("凭票免 Authorization 直接下载", st == 200 and body == DATA, f"HTTP {st}")
        chk("响应带上原始文件名", "psnr_sweep.csv" in h.get("Content-Disposition", ""),
            h.get("Content-Disposition"))

        st, body, h = call_h("GET", url, headers={"Range": "bytes=10-19"})
        chk("支持 Range，大文件下载能续", st == 206 and body == DATA[10:20]
            and h.get("Content-Range") == f"bytes 10-19/{len(DATA)}", f"HTTP {st}")

        st, _, _ = call_h("GET", "/api/file/f1?ticket=bogus-ticket")
        chk("伪造的票下不到", st == 401, f"HTTP {st}")

        print("\n── 数据文件：上限与配额 ──")
        s, r = call("POST", "/api/file/big/init", {"name": "stack.tif", "size": 3 * 1024 * 1024},
                    token=stu1)
        chk("超过单文件上限被拒", s == 413, f"HTTP {s}")

        s, r = call("POST", "/api/file/q1/init", {"name": "a.mat", "size": 2 * 1024 * 1024}, token=stu1)
        chk("配额内的登记通过", s == 200, f"HTTP {s}")
        s, r = call("POST", "/api/file/q2/init", {"name": "b.mat", "size": 2 * 1024 * 1024}, token=stu1)
        chk("再传就超配额，提前拒掉而不是传完才发现", s == 507, f"HTTP {s}")
        call("POST", "/api/file/q1/drop", token=stu1)
        s, r = call("POST", "/api/file/q2/init", {"name": "b.mat", "size": 2 * 1024 * 1024}, token=stu1)
        chk("腾出空间后又能传", s == 200, f"HTTP {s}")
        call("POST", "/api/file/q2/drop", token=stu1)

        print("\n── 数据文件：孤儿回收 ──")
        call("POST", "/api/sync", {"records": [
            {"id": "r-data", "updatedAt": now + 40000, "data": {
                "projectId": "p1", "at": now + 40000, "text": "第三轮扫描，附原始曲线",
                "files": [{"id": "f1", "name": "psnr_sweep.csv", "size": len(DATA), "mime": "text/csv"}]}}]},
            token=stu1)
        call("POST", "/api/file/orphan/init", {"name": "tmp.npy", "size": len(DATA)}, token=stu1)
        call("POST", "/api/file/orphan?offset=0", raw=DATA, token=stu1)
        s, r = call("GET", "/api/file/orphan", token=stu1)
        chk("没被引用的文件此刻还在", s == 200, f"HTTP {s}")

        s, r = call("POST", "/api/admin/gc", token=stu1)
        chk("学生不能触发清理", s == 403, f"HTTP {s}")

        s, r = call("POST", "/api/admin/gc", token=admin)
        chk("清理掉没有任何记录引用的数据文件", s == 200 and r.get("removed") >= 1, str(r))
        s, r = call("GET", "/api/file/orphan", token=stu1)
        chk("孤儿文件已消失", s == 404, f"HTTP {s}")
        s, r = call("GET", "/api/file/f1", token=stu1)
        chk("被记录引用的文件不受影响", s == 200 and r == DATA, f"HTTP {s}")

        s, r = call("GET", "/api/admin/status", token=admin)
        chk("状态页报出数据文件占用", s == 200 and r.get("fileBytes", 0) >= len(DATA),
            str(r.get("fileBytes")))

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
