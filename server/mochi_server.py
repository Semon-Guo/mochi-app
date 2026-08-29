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
# 环境变量里的邀请码只作为初始值，之后以数据库里的为准——
# 管理员在界面上换码要能立刻生效，不该还得 SSH 上来改文件重启。
INVITE_CODE_ENV = os.environ.get("MOCHI_INVITE_CODE", "")
ORIGINS = [o.strip() for o in (os.environ.get("MOCHI_ORIGINS") or
           "https://semon-guo.github.io,http://localhost:5173,http://127.0.0.1:5173").split(",") if o.strip()]

VAPID_PATH = Path(os.environ.get("MOCHI_VAPID") or Path.home() / "mochi" / "vapid.json")
# Apple 的推送服务会校验 sub 的有效性：填 mailto:xxx@mochi.invalid 会被直接
# 403 BadJwtToken 拒掉（.invalid 是 RFC 2606 保留的永不解析域名）。必须是
# 真实可达的 https URL 或真实邮箱——这里默认用前端地址，不涉及个人信息。
VAPID_SUBJECT = os.environ.get("MOCHI_VAPID_SUBJECT", "https://semon-guo.github.io/mochi-app/")

# 推送是可选能力：cryptography 缺失时整个服务照常跑，只是不发通知——
# 同步是主线功能，不该被它拖垮。
try:
    import webpush
    PUSH_OK = True
except Exception as _e:
    webpush = None
    PUSH_OK = False
    _PUSH_ERR = str(_e)

MAX_PHOTO = 8 * 1024 * 1024
SESSION_TTL = 90 * 24 * 3600
SYNC_TABLES = ("projects", "records", "photos", "todos")
# 实验记录是科研产出，导师有正当理由查看；待办里带着专注计时和 timeline
# （几点开始、暂停几次、有没有在玩手机），那是行为数据，性质完全不同——
# 同步只是为了本人多设备互通，导师一律看不到，由服务端强制。
ADVISOR_VISIBLE = ("projects", "records", "photos")

# 三种角色。admin 是 advisor 的超集：除了能看全组记录，还能审批导师申请。
# 用导师码注册只是「申请」，在管理员点头之前一律按学生对待——否则导师码
# 一旦外泄，拿到的人立刻就能读全组记录。
ROLES = ("student", "advisor", "admin")
GROUP_READERS = ("advisor", "admin")


def can_read_group(user):
    return user and user.get("role") in GROUP_READERS


def is_admin(user):
    return user and user.get("role") == "admin"
PAGE = 500

PHOTO_DIR.mkdir(parents=True, exist_ok=True)

# ─────────────────────────── 数据库 ───────────────────────────

