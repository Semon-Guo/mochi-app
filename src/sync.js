/* Mochi 实验记录同步。
 *
 * 只同步实验记录（projects / records / 照片）——待办、专注计时、timeline 全部
 * 留在本机，服务器上连表都没有。
 *
 * 设计要点：业务代码里那 23 处 setData 一个都不用改。所有同步元数据由
 * stampChanges() 在状态更新那一层自动 diff 出来，塞进 data._sync，
 * 渲染代码看不见它，也就不会被它影响。
 */

import { getPhoto, putPhoto, localPhotoIds, clearPhotos } from "./photos.js";

const AUTH_SK = "mochi_auth";
const OWNER_SK = "mochi_data_owner";
const SERVER_SK = "mochi_server";
const DEFAULT_SERVER = "https://172.29.249.177:3000";

const TODOS_SK = "mochi_sync_todos";

// 实验记录始终同步（课题组共用）；待办是可选项，而且**只在自己的设备之间**
// 同步——服务端不会把它给导师或任何其他人看。
export const LAB_KINDS = ["projects", "records"];
export const ALL_KINDS = ["projects", "records", "todos"];

export function getSyncTodos() {
  try { return localStorage.getItem(TODOS_SK) !== "0"; } catch { return true; }
}
export function setSyncTodos(on) {
  try { localStorage.setItem(TODOS_SK, on ? "1" : "0"); } catch {}
}
/** 当前这台设备启用的同步类型 */
export const syncKinds = () => (getSyncTodos() ? ALL_KINDS : LAB_KINDS);

// 兼容旧调用点
export const SYNC_KINDS = ALL_KINDS;

/* ── 服务器地址与登录态 ── */

export function getServer() {
  try { return localStorage.getItem(SERVER_SK) || DEFAULT_SERVER; } catch { return DEFAULT_SERVER; }
}
export function setServer(url) {
  try { localStorage.setItem(SERVER_SK, String(url || "").replace(/\/+$/, "")); } catch {}
}
export function getAuth() {
  try { return JSON.parse(localStorage.getItem(AUTH_SK) || "null"); } catch { return null; }
}
export function setAuth(a) {
  try { a ? localStorage.setItem(AUTH_SK, JSON.stringify(a)) : localStorage.removeItem(AUTH_SK); } catch {}
}

/* ── 本地数据的归属 ──
 * 本机的 projects / records / todos / 照片 和同步游标都是设备级的，
 * 不跟着账号走。不记归属的话换个账号登录会有两个后果：
 *   1) 上一个人的记录还摊在屏幕上（数据泄露）；
 *   2) 那些记录带着未推送标记，会被推成新账号的东西（数据串号）；
 *   3) 游标停在上一个账号的进度上，新账号反而拉不到自己的数据。
 */
export function getDataOwner() {
  try { return localStorage.getItem(OWNER_SK); } catch { return null; }
}
export function setDataOwner(id) {
  try { id ? localStorage.setItem(OWNER_SK, id) : localStorage.removeItem(OWNER_SK); } catch {}
}

/** 手动重置：清空本机同步数据并把游标归零，下一轮同步会从服务器全量拉回。 */
export async function resetLocalData() {
  await clearPhotos().catch(() => {});
  return {
    todos: [], notes: [], projects: [], records: [],
    _sync: { stamps: {}, tombs: {}, pushed: {}, cursor: 0, lastSyncAt: 0, photos: {} },
  };
}

/**
 * 登录时调用。换了人就把本机数据清干净并重置游标；同一个人（或首次登录，
 * 此时本地数据本来就是他自己攒的）则原样保留。
 * 返回应当替换掉当前状态的 data。
 */
