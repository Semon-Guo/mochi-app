/* 日历。
 *
 * 这个 app 有两半：待办/专注计时是「今天要干什么」，实验记录是「今天干了
 * 什么」。它们各自有列表，但没有任何一处能同时回答「8 月 26 号那天到底
 * 发生了什么」。日历就是那一处——一张图上同时呈现：
 *
 *   背景深浅 = 那天专注了多久      圆点 = 那天记了几条实验记录（按项目着色）
 *   顶部色条 = 重点节点            右上角小三角 = 有待办到期
 *
 * 三种编码互不打架，扫一眼就能看出「哪几天在推进、哪几天空着、哪天有硬期限」。
 */
import { useState, useMemo, useRef, useEffect } from "react";
import { toBJ, bjNow, dayKeyOf, p2 } from "./time.js";

const C = {
  ink: "#2C2C2C", sub: "#8C8478", dim: "#B0A99B", line: "#EDE8DE", hair: "#F4F0E7",
  panel: "#FFFDF9", bg: "#FDFBF7", edge: "#E8E4DA",
};
const MONO = "'JetBrains Mono','SF Mono','Menlo',monospace";
const WD = ["一", "二", "三", "四", "五", "六", "日"];

/** 重点节点的类型。颜色是唯一的区分手段，所以要一眼分得开，别都挤在暖色区。 */
export const MS_KINDS = [
  { key: "deadline", label: "截止", color: "#C02556", icon: "⏳" },
  { key: "meeting", label: "会议", color: "#5B7FC7", icon: "🗣" },
  { key: "milestone", label: "节点", color: "#5A9E4B", icon: "🚩" },
  { key: "other", label: "其他", color: "#C08A1E", icon: "◆" },
];
const kindOf = (k) => MS_KINDS.find((x) => x.key === k) || MS_KINDS[2];

const fmtHM = (sec) => {
  const m = Math.round((sec || 0) / 60);
  if (!m) return "";
  return m >= 60 ? `${Math.floor(m / 60)} 小时${m % 60 ? ` ${m % 60} 分` : ""}` : `${m} 分钟`;
};
const dayTitle = (d) =>
  `${d.getMonth() + 1}月${d.getDate()}日 周${WD[(d.getDay() + 6) % 7]}`;

/* ── 一天的所有事 ── */
function useByDay({ records = [], todos = [], milestones = [] }) {
  return useMemo(() => {
    const m = new Map();
    const slot = (ts) => {
      const k = dayKeyOf(ts);
      let e = m.get(k);
      if (!e) m.set(k, (e = { records: [], miles: [], dones: [], reminds: [], focus: 0 }));
      return e;
    };
    for (const r of records) if (r.at) slot(r.at).records.push(r);
    for (const ms of milestones) if (ms.at) slot(ms.at).miles.push(ms);
    for (const t of todos) {
      if (t.done) {
        const at = t.doneTs || t.timeline?.find((e) => e.type === "complete")?.at;
        if (at) {
          const e = slot(at);
          e.dones.push(t);
          e.focus += t.actualDuration || 0;
        }
      } else if (t.remind?.at) {
        slot(t.remind.at).reminds.push(t);
      }
    }
    for (const e of m.values()) {
      e.records.sort((a, b) => (a.at || 0) - (b.at || 0));
      e.miles.sort((a, b) => (a.at || 0) - (b.at || 0));
    }
    return m;
  }, [records, todos, milestones]);
}

