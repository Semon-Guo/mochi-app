#!/usr/bin/env python3
"""Mochi 实验记录同步服务。

只同步实验记录（projects / records / photos），个人待办和计时数据留在设备本地。
学生读写自己的，导师只读全组的。

纯标准库实现——这台服务器访问 GitHub releases 不稳定，任何需要下载运行时或
依赖的方案都会在部署和以后的维护上反复卡住。

用法:
    MOCHI_INVITE_CODE=xxx python3 mochi_server.py
环境变量:
    MOCHI_DATA         数据目录，默认 ~/mochi-data
    MOCHI_PORT         监听端口，默认 3000
    MOCHI_INVITE_CODE  注册邀请码，为空则允许任意注册
    MOCHI_ORIGINS      允许的前端来源，逗号分隔
"""
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import ssl
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

DATA_DIR = Path(os.environ.get("MOCHI_DATA") or Path.home() / "mochi-data")
PHOTO_DIR = DATA_DIR / "photos"
DB_PATH = DATA_DIR / "mochi.db"
PORT = int(os.environ.get("MOCHI_PORT") or 3000)
INVITE_CODE = os.environ.get("MOCHI_INVITE_CODE", "")
ORIGINS = [o.strip() for o in (os.environ.get("MOCHI_ORIGINS") or
           "https://semon-guo.github.io,http://localhost:5173,http://127.0.0.1:5173").split(",") if o.strip()]

MAX_PHOTO = 8 * 1024 * 1024
SESSION_TTL = 90 * 24 * 3600
SYNC_TABLES = ("projects", "records", "photos")
PAGE = 500

PHOTO_DIR.mkdir(parents=True, exist_ok=True)

# ─────────────────────────── 数据库 ───────────────────────────

SCHEMA = """
CREATE TABLE IF NOT EXISTS seq_counter (id INTEGER PRIMARY KEY CHECK (id = 1), n INTEGER NOT NULL);
INSERT OR IGNORE INTO seq_counter (id, n) VALUES (1, 0);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'student', created_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  data TEXT NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER, seq INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_projects_seq ON projects(seq);
CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects(owner_id, seq);

CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  data TEXT NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER, seq INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_records_seq ON records(seq);
CREATE INDEX IF NOT EXISTS idx_records_owner ON records(owner_id, seq);

CREATE TABLE IF NOT EXISTS photos (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  data TEXT NOT NULL DEFAULT '{}', mime TEXT NOT NULL DEFAULT 'image/jpeg',
  size INTEGER NOT NULL DEFAULT 0, uploaded INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL, deleted_at INTEGER, seq INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_photos_seq ON photos(seq);
CREATE INDEX IF NOT EXISTS idx_photos_owner ON photos(owner_id, seq);
"""

_local = threading.local()
_write_lock = threading.Lock()


def conn():
    """每线程一个连接；WAL 让读不阻塞写。"""
    c = getattr(_local, "conn", None)
    if c is None:
        c = sqlite3.connect(DB_PATH, timeout=10)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA journal_mode = WAL")
        c.execute("PRAGMA busy_timeout = 5000")
        c.execute("PRAGMA foreign_keys = ON")
        _local.conn = c
    return c


def init_db():
    c = sqlite3.connect(DB_PATH)
    c.executescript(SCHEMA)
    c.commit()
    c.close()


def next_seq(c):
    """全局单调递增的同步游标。20 台设备的时钟不可能一致，游标必须由服务器发号。"""
    return c.execute("UPDATE seq_counter SET n = n + 1 WHERE id = 1 RETURNING n").fetchone()[0]


def current_seq(c):
    return c.execute("SELECT n FROM seq_counter WHERE id = 1").fetchone()[0]


def new_id():
    return secrets.token_hex(10)


# ─────────────────────────── 认证 ───────────────────────────

class HttpError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status, self.message = status, message


def _scrypt_ok() -> bool:
    """macOS 自带的 Python 用 LibreSSL，没有 scrypt；服务器上的 OpenSSL 3 有。"""
    try:
        hashlib.scrypt(b"x", salt=b"y", n=2, r=1, p=1, dklen=1)
        return True
    except (AttributeError, ValueError):
        return False


