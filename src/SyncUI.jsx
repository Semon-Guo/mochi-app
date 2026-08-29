import { useState, useEffect, useRef, useMemo } from "react";
import * as Sync from "./sync.js";
import { Avatar } from "./AdvisorView.jsx";
import { fileToAvatar } from "./avatar.js";

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
  const [syncTodos, setSyncTodos] = useState(() => Sync.getSyncTodos());
  const [push, setPush] = useState({ supported: false, subscribed: false, permission: "default" });
  const [pushBusy, setPushBusy] = useState("");
  const [pushMsg, setPushMsg] = useState("");
  const running = useRef(false);

  useEffect(() => { Sync.pushStatus().then(setPush).catch(() => {}); }, [auth?.token]);

  const togglePush = async (on) => {
    setPushMsg(""); setPushBusy(on ? "on" : "off");
    try {
      if (on) {
        await Sync.enablePush(auth.token);
        await Sync.syncReminders(data, auth.token);   // 立刻把已有的提醒送上去
        setPushMsg("已开启，到点会推送到这台设备");
      } else {
        await Sync.disablePush(auth.token);
        setPushMsg("已关闭");
      }
      setPush(await Sync.pushStatus());
    } catch (e) {
      setPushMsg(e.message);
    } finally { setPushBusy(""); }
  };

  const doTestPush = async () => {
    setPushMsg(""); setPushBusy("test");
    try {
      await Sync.testPush(auth.token);
      setPushMsg("已发出，通知应该马上就到");
    } catch (e) { setPushMsg(e.message); }
    finally { setPushBusy(""); }
  };

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

      // 开了推送才上报提醒——没开的话服务器不需要知道你要做什么、什么时候做
      if ((await Sync.pushStatus()).subscribed) {
        await Sync.syncReminders(data, auth.token).catch(() => {});
      }
    } catch (e) {
      if (/HTTP 401/.test(e.message)) { Sync.setAuth(null); setAuthState(null); setErr("登录已过期，请重新登录"); }
      else if (!quiet) setErr(/Failed to fetch|NetworkError|Load failed/i.test(e.message)
        ? "连不上服务器（不在实验室网络，或根证书未信任）" : e.message);
    } finally { running.current = false; setBusy(false); }
  };

  // 提醒的指纹：只要有人新增/改动/取消了提醒，这串就会变
  const remindKey = useMemo(() => (data?.todos || [])
    .filter((t) => !t.done && t.remind && !t.remind.fired)
    .map((t) => `${t.id}@${t.remind.at}`)
    .sort().join(","), [data?.todos]);

  // 设完提醒就立刻上报，不能等下一个同步周期。
  // 用户设个「2 分钟后」的提醒然后马上划掉 app，等 2 分钟一轮的同步根本来不及——
  // 服务器压根不知道有这条提醒，自然也就不会推。
  useEffect(() => {
    if (!auth || !push.subscribed) return;
    const t = setTimeout(() => {
      Sync.syncReminders(data, auth.token).catch(() => {});
    }, 600);   // 稍等一下，避免连点几下时间选择器时每次都发请求
    return () => clearTimeout(t);
  }, [remindKey, auth?.token, push.subscribed]);

  // 打开 app 时同步一次，之后每 2 分钟一次；回到前台也补一次。
  // syncTodos 变化时也重跑：刚打开开关就该把待办推上去，不用干等两分钟。
  useEffect(() => {
    if (!auth) return;
    doSync(true);
    const iv = setInterval(() => doSync(true), 120000);
    const wake = () => { if (document.visibilityState === "visible") doSync(true); };
    document.addEventListener("visibilitychange", wake);
    return () => { clearInterval(iv); document.removeEventListener("visibilitychange", wake); };
  }, [auth?.token, syncTodos]);

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
              <ProfileCard auth={auth} onUpdate={(u) => {
                const next = { ...auth, user: u };
                Sync.setAuth(next); setAuthState(next);
              }} />

              <label style={{
                display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer",
                padding: "10px 11px", borderRadius: 12, border: `1px solid ${C.line}`,
                background: "#FCFAF6", marginTop: 4,
              }}>
                <input type="checkbox" checked={syncTodos} style={{ marginTop: 3, cursor: "pointer" }}
                  onChange={(e) => { Sync.setSyncTodos(e.target.checked); setSyncTodos(e.target.checked); }} />
                <span style={{ fontSize: 12.5, lineHeight: 1.6 }}>
                  <b style={{ color: C.ink }}>同步待办到我的其他设备</b>
                  <span style={{ display: "block", color: C.faint, fontSize: 11.5, marginTop: 2 }}>
                    待办、专注计时、timeline <b>只有你自己看得到</b>——导师和其他同学都看不到，
                    服务端强制。关掉则只同步实验记录。
                  </span>
                </span>
              </label>
              {auth.user.role === "advisor" && (
                <button onClick={() => { setOpen(false); onOpenAdvisor(); }}
                  style={{ ...btn("#FFF", C.ink, { width: "100%", border: `2px solid ${C.edge}`, marginTop: 6 }) }}>
                  查看全组记录
                </button>
              )}
              {/* 推送：app 关着也能收到提醒，代价是任务标题要上传 */}
              <div style={{ padding: "10px 11px", borderRadius: 12, border: `1px solid ${C.line}`,
                background: "#FCFAF6", marginTop: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 700, color: C.ink, flex: 1 }}>
                    到点推送通知
                  </span>
                  {push.supported && push.permission !== "denied" && (
                    <button onClick={() => togglePush(!push.subscribed)} disabled={!!pushBusy}
                      style={{ ...btn(push.subscribed ? "#FFF" : C.ink, push.subscribed ? C.dim : "#FFF",
                        { padding: "6px 12px", fontSize: 12, borderRadius: 10,
                          border: push.subscribed ? `1px solid ${C.edge}` : "none",
                          opacity: pushBusy ? .5 : 1 }) }}>
                      {pushBusy === "on" ? "开启中…" : pushBusy === "off" ? "关闭中…"
                        : push.subscribed ? "关闭" : "开启"}
                    </button>
                  )}
                </div>

                {!Sync.isStandalone() && push.supported && (
                  <div style={{ fontSize: 11.5, color: "#C08838", marginTop: 6, lineHeight: 1.6 }}>
                    iPhone 上需要先把 Mochi「添加到主屏幕」，在 Safari 标签页里收不到通知。
                  </div>
                )}
                {!push.supported && (
                  <div style={{ fontSize: 11.5, color: C.faint, marginTop: 6, lineHeight: 1.6 }}>
                    此浏览器不支持推送。iPhone 需 iOS 16.4 以上，且已添加到主屏幕。
                  </div>
                )}
                {push.permission === "denied" && (
                  <div style={{ fontSize: 11.5, color: C.red, marginTop: 6, lineHeight: 1.6 }}>
                    通知权限被拒绝了。iPhone 上到「设置 → 通知 → Mochi」重新打开。
                  </div>
                )}

                <div style={{ fontSize: 11.5, color: C.faint, marginTop: 6, lineHeight: 1.6 }}>
                  {push.subscribed
                    ? "app 关着也会到点提醒。任务标题会存在服务器上用于推送，通知内容对推送服务是加密的。"
                    : "不开的话，提醒只在打开 app 时补弹——退到后台后系统不会推送。"}
                </div>

                {push.subscribed && (
                  <button onClick={doTestPush} disabled={!!pushBusy}
                    style={{ ...btn("#FFF", C.ink, { width: "100%", marginTop: 8, padding: "8px 0",
                      fontSize: 12, borderRadius: 10, border: `1px solid ${C.edge}`, opacity: pushBusy ? .5 : 1 }) }}>
                    {pushBusy === "test" ? "发送中…" : "发送测试通知"}
                  </button>
                )}
                {pushMsg && (
                  <div style={{ fontSize: 11.5, marginTop: 7, lineHeight: 1.6,
                    color: /失败|拒绝|不支持|未启用|没有/.test(pushMsg) ? C.red : C.green }}>{pushMsg}</div>
                )}
              </div>

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


