import { useState, useEffect, useMemo, useRef } from "react";
import * as Sync from "./sync.js";
import { avatarFallback } from "./avatar.js";
import { downloadFile, fmtBytes } from "./files.js";
import { Photo } from "./PhotoView.jsx";
import { Thread, indexComments, threadOf, LIKE, REPLY } from "./Comments.jsx";
import { loadSeen, persistSeen, freshRecords, FRESH_WINDOW } from "./seen.js";
import { AdminPanel } from "./AdminPanel.jsx";

/* 导师端：按学生或按项目看全组进展。
 *
 * 视觉上走「实验记录本」的路子——数字一律等宽字体，横平竖直的细线分栏，
 * 少装饰多信息。导师是来看进展的，不是来看动效的。
 *
 * 学生的记录一律只读——服务端不接受导师改别人的记录，这里也不给编辑入口。
 * 导师能写的只有三样：自己建的项目、回复、点赞。
 */

const C = {
  bg: "#FDFBF7", panel: "#FFFDF9", ink: "#2C2C2C", sub: "#8C8478",
  dim: "#B0A99B", line: "#EDE8DE", hair: "#F4F0E7",
  amber: "#C08A1E", green: "#5A9E4B", blue: "#5B7FC7", red: "#C02556",
};
const MONO = "'JetBrains Mono','SF Mono','Menlo',monospace";
const NC = ["#5B7FC7", "#5A9E4B", "#C08A1E", "#8B6AAF", "#C0562B", "#3E9E9E", "#B0577F"];

const DAY = 86400000;
const dayKey = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };
const fmtDate = (ts) => {
  if (!ts) return "—";
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
};
const fmtAgo = (ts) => {
  if (!ts) return "从无记录";
  const days = Math.floor((Date.now() - ts) / DAY);
  if (days <= 0) return "今天";
  if (days === 1) return "昨天";
  if (days < 30) return `${days} 天前`;
  if (days < 365) return `${Math.floor(days / 30)} 个月前`;
  return `${Math.floor(days / 365)} 年前`;
};

/* ── 头像 ── */
export function Avatar({ user, size = 36, ring = false }) {
  const fb = avatarFallback(user?.displayName || user?.username, user?.id);
  const common = {
    width: size, height: size, borderRadius: "50%", flexShrink: 0,
    boxShadow: ring ? `0 0 0 2px ${C.bg}, 0 0 0 3px ${C.line}` : undefined,
  };
  if (user?.avatar) {
    return <img src={user.avatar} alt="" style={{ ...common, objectFit: "cover", display: "block" }} />;
  }
  return (
    <div style={{
      ...common, background: fb.bg, color: fb.fg, display: "flex",
      alignItems: "center", justifyContent: "center",
      fontSize: size * 0.42, fontWeight: 700, letterSpacing: 0,
    }}>{fb.initial}</div>
  );
}

/* ── 活跃度热力图：最近 16 周，一眼看出谁在推进、谁停了 ── */
function Heatmap({ records, weeks = 16, color = C.green }) {
  const { cells, max, total } = useMemo(() => {
    const counts = new Map();
    for (const r of records) {
      const at = r.at || 0;
      if (at) counts.set(dayKey(at), (counts.get(dayKey(at)) || 0) + 1);
    }
    const today = new Date(); today.setHours(0, 0, 0, 0);
    // 让最后一列落在本周：往前推到最近的周一
    const end = new Date(today);
    end.setDate(end.getDate() + (7 - (end.getDay() === 0 ? 7 : end.getDay())));
    const out = [];
    let mx = 0, tot = 0;
    for (let w = weeks - 1; w >= 0; w--) {
      const col = [];
      for (let d = 6; d >= 0; d--) {
        const t = new Date(end);
        t.setDate(t.getDate() - (w * 7 + d));
        const n = counts.get(dayKey(t.getTime())) || 0;
        mx = Math.max(mx, n); tot += n;
        col.push({ ts: t.getTime(), n, future: t.getTime() > Date.now() });
      }
      out.push(col);
    }
    return { cells: out, max: mx, total: tot };
  }, [records, weeks]);

  const shade = (n) => {
    if (!n) return C.hair;
    const t = max <= 1 ? 1 : Math.min(1, 0.25 + (n / max) * 0.75);
    return `color-mix(in srgb, ${color} ${Math.round(t * 100)}%, ${C.hair})`;
  };

  return (
    <div>
      <div style={{ display: "flex", gap: 3, overflowX: "auto", paddingBottom: 2 }}>
        {cells.map((col, i) => (
          <div key={i} style={{ display: "grid", gap: 3 }}>
            {col.map((c, j) => (
              <div key={j} title={c.future ? "" : `${fmtDate(c.ts)} · ${c.n} 条`}
                style={{
                  width: 9, height: 9, borderRadius: 2,
                  background: c.future ? "transparent" : shade(c.n),
                  outline: c.future ? "none" : `1px solid rgba(0,0,0,.025)`,
                }} />
            ))}
          </div>
        ))}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 7,
        fontSize: 10.5, color: C.dim, fontFamily: MONO }}>
        <span data-heatmap>{weeks} 周 · {total} 条</span>
        <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 3 }}>
          少
          {[0, 0.35, 0.7, 1].map((t, i) => (
            <span key={i} style={{ width: 8, height: 8, borderRadius: 2,
              background: t ? `color-mix(in srgb, ${color} ${Math.round(t * 100)}%, ${C.hair})` : C.hair }} />
          ))}
          多
        </span>
      </div>
    </div>
  );
}