SCRYPT_OK = _scrypt_ok()
PBKDF2_ITERS = 600_000

def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    if SCRYPT_OK:
        dk = hashlib.scrypt(password.encode(), salt=salt, n=16384, r=8, p=1, dklen=32)
        return f"scrypt$16384$8$1${salt.hex()}${dk.hex()}"
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, PBKDF2_ITERS, dklen=32)
    return f"pbkdf2${PBKDF2_ITERS}$sha256${salt.hex()}${dk.hex()}"


def verify_password(password: str, stored: str) -> bool:
    """按存储格式选算法，所以两种哈希混在一个库里也能各自验证。"""
    try:
        parts = stored.split("$")
        if parts[0] == "scrypt":
            _, n, r, p, salt_hex, hash_hex = parts
            dk = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt_hex),
                                n=int(n), r=int(r), p=int(p), dklen=len(hash_hex) // 2)
        elif parts[0] == "pbkdf2":
            _, iters, algo, salt_hex, hash_hex = parts
            dk = hashlib.pbkdf2_hmac(algo, password.encode(), bytes.fromhex(salt_hex),
                                     int(iters), dklen=len(hash_hex) // 2)
        else:
            return False
        return hmac.compare_digest(dk.hex(), hash_hex)
    except Exception:
        return False


DUMMY_HASH = hash_password("dummy-password-for-timing")

# ── 登录限速 ──
# 没有它的话，进了校园网的人可以对任何账号无限猜密码（实测每次仅 0.13 秒）。
# 按「用户名」和「来源 IP」分别计数：前者挡针对某个账号的爆破，
# 后者挡拿一个字典横扫全组账号。计数放内存，重启即清——对 20 人的内网
# 工具足够，也不用担心把自己人永久锁死。
_fails = {}
_fail_lock = threading.Lock()
MAX_FAILS = 8            # 窗口内允许的失败次数
FAIL_WINDOW = 15 * 60    # 计数窗口
LOCK_SECONDS = 10 * 60   # 触发后的锁定时长


def rate_blocked(keys):
    """返回剩余锁定秒数；0 表示放行。"""
    now = time.time()
    with _fail_lock:
        worst = 0
        for k in keys:
            rec = _fails.get(k)
            if not rec:
                continue
            if rec["until"] > now:
                worst = max(worst, int(rec["until"] - now))
            elif now - rec["first"] > FAIL_WINDOW:
                _fails.pop(k, None)
        return worst


def note_fail(keys):
    now = time.time()
    with _fail_lock:
        for k in keys:
            rec = _fails.get(k)
            if not rec or now - rec["first"] > FAIL_WINDOW:
                _fails[k] = {"n": 1, "first": now, "until": 0}
            else:
                rec["n"] += 1
                if rec["n"] >= MAX_FAILS:
                    rec["until"] = now + LOCK_SECONDS


def note_success(keys):
    with _fail_lock:
        for k in keys:
            _fails.pop(k, None)


def public_user(row):
    return {"id": row["id"], "username": row["username"],
            "displayName": row["display_name"], "role": row["role"]}


def start_session(c, user_id):
    token = secrets.token_urlsafe(32)
    now = int(time.time() * 1000)
    with _write_lock:
        c.execute("INSERT INTO sessions (token, user_id, created_at, last_seen) VALUES (?,?,?,?)",
                  (token, user_id, now, now))
        c.commit()
    return token


def register(body, client_ip="?"):
    username = str(body.get("username") or "").strip().lower()
    password = str(body.get("password") or "")
    display = str(body.get("displayName") or "").strip() or username
    if not re.fullmatch(r"[a-z0-9_.-]{2,32}", username):
        raise HttpError(400, "用户名只能是 2-32 位的字母、数字、下划线、点或连字符")
    if len(password) < 8:
        raise HttpError(400, "密码至少 8 位")

    c = conn()
    # 注册一律是学生。导师角色只能在服务器上用 set_role.py 授予——否则谁先抢注
    # 谁就拿到了看全组记录的权限。
    wait = rate_blocked([f"reg:{client_ip}"])
    if wait:
        raise HttpError(429, f"尝试次数过多，请 {wait // 60 + 1} 分钟后再试")
    if INVITE_CODE and body.get("inviteCode") != INVITE_CODE:
        note_fail([f"reg:{client_ip}"])          # 邀请码也不能随便试
        raise HttpError(403, "邀请码不正确")
    if c.execute("SELECT 1 FROM users WHERE username = ?", (username,)).fetchone():
        raise HttpError(409, "用户名已被占用")

    uid, role, now = new_id(), "student", int(time.time() * 1000)
    with _write_lock:
        c.execute("INSERT INTO users (id, username, password_hash, display_name, role, created_at)"
                  " VALUES (?,?,?,?,?,?)", (uid, username, hash_password(password), display, role, now))
        c.commit()
    row = c.execute("SELECT * FROM users WHERE id = ?", (uid,)).fetchone()
    return {"token": start_session(c, uid), "user": public_user(row)}


def login(body, client_ip="?"):
    c = conn()
    username = str(body.get("username") or "").strip().lower()
    keys = [f"u:{username}", f"ip:{client_ip}"]
    wait = rate_blocked(keys)
    if wait:
        raise HttpError(429, f"尝试次数过多，请 {wait // 60 + 1} 分钟后再试")

    row = c.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
    # 用户不存在也跑一次校验，避免用响应时间区分「用户不存在」和「密码错」
    ok = verify_password(str(body.get("password") or ""), row["password_hash"] if row else DUMMY_HASH)
    if not row or not ok:
        note_fail(keys)
        raise HttpError(401, "用户名或密码错误")
    note_success(keys)
    return {"token": start_session(c, row["id"]), "user": public_user(row)}


def current_user(headers):
    m = re.match(r"Bearer\s+(.+)", headers.get("Authorization") or "", re.I)
    if not m:
        return None
    c = conn()
    s = c.execute("SELECT * FROM sessions WHERE token = ?", (m.group(1),)).fetchone()
    if not s:
        return None
    now = int(time.time() * 1000)
    if now - s["last_seen"] > SESSION_TTL * 1000:
        with _write_lock:
            c.execute("DELETE FROM sessions WHERE token = ?", (m.group(1),))
            c.commit()
        return None
    with _write_lock:
        c.execute("UPDATE sessions SET last_seen = ? WHERE token = ?", (now, m.group(1)))
        c.commit()
    row = c.execute("SELECT * FROM users WHERE id = ?", (s["user_id"],)).fetchone()
    return public_user(row) if row else None


# ─────────────────────────── 同步 ───────────────────────────

def shape(table, r):
    out = {"id": r["id"], "ownerId": r["owner_id"],
           "data": None if r["deleted_at"] else json.loads(r["data"]),
           "updatedAt": r["updated_at"], "deletedAt": r["deleted_at"], "seq": r["seq"]}
    if table == "photos":
        out.update(mime=r["mime"], size=r["size"], uploaded=bool(r["uploaded"]))
    return out


def pull(user, since):
    """增量拉取。学生只看自己的，导师看全组的。"""
    c = conn()
    advisor = user["role"] == "advisor"
    out = {"since": since, "seq": since, "more": False}
    for t in SYNC_TABLES:
        if advisor:
            rows = c.execute(f"SELECT * FROM {t} WHERE seq > ? ORDER BY seq LIMIT ?", (since, PAGE)).fetchall()
        else:
            rows = c.execute(f"SELECT * FROM {t} WHERE owner_id = ? AND seq > ? ORDER BY seq LIMIT ?",
                             (user["id"], since, PAGE)).fetchall()
        out[t] = [shape(t, r) for r in rows]
        if len(rows) == PAGE:
            out["more"] = True
        for r in rows:
            out["seq"] = max(out["seq"], r["seq"])
    if not out["more"] and out["seq"] == since:
        out["seq"] = current_seq(c)
    return out


def push(user, changes):
    """推送本地改动。只能写自己的；同一条记录以 updatedAt 较大的一方为准（LWW）。"""
    c = conn()
    res = {"applied": 0, "skipped": 0, "rejected": []}
    with _write_lock:
        try:
            for t in SYNC_TABLES:
                rows = changes.get(t)
                if not isinstance(rows, list):
                    continue
                for row in rows:
                    rid = row.get("id") if isinstance(row, dict) else None
                    if not isinstance(rid, str) or not rid:
                        res["rejected"].append({"table": t, "id": rid, "why": "缺少 id"})
                        continue
                    try:
                        updated_at = int(row.get("updatedAt") or 0)
                    except (TypeError, ValueError):
                        updated_at = 0
                    if not updated_at:
                        res["rejected"].append({"table": t, "id": rid, "why": "缺少 updatedAt"})
                        continue

                    cur = c.execute(f"SELECT * FROM {t} WHERE id = ?", (rid,)).fetchone()
                    if cur and cur["owner_id"] != user["id"]:
                        res["rejected"].append({"table": t, "id": rid, "why": "不能修改别人的记录"})
                        continue
                    if cur and updated_at <= cur["updated_at"]:
                        res["skipped"] += 1
                        continue

                    deleted_at = int(row["deletedAt"]) if row.get("deletedAt") else None
                    data = json.dumps({} if deleted_at else (row.get("data") or {}), ensure_ascii=False)
                    if cur:
                        c.execute(f"UPDATE {t} SET data=?, updated_at=?, deleted_at=?, seq=? WHERE id=?",
                                  (data, updated_at, deleted_at, next_seq(c), rid))
                    else:
                        c.execute(f"INSERT INTO {t} (id, owner_id, data, updated_at, deleted_at, seq)"
                                  " VALUES (?,?,?,?,?,?)",
                                  (rid, user["id"], data, updated_at, deleted_at, next_seq(c)))
                    res["applied"] += 1
            c.commit()
        except Exception:
            c.rollback()
            raise
    res["seq"] = current_seq(c)
    return res


def claim_photo(user, pid, mime, size):
    """上传二进制前的校验：元数据必须已经同步过来，且只能传自己的。"""
    c = conn()
    row = c.execute("SELECT * FROM photos WHERE id = ?", (pid,)).fetchone()
    if not row:
        raise HttpError(404, "照片元数据不存在，请先同步")
    if row["owner_id"] != user["id"]:
        raise HttpError(403, "不能上传别人的照片")
    if row["deleted_at"]:
        raise HttpError(410, "这张照片已删除")
    with _write_lock:
        c.execute("UPDATE photos SET mime=?, size=?, uploaded=1, seq=? WHERE id=?",
                  (mime or row["mime"], size, next_seq(c), pid))
        c.commit()
    return row


def readable_photo(user, pid):
    row = conn().execute("SELECT * FROM photos WHERE id = ?", (pid,)).fetchone()
    if not row or row["deleted_at"]:
        return None
    if row["owner_id"] != user["id"] and user["role"] != "advisor":
        return None
    return row


# ─────────────────────────── HTTP ───────────────────────────

PHOTO_RE = re.compile(r"^/api/photo/([A-Za-z0-9_-]{1,64})$")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "mochi-sync"

    def log_message(self, fmt, *args):
        print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {self.address_string()} {fmt % args}", flush=True)

    # -- 工具 --
    def _cors(self):
        origin = self.headers.get("Origin")
        h = {"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
             "Access-Control-Allow-Headers": "Content-Type, Authorization",
             "Access-Control-Max-Age": "86400"}
        if origin and origin in ORIGINS:
            h["Access-Control-Allow-Origin"] = origin
            h["Vary"] = "Origin"
        return h

    def _send(self, status, body: bytes, ctype, extra=None):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in {**self._cors(), **(extra or {})}.items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, obj, status=200):
        self._send(status, json.dumps(obj, ensure_ascii=False).encode(), "application/json; charset=utf-8")

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_PHOTO + 1024 * 1024:
            raise HttpError(413, "请求体过大")
        return self.rfile.read(n) if n else b""

    def _json_body(self):
        raw = self._body()
        if not raw:
            return {}
        try:
            obj = json.loads(raw)
        except json.JSONDecodeError:
            raise HttpError(400, "请求体不是合法 JSON")
        if not isinstance(obj, dict):
            raise HttpError(400, "请求体必须是 JSON 对象")
        return obj

    def _need_user(self):
        u = current_user(self.headers)
        if not u:
            raise HttpError(401, "请先登录")
        return u

    # -- 路由 --
    def do_OPTIONS(self):
        self._send(204, b"", "text/plain")

    def do_GET(self):
        self._dispatch("GET")

    def do_POST(self):
        self._dispatch("POST")

    def _dispatch(self, method):
        try:
            path = urlparse(self.path).path
            query = parse_qs(urlparse(self.path).query)

            if path == "/api/health":
                return self._json({"ok": True, "now": int(time.time() * 1000)})
            if method == "POST" and path == "/api/register":
                return self._json(register(self._json_body(), self.client_address[0]))
            if method == "POST" and path == "/api/login":
                return self._json(login(self._json_body(), self.client_address[0]))
            if method == "POST" and path == "/api/logout":
                m = re.match(r"Bearer\s+(.+)", self.headers.get("Authorization") or "", re.I)
                if m:
                    c = conn()
                    with _write_lock:
                        c.execute("DELETE FROM sessions WHERE token = ?", (m.group(1),))
                        c.commit()
                return self._json({"ok": True})
            if method == "GET" and path == "/api/me":
                return self._json({"user": self._need_user()})
            if method == "GET" and path == "/api/users":
                u = self._need_user()
                if u["role"] != "advisor":
                    raise HttpError(403, "只有导师能查看成员列表")
                rows = conn().execute(
                    "SELECT id, username, display_name, role FROM users ORDER BY created_at").fetchall()
                return self._json({"users": [{"id": r["id"], "username": r["username"],
                                              "displayName": r["display_name"], "role": r["role"]} for r in rows]})
            if method == "GET" and path == "/api/sync":
                since = query.get("since", ["0"])[0]
                try:
                    since = max(0, int(since))
                except ValueError:
                    since = 0
                return self._json(pull(self._need_user(), since))
            if method == "POST" and path == "/api/sync":
                return self._json(push(self._need_user(), self._json_body()))

            m = PHOTO_RE.match(path)
            if m:
                pid, user = m.group(1), self._need_user()
                if method == "POST":
                    buf = self._body()
                    if not buf:
                        raise HttpError(400, "空文件")
                    if len(buf) > MAX_PHOTO:
                        raise HttpError(413, f"照片超过 {MAX_PHOTO // 1024 // 1024}MB")
                    claim_photo(user, pid, self.headers.get("Content-Type") or "image/jpeg", len(buf))
                    (PHOTO_DIR / pid).write_bytes(buf)
                    return self._json({"ok": True, "size": len(buf)})
                row = readable_photo(user, pid)
                if not row:
                    raise HttpError(404, "照片不存在或无权访问")
                f = PHOTO_DIR / pid
                if not f.exists():
                    raise HttpError(404, "照片尚未上传")
                return self._send(200, f.read_bytes(), row["mime"],
                                  {"Cache-Control": "private, max-age=31536000, immutable"})

            raise HttpError(404, "没有这个接口")
        except HttpError as e:
            self._json({"error": e.message}, e.status)
        except Exception as e:
            print(f"[ERROR] {method} {self.path}: {type(e).__name__}: {e}", flush=True)
            self._json({"error": "服务器内部错误"}, 500)


