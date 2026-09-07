#!/usr/bin/env python3
"""Mochi 实验记录同步服务。

只同步实验记录（projects / records / photos / comments / milestones / 数据文件），
个人待办和计时数据留在设备本地。
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
    MOCHI_MAX_FILE_MB  单个数据文件上限，默认 512
    MOCHI_USER_QUOTA_MB 每人数据文件总量上限，默认 10240
    MOCHI_ORPHAN_GRACE_H 数据文件多久没被记录引用就回收，默认 24 小时
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
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlparse, parse_qs, quote as urlquote

DATA_DIR = Path(os.environ.get("MOCHI_DATA") or Path.home() / "mochi-data")
PHOTO_DIR = DATA_DIR / "photos"
FILE_DIR = DATA_DIR / "files"
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

# 积分：一条记录 1 分，导师的每个赞 / 每条点评各 5 分。
# 每天最多 3 条记录——防的是「为了刷分把一条拆成十条」。
MAX_RECORDS_PER_DAY = int(os.environ.get("MOCHI_MAX_RECORDS_PER_DAY") or 3)
# 只有导师的**点赞**计分。点评不计分：那是给学生的反馈，不该变成筹码——
# 总不该让导师在「要不要多写一句」时先想想给不给分。
# 同学之间也能互相点赞，同样不计分，否则互刷就是几分钟的事。
PT_RECORD, PT_LIKE = 1, 5

MAX_PHOTO = 8 * 1024 * 1024

# 数据文件跟照片是两码事：照片是压好的缩略证据，几百 KB，随记录同步到每台
# 设备；数据文件是原始测量结果，动辄几百 MB，只在服务器上放一份，谁要谁下。
# 所以它走分块上传（前端切片、断了能续），全程流式落盘，不进内存。
MAX_FILE = int(os.environ.get("MOCHI_MAX_FILE_MB") or 512) * 1024 * 1024
MAX_CHUNK = 8 * 1024 * 1024          # 前端切 4MB，留一倍余量
USER_QUOTA = int(os.environ.get("MOCHI_USER_QUOTA_MB") or 10240) * 1024 * 1024
IO_CHUNK = 1 << 16
# 上传是选完文件就发生的，而引用它的记录可能永远没被保存（写到一半关掉了）。
# 没有这段宽限期后的回收，每一次中途放弃都在磁盘上留下几百 MB。
ORPHAN_GRACE = int(os.environ.get("MOCHI_ORPHAN_GRACE_H") or 24) * 3600 * 1000
TICKET_TTL = 5 * 60 * 1000
SESSION_TTL = 90 * 24 * 3600
SYNC_TABLES = ("projects", "records", "photos", "comments", "milestones", "todos")
# 实验记录是科研产出，导师有正当理由查看；待办里带着专注计时和 timeline
# （几点开始、暂停几次、有没有在玩手机），那是行为数据，性质完全不同——
# 同步只是为了本人多设备互通，导师一律看不到，由服务端强制。
ADVISOR_VISIBLE = ("projects", "records", "photos", "comments", "milestones")
# 重点节点是**组里的共同日程**（投稿截止、组会、答辩），跟「谁记的」无关：
# 所有人都读得到，但只有导师和管理员写得了。学生各自能建的话，日历上就会
# 冒出一堆只有本人看得见的私人条目，那就不是组日程了。
GROUP_SHARED = ("milestones",)

# 三种角色。admin 是 advisor 的超集：除了能看全组记录，还能审批导师申请。
# 用导师码注册只是「申请」，在管理员点头之前一律按学生对待——否则导师码
# 一旦外泄，拿到的人立刻就能读全组记录。
ROLES = ("student", "advisor", "admin")
GROUP_READERS = ("advisor", "admin")
GROUP_WRITABLE_BY = GROUP_READERS      # 谁能写 GROUP_SHARED 里的表

# 按人开放的功能。待办 / 专注计时是「个人时间管理」，跟实验记录本不是一回事——
# 组里多数人只需要记录本，那一半摆在最显眼的第一个页签上只是干扰。所以默认关，
# 由管理员一个个开。
#
# 这不是安全边界：待办数据本来就只有本人拉得回（ADVISOR_VISIBLE 里没有它，
# 服务端强制），这里管的只是「界面上给不给这个人显示待办这一半」。也正因如此，
# 收回权限不动任何数据——人本来就在自己机器上存着，再开放回来一条不少。
FEATURES = ("todo",)


def can_read_group(user):
    return user and user.get("role") in GROUP_READERS


def is_admin(user):
    return user and user.get("role") == "admin"
PAGE = 500

# 这是台多用户机器。main() 里的 umask 管不到这两行——它们在模块导入时就执行了，
# 新建的目录会拿到 775，组里其他账号能列目录。所以权限在这儿显式钉死。
for _d in (PHOTO_DIR, FILE_DIR):
    _d.mkdir(parents=True, exist_ok=True)
    try:
        _d.chmod(0o700)
    except OSError:
        pass

# ─────────────────────────── 数据库 ───────────────────────────

SCHEMA = """
CREATE TABLE IF NOT EXISTS seq_counter (id INTEGER PRIMARY KEY CHECK (id = 1), n INTEGER NOT NULL);
INSERT OR IGNORE INTO seq_counter (id, n) VALUES (1, 0);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'student', created_at INTEGER NOT NULL,
  avatar TEXT, updated_at INTEGER NOT NULL DEFAULT 0,
  pending_role TEXT, requested_at INTEGER, archived_at INTEGER, features TEXT);

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
  data TEXT NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER, seq INTEGER NOT NULL DEFAULT 0,
  day TEXT, project_id TEXT);
CREATE INDEX IF NOT EXISTS idx_records_seq ON records(seq);
CREATE INDEX IF NOT EXISTS idx_records_owner ON records(owner_id, seq);
/* day 的索引不在这里建：老库里 records 表已经存在，CREATE TABLE IF NOT EXISTS
   是空操作，day 列还没补上，在这儿建索引会直接 no such column 起不来。
   见 init_db()——补完列再建。 */

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

/* 导师的回复和点赞。owner_id 是发言人，而拉取是按 owner_id 过滤的——
   所以必须冗余存一份「被评论记录的作者」，否则导师写的回复学生根本拉不到。
   record_id 单独成列是为了删记录时能连带清掉。 */
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  data TEXT NOT NULL, record_id TEXT, target_owner TEXT,
  updated_at INTEGER NOT NULL, deleted_at INTEGER, seq INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_comments_seq ON comments(seq);
CREATE INDEX IF NOT EXISTS idx_comments_owner ON comments(owner_id, seq);
CREATE INDEX IF NOT EXISTS idx_comments_target ON comments(target_owner, seq);

/* 日历上的重点节点：投稿截止、组会、开题、答辩这些。全组共享：谁都读得到，
   只有导师写得了。owner_id 记的是「谁定的」，不影响谁看得到。 */