/* ── 编辑一个重点节点 ── */
function MilestoneSheet({ initial, day, projects, onSave, onDelete, onClose }) {
  const [title, setTitle] = useState(initial?.title || "");
  const [kind, setKind] = useState(initial?.kind || "milestone");
  const [projectId, setProjectId] = useState(initial?.projectId || "");
  const [note, setNote] = useState(initial?.note || "");
  const [date, setDate] = useState(() => {
    const d = toBJ(initial?.at || day || Date.now());
    return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  });
  const ref = useRef(null);
  useEffect(() => { ref.current?.focus(); }, []);

  const commit = () => {
    if (!title.trim()) return;
    const [y, mo, dd] = date.split("-").map(Number);
    // 归到当天中午：存 00:00 的话，时区偏一点就会掉到前一天去
    const at = new Date(y, mo - 1, dd, 12, 0, 0).getTime();
    onSave({ ...(initial || {}), title: title.trim(), kind, projectId, note: note.trim(), at });
    onClose();
  };

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, zIndex: 9998, background: "rgba(26,22,18,.42)",
      display: "flex", alignItems: "flex-end", justifyContent: "center",
      animation: "flashFade .18s ease both",
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        width: "100%", maxWidth: "var(--app-w)", background: C.bg, color: C.ink,
        borderRadius: "24px 24px 0 0", padding: "20px 22px 30px",
        animation: "sheetUp .26s cubic-bezier(.25,1,.5,1) both", boxSizing: "border-box",
      }}>
        <div style={{ width: 38, height: 4, borderRadius: 2, background: C.edge, margin: "0 auto 16px" }} />
        <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 14 }}>
          {initial ? "改重点节点" : `新的重点节点 · ${dayTitle(toBJ(day || Date.now()))}`}
        </div>

        <input ref={ref} value={title} onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") commit(); }}
          placeholder="比如：投稿截止 / 中期检查 / 组会汇报"
          style={{ width: "100%", padding: "12px 14px", borderRadius: 12, fontSize: 15,
            border: `2px solid ${C.edge}`, background: "#FFF", color: C.ink,
            fontFamily: "inherit", outline: "none", boxSizing: "border-box" }} />

        <div style={{ display: "flex", gap: 7, marginTop: 12, flexWrap: "wrap" }}>
          {MS_KINDS.map((k) => (
            <button key={k.key} onClick={() => setKind(k.key)} style={{
              display: "inline-flex", alignItems: "center", gap: 5, padding: "7px 13px",
              borderRadius: 999, cursor: "pointer", fontFamily: "inherit",
              fontSize: 13, fontWeight: 600,
              border: `1.5px solid ${kind === k.key ? k.color : C.edge}`,
              background: kind === k.key ? k.color : "#FFF",
              color: kind === k.key ? "#FFF" : C.sub,
            }}>{k.icon} {k.label}</button>
          ))}
        </div>

        <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
          <label style={{ flex: 1, fontSize: 11.5, color: C.sub }}>日期
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
              style={{ width: "100%", padding: "10px 12px", borderRadius: 11, fontSize: 14,
                border: `2px solid ${C.edge}`, background: "#FFF", color: C.ink,
                fontFamily: "inherit", outline: "none", boxSizing: "border-box", marginTop: 5 }} />
          </label>
          {projects.length > 0 && (
            <label style={{ flex: 1, fontSize: 11.5, color: C.sub }}>关联项目
              <select value={projectId} onChange={(e) => setProjectId(e.target.value)}
                style={{ width: "100%", padding: "10px 12px", borderRadius: 11, fontSize: 14,
                  border: `2px solid ${C.edge}`, background: "#FFF", color: C.ink,
                  fontFamily: "inherit", outline: "none", boxSizing: "border-box", marginTop: 5 }}>
                <option value="">不关联</option>
                {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
          )}
        </div>

        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2}
          placeholder="备注（可留空）"
          style={{ width: "100%", padding: "10px 12px", borderRadius: 11, fontSize: 13.5,
            border: `2px solid ${C.edge}`, background: "#FFF", color: C.ink, marginTop: 12,
            fontFamily: "inherit", outline: "none", resize: "vertical", boxSizing: "border-box" }} />

        <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
          {initial && (
            <button onClick={() => { onDelete(initial); onClose(); }} style={{
              padding: "13px 18px", borderRadius: 14, border: `2px solid ${C.edge}`,
              background: "#FFF", color: "#C02556", fontSize: 14, fontWeight: 600,
              cursor: "pointer", fontFamily: "inherit" }}>删除</button>
          )}
          <button onClick={onClose} style={{
            flex: 1, padding: "13px 0", borderRadius: 14, border: `2px solid ${C.edge}`,
            background: "#FFF", color: C.sub, fontSize: 15, fontWeight: 600,
            cursor: "pointer", fontFamily: "inherit" }}>取消</button>
          <button onClick={commit} style={{
            flex: 1.3, padding: "13px 0", borderRadius: 14, border: "none", background: C.ink,
            color: "#FFF", fontSize: 15, fontWeight: 600, cursor: "pointer",
            fontFamily: "inherit", opacity: title.trim() ? 1 : .4 }}>保存</button>
        </div>
      </div>
    </div>
  );
}