CERT = os.environ.get("MOCHI_CERT", "")
KEY = os.environ.get("MOCHI_KEY", "")
CA_CERT = os.environ.get("MOCHI_CA_CERT", "")
CERT_PORT = int(os.environ.get("MOCHI_CERT_PORT") or 3001)

INSTALL_PAGE = """<!doctype html><html lang=zh-CN><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>Mochi 根证书安装</title>
<style>
body{font:16px/1.7 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;
max-width:600px;margin:0 auto;padding:24px;color:#2C2C2C;background:#FDFBF7}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 8px}
.sub{color:#999;font-size:14px;margin-bottom:24px}
a.btn{display:block;background:#2C2C2C;color:#fff;text-decoration:none;text-align:center;
padding:15px;border-radius:14px;font-weight:600;margin:10px 0}
ol{padding-left:22px}li{margin:8px 0}
.warn{background:#FFF6E5;border:1px solid #E8A838;border-radius:12px;padding:12px 14px;margin:16px 0;font-size:14px}
.safe{background:#EEF7EC;border:1px solid #5A9E4B;border-radius:12px;padding:12px 14px;margin:16px 0;font-size:14px}
code{background:#F0EDE6;padding:2px 6px;border-radius:4px;font-size:13px;word-break:break-all}
</style>
<h1>Mochi 根证书</h1>
<div class=sub>装一次就好。装完才能用 Mochi 同步实验记录。</div>

<h2>先看清楚你在装什么</h2>
<p>你要装的是一张<b>根证书</b>。一般来说，装根证书是件需要谨慎的事——普通的根证书一旦被滥用，
持有者可以伪造<b>任意网站</b>的身份（网银、邮箱、微信），在你连的网络里解密你的 HTTPS 流量。</p>
<div class=safe>
<b>这张证书被从技术上锁死了。</b>它带有 X.509 的 Name Constraints 扩展，签发范围被限制在
<code>mochi.invalid</code> 这一个永不存在的域名下。也就是说：<b>即使这张证书的私钥泄露，
拿到它的人也签不出 google.com、网银或任何真实网站的证书</b>——你的系统会直接拒绝。
已在 Apple 的证书验证栈上实测确认。
</div>
<p>它唯一能做的，就是让你的设备信任实验室内网那台 <code>172.29.249.177</code> 上的同步服务。
私钥不在服务器上，只保存在管理员本人的电脑里。</p>
<p style="color:#999;font-size:13.5px">不放心的话可以自己核对：装之前用
<code>openssl x509 -in mochi-ca.crt -noout -text</code> 看 <code>X509v3 Name Constraints</code> 一节。</p>

<a class=btn href="/mochi-ca.mobileconfig">📱 iPhone / iPad 点这里安装</a>
<a class=btn href="/ca.crt">💻 Mac 点这里下载</a>

<h2>iPhone 步骤</h2>
<ol>
<li>用 <b>Safari</b> 打开本页（微信里打不开描述文件），点上面第一个按钮</li>
<li>弹出「已下载描述文件」→ 打开<b>设置</b>，最上方会出现「已下载描述文件」，点进去<b>安装</b></li>
<li><b>关键一步：</b>设置 → 通用 → 关于本机 → 拉到最底部 → <b>证书信任设置</b> → 打开「Mochi Lab Root CA」的开关</li>
</ol>
<div class=warn><b>第 3 步不能省。</b>只安装不打开信任开关，浏览器依然会报证书错误——绝大多数人卡在这里。</div>

<h2>Mac 步骤</h2>
<ol>
<li>点上面第二个按钮下载 <code>ca.crt</code></li>
<li>双击它，钥匙串访问会打开并添加到「登录」</li>
<li>在钥匙串里找到「Mochi Lab Root CA」，双击 → 展开「信任」→ 把「使用此证书时」改成<b>始终信任</b> → 关窗口输密码确认</li>
</ol>

<h2>不想装 / 想撤销</h2>
<p>随时可以删掉：iPhone 在「设置 → 通用 → VPN 与设备管理」里删除描述文件；
Mac 在钥匙串访问里删除「Mochi Lab Root CA」。删掉之后 Mochi 的同步就用不了，
但待办和计时功能不受影响（那些数据本来就只存在你自己手机上）。</p>

<div class=warn>装完之后，同步地址是 <code>https://172.29.249.177:3000</code>，只在实验室网络里能连上。</div>
</html>"""


