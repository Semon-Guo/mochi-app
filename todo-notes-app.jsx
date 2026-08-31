import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import * as Sync from "./src/sync.js";
import { SyncBar } from "./src/SyncUI.jsx";
import { AdvisorView } from "./src/AdvisorView.jsx";
import { putPhoto, delPhoto } from "./src/photos.js";
import { Photo, FullPhoto } from "./src/PhotoView.jsx";
import { uploadFile, dropFile, downloadFile, fmtBytes } from "./src/files.js";
import { Thread, indexComments, threadOf, LIKE, REPLY } from "./src/Comments.jsx";
import { NC, uid, migrateLab } from "./src/migrate.js";

// 构建标识：排查「是不是还在用缓存的旧版本」时直接看界面，不用猜
const BUILD = typeof __BUILD__ !== "undefined" ? __BUILD__ : "dev";

const SK = "mochi_v3";
const TIMER_SK = "mochi_timer";     // legacy single-session key, migrated on first read
const TIMERS_SK = "mochi_timers";   // { [todoId]: { startTs, baseElapsed } } — several at once
const BG_TS_SK = "mochi_bg_ts";
const BG_LIMIT_SEC = 5 * 60;

// Timer sessions live in a map so any number of tasks can run in parallel.
function readSessions() {
  try { const r = localStorage.getItem(TIMERS_SK); if (r) return JSON.parse(r) || {}; } catch {}
  return {};
}
function writeSessions(map) { try { localStorage.setItem(TIMERS_SK, JSON.stringify(map)); } catch {} }
function loadTimerSessions() {
  const map = readSessions();
  try {
    const legacy = localStorage.getItem(TIMER_SK);
    if (legacy) {
      const { todoId, startTs, baseElapsed } = JSON.parse(legacy);
      if (todoId && startTs) map[todoId] = { startTs, baseElapsed: baseElapsed || 0 };
      localStorage.removeItem(TIMER_SK);
      writeSessions(map);
    }
  } catch {}
  return map;
}
function getTimerSession(todoId) { const s = readSessions()[todoId]; return s && s.startTs ? s : null; }
function sessionElapsed(s) { return s ? (s.baseElapsed || 0) + Math.max(0, Math.floor((Date.now() - s.startTs) / 1000)) : 0; }
function saveTimerSession(todoId, startTs, baseElapsed) {
  const map = loadTimerSessions();
  map[todoId] = { startTs, baseElapsed: baseElapsed || 0 };
  writeSessions(map);
  try { localStorage.removeItem(BG_TS_SK); } catch {}   // user is clearly here
}
function clearTimerSession(...todoIds) {
  const map = loadTimerSessions();
  todoIds.forEach(id => { delete map[id]; });
  writeSessions(map);
  if (!Object.keys(map).length) { try { localStorage.removeItem(BG_TS_SK); } catch {} }
}
function loadAll() {
  let data = { todos: [], notes: [], projects: [], records: [], comments: [] };
  try { const r = localStorage.getItem(SK); if (r) data = JSON.parse(r); } catch {}
  const keptSync = data._sync || null;
  data = migrateLab({
    todos: (data.todos || []).map(migrateTodo),
    // 散记功能已下线，但数据原样留着——删掉界面不该顺手把人写过的东西烧了
    notes: data.notes || [],
    projects: data.projects || [],
    experiments: data.experiments || [],
    records: data.records || [],
    comments: data.comments || [],
  });
  if (keptSync) data._sync = keptSync;
  // Every live session keeps counting while the app is closed — fold the time back in,
  // and drop sessions whose task is gone or already finished.
  const sessions = loadTimerSessions();
  const alive = new Set(data.todos.filter(t => !t.done).map(t => t.id));
  const stale = Object.keys(sessions).filter(id => !alive.has(id));
  if (stale.length) { stale.forEach(id => { delete sessions[id]; }); writeSessions(sessions); }
  const activeTodoIds = Object.keys(sessions);
  if (activeTodoIds.length) {
    data = { ...data, todos: data.todos.map(t =>
      sessions[t.id] ? { ...t, elapsed: sessionElapsed(sessions[t.id]) } : t) };
  }
  return { data, activeTodoIds };
}
let saveFailed = null;   // 写失败要能被看见，不能静默吞掉
function save(d) {
  try { localStorage.setItem(SK, JSON.stringify(d)); saveFailed = null; }
  catch (e) { saveFailed = e?.name === "QuotaExceededError" ? "存储写满了，这次改动没保存" : "保存失败"; }
}

// Beijing time helpers
function bjNow() { return new Date(Date.now() + (8 * 3600000) + (new Date().getTimezoneOffset() * 60000)); }
function toBJ(ts) { return new Date(ts + (8 * 3600000) + (new Date().getTimezoneOffset() * 60000)); }
function fmtBJ(ts) { const d = toBJ(ts); return `${d.getHours().toString().padStart(2,"0")}:${d.getMinutes().toString().padStart(2,"0")}`; }
function fmtBJFull(ts) { const d = toBJ(ts); return `${d.getMonth()+1}/${d.getDate()} ${d.getHours().toString().padStart(2,"0")}:${d.getMinutes().toString().padStart(2,"0")}:${d.getSeconds().toString().padStart(2,"0")}`; }
function fmtDay(ts) { const d = toBJ(ts); const t = bjNow(); const y = new Date(t); y.setDate(y.getDate()-1); if (d.toDateString()===t.toDateString()) return "今天"; if (d.toDateString()===y.toDateString()) return "昨天"; return `${d.getMonth()+1}月${d.getDate()}日`; }
function fmtSec(s) { if (s == null) return "00:00"; const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),sec=s%60; if(h>0) return `${h}:${m.toString().padStart(2,"0")}:${sec.toString().padStart(2,"0")}`; return `${m.toString().padStart(2,"0")}:${sec.toString().padStart(2,"0")}`; }
function fmtMin(m) { if(!m) return "30m"; if(m>=60) return `${Math.floor(m/60)}h${m%60>0?(m%60+"m"):""}`; return `${m}m`; }

// Timestamp whose Beijing wall clock reads h:mm, dayOffset days from today
function bjTimeToTs(h, m, dayOffset = 0) {
  const b = bjNow();
  b.setDate(b.getDate() + dayOffset);
  b.setHours(h, m, 0, 0);
  return b.getTime() - (8 * 3600000) - (new Date().getTimezoneOffset() * 60000);
}
function fmtRemind(ts) {
  const d = toBJ(ts), n = bjNow();
  const hm = `${d.getHours().toString().padStart(2,"0")}:${d.getMinutes().toString().padStart(2,"0")}`;
  if (d.toDateString() === n.toDateString()) return hm;
  const tm = new Date(n); tm.setDate(tm.getDate() + 1);
  if (d.toDateString() === tm.toDateString()) return `明天 ${hm}`;
  return `${d.getMonth()+1}/${d.getDate()} ${hm}`;
}
function hexA(hex, a) {
  const h = hex.replace("#","");
  const n = parseInt(h.length === 3 ? h.split("").map(c=>c+c).join("") : h, 16);
  return `rgba(${(n>>16)&255},${(n>>8)&255},${n&255},${a})`;
}

const WDAYS = ["周一","周二","周三","周四","周五","周六","周日"];
const HOURS = Array.from({length:17},(_,i)=>i+9); // 9:00~25:00 (24=0:00, 25=1:00 next day)

const MONO = "'JetBrains Mono','SF Mono','Courier New',monospace";

/* ── 记录本 ──────────────────────────────────────────────────────────
   一个项目 = 一叠记录。一条记录 = 日期 + 天气 + 正文 + 照片，跟纸本子一页一样。 */
const WEATHER = ["☀️ 晴", "⛅ 多云", "☁️ 阴", "🌧 雨", "⛈ 雷雨", "❄️ 雪"];

/* 照片存 IndexedDB，见 src/photos.js —— 同步引擎也要用，所以抽出去共用 */

// 长边压到 1600、JPEG q0.75，一张大约 200–400KB，看光路和示数完全够
function shrinkImage(file, max = 1600, q = 0.75) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const sc = Math.min(1, max / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * sc)), h = Math.max(1, Math.round(img.height * sc));
      const cv = document.createElement("canvas");
      cv.width = w; cv.height = h;
      cv.getContext("2d").drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      cv.toBlob(b => b ? res(b) : rej(new Error("压缩失败")), "image/jpeg", q);
    };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error("这张图读不了")); };
    img.src = url;
  });
}

function dayKeyOf(ts) { return toBJ(ts).toDateString(); }
function fmtRecDay(ts) {
  const d = toBJ(ts);
  const w = ["周日","周一","周二","周三","周四","周五","周六"][d.getDay()];
  return `${d.getMonth()+1}月${d.getDate()}日 ${w}`;
}

/* 用 hover/pointer 判断是不是鼠标设备——比用宽度可靠：iPad 接键盘算桌面，
   小窗口的 Mac 也仍然是桌面。 */
function useMedia(query) {
  const [hit, setHit] = useState(() => {
    try { return window.matchMedia(query).matches; } catch { return false; }
  });
  useEffect(() => {
    let m;
    try { m = window.matchMedia(query); } catch { return; }
    const on = (e) => setHit(e.matches);
    setHit(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, [query]);
  return hit;
}
const DESKTOP_Q = "(hover: hover) and (pointer: fine)";

/* ── Notifications ── */
function notifySupported() { return typeof window !== "undefined" && "Notification" in window; }
async function ensureNotifyPerm() {
  try {
    if (!notifySupported()) return false;
    if (Notification.permission === "granted") return true;
    if (Notification.permission === "denied") return false;
    return (await Notification.requestPermission()) === "granted";
  } catch { return false; }
}
async function fireNotify(tag, title, body) {
  try {
    if (!notifySupported() || Notification.permission !== "granted") return false;
    const opts = { body, tag, icon: "icon-192.png", badge: "icon-192.png", requireInteraction: true };
    if ("serviceWorker" in navigator) {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg?.showNotification) { await reg.showNotification(title, opts); return true; }
    }
    new Notification(title, opts);   // no SW (dev server / plain tab)
    return true;
  } catch { return false; }
}

/* Importance tiers, low → high (RPG framing) */
const IMP = [
  { key:"casual", label:"休闲", color:"#5A9E4B", bg:"#EEFAE9", ring:"#B6E2A8" },
  { key:"side",   label:"支线", color:"#E8A838", bg:"#FFF6E5", ring:"#F5D48B" },
  { key:"main",   label:"主线", color:"#C02556", bg:"#FDEBF0", ring:"#E88DA8" },
];
const IM = Object.fromEntries(IMP.map(u=>[u.key,u]));
const IMP_ORDER = { main:0, side:1, casual:2 };
// v3 stored urgency: low|medium|critical — migrated on load, mapped here as a safety net
const LEGACY_IMP = { low:"casual", medium:"side", critical:"main" };
function impOf(t) { return IM[t?.importance] || IM[LEGACY_IMP[t?.urgency]] || IM.side; }
function migrateTodo(t) {
  if (t.importance && !t.urgency) return t;
  const { urgency, ...rest } = t;
  return { ...rest, importance: t.importance || LEGACY_IMP[urgency] || "side" };
}

// SVG Icons
const Ic = {
  Plus:({s=22})=><svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>,
  Trash:({s=18})=><svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>,
  Note:({s=20})=><svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>,
  Todo:({s=20})=><svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M9 12l2 2 4-4"/></svg>,
  Back:({s=22})=><svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>,
  Play:({s=18})=><svg width={s} height={s} viewBox="0 0 24 24" fill="currentColor"><polygon points="6,3 20,12 6,21"/></svg>,
  Pause:({s=18})=><svg width={s} height={s} viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="3" width="5" height="18" rx="1"/><rect x="14" y="3" width="5" height="18" rx="1"/></svg>,
  Check:({s=18})=><svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>,
  Clock:({s=14})=><svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>,
  Cal:({s=16})=><svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>,
  Edit:({s=14})=><svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>,
  Split:({s=16})=><svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>,
  Grid:({s=18})=><svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>,
  List:({s=18})=><svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="4" cy="6" r="1" fill="currentColor"/><circle cx="4" cy="12" r="1" fill="currentColor"/><circle cx="4" cy="18" r="1" fill="currentColor"/></svg>,
  ChevL:({s=18})=><svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="15 18 9 12 15 6"/></svg>,
  ChevR:({s=18})=><svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="9 6 15 12 9 18"/></svg>,
  Down:({s=14})=><svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="6 9 12 15 18 9"/></svg>,
  Up:({s=14})=><svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="18 15 12 9 6 15"/></svg>,
  Drag:({s=16})=><svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="7" y1="6" x2="17" y2="6"/><line x1="7" y1="10" x2="17" y2="10"/><line x1="7" y1="14" x2="17" y2="14"/><line x1="7" y1="18" x2="17" y2="18"/></svg>,
  Bell:({s=16})=><svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/></svg>,
  BellOff:({s=16})=><svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M13.73 21a2 2 0 01-3.46 0"/><path d="M18.63 13A17.9 17.9 0 0118 8"/><path d="M6.26 6.26A5.86 5.86 0 006 8c0 7-3 9-3 9h14"/><path d="M18 8a6 6 0 00-9.33-5"/><line x1="2" y1="2" x2="22" y2="22"/></svg>,
  X:({s=16})=><svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>,
};

/* ── Focus Timer ── */
// Elapsed is always derived from the task's own stored session ({startTs, baseElapsed}),
// so several timers can run side by side and none of them drifts while backgrounded.
function FocusTimer({ todo, frozen, onComplete, onPause }) {
  const read = () => {
    const s = getTimerSession(todo.id);
    return s ? sessionElapsed(s) : (todo.elapsed || 0);
  };
  const [elapsed, setElapsed] = useState(read);

  useEffect(() => {
    if (frozen) return;                      // "you were away" dialog is up — hold the clock
    setElapsed(read());
    const iv = setInterval(() => setElapsed(read()), 250);
    const onVis = () => { if (document.visibilityState === "visible") setElapsed(read()); };
    document.addEventListener("visibilitychange", onVis);
    return () => { clearInterval(iv); document.removeEventListener("visibilitychange", onVis); };
  }, [frozen, todo.id]);

  const imp = impOf(todo);
  const expected = (todo.duration || 30) * 60;
  const isOver = elapsed > expected;
  const startTs = getTimerSession(todo.id)?.startTs
    || [...(todo.timeline || [])].reverse().find(e => e.type === "start" || e.type === "resume")?.at
    || Date.now();

  return (
    <div style={{ padding: "14px 0 8px", animation: "slideUp .3s ease both" }}>
      {/* Start time */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, marginBottom: 14 }}>
        <div style={{ fontSize: 11, color: "#AAA", letterSpacing: "0.5px" }}>开始于</div>
        <div style={{
          fontSize: 18, fontWeight: 700, color: imp.color,
          fontFamily: "'JetBrains Mono','SF Mono','Courier New',monospace",
          letterSpacing: "1.5px", background: imp.bg, padding: "4px 14px", borderRadius: 10,
        }}>{fmtBJ(startTs)}</div>
      </div>

      {/* Timer display */}
      <div style={{
        display: "flex", alignItems: "baseline", justifyContent: "center", gap: 8,
        padding: "18px 0", borderRadius: 20,
        background: isOver ? "linear-gradient(135deg, #E8F9ED, #F0FFF4)" : `linear-gradient(135deg, ${imp.bg}, #FDFBF7)`,
        marginBottom: 14,
      }}>
        <span style={{ fontSize: 15, color: "#999", fontWeight: 500 }}>已专注：</span>
        <span style={{
          fontSize: 36, fontWeight: 800, letterSpacing: "3px",
          fontFamily: "'JetBrains Mono','SF Mono','Courier New',monospace",
          color: isOver ? "#3BA55C" : imp.color,
        }}>{fmtSec(elapsed)}</span>
      </div>

      {/* Info row */}
      <div style={{ display: "flex", justifyContent: "center", gap: 16, fontSize: 12, color: "#AAA", marginBottom: 16 }}>
        <span>目标 {fmtMin(todo.duration)}</span>
        {isOver && <span style={{ color: "#3BA55C", fontWeight: 600 }}>+{fmtSec(elapsed - expected)}</span>}
      </div>

      {/* Controls */}
      <div style={{ display: "flex", gap: 10 }}>
        <button onClick={() => onPause(read())} style={{
          flex: 1, padding: "14px 0", borderRadius: 16, border: `2px solid ${imp.ring}`,
          background: "#FFF", color: imp.color, fontSize: 15, fontWeight: 600,
          fontFamily: "inherit", cursor: "pointer", display: "flex", alignItems: "center",
          justifyContent: "center", gap: 8,
        }}><Ic.Pause s={16}/> 暂停</button>
        <button onClick={() => onComplete(read())} style={{
          flex: 1, padding: "14px 0", borderRadius: 16, border: "none",
          background: "#2C2C2C", color: "#FFF", fontSize: 15, fontWeight: 600,
          fontFamily: "inherit", cursor: "pointer", display: "flex", alignItems: "center",
          justifyContent: "center", gap: 8, boxShadow: "0 4px 16px rgba(0,0,0,0.15)",
        }}><Ic.Check s={16}/> 完成</button>
      </div>
    </div>
  );
}