/* ── 月视图 ── */
export function Calendar({ records = [], todos = [], projects = [], milestones = [],
                           onSaveMilestone, onDeleteMilestone, onOpenProject, canEdit = false }) {
  const [mode, setMode] = useState("month");        // month | week
  const [cursor, setCursor] = useState(() => { const d = bjNow(); return { y: d.getFullYear(), m: d.getMonth() }; });
  const [picked, setPicked] = useState(() => dayKeyOf(Date.now()));
  const [editing, setEditing] = useState(null);     // {ms} | {day} | null
  const [showAll, setShowAll] = useState(false);

  const byDay = useByDay({ records, todos, milestones });
  const projColor = useMemo(() => {
    const m = {};
    projects.forEach((p, i) => { m[p.id] = typeof p.color === "string" ? p.color : (p.color?.accent || "#8C8478"); });
    return m;
  }, [projects]);

  // 从当月 1 号往前退到那一周的周一，铺满 6 行
  const cells = useMemo(() => {
    const first = new Date(cursor.y, cursor.m, 1);
    const back = (first.getDay() + 6) % 7;
    const start = new Date(cursor.y, cursor.m, 1 - back);
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i, 12);
      return { d, key: d.toDateString(), inMonth: d.getMonth() === cursor.m };
    });
  }, [cursor]);

  const todayKey = dayKeyOf(Date.now());
  const maxFocus = useMemo(() => Math.max(1,
    ...cells.map((c) => byDay.get(c.key)?.focus || 0)), [cells, byDay]);

  const sel = byDay.get(picked) || { records: [], miles: [], dones: [], reminds: [], focus: 0 };
  const selDate = useMemo(() => new Date(picked), [picked]);

  // 「接下来」而不是「本月」——投稿截止不认月份边界，翻在 8 月却看不见
  // 9 月 4 号那个截止，这列表就白做了。过去的节点在格子和当天面板里还看得到。
  const upcoming = useMemo(() => {
    const today = new Date().setHours(0, 0, 0, 0);
    return milestones
      .filter((ms) => new Date(ms.at || 0).setHours(0, 0, 0, 0) >= today)
      .sort((a, b) => (a.at || 0) - (b.at || 0))
      .slice(0, 12);
  }, [milestones]);

  // 周模式下这一周的七天，从周一起
  const weekDays = useMemo(() => {
    const b = new Date(picked);
    const mon = new Date(b.getFullYear(), b.getMonth(), b.getDate() - ((b.getDay() + 6) % 7), 12);
    return Array.from({ length: 7 }, (_, i) =>
      new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + i, 12));
  }, [picked]);

  const step = (n) => {
    if (mode === "week") {
      const b = new Date(picked);
      const nd = new Date(b.getFullYear(), b.getMonth(), b.getDate() + n * 7, 12);
      setPicked(nd.toDateString());
      setCursor({ y: nd.getFullYear(), m: nd.getMonth() });
      return;
    }
    setCursor((c) => {
      const d = new Date(c.y, c.m + n, 1);
      return { y: d.getFullYear(), m: d.getMonth() };
    });
  };
  const jumpTo = (ts) => {
    const d = toBJ(ts);
    setCursor({ y: d.getFullYear(), m: d.getMonth() });
    setPicked(dayKeyOf(ts));
    setMode("month");
  };
  const goToday = () => {
    const d = bjNow();
    setCursor({ y: d.getFullYear(), m: d.getMonth() });
    setPicked(dayKeyOf(Date.now()));
  };

  const navBtn = {
    border: "none", background: "none", cursor: "pointer", color: C.sub,
    fontSize: 20, padding: "2px 10px", lineHeight: 1, borderRadius: 8, fontFamily: "inherit",
  };

  return (
    <div>
      {/* 重点节点卡片放在最上面：打开日历第一眼要回答的是「接下来有什么、还剩几天」，
          而不是「这个月的格子长什么样」。倒计时用大号数字，扫一眼就有轻重缓急。 */}
      {upcoming.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          {(showAll ? upcoming : upcoming.slice(0, 3)).map((ms) => {
            const k = kindOf(ms.kind);
            const d = toBJ(ms.at);
            const days = Math.round((new Date(ms.at).setHours(0, 0, 0, 0)
              - new Date().setHours(0, 0, 0, 0)) / 86400000);
            const urg = days <= 1 ? "#C02556" : days <= 3 ? "#D06024" : days <= 7 ? "#B07C14" : C.ink;
            const p = projects.find((x) => x.id === ms.projectId);
            const sub = [p?.name, ms.note].filter(Boolean).join(" · ");
            return (
              <button key={ms.id}
                onClick={() => (canEdit ? setEditing({ ms }) : jumpTo(ms.at))}
                title={canEdit ? "点一下编辑" : "点一下跳到那天"}
                style={{
                  width: "100%", display: "flex", alignItems: "center", gap: 12,
                  padding: "13px 15px", marginBottom: 8, borderRadius: 16,
                  border: `1px solid ${C.line}`, borderLeft: `4px solid ${k.color}`,
                  background: "#FFF", cursor: "pointer", fontFamily: "inherit",
                  textAlign: "left", boxShadow: "0 1px 3px rgba(120,100,70,.05)",
                }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                    <span style={{ fontSize: 10, fontWeight: 700, color: k.color,
                      background: `color-mix(in srgb, ${k.color} 11%, transparent)`,
                      padding: "2px 7px", borderRadius: 5 }}>{k.icon} {k.label}</span>
                    <span style={{ fontSize: 10.5, color: C.dim, fontFamily: MONO }}>
                      {dayTitle(d)}
                    </span>
                  </div>
                  <div style={{ fontSize: 15.5, fontWeight: 700, lineHeight: 1.3, color: C.ink,
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {ms.title}
                  </div>
                  {sub && (
                    <div style={{ fontSize: 11, color: C.sub, marginTop: 3, lineHeight: 1.5,
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sub}</div>
                  )}
                </div>
                {days === 0 ? (
                  <span style={{ flexShrink: 0, fontSize: 13, fontWeight: 800, color: "#FFF",
                    background: "#C02556", padding: "7px 12px", borderRadius: 999 }}>就是今天</span>
                ) : (
                  <div style={{ textAlign: "center", flexShrink: 0, minWidth: 44 }}>
                    <div style={{ fontSize: 9.5, color: C.dim, letterSpacing: "1.5px" }}>还有</div>
                    <div style={{ fontSize: 27, fontWeight: 800, fontFamily: MONO,
                      lineHeight: 1.05, color: urg, letterSpacing: "-1px" }}>{days}</div>
                    <div style={{ fontSize: 9.5, color: C.dim }}>天</div>
                  </div>
                )}
              </button>
            );
          })}
          {upcoming.length > 3 && (
            <button onClick={() => setShowAll((v) => !v)} style={{
              width: "100%", padding: "7px 0", borderRadius: 10, cursor: "pointer",
              border: "none", background: "transparent", color: C.dim,
              fontSize: 12, fontWeight: 600, fontFamily: "inherit",
            }}>{showAll ? "收起" : `还有 ${upcoming.length - 3} 个重点 ▾`}</button>
          )}
        </div>
      )}

      {/* 顶栏：月份 + 今天 + 月/周切换 */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 12 }}>
        <button onClick={() => step(-1)} style={navBtn} title="上一页">‹</button>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: mode === "week" ? 15 : 18, fontWeight: 700, letterSpacing: "-0.3px" }}>
            {mode === "week"
              ? `${weekDays[0].getMonth() + 1}/${weekDays[0].getDate()} — ${weekDays[6].getMonth() + 1}/${weekDays[6].getDate()}`
              : `${cursor.m + 1} 月`}
          </div>
          <div style={{ fontSize: 10.5, color: C.dim, fontFamily: MONO }}>{cursor.y}</div>
        </div>
        <button onClick={() => step(1)} style={navBtn} title="下一页">›</button>
        <button onClick={goToday} style={{
          marginLeft: "auto", padding: "6px 12px", borderRadius: 999, cursor: "pointer",
          border: `1px solid ${C.edge}`, background: "#FFF", color: C.sub,
          fontSize: 12, fontWeight: 600, fontFamily: "inherit",
        }}>今天</button>
        <div style={{ display: "flex", background: "#F0EDE6", borderRadius: 999, padding: 2 }}>
          {[["month", "月"], ["week", "周"]].map(([k, label]) => (
            <button key={k} onClick={() => setMode(k)} style={{
              padding: "5px 13px", borderRadius: 999, cursor: "pointer", fontFamily: "inherit",
              fontSize: 12.5, fontWeight: 700, border: "none",
              background: mode === k ? C.ink : "transparent", color: mode === k ? "#FFF" : C.sub,
            }}>{label}</button>
          ))}
        </div>
      </div>

      {mode === "week" ? (
        /* 一周日程。这里不重复「完成记录」里那张按小时铺的计时网格——
           那张回答的是「几点在干活」，而站在日历里想知道的是「这一周有什么」，
           而且 7 列小时网格在 430px 上必须横向滚动，周六日直接被切掉。 */
        <div>
          {weekDays.map((d) => {
            const key = d.toDateString();
            const e = byDay.get(key) || { records: [], miles: [], dones: [], reminds: [], focus: 0 };
            const isToday = key === todayKey;
            const empty = !e.records.length && !e.miles.length && !e.focus
              && !e.dones.length && !e.reminds.length;
            return (
              <div key={key} style={{
                display: "flex", gap: 11, padding: "11px 0",
                borderTop: `1px solid ${C.hair}`, opacity: empty ? .5 : 1,
              }}>
                <button onClick={() => { setPicked(key); setMode("month"); }} style={{
                  width: 42, flexShrink: 0, border: "none", background: "none", padding: 0,
                  cursor: "pointer", fontFamily: "inherit", textAlign: "center",
                }}>
                  <div style={{ fontSize: 10.5, color: d.getDay() % 6 === 0 ? "#C0562B" : C.dim,
                    fontWeight: 700 }}>周{WD[(d.getDay() + 6) % 7]}</div>
                  <div style={{ fontSize: 15, fontWeight: 700, fontFamily: MONO,
                    width: 26, height: 26, lineHeight: "26px", borderRadius: "50%", margin: "2px auto 0",
                    background: isToday ? C.ink : "transparent", color: isToday ? "#FFF" : C.ink,
                  }}>{d.getDate()}</div>
                </button>
                <div style={{ flex: 1, minWidth: 0 }}>
                  {e.miles.map((ms) => {
                    const k = kindOf(ms.kind);
                    return (
                      <button key={ms.id} onClick={canEdit ? () => setEditing({ ms }) : undefined}
                        style={{
                        display: "flex", alignItems: "center", gap: 6, width: "100%",
                        padding: "5px 9px", marginBottom: 5, borderRadius: 8,
                        cursor: canEdit ? "pointer" : "default",
                        border: `1px solid ${C.line}`, borderLeft: `3px solid ${k.color}`,
                        background: "#FFF", fontFamily: "inherit", textAlign: "left",
                      }}>
                        <span style={{ fontSize: 11 }}>{k.icon}</span>
                        <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 700,
                          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {ms.title}
                        </span>
                      </button>
                    );
                  })}
                  {e.records.map((r) => (
                    <button key={r.id} onClick={() => onOpenProject?.(r.projectId)} style={{
                      display: "flex", alignItems: "baseline", gap: 7, width: "100%", padding: "3px 0",
                      border: "none", background: "none", cursor: "pointer",
                      fontFamily: "inherit", textAlign: "left",
                    }}>
                      <span style={{ fontSize: 10, color: C.dim, fontFamily: MONO, flexShrink: 0 }}>
                        {p2(toBJ(r.at).getHours())}:{p2(toBJ(r.at).getMinutes())}
                      </span>
                      <span style={{ width: 4.5, height: 4.5, borderRadius: "50%", flexShrink: 0,
                        background: projColor[r.projectId] || C.sub }} />
                      <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: C.ink,
                        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {r.text || "（无正文）"}
                      </span>
                    </button>
                  ))}
                  {(e.focus > 0 || e.dones.length > 0 || e.reminds.length > 0) && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 5 }}>
                      {e.focus > 0 && (
                        <span style={{ fontSize: 10.5, color: "#3F7A33", background: "#EEF6EA",
                          padding: "2px 8px", borderRadius: 999, fontWeight: 600 }}>
                          专注 {fmtHM(e.focus)}
                        </span>
                      )}
                      {e.dones.length > 0 && (
                        <span style={{ fontSize: 10.5, color: C.sub, background: C.hair,
                          padding: "2px 8px", borderRadius: 999, fontWeight: 600 }}>
                          完成 {e.dones.length} 项
                        </span>
                      )}
                      {e.reminds.map((t) => (
                        <span key={t.id} style={{ fontSize: 10.5, color: "#8A6410", background: "#FFF6E5",
                          padding: "2px 8px", borderRadius: 999, fontWeight: 600 }}>⏰ {t.text}</span>
                      ))}
                    </div>
                  )}
                  {empty && <div style={{ fontSize: 12, color: C.dim, paddingTop: 4 }}>—</div>}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 3 }}>
            {WD.map((w, i) => (
              <div key={w} style={{ textAlign: "center", fontSize: 10.5, fontWeight: 700,
                color: i >= 5 ? "#C0562B" : C.dim, padding: "2px 0 6px" }}>{w}</div>
            ))}
            {cells.map(({ d, key, inMonth }) => {
              const e = byDay.get(key);
              const isToday = key === todayKey;
              const isPicked = key === picked;
              // 专注时长做成背景深浅：连续量用面积表达，比再加一排点更安静
              const heat = e?.focus ? 0.06 + 0.34 * Math.min(1, e.focus / maxFocus) : 0;
              return (
                <button key={key} onClick={() => setPicked(key)} style={{
                  position: "relative", aspectRatio: "1 / 1.05", padding: "7px 3px 4px",
                  display: "flex", flexDirection: "column", alignItems: "center", gap: 3,
                  overflow: "hidden",
                  cursor: "pointer", fontFamily: "inherit", borderRadius: 9,
                  border: isPicked ? `1.5px solid ${C.ink}` : "1.5px solid transparent",
                  background: heat ? `rgba(90,158,75,${heat})` : (inMonth ? "#FFF" : "transparent"),
                  opacity: inMonth ? 1 : .38,
                  // 非本月的格子也要有身体：不然那天若有重点节点，色条会浮在空中
                  boxShadow: heat ? undefined : `inset 0 0 0 1px ${C.hair}`,
                }}>
                  {/* 重点节点：贴着格子顶边的一道色条，最多两段。
                      留缝的话它看着像挂在上一行的格子底下。 */}
                  {e?.miles?.length > 0 && (
                    <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3.5,
                      display: "flex", gap: 1, borderRadius: "8px 8px 0 0", overflow: "hidden" }}>
                      {e.miles.slice(0, 2).map((ms) => (
                        <div key={ms.id} style={{ flex: 1, background: kindOf(ms.kind).color }} />
                      ))}
                    </div>
                  )}
                  <div style={{
                    fontSize: 12.5, fontWeight: isToday ? 700 : 600, fontFamily: MONO,
                    width: 21, height: 21, lineHeight: "21px", borderRadius: "50%",
                    background: isToday ? C.ink : "transparent",
                    color: isToday ? "#FFF" : (inMonth ? C.ink : C.dim),
                  }}>{d.getDate()}</div>
                  {/* 实验记录：一天一个点，最多四个 */}
                  <div style={{ display: "flex", gap: 2, minHeight: 5, alignItems: "center" }}>
                    {(e?.records || []).slice(0, 4).map((r) => (
                      <span key={r.id} style={{ width: 4.5, height: 4.5, borderRadius: "50%",
                        background: projColor[r.projectId] || C.sub }} />
                    ))}
                    {(e?.records?.length || 0) > 4 && (
                      <span style={{ fontSize: 8, color: C.sub, fontFamily: MONO }}>
                        +{e.records.length - 4}
                      </span>
                    )}
                  </div>
                  {/* 有待办到期：右上角一点红 */}
                  {e?.reminds?.length > 0 && (
                    <span style={{ position: "absolute", top: 4, right: 4, width: 5, height: 5,
                      borderRadius: "50%", background: "#E8A838" }} />
                  )}
                </button>
              );
            })}
          </div>

          {/* 选中那天 */}
          <div style={{ marginTop: 14, border: `1px solid ${C.line}`, borderRadius: 14,
            background: C.panel, padding: "13px 14px" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 10 }}>
              <span style={{ fontSize: 15, fontWeight: 700 }}>{dayTitle(selDate)}</span>
              {picked === todayKey && (
                <span style={{ fontSize: 10.5, fontWeight: 700, color: "#5A9E4B" }}>今天</span>
              )}
              {canEdit && (
                <button onClick={() => setEditing({ day: selDate.getTime() })} style={{
                  marginLeft: "auto", padding: "5px 11px", borderRadius: 999, cursor: "pointer",
                  border: `1px dashed ${C.dim}`, background: "transparent", color: C.sub,
                  fontSize: 11.5, fontWeight: 600, fontFamily: "inherit",
                }}>＋ 重点节点</button>
              )}
            </div>

            {sel.miles.map((ms) => {
              const k = kindOf(ms.kind);
              const p = projects.find((x) => x.id === ms.projectId);
              return (
                <button key={ms.id} onClick={canEdit ? () => setEditing({ ms }) : undefined}
                  style={{
                  width: "100%", display: "flex", alignItems: "flex-start", gap: 9,
                  padding: "9px 10px", marginBottom: 7, borderRadius: 10,
                  cursor: canEdit ? "pointer" : "default",
                  border: `1px solid ${C.line}`, borderLeft: `3px solid ${k.color}`,
                  background: "#FFF", fontFamily: "inherit", textAlign: "left",
                }}>
                  <span style={{ fontSize: 13 }}>{k.icon}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 700, color: C.ink }}>{ms.title}</div>
                    {(ms.note || p) && (
                      <div style={{ fontSize: 11, color: C.sub, marginTop: 2, lineHeight: 1.5 }}>
                        {p ? `${p.name}${ms.note ? " · " : ""}` : ""}{ms.note}
                      </div>
                    )}
                  </div>
                  <span style={{ fontSize: 10.5, color: k.color, fontWeight: 700, flexShrink: 0 }}>
                    {k.label}
                  </span>
                </button>
              );
            })}

            {sel.records.length > 0 && (
              <div style={{ marginTop: sel.miles.length ? 4 : 0 }}>
                {sel.records.map((r) => {
                  const p = projects.find((x) => x.id === r.projectId);
                  return (
                    <button key={r.id} onClick={() => onOpenProject?.(r.projectId)} style={{
                      width: "100%", display: "flex", alignItems: "baseline", gap: 8,
                      padding: "7px 0", border: "none", borderTop: `1px solid ${C.hair}`,
                      background: "none", cursor: "pointer", fontFamily: "inherit", textAlign: "left",
                    }}>
                      <span style={{ fontSize: 10.5, color: C.dim, fontFamily: MONO, flexShrink: 0 }}>
                        {p2(toBJ(r.at).getHours())}:{p2(toBJ(r.at).getMinutes())}
                      </span>
                      <span style={{ width: 5, height: 5, borderRadius: "50%", flexShrink: 0,
                        background: projColor[r.projectId] || C.sub, transform: "translateY(-1px)" }} />
                      <span style={{ flex: 1, minWidth: 0, fontSize: 13, color: C.ink,
                        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {r.text || "（无正文）"}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}

            {(sel.focus > 0 || sel.dones.length > 0 || sel.reminds.length > 0) && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 9,
                paddingTop: 9, borderTop: `1px solid ${C.hair}` }}>
                {sel.focus > 0 && (
                  <span style={{ fontSize: 11, color: "#3F7A33", background: "#EEF6EA",
                    padding: "3px 9px", borderRadius: 999, fontWeight: 600 }}>
                    专注 {fmtHM(sel.focus)}
                  </span>
                )}
                {sel.dones.length > 0 && (
                  <span style={{ fontSize: 11, color: C.sub, background: C.hair,
                    padding: "3px 9px", borderRadius: 999, fontWeight: 600 }}>
                    完成 {sel.dones.length} 项
                  </span>
                )}
                {sel.reminds.map((t) => (
                  <span key={t.id} style={{ fontSize: 11, color: "#8A6410", background: "#FFF6E5",
                    padding: "3px 9px", borderRadius: 999, fontWeight: 600 }}>
                    ⏰ {t.text}
                  </span>
                ))}
              </div>
            )}

            {!sel.miles.length && !sel.records.length && !sel.focus && !sel.dones.length
              && !sel.reminds.length && (
              <div style={{ fontSize: 12.5, color: C.dim, padding: "6px 0 2px" }}>这天没有记录</div>
            )}
          </div>

          {/* 本月的重点节点，不用一天天点过去找 */}
        </>
      )}

      {editing && (
        <MilestoneSheet initial={editing.ms} day={editing.day} projects={projects}
          onSave={onSaveMilestone} onDelete={onDeleteMilestone}
          onClose={() => setEditing(null)} />
      )}
    </div>
  );
}