class CertHandler(BaseHTTPRequestHandler):
    """明文 HTTP，只提供根证书下载和安装指引。

    装证书之前 HTTPS 还不被信任，所以这一步必须走明文——但这里只发公开的
    根证书（本来就是要公开分发的东西），没有任何敏感数据。
    """
    protocol_version = "HTTP/1.1"
    server_version = "mochi-cert"

    def log_message(self, fmt, *args):
        print(f"[cert] {self.address_string()} {fmt % args}", flush=True)

    def _out(self, body: bytes, ctype, filename=None):
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        if filename:
            self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlparse(self.path).path
        try:
            if path == "/ca.crt" and CA_CERT:
                return self._out(Path(CA_CERT).read_bytes(), "application/x-x509-ca-cert", "mochi-ca.crt")
            if path == "/mochi-ca.mobileconfig" and CA_CERT:
                return self._out(build_mobileconfig(Path(CA_CERT).read_bytes()),
                                 "application/x-apple-aspen-config", "mochi-ca.mobileconfig")
            self._out(INSTALL_PAGE.encode(), "text/html; charset=utf-8")
        except Exception as e:
            print(f"[cert] 出错: {e}", flush=True)
            self.send_error(500)


def build_mobileconfig(pem: bytes) -> bytes:
    """把 PEM 根证书包成 iOS 描述文件，安装体验比裸 .crt 好很多。"""
    import base64
    import uuid
    body = b"".join(l for l in pem.splitlines() if not l.startswith(b"-----"))
    der_b64 = base64.b64encode(base64.b64decode(body)).decode()
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>PayloadContent</key><array><dict>
  <key>PayloadType</key><string>com.apple.security.root</string>
  <key>PayloadIdentifier</key><string>com.mochi.lab.ca</string>
  <key>PayloadUUID</key><string>{uuid.uuid4()}</string>
  <key>PayloadVersion</key><integer>1</integer>
  <key>PayloadDisplayName</key><string>Mochi Lab Root CA</string>
  <key>PayloadDescription</key><string>课题组实验记录同步服务的根证书</string>
  <key>PayloadCertificateFileName</key><string>mochi-ca.crt</string>
  <key>PayloadContent</key><data>{der_b64}</data>