/* ── Running tasks bar — every parallel timer at a glance ── */
function RunningBar({ ids, todos, onOpen, onPauseAll }) {
  const [, tick] = useState(0);
  useEffect(() => { const iv = setInterval(() => tick(n => n + 1), 500); return () => clearInterval(iv); }, []);
  const items = ids.map(id => todos.find(t => t.id === id)).filter(Boolean);
  if (!items.length) return null;
  return (
    <div style={{
      position: "fixed", bottom: 0, left: "50%", transform: "translateX(-50%)",
      width: "100%", maxWidth: "var(--app-w)", zIndex: 99, pointerEvents: "none",
      padding: "0 24px calc(env(safe-area-inset-bottom, 0px) + 26px)",
    }}>
      <div style={{
        pointerEvents: "auto", marginRight: 68,
        background: "linear-gradient(140deg,#302B26,#1B1917)", borderRadius: 18,
        boxShadow: "0 12px 34px rgba(0,0,0,0.28)", padding: "9px 10px 9px 12px",
        display: "flex", alignItems: "center", gap: 8,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 5, flexShrink: 0 }}>
          <span className="run-pulse" style={{ width: 7, height: 7, borderRadius: "50%", background: "#5A9E4B" }}/>
          <span style={{ fontSize: 11, color: "#8A8480", fontWeight: 600 }}>{items.length}个</span>
        </div>
        <div className="run-strip" style={{ display: "flex", gap: 6, overflowX: "auto", flex: 1, minWidth: 0, scrollbarWidth: "none" }}>
          {items.map(t => {
            const imp = impOf(t);
            const s = getTimerSession(t.id);
            return (
              <button key={t.id} onClick={() => onOpen(t.id)} style={{
                flexShrink: 0, display: "flex", alignItems: "center", gap: 6, cursor: "pointer",
                background: hexA(imp.color, 0.16), border: `1px solid ${hexA(imp.color, 0.3)}`,
                borderRadius: 11, padding: "5px 9px", fontFamily: "inherit", maxWidth: 168,
              }}>
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: imp.color, flexShrink: 0 }}/>
                <span style={{ fontSize: 11.5, color: "#EDE8E2", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.text}</span>
                <span style={{ fontSize: 11.5, color: "#FFF", fontWeight: 700, fontFamily: MONO, flexShrink: 0 }}>{fmtSec(sessionElapsed(s))}</span>
              </button>
            );
          })}
        </div>
        {items.length > 1 && (
          <button onClick={onPauseAll} style={{
            flexShrink: 0, background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.14)",
            borderRadius: 11, padding: "6px 9px", color: "#CFC9C3", fontSize: 11, fontWeight: 600,
            cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 4,
          }}><Ic.Pause s={11}/>全部</button>
        )}
      </div>
    </div>
  );
}

/* ── Reminder Picker (shared by task form & swipe sheet) ── */
const REMIND_PRESETS = [
  { label:"15分钟后", at:()=>Date.now()+15*60000 },
  { label:"30分钟后", at:()=>Date.now()+30*60000 },
  { label:"1小时后",  at:()=>Date.now()+60*60000 },
  { label:"今晚20:00", at:()=>{ const t=bjTimeToTs(20,0); return t>Date.now()?t:bjTimeToTs(20,0,1); } },
  { label:"明早9:00",  at:()=>bjTimeToTs(9,0,1) },
];
function RemindPicker({ at, onChange, accent = "#E8A838" }) {
  const d = toBJ(at);
  const timeStr = `${d.getHours().toString().padStart(2,"0")}:${d.getMinutes().toString().padStart(2,"0")}`;
  const denied = notifySupported() && Notification.permission === "denied";
  return (
    <div style={{ animation:"slideUp .22s ease both" }}>
      <div style={{ display:"flex",flexWrap:"wrap",gap:6 }}>
        {REMIND_PRESETS.map(pr=>(
          <button key={pr.label} onClick={()=>onChange(pr.at())} style={{
            padding:"8px 12px",borderRadius:10,border:"2px solid transparent",
            background:"#F0EDE6",color:"#777",fontSize:12,fontWeight:600,
            cursor:"pointer",fontFamily:"inherit",
          }}>{pr.label}</button>
        ))}
      </div>
      <div style={{ display:"flex",alignItems:"center",gap:10,marginTop:10 }}>
        <span style={{ fontSize:12,color:"#999" }}>具体时间</span>
        <input type="time" value={timeStr} onChange={e=>{
          const [h,m] = e.target.value.split(":").map(Number);
          if (Number.isNaN(h) || Number.isNaN(m)) return;
          let ts = bjTimeToTs(h,m);
          if (ts <= Date.now()) ts = bjTimeToTs(h,m,1);   // already past → tomorrow
          onChange(ts);
        }} style={{
          padding:"7px 10px",borderRadius:10,border:"2px solid #E8E4DA",fontSize:14,
          fontFamily:"inherit",outline:"none",background:"#FFF",color:"#2C2C2C",
        }}/>
        <span style={{ fontSize:13,fontWeight:700,color:accent }}>{fmtRemind(at)}</span>
      </div>
      {!notifySupported() && (
        <div style={{ fontSize:11,color:"#BBB",marginTop:8,lineHeight:1.5 }}>
          此浏览器不支持系统通知 · 打开 App 时仍会流光提醒
        </div>
      )}
      {denied && (
        <div style={{ fontSize:11,color:"#C08838",marginTop:8,lineHeight:1.5 }}>
          系统通知已被拒绝 · 只会有应用内提醒和流光
        </div>
      )}
      {/* 没有推送服务，退到后台后没有代码在跑 —— 说清楚，别让人以为一定会准时响 */}
      {notifySupported() && !denied && (
        <div style={{ fontSize:11,color:"#BBB",marginTop:8,lineHeight:1.5 }}>
          退到后台后系统不会推送 · 回到 App 时补弹
        </div>
      )}
    </div>
  );
}

