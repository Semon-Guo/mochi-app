import { useState, useEffect, useMemo, useRef } from "react";
import * as Sync from "./sync.js";
import { avatarFallback } from "./avatar.js";
import { downloadFile, fmtBytes } from "./files.js";
import { AdminPanel } from "./AdminPanel.jsx";

/* 导师端：按学生或按项目看全组进展。
 *
 * 视觉上走「实验记录本」的路子——数字一律等宽字体，横平竖直的细线分栏，
 * 少装饰多信息。导师是来看进展的，不是来看动效的。
 *
 * 只读：服务端不接受导师改学生的记录，这里也不提供任何编辑入口。
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

/* ── 一条记录 ── */
function RecordRow({ r, author, projectName, projectColor, onPhoto, showAuthor = true }) {
  return (
    <div style={{ display: "flex", gap: 10, padding: "11px 0", borderTop: `1px solid ${C.hair}` }}>
      <div style={{ width: 42, flexShrink: 0, textAlign: "right", paddingTop: 1 }}>
        <div style={{ fontSize: 12, fontFamily: MONO, color: C.sub, fontWeight: 600 }}>{fmtDate(r.at)}</div>
        <div style={{ fontSize: 9.5, color: C.dim, fontFamily: MONO }}>
          {new Date(r.at || 0).getFullYear()}
        </div>
      </div>
      <div style={{ width: 1, background: C.line, flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 3 }}>
          {showAuthor && author && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              <Avatar user={author} size={16} />
              <span style={{ fontSize: 11, fontWeight: 600, color: C.ink }}>{author.displayName}</span>
            </span>
          )}
          {projectName && (
            <span style={{ fontSize: 10, color: projectColor || C.sub, fontWeight: 600,
              background: `color-mix(in srgb, ${projectColor || C.sub} 12%, transparent)`,
              padding: "1.5px 7px", borderRadius: 4 }}>{projectName}</span>
          )}
          {r.weather && <span style={{ fontSize: 10.5, color: C.dim }}>{r.weather}</span>}
        </div>
        <div style={{ fontSize: 13.5, lineHeight: 1.65, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
          {r.text || <span style={{ color: C.dim }}>（无正文）</span>}
        </div>
        {r.photos?.length > 0 && (
          <button onClick={() => onPhoto?.(r.photos)} style={{
            marginTop: 5, border: "none", background: "none", padding: 0, cursor: "pointer",
            fontSize: 10.5, color: C.blue, fontFamily: "inherit",
          }}>📷 {r.photos.length} 张照片</button>
        )}
        {r.files?.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap" }}>
            {r.files.map((f) => <FileLink key={f.id} f={f} />)}
          </div>
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
export function AdvisorView({ data, onClose, onPhoto }) {
  const auth = Sync.getAuth();
  const [tab, setTab] = useState("people");     // people | projects
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

  const weekAgo = Date.now() - 7 * DAY;
  const thisWeek = records.filter((r) => (r.at || 0) >= weekAgo).length;
  const activeThisWeek = new Set(records.filter((r) => (r.at || 0) >= weekAgo).map((r) => r.ownerId)).size;
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
            <RecordRow key={r.id} r={r} showAuthor={false} onPhoto={onPhoto}
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
        {people.length > 0 && (
          <Panel title="参与成员">
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
            <RecordRow key={r.id} r={r} author={byId[r.ownerId]} onPhoto={onPhoto} />
          ))}
        </Panel>
      </Shell>
    );
  }

  /* ── 总览 ── */
  return (
    <Shell onClose={onClose} title="课题组进展"
      subtitle={`${students.length} 名成员${archived.length ? ` · ${archived.length} 人已离组` : ""}` +
        ` · 只读视图${Sync.isAdmin(auth?.user) ? " · 管理员" : ""}`}>
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
        <div style={{ display: "flex", gap: 4, marginBottom: 14 }}>
          <Stat label="本周记录" value={thisWeek} accent={thisWeek ? C.green : C.dim} />
          <Stat label="本周活跃" value={`${activeThisWeek}/${students.length}`} hint="有记录的成员" />
          <Stat label="项目" value={projects.length} />
          <Stat label="累计记录" value={records.length} />
        </div>
        <Heatmap records={records} />
      </Panel>

      <div style={{ display: "flex", gap: 6, padding: "0 0 10px" }}>
        {[["people", "按成员"], ["projects", "按项目"],
          ...(Sync.isAdmin(auth?.user) ? [["admin", "管理"]] : [])].map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)} style={{
            padding: "8px 16px", borderRadius: 10, cursor: "pointer", fontFamily: "inherit",
            fontSize: 13, fontWeight: 600,
            border: tab === k ? `1px solid ${C.ink}` : `1px solid ${C.line}`,
            background: tab === k ? C.ink : "#FFF", color: tab === k ? "#FFF" : C.sub,
          }}>{label}</button>
        ))}
      </div>

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