export async function switchAccount(data, prevOwnerId, nextOwnerId) {
  setDataOwner(nextOwnerId);
  if (prevOwnerId === nextOwnerId) return data;

  // prevOwnerId 为空有两种可能，得分开对待：
  //   a) 真的首次登录——本地数据是用户自己离线攒的，必须保留；
  //   b) 从不记归属的旧版本升级上来——本地数据可能是别人的。
  // 用游标区分：同步过（cursor>0）说明数据是从某个账号拉下来的，
  // 而我们无从判断是谁的，清掉最稳妥。
  if (!prevOwnerId && !(data?._sync?.cursor > 0)) return data;

  await clearPhotos().catch(() => {});
  return {
    todos: [], notes: [], projects: [], records: [],
    _sync: { stamps: {}, tombs: {}, pushed: {}, cursor: 0, lastSyncAt: 0, photos: {} },
  };
}

async function api(path, { method = "GET", body, token, raw, ctype } = {}) {
  const res = await fetch(getServer() + path, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(raw !== undefined ? { "Content-Type": ctype || "application/octet-stream" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: raw !== undefined ? raw : (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const isJson = (res.headers.get("content-type") || "").includes("json");
  const payload = isJson ? await res.json() : await res.arrayBuffer();
  if (!res.ok) throw new Error((isJson && payload?.error) || `HTTP ${res.status}`);
  return payload;
}

export const login = (username, password) =>
  api("/api/login", { method: "POST", body: { username, password } });
export const register = (info) =>
  api("/api/register", { method: "POST", body: info });
export const fetchMe = (token) => api("/api/me", { token });
export const fetchUsers = (token) => api("/api/users", { token });
export const fetchOverview = (token) => api("/api/overview", { token });
export const fetchRequests = (token) => api("/api/admin/requests", { token });
export const adminSetRole = (token, userId, role) =>
  api("/api/admin/role", { method: "POST", token, body: { userId, role } });
export const adminArchive = (token, userId, archived = true) =>
  api("/api/admin/archive", { method: "POST", token, body: { userId, archived } });
export const adminRemove = (token, userId) =>
  api("/api/admin/remove", { method: "POST", token, body: { userId } });
export const adminResetPassword = (token, userId) =>
  api("/api/admin/reset-password", { method: "POST", token, body: { userId } });
export const adminRevokeSessions = (token, userId) =>
  api("/api/admin/revoke-sessions", { method: "POST", token, body: { userId } });
export const adminGetInvite = (token) => api("/api/admin/invite", { token });
export const adminSetInvite = (token, code) =>
  api("/api/admin/invite", { method: "POST", token, body: { code } });
export const adminStatus = (token) => api("/api/admin/status", { token });
export const adminAudit = (token) => api("/api/admin/audit", { token });
export const changePassword = (token, oldPassword, newPassword) =>
  api("/api/password", { method: "POST", token, body: { oldPassword, newPassword } });
export const decideRequest = (token, userId, approve) =>
  api("/api/admin/decide", { method: "POST", token, body: { userId, approve } });

/** 能读全组记录的角色。admin 是 advisor 的超集。 */
export const canReadGroup = (user) => ["advisor", "admin"].includes(user?.role);
export const isAdmin = (user) => user?.role === "admin";
export const uploadAvatar = (token, avatar) =>
  api("/api/avatar", { method: "POST", token, body: { avatar } });
export const updateProfile = (token, displayName) =>
  api("/api/profile", { method: "POST", token, body: { displayName } });

/* ── 变更打戳 ──
 * 每次状态更新时比对前后，给变化的记录盖 updatedAt、给消失的记录留墓碑。
 * 没有墓碑的话，同步时分不清「这条被删了」和「这条还没同步过来」。
 */

const idMap = (arr) => {
  const m = new Map();
  for (const x of arr || []) if (x && x.id) m.set(x.id, x);
  return m;
};

// _sync 本身不参与比较，否则每次打戳都会引起下一轮变化
const fingerprint = (o) => JSON.stringify(o);

export function stampChanges(prev, next, now = Date.now(), kinds = null) {
  const KINDS = kinds || syncKinds();
  const prevSync = prev?._sync || {};
  const sync = {
    stamps: { ...(prevSync.stamps || {}) },
    tombs: { ...(prevSync.tombs || {}) },
    pushed: { ...(prevSync.pushed || {}) },
    cursor: prevSync.cursor || 0,
    lastSyncAt: prevSync.lastSyncAt || 0,
  };
  let touched = false;

  for (const kind of KINDS) {
    const before = idMap(prev?.[kind]);
    const after = idMap(next?.[kind]);

    for (const [id, item] of after) {
      const old = before.get(id);
      if (!old) {
        // 服务器同步下来的记录已经带戳，不要盖成本地时间
        if (!sync.stamps[id]) { sync.stamps[id] = { t: kind, at: now }; touched = true; }
        if (sync.tombs[id]) { delete sync.tombs[id]; touched = true; }
      } else if (fingerprint(old) !== fingerprint(item)) {
        sync.stamps[id] = { t: kind, at: now };
        touched = true;
      }
    }
    for (const [id] of before) {
      if (!after.has(id)) {
        sync.tombs[id] = { t: kind, at: now };
        delete sync.stamps[id];
        touched = true;
      }
    }
  }

  if (!touched && prev?._sync) return next;
  return { ...next, _sync: sync };
}

/** 标记某条记录已经和服务器一致（推送成功或刚拉下来），下次不再重复推 */
function markClean(sync, id, at) {
  sync.pushed[id] = at;
}

export function pendingCount(data) {
  const s = data?._sync;
  if (!s) return 0;
  let n = 0;
  for (const [id, st] of Object.entries(s.stamps || {})) if (s.pushed?.[id] !== st.at) n++;
  for (const [id, tb] of Object.entries(s.tombs || {})) if (s.pushed?.[id] !== tb.at) n++;
  return n;
}

/* ── 一轮完整同步：先推后拉 ── */

export async function syncOnce(data, token) {
  const sync = {
    stamps: { ...(data?._sync?.stamps || {}) },
    tombs: { ...(data?._sync?.tombs || {}) },
    pushed: { ...(data?._sync?.pushed || {}) },
    cursor: data?._sync?.cursor || 0,
    lastSyncAt: data?._sync?.lastSyncAt || 0,
  };

  const KINDS = syncKinds();

  // 自愈：本地一条同步记录都没有、游标却不为 0，说明状态错乱了
  // （比如清空本机数据时游标被错误地写了回来）。这种状态下增量拉取
  // 永远返回空，只能从头再来一次。真删光了记录也不怕——重来一次拉到的
  // 是墓碑，结果一样，只是多传一趟。
  const localCount = ALL_KINDS.reduce((n, k) => n + (data?.[k] || []).length, 0);
  if (localCount === 0 && sync.cursor > 0) {
    sync.cursor = 0;
    sync.stamps = {}; sync.tombs = {}; sync.pushed = {};
  }

  // 1) 推本地改动
  const byKind = {};
  for (const k of KINDS) byKind[k] = [];
  const items = {};
  for (const kind of KINDS) for (const x of data?.[kind] || []) items[x.id] = x;

  for (const [id, st] of Object.entries(sync.stamps)) {
    if (sync.pushed[id] === st.at) continue;       // 已经推过且没再改
    const item = items[id];
    if (!item || !byKind[st.t]) continue;
    const { id: _drop, ...payload } = item;
    byKind[st.t].push({ id, updatedAt: st.at, data: payload });
  }
  for (const [id, tb] of Object.entries(sync.tombs)) {
    if (sync.pushed[id] === tb.at) continue;
    if (!byKind[tb.t]) continue;
    byKind[tb.t].push({ id, updatedAt: tb.at, deletedAt: tb.at });
  }

  let pushed = 0, rejected = [];
  if (KINDS.some((k) => byKind[k].length)) {
    const res = await api("/api/sync", { method: "POST", body: byKind, token });
    pushed = res.applied || 0;
    rejected = res.rejected || [];
    const bad = new Set(rejected.map(r => r.id));
    for (const kind of KINDS)
      for (const row of byKind[kind] || [])
        if (!bad.has(row.id)) markClean(sync, row.id, row.updatedAt);
  }

  // 2) 拉服务器改动（可能分页）
  const incoming = {};
  for (const k of ALL_KINDS) incoming[k] = [];
  let guard = 0;
  for (;;) {
    const res = await api(`/api/sync?since=${sync.cursor}`, { token });
    for (const kind of KINDS) incoming[kind].push(...(res[kind] || []));
    sync.cursor = res.seq ?? sync.cursor;
    if (!res.more || ++guard > 50) break;
  }

  sync.lastSyncAt = Date.now();
  const pulled = KINDS.reduce((n, k) => n + incoming[k].length, 0);
  return { sync, incoming, pushed, pulled, rejected };
}

/**
 * 把拉回来的记录并进本地。同一条记录以 updatedAt 较大的一方为准；
 * 本地有未推送的更新时不覆盖，留给下一轮推上去。
 */
export function mergeIncoming(data, sync, incoming, myUserId) {
  const next = { ...data };

  for (const kind of ALL_KINDS) {
    const rows = incoming[kind] || [];
    if (!rows.length) continue;
    const list = [...(next[kind] || [])];
    const pos = new Map(list.map((x, i) => [x.id, i]));

    for (const row of rows) {
      const localStamp = sync.stamps[row.id]?.at || sync.tombs[row.id]?.at || 0;
      const localDirty = localStamp && sync.pushed[row.id] !== localStamp;
      if (localDirty && localStamp >= row.updatedAt) continue;   // 本地更新，等下一轮推上去

      const i = pos.get(row.id);
      if (row.deletedAt) {
        if (i !== undefined) { list.splice(i, 1); pos.clear(); list.forEach((x, k) => pos.set(x.id, k)); }
        sync.tombs[row.id] = { t: kind, at: row.updatedAt };
        delete sync.stamps[row.id];
      } else {
        const item = { ...row.data, id: row.id, ownerId: row.ownerId };
        if (i === undefined) { pos.set(row.id, list.length); list.push(item); }
        else list[i] = item;
        sync.stamps[row.id] = { t: kind, at: row.updatedAt };
        delete sync.tombs[row.id];
      }
      markClean(sync, row.id, row.updatedAt);
    }
    next[kind] = list;
  }

  next._sync = sync;
  return next;
}


/* ── 照片同步 ──
 * 照片是 IndexedDB 里的 Blob，走单独的二进制端点：先由 /api/sync 建好元数据
 * （服务端要靠它判断归属和权限），再 POST 二进制。
 * 只处理被记录引用的照片——没被任何记录引用的是废弃的，不占用带宽。
 */
export async function syncPhotos(data, token, sync) {
  const referenced = new Set();
  for (const r of data.records || []) for (const pid of r.photos || []) referenced.add(pid);
  if (!referenced.size) return { uploaded: 0, downloaded: 0, changed: false };

  const state = { ...(sync.photos || {}) };
  let localIds;
  try { localIds = new Set(await localPhotoIds()); } catch { return { uploaded: 0, downloaded: 0, changed: false }; }

  const toUpload = [...referenced].filter((id) => localIds.has(id) && !state[id]?.up);
  const toDownload = [...referenced].filter((id) => !localIds.has(id) && !state[id]?.gone);

  let uploaded = 0, downloaded = 0;

  if (toUpload.length) {
    const now = Date.now();
    await api("/api/sync", { method: "POST", token,
      body: { photos: toUpload.map((id) => ({ id, updatedAt: now, data: {} })) } });
    for (const id of toUpload) {
      try {
        const blob = await getPhoto(id);
        if (!blob) continue;
        await api(`/api/photo/${id}`, { method: "POST", token, raw: blob, ctype: blob.type || "image/jpeg" });
        state[id] = { up: true };
        uploaded++;
      } catch { /* 单张失败不影响其余，下一轮再试 */ }
    }
  }

  for (const id of toDownload) {
    try {
      const buf = await api(`/api/photo/${id}`, { token });
      await putPhoto(id, new Blob([buf], { type: "image/jpeg" }));
      state[id] = { up: true };
      downloaded++;
    } catch (e) {
      // 上传方还没传上来，或者不是自己/导师的照片——记下来别每轮都重试
      if (/HTTP 404|HTTP 403/.test(e.message)) state[id] = { gone: true };
    }
  }

  sync.photos = state;
  return { uploaded, downloaded, changed: uploaded > 0 || downloaded > 0 };
}

/* ── 推送通知 ──
 * 页面里的定时器在 app 退到后台后就被冻结了，所以「到点提醒」只能靠服务器
 * 推过来唤醒 Service Worker。iOS 上还有两个前提：必须是「添加到主屏幕」的
 * PWA，且权限必须在用户手势里申请。
 */

const b64ToBytes = (b64) => {
  const s = (b64 + "=".repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(s);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

export const pushSupported = () =>
  typeof window !== "undefined" && "serviceWorker" in navigator &&
  "PushManager" in window && "Notification" in window;

/** iOS 只对已加到主屏幕的 PWA 开放推送，在 Safari 标签页里连 API 都没有 */
export const isStandalone = () => {
  try {
    return window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  } catch { return false; }
};

export async function pushStatus() {
  if (!pushSupported()) return { supported: false, subscribed: false, permission: "unsupported" };
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    return { supported: true, subscribed: !!sub, permission: Notification.permission,
             endpoint: sub?.endpoint || null };
  } catch {
    return { supported: true, subscribed: false, permission: Notification.permission };
  }
}

/** 必须在用户手势（点击）里调用，否则 Safari 不会弹权限框 */
export async function enablePush(token) {
  if (!pushSupported()) throw new Error("此浏览器不支持推送通知");
  const perm = await Notification.requestPermission();
  if (perm !== "granted") {
    throw new Error(perm === "denied"
      ? "通知权限被拒绝了。iPhone 上要到 设置 → 通知 → Mochi 里重新打开"
      : "没有获得通知权限");
  }
  const { key, enabled } = await api("/api/push/key", { token });
  if (!enabled || !key) throw new Error("服务器未启用推送");

  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  // 服务器换过 VAPID 密钥的话，旧订阅是废的，得退掉重订
  if (sub) {
    const old = new Uint8Array(sub.options?.applicationServerKey || []);
    const now = b64ToBytes(key);
    if (old.length !== now.length || !old.every((v, i) => v === now[i])) {
      await sub.unsubscribe().catch(() => {});
      sub = null;
    }
  }
  if (!sub) {
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) });
  }
  await api("/api/push/subscribe", { method: "POST", token, body: { subscription: sub.toJSON() } });
  return sub;
}

export async function disablePush(token) {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  await api("/api/push/unsubscribe", { method: "POST", token, body: { endpoint: sub.endpoint } })
    .catch(() => {});
  await sub.unsubscribe().catch(() => {});
}

export const testPush = (token) => api("/api/push/test", { method: "POST", token, body: {} });

/**
 * 把「未来还会响的提醒」整份上报，服务端照单替换。
 * 只有开了推送才上报——没开的话服务器不需要知道你要做什么、什么时候做。
 */
export async function syncReminders(data, token) {
  const now = Date.now();
  const list = (data?.todos || [])
    .filter((t) => !t.done && t.remind && !t.remind.fired && t.remind.at > now)
    .slice(0, 300)
    .map((t) => ({
      id: t.id,
      dueAt: t.remind.at,
      title: `⏰ ${t.text}`.slice(0, 120),
      body: [t.importance === "main" ? "主线" : t.importance === "side" ? "支线" : "休闲",
             t.duration ? `预期 ${t.duration} 分钟` : ""].filter(Boolean).join(" · "),
    }));
  return api("/api/reminders", { method: "POST", token, body: { reminders: list } });
}