/* ── 小统计块 ── */
function Stat({ label, value, hint, accent }) {
  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ fontSize: 22, fontWeight: 700, fontFamily: MONO, letterSpacing: "-0.5px",
        color: accent || C.ink, lineHeight: 1.1 }}>{value}</div>
      <div style={{ fontSize: 11, color: C.sub, marginTop: 3 }}>{label}</div>
      {hint && <div style={{ fontSize: 10, color: C.dim, marginTop: 1 }}>{hint}</div>}
    </div>
  );
}

/* ── 记录里的数据文件：点一下从服务器现拉 ──
   不预下载，也不显示缩略——导师一屏能刷过几十条记录，没道理让浏览器替他
   把组里所有人的数据集都拖下来。 */
function FileLink({ f }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const open = async () => {
    setErr(""); setBusy(true);
    try { await downloadFile(f, Sync.getAuth()?.token); }
    catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };
  return (
    <button onClick={open} disabled={busy} title={f.name} style={{
      display: "inline-flex", alignItems: "center", gap: 5, maxWidth: "100%",
      marginTop: 5, marginRight: 6, padding: "3px 8px", borderRadius: 7,
      border: `1px solid ${C.line}`, background: C.panel, cursor: "pointer",
      fontFamily: "inherit", fontSize: 10.5, color: err ? C.red : C.ink,
    }}>
      <span>📎</span>
      <span style={{ maxWidth: 190, overflow: "hidden", textOverflow: "ellipsis",
        whiteSpace: "nowrap" }}>{err || f.name}</span>
      <span style={{ fontFamily: MONO, color: C.dim }}>
        {busy ? "…" : fmtBytes(f.size)}
      </span>
    </button>
  );
}

/* ── 一条记录 ──
   两个视图各有侧重，作者那一行是分水岭：
   「按成员」看的是一个人的时间线，作者是废话，项目标签才是信息；
   「按项目」看的是同一个项目下谁在推进，所以人要立得住——头像放大、
   名字加粗，一屏扫下来能立刻分清是谁写的。 */
function RecordRow({ r, author, projectName, projectColor, onPhoto, showAuthor = true,
                    thread, meId, onLike, onReply, onDropComment }) {
  const withAuthor = showAuthor && author;
  return (
    <div style={{ display: "flex", gap: 10, padding: withAuthor ? "14px 0" : "11px 0",
      borderTop: `1px solid ${C.hair}` }}>
      <div style={{ width: 42, flexShrink: 0, textAlign: "right", paddingTop: withAuthor ? 4 : 1 }}>
        <div style={{ fontSize: 12, fontFamily: MONO, color: C.sub, fontWeight: 600 }}>{fmtDate(r.at)}</div>
        <div style={{ fontSize: 9.5, color: C.dim, fontFamily: MONO }}>
          {new Date(r.at || 0).getFullYear()}
        </div>
      </div>
      <div style={{ width: 1, background: C.line, flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        {withAuthor ? (
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 9 }}>
            <Avatar user={author} size={34} />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: C.ink, lineHeight: 1.25,
                letterSpacing: "-0.2px", overflow: "hidden", textOverflow: "ellipsis",
                whiteSpace: "nowrap" }}>{author.displayName}</div>
              <div style={{ fontSize: 10, color: C.dim, fontFamily: MONO, marginTop: 1 }}>
                @{author.username}
              </div>
            </div>
            {r.weather && (
              <span style={{ fontSize: 11, color: C.dim, marginLeft: "auto", flexShrink: 0 }}>{r.weather}</span>
            )}
          </div>
        ) : (projectName || r.weather) && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 3 }}>
            {projectName && (
              <span style={{ fontSize: 10, color: projectColor || C.sub, fontWeight: 600,
                background: `color-mix(in srgb, ${projectColor || C.sub} 12%, transparent)`,
                padding: "1.5px 7px", borderRadius: 4 }}>{projectName}</span>
            )}
            {r.weather && <span style={{ fontSize: 10.5, color: C.dim }}>{r.weather}</span>}
          </div>
        )}
        <div style={{ fontSize: 13.5, lineHeight: 1.65, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
          {r.text || <span style={{ color: C.dim }}>（无正文）</span>}
        </div>
        {r.photos?.length > 0 && (
          <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
            {r.photos.map((id) => <Photo key={id} id={id} size={66} onOpen={onPhoto} />)}
          </div>
        )}
        {r.files?.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap" }}>
            {r.files.map((f) => <FileLink key={f.id} f={f} />)}
          </div>
        )}
        {thread && (
          <Thread thread={thread} meId={meId} onToggleLike={onLike}
            onReply={onReply} onDelete={onDropComment} />
        )}
      </div>
    </div>
  );
}

