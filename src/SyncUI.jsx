import { useState, useEffect, useRef } from "react";
import * as Sync from "./sync.js";

const C = {
  bg: "#FDFBF7", ink: "#2C2C2C", dim: "#999", faint: "#C0B8A8",
  line: "#F0EDE6", edge: "#E8E4DA", amber: "#E8A838", green: "#5A9E4B", red: "#C02556",
};
const btn = (bg, fg, extra = {}) => ({
  padding: "11px 0", borderRadius: 13, border: "none", background: bg, color: fg,
  fontSize: 14, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", ...extra,
});
const input = {
  width: "100%", padding: "11px 12px", borderRadius: 11, border: `2px solid ${C.edge}`,
  fontSize: 15, fontFamily: "inherit", outline: "none", background: "#FFF", color: C.ink,
  marginTop: 6,
};

const ago = (ts) => {
  if (!ts) return "从未";
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
};

/* ── 登录 / 注册 ── */
function AuthForm({ onDone, onCancel }) {
  const [mode, setMode] = useState("login");
  const [f, setF] = useState({ username: "", password: "", displayName: "", inviteCode: "" });
  const [server, setSrv] = useState(Sync.getServer());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const set = (k) => (e) => setF((v) => ({ ...v, [k]: e.target.value }));

  const submit = async () => {
    setErr(""); setBusy(true);
    try {
      Sync.setServer(server);
      const res = mode === "login"
        ? await Sync.login(f.username, f.password)
        : await Sync.register(f);
      Sync.setAuth(res);
      onDone(res);
    } catch (e) {
      // fetch 对证书错误只给一个笼统的 TypeError，这里给出可操作的提示
      setErr(/Failed to fetch|NetworkError|Load failed/i.test(e.message)
        ? "连不上服务器。检查：① 是否在实验室网络里 ② 是否装好并信任了根证书"
        : e.message);
    } finally { setBusy(false); }
  };

  return (
    <div style={{ padding: "4px 0 8px" }}>
      <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
        {[["login", "登录"], ["register", "注册"]].map(([k, label]) => (
          <button key={k} onClick={() => { setMode(k); setErr(""); }} style={{
            flex: 1, padding: "9px 0", borderRadius: 11, cursor: "pointer", fontFamily: "inherit",
            fontSize: 13.5, fontWeight: 600,
            border: mode === k ? `2px solid ${C.ink}` : `2px solid ${C.edge}`,
            background: mode === k ? C.ink : "#FFF", color: mode === k ? "#FFF" : C.dim,
          }}>{label}</button>
        ))}
      </div>

      <label style={{ fontSize: 12, color: C.dim }}>用户名
        <input style={input} value={f.username} onChange={set("username")}
          autoCapitalize="none" autoCorrect="off" placeholder="字母数字，2-32 位" />
      </label>
      <label style={{ fontSize: 12, color: C.dim, display: "block", marginTop: 10 }}>密码
        <input style={input} type="password" value={f.password} onChange={set("password")}
          placeholder="至少 8 位" />
      </label>
      {mode === "register" && (
        <>
          <label style={{ fontSize: 12, color: C.dim, display: "block", marginTop: 10 }}>显示名
            <input style={input} value={f.displayName} onChange={set("displayName")} placeholder="导师看到的名字" />
          </label>
          <label style={{ fontSize: 12, color: C.dim, display: "block", marginTop: 10 }}>邀请码
            <input style={input} value={f.inviteCode} onChange={set("inviteCode")} placeholder="问组里要" />
          </label>
        </>
      )}
      <details style={{ marginTop: 12 }}>
        <summary style={{ fontSize: 12, color: C.faint, cursor: "pointer" }}>服务器地址</summary>
        <input style={input} value={server} onChange={(e) => setSrv(e.target.value)} autoCapitalize="none" />
      </details>

      {err && (
        <div style={{ marginTop: 12, padding: "10px 12px", borderRadius: 11, background: "#FFF0F3",
          border: "1px solid #F3C6D2", color: C.red, fontSize: 12.5, lineHeight: 1.6 }}>{err}</div>
      )}

      <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
        <button onClick={onCancel} style={{ ...btn("#FFF", C.dim, { flex: 1, border: `2px solid ${C.edge}` }) }}>取消</button>
        <button onClick={submit} disabled={busy || !f.username || !f.password}
          style={{ ...btn(C.ink, "#FFF", { flex: 1, opacity: busy || !f.username || !f.password ? 0.4 : 1 }) }}>
          {busy ? "请稍候…" : mode === "login" ? "登录" : "注册"}
        </button>
      </div>
    </div>
  );
}