/* ── Reminder Sheet (quick set/clear from a task row) ── */
function ReminderSheet({ todo, onSave, onClear, onClose }) {
  const imp = impOf(todo);
  const [at, setAt] = useState(todo.remind?.at || Date.now() + 30*60000);
  return (
    <div onClick={onClose} style={{
      position:"fixed",inset:0,zIndex:9998,background:"rgba(0,0,0,0.42)",
      display:"flex",alignItems:"flex-end",justifyContent:"center",
      animation:"flashFade .2s ease both",
    }}>
      <div onClick={e=>e.stopPropagation()} style={{
        width:"100%",maxWidth:"var(--app-w)",background:"#FDFBF7",
        borderRadius:"26px 26px 0 0",padding:"22px 24px 34px",
        boxShadow:"0 -12px 48px rgba(0,0,0,0.18)",animation:"sheetUp .28s cubic-bezier(.25,1,.5,1) both",
      }}>
        <div style={{ width:38,height:4,borderRadius:2,background:"#E4E0D7",margin:"0 auto 16px" }}/>
        <div style={{ display:"flex",alignItems:"center",gap:8,marginBottom:4 }}>
          <span style={{ color:imp.color,display:"flex" }}><Ic.Bell s={17}/></span>
          <span style={{ fontSize:17,fontWeight:700 }}>设置提醒</span>
        </div>
        <div style={{ fontSize:13,color:"#999",marginBottom:16,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{todo.text}</div>
        <RemindPicker at={at} accent={imp.color} onChange={setAt} />
        <div style={{ display:"flex",gap:10,marginTop:20 }}>
          {todo.remind ? (
            <button onClick={onClear} style={{
              flex:1,padding:"13px 0",borderRadius:14,border:"2px solid #E0DCD3",background:"#FFF",
              color:"#999",fontSize:15,fontWeight:600,cursor:"pointer",fontFamily:"inherit",
              display:"flex",alignItems:"center",justifyContent:"center",gap:6,
            }}><Ic.BellOff s={15}/>关闭提醒</button>
          ) : (
            <button onClick={onClose} style={{
              flex:1,padding:"13px 0",borderRadius:14,border:"2px solid #E0DCD3",background:"#FFF",
              color:"#888",fontSize:15,fontWeight:600,cursor:"pointer",fontFamily:"inherit",
            }}>取消</button>
          )}
          <button onClick={()=>{ ensureNotifyPerm(); onSave(at); }} style={{
            flex:1.4,padding:"13px 0",borderRadius:14,border:"none",
            background:`linear-gradient(135deg, ${imp.color}, ${imp.color}cc)`,color:"#FFF",
            fontSize:15,fontWeight:600,cursor:"pointer",fontFamily:"inherit",
            boxShadow:`0 6px 20px ${hexA(imp.color,0.32)}`,
          }}>{fmtRemind(at)} 提醒我</button>
        </div>
      </div>
    </div>
  );
}

/* ── Task Form ── */
function TaskForm({ initial, onSave, onCancel, isSubtask }) {
  const desktop = useMedia(DESKTOP_Q);
  const [text, setText] = useState(initial?.text || "");
  const [duration, setDuration] = useState(initial?.duration || 30);
  const [importance, setImportance] = useState(initial?.importance || "side");
  const [remind, setRemind] = useState(initial?.remind || null);
  const ref = useRef(null);
  const formRef = useRef(null);
  useEffect(() => {
    if (ref.current) ref.current.focus();
    // Wait for iOS keyboard to finish animating, then scroll into view
    const t = setTimeout(() => {
      if (formRef.current) formRef.current.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }, 350);
    return () => clearTimeout(t);
  }, []);
  const presets = [10, 15, 20, 30, 45, 60, 90, 120];
  const imp = IM[importance] || IM.side;
  const submit = () => { if (text.trim()) onSave({ text: text.trim(), duration, importance, remind }); };
  // 桌面上打完字直接 ⌘↩ 存下，不用去够鼠标
  const onKey = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); submit(); }
  };
  return (
    <div ref={formRef} style={{ animation: "slideUp .3s ease both", padding: "12px 0 16px", marginLeft: isSubtask ? 24 : 0 }}>
      {isSubtask && <div style={{ fontSize: 12, color: "#999", marginBottom: 6, fontWeight: 600 }}>↳ 添加子任务</div>}
      <input ref={ref} value={text} onChange={e=>setText(e.target.value)} onKeyDown={onKey}
        placeholder={isSubtask ? "子任务名称..." : "任务名称..."}
        onKeyDown={e=>{if(e.key==="Enter"&&text.trim()) onSave({text:text.trim(),duration,importance,remind});}}
        style={{ width:"100%",padding:"14px 16px",borderRadius:14,border:"2px solid #E8E4DA",fontSize:15,fontFamily:"inherit",background:"#FFF",outline:"none",color:"#2C2C2C",boxSizing:"border-box" }}
      />
      <div style={{ marginTop: 12 }}>
        <div style={{ fontSize: 12, color: "#999", marginBottom: 8, fontWeight: 600, letterSpacing: "0.5px" }}>重要程度</div>
        <div style={{ display: "flex", gap: 6 }}>
          {IMP.map(u=>(
            <button key={u.key} onClick={()=>setImportance(u.key)} style={{
              flex:1,padding:"9px 0",borderRadius:12,
              border:importance===u.key?`2.5px solid ${u.color}`:"2.5px solid transparent",
              background:u.bg,color:u.color,fontSize:12,fontWeight:600,
              cursor:"pointer",fontFamily:"inherit",transition:"all .2s",
              transform:importance===u.key?"scale(1.05)":"scale(1)",
            }}>{u.label}</button>
          ))}
        </div>
      </div>
      <div style={{ marginTop: 12 }}>
        <div style={{ fontSize: 12, color: "#999", marginBottom: 8, fontWeight: 600, letterSpacing: "0.5px" }}>预期时长</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {presets.map(d=>(
            <button key={d} onClick={()=>setDuration(d)} style={{
              padding:"8px 14px",borderRadius:10,
              border:duration===d?"2px solid #2C2C2C":"2px solid transparent",
              background:duration===d?"#2C2C2C":"#F0EDE6",
              color:duration===d?"#FFF":"#777",fontSize:12,fontWeight:600,
              cursor:"pointer",fontFamily:"inherit",
            }}>{fmtMin(d)}</button>
          ))}
        </div>
        <div style={{ display:"flex",alignItems:"center",gap:8,marginTop:8 }}>
          <span style={{fontSize:12,color:"#999"}}>自定义:</span>
          <input type="number" value={duration} onChange={e=>setDuration(Math.max(1,+e.target.value||1))}
            style={{width:56,padding:"7px 8px",borderRadius:8,border:"2px solid #E8E4DA",fontSize:13,fontFamily:"inherit",textAlign:"center",outline:"none"}} />
          <span style={{fontSize:12,color:"#999"}}>分钟</span>
        </div>
      </div>
      <div style={{ marginTop: 14 }}>
        <div style={{ display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8 }}>
          <div style={{ fontSize:12,color:"#999",fontWeight:600,letterSpacing:"0.5px" }}>提醒</div>
          <button onClick={()=>{
            if (remind) { setRemind(null); return; }
            setRemind({ at: Date.now() + 30*60000, fired:false, ack:false });
            ensureNotifyPerm();   // must run inside the tap for Safari
          }} style={{
            display:"flex",alignItems:"center",gap:6,padding:"7px 12px",borderRadius:11,
            border:remind?`2px solid ${imp.color}`:"2px solid #E8E4DA",
            background:remind?imp.bg:"#FFF",color:remind?imp.color:"#AAA",
            fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit",transition:"all .2s",
          }}>{remind ? <><Ic.Bell s={13}/>已开启</> : <><Ic.BellOff s={13}/>关闭</>}</button>
        </div>
        {remind && <RemindPicker at={remind.at} accent={imp.color} onChange={at=>setRemind({at,fired:false,ack:false})} />}
      </div>
      <div style={{ display:"flex",gap:10,marginTop:16 }}>
        <button onClick={onCancel} style={{flex:1,padding:"13px 0",borderRadius:14,border:"2px solid #E0DCD3",background:"#FFF",color:"#888",fontSize:15,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>取消</button>
        <button onClick={submit} style={{flex:1,padding:"13px 0",borderRadius:14,border:"none",background:"#2C2C2C",color:"#FFF",fontSize:15,fontWeight:600,cursor:"pointer",fontFamily:"inherit",opacity:text.trim()?1:0.4,display:"flex",alignItems:"center",justifyContent:"center",gap:7}}>
          保存{desktop && <span style={{fontSize:11,opacity:.55,fontFamily:MONO}}>⌘↩</span>}</button>
      </div>
    </div>
  );
}

/* ── Weekly Timetable ── */
function WeeklyTable({ todos, weekOffset, setWeekOffset }) {
  // Get the Monday of the target week
  const now = bjNow();
  const dayOfWeek = now.getDay() === 0 ? 7 : now.getDay();
  const monday = new Date(now);
  monday.setDate(monday.getDate() - dayOfWeek + 1 + weekOffset * 7);
  monday.setHours(0,0,0,0);
  const sunday = new Date(monday);
  sunday.setDate(sunday.getDate() + 6);
  sunday.setHours(23,59,59,999);

  const monLabel = `${monday.getMonth()+1}/${monday.getDate()}`;
  const sunLabel = `${sunday.getMonth()+1}/${sunday.getDate()}`;

  // Filter done todos in this week (use completion time for week grouping)
  const weekTodos = todos.filter(t => {
    if (!t.done) return false;
    const doneTime = t.doneTs || t.timeline?.find(e => e.type === "complete")?.at;
    if (!doneTime) return false;
    const d = toBJ(doneTime);
    return d >= monday && d <= sunday;
  });

  // Build blocks: split timeline into segments (start→pause, resume→complete, etc.)
  const blocks = weekTodos.flatMap(t => {
    const tl = t.timeline || [];
    const segments = [];
    let segStart = null;
    for (const ev of tl) {
      if (ev.type === "start" || ev.type === "resume") {
        segStart = ev.at;
      } else if ((ev.type === "pause" || ev.type === "complete") && segStart) {
        segments.push({ startAt: segStart, endAt: ev.at });
        segStart = null;
      }
    }
    if (segments.length === 0) {
      const last = [...tl].reverse().find(e => e.type === "start" || e.type === "resume");
      if (!last) return [];
      const d = toBJ(last.at);
      const dayIdx = (d.getDay() === 0 ? 6 : d.getDay() - 1);
      const startH = d.getHours() + d.getMinutes() / 60;
      const durSec = t.actualDuration || (t.duration || 30) * 60;
      const durH = Math.max(durSec / 3600, 0.25);
      const imp = impOf(t);
      return [{ dayIdx, startH, durH, text: t.text, color: imp.color, bg: imp.bg }];
    }
    const imp = impOf(t);
    return segments
      .filter(seg => { const d = toBJ(seg.startAt); return d >= monday && d <= sunday; })
      .map(seg => {
        const d = toBJ(seg.startAt);
        const dayIdx = (d.getDay() === 0 ? 6 : d.getDay() - 1);
        const startH = d.getHours() + d.getMinutes() / 60;
        const durSec = (seg.endAt - seg.startAt) / 1000;
        const durH = Math.max(durSec / 3600, 0.25);
        return { dayIdx, startH, durH, text: t.text, color: imp.color, bg: imp.bg };
      });
  });

  // Tasks can be timed in parallel, so blocks overlap. Give each cluster of
  // overlapping blocks its own set of lanes and split the column between them.
  const laid = blocks.map(b => {
    // Early-morning blocks render in the 24:00–26:00 zone — the late-night
    // continuation of the *previous* day → one column left.
    const vh = b.startH < 9 ? b.startH + 24 : b.startH;
    return { ...b, vh, col: b.startH < 9 ? b.dayIdx - 1 : b.dayIdx, lane: 0, lanes: 1 };
  }).filter(b => b.col >= 0 && b.vh >= 9 && b.vh < 26);

  const byCol = {};
  laid.forEach(b => { (byCol[b.col] = byCol[b.col] || []).push(b); });
  Object.values(byCol).forEach(list => {
    list.sort((a, b) => a.vh - b.vh);
    let cluster = [], laneEnds = [], clusterEnd = -Infinity;
    const flush = () => {
      const n = Math.max(laneEnds.length, 1);
      cluster.forEach(b => { b.lanes = n; });
      cluster = []; laneEnds = []; clusterEnd = -Infinity;
    };
    list.forEach(b => {
      if (b.vh >= clusterEnd) flush();            // no overlap with the cluster so far
      let lane = laneEnds.findIndex(end => end <= b.vh);
      if (lane === -1) { lane = laneEnds.length; laneEnds.push(0); }
      const end = b.vh + b.durH;
      laneEnds[lane] = end;
      b.lane = lane;
      cluster.push(b);
      clusterEnd = Math.max(clusterEnd, end);
    });
    flush();
  });

  const ROW_H = 48;
  const COL_W = "calc((100% - 36px) / 7)";

  return (
    <div>
      {/* Week nav */}
      <div style={{ display:"flex",alignItems:"center",justifyContent:"center",gap:16,padding:"12px 0 16px" }}>
        <button onClick={()=>setWeekOffset(o=>o-1)} style={S.ib}><Ic.ChevL s={20}/></button>
        <div style={{ textAlign:"center" }}>
          <div style={{ fontSize:15,fontWeight:700 }}>{monLabel} — {sunLabel}</div>
          <div style={{ fontSize:11,color:"#AAA" }}>{weekOffset===0?"本周":weekOffset===-1?"上周":`${Math.abs(weekOffset)}周${weekOffset<0?"前":"后"}`}</div>
        </div>
        <button onClick={()=>setWeekOffset(o=>o+1)} style={S.ib}><Ic.ChevR s={20}/></button>
      </div>

      {/* Grid */}
      <div style={{ overflowX: "auto", paddingBottom: 16 }}>
        <div style={{ position:"relative", minWidth: 500 }}>
          {/* Header */}
          <div style={{ display:"flex",paddingLeft:36 }}>
            {WDAYS.map((w,i)=>(
              <div key={i} style={{ width:COL_W, flex:"1 0 0", textAlign:"center",fontSize:11,fontWeight:600,color:i>=5?"#E25B3A":"#888",padding:"6px 0" }}>{w}</div>
            ))}
          </div>

          {/* Time grid */}
          <div style={{ position:"relative" }}>
            {HOURS.map(h=>(
              <div key={h} style={{ display:"flex",height:ROW_H,borderTop:"1px solid #F0EDE6" }}>
                <div style={{ width:36,fontSize:10,color:"#BBB",textAlign:"right",paddingRight:6,paddingTop:2,flexShrink:0 }}>{h<24?`${h}:00`:`${h-24}:00`}</div>
                {WDAYS.map((_,i)=>(
                  <div key={i} style={{ flex:"1 0 0",borderLeft:"1px solid #F5F2EC" }} />
                ))}
              </div>
            ))}

            {/* Task blocks */}
            {laid.map((b,i)=>{
              const top = (b.vh - 9) * ROW_H;
              const height = Math.max(b.durH * ROW_H, 22);
              // Overlapping (parallel) blocks share the column, side by side.
              const slot = `((100% - 36px) / 7 - 4px) / ${b.lanes}`;
              const left = `calc(36px + ${b.col} * ((100% - 36px) / 7) + 2px + ${b.lane} * (${slot}))`;
              const width = `calc(${slot} - ${b.lanes > 1 ? 2 : 0}px)`;
              return (
                <div key={i} style={{
                  position:"absolute", top, left, width, height: Math.min(height, (26 - b.vh) * ROW_H),
                  background: `linear-gradient(135deg, ${b.color}ee, ${b.color}bb)`,
                  borderRadius: 6, padding: "3px 5px", overflow: "hidden",
                  fontSize: 10, fontWeight: 600, color: "#FFF", lineHeight: 1.3,
                  boxShadow: `0 2px 8px ${b.color}33`,
                  cursor: "default",
                }}>
                  <div style={{ overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{b.text}</div>
                  {height > 28 && b.lanes === 1 && <div style={{ fontSize: 9, opacity: 0.8, marginTop: 1 }}>{Math.round(b.durH * 60)}m</div>}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Todo Item Row (reusable for parent & child) ── */
function TodoRow({ t, depth, activeIds, timersFrozen, setEditingTodo, setShowAdd,
  deleteTodo, startTodo, onAddSub, expandedIds, toggleExpand, children: subs, allTodos,
  completeTodo, pauseTodo, resumeTodo, dragFrom, dragOver, onDragStart, onRemind }) {
  const desktop = useMedia(DESKTOP_Q);
  const imp = impOf(t);
  const rem = t.remind || null;
  const lit = !!rem;                            // reminder on → row carries the flowing light
  const hot = lit && rem.fired && !rem.ack;     // fired and not acknowledged → faster, brighter
  const isActive = activeIds.has(t.id);
  const kidTodos = allTodos.filter(c => c.parentId === t.id);
  const hasKids = kidTodos.length > 0;
  const expanded = expandedIds.has(t.id);
  const lastEvt = t.timeline?.[t.timeline.length - 1];
  const isPaused = lastEvt?.type === "pause";
  const isDragging = dragFrom === t.id;
  const isDragOver = dragOver === t.id && dragFrom !== t.id;

  const REVEAL = 72;        // right swipe → drag handle
  const ACT_W = 148;        // left swipe → 提醒 + 删除
  const [tx, setTx] = useState(0);
  const swipe = useRef({ startX: 0, startY: 0, active: false, moving: false, baseTx: 0 });

  useEffect(() => { if (dragFrom) setTx(0); }, [dragFrom]);

  const onSwipeStart = (e) => {
    if (dragFrom) return;
    const touch = e.touches[0];
    swipe.current = { startX: touch.clientX, startY: touch.clientY, active: true, moving: false, baseTx: tx };
  };
  const onSwipeMove = (e) => {
    if (!swipe.current.active) return;
    const touch = e.touches[0];
    const dx = touch.clientX - swipe.current.startX;
    const dy = touch.clientY - swipe.current.startY;
    if (!swipe.current.moving) {
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
      if (Math.abs(dy) > Math.abs(dx)) { swipe.current.active = false; return; }
      swipe.current.moving = true;
    }
    e.preventDefault();
    setTx(Math.max(-ACT_W, Math.min(REVEAL, swipe.current.baseTx + dx)));
  };
  const onSwipeEnd = () => {
    if (!swipe.current.moving) {
      if (Math.abs(tx) > 10) setTx(0);
      swipe.current = { ...swipe.current, active: false };
      return;
    }
    swipe.current = { ...swipe.current, active: false, moving: false };
    setTx(prev => prev < -ACT_W * 0.35 ? -ACT_W : prev > REVEAL * 0.5 ? REVEAL : 0);
  };
  const closeSwipe = () => setTx(0);

  return (
    <>
      <div
        data-todo-id={t.id}
        className="todo-row"
        style={{
          position: "relative", overflow: "hidden",
          borderBottom: "1px solid #F0EDE6",
          borderTop: isDragOver ? "2px solid #E8A838" : undefined,
          paddingLeft: Math.min(depth, 4) * 20,
          opacity: isDragging ? 0.25 : 1,
          transition: "opacity 0.15s",
          animation: "slideUp .3s ease both",
        }}
      >
        {/* Actions – right side (swipe left to reveal) */}
        <div style={{
          position: "absolute", right: 0, top: 0, bottom: 0, width: ACT_W,
          display: "flex", alignItems: "stretch",
        }}>
          <button onClick={() => { closeSwipe(); onRemind(t.id); }} style={{
            flex: 1, border: "none", cursor: "pointer", color: "#FFF",
            background: lit ? "linear-gradient(160deg,#B98A2E,#8E6714)" : "linear-gradient(160deg,#E8A838,#D08C1E)",
            display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 3,
          }}>
            {lit ? <Ic.BellOff s={19}/> : <Ic.Bell s={19}/>}
            <span style={{ fontSize: 10, fontWeight: 700 }}>{lit ? "改提醒" : "提醒"}</span>
          </button>
          <button onClick={() => { closeSwipe(); deleteTodo(t.id); }} style={{
            flex: 1, border: "none", cursor: "pointer", color: "#FFF", background: "#FF3B30",
            display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 3,
          }}>
            <Ic.Trash s={19}/>
            <span style={{ fontSize: 10, fontWeight: 700 }}>删除</span>
          </button>
        </div>

        {/* Drag action – left side (swipe right to reveal) */}
        {!isActive && (
          <div style={{
            position: "absolute", left: 0, top: 0, bottom: 0, width: REVEAL,
            background: "#5B7FC7", display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            <button
              onTouchStart={(e) => { e.stopPropagation(); closeSwipe(); onDragStart(t.id, e); }}
              style={{
                background: "none", border: "none", color: "#FFF", cursor: "grab",
                display: "flex", flexDirection: "column", alignItems: "center", gap: 3, padding: 8,
                touchAction: "none",
              }}>
              <Ic.Drag s={19}/>
              <span style={{ fontSize: 10, fontWeight: 700 }}>拖动</span>
            </button>
          </div>
        )}

        {/* Main content – translates on swipe */}
        <div
          style={{
            position: "relative",
            transform: `translateX(${tx}px)`,
            transition: swipe.current.moving ? "none" : "transform 0.25s cubic-bezier(0.25,1,0.5,1)",
            background: "#FDFBF7",
            padding: "4px 0",
          }}
          onTouchStart={onSwipeStart}
          onTouchMove={onSwipeMove}
          onTouchEnd={onSwipeEnd}
        >
          {/* Reminder light — a sheen sweeps left→right, then the row rests */}
          {lit && (
            <div className="rmd" aria-hidden="true" style={{ "--sweep": hot ? "2.1s" : "3.8s" }}>
              <div className="rmd-wash" style={{ background:
                `linear-gradient(102deg, ${hexA(imp.color, hot?0.13:0.085)} 0%, ${hexA(imp.color, hot?0.05:0.03)} 42%, rgba(255,255,255,0) 78%)` }}/>
              <div className="rmd-grain"/>
              <div className="rmd-ring" style={{ boxShadow: `inset 0 0 0 1px ${hexA(imp.color, hot?0.24:0.14)}` }}/>
              <div className="rmd-sheen" style={{ background:
                `linear-gradient(90deg, ${hexA(imp.color,0)} 0%, ${hexA(imp.color,0.08)} 24%, ${hexA(imp.color, hot?0.34:0.24)} 42%, rgba(255,255,255,0.95) 50%, ${hexA(imp.color, hot?0.34:0.24)} 58%, ${hexA(imp.color,0.08)} 76%, ${hexA(imp.color,0)} 100%)` }}/>
              <div className="rmd-edge">
                <div className="rmd-comet" style={{ background:
                  `linear-gradient(90deg, ${hexA(imp.color,0)} 0%, ${hexA(imp.color,0.5)} 34%, #FFFFFF 50%, ${hexA(imp.color,0.5)} 66%, ${hexA(imp.color,0)} 100%)` }}/>
              </div>
            </div>
          )}
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 0", position: "relative", zIndex: 1 }}>
            {/* Importance dot */}
            <div className={lit ? "rmd-dot" : undefined} style={{
              "--sweep": hot ? "2.1s" : "3.8s",
              width: depth ? 8 : 10, height: depth ? 8 : 10, borderRadius: "50%", background: imp.color, flexShrink: 0,
              boxShadow: lit
                ? `0 0 0 ${depth?2:3}px ${imp.ring}, 0 0 12px ${hexA(imp.color,0.75)}`
                : `0 0 0 ${depth?2:3}px ${imp.ring}`,
            }} />
            {/* Content */}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: depth ? 14 : 15, lineHeight: 1.4, color: "#2C2C2C", display: "flex", alignItems: "center", gap: 6 }}>
                {depth > 0 && <span style={{ color: "#CCC", fontSize: 12 }}>↳</span>}
                {t.text}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4, flexWrap: "wrap" }}>
                <span style={{ fontSize: 10, color: imp.color, fontWeight: 600, background: imp.bg, padding: "2px 8px", borderRadius: 5 }}>{imp.label}</span>
                <span style={{ fontSize: 10, color: "#BBB", display: "flex", alignItems: "center", gap: 2 }}><Ic.Clock s={10}/>{fmtMin(t.duration)}</span>
                {t.elapsed > 0 && !isActive && <span style={{ fontSize: 10, color: "#AAA" }}>已用{fmtSec(t.elapsed)}</span>}
                {isPaused && !isActive && <span style={{ fontSize: 10, color: "#E8A838", fontWeight: 600 }}>⏸暂停中</span>}
                {lit && (
                  <button onClick={() => { closeSwipe(); onRemind(t.id); }}
                    className={hot ? "rmd-chip rmd-chip-hot" : "rmd-chip"}
                    style={{ color: imp.color, background: hexA(imp.color,0.10), border: `1px solid ${hexA(imp.color,0.22)}` }}>
                    <Ic.Bell s={9}/>{hot ? "到点了" : fmtRemind(rem.at)}
                  </button>
                )}
                {hasKids && <span style={{ fontSize: 10, color: "#BBB" }}>{kidTodos.filter(c=>c.done).length}/{kidTodos.length}子任务</span>}
              </div>
            </div>
            {/* Expand toggle */}
            {hasKids && (
              <button style={S.ib} onClick={() => toggleExpand(t.id)}>
                {expanded ? <Ic.Up s={14}/> : <Ic.Down s={14}/>}
              </button>
            )}
            {/* Actions —— 桌面上没有滑动手势，提醒和删除必须放进行内，
                否则鼠标用户根本没法删除任务或设提醒 */}
            <div className={desktop ? "row-acts" : undefined} style={{ display:"flex", alignItems:"center", gap:2 }}>
              {desktop && (
                <button style={S.actBtn} className="hit" title={lit ? "改提醒" : "设提醒"}
                  onClick={() => { closeSwipe(); onRemind(t.id); }}>
                  {lit ? <Ic.BellOff s={17}/> : <Ic.Bell s={17}/>}
                </button>
              )}
              <button style={S.actBtn} className="hit" onClick={() => { closeSwipe(); onAddSub(t.id); }} title="拆解子任务"><Ic.Split s={18}/></button>
              <button style={S.actBtn} className="hit" onClick={() => { closeSwipe(); setEditingTodo(t.id); setShowAdd(false); }} title="编辑"><Ic.Edit s={18}/></button>
              {desktop && (
                <button style={{...S.actBtn, color:"#D08585"}} className="hit" title="删除"
                  onClick={() => { closeSwipe(); deleteTodo(t.id); }}>
                  <Ic.Trash s={17}/>
                </button>
              )}
            </div>
            {!isActive && !isPaused && (
              <button onClick={() => startTodo(t.id)} style={{
                width: 38, height: 38, borderRadius: 12, border: "none",
                background: `linear-gradient(135deg,${imp.bg},${imp.ring}55)`,
                color: imp.color, display: "flex", alignItems: "center", justifyContent: "center",
                cursor: "pointer", flexShrink: 0,
              }}><Ic.Play s={15}/></button>
            )}
            {isPaused && !isActive && (
              <button onClick={() => resumeTodo(t.id)} style={{
                width: 38, height: 38, borderRadius: 12, border: "none",
                background: `linear-gradient(135deg,${imp.bg},${imp.ring}55)`,
                color: imp.color, display: "flex", alignItems: "center", justifyContent: "center",
                cursor: "pointer", flexShrink: 0,
              }}><Ic.Play s={15}/></button>
            )}
          </div>
          {/* Active timer */}
          {isActive && (<div style={{ position: "relative", zIndex: 1 }}>
            <FocusTimer
              todo={t}
              frozen={timersFrozen}
              onComplete={el => completeTodo(t.id, el)}
              onPause={el => pauseTodo(t.id, el)}
            />
          </div>)}
        </div>
      </div>
      {/* Children */}
      {expanded && subs}
    </>
  );
}

/* ── 数据文件：一枚附件 ──
   照片是直接铺出来看的，数据文件不是——几百 MB 的 .mat 没法预览，也不该
   自动下到每台设备上。这里只显示文件名和大小，点一下才真的去拉。 */
function FileChip({ f, onRemove }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const open = async () => {
    setErr(""); setBusy(true);
    try { await downloadFile(f, Sync.getAuth()?.token); }
    catch (e) { setErr(/HTTP 401|请先登录/.test(e.message) ? "要先登录才能下载" : e.message); }
    finally { setBusy(false); }
  };

  return (
    <div style={{
      display:"flex", alignItems:"center", gap:9, padding:"8px 10px", marginTop:6,
      background:"#FAF8F3", border:"1px solid #EDE8DE", borderRadius:10,
    }}>
      <span style={{ fontSize:13, opacity:.75 }}>📎</span>
      <button onClick={open} disabled={busy} title={f.name} style={{
        flex:1, minWidth:0, textAlign:"left", border:"none", background:"none", padding:0,
        cursor:"pointer", fontFamily:"inherit", fontSize:12.5, fontWeight:600, color:"#3A3630",
        overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap",
      }}>{f.name}</button>
      <span style={{ fontSize:11, color:"#B0A99B", fontFamily:MONO, flexShrink:0 }}>
        {busy ? "取链接…" : fmtBytes(f.size)}
      </span>
      {onRemove
        ? <button onClick={()=>onRemove(f.id)} style={{ ...S.ib, padding:2, color:"#C5BEB0" }}>✕</button>
        : <button onClick={open} disabled={busy} style={{ ...S.ib, padding:2, color:"#8C8478" }}>↓</button>}
      {err && <span style={{ fontSize:11, color:"#C02556" }}>{err}</span>}
    </div>
  );
}

/* ── 挑数据文件：选中即传 ──
   不做「先存本地、回头再传」：几百 MB 的东西攒在设备上只会变成「以为传上去了
   其实没有」，那比当场说清楚糟得多。所以没登录、连不上就直接说，别装成功。

   做成钩子而不是组件：附件列表要待在正文下面，触发按钮却要摆进底部那排跟
   「加照片」并肩——两块 JSX 不相邻，组件交不出来。 */
function useDataFiles({ files = [], onAdd, onRemove }) {
  const [ups, setUps] = useState([]);        // [{ key, id, name, size, pct, err }]
  const [err, setErr] = useState("");
  const ref = useRef(null);
  const live = useRef(new Set());

  // 离开这一页时把没传完的掐掉——留着也没人看进度了，服务器那边的碎片会被回收
  useEffect(() => () => { live.current.forEach(c => { try { c.abort(); } catch {} }); }, []);

  const open = () => {
    if (!Sync.getAuth()?.token) {
      setErr("要先登录才能上传数据文件——数据是直接传到组里服务器上的，不在本机存副本");
      return;
    }
    setErr("");
    ref.current?.click();
  };

  const pick = async (e) => {
    const picked = [...(e.target.files || [])];
    e.target.value = "";
    if (!picked.length) return;
    const token = Sync.getAuth()?.token;
    if (!token) { setErr("登录已失效，请重新登录后再传"); return; }

    for (const file of picked) {
      const id = uid();
      const ctrl = new AbortController();
      live.current.add(ctrl);
      setUps(u => [...u, { key:id, id, name:file.name, size:file.size, pct:0, ctrl }]);
      try {
        const meta = await uploadFile(file, id, {
          token, signal: ctrl.signal,
          onProgress: (pct) => setUps(u => u.map(x => x.key === id ? { ...x, pct } : x)),
        });
        onAdd(meta);
        setUps(u => u.filter(x => x.key !== id));
      } catch (ex) {
        if (ex?.name === "AbortError") {
          setUps(u => u.filter(x => x.key !== id));
          dropFile(id, token);
        } else {
          setUps(u => u.map(x => x.key === id ? { ...x, err: ex?.message || "上传失败" } : x));
        }
      } finally { live.current.delete(ctrl); }
    }
  };

  const list = (
    <>
      {files.map(f => <FileChip key={f.id} f={f} onRemove={onRemove}/>)}

      {ups.map(u => (
        <div key={u.key} style={{
          padding:"8px 10px", marginTop:6, background:"#FAF8F3",
          border:"1px solid #EDE8DE", borderRadius:10,
        }}>
          <div style={{ display:"flex", alignItems:"center", gap:9 }}>
            <span style={{ fontSize:13, opacity:.75 }}>📎</span>
            <span style={{ flex:1, minWidth:0, fontSize:12.5, fontWeight:600, color:"#3A3630",
              overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{u.name}</span>
            <span style={{ fontSize:11, color:"#B0A99B", fontFamily:MONO, flexShrink:0 }}>
              {u.err ? fmtBytes(u.size) : `${Math.round(u.pct * 100)}%`}
            </span>
            <button onClick={()=>{ try { u.ctrl.abort(); } catch {} }}
              style={{ ...S.ib, padding:2, color:"#C5BEB0" }}>✕</button>
          </div>
          {u.err
            ? <div style={{ fontSize:11, color:"#C02556", marginTop:5 }}>{u.err}</div>
            : <div style={{ height:3, marginTop:6, background:"#EDE8DE", borderRadius:2, overflow:"hidden" }}>
                <div style={{ height:"100%", width:`${u.pct * 100}%`, background:"#2C2C2C",
                  borderRadius:2, transition:"width .2s" }}/>
              </div>}
        </div>
      ))}

      {err && <div style={{ fontSize:11.5, color:"#C02556", marginTop:8, lineHeight:1.6 }}>{err}</div>}

      <input ref={ref} type="file" multiple onChange={pick} style={{ display:"none" }}/>
    </>
  );

  /* 记录卡片的编辑区里没有底部那排按钮，就地给一条虚线的 */
  const inlineButton = (
    <button onClick={open} style={{
      marginTop:8, width:"100%", padding:"9px 0", borderRadius:11,
      border:"1px dashed #DCD6C9", background:"none", color:"#8C8478",
      fontSize:12.5, fontWeight:600, cursor:"pointer", fontFamily:"inherit",
    }}>📎 加数据文件</button>
  );

  return { list, open, inlineButton };
}

/* ── 写一条记录：日期是自动的，天气点一下，正文和照片 ── */
function Compose({ lastWeather, onSave }) {
  const [weather, setWeather] = useState(lastWeather || "");
  const [text, setText] = useState("");
  const [photos, setPhotos] = useState([]);
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const fileRef = useRef(null);

  const pick = async (e) => {
    const files = [...(e.target.files || [])];
    e.target.value = "";
    if (!files.length) return;
    setBusy(true); setErr(null);
    try {
      const ids = [];
      for (const f of files) {
        const blob = await shrinkImage(f);
        const id = uid();
        await putPhoto(id, blob);
        ids.push(id);
      }
      setPhotos(p => [...p, ...ids]);
    } catch (ex) { setErr(ex?.message || "照片存不进去"); }
    setBusy(false);
  };

  const drop = async (id) => {
    setPhotos(p => p.filter(x => x !== id));
    try { await delPhoto(id); } catch {}
  };

  const commit = () => {
    if (!text.trim() && !photos.length && !files.length) return;
    onSave({ weather, text: text.trim(), photos, files });
    setText(""); setPhotos([]); setFiles([]);
  };

  // 还没被任何记录引用，撤掉就该立刻从服务器上消失
  const dropData = (id) => {
    setFiles(f => f.filter(x => x.id !== id));
    dropFile(id, Sync.getAuth()?.token);
  };

  const dataUI = useDataFiles({ files, onAdd: m => setFiles(f => [...f, m]), onRemove: dropData });
  const softBtn = {
    flex:1, padding:"12px 0", borderRadius:13, border:"2px solid #E8E4DA", background:"#FFF",
    color:"#8C8478", fontSize:13.5, fontWeight:600, cursor:"pointer", fontFamily:"inherit",
    display:"flex", alignItems:"center", justifyContent:"center", gap:6,
  };

  return (
    <div style={{ background:"#FFF", border:"1px solid #EDE8DE", borderRadius:16, padding:"14px 15px", marginBottom:18 }}>
      <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:10 }}>
        <span style={{ fontSize:14, fontWeight:700 }}>{fmtRecDay(Date.now())}</span>
        <span style={{ fontSize:11, color:"#C0B8A8", fontFamily:MONO }}>{fmtBJ(Date.now())}</span>
      </div>

      <div style={{ display:"flex", flexWrap:"wrap", gap:6, marginBottom:11 }}>
        {WEATHER.map(w => (
          <button key={w} onClick={()=>setWeather(weather === w ? "" : w)} style={{
            padding:"6px 11px", borderRadius:10, fontSize:12, fontWeight:600, cursor:"pointer",
            fontFamily:"inherit", background: weather === w ? "#2C2C2C" : "#F2EFE8",
            color: weather === w ? "#FFF" : "#8C8478", border:"none",
          }}>{w}</button>
        ))}
      </div>

      <textarea value={text} onChange={e=>setText(e.target.value)} rows={4}
        placeholder="今天做了什么…"
        style={{ ...S.inp, resize:"vertical", fontSize:14.5, lineHeight:1.65 }}/>

      {photos.length > 0 && (
        <div style={{ display:"flex", gap:7, marginTop:10, flexWrap:"wrap" }}>
          {photos.map(id => (
            <div key={id} style={{ position:"relative" }}>
              <Photo id={id} size={72}/>
              <button onClick={()=>drop(id)} style={{
                position:"absolute", top:-6, right:-6, width:22, height:22, borderRadius:"50%",
                background:"#2C2C2C", color:"#FFF", border:"2px solid #FFF", cursor:"pointer",
                fontSize:11, lineHeight:1, display:"flex", alignItems:"center", justifyContent:"center", padding:0,
              }}>✕</button>
            </div>
          ))}
        </div>
      )}

      {dataUI.list}

      {err && <div style={{ fontSize:11.5, color:"#C02556", marginTop:8 }}>{err}</div>}

      <input ref={fileRef} type="file" accept="image/*" multiple onChange={pick} style={{ display:"none" }}/>
      <div style={{ display:"flex", gap:8, marginTop:12 }}>
        <button onClick={()=>fileRef.current?.click()} disabled={busy}
          style={{ ...softBtn, opacity: busy ? .5 : 1 }}>📷 {busy ? "处理中…" : "照片"}</button>
        <button onClick={dataUI.open} style={softBtn}>📎 数据</button>
        <button onClick={commit} style={{
          flex:1.25, padding:"12px 0", borderRadius:13, border:"none", background:"#2C2C2C",
          color:"#FFF", fontSize:14, fontWeight:600, cursor:"pointer", fontFamily:"inherit",
          opacity: (text.trim() || photos.length || files.length) ? 1 : .4,
        }}>记下</button>
      </div>
    </div>
  );
}

/* ── 已经记下的一条 ── */
function RecordCard({ r, onSave, onDelete, onOpenPhoto, thread, meId, onReply, onDropComment }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(r.text);
  const [weather, setWeather] = useState(r.weather || "");
  // 数据往往比记录晚到——分析跑完了才有结果文件，所以已存在的记录也得能补挂
  const [files, setFiles] = useState(r.files || []);
  const dataUI = useDataFiles({ files, onAdd: m => setFiles(f => [...f, m]),
    onRemove: id => setFiles(f => f.filter(x => x.id !== id)) });

  return (
    <div style={{ background:"#FFF", border:"1px solid #EDE8DE", borderRadius:14, padding:"13px 14px", marginBottom:10 }}>
      <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:7 }}>
        <span style={{ fontSize:12.5, fontWeight:700, color:"#5A544A" }}>{fmtRecDay(r.at)}</span>
        <span style={{ fontSize:11, color:"#C0B8A8", fontFamily:MONO }}>{fmtBJ(r.at)}</span>
        {r.weather && !editing && <span style={{ fontSize:12, color:"#8C8478" }}>{r.weather}</span>}
        <button onClick={()=>setEditing(v=>!v)} style={{ ...S.ib, marginLeft:"auto", color:"#C5BEB0", padding:4 }}>
          <Ic.Edit s={14}/>
        </button>
      </div>

      {editing ? (
        <>
          <div style={{ display:"flex", flexWrap:"wrap", gap:5, marginBottom:9 }}>
            {WEATHER.map(w => (
              <button key={w} onClick={()=>setWeather(weather === w ? "" : w)} style={{
                padding:"5px 9px", borderRadius:9, fontSize:11.5, fontWeight:600, cursor:"pointer",
                fontFamily:"inherit", background: weather === w ? "#2C2C2C" : "#F2EFE8",
                color: weather === w ? "#FFF" : "#8C8478", border:"none",
              }}>{w}</button>
            ))}
          </div>
          <textarea value={text} onChange={e=>setText(e.target.value)} rows={4}
            style={{ ...S.inp, resize:"vertical", fontSize:14, lineHeight:1.65 }}/>
          {dataUI.list}
          {dataUI.inlineButton}
          <div style={{ display:"flex", gap:7, marginTop:9 }}>
            <button onClick={()=>{ onSave(r.id, { text: text.trim(), weather, files }); setEditing(false); }} style={S.miniD}>保存</button>
            <button onClick={()=>{ setText(r.text); setWeather(r.weather||""); setFiles(r.files||[]); setEditing(false); }} style={S.mini}>取消</button>
            <button onClick={()=>onDelete(r)} style={{ ...S.mini, marginLeft:"auto", color:"#C02556" }}>删除</button>
          </div>
        </>
      ) : (
        <>
          {r.text && <div style={{ fontSize:14, lineHeight:1.7, color:"#3A3630", whiteSpace:"pre-wrap" }}>{r.text}</div>}
          {r.photos?.length > 0 && (
            <div style={{ display:"flex", gap:7, marginTop: r.text ? 10 : 0, flexWrap:"wrap" }}>
              {r.photos.map(id => <Photo key={id} id={id} size={78} onOpen={onOpenPhoto}/>)}
            </div>
          )}
          {r.files?.map(f => <FileChip key={f.id} f={f}/>)}
          {/* 只有真有人点评或点赞时才出现——每条记录底下都挂一排按钮，
              自己的记录本就吵了。有人搭话时输入框自然会长出来。
              也不给自己的记录点赞的按钮，但导师点的赞要看得见。
              按钮写「回复」不写「点评」：学生是在回导师，不是点评自己。 */}
          {thread && (thread.replies.length > 0 || thread.likes.length > 0) && (
            <Thread thread={thread} meId={meId} canLike={false} replyLabel="回复"
              onReply={onReply} onDelete={onDropComment}/>
          )}
        </>
      )}
    </div>
  );
}

/* ── 项目：一个名字就够 ── */
function ProjectForm({ initial, onSave, onCancel }) {
  const [name, setName] = useState(initial?.name || "");
  const ref = useRef(null);
  useEffect(()=>{ if(ref.current) ref.current.focus(); }, []);
  return (
    <div style={{ animation:"slideUp .3s ease both", padding:"12px 0 16px" }}>
      <input ref={ref} value={name} onChange={e=>setName(e.target.value)}
        onKeyDown={e=>{ if(e.key==="Enter" && name.trim()) onSave({ name:name.trim() }); }}
        placeholder="项目名称…" style={S.inp}/>
      <div style={{ display:"flex", gap:10, marginTop:14 }}>
        <button onClick={onCancel} style={S.btnGhost}>取消</button>
        <button onClick={()=>name.trim() && onSave({ name:name.trim() })}
          style={{ ...S.btnDark, opacity: name.trim() ? 1 : .4 }}>保存</button>
      </div>
    </div>
  );
}

/* ── Main App ── */
export default function MochiApp() {
  const [initState] = useState(loadAll);
  const [data, _setData] = useState(initState.data);
  // 所有 setData 都过这一层：自动比对前后，给变化的实验记录盖 updatedAt、
  // 给删掉的留墓碑。这样那 23 处调用点一个都不用改。
  const setData = useCallback((updater) => {
    _setData(prev => Sync.stampChanges(prev, typeof updater === "function" ? updater(prev) : updater));
  }, []);
  // 同步合并的结果已经带好了服务器的时间戳，不能再过 stampChanges——
  // 否则刚拉下来的记录会被当成本地新改动，下一轮又推回服务器。
  const applySync = useCallback((fn) => _setData(fn), []);
  const [advisorOpen, setAdvisorOpen] = useState(false);
  const [tab, setTab] = useState("todo");
  const [showAdd, setShowAdd] = useState(false);
  const [addSubParent, setAddSubParent] = useState(null);
  const [editingTodo, setEditingTodo] = useState(null);
  const [activeIds, setActiveIds] = useState(() => new Set(initState.activeTodoIds));
  const [bgAlert, setBgAlert] = useState(null); // { hiddenSec } — away too long while timers ran
  const [view, setView] = useState("main"); // main | done | timetable
  const [expandedIds, setExpandedIds] = useState(new Set());
  const [weekOffset, setWeekOffset] = useState(0);
  const [doneViewMode, setDoneViewMode] = useState("list"); // list | week
  const [celebration, setCelebration] = useState(null); // { msg, elapsed }
  const [canceledTimer, setCanceledTimer] = useState(false);
  const [dragFrom, setDragFrom] = useState(null);
  const [dragOver, setDragOver] = useState(null);
  const [dragY, setDragY] = useState(0);
  const [dragHalfH, setDragHalfH] = useState(30);
  const [remindFor, setRemindFor] = useState(null);     // todo id whose reminder sheet is open
  const [remindAlert, setRemindAlert] = useState(null); // todo id of the in-app "到点了" banner
  const [openProject, setOpenProject] = useState(null);
  const [projForm, setProjForm] = useState(null);   // "new" | project id
  const [viewPhoto, setViewPhoto] = useState(null);
  const [saveErr, setSaveErr] = useState(null);
  const dragFromRef = useRef(null);
  const dragOverRef = useRef(null);
  const dragYRef = useRef(0);
  const todosRef = useRef(initState.data.todos);
  const activeRef = useRef(new Set(initState.activeTodoIds));
  const firedRef = useRef(new Set());

  useEffect(() => { save(data); }, [data]);
  useEffect(() => { todosRef.current = data.todos; }, [data.todos]);
  useEffect(() => { activeRef.current = activeIds; }, [activeIds]);
  useEffect(() => { setSaveErr(saveFailed); }, [data]);

  // ── 键盘快捷键（只在鼠标/键盘设备上启用）──
  // 桌面上手一直在键盘上，来回摸鼠标点「+」是最大的效率损失。
  const desktop = useMedia(DESKTOP_Q);
  useEffect(() => {
    if (!desktop) return;
    const onKey = (e) => {
      const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName || "")
        || e.target?.isContentEditable;

      if (e.key === "Escape") {
        // 从最上层往下逐层关闭，一次 Esc 只关一层
        if (bgAlert) return;                                  // 这个必须明确选择，不能靠 Esc 糊弄过去
        if (viewPhoto) { setViewPhoto(null); return; }
        if (remindFor) { setRemindFor(null); return; }
        if (advisorOpen) { setAdvisorOpen(false); return; }
        if (showAdd) { setShowAdd(false); return; }
        if (addSubParent) { setAddSubParent(null); return; }
        if (editingTodo) { setEditingTodo(null); return; }
        if (projForm) { setProjForm(null); return; }
        if (view !== "main") { setView("main"); return; }
        if (openProject) { setOpenProject(null); return; }
        if (inField) e.target.blur();
        return;
      }

      if (inField || e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        if (view !== "main") setView("main");
        if (tab === "todo") { setShowAdd(true); setEditingTodo(null); setAddSubParent(null); }
        else setProjForm("new");
      } else if (e.key === "1") { setView("main"); setTab("todo"); }
      else if (e.key === "2") { setView("main"); setTab("lab"); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [desktop, bgAlert, viewPhoto, remindFor, advisorOpen, showAdd, addSubParent,
      editingTodo, projForm, view, openProject, tab]);

  // Away-time watcher — one dialog for all running timers. iOS freezes (or kills) a
  // backgrounded PWA, so on return we ask whether the gap was real focus or a detour.
  useEffect(() => {
    const checkAway = () => {
      try {
        const bg = localStorage.getItem(BG_TS_SK);
        if (!bg) return;
        localStorage.removeItem(BG_TS_SK);
        const hiddenSec = Math.floor((Date.now() - parseInt(bg, 10)) / 1000);
        if (hiddenSec > BG_LIMIT_SEC && activeRef.current.size) setBgAlert({ hiddenSec });
      } catch {}
    };
    const onVis = () => {
      if (document.visibilityState === "hidden") {
        if (activeRef.current.size) { try { localStorage.setItem(BG_TS_SK, Date.now().toString()); } catch {} }
        return;
      }
      if (document.visibilityState === "visible") checkAway();
    };
    checkAway();   // app may have been killed outright and relaunched
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  // Reminder scheduler — polls while the app is alive, and re-checks whenever it
  // comes back to the foreground (a backgrounded PWA gets its timers frozen).
  useEffect(() => {
    const check = () => {
      const now = Date.now();
      const due = todosRef.current.filter(t =>
        !t.done && t.remind && !t.remind.fired && t.remind.at <= now &&
        !firedRef.current.has(`${t.id}@${t.remind.at}`));
      if (!due.length) return;
      due.forEach(t => {
        firedRef.current.add(`${t.id}@${t.remind.at}`);
        fireNotify(`mochi-${t.id}`, `⏰ ${t.text}`, `${impOf(t).label} · 预期 ${fmtMin(t.duration)}`);
      });
      const ids = new Set(due.map(t => t.id));
      setData(d => ({ ...d, todos: d.todos.map(t =>
        ids.has(t.id) ? { ...t, remind: { ...t.remind, fired: true, ack: false } } : t) }));
      try { navigator.vibrate?.([90, 60, 90]); } catch {}
      setRemindAlert(due[due.length - 1].id);
    };
    check();
    const iv = setInterval(check, 15000);
    const wake = () => { if (document.visibilityState === "visible") check(); };
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("focus", wake);
    return () => {
      clearInterval(iv);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("focus", wake);
    };
  }, []);

  useEffect(() => {
    if (!dragFrom) return;
    const onMove = (e) => {
      const p = e.touches ? e.touches[0] : e;
      if (!p) return;
      e.preventDefault();
      dragYRef.current = p.clientY;
      setDragY(p.clientY);
      const el = document.elementFromPoint(p.clientX, p.clientY);
      const row = el?.closest('[data-todo-id]');
      if (row) {
        const overId = row.dataset.todoId;
        if (overId !== dragFromRef.current) { dragOverRef.current = overId; setDragOver(overId); }
      }
    };
    const onEnd = () => {
      const from = dragFromRef.current, over = dragOverRef.current;
      if (from && over && from !== over) {
        setData(d => {
          const arr = [...d.todos];
          const fi = arr.findIndex(t => t.id === from);
          const ti = arr.findIndex(t => t.id === over);
          if (fi < 0 || ti < 0) return d;
          const a = arr[fi], b = arr[ti];
          if (a.importance !== b.importance || a.parentId !== b.parentId) return d;
          arr.splice(fi, 1);
          arr.splice(arr.findIndex(t => t.id === over), 0, a);
          return { ...d, todos: arr };
        });
      }
      dragFromRef.current = null; dragOverRef.current = null;
      setDragFrom(null); setDragOver(null);
    };
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onEnd);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onEnd);
    return () => {
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onEnd);
    };
  }, [dragFrom]);

  const startDrag = (id, e) => {
    const touch = e?.touches?.[0];
    if (!touch) return;
    const el = document.querySelector(`[data-todo-id="${id}"]`);
    const rect = el ? el.getBoundingClientRect() : { height: 60 };
    dragFromRef.current = id;
    dragOverRef.current = null;
    dragYRef.current = touch.clientY;
    setDragFrom(id);
    setDragOver(null);
    setDragY(touch.clientY);
    setDragHalfH(rect.height / 2);
  };

  const toggleExpand = (id) => {
    setExpandedIds(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  };

  // CRUD
  const addTodo = (info, parentId = null) => {
    const t = { id:uid(), ...info, done:false, ts:Date.now(), elapsed:0, actualDuration:null, doneTs:null, timeline:[], parentId };
    setData(d => {
      if (parentId) {
        const idx = d.todos.findIndex(x=>x.id===parentId);
        // Find last child of parent
        let insertIdx = idx + 1;
        while (insertIdx < d.todos.length && d.todos[insertIdx].parentId === parentId) insertIdx++;
        const arr = [...d.todos];
        arr.splice(insertIdx, 0, t);
        return { ...d, todos: arr };
      }
      return { ...d, todos: [t, ...d.todos] };
    });
    setShowAdd(false);
    setAddSubParent(null);
    if (parentId) setExpandedIds(s => { const n = new Set(s); n.add(parentId); return n; });
  };

  // Reminders
  const setRemindAt = (id, at) => {
    setData(d => ({ ...d, todos: d.todos.map(t => t.id === id ? { ...t, remind: { at, fired: false, ack: false } } : t) }));
    setRemindFor(null);
  };
  const clearRemind = (id) => {
    setData(d => ({ ...d, todos: d.todos.map(t => t.id === id ? { ...t, remind: null } : t) }));
    setRemindFor(null);
    setRemindAlert(a => a === id ? null : a);
  };
  const ackRemind = (id) => {
    setData(d => ({ ...d, todos: d.todos.map(t => t.id === id && t.remind ? { ...t, remind: { ...t.remind, ack: true } } : t) }));
    setRemindAlert(a => a === id ? null : a);
  };
  const snoozeRemind = (id, min = 10) => {
    setData(d => ({ ...d, todos: d.todos.map(t => t.id === id ? { ...t, remind: { at: Date.now() + min * 60000, fired: false, ack: false } } : t) }));
    setRemindAlert(a => a === id ? null : a);
  };

  const updateTodoInfo = (id, info) => { setData(d => ({ ...d, todos: d.todos.map(t => t.id===id?{...t,...info}:t) })); setEditingTodo(null); };

  // Timers run in parallel: starting one never stops the others.
  const addActive = (id) => setActiveIds(s => { const n = new Set(s); n.add(id); return n; });
  const dropActive = (ids) => setActiveIds(s => { const n = new Set(s); ids.forEach(i => n.delete(i)); return n; });

  const startTodo = (id) => {
    if (activeIds.has(id)) return;
    const todo = data.todos.find(t => t.id === id);
    saveTimerSession(id, Date.now(), todo?.elapsed || 0);
    setData(d => ({ ...d, todos: d.todos.map(t => {
      if (t.id !== id) return t;
      const tl = [...(t.timeline||[]), { type: "start", at: Date.now() }];
      return { ...t, timeline: tl };
    })}));
    addActive(id);
  };

  const pauseTodo = (id, elapsed) => {
    clearTimerSession(id);
    setData(d => ({ ...d, todos: d.todos.map(t => {
      if (t.id !== id) return t;
      const tl = [...(t.timeline||[]), { type: "pause", at: Date.now() }];
      return { ...t, timeline: tl, elapsed };
    })}));
    dropActive([id]);
  };

  // Pause every running task at once — one timeline event and one write each.
  const pauseAll = () => {
    const ids = [...activeIds];
    if (!ids.length) return;
    const at = Date.now();
    const stops = {};
    ids.forEach(id => { const s = getTimerSession(id); stops[id] = s ? sessionElapsed(s) : null; });
    clearTimerSession(...ids);
    setData(d => ({ ...d, todos: d.todos.map(t => {
      if (!(t.id in stops)) return t;
      const tl = [...(t.timeline||[]), { type: "pause", at }];
      return { ...t, timeline: tl, elapsed: stops[t.id] != null ? stops[t.id] : (t.elapsed || 0) };
    })}));
    dropActive(ids);
  };

  const resumeTodo = (id) => {
    if (activeIds.has(id)) return;
    const todo = data.todos.find(t => t.id === id);
    saveTimerSession(id, Date.now(), todo?.elapsed || 0);
    setData(d => ({ ...d, todos: d.todos.map(t => {
      if (t.id !== id) return t;
      const tl = [...(t.timeline||[]), { type: "resume", at: Date.now() }];
      return { ...t, timeline: tl };
    })}));
    addActive(id);
  };

  const CHEERS = ["干得漂亮！🔥","太强了！💪","完美收工！✨","效率拉满！🚀","又搞定一个！🎯","你就是传说！⚡","节奏起来了！🎶","无人能挡！💥"];
  const completeTodo = (id, elapsed) => {
    clearTimerSession(id);
    setData(d => ({ ...d, todos: d.todos.map(t => {
      if (t.id !== id) return t;
      const tl = [...(t.timeline||[]), { type: "complete", at: Date.now() }];
      return { ...t, done: true, elapsed, actualDuration: elapsed, doneTs: Date.now(), timeline: tl };
    })}));
    dropActive([id]);
    setCelebration({ msg: CHEERS[Math.floor(Math.random()*CHEERS.length)], elapsed });
    setTimeout(() => setCelebration(null), 2200);
  };

  const deleteTodo = (id) => {
    const gone = [id, ...data.todos.filter(t => t.parentId === id).map(t => t.id)];
    clearTimerSession(...gone);
    setData(d => ({ ...d, todos: d.todos.filter(t => t.id !== id && t.parentId !== id) }));
    dropActive(gone);
  };

  // Discard the current session(s) — used when the away-time check says "我在玩手机".
  const cancelTodos = (ids) => {
    if (!ids.length) return;
    // Roll elapsed back to what it was before each session started
    const before = {};
    ids.forEach(id => { const s = getTimerSession(id); before[id] = s ? (s.baseElapsed || 0) : 0; });
    clearTimerSession(...ids);
    setData(d => ({ ...d, todos: d.todos.map(t => {
      if (!(t.id in before)) return t;
      // Strip the last start/resume event so the timeline stays clean
      const tl = [...(t.timeline || [])];
      const lastIdx = tl.map(e => e.type).reduce((acc, ty, i) => (ty === "start" || ty === "resume") ? i : acc, -1);
      if (lastIdx >= 0) tl.splice(lastIdx, 1);
      return { ...t, elapsed: before[t.id], timeline: tl };
    })}));
    dropActive(ids);
    setCanceledTimer(true);
    setTimeout(() => setCanceledTimer(false), 3000);
  };

  // 导师的回复和点赞。作者名字要跟着一起存——对面拿不到成员名单，
  // 不存的话他只会看到一串 user id。
  const me = Sync.getAuth()?.user;
  const cmtIndex = useMemo(() => indexComments(data.comments), [data.comments]);
  const addComment = (recordId, kind, text) => setData(d => ({ ...d, comments: [
    ...(d.comments || []),
    { id: uid(), recordId, kind, text: text || "", byName: me?.displayName || "", at: Date.now() },
  ] }));
  const dropComment = (c) => setData(d => ({ ...d, comments: (d.comments || []).filter(x => x.id !== c.id) }));

  // 导师在导师端建的组级项目：归他所有，成员名单跟着项目数据一起同步，
  // 学生端靠这份名单才拉得到这个项目。
  const createGroupProject = (name) => setData(d => ({ ...d, projects: [
    { id:uid(), name, startedAt:Date.now(), color:NC[d.projects.length % NC.length], members:[] },
    ...d.projects] }));
  const setProjectMembers = (id, members) => setData(d => ({ ...d,
    projects: d.projects.map(p => p.id === id ? { ...p, members } : p) }));

  // 记录本
  const saveProject = (info) => {
    setData(d => projForm === "new"
      ? { ...d, projects: [{ id:uid(), ...info, startedAt:Date.now(), color:NC[d.projects.length % NC.length] }, ...d.projects] }
      : { ...d, projects: d.projects.map(x => x.id === projForm ? { ...x, ...info } : x) });
    setProjForm(null);
  };
  const deleteProject = (id) => {
    const gone = data.records.filter(r => r.projectId === id);
    const token = Sync.getAuth()?.token;
    const goneIds = new Set(gone.map(r => r.id));
    gone.forEach(r => {
      (r.photos || []).forEach(pid => delPhoto(pid).catch(()=>{}));
      (r.files || []).forEach(f => dropFile(f.id, token));
    });
    setData(d => ({ ...d, projects: d.projects.filter(x=>x.id!==id),
      records: d.records.filter(r=>r.projectId!==id),
      comments: (d.comments || []).filter(c => !goneIds.has(c.recordId)) }));
    setOpenProject(null);
  };
  const addRecord = (projectId, info) =>
    setData(d => ({ ...d, records: [...d.records, { id:uid(), projectId, at:Date.now(), ...info }] }));
  const saveRecord = (id, patch) =>
    setData(d => ({ ...d, records: d.records.map(r => r.id === id ? { ...r, ...patch } : r) }));
  const deleteRecord = (r) => {
    (r.photos || []).forEach(pid => delPhoto(pid).catch(()=>{}));
    (r.files || []).forEach(f => dropFile(f.id, Sync.getAuth()?.token));
    setData(d => ({ ...d,
      records: d.records.filter(x => x.id !== r.id),
      // 记录没了，挂在它下面的回复和赞也该走——留着就是服务器上一堆孤儿
      comments: (d.comments || []).filter(c => c.recordId !== r.id) }));
  };

  const pending = data.todos.filter(t => !t.done && !t.parentId);
  const allPending = data.todos.filter(t => !t.done);
  const done = data.todos.filter(t => t.done);
  const doneByDate = {};
  done.forEach(t => { const k = toBJ(t.doneTs||t.ts).toDateString(); if(!doneByDate[k]) doneByDate[k]=[]; doneByDate[k].push(t); });
  const sortedDK = Object.keys(doneByDate).sort((a,b)=>new Date(b)-new Date(a));

  const impSort = (a, b) => (IMP_ORDER[a.importance]??3) - (IMP_ORDER[b.importance]??3);

  // Helper to render todo tree
  const renderTodo = (t, depth = 0) => {
    const kids = data.todos.filter(c => c.parentId === t.id && !c.done).sort(impSort);
    if (editingTodo === t.id) {
      return (
        <div key={t.id} style={{ paddingLeft: Math.min(depth, 4) * 20 }}>
          <TaskForm initial={t} onSave={info=>updateTodoInfo(t.id,info)} onCancel={()=>setEditingTodo(null)} isSubtask={!!t.parentId}/>
          {kids.map(c => renderTodo(c, depth + 1))}
        </div>
      );
    }
    return (
      <TodoRow key={t.id} t={t} depth={depth} activeIds={activeIds} timersFrozen={!!bgAlert}
        setEditingTodo={setEditingTodo} setShowAdd={setShowAdd} deleteTodo={deleteTodo}
        startTodo={startTodo} onAddSub={id => { setAddSubParent(id); setShowAdd(false); setEditingTodo(null); setExpandedIds(s => { const n = new Set(s); n.add(id); return n; }); }}
        expandedIds={expandedIds} toggleExpand={toggleExpand} allTodos={data.todos}
        completeTodo={completeTodo} pauseTodo={pauseTodo} resumeTodo={resumeTodo}
        dragFrom={dragFrom} dragOver={dragOver} onDragStart={startDrag} onRemind={setRemindFor}>
        {kids.map(c => renderTodo(c, depth + 1))}
        {addSubParent === t.id && (
          <div style={{ paddingLeft: Math.min(depth + 1, 4) * 20 }}>
            <TaskForm isSubtask onSave={info => addTodo(info, t.id)} onCancel={() => setAddSubParent(null)} />
          </div>
        )}
      </TodoRow>
    );
  };

  // ── Running-timer overlays (rendered by every view) ──
  // Jump to a running task from the bar: back to the list, parents unfolded, scrolled into view.
  const revealTodo = (id) => {
    setView("main"); setTab("todo"); setOpenProject(null);
    setExpandedIds(s => {
      const n = new Set(s);
      let cur = data.todos.find(t => t.id === id);
      while (cur?.parentId) { n.add(cur.parentId); cur = data.todos.find(t => t.id === cur.parentId); }
      return n;
    });
    setTimeout(() => {
      document.querySelector(`[data-todo-id="${id}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 60);
  };
  const awayTodos = bgAlert ? [...activeIds].map(id => data.todos.find(t => t.id === id)).filter(Boolean) : [];
  const timerUI = (
    <>
      <RunningBar ids={[...activeIds]} todos={data.todos} onOpen={revealTodo} onPauseAll={pauseAll} />
      {bgAlert && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 9999,
          background: "rgba(0,0,0,0.45)", display: "flex",
          alignItems: "center", justifyContent: "center", padding: "0 32px",
        }}>
          <div style={{
            background: "#FDFBF7", borderRadius: 24, padding: "28px 24px",
            width: "100%", maxWidth: 340, boxShadow: "0 24px 64px rgba(0,0,0,0.2)",
            animation: "slideUp .25s ease both",
          }}>
            <div style={{ fontSize: 36, textAlign: "center", marginBottom: 12 }}>📵</div>
            <div style={{ fontSize: 17, fontWeight: 700, textAlign: "center", marginBottom: 8 }}>
              你离开了 {Math.round(bgAlert.hiddenSec / 60)} 分钟
            </div>
            <div style={{ fontSize: 14, color: "#888", textAlign: "center", marginBottom: 16, lineHeight: 1.6 }}>
              {awayTodos.length > 1 ? `${awayTodos.length} 个任务还在计时 — 是锁屏专注，还是在玩手机？` : "是锁屏专注，还是在玩手机？"}
            </div>
            {awayTodos.length > 1 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, justifyContent: "center", marginBottom: 18 }}>
                {awayTodos.map(t => {
                  const imp = impOf(t);
                  return (
                    <span key={t.id} style={{
                      fontSize: 11, fontWeight: 600, color: imp.color, background: imp.bg,
                      border: `1px solid ${hexA(imp.color, 0.22)}`, borderRadius: 8, padding: "4px 9px",
                      maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                    }}>{t.text}</span>
                  );
                })}
              </div>
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <button onClick={() => setBgAlert(null)} style={{
                padding: "14px 0", borderRadius: 16, border: "none",
                background: "#2C2C2C", color: "#FFF", fontSize: 15, fontWeight: 600,
                fontFamily: "inherit", cursor: "pointer",
              }}>🔒 锁屏专注，继续计时</button>
              <button onClick={() => { cancelTodos([...activeIds]); setBgAlert(null); }} style={{
                padding: "14px 0", borderRadius: 16, border: "2px solid #F0EDE6",
                background: "#FFF", color: "#C02556", fontSize: 15, fontWeight: 600,
                fontFamily: "inherit", cursor: "pointer",
              }}>📱 在玩手机，取消{awayTodos.length > 1 ? "这些" : "本次"}</button>
            </div>
          </div>
        </div>
      )}
    </>
  );

  // ── Reminder overlays (rendered by every view) ──
  const alertTodo = remindAlert ? data.todos.find(t => t.id === remindAlert) : null;
  const sheetTodo = remindFor ? data.todos.find(t => t.id === remindFor) : null;
  const alertImp = alertTodo ? impOf(alertTodo) : null;
  const remindUI = (
    <>
      {alertTodo && (
        <div style={{
          position:"fixed", top:0, left:"50%", transform:"translateX(-50%)",
          width:"100%", maxWidth:"var(--app-w)", zIndex:9997, pointerEvents:"none",
          padding:"calc(env(safe-area-inset-top, 0px) + 12px) 14px 0",
        }}>
          <div style={{
            pointerEvents:"auto", position:"relative", overflow:"hidden",
            background:"linear-gradient(140deg,#302B26,#1B1917)", borderRadius:20, padding:"14px 16px",
            boxShadow:`0 18px 48px rgba(0,0,0,0.34), inset 0 0 0 1px ${hexA(alertImp.color,0.38)}`,
            animation:"slideDown .32s cubic-bezier(.25,1,.5,1) both",
          }}>
            <div className="rmd-sheen rmd-sheen-dark" style={{ "--sweep":"2.4s", background:
              `linear-gradient(90deg, ${hexA(alertImp.color,0)} 0%, ${hexA(alertImp.color,0.35)} 40%, rgba(255,255,255,0.55) 50%, ${hexA(alertImp.color,0.35)} 60%, ${hexA(alertImp.color,0)} 100%)` }}/>
            <div style={{ position:"relative", zIndex:1 }}>
              <div style={{ display:"flex", alignItems:"center", gap:7 }}>
                <span className="rmd-chip-hot" style={{ color:alertImp.color, display:"flex" }}><Ic.Bell s={15}/></span>
                <span style={{ fontSize:12, fontWeight:700, color:alertImp.color, letterSpacing:"0.5px" }}>到点了</span>
                <button onClick={()=>ackRemind(alertTodo.id)} style={{
                  marginLeft:"auto", background:"none", border:"none", color:"#8A8480",
                  cursor:"pointer", display:"flex", padding:2,
                }}><Ic.X s={15}/></button>
              </div>
              <div style={{ fontSize:16, fontWeight:600, color:"#FFF", marginTop:6, lineHeight:1.35 }}>{alertTodo.text}</div>
              <div style={{ fontSize:11, color:"#8A8480", marginTop:4 }}>{alertImp.label} · 预期 {fmtMin(alertTodo.duration)}</div>
              <div style={{ display:"flex", gap:8, marginTop:12 }}>
                <button onClick={()=>{
                  ackRemind(alertTodo.id); setView("main"); setTab("todo");
                  startTodo(alertTodo.id);
                }} style={{
                  flex:1.3, padding:"11px 0", borderRadius:13, border:"none",
                  background:`linear-gradient(135deg, ${alertImp.color}, ${alertImp.color}cc)`, color:"#FFF",
                  fontSize:14, fontWeight:600, cursor:"pointer", fontFamily:"inherit",
                  display:"flex", alignItems:"center", justifyContent:"center", gap:6,
                  boxShadow:`0 6px 18px ${hexA(alertImp.color,0.38)}`,
                }}><Ic.Play s={13}/>开始专注</button>
                <button onClick={()=>snoozeRemind(alertTodo.id, 10)} style={{
                  flex:1, padding:"11px 0", borderRadius:13, border:"1px solid rgba(255,255,255,0.16)",
                  background:"rgba(255,255,255,0.06)", color:"#CFC9C3",
                  fontSize:14, fontWeight:600, cursor:"pointer", fontFamily:"inherit",
                }}>稍后10分</button>
              </div>
            </div>
          </div>
        </div>
      )}
      {sheetTodo && (
        <ReminderSheet
          todo={sheetTodo}
          onSave={at => setRemindAt(sheetTodo.id, at)}
          onClear={() => clearRemind(sheetTodo.id)}
          onClose={() => setRemindFor(null)}
        />
      )}
    </>
  );

  const photoUI = (
    <>
      {viewPhoto && (
        <div onClick={()=>setViewPhoto(null)} style={{
          position:"fixed", inset:0, zIndex:9996, background:"rgba(20,18,16,0.94)",
          display:"flex", alignItems:"center", justifyContent:"center", padding:16,
          animation:"flashFade .2s ease both",
        }}>
          <FullPhoto id={viewPhoto}/>
        </div>
      )}
      {saveErr && (
        <div style={{
          position:"fixed", bottom:110, left:"50%", transform:"translateX(-50%)", zIndex:9995,
          background:"#C02556", color:"#FFF", padding:"11px 18px", borderRadius:14,
          fontSize:13, fontWeight:600, boxShadow:"0 8px 32px rgba(0,0,0,0.25)", whiteSpace:"nowrap",
        }}>⚠ {saveErr}</div>
      )}
    </>
  );

  // ── 项目：一页记录本 ──
  if (openProject) {
    const pr = data.projects.find(x => x.id === openProject);
    if (!pr) { setOpenProject(null); return null; }
    const recs = data.records.filter(r => r.projectId === pr.id).sort((a,b)=>b.at-a.at);
    const today = dayKeyOf(Date.now());
    const lastWeather = recs.find(r => dayKeyOf(r.at) === today && r.weather)?.weather
      || recs.find(r => r.weather)?.weather || "";

    if (projForm === pr.id) {
      return (
        <div className="app-shell" style={S.ctn}>
          <div style={{ padding:"52px 24px 8px", display:"flex", alignItems:"center", gap:12 }}>
            <button style={S.ib} onClick={()=>setProjForm(null)}><Ic.Back/></button>
            <span style={{ fontSize:20, fontWeight:700 }}>改项目名</span>
          </div>
          <div style={{ padding:"0 24px" }}>
            <ProjectForm initial={pr} onSave={saveProject} onCancel={()=>setProjForm(null)}/>
          </div>
          {timerUI}{remindUI}
          <style>{CSS}</style>
        </div>
      );
    }

    return (
      <div className="app-shell" style={S.ctn}>
        <div style={{ padding:"52px 24px 0" }}>
          <div style={{ display:"flex", alignItems:"center", gap:8 }}>
            <button style={S.ib} onClick={()=>setOpenProject(null)}><Ic.Back/></button>
            <span style={{ fontSize:20, fontWeight:700, flex:1, lineHeight:1.3 }}>{pr.name}</span>
            {/* 导师建的组级项目改不了也删不了——服务端本来就拒，界面上再给入口
                只会让本地删掉、推上去被拒、下一轮又拉回来，还会留下永远推不动的脏改动 */}
            {(!pr.ownerId || pr.ownerId === me?.id) ? (<>
              <button style={S.ib} onClick={()=>setProjForm(pr.id)}><Ic.Edit s={17}/></button>
              <button style={{ ...S.ib, color:"#DDD" }} onClick={()=>deleteProject(pr.id)}><Ic.Trash s={16}/></button>
            </>) : (
              <span style={{ fontSize:10.5, fontWeight:700, color:"#5B7FC7", background:"#EEF2FB",
                padding:"3px 8px", borderRadius:6 }}>组级项目</span>
            )}
          </div>
          <div style={{ fontSize:11, color:"#B0A99B", paddingLeft:34, marginBottom:16 }}>{recs.length} 条记录</div>
        </div>

        <div style={{ padding:"0 24px" }}>
          <Compose lastWeather={lastWeather} onSave={info => addRecord(pr.id, info)}/>
          {recs.map(r => (
            <RecordCard key={r.id} r={r} onSave={saveRecord} onDelete={deleteRecord} onOpenPhoto={setViewPhoto}
              thread={threadOf(cmtIndex, r.id)} meId={me?.id}
              onReply={(text)=>addComment(r.id, REPLY, text)} onDropComment={dropComment}/>
          ))}
          {recs.length === 0 && (
            <div style={{ padding:"20px 0", textAlign:"center", color:"#C5BEB0", fontSize:13 }}>还没有记录</div>
          )}
        </div>

        {timerUI}{remindUI}{photoUI}
        <style>{CSS}</style>
      </div>
    );
  }

  // ── Done History ──
  if (view === "done") {
    return (
      <div className="app-shell" style={S.ctn}>
        <div style={{ padding:"52px 24px 8px",display:"flex",alignItems:"center",gap:12 }}>
          <button style={S.ib} onClick={()=>setView("main")}><Ic.Back/></button>
          <span style={{ fontSize:20,fontWeight:700,flex:1 }}>完成记录</span>
          {/* Toggle list/week */}
          <button onClick={()=>setDoneViewMode(m=>m==="list"?"week":"list")} style={{
            ...S.ib, background: "#F0EDE6", padding: "8px 12px", borderRadius: 10, gap: 6,
            display: "flex", alignItems: "center",
          }}>
            {doneViewMode === "list" ? <Ic.Grid s={16}/> : <Ic.List s={16}/>}
            <span style={{ fontSize: 12, fontWeight: 600, color: "#666" }}>{doneViewMode === "list" ? "周视图" : "列表"}</span>
          </button>
        </div>

        <div style={{ padding: "8px 24px" }}>
          {doneViewMode === "week" ? (
            <WeeklyTable todos={data.todos} weekOffset={weekOffset} setWeekOffset={setWeekOffset} />
          ) : (
            <>
              {sortedDK.length===0 && <div style={S.empty}><div style={{fontSize:48}}>🎉</div><div style={{fontSize:16,color:"#AAA",fontWeight:500,marginTop:8}}>还没有完成的任务</div></div>}
              {sortedDK.map(dk => {
                const items = doneByDate[dk];
                const tAct = items.reduce((a,t)=>a+(t.actualDuration||0),0);
                return (
                  <div key={dk} style={{ marginBottom: 24 }}>
                    <div style={{ display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:10,padding:"10px 14px",background:"#F8F5EF",borderRadius:12 }}>
                      <span style={{ fontSize:16,fontWeight:700 }}>{fmtDay(new Date(dk).getTime())}</span>
                      <span style={{ fontSize:11,color:"#999" }}>{items.length}项 · 共{fmtSec(tAct)}</span>
                    </div>
                    {items.map(t => {
                      const imp = impOf(t);
                      const over = t.actualDuration > (t.duration||30)*60;
                      return (
                        <div key={t.id} style={{ padding: "12px 4px", borderBottom: "1px solid #F0EDE6" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                            <div style={{ width:8,height:8,borderRadius:4,background:imp.color,flexShrink:0 }}/>
                            <div style={{ flex:1 }}>
                              <div style={{ fontSize:14,color:"#666",textDecoration:"line-through" }}>
                                {t.parentId && <span style={{ color:"#CCC",marginRight:4 }}>↳</span>}{t.text}
                              </div>
                              <div style={{ fontSize:11,color:"#BBB",marginTop:3,display:"flex",gap:8 }}>
                                <span>预期{fmtMin(t.duration)}</span>
                                <span>实际{fmtSec(t.actualDuration||0)}</span>
                                {over && <span style={{color:"#3BA55C",fontWeight:600}}>+{fmtSec((t.actualDuration||0)-(t.duration||30)*60)}</span>}
                              </div>
                            </div>
                            <button style={{...S.ib,color:"#DDD"}} onClick={()=>deleteTodo(t.id)}><Ic.Trash s={14}/></button>
                          </div>
                          {/* Timeline detail */}
                          {t.timeline && t.timeline.length > 0 && (
                            <div style={{ marginLeft: 18, marginTop: 6, padding: "6px 10px", background: "#FAFAF7", borderRadius: 8 }}>
                              {t.timeline.map((ev, idx) => (
                                <div key={idx} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 10, color: "#AAA", padding: "2px 0" }}>
                                  <span style={{
                                    width: 6, height: 6, borderRadius: 3, flexShrink: 0,
                                    background: ev.type==="start"?"#5A9E4B":ev.type==="pause"?"#E8A838":ev.type==="resume"?"#5B7FC7":"#2C2C2C",
                                  }} />
                                  <span style={{ fontWeight: 600, width: 28 }}>
                                    {ev.type==="start"?"开始":ev.type==="pause"?"暂停":ev.type==="resume"?"恢复":"完成"}
                                  </span>
                                  <span style={{ fontFamily: "'SF Mono','Courier New',monospace" }}>{fmtBJFull(ev.at)}</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </>
          )}
        </div>
        {timerUI}
      {remindUI}
        <style>{CSS}</style>
      </div>
    );
  }

  // 导师视图是独立一屏，走在主视图之前。
  // photoUI 必须一起挂上——它是那个全屏看图的浮层，漏了的话导师点缩略图
  // 只是把 state 改了，屏幕上什么都不会发生。
  if (advisorOpen) {
    return (<>
      <AdvisorView data={data} onClose={()=>setAdvisorOpen(false)} onPhoto={setViewPhoto}
        actions={{ createProject: createGroupProject, setProjectMembers, addComment, dropComment }} />
      {photoUI}
      <style>{CSS}</style>
    </>);
  }

  // ── Main View ──
  return (
    <div className="app-shell" style={S.ctn}>
      <div style={{ padding:"52px var(--app-pad) 12px" }}>
        <div style={{ display:"flex",alignItems:"center",gap:10 }}>
          <span style={{ fontSize:28,color:"#E8A838" }}>✦</span>
          <span style={{ fontSize:28,fontWeight:700,letterSpacing:"-0.5px" }}>Mochi</span>
        </div>
        <div style={{ fontSize:14,color:"#999",marginTop:4,paddingLeft:38,fontFamily:"'Noto Serif SC',serif",
          display:"flex",alignItems:"baseline",gap:8 }}>
          {new Date().toLocaleDateString("zh-CN",{month:"long",day:"numeric",weekday:"long"})}
          <span style={{ fontSize:10,color:"#D6CFC2",fontFamily:MONO }} title="构建版本">{BUILD}</span>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display:"flex",gap:6,padding:"16px var(--app-pad) 8px",alignItems:"center" }}>
        {[["todo","待办",<Ic.Todo s={18} key="t"/>,allPending.length,"1"],["lab","记录",<Ic.Note s={18} key="n"/>,data.projects.length,"2"]].map(([k,l,ic,c,key])=>(
          <button key={k} onClick={()=>{setTab(k);setShowAdd(false);setEditingTodo(null);setAddSubParent(null);setProjForm(null);}}
            style={{...S.tab,...(tab===k?S.tabA:{})}}>{ic}<span>{l}</span>{c>0&&<span style={S.bdg}>{c}</span>}
            <span className="kbd-hint">{key}</span></button>
        ))}
        {done.length>0&&(
          <button onClick={()=>setView("done")} style={{...S.tab,marginLeft:"auto",gap:5,padding:"10px 14px"}}>
            <Ic.Cal s={15}/><span style={{fontSize:13}}>{done.length}</span>
          </button>
        )}
      </div>

      <div style={{ padding:"12px var(--app-pad)" }}>
        {tab==="todo"?(
          <>
            {showAdd && !addSubParent && <TaskForm onSave={info=>addTodo(info)} onCancel={()=>setShowAdd(false)} />}

            {pending.length===0 && !showAdd && (
              <div style={S.empty}>
                <div style={{fontSize:48}}>📋</div>
                <div style={{fontSize:17,fontWeight:600,color:"#AAA",marginTop:8}}>还没有待办事项</div>
                <div style={{fontSize:13,color:"#CCC",marginTop:4}}>点击右下角 + 添加任务</div>
              </div>
            )}

            {/* Sorted by importance, top-level only */}
            {[...pending].sort(impSort).map(t => renderTodo(t, 0))}
          </>
        ):(
          <>
            <SyncBar data={data} applySync={applySync} onOpenAdvisor={()=>setAdvisorOpen(true)} />
            {projForm === "new" && <ProjectForm onSave={saveProject} onCancel={()=>setProjForm(null)}/>}

            {data.projects.length===0 && projForm!=="new" && (
              <div style={S.empty}>
                <div style={{fontSize:48}}>🔬</div>
                <div style={{fontSize:17,fontWeight:600,color:"#AAA",marginTop:8}}>还没有项目</div>
                <div style={{fontSize:13,color:"#CCC",marginTop:4}}>点右下角 + 开一个</div>
              </div>
            )}

            <div className="proj-grid">
            {data.projects.map(pr => {
              const n = data.records.filter(r => r.projectId === pr.id).length;
              const last = data.records.filter(r => r.projectId === pr.id).reduce((m,r)=>Math.max(m,r.at),0);
              return (
                <div key={pr.id} onClick={()=>setOpenProject(pr.id)} className="pcard"
                  style={{ ...S.pcard, animation:"popIn .3s ease both" }}>
                  <div style={{ fontSize:15.5, fontWeight:600, lineHeight:1.35 }}>{pr.name}</div>
                  <div style={{ display:"flex", gap:7, marginTop:6, fontSize:11, color:"#B0A99B" }}>
                    <span>{n} 条记录</span>
                    {last > 0 && <><span>·</span><span>最后 {fmtDay(last)}</span></>}
                  </div>
                </div>
              );
            })}
            </div>

          </>
        )}
      </div>

      <button onClick={()=>{
        if (tab==="todo") { setShowAdd(true); setEditingTodo(null); setAddSubParent(null); }
        else setProjForm("new");
      }} style={S.fab} title="新建（N）">
        <Ic.Plus s={26}/>
      </button>

      {/* Celebration overlay */}
      {celebration && (
        <div style={{
          position:"fixed",inset:0,zIndex:9999,display:"flex",flexDirection:"column",
          alignItems:"center",justifyContent:"center",pointerEvents:"none",
        }}>
          {/* Backdrop flash */}
          <div style={{
            position:"absolute",inset:0,
            background:"radial-gradient(circle at 50% 40%, rgba(90,158,75,0.12) 0%, transparent 70%)",
            animation:"flashIn 0.3s ease both",
          }}/>
          {/* Confetti particles */}
          {Array.from({length:40}).map((_,i)=>{
            const x = Math.random()*100;
            const delay = Math.random()*0.4;
            const dur = 1.2+Math.random()*1;
            const size = 6+Math.random()*8;
            const colors = ["#5A9E4B","#E8A838","#C02556","#5B7FC7","#8B6AAF","#FF6B6B","#FFD93D","#6BCB77"];
            const c = colors[Math.floor(Math.random()*colors.length)];
            const rot = Math.random()*360;
            const drift = (Math.random()-0.5)*60;
            const shape = Math.random()>0.5;
            return <div key={i} style={{
              position:"absolute",top:"-5%",left:`${x}%`,
              width:size,height:shape?size:size*0.5,
              background:c,borderRadius:shape?"50%":"2px",
              opacity:0,transform:`rotate(${rot}deg)`,
              animation:`confettiFall ${dur}s ${delay}s ease-out forwards`,
              ["--drift"]:`${drift}px`,
            }}/>;
          })}
          {/* Burst ring */}
          <div style={{
            width:120,height:120,borderRadius:"50%",
            border:"3px solid #5A9E4B",opacity:0,
            animation:"burstRing 0.8s 0.1s ease-out forwards",
          }}/>
          {/* Message */}
          <div style={{
            marginTop:16,fontSize:28,fontWeight:800,color:"#2C2C2C",
            textAlign:"center",letterSpacing:"-0.5px",
            animation:"msgPop 0.5s 0.15s ease both",opacity:0,
            fontFamily:"'Outfit',sans-serif",
          }}>{celebration.msg}</div>
          <div style={{
            marginTop:8,fontSize:15,color:"#888",fontWeight:500,
            animation:"msgPop 0.5s 0.3s ease both",opacity:0,
            fontFamily:"'Outfit',sans-serif",
          }}>专注了 {fmtSec(celebration.elapsed)}</div>
        </div>
      )}

      {/* Cancelled timer toast */}
      {canceledTimer && (
        <div style={{
          position: "fixed", bottom: 110, left: "50%", transform: "translateX(-50%)",
          zIndex: 9999, background: "#2C2C2C", color: "#FFF",
          padding: "12px 20px", borderRadius: 16, fontSize: 14, fontWeight: 600,
          boxShadow: "0 8px 32px rgba(0,0,0,0.25)", whiteSpace: "nowrap",
          animation: "slideUp .3s ease both",
        }}>
          📵 离开超过5分钟，本次计时已取消
        </div>
      )}

      {/* Drag ghost overlay */}
      {dragFrom && (() => {
        const todo = data.todos.find(t => t.id === dragFrom);
        if (!todo) return null;
        const imp = impOf(todo);
        return (
          <div style={{
            position: "fixed", left: 16, right: 16,
            top: dragY - dragHalfH,
            zIndex: 1000, background: "#FDFBF7", borderRadius: 16,
            padding: "12px 16px",
            boxShadow: `0 16px 48px rgba(0,0,0,0.22), 0 0 0 2px ${imp.ring}`,
            transform: "scale(1.03)", pointerEvents: "none",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ width: 10, height: 10, borderRadius: "50%", background: imp.color, flexShrink: 0, boxShadow: `0 0 0 3px ${imp.ring}` }}/>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 15, fontWeight: 600, color: "#2C2C2C" }}>{todo.text}</div>
                <div style={{ display: "flex", gap: 6, marginTop: 3 }}>
                  <span style={{ fontSize: 10, color: imp.color, fontWeight: 600, background: imp.bg, padding: "2px 8px", borderRadius: 5 }}>{imp.label}</span>
                  <span style={{ fontSize: 10, color: "#BBB" }}>{fmtMin(todo.duration)}</span>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {timerUI}
      {remindUI}

      <style>{CSS}</style>
    </div>
  );
}

export const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@400;700&family=Outfit:wght@400;500;600;700&display=swap');

  /* 一处控制全局宽度：容器、悬浮条、提醒横幅、FAB 都跟着它走。
     断点压到 560px：桌面上窗口常常不是全屏，760 的门槛太高，
     很多人根本触发不到宽版就以为没生效。宽度用 min() 连续变化，
     不再是一跳一跳的。 */
  :root { --app-w: 430px; --app-pad: 24px; }
  @media (min-width: 560px)  { :root { --app-w: min(100% - 48px, 560px); --app-pad: 28px; } }
  @media (min-width: 800px)  { :root { --app-w: min(100% - 64px, 680px); --app-pad: 32px; } }
  @media (min-width: 1100px) { :root { --app-w: 780px; --app-pad: 40px; } }

  /* 桌面：鼠标悬停才露出行内操作，替代手机上的左滑 */
  @media (hover: hover) and (pointer: fine) {
    .row-acts { opacity: 0; transition: opacity .15s ease; }
    .todo-row:hover .row-acts { opacity: 1; }
    .todo-row:hover { background: #FAF7F1; }
    .hit:hover { background: #F0EDE6; }
    .kbd-hint { display: inline-flex; }
  }
  .kbd-hint { display: none; align-items: center; gap: 3px; font-size: 10px;
    color: #C0B8A8; border: 1px solid #E8E4DA; border-radius: 4px; padding: 1px 5px;
    font-family: ${"'JetBrains Mono','SF Mono',monospace"}; }
  .todo-row { transition: background .15s ease; border-radius: 10px; }

  /* 项目卡片：窄屏一列，宽屏铺成网格，别让卡片拉成一条 */
  .proj-grid { display: grid; grid-template-columns: 1fr; gap: 10px; }
  @media (min-width: 560px) {
    .proj-grid { grid-template-columns: repeat(auto-fill, minmax(224px, 1fr)); }
    .proj-grid > * { margin-bottom: 0 !important; }
  }
  .pcard { transition: transform .15s ease, box-shadow .15s ease; }

  /* 导师端：成员/项目卡片。窄屏一列，宽屏铺网格——导师多半在电脑上看 */
  .adv-grid { display: grid; grid-template-columns: 1fr; gap: 10px; padding-bottom: 20px; }
  @media (min-width: 560px) { .adv-grid { grid-template-columns: repeat(auto-fill, minmax(248px, 1fr)); } }
  .adv-card { transition: border-color .15s ease, box-shadow .15s ease, transform .15s ease; }
  @media (hover: hover) and (pointer: fine) {
    .adv-card:hover { border-color: #D9D2C4 !important; transform: translateY(-1px);
      box-shadow: 0 6px 18px rgba(120,100,70,.07); }
  }
  @media (hover: hover) and (pointer: fine) {
    .pcard:hover { transform: translateY(-2px); box-shadow: 0 8px 22px rgba(0,0,0,.07); }
  }
  * { box-sizing:border-box; margin:0; padding:0; -webkit-tap-highlight-color:transparent; }

  /* 手机上容器占满宽度，看不出 body 的底色；Mac 上容器居中后两侧会露出来，
     不设的话就是浏览器默认的白，和暖米色的容器形成一道明显色差。 */
  html, body { background: #F4EFE6; }
  @media (min-width: 560px) {
    /* 宽屏下让内容区像一张浮起来的纸，边界清楚但不喧宾夺主 */
    .app-shell {
      box-shadow: 0 0 0 1px rgba(0,0,0,.035), 0 6px 40px rgba(120,100,70,.08);
      border-radius: 18px;
      margin-top: 18px !important;
      margin-bottom: 18px !important;
      min-height: calc(100vh - 36px) !important;
    }
  }
  /* 桌面上滚动条收细一点，别把纸的边缘顶开 */
  @media (hover: hover) and (pointer: fine) {
    ::-webkit-scrollbar { width: 10px; height: 10px; }
    ::-webkit-scrollbar-thumb { background: #DCD5C8; border-radius: 6px;
      border: 3px solid transparent; background-clip: content-box; }
    ::-webkit-scrollbar-thumb:hover { background: #C9C0AF; background-clip: content-box; }
    ::-webkit-scrollbar-track { background: transparent; }
  }
  @keyframes slideUp { from{opacity:0;transform:translateY(12px)} to{opacity:1;transform:translateY(0)} }
  @keyframes popIn { from{opacity:0;transform:scale(.92)} to{opacity:1;transform:scale(1)} }
  @keyframes fabPulse { 0%,100%{box-shadow:0 4px 20px rgba(51,51,51,.25)} 50%{box-shadow:0 4px 30px rgba(51,51,51,.4)} }
  @keyframes runPulse { 0%,100%{opacity:1;box-shadow:0 0 0 0 rgba(90,158,75,.55)} 50%{opacity:.65;box-shadow:0 0 0 5px rgba(90,158,75,0)} }
  .run-pulse { animation: runPulse 1.8s ease-in-out infinite; }
  .run-strip::-webkit-scrollbar { display:none; }
  @keyframes confettiFall {
    0% { opacity:1; transform:translateY(0) translateX(0) rotate(0deg) scale(0.5); }
    20% { opacity:1; transform:translateY(20vh) translateX(var(--drift)) rotate(180deg) scale(1); }
    100% { opacity:0; transform:translateY(105vh) translateX(var(--drift)) rotate(720deg) scale(0.6); }
  }
  @keyframes burstRing {
    0% { transform:scale(0.3); opacity:0.8; }
    100% { transform:scale(2.5); opacity:0; }
  }
  @keyframes flashIn {
    0% { opacity:0; } 30% { opacity:1; } 100% { opacity:0; }
  }
  @keyframes msgPop {
    0% { opacity:0; transform:scale(0.6) translateY(10px); }
    50% { opacity:1; transform:scale(1.08) translateY(-2px); }
    100% { opacity:1; transform:scale(1) translateY(0); }
  }
  input:focus,textarea:focus { border-color:#C8BFA8!important; }
  @keyframes slideDown { from{opacity:0;transform:translateY(-14px)} to{opacity:1;transform:translateY(0)} }
  @keyframes sheetUp { from{transform:translateY(100%)} to{transform:translateY(0)} }
  @keyframes flashFade { from{opacity:0} to{opacity:1} }

  /* 点赞：弹一下再落回。回弹曲线比线性有"手感"，但幅度压在 1.4 倍以内——
     这是个每天点几十次的按钮，动静太大会烦。 */
  @keyframes likePop { 0%{transform:scale(1)} 35%{transform:scale(1.4)}
    62%{transform:scale(.92)} 100%{transform:scale(1)} }
  .like-pop { display:inline-block; animation: likePop .42s cubic-bezier(.34,1.56,.64,1) both; }
  /* 标已读：整条淡下去，不是消失。手还停在那儿，列表却跳一格是最容易点错的。 */
  .read-fade { transition: opacity .38s ease, filter .38s ease; }

  /* ── Reminder light ──────────────────────────────────────────────
     Layers, back to front: a warm wash anchored at the left edge, a fine
     grain for material, a hairline ring, the sweeping sheen, and a comet
     tracing the top edge in sync. One sweep per cycle, then the row rests. */
  .rmd { position:absolute; inset:2px 0; z-index:0; pointer-events:none; overflow:hidden; border-radius:14px; }
  .rmd-wash, .rmd-grain, .rmd-ring { position:absolute; inset:0; }
  .rmd-ring { border-radius:14px; }
  .rmd-grain {
    opacity:.055; mix-blend-mode:multiply; background-size:110px 110px;
    background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='110' height='110'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='110' height='110' filter='url(%23n)'/%3E%3C/svg%3E");
  }
  .rmd-sheen {
    position:absolute; top:-40%; bottom:-40%; left:0; width:44%;
    transform:translate3d(-100%,0,0) skewX(-16deg);
    animation:rmdSweep var(--sweep,3.8s) cubic-bezier(.4,0,.22,1) infinite;
    will-change:transform;
  }
  .rmd-sheen-dark { mix-blend-mode:screen; }
  .rmd-edge { position:absolute; left:0; right:0; top:0; height:1.5px; overflow:hidden; }
  .rmd-comet {
    position:absolute; top:0; bottom:0; left:0; width:32%;
    transform:translate3d(-100%,0,0);
    animation:rmdComet var(--sweep,3.8s) cubic-bezier(.4,0,.22,1) infinite;
    will-change:transform;
  }
  @keyframes rmdSweep {
    0%   { transform:translate3d(-100%,0,0) skewX(-16deg); }
    34%  { transform:translate3d(230%,0,0) skewX(-16deg); }
    100% { transform:translate3d(230%,0,0) skewX(-16deg); }
  }
  @keyframes rmdComet {
    0%   { transform:translate3d(-100%,0,0); }
    34%  { transform:translate3d(315%,0,0); }
    100% { transform:translate3d(315%,0,0); }
  }
  .rmd-dot { animation:rmdDot var(--sweep,3.8s) ease-in-out infinite; }
  @keyframes rmdDot { 0%,100%{transform:scale(1)} 50%{transform:scale(1.16)} }
  .rmd-chip {
    display:inline-flex; align-items:center; gap:3px; font-size:10px; font-weight:600;
    padding:2px 7px; border-radius:5px; cursor:pointer; font-family:inherit; line-height:1.7;
  }
  .rmd-chip-hot { animation:rmdChipPulse 1.3s ease-in-out infinite; }
  @keyframes rmdChipPulse { 0%,100%{opacity:1} 50%{opacity:.45} }
  @media (prefers-reduced-motion: reduce) {
    .rmd-sheen, .rmd-comet, .rmd-dot, .rmd-chip-hot { animation:none; }
    .rmd-sheen { transform:translate3d(6%,0,0) skewX(-16deg); opacity:.5; }
    .rmd-comet { transform:translate3d(0,0,0); }
  }
`;

const S = {
  ctn:{fontFamily:"'Outfit','Noto Serif SC',sans-serif",background:"#FDFBF7",minHeight:"100vh",maxWidth:"var(--app-w)",margin:"0 auto",position:"relative",paddingBottom:100,color:"#2C2C2C",overflowX:"hidden"},
  tab:{display:"flex",alignItems:"center",gap:6,padding:"10px 18px",borderRadius:24,border:"none",background:"#F0EDE6",color:"#888",fontSize:15,fontWeight:500,cursor:"pointer",transition:"all .25s",fontFamily:"inherit"},
  tabA:{background:"#2C2C2C",color:"#FFF"},
  bdg:{background:"#E8A838",color:"#FFF",fontSize:11,fontWeight:600,borderRadius:10,padding:"1px 7px",marginLeft:2},
  ib:{background:"none",border:"none",cursor:"pointer",display:"flex",alignItems:"center",padding:6,borderRadius:10,color:"#555"},
  actBtn:{width:38,height:38,borderRadius:12,border:"none",background:"#F2EFE8",color:"#999",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",flexShrink:0},
  fab:{position:"fixed",bottom:32,right:"max(24px, calc(50% - var(--app-w) / 2 + 24px))",width:56,height:56,borderRadius:"50%",border:"none",background:"#2C2C2C",color:"#FFF",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",animation:"fabPulse 3s ease infinite",zIndex:100},
  empty:{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",paddingTop:80,gap:4},
  edH:{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"52px 20px 12px"},
  neT:{fontSize:26,fontWeight:700,border:"none",background:"transparent",outline:"none",fontFamily:"'Outfit',sans-serif",letterSpacing:"-0.5px",width:"100%"},
  inp:{width:"100%",padding:"12px 14px",borderRadius:12,border:"2px solid #E8E4DA",fontSize:14.5,fontFamily:"inherit",background:"#FFF",outline:"none",color:"#2C2C2C",boxSizing:"border-box"},
  lbl:{fontSize:12,color:"#999",marginBottom:8,fontWeight:600,letterSpacing:"0.5px"},
  btnGhost:{flex:1,padding:"13px 0",borderRadius:14,border:"2px solid #E0DCD3",background:"#FFF",color:"#888",fontSize:15,fontWeight:600,cursor:"pointer",fontFamily:"inherit"},
  btnDark:{flex:1,padding:"13px 0",borderRadius:14,border:"none",background:"#2C2C2C",color:"#FFF",fontSize:15,fontWeight:600,cursor:"pointer",fontFamily:"inherit"},
  mini:{padding:"6px 11px",borderRadius:9,border:"1px solid #E4E0D7",background:"#FFF",color:"#8C8478",fontSize:11.5,fontWeight:600,cursor:"pointer",fontFamily:"inherit"},
  miniD:{padding:"6px 11px",borderRadius:9,border:"none",background:"#2C2C2C",color:"#FFF",fontSize:11.5,fontWeight:600,cursor:"pointer",fontFamily:"inherit"},
  pcard:{background:"#FFF",border:"1px solid #EDE8DE",borderRadius:14,padding:"13px 14px",marginBottom:9,cursor:"pointer"},
  grp:{fontSize:10.5,fontWeight:700,letterSpacing:"0.9px",color:"#B0A99B",margin:"18px 0 9px"},
  neB:{fontSize:16,lineHeight:1.8,border:"none",background:"transparent",outline:"none",fontFamily:"'Noto Serif SC',serif",color:"#444",resize:"none",minHeight:"60vh",width:"100%",marginTop:12},
};