/* ── 待审批的导师申请（只有管理员看得到） ── */
function RequestPanel({ token, onChanged }) {
  const [reqs, setReqs] = useState([]);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");

  const load = () => Sync.fetchRequests(token)
    .then((r) => setReqs(r.requests || []))
    .catch((e) => setErr(e.message));
  useEffect(() => { load(); }, [token]);

  const decide = async (u, approve) => {
    setErr(""); setBusy(u.id + (approve ? "y" : "n"));
    try {
      await Sync.decideRequest(token, u.id, approve);
      await load();
      onChanged?.();
    } catch (e) { setErr(e.message); }
    finally { setBusy(""); }
  };

  if (!reqs.length && !err) return null;
  return (
    <div style={{ border: `1px solid ${C.amber}`, borderRadius: 14, background: "#FFFBF0",
      padding: 14, marginBottom: 12 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: C.amber, letterSpacing: "0.4px",
        textTransform: "uppercase", marginBottom: 4 }}>
        待审批的导师申请 · {reqs.length}
      </div>
      <div style={{ fontSize: 11.5, color: C.sub, marginBottom: 10, lineHeight: 1.6 }}>
        这些人用导师码注册。<b>批准前他们只是普通学生</b>，看不到任何别人的记录。
      </div>
      {err && <div style={{ color: C.red, fontSize: 12, marginBottom: 8 }}>{err}</div>}
      {reqs.map((u) => (
        <div key={u.id} style={{ display: "flex", alignItems: "center", gap: 10,
          padding: "9px 0", borderTop: `1px solid ${C.hair}` }}>
          <Avatar user={u} size={32} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600 }}>{u.displayName}</div>
            <div style={{ fontSize: 10.5, color: C.dim, fontFamily: MONO }}>
              @{u.username} · {fmtAgo(u.requestedAt)}申请
            </div>
          </div>
          <button onClick={() => decide(u, false)} disabled={!!busy}
            style={{ padding: "6px 12px", borderRadius: 9, cursor: "pointer", fontFamily: "inherit",
              fontSize: 12, fontWeight: 600, border: `1px solid ${C.line}`, background: "#FFF",
              color: C.sub, opacity: busy ? .5 : 1 }}>
            {busy === u.id + "n" ? "…" : "驳回"}
          </button>
          <button onClick={() => decide(u, true)} disabled={!!busy}
            style={{ padding: "6px 12px", borderRadius: 9, cursor: "pointer", fontFamily: "inherit",
              fontSize: 12, fontWeight: 600, border: "none", background: C.ink, color: "#FFF",
              opacity: busy ? .5 : 1 }}>
            {busy === u.id + "y" ? "…" : "批准为导师"}
          </button>
        </div>
      ))}
    </div>
  );
}

/* ── 导师端主界面 ── */
/* ── 主页那一条「新记录」 ──
   导师打开 app 想知道的第一件事是「谁又干活了」，所以内容直接铺开：头像、
   正文、缩略图、附件一次看全，赞和回复就地能点，不用点进去再点回来。 */
function FeedCard({ r, author, projectName, projectColor, onPhoto, thread, meId,
                    onLike, onReply, onDropComment, onSeen, onOpenUser, read }) {
  return (
    <div style={{ border: `1px solid ${C.line}`, borderRadius: 14, marginBottom: 10,
      padding: "13px 14px", background: read ? "#FBFAF7" : C.panel,
      borderLeft: `3px solid ${read ? C.line : C.amber}`,
      transition: "border-left-color .38s ease, background .38s ease" }}>
      {/* 淡化只作用在正文和附件上。**人的头像和名字一律不置灰**——把活人的
          照片和名字变成灰的，在中文语境里是很不吉利的画面。动作那一行也保持
          清楚，不然想撤销还得眯着眼找按钮。 */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
        <button onClick={() => onOpenUser?.(r.ownerId)} style={{ border: "none", background: "none",
          padding: 0, cursor: "pointer", display: "flex", alignItems: "center", gap: 10,
          minWidth: 0, flex: 1, fontFamily: "inherit", textAlign: "left" }}>
          <Avatar user={author} size={40} ring />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: C.ink, lineHeight: 1.25,
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {author?.displayName || "未知成员"}
            </div>
            <div style={{ fontSize: 10.5, color: C.dim, fontFamily: MONO }}>
              {fmtAgo(r.at)}{r.weather ? ` · ${r.weather}` : ""}
            </div>
          </div>
        </button>
        {projectName && (
          <span style={{ fontSize: 10.5, color: projectColor || C.sub, fontWeight: 700, flexShrink: 0,
            background: `color-mix(in srgb, ${projectColor || C.sub} 12%, transparent)`,
            padding: "3px 9px", borderRadius: 6 }}>{projectName}</span>
        )}
      </div>

      <div className="read-fade" style={{ opacity: read ? 0.42 : 1,
        filter: read ? "grayscale(1)" : "none" }}>
      <div style={{ fontSize: 14, lineHeight: 1.7, color: C.ink, whiteSpace: "pre-wrap",
        wordBreak: "break-word" }}>
        {r.text || <span style={{ color: C.dim }}>（无正文）</span>}
      </div>

      {r.photos?.length > 0 && (
        <div style={{ display: "flex", gap: 7, marginTop: 10, flexWrap: "wrap" }}>
          {r.photos.map((id) => <Photo key={id} id={id} size={84} onOpen={onPhoto} />)}
        </div>
      )}
      {r.files?.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap" }}>
          {r.files.map((f) => <FileLink key={f.id} f={f} />)}
        </div>
      )}
      </div>

      <div style={{ borderTop: `1px solid ${C.hair}`, marginTop: 11, paddingTop: 4 }}>
        <Thread thread={thread} meId={meId} onToggleLike={onLike}
          onReply={onReply} onDelete={onDropComment}
          trailing={
            <button onClick={onSeen} title={read ? "点一下撤销" : "标为已读"}
              style={{ padding: "4px 10px", borderRadius: 999, fontSize: 12, fontWeight: 600,
                cursor: "pointer", fontFamily: "inherit",
                border: `1px solid ${read ? "transparent" : C.line}`,
                background: read ? C.hair : "#FFF", color: read ? C.sub : C.dim,
                transition: "background .25s ease, color .25s ease, border-color .25s ease" }}>
              {read ? "已读 ↺" : "✓ 已读"}
            </button>
          } />
      </div>
    </div>
  );
}

