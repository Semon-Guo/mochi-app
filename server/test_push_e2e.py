#!/usr/bin/env python3
"""推送全链路验证：服务器 → 推送端点 → 解密还原。

没有真实浏览器，所以自己扮演接收方：生成一对 P-256 密钥当作「浏览器的订阅密钥」，
把 endpoint 指向本地起的假推送服务，让 mochi_server 真的推一条过来，
再按 RFC 8291 解密回明文。

能解出原文，就说明 VAPID 签名、消息加密、HTTP 格式三样都是对的——
真实浏览器那侧走的是同一套。
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from webpush import b64d, b64e, _hkdf, _pub_bytes          # noqa: E402
from cryptography.hazmat.primitives.asymmetric import ec    # noqa: E402
from cryptography.hazmat.primitives.ciphers.aead import AESGCM  # noqa: E402

HERE = Path(__file__).parent
API_PORT, PUSH_PORT = 39301, 39302
BASE = f"http://127.0.0.1:{API_PORT}"
INVITE = "push-e2e"

passed = failed = 0
received = []


def chk(name, cond, info=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"  PASS  {name}" + (f"  {info}" if info else ""))
    else:
        failed += 1
        print(f"  FAIL  {name}" + (f"  {info}" if info else ""))


# ── 假的推送服务：收下请求，原样存起来 ──
class PushEndpoint(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        received.append({"body": self.rfile.read(n), "headers": dict(self.headers)})
        self.send_response(201)
        self.send_header("Content-Length", "0")
        self.end_headers()


def decrypt(body: bytes, ua_private, auth_secret: bytes) -> bytes:
    """RFC 8291 的解密方向——浏览器内部做的就是这件事。"""
    salt, as_public, ciphertext = body[:16], body[21:86], body[86:]
    as_pub = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), as_public)
    shared = ua_private.exchange(ec.ECDH(), as_pub)
    key_info = b"WebPush: info\x00" + _pub_bytes(ua_private.public_key()) + as_public
    ikm = _hkdf(auth_secret, shared, key_info, 32)
    cek = _hkdf(salt, ikm, b"Content-Encoding: aes128gcm\x00", 16)
    nonce = _hkdf(salt, ikm, b"Content-Encoding: nonce\x00", 12)
    return AESGCM(cek).decrypt(nonce, ciphertext, None).rstrip(b"\x02")


def call(path, body=None, token=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method="POST" if data is not None else "GET")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read())
        except Exception:
            return e.code, {}


def main():
    tmp = tempfile.mkdtemp(prefix="mochi-push-")
    env = {**os.environ, "MOCHI_DATA": tmp, "MOCHI_PORT": str(API_PORT),
           "MOCHI_INVITE_CODE": INVITE, "MOCHI_VAPID": str(Path(tmp) / "vapid.json")}
    srv = ThreadingHTTPServer(("127.0.0.1", PUSH_PORT), PushEndpoint)
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    proc = subprocess.Popen([sys.executable, "-u", str(HERE / "mochi_server.py")], env=env,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        for _ in range(80):
            try:
                if call("/api/health")[0] == 200:
                    break
            except Exception:
                time.sleep(0.1)

        s, health = call("/api/health")
        chk("服务器启用了推送", health.get("push") is True, str(health.get("push")))

        s, r = call("/api/register", {"username": "pusher", "password": "pusher-pass-1",
                                      "displayName": "推送测试", "inviteCode": INVITE})
        token = r["token"]
        chk("注册成功", s == 200)

        # 扮演浏览器：生成订阅密钥
        ua_priv = ec.generate_private_key(ec.SECP256R1())
        auth_secret = os.urandom(16)
        sub = {"endpoint": f"http://127.0.0.1:{PUSH_PORT}/push/device-1",
               "keys": {"p256dh": b64e(_pub_bytes(ua_priv.public_key())),
                        "auth": b64e(auth_secret)}}
        s, r = call("/api/push/subscribe", {"subscription": sub}, token)
        chk("订阅成功", s == 200 and r.get("ok"), f"HTTP {s}")

        print("\n── 立即推送（测试通知）──")
        received.clear()
        s, r = call("/api/push/test", {}, token)
        chk("服务器报告发送成功", s == 200 and r.get("sent") == 1, f"HTTP {s} {r}")
        time.sleep(0.4)
        chk("推送端点确实收到了请求", len(received) == 1, f"{len(received)} 条")

        if received:
            got = received[0]
            # HTTP 头名大小写不敏感，而 urllib 会把 TTL 规范化成 Ttl
            h = {k.lower(): v for k, v in got["headers"].items()}
            chk("Content-Encoding 为 aes128gcm", h.get("content-encoding") == "aes128gcm",
                h.get("content-encoding"))
            chk("带 VAPID Authorization 头", (h.get("authorization") or "").startswith("vapid t="))
            chk("设置了 TTL", h.get("ttl") is not None, h.get("ttl"))
            plain = decrypt(got["body"], ua_priv, auth_secret)
            payload = json.loads(plain)
            chk("解密成功且是合法 JSON", isinstance(payload, dict), str(payload)[:60])
            chk("通知标题正确", "推送已就绪" in payload.get("title", ""), payload.get("title"))

        print("\n── 到点自动推送 ──")
        received.clear()
        now = int(time.time() * 1000)
        s, r = call("/api/reminders", {"reminders": [
            {"id": "todo-abc", "dueAt": now - 5000, "title": "⏰ 跑柱子", "body": "主线 · 预期 60 分钟"},
            {"id": "todo-future", "dueAt": now + 3600_000, "title": "⏰ 还没到点的"},
        ]}, token)
        chk("上传了两条提醒（一条已到点，一条在未来）", s == 200 and r.get("count") == 2)

        # 后台线程每 30 秒扫一次
        for _ in range(70):
            if received:
                break
            time.sleep(0.5)
        chk("到点的提醒被自动推送", len(received) >= 1, f"{len(received)} 条")

        if received:
            payload = json.loads(decrypt(received[0]["body"], ua_priv, auth_secret))
            chk("推送的是到点那条，不是未来那条", payload.get("title") == "⏰ 跑柱子", payload.get("title"))
            chk("正文带上了重要度和预期时长", "主线" in payload.get("body", ""), payload.get("body"))
            chk("带 todoId 供点击跳转", payload.get("todoId") == "todo-abc", payload.get("todoId"))

        before = len(received)
        time.sleep(35)
        chk("已发过的提醒不会重复推送", len(received) == before, f"{len(received)} vs {before}")

        print("\n── 导师点赞/点评，学生收到通知 ──")
        # 学生先写一条记录
        now2 = int(time.time() * 1000)
        s, r = call("/api/sync", {"records": [
            {"id": "rec-1", "updatedAt": now2,
             "data": {"projectId": "p1", "at": now2, "text": "第三轮扫描，重建 PSNR 28.3 dB"}}]}, token)
        chk("学生写下一条记录", s == 200 and r.get("applied") == 1, str(r))

        # 导师身份只能在服务器上授予
        s, r = call("/api/register", {"username": "prof", "password": "prof-pass-11",
                                      "displayName": "郭老师", "inviteCode": INVITE})
        subprocess.run([sys.executable, str(HERE / "set_role.py"), "prof", "advisor"],
                       env=env, capture_output=True, text=True)
        s, r = call("/api/login", {"username": "prof", "password": "prof-pass-11"})
        prof = r.get("token")
        chk("导师登录", s == 200 and r["user"]["role"] == "advisor", r.get("user", {}).get("role"))

        received.clear()
        s, r = call("/api/sync", {"comments": [
            {"id": "cm-like", "updatedAt": now2 + 1000,
             "data": {"recordId": "rec-1", "kind": "like"}}]}, prof)
        chk("导师点赞被接受", s == 200 and r.get("applied") == 1, str(r.get("rejected")))
        for _ in range(40):
            if received:
                break
            time.sleep(0.1)
        chk("学生设备收到了点赞通知", len(received) == 1, f"{len(received)} 条")
        if received:
            payload = json.loads(decrypt(received[0]["body"], ua_priv, auth_secret))
            chk("标题写清楚是谁赞的", "郭老师" in payload.get("title", "") and "赞" in payload.get("title", ""),
                payload.get("title"))
            chk("正文带上记录摘要，不用点开就知道是哪条",
                "PSNR" in payload.get("body", ""), payload.get("body"))

        received.clear()
        s, r = call("/api/sync", {"comments": [
            {"id": "cm-reply", "updatedAt": now2 + 2000,
             "data": {"recordId": "rec-1", "kind": "reply", "text": "暗场校正做了吗？"}}]}, prof)
        chk("导师点评被接受", s == 200 and r.get("applied") == 1)
        for _ in range(40):
            if received:
                break
            time.sleep(0.1)
        chk("学生设备收到了点评通知", len(received) == 1, f"{len(received)} 条")
        if received:
            payload = json.loads(decrypt(received[0]["body"], ua_priv, auth_secret))
            chk("标题说明是点评", "点评" in payload.get("title", ""), payload.get("title"))
            chk("正文就是点评原文", "暗场校正" in payload.get("body", ""), payload.get("body"))

        # 同一条重推不该再吵一次——客户端偶尔会因为推送记账丢失而重发
        received.clear()
        call("/api/sync", {"comments": [
            {"id": "cm-reply", "updatedAt": now2 + 3000,
             "data": {"recordId": "rec-1", "kind": "reply", "text": "暗场校正做了吗？"}}]}, prof)
        time.sleep(1.2)
        chk("同一条评论重推不会重复通知", len(received) == 0, f"{len(received)} 条")

        # 自己给自己写的东西不该给自己发通知
        received.clear()
        call("/api/sync", {"comments": [
            {"id": "cm-self", "updatedAt": now2 + 4000,
             "data": {"recordId": "rec-1", "kind": "reply", "text": "做了，前一天测的"}}]}, token)
        time.sleep(1.2)
        chk("学生回自己的记录不会给自己发通知", len(received) == 0, f"{len(received)} 条")

        print(f"\n{'=' * 46}\n通过 {passed} 项，失败 {failed} 项\n{'=' * 46}")
        return 1 if failed else 0
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        srv.shutdown()
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