SCHEMA = """
CREATE TABLE IF NOT EXISTS seq_counter (id INTEGER PRIMARY KEY CHECK (id = 1), n INTEGER NOT NULL);
INSERT OR IGNORE INTO seq_counter (id, n) VALUES (1, 0);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'student', created_at INTEGER NOT NULL,
  avatar TEXT, updated_at INTEGER NOT NULL DEFAULT 0,
  pending_role TEXT, requested_at INTEGER, archived_at INTEGER);

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

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL,
  target TEXT, detail TEXT);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at DESC);

CREATE TABLE IF NOT EXISTS push_subs (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
  created_at INTEGER NOT NULL, last_ok INTEGER, fail_count INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_push_user ON push_subs(user_id);

CREATE TABLE IF NOT EXISTS reminders (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  due_at INTEGER NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
  fired_at INTEGER, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_rem_due ON reminders(fired_at, due_at);
CREATE INDEX IF NOT EXISTS idx_rem_owner ON reminders(owner_id);

CREATE TABLE IF NOT EXISTS todos (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  data TEXT NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER, seq INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_todos_seq ON todos(seq);
CREATE INDEX IF NOT EXISTS idx_todos_owner ON todos(owner_id, seq);

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
    # 老库补列——不能靠改 CREATE TABLE，那对已存在的表不生效
    have = {r[1] for r in c.execute("PRAGMA table_info(users)")}
    for col, decl in (("avatar", "TEXT"), ("updated_at", "INTEGER NOT NULL DEFAULT 0"),
                      ("pending_role", "TEXT"), ("requested_at", "INTEGER"),
                      ("archived_at", "INTEGER")):
        if col not in have:
            c.execute(f"ALTER TABLE users ADD COLUMN {col} {decl}")
    c.commit()
    c.close()


def get_setting(key, default=""):
    try:
        row = conn().execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
        return row["value"] if row else default
    except Exception:
        return default


def set_setting(key, value):
    now = int(time.time() * 1000)
    c = conn()
    with _write_lock:
        c.execute("INSERT INTO settings (key, value, updated_at) VALUES (?,?,?)"
                  " ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
                  (key, str(value), now))
        c.commit()


def audit(actor, action, target=None, detail=None):
    """管理操作一律留痕。出了事要能回答「谁在什么时候动了什么」。"""
    try:
        c = conn()
        with _write_lock:
            c.execute("INSERT INTO audit_log (at, actor, action, target, detail) VALUES (?,?,?,?,?)",
                      (int(time.time() * 1000), actor, action, target, detail))
            c.commit()
        print(f"[audit] {actor} {action} {target or ''} {detail or ''}", flush=True)
    except Exception as e:
        print(f"[audit] 写入失败: {e}", flush=True)


def next_seq(c):
    """全局单调递增的同步游标。20 台设备的时钟不可能一致，游标必须由服务器发号。"""
    return c.execute("UPDATE seq_counter SET n = n + 1 WHERE id = 1 RETURNING n").fetchone()[0]


def current_seq(c):
    return c.execute("SELECT n FROM seq_counter WHERE id = 1").fetchone()[0]


def new_id():
    return secrets.token_hex(10)


def load_vapid():
    """VAPID 密钥要长期固定：前端的订阅绑定了公钥，换了就得所有人重新订阅。"""
    if not PUSH_OK:
        return None
    try:
        if VAPID_PATH.exists():
            v = json.loads(VAPID_PATH.read_text())
        else:
            v = webpush.generate_vapid_keys()
            VAPID_PATH.parent.mkdir(parents=True, exist_ok=True)
            VAPID_PATH.write_text(json.dumps(v, indent=2))
            VAPID_PATH.chmod(0o600)
            print(f"已生成 VAPID 密钥: {VAPID_PATH}", flush=True)
        v["subject"] = VAPID_SUBJECT
        return v
    except Exception as e:
        print(f"[push] VAPID 密钥加载失败: {e}", flush=True)
        return None


VAPID = None   # 在 main() 里初始化


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


def public_user(row, with_avatar=True):
    u = {"id": row["id"], "username": row["username"],
         "displayName": row["display_name"], "role": row["role"]}
    try:
        if with_avatar and row["avatar"]:
            u["avatar"] = row["avatar"]
        if row["pending_role"]:
            u["pendingRole"] = row["pending_role"]
            u["requestedAt"] = row["requested_at"]
        if row["archived_at"]:
            u["archivedAt"] = row["archived_at"]
    except (IndexError, KeyError):
        pass
    return u


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
    wait = rate_blocked([f"reg:{client_ip}"])
    if wait:
        raise HttpError(429, f"尝试次数过多，请 {wait // 60 + 1} 分钟后再试")

    # 用哪个码注册，决定拿到什么身份。两个码都没配时才允许裸注册。
    # 注册一律是学生。导师和管理员由管理员在界面上直接任命——
    # 靠一串字符换权限的路子已经取消了。
    code = str(body.get("inviteCode") or "")
    invite = get_setting("invite_code", INVITE_CODE_ENV)
    if invite and not hmac.compare_digest(code, invite):
        note_fail([f"reg:{client_ip}"])          # 邀请码也不能随便试
        raise HttpError(403, "邀请码不正确")
    role, pending = "student", None

    if c.execute("SELECT 1 FROM users WHERE username = ?", (username,)).fetchone():
        raise HttpError(409, "用户名已被占用")

    uid, now = new_id(), int(time.time() * 1000)

    with _write_lock:
        c.execute("INSERT INTO users (id, username, password_hash, display_name, role, created_at,"
                  " pending_role, requested_at) VALUES (?,?,?,?,?,?,?,?)",
                  (uid, username, hash_password(password), display, role, now,
                   pending, now if pending else None))
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
    """增量拉取。实验记录导师可见全组；待办任何角色都只能看自己的。"""
    c = conn()
    out = {"since": since, "seq": since, "more": False}
    for t in SYNC_TABLES:
        advisor = can_read_group(user) and t in ADVISOR_VISIBLE
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


MAX_AVATAR = 96 * 1024   # 前端压到 192px JPEG，正常 10-20KB；留足余量

def set_avatar(user, data_url):
    """头像存成 data URL 直接进 users 表。

    导师端一屏要显示十几个人的头像，走单独的文件端点就是十几个请求；
    存字段里能随 /api/users 一次返回。代价是库大一点——20 人 × 20KB 不值一提。
    """
    if data_url is None:
        v = None
    else:
        v = str(data_url)
        if not v.startswith("data:image/"):
            raise HttpError(400, "头像格式不对")
        if len(v) > MAX_AVATAR:
            raise HttpError(413, f"头像太大（上限 {MAX_AVATAR // 1024}KB）")
    now = int(time.time() * 1000)
    c = conn()
    with _write_lock:
        c.execute("UPDATE users SET avatar = ?, updated_at = ? WHERE id = ?", (v, now, user["id"]))
        c.commit()
    row = c.execute("SELECT * FROM users WHERE id = ?", (user["id"],)).fetchone()
    return {"user": public_user(row)}


def set_profile(user, body):
    name = str(body.get("displayName") or "").strip()
    if not name:
        raise HttpError(400, "显示名不能为空")
    if len(name) > 32:
        raise HttpError(400, "显示名最长 32 个字")
    now = int(time.time() * 1000)
    c = conn()
    with _write_lock:
        c.execute("UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?", (name, now, user["id"]))
        c.commit()
    row = c.execute("SELECT * FROM users WHERE id = ?", (user["id"],)).fetchone()
    return {"user": public_user(row)}


# ─────────────────────────── 管理功能 ───────────────────────────

def _target(c, user_id):
    row = c.execute("SELECT * FROM users WHERE id = ?", (str(user_id or ""),)).fetchone()
    if not row:
        raise HttpError(404, "没有这个用户")
    return row


def _count_admins(c, exclude=None):
    q = "SELECT COUNT(*) FROM users WHERE role = 'admin'"
    args = ()
    if exclude:
        q += " AND id != ?"
        args = (exclude,)
    return c.execute(q, args).fetchone()[0]


def admin_set_role(user, target_id, role):
    """直接任命角色。取代了原来的导师邀请码。"""
    if not is_admin(user):
        raise HttpError(403, "只有管理员能改角色")
    if role not in ROLES:
        raise HttpError(400, "角色不对")
    c = conn()
    row = _target(c, target_id)
    if row["id"] == user["id"]:
        # 自己把自己降级就再也改不回来了，只能 SSH 上服务器救
        raise HttpError(403, "不能修改自己的角色，请让另一位管理员操作")
    if row["role"] == "admin" and role != "admin" and _count_admins(c, row["id"]) == 0:
        raise HttpError(409, "这是最后一个管理员，降级后就没人能管理了")

    now = int(time.time() * 1000)
    with _write_lock:
        c.execute("UPDATE users SET role = ?, pending_role = NULL, requested_at = NULL,"
                  " updated_at = ? WHERE id = ?", (role, now, row["id"]))
        c.commit()
    audit(user["username"], "改角色", row["username"], f'{row["role"]} → {role}')
    return {"user": public_user(c.execute("SELECT * FROM users WHERE id = ?", (row["id"],)).fetchone())}


def admin_archive_user(user, target_id, archived=True):
    """标记离组 / 恢复在组。

    离组不删任何东西——实验记录是课题组的资产，人走了数据得留下，
    以后追溯某个结论怎么来的还得靠它。只是把人从默认视图里挪走。
    """
    if not is_admin(user):
        raise HttpError(403, "只有管理员能操作")
    c = conn()
    row = _target(c, target_id)
    if row["id"] == user["id"]:
        raise HttpError(403, "不能把自己标记为离组")
    if archived and row["role"] == "admin" and _count_admins(c, row["id"]) == 0:
        raise HttpError(409, "这是最后一个管理员，不能标记离组")

    now = int(time.time() * 1000)
    with _write_lock:
        c.execute("UPDATE users SET archived_at = ?, updated_at = ? WHERE id = ?",
                  (now if archived else None, now, row["id"]))
        if archived:
            # 人都离组了，会话不该继续有效
            c.execute("DELETE FROM sessions WHERE user_id = ?", (row["id"],))
        c.commit()
    audit(user["username"], "标记离组" if archived else "恢复在组", row["username"],
          "记录全部保留" if archived else None)
    return {"user": public_user(c.execute("SELECT * FROM users WHERE id = ?", (row["id"],)).fetchone())}


def admin_delete_user(user, target_id):
    """彻底删除账号及其全部数据。只该用来清理误注册和测试账号。

    正常的离组走 archive——那个不删数据。
    """
    if not is_admin(user):
        raise HttpError(403, "只有管理员能删除")
    c = conn()
    row = _target(c, target_id)
    if row["id"] == user["id"]:
        raise HttpError(403, "不能删除自己")
    if row["role"] == "admin" and _count_admins(c, row["id"]) == 0:
        raise HttpError(409, "这是最后一个管理员，不能删除")

    # 先数清楚要删多少写进日志——删完就查不到了
    counts = {t: c.execute(f"SELECT COUNT(*) FROM {t} WHERE owner_id = ?", (row["id"],)).fetchone()[0]
              for t in SYNC_TABLES}
    photo_ids = [r["id"] for r in
                 c.execute("SELECT id FROM photos WHERE owner_id = ?", (row["id"],)).fetchall()]
    with _write_lock:
        c.execute("DELETE FROM users WHERE id = ?", (row["id"],))   # 外键级联删掉其余
        c.commit()
    for pid in photo_ids:                                            # 磁盘上的文件不受外键管
        try:
            (PHOTO_DIR / pid).unlink(missing_ok=True)
        except Exception:
            pass
    audit(user["username"], "彻底删除账号", row["username"],
          " ".join(f"{k}={v}" for k, v in counts.items()) + f" 照片文件={len(photo_ids)}")
    return {"ok": True, "removed": counts}


def admin_reset_password(user, target_id):
    """生成一次性临时密码。

    管理员不能指定密码——那样他就知道了别人的密码，之后能冒充对方。
    随机生成、只回显一次，让本人登录后自己改。
    """
    if not is_admin(user):
        raise HttpError(403, "只有管理员能重置密码")
    c = conn()
    row = _target(c, target_id)
    temp = secrets.token_urlsafe(9)
    now = int(time.time() * 1000)
    with _write_lock:
        c.execute("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?",
                  (hash_password(temp), now, row["id"]))
        c.execute("DELETE FROM sessions WHERE user_id = ?", (row["id"],))   # 旧会话一并踢掉
        c.commit()
    audit(user["username"], "重置密码", row["username"], "旧会话已全部吊销")
    return {"ok": True, "tempPassword": temp, "username": row["username"]}


def admin_revoke_sessions(user, target_id):
    """强制某人所有设备登出。设备丢了、或者怀疑账号被盗时用。"""
    if not is_admin(user):
        raise HttpError(403, "只有管理员能吊销会话")
    c = conn()
    row = _target(c, target_id)
    with _write_lock:
        n = c.execute("DELETE FROM sessions WHERE user_id = ?", (row["id"],)).rowcount
        c.commit()
    audit(user["username"], "吊销会话", row["username"], f"{n} 个会话")
    return {"ok": True, "revoked": n}


def admin_invite(user, new_code=None):
    """查看或更换邀请码。存数据库，改完立刻生效，不用重启。"""
    if not is_admin(user):
        raise HttpError(403, "只有管理员能管理邀请码")
    if new_code is None:
        return {"code": get_setting("invite_code", INVITE_CODE_ENV)}
    code = str(new_code).strip()
    if code and len(code) < 6:
        raise HttpError(400, "邀请码至少 6 位")
    set_setting("invite_code", code)
    audit(user["username"], "更换邀请码", None, "已清空（任何人可注册）" if not code else "已更新")
    return {"code": code}


def admin_status(user):
    """服务器状态：磁盘、数据量、备份、推送。省得为了看一眼还要 SSH。"""
    if not is_admin(user):
        raise HttpError(403, "只有管理员能查看")
    c = conn()
    counts = {t: c.execute(f"SELECT COUNT(*) FROM {t} WHERE deleted_at IS NULL").fetchone()[0]
              for t in SYNC_TABLES}
    counts["users"] = c.execute("SELECT COUNT(*) FROM users").fetchone()[0]
    counts["sessions"] = c.execute("SELECT COUNT(*) FROM sessions").fetchone()[0]

    try:
        st = os.statvfs(DATA_DIR)
        disk = {"freeBytes": st.f_bavail * st.f_frsize, "totalBytes": st.f_blocks * st.f_frsize}
    except Exception:
        disk = None

    photo_bytes = 0
    try:
        for f in PHOTO_DIR.iterdir():
            if f.is_file():
                photo_bytes += f.stat().st_size
    except Exception:
        pass

    backups = []
    try:
        bdir = Path.home() / "mochi" / "backups"
        for f in sorted(bdir.glob("mochi-*.db"), key=lambda x: x.stat().st_mtime, reverse=True)[:3]:
            backups.append({"name": f.name, "at": int(f.stat().st_mtime * 1000), "size": f.stat().st_size})
    except Exception:
        pass

    return {
        "counts": counts, "disk": disk, "photoBytes": photo_bytes,
        "dbBytes": DB_PATH.stat().st_size if DB_PATH.exists() else 0,
        "backups": backups, "push": bool(PUSH_OK and VAPID),
        "inviteSet": bool(get_setting("invite_code", INVITE_CODE_ENV)),
        "now": int(time.time() * 1000),
    }


def admin_audit(user, limit=60):
    if not is_admin(user):
        raise HttpError(403, "只有管理员能查看")
    rows = conn().execute("SELECT * FROM audit_log ORDER BY at DESC LIMIT ?",
                          (max(1, min(int(limit or 60), 200)),)).fetchall()
    return {"entries": [{"at": r["at"], "actor": r["actor"], "action": r["action"],
                         "target": r["target"], "detail": r["detail"]} for r in rows]}


def change_password(user, body):
    """本人改密码。要验旧密码——否则设备被人短暂拿到就能改掉密码锁死账号。"""
    c = conn()
    row = c.execute("SELECT * FROM users WHERE id = ?", (user["id"],)).fetchone()
    if not verify_password(str(body.get("oldPassword") or ""), row["password_hash"]):
        raise HttpError(401, "当前密码不正确")
    new = str(body.get("newPassword") or "")
    if len(new) < 8:
        raise HttpError(400, "新密码至少 8 位")
    now = int(time.time() * 1000)
    with _write_lock:
        c.execute("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?",
                  (hash_password(new), now, row["id"]))
        c.commit()
    return {"ok": True}


def list_requests(user):
    """待审批的导师申请。只有管理员看得到。"""
    if not is_admin(user):
        raise HttpError(403, "只有管理员能审批")
    rows = conn().execute(
        "SELECT * FROM users WHERE pending_role IS NOT NULL ORDER BY requested_at").fetchall()
    return {"requests": [public_user(r) for r in rows]}


def decide_request(user, target_id, approve):
    """批准或驳回一份导师申请。

    驳回不删账号——那个人仍然是正常学生，只是拿不到全组读取权限。
    """
    if not is_admin(user):
        raise HttpError(403, "只有管理员能审批")
    c = conn()
    row = c.execute("SELECT * FROM users WHERE id = ?", (str(target_id or ""),)).fetchone()
    if not row:
        raise HttpError(404, "没有这个用户")
    if not row["pending_role"]:
        raise HttpError(409, "该用户没有待审批的申请")
    if row["id"] == user["id"]:
        # 自己批自己等于导师码直通，把整套审批架空了
        raise HttpError(403, "不能审批自己的申请")

    new_role = row["pending_role"] if approve else row["role"]
    now = int(time.time() * 1000)
    with _write_lock:
        c.execute("UPDATE users SET role = ?, pending_role = NULL, requested_at = NULL,"
                  " updated_at = ? WHERE id = ?", (new_role, now, row["id"]))
        c.commit()
    audit(user["username"], "批准导师申请" if approve else "驳回导师申请", row["username"])
    fresh = c.execute("SELECT * FROM users WHERE id = ?", (row["id"],)).fetchone()
    return {"user": public_user(fresh), "approved": bool(approve)}


def group_overview(user):
    """导师端用的一次性概览：成员、每人的项目/记录数、活跃度。

    这些聚合放服务端算，前端不用把全组数据拉下来再统计——导师那边只是看，
    没必要把所有人的记录都塞进他的本地库。
    """
    if not can_read_group(user):
        raise HttpError(403, "只有导师能查看")
    c = conn()
    users = c.execute("SELECT * FROM users ORDER BY CASE role WHEN 'admin' THEN 0 WHEN 'advisor' THEN 1 ELSE 2 END, created_at").fetchall()
    out = []
    for u in users:
        recs = c.execute(
            "SELECT data, updated_at FROM records WHERE owner_id = ? AND deleted_at IS NULL",
            (u["id"],)).fetchall()
        projs = c.execute(
            "SELECT COUNT(*) FROM projects WHERE owner_id = ? AND deleted_at IS NULL",
            (u["id"],)).fetchone()[0]
        ats = []
        for r in recs:
            try:
                at = json.loads(r["data"]).get("at")
                if at:
                    ats.append(int(at))
            except Exception:
                pass
        item = public_user(u)
        item.update(projects=projs, records=len(recs), lastAt=max(ats) if ats else 0)
        # 谁该出现在「按成员」里：做科研记录的人。纯管理账号（比如只用来
        # 审批的导师/管理员，一条记录都没有）不该占着列表。
        item["inGroup"] = (u["role"] == "student") or len(recs) > 0 or projs > 0
        out.append(item)
    pending = c.execute("SELECT COUNT(*) FROM users WHERE pending_role IS NOT NULL").fetchone()[0]
    return {"members": out, "now": int(time.time() * 1000),
            "pendingRequests": pending if is_admin(user) else 0}


# ─────────────────────────── 推送 ───────────────────────────

def save_subscription(user, sub):
    """一台设备一条订阅。endpoint 唯一，重复订阅就更新而不是堆积。"""
    ep = str((sub or {}).get("endpoint") or "")
    keys = (sub or {}).get("keys") or {}
    # 真实推送端点一律是 https；回环地址放行是为了让端到端测试能跑起来，
    # 跟浏览器判定 secure context 的规则一致。
    ok_scheme = ep.startswith("https://") or ep.startswith("http://127.0.0.1:") \
        or ep.startswith("http://localhost:")
    if not ok_scheme or not keys.get("p256dh") or not keys.get("auth"):
        raise HttpError(400, "订阅信息不完整")
    sid = hashlib.sha256(ep.encode()).hexdigest()[:32]
    now = int(time.time() * 1000)
    c = conn()
    with _write_lock:
        c.execute("INSERT INTO push_subs (id, user_id, endpoint, p256dh, auth, created_at, last_ok, fail_count)"
                  " VALUES (?,?,?,?,?,?,NULL,0)"
                  " ON CONFLICT(id) DO UPDATE SET user_id=excluded.user_id,"
                  " p256dh=excluded.p256dh, auth=excluded.auth, fail_count=0",
                  (sid, user["id"], ep, keys["p256dh"], keys["auth"], now))
        c.commit()
    return {"ok": True, "id": sid}


def drop_subscription(user, endpoint):
    c = conn()
    sid = hashlib.sha256(str(endpoint or "").encode()).hexdigest()[:32]
    with _write_lock:
        c.execute("DELETE FROM push_subs WHERE id = ? AND user_id = ?", (sid, user["id"]))
        c.commit()
    return {"ok": True}


def put_reminders(user, items):
    """全量替换该用户的待发提醒。

    客户端每次同步都把「当前所有未来的提醒」整份传上来，服务端照单替换——
    比增量维护简单得多，也不会因为漏传一条删除就在半夜误报。
    """
    if not isinstance(items, list):
        raise HttpError(400, "reminders 必须是数组")
    now = int(time.time() * 1000)
    rows = []
    for it in items[:500]:
        try:
            due = int(it.get("dueAt") or 0)
        except (TypeError, ValueError):
            continue
        rid = str(it.get("id") or "")
        if not rid or not due:
            continue
        rows.append((rid, user["id"], due, str(it.get("title") or "提醒")[:200],
                     str(it.get("body") or "")[:300], now))
    c = conn()
    with _write_lock:
        old = {r["id"]: r["fired_at"] for r in
               c.execute("SELECT id, fired_at FROM reminders WHERE owner_id = ?", (user["id"],))}
        c.execute("DELETE FROM reminders WHERE owner_id = ?", (user["id"],))
        for r in rows:
            # 时间没变的旧提醒保留已发标记，避免客户端每次同步都让它重发一遍
            fired = old.get(r[0]) if r[0] in old else None
            c.execute("INSERT INTO reminders (id, owner_id, due_at, title, body, fired_at, updated_at)"
                      " VALUES (?,?,?,?,?,?,?)", (r[0], r[1], r[2], r[3], r[4], fired, r[5]))
        c.commit()
    return {"ok": True, "count": len(rows)}


def push_due_reminders():
    """扫描到期提醒并推送。由后台线程每 30 秒调一次。"""
    if not (PUSH_OK and VAPID):
        return 0
    now = int(time.time() * 1000)
    c = conn()
    # 只补发最近 1 小时内到期的：机器关过一整晚的话，早上不该被十几条隔夜提醒砸醒
    due = c.execute(
        "SELECT * FROM reminders WHERE fired_at IS NULL AND due_at <= ? AND due_at > ?",
        (now, now - 3600 * 1000)).fetchall()
    if not due:
        # 顺手把过期太久、永远不会发的清掉，别让表无限长
        with _write_lock:
            c.execute("DELETE FROM reminders WHERE fired_at IS NULL AND due_at <= ?",
                      (now - 7 * 24 * 3600 * 1000,))
            c.commit()
        return 0

    sent = 0
    for rem in due:
        subs = c.execute("SELECT * FROM push_subs WHERE user_id = ?", (rem["owner_id"],)).fetchall()
        payload = {"title": rem["title"], "body": rem["body"], "tag": f"mochi-{rem['id']}",
                   "todoId": rem["id"]}
        for sub in subs:
            try:
                webpush.send({"endpoint": sub["endpoint"],
                              "keys": {"p256dh": sub["p256dh"], "auth": sub["auth"]}},
                             payload, VAPID)
                with _write_lock:
                    c.execute("UPDATE push_subs SET last_ok = ?, fail_count = 0 WHERE id = ?",
                              (now, sub["id"]))
                    c.commit()
                sent += 1
            except webpush.PushGone:
                # 设备卸载了 app 或清了数据，订阅永久失效，留着只会每次都失败
                with _write_lock:
                    c.execute("DELETE FROM push_subs WHERE id = ?", (sub["id"],))
                    c.commit()
                print(f"[push] 订阅已失效，已移除 {sub['id'][:8]}", flush=True)
            except Exception as e:
                with _write_lock:
                    c.execute("UPDATE push_subs SET fail_count = fail_count + 1 WHERE id = ?", (sub["id"],))
                    c.execute("DELETE FROM push_subs WHERE fail_count >= 10")
                    c.commit()
                print(f"[push] 发送失败 {sub['id'][:8]}: {e}", flush=True)
        with _write_lock:
            c.execute("UPDATE reminders SET fired_at = ? WHERE id = ?", (now, rem["id"]))
            c.commit()
    return sent


def push_loop():
    while True:
        try:
            n = push_due_reminders()
            if n:
                print(f"[push] 已发送 {n} 条通知", flush=True)
        except Exception as e:
            print(f"[push] 扫描出错: {e}", flush=True)
        time.sleep(30)


def readable_photo(user, pid):
    row = conn().execute("SELECT * FROM photos WHERE id = ?", (pid,)).fetchone()
    if not row or row["deleted_at"]:
        return None
    if row["owner_id"] != user["id"] and not can_read_group(user):
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
        self._body_read = True
        return self.rfile.read(n) if n else b""

    def _drain(self):
        """把没读的请求体丢掉。

        HTTP/1.1 连接是复用的：有的处理分支（比如 /api/push/test）根本不看
        请求体，也有的在读之前就抛错了，剩下的字节会被当成下一个请求的
        起始行——日志里那条 `"{}POST /api/push/test" 501` 就是这么来的。
        """
        if getattr(self, "_body_read", False):
            return
        self._body_read = True
        n = int(self.headers.get("Content-Length") or 0)
        while n > 0:
            chunk = self.rfile.read(min(n, 65536))
            if not chunk:
                break
            n -= len(chunk)

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
        self._body_read = False
        try:
            path = urlparse(self.path).path
            query = parse_qs(urlparse(self.path).query)

            if path == "/api/health":
                return self._json({"ok": True, "now": int(time.time() * 1000),
                                   "push": bool(PUSH_OK and VAPID)})
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
                if not can_read_group(u):
                    raise HttpError(403, "只有导师能查看成员列表")
                rows = conn().execute("SELECT * FROM users ORDER BY CASE role WHEN 'admin' THEN 0 WHEN 'advisor' THEN 1 ELSE 2 END, created_at").fetchall()
                return self._json({"users": [public_user(r) for r in rows]})
            if method == "POST" and path == "/api/avatar":
                return self._json(set_avatar(self._need_user(), self._json_body().get("avatar")))
            if method == "POST" and path == "/api/profile":
                return self._json(set_profile(self._need_user(), self._json_body()))
            if method == "POST" and path == "/api/admin/role":
                b = self._json_body()
                return self._json(admin_set_role(self._need_user(), b.get("userId"), b.get("role")))
            if method == "POST" and path == "/api/admin/archive":
                b = self._json_body()
                return self._json(admin_archive_user(self._need_user(), b.get("userId"),
                                                     bool(b.get("archived", True))))
            if method == "POST" and path == "/api/admin/remove":
                return self._json(admin_delete_user(self._need_user(), self._json_body().get("userId")))
            if method == "POST" and path == "/api/admin/reset-password":
                return self._json(admin_reset_password(self._need_user(), self._json_body().get("userId")))
            if method == "POST" and path == "/api/admin/revoke-sessions":
                return self._json(admin_revoke_sessions(self._need_user(), self._json_body().get("userId")))
            if method == "GET" and path == "/api/admin/invite":
                return self._json(admin_invite(self._need_user()))
            if method == "POST" and path == "/api/admin/invite":
                return self._json(admin_invite(self._need_user(), self._json_body().get("code", "")))
            if method == "GET" and path == "/api/admin/status":
                return self._json(admin_status(self._need_user()))
            if method == "GET" and path == "/api/admin/audit":
                return self._json(admin_audit(self._need_user()))
            if method == "POST" and path == "/api/password":
                return self._json(change_password(self._need_user(), self._json_body()))

            if method == "GET" and path == "/api/admin/requests":
                return self._json(list_requests(self._need_user()))
            if method == "POST" and path == "/api/admin/decide":
                b = self._json_body()
                return self._json(decide_request(self._need_user(), b.get("userId"),
                                                 bool(b.get("approve"))))

            if method == "GET" and path == "/api/overview":
                return self._json(group_overview(self._need_user()))

            if method == "GET" and path == "/api/push/key":
                # 前端订阅时要用它做 applicationServerKey
                return self._json({"key": VAPID["public"] if (PUSH_OK and VAPID) else None,
                                   "enabled": bool(PUSH_OK and VAPID)})
            if method == "POST" and path == "/api/push/subscribe":
                return self._json(save_subscription(self._need_user(), self._json_body().get("subscription")))
            if method == "POST" and path == "/api/push/unsubscribe":
                return self._json(drop_subscription(self._need_user(), self._json_body().get("endpoint")))
            if method == "POST" and path == "/api/reminders":
                return self._json(put_reminders(self._need_user(), self._json_body().get("reminders")))
            if method == "POST" and path == "/api/push/test":
                # 用户点「发送测试通知」时走这条，立刻推一条，不用等到点
                u = self._need_user()
                if not (PUSH_OK and VAPID):
                    raise HttpError(503, "服务器未启用推送")
                c = conn()
                subs = c.execute("SELECT * FROM push_subs WHERE user_id = ?", (u["id"],)).fetchall()
                if not subs:
                    raise HttpError(400, "这台设备还没有订阅推送")
                ok, errs = 0, []
                for sub in subs:
                    try:
                        webpush.send({"endpoint": sub["endpoint"],
                                      "keys": {"p256dh": sub["p256dh"], "auth": sub["auth"]}},
                                     {"title": "✅ 推送已就绪", "body": "到点时就会像这样提醒你",
                                      "tag": "mochi-test"}, VAPID)
                        ok += 1
                    except Exception as e:
                        errs.append(str(e)[:120])
                if not ok:
                    raise HttpError(502, "推送失败：" + "；".join(errs[:2]))
                return self._json({"ok": True, "sent": ok})

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
        finally:
            self._drain()


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
    if not get_setting("invite_code", INVITE_CODE_ENV):
        print("⚠️  未设置邀请码，任何人都能注册")

    global VAPID
    VAPID = load_vapid()
    if PUSH_OK and VAPID:
        threading.Thread(target=push_loop, daemon=True).start()
        print(f"推送已启用，VAPID 公钥: {VAPID['public'][:24]}…")
    else:
        print(f"⚠️  推送未启用（{'缺少 cryptography' if not PUSH_OK else 'VAPID 密钥不可用'}），同步功能不受影响")

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