export function AdvisorView({ data, onClose, onPhoto, actions = {} }) {
  const auth = Sync.getAuth();
  const [tab, setTab] = useState("feed");       // feed | people | projects | admin
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [focus, setFocus] = useState(null);      // {type:'user'|'project', id}
  const [members, setMembers] = useState([]);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const [showArchived, setShowArchived] = useState(false);
  const reload = () => setNonce((n) => n + 1);

  useEffect(() => {
    if (!auth) return;
    Sync.fetchOverview(auth.token)
      .then((r) => setMembers(r.members || []))
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
  }, [nonce]);

  const byId = useMemo(() => Object.fromEntries(members.map((m) => [m.id, m])), [members]);
  const records = useMemo(
    () => [...(data.records || [])].sort((a, b) => (b.at || 0) - (a.at || 0)), [data.records]);
  const projects = data.projects || [];

  const projColor = useMemo(() => {
    const m = {};
    projects.forEach((p, i) => { m[p.id] = p.color || NC[i % NC.length]; });
    return m;
  }, [projects]);

  const meId = auth?.user?.id;
  const cmtIndex = useMemo(() => indexComments(data.comments), [data.comments]);
  const recordIds = useMemo(() => records.map((r) => r.id), [records]);

  // 已读状态只存本机：这是导师一个人的阅读进度，没理由让被看的学生知道
  // 他读没读、什么时候读的。
  //
  // 头一回用的时候只把**两周前**的记录标成已读：全标已读的话新导师第一次
  // 打开永远是「没有新记录」，看着像坏了；一条不标又会被课题组历史上的
  // 几百条糊一脸。留最近两周，正好是「最近新增的」那个量。
  const [seen, setSeen] = useState(() => loadSeen(auth?.user?.id,
    records.filter((r) => (r.at || 0) < Date.now() - FRESH_WINDOW).map((r) => r.id)));
  const markSeen = (ids) => setSeen((prev) => {
    const next = new Set(prev);
    ids.forEach((i) => next.add(i));
    persistSeen(meId, next, recordIds);
    return next;
  });
  // 点错了能撤回来——卡片本来就还在眼前，撤销的入口不该藏起来
  const unmarkSeen = (id) => setSeen((prev) => {
    const next = new Set(prev);
    next.delete(id);
    persistSeen(meId, next, recordIds);
    return next;
  });

  const fresh = freshRecords(records, seen, meId);

  // 标记已读不能让这一条当场从眼前消失——刚点完手还在那儿，列表却已经
  // 跳了一格，很容易点错下一条。所以进入这个页签时钉一份快照：这一轮看到的
  // 记录一直留在原位，读过的变灰，等下次再进来才真的清掉。
  const [pinned, setPinned] = useState(() => new Set());
  useEffect(() => {
    if (tab !== "feed") return;
    setPinned(new Set(freshRecords(records, seen, meId).map((r) => r.id)));
    // 只依赖 tab：把 records/seen 放进来会让它每同步一次、每点一次已读就重来
  }, [tab]);

  // 屏幕上这一轮要显示的：没看过的，加上这一轮里刚被标成已读的
  const feedList = records.filter((r) => r.ownerId !== meId
    && (r.at || 0) >= Date.now() - FRESH_WINDOW
    && (!seen.has(r.id) || pinned.has(r.id)));

  // 点赞和回复都算「看过了」——都动手互动了，再让他手动点一下已读是多余的
  const toggleLike = (r) => {
    const mine = threadOf(cmtIndex, r.id).likes.find((c) => !c.ownerId || c.ownerId === meId);
    if (mine) actions.dropComment?.(mine);
    else actions.addComment?.(r.id, LIKE, "");
    markSeen([r.id]);
  };
  const reply = (r, text) => { actions.addComment?.(r.id, REPLY, text); markSeen([r.id]); };

  // 只有项目的拥有者能改名单——服务端本来就只接受本人的写入
  const ownsProject = (p) => p && (!p.ownerId || p.ownerId === meId);
  const toggleMember = (p, uid) => {
    const cur = p.members || [];
    actions.setProjectMembers?.(p.id,
      cur.includes(uid) ? cur.filter((x) => x !== uid) : [...cur, uid]);
  };
  const rowProps = (r) => ({
    thread: threadOf(cmtIndex, r.id), meId,
    onLike: () => toggleLike(r), onReply: (t) => reply(r, t),
    onDropComment: actions.dropComment,
  });

  const weekAgo = Date.now() - 7 * DAY;
  const thisWeek = records.filter((r) => (r.at || 0) >= weekAgo).length;
  const activeThisWeek = new Set(records.filter((r) => (r.at || 0) >= weekAgo).map((r) => r.ownerId)).size;
  // 今天有没有人动——「本周活跃」看的是这一周的势头，答不了「今天组里静没静」
  const today = dayKey(Date.now());
  const activeToday = new Set(records.filter((r) => dayKey(r.at || 0) === today)
    .map((r) => r.ownerId)).size;
  // 「按成员」只列做科研记录的人：纯管理账号（比如只用来审批、一条记录都没有的
  // 导师或管理员）不该占着列表。inGroup 由服务端算好。
  const inGroup = members.filter((m) => m.inGroup !== false);
  const students = inGroup.filter((m) => !m.archivedAt);
  const archived = inGroup.filter((m) => m.archivedAt);
  const serverRecords = members.reduce((n, m) => n + (m.records || 0), 0);

  /* ── 详情：某个学生 ── */
  if (focus?.type === "user") {
    const u = byId[focus.id];
    const mine = records.filter((r) => r.ownerId === focus.id);
    const projIds = [...new Set(mine.map((r) => r.projectId))];
    return (
      <Shell onBack={() => setFocus(null)} title={u?.displayName || "成员"}
        subtitle={(u?.archivedAt ? `已离组（${fmtAgo(u.archivedAt)}） · ` : "") +
          `${mine.length} 条记录 · ${projIds.length} 个项目 · 最后 ${fmtAgo(mine[0]?.at)}`}
        avatar={u}>
        <Panel>
          <Heatmap records={mine} color={C.green} />
        </Panel>
        {projIds.length > 0 && (
          <Panel title="按项目分布">
            {projIds.map((pid) => {
              const p = projects.find((x) => x.id === pid);
              const n = mine.filter((r) => r.projectId === pid).length;
              const pct = Math.round((n / mine.length) * 100);
              return (
                <div key={pid || "none"} style={{ display: "flex", alignItems: "center", gap: 9, padding: "6px 0" }}>
                  <span style={{ fontSize: 12.5, flex: 1, minWidth: 0, overflow: "hidden",
                    textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p?.name || "未归类"}</span>
                  <div style={{ width: 90, height: 5, borderRadius: 3, background: C.hair, overflow: "hidden" }}>
                    <div style={{ width: `${pct}%`, height: "100%", background: projColor[pid] || C.dim }} />
                  </div>
                  <span style={{ fontSize: 11, fontFamily: MONO, color: C.sub, width: 26, textAlign: "right" }}>{n}</span>
                </div>
              );
            })}
          </Panel>
        )}
        <Panel title={`全部记录 · ${mine.length}`}>
          {mine.length === 0 && <Empty text="这位成员还没有记录" />}
          {mine.map((r) => (
            <RecordRow key={r.id} r={r} showAuthor={false} onPhoto={onPhoto} {...rowProps(r)}
              projectName={projects.find((p) => p.id === r.projectId)?.name}
              projectColor={projColor[r.projectId]} />
          ))}
        </Panel>
      </Shell>
    );
  }

  /* ── 详情：某个项目 ── */
  if (focus?.type === "project") {
    const p = projects.find((x) => x.id === focus.id);
    const mine = records.filter((r) => r.projectId === focus.id);
    const people = [...new Set(mine.map((r) => r.ownerId))];
    return (
      <Shell onBack={() => setFocus(null)} title={p?.name || "项目"}
        subtitle={`${mine.length} 条记录 · ${people.length} 人参与 · 最后 ${fmtAgo(mine[0]?.at)}`}
        accent={projColor[focus.id]}>
        <Panel>
          <Heatmap records={mine} color={projColor[focus.id] || C.blue} />
        </Panel>
        {ownsProject(p) ? (
          <Panel title="项目成员">
            <div style={{ fontSize: 11.5, color: C.sub, lineHeight: 1.6, marginBottom: 10 }}>
              勾中的人才看得到这个项目，也才能往里记。移出后他已经写下的记录不受影响。
            </div>
            {students.length === 0 && <div style={{ fontSize: 12.5, color: C.dim }}>组里还没有成员</div>}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {/* 名单外但已经有记录的人也得列出来（比如刚被移出的），否则那些记录
                  在这一页上像是没有主人 */}
              {[...students, ...people.map((uid) => byId[uid]).filter(
                  (m) => m && !students.some((s2) => s2.id === m.id))].map((m) => {
                const on = (p.members || []).includes(m.id);
                const n = mine.filter((r) => r.ownerId === m.id).length;
                return (
                  <button key={m.id} onClick={() => toggleMember(p, m.id)} style={{
                    display: "flex", alignItems: "center", gap: 7, cursor: "pointer",
                    border: `1.5px solid ${on ? C.ink : C.line}`, borderRadius: 999,
                    padding: "5px 12px 5px 5px", fontFamily: "inherit",
                    background: on ? C.ink : "#FFF", color: on ? "#FFF" : C.sub,
                  }}>
                    <Avatar user={m} size={22} />
                    <span style={{ fontSize: 12.5, fontWeight: 600 }}>{m.displayName}</span>
                    {n > 0 && (
                      <span style={{ fontSize: 11, fontFamily: MONO,
                        color: on ? "rgba(255,255,255,.65)" : C.dim }}>{n}</span>
                    )}
                    <span style={{ fontSize: 12, opacity: on ? 1 : .6 }}>{on ? "✓" : "＋"}</span>
                  </button>
                );
              })}
            </div>
          </Panel>
        ) : (
          <Panel title="项目成员">
            <div style={{ fontSize: 12.5, color: C.sub, lineHeight: 1.6 }}>
              这是 {byId[p?.ownerId]?.displayName || "成员"} 自己建的项目，名单由他自己管。
            </div>
          </Panel>
        )}
        {!ownsProject(p) && people.length > 0 && (
          <Panel title="有记录的成员">
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {people.map((uid) => {
                const n = mine.filter((r) => r.ownerId === uid).length;
                return (
                  <button key={uid} onClick={() => setFocus({ type: "user", id: uid })} style={{
                    display: "flex", alignItems: "center", gap: 7, cursor: "pointer",
                    border: `1px solid ${C.line}`, borderRadius: 999, padding: "4px 11px 4px 4px",
                    background: "#FFF", fontFamily: "inherit",
                  }}>
                    <Avatar user={byId[uid]} size={22} />
                    <span style={{ fontSize: 12, fontWeight: 600 }}>{byId[uid]?.displayName || "未知"}</span>
                    <span style={{ fontSize: 11, fontFamily: MONO, color: C.dim }}>{n}</span>
                  </button>
                );
              })}
            </div>
          </Panel>
        )}
        <Panel title={`全部记录 · ${mine.length}`}>
          {mine.length === 0 && <Empty text="这个项目还没有记录" />}
          {mine.map((r) => (
            <RecordRow key={r.id} r={r} author={byId[r.ownerId]} onPhoto={onPhoto} {...rowProps(r)} />
          ))}
        </Panel>
      </Shell>
    );
  }

  /* ── 总览 ── */
  return (
    <Shell onClose={onClose} title="课题组进展"
      subtitle={`${students.length} 名成员${archived.length ? ` · ${archived.length} 人已离组` : ""}` +
        ` · 学生记录只读${Sync.isAdmin(auth?.user) ? " · 管理员" : ""}`}>
      {err && <Panel><div style={{ color: C.red, fontSize: 13 }}>{err}</div></Panel>}

      {Sync.isAdmin(auth?.user) && (
        <RequestPanel token={auth.token} onChanged={reload} />
      )}

      {/* 统计数字来自服务端聚合，记录正文来自本地同步——刚登录时两者会对不上，
          说清楚比让人以为「记录丢了」强 */}
      {!loading && !err && serverRecords > 0 && records.length === 0 && (
        <Panel>
          <div style={{ fontSize: 12.5, color: C.amber, lineHeight: 1.7 }}>
            服务端有 {serverRecords} 条记录，本地还没同步下来。
            回到主界面等同步完成（或点一下同步按钮）再来看详情。
          </div>
        </Panel>
      )}

      <Panel>
        {/* 固定五列。用 auto-fit 的话窄屏上会掉成 4+1，最后一格孤零零挂在第二行；
            minmax(0,1fr) 是为了让格子真能被压窄，而不是被内容撑破 */}
        <div style={{ display: "grid", gap: 4, marginBottom: 14,
          gridTemplateColumns: "repeat(5, minmax(0, 1fr))" }}>
          <Stat label="本周记录" value={thisWeek} accent={thisWeek ? C.green : C.dim} />
          <Stat label="今日活跃" value={`${activeToday}/${students.length}`}
            accent={activeToday ? C.green : C.dim} />
          <Stat label="本周活跃" value={`${activeThisWeek}/${students.length}`} />
          <Stat label="项目" value={projects.length} />
          <Stat label="累计记录" value={records.length} />
        </div>
        <Heatmap records={records} />
      </Panel>

      <div style={{ display: "flex", gap: 6, padding: "0 0 10px" }}>
        {[["feed", `新记录${fresh.length ? ` ${fresh.length}` : ""}`],
          ["people", "按成员"], ["projects", "按项目"],
          ...(Sync.isAdmin(auth?.user) ? [["admin", "管理"]] : [])].map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)} style={{
            padding: "8px 16px", borderRadius: 10, cursor: "pointer", fontFamily: "inherit",
            fontSize: 13, fontWeight: 600,
            border: tab === k ? `1px solid ${C.ink}` : `1px solid ${C.line}`,
            background: tab === k ? C.ink : "#FFF", color: tab === k ? "#FFF" : C.sub,
          }}>{label}</button>
        ))}
      </div>

      {tab === "feed" && (
        <>
          {feedList.length === 0 ? (
            <Empty text={records.length ? "没有新记录，都看过了" : "还没有任何记录"} />
          ) : (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "0 2px 10px" }}>
                <span style={{ fontSize: 12.5, color: C.sub, fontWeight: 600 }}>
                  {fresh.length ? `${fresh.length} 条还没看` : "都看过了，下次进来清空"}
                </span>
                <button onClick={() => markSeen(fresh.map((r) => r.id))} style={{
                  marginLeft: "auto", border: "none", background: "none", cursor: "pointer",
                  color: C.dim, fontSize: 12, fontWeight: 600, fontFamily: "inherit", padding: 2,
                }}>全部标为已读</button>
              </div>
              {feedList.slice(0, 30).map((r) => (
                <FeedCard key={r.id} r={r} author={byId[r.ownerId]} onPhoto={onPhoto}
                  projectName={projects.find((p) => p.id === r.projectId)?.name}
                  projectColor={projColor[r.projectId]}
                  thread={threadOf(cmtIndex, r.id)} meId={meId}
                  onLike={() => toggleLike(r)} onReply={(t) => reply(r, t)}
                  onDropComment={actions.dropComment}
                  read={seen.has(r.id)}
                  onSeen={() => (seen.has(r.id) ? unmarkSeen(r.id) : markSeen([r.id]))}
                  onOpenUser={(id) => setFocus({ type: "user", id })} />
              ))}
              {feedList.length > 30 && (
                <div style={{ textAlign: "center", color: C.dim, fontSize: 12, padding: "6px 0 2px" }}>
                  还有 {feedList.length - 30} 条，处理完这批再看
                </div>
              )}
            </>
          )}
        </>
      )}

      {/* 只有成员视图依赖网络；项目视图的数据都在本地，不该跟着一起等 */}
      {loading && tab === "people" && (
        <Panel><div style={{ color: C.dim, fontSize: 13 }}>正在载入成员…</div></Panel>
      )}

      {!loading && tab === "people" && (
        <>
        <div className="adv-grid">
          {students.length === 0 && <Empty text="组里还没有成员记录" />}
          {students.map((m) => {
            const mine = records.filter((r) => r.ownerId === m.id);
            const stale = mine[0] ? Math.floor((Date.now() - mine[0].at) / DAY) : 999;
            return (
              <button key={m.id} onClick={() => setFocus({ type: "user", id: m.id })} className="adv-card"
                style={{ textAlign: "left", cursor: "pointer", fontFamily: "inherit",
                  border: `1px solid ${C.line}`, borderRadius: 14, background: C.panel, padding: 13 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <Avatar user={m} size={40} ring />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 700, overflow: "hidden",
                      textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.displayName}</div>
                    <div style={{ fontSize: 10.5, color: C.dim, fontFamily: MONO }}>@{m.username}</div>
                  </div>
                </div>
                <div style={{ display: "flex", gap: 12, marginTop: 11, paddingTop: 10,
                  borderTop: `1px solid ${C.hair}` }}>
                  <div><div style={{ fontSize: 15, fontWeight: 700, fontFamily: MONO }}>{m.projects}</div>
                    <div style={{ fontSize: 10, color: C.sub }}>项目</div></div>
                  <div><div style={{ fontSize: 15, fontWeight: 700, fontFamily: MONO }}>{m.records}</div>
                    <div style={{ fontSize: 10, color: C.sub }}>记录</div></div>
                  <div style={{ marginLeft: "auto", textAlign: "right" }}>
                    <div style={{ fontSize: 11.5, fontWeight: 600,
                      color: stale > 14 ? C.dim : stale > 7 ? C.amber : C.green }}>{fmtAgo(m.lastAt)}</div>
                    <div style={{ fontSize: 10, color: C.sub }}>最后记录</div>
                  </div>
                </div>
              </button>
            );
          })}
        </div>

        {/* 离组的人放在下面，不占主视图，但记录一条没少，点得进去 */}
        {archived.length > 0 && (
          <div style={{ marginTop: 4 }}>
            <button onClick={() => setShowArchived((v) => !v)} style={{
              width: "100%", display: "flex", alignItems: "center", gap: 8, padding: "10px 12px",
              border: `1px solid ${C.line}`, borderRadius: 12, background: "transparent",
              cursor: "pointer", fontFamily: "inherit", color: C.dim, fontSize: 12.5,
            }}>
              <span style={{ fontSize: 10 }}>{showArchived ? "▾" : "▸"}</span>
              已离组 {archived.length} 人
              <span style={{ marginLeft: "auto", fontSize: 11, color: C.dim }}>
                记录保留，可查看
              </span>
            </button>
            {showArchived && (
              <div className="adv-grid" style={{ marginTop: 10 }}>
                {archived.map((m) => {
                  const mine = records.filter((r) => r.ownerId === m.id);
                  return (
                    <button key={m.id} onClick={() => setFocus({ type: "user", id: m.id })}
                      className="adv-card" style={{ textAlign: "left", cursor: "pointer",
                        fontFamily: "inherit", border: `1px solid ${C.line}`, borderRadius: 14,
                        background: "transparent", padding: 13, opacity: 0.72 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <span style={{ filter: "grayscale(1)" }}><Avatar user={m} size={34} /></span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13.5, fontWeight: 600, overflow: "hidden",
                            textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.displayName}</div>
                          <div style={{ fontSize: 10.5, color: C.dim, fontFamily: MONO }}>
                            {fmtAgo(m.archivedAt)}离组 · {m.records} 条记录
                          </div>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
        </>
      )}

      {tab === "admin" && Sync.isAdmin(auth?.user) && (
        <AdminPanel auth={auth} onChanged={reload} />
      )}

      {tab === "projects" && (
        <>
        <div style={{ marginBottom: 10 }}>
          {creating ? (
            <div style={{ border: `1px solid ${C.line}`, borderRadius: 14, background: C.panel, padding: 13 }}>
              <div style={{ fontSize: 11.5, color: C.sub, marginBottom: 8, lineHeight: 1.6 }}>
                建一个组级项目，然后在项目里勾选成员。学生会在自己的记录本里看到它。
              </div>
              <input autoFocus value={newName} onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && newName.trim()) {
                    actions.createProject?.(newName.trim()); setNewName(""); setCreating(false);
                  }
                  if (e.key === "Escape") { setNewName(""); setCreating(false); }
                }}
                placeholder="项目名称…"
                style={{ width: "100%", padding: "10px 12px", borderRadius: 10, fontSize: 14,
                  border: `1.5px solid ${C.edge || C.line}`, background: "#FFF", color: C.ink,
                  fontFamily: "inherit", outline: "none", boxSizing: "border-box" }} />
              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <button onClick={() => {
                  if (!newName.trim()) return;
                  actions.createProject?.(newName.trim()); setNewName(""); setCreating(false);
                }} style={{ padding: "8px 16px", borderRadius: 10, border: "none", background: C.ink,
                  color: "#FFF", fontSize: 13, fontWeight: 600, cursor: "pointer",
                  fontFamily: "inherit", opacity: newName.trim() ? 1 : 0.4 }}>建立</button>
                <button onClick={() => { setNewName(""); setCreating(false); }} style={{
                  padding: "8px 16px", borderRadius: 10, border: `1px solid ${C.line}`,
                  background: "#FFF", color: C.sub, fontSize: 13, fontWeight: 600,
                  cursor: "pointer", fontFamily: "inherit" }}>取消</button>
              </div>
            </div>
          ) : (
            <button onClick={() => setCreating(true)} style={{
              width: "100%", padding: "11px 0", borderRadius: 12, cursor: "pointer",
              border: `1px dashed ${C.dim}`, background: "transparent", color: C.sub,
              fontSize: 13, fontWeight: 600, fontFamily: "inherit",
            }}>＋ 新建组级项目</button>
          )}
        </div>
        <div className="adv-grid">
          {projects.length === 0 && <Empty text="全组还没有项目" />}
          {projects.map((p) => {
            const mine = records.filter((r) => r.projectId === p.id);
            const people = [...new Set(mine.map((r) => r.ownerId))];
            return (
              <button key={p.id} onClick={() => setFocus({ type: "project", id: p.id })} className="adv-card"
                style={{ textAlign: "left", cursor: "pointer", fontFamily: "inherit",
                  border: `1px solid ${C.line}`, borderRadius: 14, background: C.panel, padding: 13,
                  borderLeft: `3px solid ${projColor[p.id]}` }}>
                <div style={{ fontSize: 14, fontWeight: 700, lineHeight: 1.35 }}>{p.name}</div>
                {(!p.ownerId || p.ownerId === meId) && (
                  <div style={{ fontSize: 10.5, color: C.blue, fontWeight: 600, marginTop: 4 }}>
                    我建的 · {(p.members || []).length} 人在组
                  </div>
                )}
                <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 11,
                  paddingTop: 10, borderTop: `1px solid ${C.hair}` }}>
                  <div><div style={{ fontSize: 15, fontWeight: 700, fontFamily: MONO }}>{mine.length}</div>
                    <div style={{ fontSize: 10, color: C.sub }}>记录</div></div>
                  <div style={{ display: "flex", marginLeft: 2 }}>
                    {people.slice(0, 4).map((uid, i) => (
                      <span key={uid} style={{ marginLeft: i ? -8 : 0 }}>
                        <Avatar user={byId[uid]} size={24} ring />
                      </span>
                    ))}
                    {people.length > 4 && (
                      <span style={{ marginLeft: -8, width: 24, height: 24, borderRadius: "50%",
                        background: C.hair, color: C.sub, fontSize: 10, fontWeight: 700,
                        display: "flex", alignItems: "center", justifyContent: "center",
                        boxShadow: `0 0 0 2px ${C.bg}` }}>+{people.length - 4}</span>
                    )}
                  </div>
                  <div style={{ marginLeft: "auto", textAlign: "right" }}>
                    <div style={{ fontSize: 11.5, fontWeight: 600, color: C.sub }}>{fmtAgo(mine[0]?.at)}</div>
                    <div style={{ fontSize: 10, color: C.sub }}>最后更新</div>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
        </>
      )}
    </Shell>
  );
}

/* ── 布局外壳 ── */
function Shell({ title, subtitle, avatar, accent, onBack, onClose, children }) {
  return (
    <div className="app-shell" style={{
      fontFamily: "'Outfit','Noto Serif SC',sans-serif", background: C.bg, minHeight: "100vh",
      maxWidth: "var(--app-w)", margin: "0 auto", paddingBottom: 48, color: C.ink,
    }}>
      <div style={{ padding: "46px var(--app-pad) 14px", display: "flex", alignItems: "center", gap: 11,
        borderBottom: `1px solid ${C.line}`, marginBottom: 14 }}>
        <button onClick={onBack || onClose} className="hit" style={{
          border: "none", background: "none", cursor: "pointer", color: C.sub,
          fontSize: 22, padding: "0 4px 3px", lineHeight: 1, borderRadius: 8,
        }} title={onBack ? "返回" : "关闭"}>‹</button>
        {avatar && <Avatar user={avatar} size={34} />}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 19, fontWeight: 700, letterSpacing: "-0.2px",
            color: accent || C.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {title}
          </div>
          <div style={{ fontSize: 11.5, color: C.sub, marginTop: 2, fontFamily: MONO }}>{subtitle}</div>
        </div>
      </div>
      <div style={{ padding: "0 var(--app-pad)" }}>{children}</div>
    </div>
  );
}

function Panel({ title, children }) {
  return (
    <div style={{ border: `1px solid ${C.line}`, borderRadius: 14, background: C.panel,
      padding: 14, marginBottom: 12 }}>
      {title && (
        <div style={{ fontSize: 11, fontWeight: 700, color: C.sub, letterSpacing: "0.4px",
          textTransform: "uppercase", marginBottom: 9 }}>{title}</div>
      )}
      {children}
    </div>
  );
}

function Empty({ text }) {
  return <div style={{ textAlign: "center", padding: "36px 0", color: C.dim, fontSize: 13 }}>{text}</div>;
}