CREATE TABLE IF NOT EXISTS milestones (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  data TEXT NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER, seq INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_ms_seq ON milestones(seq);
CREATE INDEX IF NOT EXISTS idx_ms_owner ON milestones(owner_id, seq);

/* 项目成员的倒排索引。成员名单本身存在项目 data 里跟着同步走，这张表只是
   为了让「拉取我参与的项目」能走索引，而不是每次去解析每行 JSON。 */
CREATE TABLE IF NOT EXISTS project_members (
  project_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (project_id, user_id));
CREATE INDEX IF NOT EXISTS idx_pm_user ON project_members(user_id);

/* 数据文件不进 SYNC_TABLES：文件名、大小这些元数据是跟着记录正文一起同步的
   （record.data.files[]），这张表只负责回答「这坨字节归谁、传完了没有」。 */
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT '', mime TEXT NOT NULL DEFAULT 'application/octet-stream',
  size INTEGER NOT NULL DEFAULT 0, uploaded INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_files_owner ON files(owner_id);
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
    # 顺序要紧：先补列，再建索引。反过来在老库上会 no such column 直接崩，
    # 而测试用的永远是新建的空库（CREATE TABLE 里就带 day），抓不到这个。
    rhave = {r[1] for r in c.execute("PRAGMA table_info(records)")}
    for col in ("day TEXT", "project_id TEXT"):
        if col.split()[0] not in rhave:
            c.execute(f"ALTER TABLE records ADD COLUMN {col}")
    for tbl in ("photos", "files"):
        cols = {r[1] for r in c.execute(f"PRAGMA table_info({tbl})")}
        if "project_id" not in cols:
            c.execute(f"ALTER TABLE {tbl} ADD COLUMN project_id TEXT")
    if "day" not in rhave:
        # 老数据补上归日。库很小（几百条），一次性扫完就好
        for rid, blob in c.execute("SELECT id, data FROM records").fetchall():
            try:
                at = json.loads(blob).get("at")
            except Exception:
                at = None
            if at:
                c.execute("UPDATE records SET day = ? WHERE id = ?", (bj_day(at), rid))
    if "project_id" not in rhave:
        # 回填归属项目，可见性要靠它过滤；顺带把照片和数据文件也挂上
        for rid, blob in c.execute("SELECT id, data FROM records").fetchall():
            try:
                d = json.loads(blob) or {}
            except Exception:
                continue
            pid = d.get("projectId")
            if not pid:
                continue
            c.execute("UPDATE records SET project_id = ? WHERE id = ?", (pid, rid))
            for ph in (d.get("photos") or []):
                c.execute("UPDATE photos SET project_id = ? WHERE id = ?", (pid, ph))
            for f in (d.get("files") or []):
                if isinstance(f, dict) and f.get("id"):
                    c.execute("UPDATE files SET project_id = ? WHERE id = ?", (pid, f["id"]))
    c.execute("CREATE INDEX IF NOT EXISTS idx_records_day ON records(owner_id, day)")
    c.execute("CREATE INDEX IF NOT EXISTS idx_records_project ON records(project_id)")

    have = {r[1] for r in c.execute("PRAGMA table_info(users)")}
    for col, decl in (("avatar", "TEXT"), ("updated_at", "INTEGER NOT NULL DEFAULT 0"),
                      ("pending_role", "TEXT"), ("requested_at", "INTEGER"),
                      ("archived_at", "INTEGER"), ("features", "TEXT")):
        if col not in have:
            c.execute(f"ALTER TABLE users ADD COLUMN {col} {decl}")
    if "features" not in have:
        # 升级到「待办按人开放」的这一刻：老用户一律关——全组默认看不到待办，
        # 正是这个改动的本意。唯独管理员先开着：他是唯一能再打开的人，
        # 把他自己也关在外面，只会让人以为升级把功能弄丢了。
        c.execute("UPDATE users SET features = ? WHERE role = 'admin'",
                  (json.dumps({"todo": True}),))
    c.commit()
    c.close()


def bj_day(ts_ms):
    """时间戳归到北京时间的哪一天。全组按同一时区分天，否则同一条记录在
    不同人的界面上会落在不同日期，日限额和排行榜也就对不上了。"""
    try:
        t = time.gmtime((int(ts_ms) + 8 * 3600 * 1000) / 1000)
        return time.strftime("%Y-%m-%d", t)
    except Exception:
        return None


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
    """管理操作一律留痕。出了事要能回答「谁在什么时候动了什么」。

    **它自己要拿 _write_lock，所以绝不能在已经持锁的事务里调用**——那是个
    不可重入锁，会当场死锁（push() 里改项目成员时踩过一次）。事务里要留痕
    就先攒着，提交完再写：真回滚了也不会留下一条其实没发生的记录。
    """
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


def user_features(row):
    """这个人被开放了哪些功能。默认全关。

    存成一个 JSON 列而不是每个功能一列：以后再想按人开放别的东西，
    不用再动一次表结构（线上加列踩过坑，见 SCHEMA 那段注释）。
    """
    try:
        raw = row["features"]
    except (IndexError, KeyError):
        return {}                       # 老库还没补上这一列
    try:
        f = json.loads(raw or "{}")
    except (TypeError, ValueError):
        return {}
    if not isinstance(f, dict):
        return {}
    return {k: True for k in FEATURES if f.get(k)}


def public_user(row, with_avatar=True):
    u = {"id": row["id"], "username": row["username"],
         "displayName": row["display_name"], "role": row["role"],
         "features": user_features(row)}
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

def hidden_projects(user):
    """这个人看不到的项目 id。

    两种情况算「受限」，只对名单内的人开放（外加项目主人和导师）：
      - 有成员名单的项目（导师圈定了谁参与）
      - **导师自己建的项目**，哪怕名单还空着

    第二条是必须的：只看名单的话，导师刚建完还没加人时它是全组可见的，
    加上第一个人的瞬间又对所有人消失——这个跳变没法跟人解释。导师建的项目
    从头到尾都是圈定范围的，那就从创建起就受限。

    其余的都是个人课题，全组可见——组里互相看得到彼此在做什么本来就是好事，
    这也正是这次要的。
    """
    if can_read_group(user):
        return set()
    uid = user["id"]
    return {r["id"] for r in conn().execute(
        "SELECT id FROM projects WHERE owner_id != ?"
        " AND (owner_id IN (SELECT id FROM users WHERE role IN ('advisor','admin'))"
        "      OR id IN (SELECT project_id FROM project_members))"
        " AND id NOT IN (SELECT project_id FROM project_members WHERE user_id = ?)",
        (uid, uid))}


def can_see_record(row, hidden, uid):
    if row["owner_id"] == uid:
        return True
    pid = row["project_id"] if "project_id" in row.keys() else None
    return bool(pid) and pid not in hidden


def shape(table, r):
    out = {"id": r["id"], "ownerId": r["owner_id"],
           "data": None if r["deleted_at"] else json.loads(r["data"]),
           "updatedAt": r["updated_at"], "deletedAt": r["deleted_at"], "seq": r["seq"]}
    if table == "photos":
        out.update(mime=r["mime"], size=r["size"], uploaded=bool(r["uploaded"]))
    return out


def tomb(table, r):
    """把一行伪装成墓碑：内容一个字都不给，但客户端知道该把本地那份删掉。"""
    out = shape(table, r)
    out["data"] = None
    out["deletedAt"] = r["deleted_at"] or r["updated_at"]
    return out


def pull(user, since):
    """增量拉取。待办任何角色都只能看自己的；实验记录是全组共享的。

    项目和记录的可见性由 hidden_projects() 决定：个人课题全组可见，
    有成员名单的项目只给名单内的人。

    不可见的行**发墓碑而不是直接过滤掉**：客户端可能早就存着旧的那一份
    （比如导师后来给某个项目加了名单，它就此变成受限），不发墓碑的话
    那份数据会一直留在他设备上。
    """
    c = conn()
    uid = user["id"]
    hidden = hidden_projects(user)
    out = {"since": since, "seq": since, "more": False}
    for t in SYNC_TABLES:
        advisor = can_read_group(user) and t in ADVISOR_VISIBLE
        veil = None
        if advisor or t in ("projects", "records"):
            rows = c.execute(f"SELECT * FROM {t} WHERE seq > ? ORDER BY seq LIMIT ?", (since, PAGE)).fetchall()
            if not advisor:
                veil = (lambda r: r["id"] not in hidden) if t == "projects" \
                    else (lambda r: can_see_record(r, hidden, uid))
        elif t in GROUP_SHARED:
            rows = c.execute(f"SELECT * FROM {t} WHERE seq > ? ORDER BY seq LIMIT ?",
                             (since, PAGE)).fetchall()
        elif t == "comments":
            rows = c.execute(
                "SELECT * FROM comments WHERE (owner_id = ? OR target_owner = ?)"
                " AND seq > ? ORDER BY seq LIMIT ?", (uid, uid, since, PAGE)).fetchall()
        else:
            rows = c.execute(f"SELECT * FROM {t} WHERE owner_id = ? AND seq > ? ORDER BY seq LIMIT ?",
                             (uid, since, PAGE)).fetchall()
        out[t] = [shape(t, r) if (veil is None or veil(r)) else tomb(t, r) for r in rows]
        if len(rows) == PAGE:
            out["more"] = True
        for r in rows:
            out["seq"] = max(out["seq"], r["seq"])
    if not out["more"] and out["seq"] == since:
        out["seq"] = current_seq(c)
    return out


def push(user, changes):
    """推送本地改动。只能写自己的；同一条记录以 updatedAt 较大的一方为准（LWW）。

    拒绝时把服务器上的当前版本一起回传（current）。不回传的话客户端没法自愈：
    那一行的 seq 并没有变，后续增量拉取永远不会再把它发下来，被拒的本地改动
    就这么留在那台设备上，成了一份只有他自己看得见的假数据。
    """
    c = conn()
    res = {"applied": 0, "skipped": 0, "rejected": []}
    notices = []          # 落库之后再发，不能占着写锁做网络 I/O
    audits = []           # 同理：audit() 会去抢同一把写锁，攒到提交后再写
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

                    def reject(why, cur=None):
                        out = {"table": t, "id": rid, "why": why}
                        if cur is not None:
                            out["current"] = shape(t, cur)
                        res["rejected"].append(out)
                    try:
                        updated_at = int(row.get("updatedAt") or 0)
                    except (TypeError, ValueError):
                        updated_at = 0
                    if not updated_at:
                        reject("缺少 updatedAt")
                        continue

                    cur = c.execute(f"SELECT * FROM {t} WHERE id = ?", (rid,)).fetchone()
                    if t in GROUP_SHARED and user["role"] not in GROUP_WRITABLE_BY:
                        reject("只有导师能设置重点节点", cur)
                        continue
                    # 组共享的东西谁定的都能改：换了导师之后，前一个导师定的
                    # 组会日程不该就此冻在那儿没人动得了
                    if cur and updated_at <= cur["updated_at"]:
                        res["skipped"] += 1
                        continue

                    deleted_at = int(row["deletedAt"]) if row.get("deletedAt") else None
                    payload = {} if deleted_at else (row.get("data") or {})
                    data = json.dumps(payload, ensure_ascii=False)

                    # 这一段必须放在 deleted_at / payload / data 算完之后：它要用到它们
                    if cur and cur["owner_id"] != user["id"] and t not in GROUP_SHARED:
                        # 导师可以调整**任何**项目的成员名单——组里谁参与哪个课题
                        # 本来就是导师在管。但只准动 members：项目名、颜色这些
                        # 仍然是建它那个人的。
                        #
                        # 只取 members 而不是整份覆盖，还挡掉一个必然会踩的坑：
                        # 导师端推的是他本地那份项目对象，要是学生刚改过名字而
                        # 他还没同步到，整推就会把新名字盖回旧的。
                        # deleted_at 一并挡掉：删除推上来时 payload 是空的，
                        # 走合并的话会把成员清光、名字也丢掉，而项目还留着
                        if t == "projects" and can_read_group(user) and not deleted_at:
                            payload = merge_members(c, cur, payload, user, audits)
                            data = json.dumps(payload, ensure_ascii=False)
                        else:
                            reject("不能修改别人的记录", cur)
                            continue

                    if t == "comments" and not deleted_at:
                        why = comment_target_error(c, user, payload)
                        if why:
                            reject(why, cur)
                            continue

                    # 每天最多 3 条记录。只拦新增：已有记录的编辑照常，
                    # 否则改个错别字都会因为「今天满了」而被拒。
                    if t == "records" and not deleted_at and not cur:
                        day = bj_day(payload.get("at"))
                        if day:
                            n = c.execute(
                                "SELECT COUNT(*) FROM records"
                                " WHERE owner_id = ? AND day = ? AND deleted_at IS NULL",
                                (user["id"], day)).fetchone()[0]
                            if n >= MAX_RECORDS_PER_DAY:
                                reject(f"一天最多记 {MAX_RECORDS_PER_DAY} 条，这天已经满了")
                                continue

                    if cur:
                        c.execute(f"UPDATE {t} SET data=?, updated_at=?, deleted_at=?, seq=? WHERE id=?",
                                  (data, updated_at, deleted_at, next_seq(c), rid))
                    else:
                        c.execute(f"INSERT INTO {t} (id, owner_id, data, updated_at, deleted_at, seq)"
                                  " VALUES (?,?,?,?,?,?)",
                                  (rid, user["id"], data, updated_at, deleted_at, next_seq(c)))

                    if t == "records" and not deleted_at:
                        pid = payload.get("projectId")
                        c.execute("UPDATE records SET day = ?, project_id = ? WHERE id = ?",
                                  (bj_day(payload.get("at")), pid, rid))
                        # 照片和数据文件跟着记录走：可见性、回收都要知道它们属于
                        # 哪个项目，而它们自己是先于记录上传的，当时还不知道
                        if pid:
                            for ph in (payload.get("photos") or []):
                                c.execute("UPDATE photos SET project_id = ? WHERE id = ?", (pid, ph))
                            for f in (payload.get("files") or []):
                                if isinstance(f, dict) and f.get("id"):
                                    c.execute("UPDATE files SET project_id = ? WHERE id = ?",
                                              (pid, f["id"]))
                    # 成员名单跟着项目 data 同步过来，这里同步进倒排索引
                    if t == "projects":
                        reindex_members(c, rid, payload)
                    # 评论要记下它挂在哪条记录、那条记录是谁的——学生靠这个才拉得到。
                    # 删除时不能碰这两列：墓碑的 data 是空的，跟着清掉的话学生就
                    # 再也拉不到这条墓碑，取消的赞会永远留在他屏幕上。
                    if t == "comments" and not deleted_at:
                        rec = c.execute("SELECT owner_id, data FROM records WHERE id = ?",
                                        (str(payload.get("recordId") or ""),)).fetchone()
                        c.execute("UPDATE comments SET record_id = ?, target_owner = ? WHERE id = ?",
                                  (payload.get("recordId"), rec["owner_id"] if rec else None, rid))
                        # 只在这条评论是**新增**时通知：客户端偶尔会把同一条重推
                        # （比如推送记账丢了），按 updatedAt 判断的话对方会被
                        # 同一个赞反复吵醒。
                        if rec and not cur and rec["owner_id"] != user["id"]:
                            try:
                                rec_text = json.loads(rec["data"]).get("text")
                            except Exception:
                                rec_text = ""
                            notices.append((rec["owner_id"], comment_notice(
                                user, payload.get("kind"), payload.get("text"),
                                rec_text, payload.get("recordId"))))
                    res["applied"] += 1
            c.commit()
        except Exception:
            c.rollback()
            raise
    for a in audits:
        audit(*a)
    # 推送要等事务提交完再发：发到一半回滚的话，对方会收到一条不存在的点评
    if notices:
        threading.Thread(target=deliver, args=(notices,), daemon=True).start()
    res["seq"] = current_seq(c)
    return res


def merge_members(c, cur, payload, user, audits):
    """导师改别人项目的成员名单：以库里那份为底，只换 members。

    留痕不在这里写：调用方还握着写锁，audit() 会去抢同一把锁。攒进 audits，
    提交之后再落。
    """
    try:
        base = json.loads(cur["data"]) or {}
    except Exception:
        base = {}
    old = [m for m in (base.get("members") or []) if isinstance(m, str)]
    new = [m for m in (payload.get("members") or []) if isinstance(m, str)]
    if set(old) != set(new):
        names = {r["id"]: r["username"] for r in c.execute("SELECT id, username FROM users")}
        added = [names.get(x, x[:8]) for x in new if x not in old]
        removed = [names.get(x, x[:8]) for x in old if x not in new]
        detail = "；".join(filter(None, [
            ("加入 " + "、".join(added)) if added else "",
            ("移出 " + "、".join(removed)) if removed else "",
        ]))
        # target 存项目 id，好按项目把这些记录捞出来给导师看
        audits.append((user["username"], "改项目成员", cur["id"],
                       f'{base.get("name") or "未命名项目"}：{detail}'))
    return {**base, "members": new}


def project_log(user, project_id, limit=30):
    """某个项目的成员管理记录。导师之间互相能看见对方动过什么。"""
    if not can_read_group(user):
        raise HttpError(403, "只有导师能查看")
    rows = conn().execute(
        "SELECT * FROM audit_log WHERE action = '改项目成员' AND target = ?"
        " ORDER BY at DESC LIMIT ?", (str(project_id or ""), max(1, min(int(limit), 100)))).fetchall()
    return {"entries": [{"at": r["at"], "actor": r["actor"], "detail": r["detail"]} for r in rows]}


def reindex_members(c, project_id, data):
    """把项目 data 里的成员名单刷进倒排索引。项目删了（data 为空）就清空。"""
    members = data.get("members") if isinstance(data, dict) else None
    ids = [m for m in (members or []) if isinstance(m, str) and m][:200]
    c.execute("DELETE FROM project_members WHERE project_id = ?", (project_id,))
    for uid in ids:
        # 名单里可能有已被删掉的账号，外键会拦下来，跳过即可
        try:
            c.execute("INSERT OR IGNORE INTO project_members (project_id, user_id) VALUES (?,?)",
                      (project_id, uid))
        except sqlite3.IntegrityError:
            pass


def comment_target_error(c, user, data):
    """评论只能挂在自己看得到的记录上。

    不查的话，知道（或猜中）一个记录 id 就能往别人的记录下面塞东西——
    而那条评论会因为 target_owner 的关系直接出现在对方界面上。
    """
    rid = data.get("recordId")
    if not isinstance(rid, str) or not rid:
        return "评论缺少 recordId"
    rec = c.execute("SELECT owner_id, deleted_at, project_id FROM records WHERE id = ?",
                    (rid,)).fetchone()
    if not rec or rec["deleted_at"]:
        return "这条记录不存在"
    # 看得到就评得了：同学之间也能互相点赞（只是不计分）
    if not can_see_record(rec, hidden_projects(user), user["id"]):
        return "看不到这条记录"
    return None


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


# ─────────────────────────── 数据文件 ───────────────────────────
#
# 上传分三步：init 报文件名和大小拿到续传点 → 按块 POST 二进制 → 传满即完成。
# 中断了重来一次 init 就能从断点接着传，不用把几百 MB 重传一遍。
#
# 下载不走 Authorization：几百 MB 的东西必须让浏览器自己去拉（能续传、能进
# 下载列表、不占页面内存），而 <a href> 是带不上请求头的。所以先换一张五分钟
# 有效的下载票，token 本身不进 URL、不进访问日志。

_file_locks = {}
_file_locks_guard = threading.Lock()


def file_lock(fid):
    """同一个文件的写入必须串行——两个块同时 append 会把内容交错写坏。"""
    with _file_locks_guard:
        lk = _file_locks.get(fid)
        if lk is None:
            lk = _file_locks[fid] = threading.Lock()
        return lk


def _part(fid):
    return FILE_DIR / (fid + ".part")


def user_file_bytes(c, owner_id, exclude=None):
    rows = c.execute("SELECT id, size FROM files WHERE owner_id = ?", (owner_id,)).fetchall()
    return sum(r["size"] for r in rows if r["id"] != exclude)


def file_init(user, fid, body):
    """登记一个待上传的文件，返回已经收到多少字节（续传点）。"""
    name = str(body.get("name") or "").strip()[:180]
    mime = str(body.get("mime") or "").strip()[:80] or "application/octet-stream"
    try:
        size = int(body.get("size") or 0)
    except (TypeError, ValueError):
        size = 0
    if not name:
        raise HttpError(400, "缺少文件名")
    if size <= 0:
        raise HttpError(400, "这个文件是空的")
    if size > MAX_FILE:
        raise HttpError(413, f"单个文件不能超过 {MAX_FILE // 1024 // 1024} MB")

    c = conn()
    now = int(time.time() * 1000)
    row = c.execute("SELECT * FROM files WHERE id = ?", (fid,)).fetchone()
    if row and row["owner_id"] != user["id"]:
        raise HttpError(403, "这个编号已经属于别人")

    final = FILE_DIR / fid
    if row and row["uploaded"] and row["size"] == size and final.exists():
        return {"ok": True, "received": size, "done": True}     # 同一个文件重复挑选，直接复用

    used = user_file_bytes(c, user["id"], exclude=fid)
    if used + size > USER_QUOTA:
        raise HttpError(507, f"你的数据文件已占用 {used // 1024 // 1024} MB，"
                             f"再传这个会超出 {USER_QUOTA // 1024 // 1024} MB 的配额")

    with file_lock(fid):
        # 没有登记行却有碎片，说明是上一轮回收没删干净的残骸——新文件绝不能接着它写
        if not row:
            _part(fid).unlink(missing_ok=True)
        # 大小对不上说明换了一个文件却复用了编号，之前的碎片一律作废
        if row and row["size"] != size:
            _part(fid).unlink(missing_ok=True)
            final.unlink(missing_ok=True)
        received = _part(fid).stat().st_size if _part(fid).exists() else 0
        if received > size:
            _part(fid).unlink(missing_ok=True)
            received = 0
        with _write_lock:
            c.execute("INSERT INTO files (id, owner_id, name, mime, size, uploaded, created_at, updated_at)"
                      " VALUES (?,?,?,?,?,0,?,?)"
                      " ON CONFLICT(id) DO UPDATE SET name=excluded.name, mime=excluded.mime,"
                      " size=excluded.size, uploaded=0, updated_at=excluded.updated_at",
                      (fid, user["id"], name, mime, size, now, now))
            c.commit()
    return {"ok": True, "received": received, "done": False}


def file_owned(user, fid):
    row = conn().execute("SELECT * FROM files WHERE id = ?", (fid,)).fetchone()
    if not row:
        raise HttpError(409, "请先登记文件信息")
    if row["owner_id"] != user["id"]:
        raise HttpError(403, "不能上传别人的文件")
    return row


def file_finish(fid, size):
    _part(fid).replace(FILE_DIR / fid)
    c = conn()
    with _write_lock:
        c.execute("UPDATE files SET uploaded = 1, size = ?, updated_at = ? WHERE id = ?",
                  (size, int(time.time() * 1000), fid))
        c.commit()
    with _file_locks_guard:
        _file_locks.pop(fid, None)


def readable_file(user, fid):
    """自己的能看；导师和管理员能看全组的——跟记录本身的可见范围一致。"""
    row = conn().execute("SELECT * FROM files WHERE id = ?", (fid,)).fetchone()
    if not row or not row["uploaded"]:
        return None
    return row if visible_blob(user, row) else None


def file_drop(user, fid):
    """删掉自己的一个数据文件。用户在保存记录前撤掉附件时调用。"""
    c = conn()
    row = c.execute("SELECT * FROM files WHERE id = ?", (fid,)).fetchone()
    if not row:
        return {"ok": True, "removed": 0}
    if row["owner_id"] != user["id"]:
        raise HttpError(403, "不能删除别人的文件")
    with _write_lock:
        c.execute("DELETE FROM files WHERE id = ?", (fid,))
        c.commit()
    for f in (FILE_DIR / fid, _part(fid)):
        try:
            f.unlink(missing_ok=True)
        except Exception:
            pass
    with _file_locks_guard:
        _file_locks.pop(fid, None)
    return {"ok": True, "removed": 1}


_tickets = {}                    # token -> (file_id, expires_at)
_tickets_guard = threading.Lock()


def file_ticket(user, fid):
    if not readable_file(user, fid):
        raise HttpError(404, "文件不存在或无权访问")
    tok = secrets.token_urlsafe(16)
    now = int(time.time() * 1000)
    with _tickets_guard:
        for k, (_, exp) in list(_tickets.items()):
            if exp < now:
                del _tickets[k]
        _tickets[tok] = (fid, now + TICKET_TTL)
    return {"url": f"/api/file/{fid}?ticket={tok}", "expiresAt": now + TICKET_TTL}


def ticket_ok(fid, tok):
    if not tok:
        return False
    with _tickets_guard:
        got = _tickets.get(tok)
    return bool(got and got[0] == fid and got[1] >= int(time.time() * 1000))


def referenced_file_ids(c):
    ids = set()
    for r in c.execute("SELECT data FROM records WHERE deleted_at IS NULL"):
        try:
            d = json.loads(r["data"])
        except Exception:
            continue
        for f in (d.get("files") or []) if isinstance(d, dict) else []:
            if isinstance(f, dict) and isinstance(f.get("id"), str):
                ids.add(f["id"])
    return ids


def gc_orphan_files(grace=ORPHAN_GRACE):
    """回收没有任何记录引用的数据文件：传了一半放弃的、以及记录被删后剩下的。

    宽限期是为了保护「刚传完、记录还没同步上来」的那几分钟。
    """
    c = conn()
    keep = referenced_file_ids(c)
    cutoff = int(time.time() * 1000) - grace
    rows = c.execute("SELECT id, size FROM files WHERE created_at < ?", (cutoff,)).fetchall()
    gone = [r for r in rows if r["id"] not in keep]
    if not gone:
        return {"removed": 0, "freedBytes": 0}
    freed = 0
    with _write_lock:
        for r in gone:
            c.execute("DELETE FROM files WHERE id = ?", (r["id"],))
        c.commit()
    for r in gone:
        for f in (FILE_DIR / r["id"], _part(r["id"])):
            try:
                if f.exists():
                    freed += f.stat().st_size
                f.unlink(missing_ok=True)
            except Exception:
                pass
    print(f"[gc] 清理孤儿数据文件 {len(gone)} 个，释放 {freed / 1048576:.1f} MB", flush=True)
    return {"removed": len(gone), "freedBytes": freed}


def gc_loop():
    while True:
        time.sleep(6 * 3600)
        try:
            gc_orphan_files()
        except Exception as e:
            print(f"[gc] 清理出错: {e}", flush=True)


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


def admin_set_feature(user, target_id, feature, on):
    """按人开放 / 收回一个功能（目前只有待办）。

    跟改角色不同，这里**允许改自己**：角色改错了会把自己锁在门外，只能 SSH
    上服务器救；而功能开关随时能再点回来。管理员要给自己开待办，总不能去
    求另一个管理员。

    收回不删任何数据——待办本来就存在本人设备上，服务器这边只是不再让
    界面显示。再开放回来，他那些任务一条不少。
    """
    if not is_admin(user):
        raise HttpError(403, "只有管理员能开放功能")
    if feature not in FEATURES:
        raise HttpError(400, "没有这个功能")
    c = conn()
    row = _target(c, target_id)
    feats = user_features(row)
    if on:
        feats[feature] = True
    else:
        feats.pop(feature, None)

    now = int(time.time() * 1000)
    with _write_lock:
        c.execute("UPDATE users SET features = ?, updated_at = ? WHERE id = ?",
                  (json.dumps(feats), now, row["id"]))
        c.commit()
    audit(user["username"], "开放待办" if on else "收回待办", row["username"],
          None if on else "数据保留在本人设备上")
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
    file_ids = [r["id"] for r in
                c.execute("SELECT id FROM files WHERE owner_id = ?", (row["id"],)).fetchall()]
    with _write_lock:
        c.execute("DELETE FROM users WHERE id = ?", (row["id"],))   # 外键级联删掉其余
        c.commit()
    for pid in photo_ids:                                            # 磁盘上的文件不受外键管
        try:
            (PHOTO_DIR / pid).unlink(missing_ok=True)
        except Exception:
            pass
    for fid in file_ids:
        for f in (FILE_DIR / fid, _part(fid)):
            try:
                f.unlink(missing_ok=True)
            except Exception:
                pass
    audit(user["username"], "彻底删除账号", row["username"],
          " ".join(f"{k}={v}" for k, v in counts.items())
          + f" 照片文件={len(photo_ids)} 数据文件={len(file_ids)}")
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

    def dir_bytes(d):
        total = 0
        try:
            for f in d.iterdir():
                if f.is_file():
                    total += f.stat().st_size
        except Exception:
            pass
        return total

    photo_bytes = dir_bytes(PHOTO_DIR)
    file_bytes = dir_bytes(FILE_DIR)
    counts["files"] = c.execute("SELECT COUNT(*) FROM files WHERE uploaded = 1").fetchone()[0]

    backups = []
    try:
        bdir = Path.home() / "mochi" / "backups"
        for f in sorted(bdir.glob("mochi-*.db"), key=lambda x: x.stat().st_mtime, reverse=True)[:3]:
            backups.append({"name": f.name, "at": int(f.stat().st_mtime * 1000), "size": f.stat().st_size})
    except Exception:
        pass

    return {
        "counts": counts, "disk": disk, "photoBytes": photo_bytes, "fileBytes": file_bytes,
        "maxFileBytes": MAX_FILE, "userQuotaBytes": USER_QUOTA,
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


BJ = timezone(timedelta(hours=8))

# 奖励规则集中放这儿，改这一处、界面和接口一起变
WEEK_REWARDS = {1: "1 天事假额度 · 免一周值日", 2: "免一周值日", 3: "免一周值日"}
MONTH_REWARDS = {1: "2 天事假", 2: "1 天事假", 3: "0.5 天事假"}
YEAR_POOL_NOTE = "年终激励按积分占比分配"


def period_range(period, offset=0):
    """返回 (起, 止, 标题)，都按北京时间算。"""
    today = datetime.now(BJ).date()
    if period == "month":
        m = today.month - 1 + offset
        y, m = today.year + m // 12, m % 12 + 1
        start = date(y, m, 1)
        end = date(y + (m // 12), m % 12 + 1, 1) - timedelta(days=1)
        return start.isoformat(), end.isoformat(), f"{y} 年 {m} 月"
    if period == "year":
        y = today.year + offset
        return date(y, 1, 1).isoformat(), date(y, 12, 31).isoformat(), f"{y} 年"
    start = today - timedelta(days=today.weekday()) + timedelta(weeks=offset)
    end = start + timedelta(days=6)
    return start.isoformat(), end.isoformat(), f"{start.month}/{start.day} — {end.month}/{end.day}"


def leaderboard(user, period="week", offset=0):
    """积分榜。一条记录 1 分（每天封顶 3 条），导师的每个赞 / 每条点评各 5 分。

    只算导师给的赞和点评：学生之间互相点，分数就没有意义了。
    """
    if period not in ("week", "month", "year"):
        period = "week"
    offset = max(-60, min(0, int(offset or 0)))     # 只往回看，不预支未来
    c = conn()
    lo, hi, label = period_range(period, offset)

    people = {r["id"]: r for r in c.execute("SELECT * FROM users WHERE archived_at IS NULL")}
    advisors = {uid for uid, r in people.items() if r["role"] in GROUP_READERS}
    stat = {uid: {"records": 0, "likes": 0, "replies": 0}
            for uid, r in people.items() if uid not in advisors}

    for r in c.execute(
            "SELECT owner_id, day, COUNT(*) AS n FROM records"
            " WHERE deleted_at IS NULL AND day >= ? AND day <= ? GROUP BY owner_id, day",
            (lo, hi)):
        if r["owner_id"] in stat:
            # 再封一次顶：日限额是后加的，之前攒下的老数据可能一天不止 3 条
            stat[r["owner_id"]]["records"] += min(r["n"], MAX_RECORDS_PER_DAY)

    for r in c.execute("SELECT owner_id, target_owner, data, updated_at FROM comments"
                       " WHERE deleted_at IS NULL"):
        tgt = r["target_owner"]
        if tgt not in stat or r["owner_id"] not in advisors or r["owner_id"] == tgt:
            continue
        try:
            d = json.loads(r["data"]) or {}
        except Exception:
            d = {}
        day = bj_day(d.get("at") or r["updated_at"])
        if not day or day < lo or day > hi:
            continue
        stat[tgt]["likes" if d.get("kind") == "like" else "replies"] += 1

    rows = []
    for uid, e in stat.items():
        u = people[uid]
        rows.append({
            "userId": uid, "username": u["username"], "displayName": u["display_name"],
            "avatar": u["avatar"], **e,
            "points": e["records"] * PT_RECORD + e["likes"] * PT_LIKE,
        })
    rows.sort(key=lambda x: (-x["points"], x["displayName"]))

    total = sum(x["points"] for x in rows) or 1
    rank = 0
    for i, x in enumerate(rows):
        # 同分同名次
        if i == 0 or x["points"] != rows[i - 1]["points"]:
            rank = i + 1
        x["rank"] = rank
        if not x["points"]:
            x["reward"] = ""
        elif period == "week":
            x["reward"] = WEEK_REWARDS.get(rank, "")
        elif period == "month":
            x["reward"] = MONTH_REWARDS.get(rank, "")
        else:
            x["reward"] = f"年终激励 {round(x['points'] * 100 / total)}%"

    return {"period": period, "offset": offset, "label": label, "from": lo, "to": hi,
            "rows": rows, "totalPoints": sum(x["points"] for x in rows),
            "rules": {"record": PT_RECORD, "like": PT_LIKE, "reply": 0,
                      "dailyCap": MAX_RECORDS_PER_DAY,
                      "week": WEEK_REWARDS, "month": MONTH_REWARDS, "year": YEAR_POOL_NOTE}}


def member_list(user):
    """全组的名字和头像。学生现在看得到彼此的记录，就得知道那一条是谁写的。

    只给展示身份必需的字段——角色、是否离组、上次活跃这些仍然只有导师看得到
    （那些是管理信息，跟「这条记录是谁写的」是两回事）。
    """
    rows = conn().execute(
        "SELECT id, username, display_name, avatar FROM users ORDER BY created_at").fetchall()
    return {"members": [{"id": r["id"], "username": r["username"],
                         "displayName": r["display_name"], "avatar": r["avatar"]} for r in rows]}


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


def send_to_user(user_id, payload):
    """推给某个人的所有设备，返回成功发出的条数。

    失效的订阅顺手清掉——留着只会每次都失败，还会把 fail_count 顶到天上。
    """
    if not (PUSH_OK and VAPID):
        return 0
    now = int(time.time() * 1000)
    c = conn()
    sent = 0
    for sub in c.execute("SELECT * FROM push_subs WHERE user_id = ?", (user_id,)).fetchall():
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
            # 设备卸载了 app 或清了数据，订阅永久失效
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
    return sent


def comment_notice(actor, kind, text, rec_text, record_id):
    """导师点赞/点评之后，学生手机上看到的那条通知。"""
    who = (actor or {}).get("displayName") or "组里有人"
    trim = lambda t, n: " ".join(str(t or "").split())[:n]
    if kind == "like":
        return {"title": f"👍 {who} 赞了你的记录",
                "body": trim(rec_text, 40) or "（无正文）", "tag": f"mochi-cm-{record_id}"}
    return {"title": f"💬 {who} 点评了你的记录",
            "body": trim(text, 80) or "（空）", "tag": f"mochi-cm-{record_id}"}


def deliver(notices):
    for uid, payload in notices:
        try:
            send_to_user(uid, payload)
        except Exception as e:
            print(f"[push] 评论通知发送出错: {e}", flush=True)


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
        sent += send_to_user(rem["owner_id"],
                             {"title": rem["title"], "body": rem["body"],
                              "tag": f"mochi-{rem['id']}", "todoId": rem["id"]})
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
    return row if visible_blob(user, row) else None


def visible_blob(user, row):
    """照片 / 数据文件跟着它所在的项目走。

    学生现在看得到别人的记录，配套的照片自然也得给——不给的话记录里就是
    一排空灰块，而同步引擎还会一遍遍去拉、一遍遍 403。
    project_id 为空的是还没被任何记录引用的（刚传上来），只有本人能取。
    """
    if row["owner_id"] == user["id"] or can_read_group(user):
        return True
    pid = row["project_id"] if "project_id" in row.keys() else None
    return bool(pid) and pid not in hidden_projects(user)


# ─────────────────────────── HTTP ───────────────────────────

PHOTO_RE = re.compile(r"^/api/photo/([A-Za-z0-9_-]{1,64})$")
FILE_RE = re.compile(r"^/api/file/([A-Za-z0-9_-]{1,64})$")
FILE_ACT_RE = re.compile(r"^/api/file/([A-Za-z0-9_-]{1,64})/(init|ticket|drop)$")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "mochi-sync"

    def log_message(self, fmt, *args):
        # 下载票是短期凭证，但没有任何理由把它写进日志文件
        line = re.sub(r"ticket=[A-Za-z0-9_-]+", "ticket=…", fmt % args)
        print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {self.address_string()} {line}", flush=True)

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

    def _stream_to(self, path, cap):
        """把请求体边读边写到磁盘。

        几百 MB 的数据文件不能像 _body() 那样整个读进内存——这台服务器上
        同时来两个人就把内存吃光了。
        """
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0:
            raise HttpError(400, "空的分块")
        if n > MAX_CHUNK:
            raise HttpError(413, f"单个分块不能超过 {MAX_CHUNK // 1024 // 1024} MB")
        if n > cap:
            raise HttpError(400, "写入超出了登记的文件大小")
        self._body_read = True
        left = n
        with open(path, "ab") as f:
            while left > 0:
                buf = self.rfile.read(min(left, IO_CHUNK))
                if not buf:
                    raise HttpError(400, "连接中断，这一块没收全")
                f.write(buf)
                left -= len(buf)
        return n

    def _send_file(self, path, ctype, filename, extra=None):
        """流式下发，支持 Range——大文件断了能接着下，不用从头再来。"""
        size = path.stat().st_size
        start, end, status = 0, size - 1, 200
        m = re.match(r"bytes=(\d*)-(\d*)\s*$", self.headers.get("Range") or "")
        if m and (m.group(1) or m.group(2)):
            if m.group(1):
                start = int(m.group(1))
                end = int(m.group(2)) if m.group(2) else size - 1
            else:
                start = max(0, size - int(m.group(2)))
            end = min(end, size - 1)
            if start >= size or end < start:
                return self._send(416, b"", "text/plain", {"Content-Range": f"bytes */{size}"})
            status = 206

        quoted = urlquote(filename.encode("utf-8"), safe="")
        head = {"Accept-Ranges": "bytes",
                "Content-Disposition": f"attachment; filename=\"{quoted}\"; filename*=UTF-8''{quoted}",
                **(extra or {})}
        if status == 206:
            head["Content-Range"] = f"bytes {start}-{end}/{size}"

        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(end - start + 1))
        for k, v in {**self._cors(), **head}.items():
            self.send_header(k, v)
        self.end_headers()
        if self.command == "HEAD":
            return
        left = end - start + 1
        with open(path, "rb") as f:
            f.seek(start)
            while left > 0:
                buf = f.read(min(left, IO_CHUNK))
                if not buf:
                    break
                self.wfile.write(buf)
                left -= len(buf)

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
            if method == "POST" and path == "/api/admin/feature":
                b = self._json_body()
                return self._json(admin_set_feature(self._need_user(), b.get("userId"),
                                                    b.get("feature"), bool(b.get("on"))))
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
            if method == "POST" and path == "/api/admin/gc":
                u = self._need_user()
                if not is_admin(u):
                    raise HttpError(403, "只有管理员能清理")
                return self._json(gc_orphan_files())
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

            if method == "GET" and path == "/api/project-log":
                return self._json(project_log(self._need_user(), query.get("id", [""])[0]))

            if method == "GET" and path == "/api/members":
                return self._json(member_list(self._need_user()))

            if method == "GET" and path == "/api/leaderboard":
                # 榜单全组可见——看不见别人的名次，排行榜就没有意义
                return self._json(leaderboard(
                    self._need_user(), query.get("period", ["week"])[0],
                    int(query.get("offset", ["0"])[0] or 0)))

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

            m = FILE_ACT_RE.match(path)
            if m and method == "POST":
                fid, act = m.group(1), m.group(2)
                user = self._need_user()
                if act == "init":
                    return self._json(file_init(user, fid, self._json_body()))
                if act == "ticket":
                    return self._json(file_ticket(user, fid))
                return self._json(file_drop(user, fid))

            m = FILE_RE.match(path)
            if m:
                fid = m.group(1)
                if method == "POST":
                    row = file_owned(self._need_user(), fid)
                    try:
                        offset = int(query.get("offset", ["-1"])[0])
                    except ValueError:
                        offset = -1
                    with file_lock(fid):
                        part = _part(fid)
                        have = part.stat().st_size if part.exists() else 0
                        # 偏移对不上就把实际进度回给前端，让它从那里接着传，
                        # 而不是让两边各写各的把文件写花
                        if offset != have:
                            raise HttpError(409, f"分块偏移不对，服务器已收到 {have} 字节")
                        got = self._stream_to(part, row["size"] - have)
                        have += got
                        done = have >= row["size"]
                    if done:
                        file_finish(fid, have)
                    return self._json({"received": have, "done": done})

                # 下载：带票的走浏览器直连（没有 Authorization 头），否则要登录
                tok = query.get("ticket", [""])[0]
                if ticket_ok(fid, tok):
                    row = conn().execute("SELECT * FROM files WHERE id = ?", (fid,)).fetchone()
                else:
                    row = readable_file(self._need_user(), fid)
                if not row or not row["uploaded"]:
                    raise HttpError(404, "文件不存在或无权访问")
                f = FILE_DIR / fid
                if not f.exists():
                    raise HttpError(404, "文件尚未上传完")
                return self._send_file(f, row["mime"], row["name"] or fid,
                                       {"Cache-Control": "private, max-age=3600"})

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

GUIDE_PAGE = """<!doctype html><html lang=zh-CN><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>Mochi 使用手册</title>
<style>
:root{--ink:#2C2C2C;--sub:#8C8478;--dim:#B0A99B;--line:#EDE8DE;--bg:#FDFBF7;--panel:#FFFDF9}
*{box-sizing:border-box}
body{font:16px/1.75 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;
max-width:720px;margin:0 auto;padding:24px 20px 80px;color:var(--ink);background:var(--bg)}
h1{font-size:26px;margin:0 0 6px;letter-spacing:-.5px}
h2{font-size:20px;margin:44px 0 10px;padding-top:18px;border-top:1px solid var(--line)}
h3{font-size:16px;margin:22px 0 6px}
p,li{font-size:15px}
.sub{color:var(--dim);font-size:14px;margin-bottom:8px}
a{color:#5B7FC7}
ol,ul{padding-left:22px}li{margin:6px 0}
code{background:#F0EDE6;padding:2px 6px;border-radius:4px;font-size:13.5px;
font-family:"SF Mono",Menlo,monospace;word-break:break-all}
table{width:100%;border-collapse:collapse;margin:12px 0;font-size:14px}
th,td{text-align:left;padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--sub);font-size:12.5px;font-weight:700;background:var(--panel)}
.note{background:var(--panel);border:1px solid var(--line);border-radius:12px;
padding:12px 14px;margin:14px 0;font-size:14px}
.warn{background:#FFF6E5;border:1px solid #E8A838;border-radius:12px;
padding:12px 14px;margin:14px 0;font-size:14px}
.key{background:#EEF7EC;border:1px solid #5A9E4B;border-radius:12px;
padding:12px 14px;margin:14px 0;font-size:14px}
.toc{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:14px 18px;margin:20px 0}
.toc ol{margin:0;padding-left:20px}.toc li{margin:3px 0;font-size:14.5px}
.role{display:inline-block;font-size:11.5px;font-weight:700;padding:2px 8px;border-radius:5px;
vertical-align:middle;margin-left:6px}
.stu{background:#EEF2FB;color:#4A6FB5}.adv{background:#FFF6E5;color:#A9791A}
.back{display:inline-block;margin-bottom:18px;font-size:14px;color:var(--sub);text-decoration:none}
hr{border:none;border-top:1px solid var(--line);margin:28px 0}
</style>

<a class=back href="/">&lsaquo; 回到证书安装页</a>
<h1>Mochi 使用手册</h1>
<div class=sub>课题组的实验记录本 · 待办与专注 · 积分榜</div>

<div class=toc><ol>
<li><a href="#start">第一次使用</a></li>
<li><a href="#todo">待办与专注计时</a>（要管理员开放）</li>
<li><a href="#lab">实验记录本</a></li>
<li><a href="#see">谁能看到什么</a>（重要）</li>
<li><a href="#cal">日历与重点节点</a></li>
<li><a href="#score">积分榜与奖励</a></li>
<li><a href="#adv">导师端</a></li>
<li><a href="#push">推送通知</a></li>
<li><a href="#faq">遇到问题</a></li>
</ol></div>

<h2 id=start>1. 第一次使用</h2>

<h3>装根证书</h3>
<p>同步服务跑在实验室内网，走的是自签证书的 HTTPS。<b>每台设备装一次</b>，装完才能同步。
步骤见 <a href="/">证书安装页</a>——iPhone 上最容易漏掉「证书信任设置」那一步，注意看。</p>

<h3>打开 app 并装到主屏幕</h3>
<p>浏览器打开 <code>https://semon-guo.github.io/mochi-app/</code>。</p>
<ul>
<li><b>iPhone：</b>用 Safari 打开 → 分享按钮 → 「添加到主屏幕」。
<b>不加到主屏幕就收不到推送通知</b>，这是 iOS 的硬性限制，不是 app 的问题。</li>
<li><b>安卓 / 电脑：</b>地址栏会有安装图标，装不装都能用。</li>
</ul>

<h3>注册</h3>
<p>进 app → 「记录」页 → 点最上面那条同步条展开 → 注册。需要<b>邀请码</b>，问组里要。</p>
<div class=warn><b>注册后一律是学生身份。</b>导师权限只能由管理员在服务器上授予——
邀请码万一外泄，拿到的人也拿不到全组记录。</div>

<h3>登录之后</h3>
<p>同步是自动的：打开 app 同步一次，之后每 2 分钟一次，切回前台也补一次。
同步条上会显示「已同步 · 几分钟前」或「N 条待同步」。</p>
<div class=note>换账号登录会<b>清空本机数据</b>（上一个人的记录不会留在你屏幕上，
也不会被当成你的推上去）。这是有意的。</div>

<h2 id=todo>2. 待办与专注计时<span class="role adv">要管理员开放</span></h2>

<div class=key><b>这一半默认不出现。</b>没开放的人，界面上只有「记录」和「日历」两个页签，
这不是出了问题。要用的话跟管理员说一声，他在导师端「管理 → 成员」里点一下「开放待办」，
你下一轮同步（最多 2 分钟，或退出重登）就能看到「待办」页了。
<br><br>组里多数人只需要实验记录本，待办和专注计时是给需要的人用的，摆在所有人最显眼的第一个
页签上只是干扰。<b>收回也不会删任何东西</b>——任务和计时本来就存在你自己的设备上，
再开放回来一条不少。</div>

<h3>建任务</h3>
<p>「待办」页右下角 <b>+</b>。三档重要度：<b>主线 / 支线 / 休闲</b>，列表按这个排序。
可以给任务加子任务。</p>

<h3>专注计时</h3>
<p>点任务上的 ▶ 开始计时。<b>可以同时计好几个</b>（跑程序的同时读文献）。
计时会记下完整的 timeline：几点开始、暂停过几次、总共多久。</p>
<div class=note>app 退到后台时计时不会中断——重新打开会把这段时间补回来。
但如果离开太久，会问你一句「这段时间真的在做吗」，避免忘记停表把数据搞脏。</div>

<h3>提醒</h3>
<p>任务上可以设提醒时间。开了推送的话，app 关着也会响（见第 8 节）。</p>

<h3>完成记录</h3>
<p>顶部那个 ✓ 按钮进「完成记录」，可以切「周视图」——把每天的专注时段画在时间网格上，
一眼看出哪几天在干活。</p>

<div class=key><b>待办、计时、timeline 只有你自己看得到。</b>
导师和同学都看不到，这是服务端强制的，不是靠界面藏起来。
同步待办只是为了你自己多设备互通，可以在同步面板里关掉。</div>

<h2 id=lab>3. 实验记录本</h2>

<h3>两层结构</h3>
<p><b>项目 → 记录</b>。项目是一个课题（几个月到一年），记录是一次上手的流水账。</p>

<h3>记一条</h3>
<p>进项目 → 最上面那张卡片：选天气 → 写正文 → <b>📷 照片</b> / <b>📎 数据</b> → 「记下」。</p>

<div class=warn><b>一天最多记 3 条。</b>右上角有 <code>2/3</code> 的计数，记满了「记下」会变灰。
这是为了防止把一条拆成十条刷积分。一天要记的事多，就写在同一条里。</div>

<h3>照片和数据文件是两回事</h3>
<table>
<tr><th></th><th>📷 照片</th><th>📎 数据文件</th></tr>
<tr><td>用途</td><td>光路、示数、现象</td><td>原始测量结果：csv / mat / npy / tif / zip</td></tr>
<tr><td>处理</td><td>自动压到长边 1600</td><td>原样不动</td></tr>
<tr><td>存在哪</td><td>你每台设备各一份</td><td>只在服务器上一份</td></tr>
<tr><td>大小</td><td>几百 KB</td><td>单个最大 512 MB</td></tr>
<tr><td>要联网吗</td><td>不用，回头自动传</td><td><b>要</b>，选中就开始传</td></tr>
</table>
<p>数据文件传的时候有进度条，断了能<b>断点续传</b>，不用从头再来。
别人（有权限看这条记录的人）点文件名就能下载。</p>
<div class=note>数据文件必须在线传，是有意的取舍：几百 MB 的东西攒在本地「回头再传」，
最后只会变成「以为传上去了其实没有」。</div>

<h3>改和删</h3>
<p>点记录右上角的铅笔可以改正文、天气，也可以<b>补挂数据文件</b>——
分析常常是隔天才跑完的。别人的记录你改不了。</p>

<h2 id=see>4. 谁能看到什么</h2>
<p>这一节值得看完，它决定了你写的东西谁看得见。</p>

<table>
<tr><th>东西</th><th>谁看得到</th></tr>
<tr><td>待办 / 专注计时 / timeline</td><td><b>只有你自己</b>（服务端强制）。
另外这一整个功能要管理员按人开放，见<a href="#todo">第 2 节</a></td></tr>
<tr><td>你的个人课题和里面的记录</td><td><b>全组</b>——组里互相看得到彼此在做什么</td></tr>
<tr><td>导师建的项目</td><td><b>只有名单里的人</b> + 导师</td></tr>
<tr><td>被导师加了成员名单的项目</td><td>同上，只给名单内</td></tr>
<tr><td>记录里的照片和数据文件</td><td>跟着它所属的项目走</td></tr>
<tr><td>导师给你的点赞和点评</td><td>你 + 导师们</td></tr>
<tr><td>日历上的重点节点</td><td>全组</td></tr>
<tr><td>积分榜</td><td>全组</td></tr>
</table>

<div class=note>「记录」页分成两段：上面是<b>你自己的课题</b>（以及你被拉进名单的组级项目），
下面「组里的课题」是同学的——可以看、可以点赞，但不能往人家本子里记。</div>

<div class=key><b>点赞是公开的鼓励。</b>任何人都可以给看得到的记录点赞。
只有<b>导师</b>点的赞才计积分（见第 6 节）。</div>

<h2 id=cal>5. 日历与重点节点</h2>
<p>「日历」页把两半信息合到一张图上——一天里到底发生了什么，一眼看全。</p>

<h3>月视图怎么读</h3>
<ul>
<li><b>格子背景越绿</b> = 那天专注的时间越长</li>
<li><b>下面的圆点</b> = 那天记了几条实验记录，颜色按项目分</li>
<li><b>顶边的色条</b> = 那天有重点节点</li>
<li><b>右上角小黄点</b> = 那天有待办到期</li>
</ul>
<p>点任意一天，下面会列出那天的全部内容：节点、每条记录（点进去跳到项目）、
专注时长、完成项数、到期的待办。</p>

<h3>周视图</h3>
<p>切到「周」是一周七天的日程列表，适合看「这一周有什么」。</p>

<h3>重点节点</h3>
<p>投稿截止、组会、开题、答辩这些。<b>只有导师能设置，但全组都看得到。</b></p>
<p>页面最上面是倒计时卡片，「还有 N 天」；≤3 天转红，当天显示「就是今天」。</p>

<h2 id=score>6. 积分榜与奖励</h2>
<p>入口在「记录」页的 🏆 积分榜。</p>

<h3>怎么算分</h3>
<table>
<tr><th>行为</th><th>分数</th><th>说明</th></tr>
<tr><td>写一条实验记录</td><td><b>1 分</b></td><td>每天最多 3 条</td></tr>
<tr><td>被<b>导师</b>点赞</td><td><b>5 分</b></td><td>每个赞都算</td></tr>
<tr><td>导师的点评</td><td>0 分</td><td>不计分</td></tr>
<tr><td>同学之间的点赞</td><td>0 分</td><td>不计分</td></tr>
</table>
<div class=note>点评不计分是刻意的：那是给你的反馈，不该变成筹码——
总不该让导师在「要不要多写一句」时先想想给不给分。同学互赞不计分，
否则互刷就是几分钟的事。</div>

<h3>奖励</h3>
<table>
<tr><th>榜单</th><th>奖励</th></tr>
<tr><td>周榜第 1</td><td>1 天事假额度 + 免一周值日</td></tr>
<tr><td>周榜前 3</td><td>免一周值日</td></tr>
<tr><td>月榜第 1 / 2 / 3</td><td>2 天 / 1 天 / 0.5 天事假</td></tr>
<tr><td>年榜</td><td>按积分占比分配年终激励</td></tr>
</table>
<p>榜单上方的 <b>‹ ›</b> 可以翻到上一期——上周、上个月的最终名次和奖励都在那儿，
这就是结算。同分并列同名次。</p>

<h2 id=adv>7. 导师端<span class="role adv">导师 / 管理员</span></h2>
<p>登录后「记录」页顶部会多一个 <b>🔬 查看全组记录</b> 的入口，带未读角标。</p>

<h3>新记录</h3>
<p>默认页签，是一条时间流：谁写的、写了什么、缩略图、附件一次铺开。
可以就地 <b>☆ 赞</b> 和 <b>💬 点评</b>。</p>
<p>点「✓ 已读」那条会<b>就地变灰但留在原位</b>，下次再进这个页签才清掉——
刚点完手还在那儿、列表就跳一格是最容易点错的。点错了再点一下「已读 ↺」撤销。
点赞或点评会自动算已读。</p>

<h3>按成员 / 按项目</h3>
<p>「今日活跃 ›」和「本周活跃 ›」可以点开，是一张两段名单：有记录的、没有记录的
（写明「已 N 天没记」，超 7 天转琥珀、超 14 天转红）。</p>

<h3>建项目、管成员</h3>
<p>「按项目」→「＋ 新建组级项目」。进项目详情，在「项目成员」里点胶囊加人减人。</p>
<div class=note><b>任何导师都能调任何项目的成员</b>，包括学生自建的课题。
但只能改成员——项目名、颜色仍归建它的人，也删不掉别人的项目。
每次调整都会写进项目详情下面的<b>管理记录</b>：谁、什么时候、加了谁移了谁。</div>

<h3>重点节点</h3>
<p>在「日历」页里加，见第 5 节。只有导师能加，全组可见。</p>

<h2 id=push>8. 推送通知</h2>
<p>同步面板里打开「到点推送通知」。会推两类：</p>
<ul>
<li>你设的待办提醒到点了</li>
<li><b>导师给你的记录点赞或写了点评</b></li>
</ul>
<div class=warn><b>iPhone 必须先「添加到主屏幕」</b>，从 Safari 标签页里打开的话，
系统连推送 API 都不提供。这是 iOS 的限制。</div>
<p>开了推送后，待办的标题会上传到服务器（不然服务器不知道该推什么内容）。
不想上传就别开，app 开着的时候仍然会在界面上提醒。</p>

<h2 id=faq>9. 遇到问题</h2>

<h3>连不上服务器</h3>
<ol>
<li>是不是在实验室网络里？服务只在内网可达。</li>
<li>根证书装了吗？iPhone 上「证书信任设置」的开关打开了吗？</li>
<li>同步面板里展开「服务器地址」，确认是 <code>https://172.29.249.177:3000</code>。</li>
</ol>

<h3>照片显示成一个空灰块</h3>
<p>说明那张还没同步到这台设备上。等一轮同步（2 分钟）；如果一直不出现，
可能是上传方还没传上来。</p>

<h3>刚写的记录不见了</h3>
<p>大概率是被服务端拒绝后回滚了——同步条上会显示原因。最常见的是<b>今天已经记满 3 条</b>。
其它可能：想改别人的东西、想改导师设的重点节点。</p>

<h3>「今天记满了」</h3>
<p>一天上限 3 条。把内容补进今天已有的记录里（点铅笔编辑），或者明天再记。</p>

<h3>换了账号，记录没了</h3>
<p>换账号会清空本机数据，这是防止数据串号。重新登录原账号，同步一轮就会全部拉回来
（记录在服务器上，没丢）。</p>

<h3>导师入口不见了</h3>
<p>角色是在服务器上改的。被提为导师之后，等一轮同步（或退出重登）就会出现。</p>

<h3>我这儿没有「待办」页</h3>
<p>那一半要管理员按人开放（见<a href="#todo">第 2 节</a>），默认是不出现的。开放之后同样
等一轮同步或退出重登。反过来，本来有、突然没了，是被收回了——<b>你的任务和计时一条没丢</b>，
它们本来就存在你自己设备上，再开放回来都还在。</p>

<hr>
<p style="color:var(--dim);font-size:13px">
数据存在实验室内网的服务器上，每天自动备份。
待办和计时数据只存在你自己的设备上。
</p>
</html>"""


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
<a class=btn style="background:#FFF;color:#2C2C2C;border:2px solid #E8E4DA" href="/guide">📖 Mochi 使用手册</a>

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
<p style="text-align:center;margin-top:22px"><a href="/guide">怎么用？看使用手册 &rsaquo;</a></p>
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
            if path in ("/guide", "/guide/"):
                return self._out(GUIDE_PAGE.encode(), "text/html; charset=utf-8")
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

    threading.Thread(target=gc_loop, daemon=True).start()

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