/* ── 同步状态条 ── */
export function SyncBar({ data, applySync, onOpenAdvisor }) {
  const [auth, setAuthState] = useState(() => Sync.getAuth());
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [tick, setTick] = useState(0);
  const running = useRef(false);

  const pending = Sync.pendingCount(data);
  const lastAt = data?._sync?.lastSyncAt || 0;

  // 让「x 分钟前」自己走动
  useEffect(() => { const iv = setInterval(() => setTick((n) => n + 1), 30000); return () => clearInterval(iv); }, []);

  const doSync = async (quiet = false) => {
    if (!auth || running.current) return;
    running.current = true;
    if (!quiet) setBusy(true);
    setErr("");
    try {
      const { sync, incoming } = await Sync.syncOnce(data, auth.token);
      // 用 prev 而不是发起时的 data —— 同步是异步的，这期间用户可能又改了东西
      applySync((prev) => Sync.mergeIncoming(prev, sync, incoming));

      // 照片走二进制端点，单独一轮。把刚拉回来的记录也算进引用集合，
      // 这样新记录的照片当轮就能下载，不用等下一次同步。
      const withIncoming = {
        ...data,
        records: [...(data.records || []),
                  ...incoming.records.filter((r) => !r.deletedAt).map((r) => ({ ...r.data, id: r.id }))],
      };
      const ph = await Sync.syncPhotos(withIncoming, auth.token, sync);
      if (ph.changed) applySync((prev) => ({ ...prev, _sync: { ...prev._sync, photos: sync.photos } }));
    } catch (e) {
      if (/HTTP 401/.test(e.message)) { Sync.setAuth(null); setAuthState(null); setErr("登录已过期，请重新登录"); }
      else if (!quiet) setErr(/Failed to fetch|NetworkError|Load failed/i.test(e.message)
        ? "连不上服务器（不在实验室网络，或根证书未信任）" : e.message);
    } finally { running.current = false; setBusy(false); }
  };

  // 打开 app 时同步一次，之后每 2 分钟一次；回到前台也补一次
  useEffect(() => {
    if (!auth) return;
    doSync(true);
    const iv = setInterval(() => doSync(true), 120000);
    const wake = () => { if (document.visibilityState === "visible") doSync(true); };
    document.addEventListener("visibilitychange", wake);
    return () => { clearInterval(iv); document.removeEventListener("visibilitychange", wake); };
  }, [auth?.token]);

  const status = !auth ? "登录后可与课题组同步"
    : busy ? "同步中…"
    : pending ? `${pending} 条待同步`
    : `已同步 · ${ago(lastAt)}`;
  const dot = !auth ? C.faint : busy ? C.amber : pending ? C.amber : C.green;

  return (
    <div style={{ marginBottom: 10, border: `1px solid ${C.line}`, borderRadius: 13, background: "#FFF", overflow: "hidden" }}>
      <div onClick={() => setOpen((v) => !v)} style={{
        display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", cursor: "pointer",
      }}>
        <span style={{ width: 7, height: 7, borderRadius: "50%", background: dot, flexShrink: 0,
          animation: busy ? "runPulse 1.2s ease-in-out infinite" : undefined }} />
        <span style={{ fontSize: 12.5, color: auth ? C.ink : C.dim, flex: 1, minWidth: 0,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{status}</span>
        {auth && (
          <button onClick={(e) => { e.stopPropagation(); doSync(); }} disabled={busy} title="立即同步"
            style={{ border: "none", background: "none", cursor: "pointer", color: C.dim, fontSize: 15, padding: 2 }}>⟳</button>
        )}
        <span style={{ color: C.faint, fontSize: 10 }}>{open ? "▾" : "▸"}</span>
      </div>

      {err && (
        <div style={{ padding: "0 12px 10px", fontSize: 12, color: C.red, lineHeight: 1.6 }}>{err}</div>
      )}

      {open && (
        <div style={{ padding: "4px 12px 12px", borderTop: `1px solid ${C.line}` }}>
          {!auth ? (
            <AuthForm onDone={(a) => { setAuthState(a); setOpen(false); }} onCancel={() => setOpen(false)} />
          ) : (
            <>
              <div style={{ fontSize: 12.5, color: C.dim, padding: "8px 0", lineHeight: 1.7 }}>
                <div>账号：<b style={{ color: C.ink }}>{auth.user.displayName}</b>（{auth.user.username}）</div>
                <div>身份：{auth.user.role === "advisor" ? "导师 · 可查看全组记录" : "学生 · 只同步自己的记录"}</div>
                <div style={{ color: C.faint, fontSize: 11.5, marginTop: 4 }}>
                  只有实验记录会同步，待办和专注计时留在本机
                </div>
              </div>
              {auth.user.role === "advisor" && (
                <button onClick={() => { setOpen(false); onOpenAdvisor(); }}
                  style={{ ...btn("#FFF", C.ink, { width: "100%", border: `2px solid ${C.edge}`, marginTop: 6 }) }}>
                  查看全组记录
                </button>
              )}
              <button onClick={() => { Sync.setAuth(null); setAuthState(null); setOpen(false); }}
                style={{ ...btn("#FFF", C.red, { width: "100%", border: `2px solid ${C.edge}`, marginTop: 8 }) }}>
                退出登录
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/* ── 导师视图：按人分组看全组记录（只读） ── */
export function AdvisorView({ data, onClose }) {
  const auth = Sync.getAuth();
  const [users, setUsers] = useState([]);
  const [err, setErr] = useState("");
  const [who, setWho] = useState("all");

  useEffect(() => {
    if (!auth) return;
    Sync.fetchUsers(auth.token).then((r) => setUsers(r.users || [])).catch((e) => setErr(e.message));
  }, []);

  const nameOf = (id) => users.find((u) => u.id === id)?.displayName || "（未知成员）";
  const projName = (pid) => (data.projects || []).find((p) => p.id === pid)?.name || "未归类";

  const records = [...(data.records || [])]
    .filter((r) => who === "all" || r.ownerId === who)
    .sort((a, b) => (b.at || 0) - (a.at || 0));

  const byOwner = {};
  for (const r of data.records || []) byOwner[r.ownerId || "me"] = (byOwner[r.ownerId || "me"] || 0) + 1;

  return (
    <div className="app-shell" style={{ fontFamily: "'Outfit','Noto Serif SC',sans-serif",
      background: C.bg, minHeight: "100vh", maxWidth: "var(--app-w)", margin: "0 auto",
      paddingBottom: 60, color: C.ink }}>
      <div style={{ padding: "52px 24px 12px", display: "flex", alignItems: "center", gap: 10 }}>
        <button onClick={onClose} style={{ border: "none", background: "none", cursor: "pointer",
          fontSize: 20, color: C.dim, padding: 0 }}>‹</button>
        <div>
          <div style={{ fontSize: 22, fontWeight: 700 }}>全组记录</div>
          <div style={{ fontSize: 12, color: C.dim, marginTop: 2 }}>只读 · 共 {(data.records || []).length} 条</div>
        </div>
      </div>

      {err && <div style={{ margin: "0 24px", color: C.red, fontSize: 13 }}>{err}</div>}

      <div style={{ padding: "8px 24px", display: "flex", gap: 6, flexWrap: "wrap" }}>
        {[["all", `全部 ${(data.records || []).length}`],
          ...users.filter(u => u.role !== "advisor").map((u) => [u.id, `${u.displayName} ${byOwner[u.id] || 0}`])]
          .map(([k, label]) => (
            <button key={k} onClick={() => setWho(k)} style={{
              padding: "7px 12px", borderRadius: 10, cursor: "pointer", fontFamily: "inherit",
              fontSize: 12, fontWeight: 600,
              border: who === k ? `2px solid ${C.ink}` : `2px solid ${C.edge}`,
              background: who === k ? C.ink : "#FFF", color: who === k ? "#FFF" : C.dim,
            }}>{label}</button>
          ))}
      </div>

      <div style={{ padding: "8px 24px" }}>
        {records.length === 0 && (
          <div style={{ textAlign: "center", padding: "60px 0", color: C.faint }}>
            <div style={{ fontSize: 40 }}>📓</div>
            <div style={{ fontSize: 15, marginTop: 8 }}>还没有记录</div>
          </div>
        )}
        {records.map((r) => (
          <div key={r.id} style={{ padding: "12px 0", borderBottom: `1px solid ${C.line}` }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: C.amber, background: "#FFF6E5",
                padding: "2px 8px", borderRadius: 5 }}>{nameOf(r.ownerId)}</span>
              <span style={{ fontSize: 11, color: C.faint }}>{projName(r.projectId)}</span>
              <span style={{ fontSize: 11, color: C.faint, marginLeft: "auto" }}>
                {new Date(r.at || 0).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })}
              </span>
            </div>
            <div style={{ fontSize: 14, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{r.text}</div>
            {r.weather && <div style={{ fontSize: 11, color: C.faint, marginTop: 4 }}>{r.weather}</div>}
            {r.photos?.length > 0 && (
              <div style={{ fontSize: 11, color: C.faint, marginTop: 4 }}>📷 {r.photos.length} 张照片</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