/* ── 个人资料：头像 + 显示名 ──
 * 头像是导师端认人的主要线索（20 个人的列表全是文字很难扫），
 * 所以上传入口放在同步面板里，登录后立刻能看到。
 */
function ProfileCard({ auth, onUpdate }) {
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(auth.user.displayName || "");
  const fileRef = useRef(null);

  const pick = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = "";                       // 同一张图再选一次也要能触发
    if (!f) return;
    setMsg(""); setBusy("avatar");
    try {
      const dataUrl = await fileToAvatar(f);   // 裁方 + 压到 192px
      const r = await Sync.uploadAvatar(auth.token, dataUrl);
      onUpdate(r.user);
      setMsg("头像已更新");
    } catch (err) { setMsg(err.message); }
    finally { setBusy(""); }
  };

  const saveName = async () => {
    const v = name.trim();
    if (!v || v === auth.user.displayName) { setEditing(false); return; }
    setMsg(""); setBusy("name");
    try {
      const r = await Sync.updateProfile(auth.token, v);
      onUpdate(r.user);
      setEditing(false);
      setMsg("显示名已更新");
    } catch (err) { setMsg(err.message); }
    finally { setBusy(""); }
  };

  return (
    <div style={{ padding: "10px 0 4px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
        <button onClick={() => fileRef.current?.click()} disabled={!!busy} title="换头像"
          style={{ border: "none", background: "none", padding: 0, cursor: "pointer",
            position: "relative", borderRadius: "50%", lineHeight: 0, opacity: busy === "avatar" ? .5 : 1 }}>
          <Avatar user={auth.user} size={46} ring />
          <span style={{ position: "absolute", right: -1, bottom: -1, width: 17, height: 17,
            borderRadius: "50%", background: C.ink, color: "#FFF", fontSize: 9,
            display: "flex", alignItems: "center", justifyContent: "center",
            boxShadow: "0 0 0 2px #FFF" }}>✎</span>
        </button>
        <input ref={fileRef} type="file" accept="image/*" onChange={pick} style={{ display: "none" }} />

        <div style={{ flex: 1, minWidth: 0 }}>
          {editing ? (
            <div style={{ display: "flex", gap: 6 }}>
              <input value={name} onChange={(e) => setName(e.target.value)} autoFocus
                onKeyDown={(e) => { if (e.key === "Enter") saveName(); if (e.key === "Escape") setEditing(false); }}
                style={{ ...input, marginTop: 0, padding: "7px 9px", fontSize: 14 }} />
              <button onClick={saveName} disabled={!!busy}
                style={{ ...btn(C.ink, "#FFF", { padding: "7px 12px", fontSize: 12.5, borderRadius: 10 }) }}>
                {busy === "name" ? "…" : "保存"}
              </button>
            </div>
          ) : (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <b style={{ color: C.ink, fontSize: 14.5 }}>{auth.user.displayName}</b>
                <button onClick={() => { setName(auth.user.displayName); setEditing(true); }}
                  style={{ border: "none", background: "none", cursor: "pointer", color: C.faint,
                    fontSize: 11, padding: 2, fontFamily: "inherit" }}>改名</button>
              </div>
              <div style={{ fontSize: 11.5, color: C.dim, marginTop: 1 }}>
                @{auth.user.username} ·{" "}
                {auth.user.role === "advisor"
                  ? <b style={{ color: C.amber }}>导师 · 可查看全组记录</b>
                  : "学生 · 只同步自己的记录"}
              </div>
            </>
          )}
        </div>
      </div>
      {msg && (
        <div style={{ fontSize: 11.5, marginTop: 8, lineHeight: 1.6,
          color: /失败|太大|不对|不能|读不了/.test(msg) ? C.red : C.green }}>{msg}</div>
      )}
    </div>
  );
}