</dict></array>
<key>PayloadDisplayName</key><string>Mochi 实验记录 · 根证书</string>
<key>PayloadDescription</key><string>装上后才能连课题组的同步服务</string>
<key>PayloadIdentifier</key><string>com.mochi.lab.profile</string>
<key>PayloadOrganization</key><string>Mochi Lab</string>
<key>PayloadType</key><string>Configuration</string>
<key>PayloadUUID</key><string>{uuid.uuid4()}</string>
<key>PayloadVersion</key><integer>1</integer>
<key>PayloadRemovalDisallowed</key><false/>
</dict></plist>""".encode()


def main():
    # 这是台多用户机器：新建的库文件、照片一律只有本人可读。
    # /home/wang 本身是 750 已经挡住了别人，这里是第二道防线。
    os.umask(0o077)
    init_db()
    if not INVITE_CODE:
        print("⚠️  未设置 MOCHI_INVITE_CODE，任何人都能注册")

    srv = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    srv.daemon_threads = True

    scheme = "http"
    if CERT and KEY:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(CERT, KEY)
        ctx.minimum_version = ssl.TLSVersion.TLSv1_2
        srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
        scheme = "https"
    else:
        print("⚠️  未配置证书，以明文 HTTP 运行（只适合开发）")

    print(f"Mochi 同步服务已启动: {scheme}://0.0.0.0:{PORT}")
    print(f"数据目录: {DATA_DIR}")
    print(f"允许的前端来源: {', '.join(ORIGINS)}")

    if CA_CERT:
        cert_srv = ThreadingHTTPServer(("0.0.0.0", CERT_PORT), CertHandler)
        cert_srv.daemon_threads = True
        threading.Thread(target=cert_srv.serve_forever, daemon=True).start()
        print(f"根证书分发页（明文）: http://0.0.0.0:{CERT_PORT}/")

    srv.serve_forever()


if __name__ == "__main__":
    main()
