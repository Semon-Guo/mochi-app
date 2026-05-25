import { useState, useEffect, useRef, useMemo } from "react";

const SK = "mochi_v3";
const TIMER_SK = "mochi_timer";
const BG_TS_SK = "mochi_bg_ts";
const BG_LIMIT_SEC = 5 * 60;
function saveTimerSession(todoId, startTs, baseElapsed) { try { localStorage.setItem(TIMER_SK, JSON.stringify({ todoId, startTs, baseElapsed })); } catch {} }
function clearTimerSession() { try { localStorage.removeItem(TIMER_SK); localStorage.removeItem(BG_TS_SK); } catch {} }
function loadAll() {
  let data = { todos: [], notes: [] };
  let activeTodoId = null;
  try { const r = localStorage.getItem(SK); if (r) data = JSON.parse(r); } catch {}
  try {
    const s = localStorage.getItem(TIMER_SK);
    if (s) {
      const { todoId, startTs, baseElapsed } = JSON.parse(s);
      const elapsedNow = baseElapsed + Math.floor((Date.now() - startTs) / 1000);
      data = { ...data, todos: data.todos.map(t => t.id === todoId ? { ...t, elapsed: elapsedNow } : t) };
      activeTodoId = todoId;
    }
  } catch {}
  return { data, activeTodoId };
}
function save(d) { try { localStorage.setItem(SK, JSON.stringify(d)); } catch {} }
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

// Beijing time helpers
function bjNow() { return new Date(Date.now() + (8 * 3600000) + (new Date().getTimezoneOffset() * 60000)); }
function toBJ(ts) { return new Date(ts + (8 * 3600000) + (new Date().getTimezoneOffset() * 60000)); }
function fmtBJ(ts) { const d = toBJ(ts); return `${d.getHours().toString().padStart(2,"0")}:${d.getMinutes().toString().padStart(2,"0")}`; }
function fmtBJFull(ts) { const d = toBJ(ts); return `${d.getMonth()+1}/${d.getDate()} ${d.getHours().toString().padStart(2,"0")}:${d.getMinutes().toString().padStart(2,"0")}:${d.getSeconds().toString().padStart(2,"0")}`; }
function fmtDay(ts) { const d = toBJ(ts); const t = bjNow(); const y = new Date(t); y.setDate(y.getDate()-1); if (d.toDateString()===t.toDateString()) return "今天"; if (d.toDateString()===y.toDateString()) return "昨天"; return `${d.getMonth()+1}月${d.getDate()}日`; }
function fmtSec(s) { if (s == null) return "00:00"; const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),sec=s%60; if(h>0) return `${h}:${m.toString().padStart(2,"0")}:${sec.toString().padStart(2,"0")}`; return `${m.toString().padStart(2,"0")}:${sec.toString().padStart(2,"0")}`; }
function fmtMin(m) { if(!m) return "30m"; if(m>=60) return `${Math.floor(m/60)}h${m%60>0?(m%60+"m"):""}`; return `${m}m`; }

const URG = [
  { key:"low", label:"轻松", color:"#5A9E4B", bg:"#EEFAE9", ring:"#B6E2A8" },
  { key:"medium", label:"一般", color:"#E8A838", bg:"#FFF6E5", ring:"#F5D48B" },
  { key:"critical", label:"火烧", color:"#C02556", bg:"#FDEBF0", ring:"#E88DA8" },
];
const UM = Object.fromEntries(URG.map(u=>[u.key,u]));

const NC = [
  {bg:"#FFF8E7",accent:"#E8A838"},{bg:"#F0F7EE",accent:"#5A9E4B"},
  {bg:"#EEF2FA",accent:"#5B7FC7"},{bg:"#FBF0F0",accent:"#D4696A"},
  {bg:"#F5F0FA",accent:"#8B6AAF"},{bg:"#F0F8F8",accent:"#4A9A96"},
];

const WDAYS = ["周一","周二","周三","周四","周五","周六","周日"];
const HOURS = Array.from({length:17},(_,i)=>i+9); // 9:00~25:00 (24=0:00, 25=1:00 next day)

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
};

/* ── Focus Timer ── */
function FocusTimer({ todo, onComplete, onPause, onUpdate, onCancel }) {
  const [elapsed, setElapsed] = useState(() => {
    try {
      const s = localStorage.getItem(TIMER_SK);
      if (s) {
        const { todoId, startTs, baseElapsed } = JSON.parse(s);
        if (todoId === todo.id) return baseElapsed + Math.floor((Date.now() - startTs) / 1000);
      }
    } catch {}
    return todo.elapsed || 0;
  });
  const [running, setRunning] = useState(true);
  const [bgAlert, setBgAlert] = useState(null); // { hiddenSec }
  const iv = useRef(null);
  const stRef = useRef(Date.now());
  const base = useRef(todo.elapsed || 0);
  const startTs = todo.timeline?.find(e => e.type === "start")?.at || Date.now();

  useEffect(() => {
    stRef.current = Date.now();
    base.current = elapsed; // use restored elapsed, not todo.elapsed
    iv.current = setInterval(() => {
      setElapsed(base.current + Math.floor((Date.now() - stRef.current) / 1000));
    }, 250);
    return () => { if (iv.current) clearInterval(iv.current); };
  }, []);

  // Track background time; cancel session if away > BG_LIMIT_SEC
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        try { localStorage.setItem(BG_TS_SK, Date.now().toString()); } catch {}
        return;
      }
      if (document.visibilityState !== 'visible') return;

      // Check how long app was in background
      try {
        const bgTs = localStorage.getItem(BG_TS_SK);
        if (bgTs) {
          const hiddenSec = Math.floor((Date.now() - parseInt(bgTs, 10)) / 1000);
          localStorage.removeItem(BG_TS_SK);
          if (hiddenSec > BG_LIMIT_SEC) {
            if (iv.current) clearInterval(iv.current);
            setBgAlert({ hiddenSec });
            return;
          }
        }
      } catch {}

      // Normal re-sync after short background
      try {
        const s = localStorage.getItem(TIMER_SK);
        if (!s) return;
        const { todoId, startTs, baseElapsed } = JSON.parse(s);
        if (todoId !== todo.id) return;
        const restoredElapsed = baseElapsed + Math.floor((Date.now() - startTs) / 1000);
        base.current = restoredElapsed;
        stRef.current = Date.now();
        setElapsed(restoredElapsed);
      } catch {}
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [todo.id]);

  const doResumeFocus = () => {
    try {
      const s = localStorage.getItem(TIMER_SK);
      if (s) {
        const { todoId, startTs: savedTs, baseElapsed } = JSON.parse(s);
        if (todoId === todo.id) {
          const restoredElapsed = baseElapsed + Math.floor((Date.now() - savedTs) / 1000);
          base.current = restoredElapsed;
          stRef.current = Date.now();
          setElapsed(restoredElapsed);
        }
      }
    } catch {}
    iv.current = setInterval(() => {
      setElapsed(base.current + Math.floor((Date.now() - stRef.current) / 1000));
    }, 250);
    setBgAlert(null);
  };

  const doCancelFocus = () => {
    setBgAlert(null);
    onCancel();
  };

  const doPause = () => {
    setRunning(false);
    if (iv.current) clearInterval(iv.current);
    const cur = base.current + Math.floor((Date.now() - stRef.current) / 1000);
    setElapsed(cur);
    onPause(cur);
  };

  const doResume = () => {
    setRunning(true);
    stRef.current = Date.now();
    base.current = elapsed;
    iv.current = setInterval(() => {
      setElapsed(base.current + Math.floor((Date.now() - stRef.current) / 1000));
    }, 250);
    onUpdate("resume");
  };

  const doFinish = () => {
    if (iv.current) clearInterval(iv.current);
    const cur = base.current + Math.floor((Date.now() - stRef.current) / 1000);
    onComplete(running ? cur : elapsed);
  };

  const urg = UM[todo.urgency] || URG[0];
  const expected = (todo.duration || 30) * 60;
  const isOver = elapsed > expected;

  return (
    <div style={{ padding: "14px 0 8px", animation: "slideUp .3s ease both" }}>
      {/* Start time */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, marginBottom: 14 }}>
        <div style={{ fontSize: 11, color: "#AAA", letterSpacing: "0.5px" }}>开始于</div>
        <div style={{
          fontSize: 18, fontWeight: 700, color: urg.color,
          fontFamily: "'JetBrains Mono','SF Mono','Courier New',monospace",
          letterSpacing: "1.5px", background: urg.bg, padding: "4px 14px", borderRadius: 10,
        }}>{fmtBJ(startTs)}</div>
      </div>

      {/* Timer display */}
      <div style={{
        display: "flex", alignItems: "baseline", justifyContent: "center", gap: 8,
        padding: "18px 0", borderRadius: 20,
        background: isOver ? "linear-gradient(135deg, #E8F9ED, #F0FFF4)" : `linear-gradient(135deg, ${urg.bg}, #FDFBF7)`,
        marginBottom: 14,
      }}>
        <span style={{ fontSize: 15, color: "#999", fontWeight: 500 }}>已专注：</span>
        <span style={{
          fontSize: 36, fontWeight: 800, letterSpacing: "3px",
          fontFamily: "'JetBrains Mono','SF Mono','Courier New',monospace",
          color: isOver ? "#3BA55C" : urg.color,
        }}>{fmtSec(elapsed)}</span>
      </div>

      {/* Info row */}
      <div style={{ display: "flex", justifyContent: "center", gap: 16, fontSize: 12, color: "#AAA", marginBottom: 16 }}>
        <span>目标 {fmtMin(todo.duration)}</span>
        {isOver && <span style={{ color: "#3BA55C", fontWeight: 600 }}>+{fmtSec(elapsed - expected)}</span>}
        {!running && <span style={{ color: "#E8A838", fontWeight: 600 }}>⏸ 已暂停</span>}
      </div>

      {/* Controls */}
      <div style={{ display: "flex", gap: 10 }}>
        {running ? (
          <button onClick={doPause} style={{
            flex: 1, padding: "14px 0", borderRadius: 16, border: `2px solid ${urg.ring}`,
            background: "#FFF", color: urg.color, fontSize: 15, fontWeight: 600,
            fontFamily: "inherit", cursor: "pointer", display: "flex", alignItems: "center",
            justifyContent: "center", gap: 8,
          }}><Ic.Pause s={16}/> 暂停</button>
        ) : (
          <button onClick={doResume} style={{
            flex: 1, padding: "14px 0", borderRadius: 16, border: "none",
            background: `linear-gradient(135deg, ${urg.color}, ${urg.color}dd)`, color: "#FFF",
            fontSize: 15, fontWeight: 600, fontFamily: "inherit", cursor: "pointer",
            display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
            boxShadow: `0 4px 16px ${urg.color}44`,
          }}><Ic.Play s={16}/> 恢复</button>
        )}
        <button onClick={doFinish} style={{
          flex: 1, padding: "14px 0", borderRadius: 16, border: "none",
          background: "#2C2C2C", color: "#FFF", fontSize: 15, fontWeight: 600,
          fontFamily: "inherit", cursor: "pointer", display: "flex", alignItems: "center",
          justifyContent: "center", gap: 8, boxShadow: "0 4px 16px rgba(0,0,0,0.15)",
        }}><Ic.Check s={16}/> 完成</button>
      </div>

      {/* Background alert dialog */}
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
            <div style={{ fontSize: 14, color: "#888", textAlign: "center", marginBottom: 24, lineHeight: 1.6 }}>
              是锁屏专注，还是在玩手机？
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <button onClick={doResumeFocus} style={{
                padding: "14px 0", borderRadius: 16, border: "none",
                background: "#2C2C2C", color: "#FFF", fontSize: 15, fontWeight: 600,
                fontFamily: "inherit", cursor: "pointer",
              }}>🔒 锁屏专注，继续计时</button>
              <button onClick={doCancelFocus} style={{
                padding: "14px 0", borderRadius: 16, border: "2px solid #F0EDE6",
                background: "#FFF", color: "#C02556", fontSize: 15, fontWeight: 600,
                fontFamily: "inherit", cursor: "pointer",
              }}>📱 在玩手机，取消本次</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Task Form ── */
function TaskForm({ initial, onSave, onCancel, isSubtask }) {
  const [text, setText] = useState(initial?.text || "");
  const [duration, setDuration] = useState(initial?.duration || 30);
  const [urgency, setUrgency] = useState(initial?.urgency || "medium");
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
  return (
    <div ref={formRef} style={{ animation: "slideUp .3s ease both", padding: "12px 0 16px", marginLeft: isSubtask ? 24 : 0 }}>
      {isSubtask && <div style={{ fontSize: 12, color: "#999", marginBottom: 6, fontWeight: 600 }}>↳ 添加子任务</div>}
      <input ref={ref} value={text} onChange={e=>setText(e.target.value)}
        placeholder={isSubtask ? "子任务名称..." : "任务名称..."}
        onKeyDown={e=>{if(e.key==="Enter"&&text.trim()) onSave({text:text.trim(),duration,urgency});}}
        style={{ width:"100%",padding:"14px 16px",borderRadius:14,border:"2px solid #E8E4DA",fontSize:15,fontFamily:"inherit",background:"#FFF",outline:"none",color:"#2C2C2C",boxSizing:"border-box" }}
      />
      <div style={{ marginTop: 12 }}>
        <div style={{ fontSize: 12, color: "#999", marginBottom: 8, fontWeight: 600, letterSpacing: "0.5px" }}>紧迫度</div>
        <div style={{ display: "flex", gap: 6 }}>
          {URG.map(u=>(
            <button key={u.key} onClick={()=>setUrgency(u.key)} style={{
              flex:1,padding:"9px 0",borderRadius:12,
              border:urgency===u.key?`2.5px solid ${u.color}`:"2.5px solid transparent",
              background:u.bg,color:u.color,fontSize:12,fontWeight:600,
              cursor:"pointer",fontFamily:"inherit",transition:"all .2s",
              transform:urgency===u.key?"scale(1.05)":"scale(1)",
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
      <div style={{ display:"flex",gap:10,marginTop:16 }}>
        <button onClick={onCancel} style={{flex:1,padding:"13px 0",borderRadius:14,border:"2px solid #E0DCD3",background:"#FFF",color:"#888",fontSize:15,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>取消</button>
        <button onClick={()=>{if(text.trim()) onSave({text:text.trim(),duration,urgency});}} style={{flex:1,padding:"13px 0",borderRadius:14,border:"none",background:"#2C2C2C",color:"#FFF",fontSize:15,fontWeight:600,cursor:"pointer",fontFamily:"inherit",opacity:text.trim()?1:0.4}}>保存</button>
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

  // Filter done todos in this week
  const weekTodos = todos.filter(t => {
    if (!t.done || !t.timeline?.length) return false;
    const st = t.timeline.find(e => e.type === "start");
    if (!st) return false;
    const d = toBJ(st.at);
    return d >= monday && d <= sunday;
  });

  // Build blocks: each todo → {dayIdx 0-6, startHour (float), durationHours, text, color}
  const blocks = weekTodos.map(t => {
    const st = t.timeline.find(e => e.type === "start");
    const d = toBJ(st.at);
    const dayIdx = (d.getDay() === 0 ? 6 : d.getDay() - 1);
    const startH = d.getHours() + d.getMinutes() / 60;
    const durSec = t.actualDuration || (t.duration || 30) * 60;
    const durH = Math.max(durSec / 3600, 0.25);
    const urg = UM[t.urgency] || URG[0];
    return { dayIdx, startH, durH, text: t.text, color: urg.color, bg: urg.bg };
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
            {blocks.map((b,i)=>{
              const virtualH = b.startH < 9 ? b.startH + 24 : b.startH; // 0:00→24, 1:00→25, 2:00→26
              if (virtualH < 9 || virtualH >= 26) return null;
              const top = (virtualH - 9) * ROW_H;
              const height = Math.max(b.durH * ROW_H, 22);
              const left = `calc(36px + ${b.dayIdx} * ((100% - 36px) / 7) + 2px)`;
              const width = `calc((100% - 36px) / 7 - 4px)`;
              return (
                <div key={i} style={{
                  position:"absolute", top, left, width, height: Math.min(height, (26 - virtualH) * ROW_H),
                  background: `linear-gradient(135deg, ${b.color}ee, ${b.color}bb)`,
                  borderRadius: 6, padding: "3px 5px", overflow: "hidden",
                  fontSize: 10, fontWeight: 600, color: "#FFF", lineHeight: 1.3,
                  boxShadow: `0 2px 8px ${b.color}33`,
                  cursor: "default",
                }}>
                  <div style={{ overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{b.text}</div>
                  {height > 28 && <div style={{ fontSize: 9, opacity: 0.8, marginTop: 1 }}>{Math.round(b.durH * 60)}m</div>}
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
function TodoRow({ t, depth, activeTodo, setActiveTodo, setEditingTodo, setShowAdd,
  deleteTodo, startTodo, onAddSub, expandedIds, toggleExpand, children: subs, allTodos,
  completeTodo, pauseTodo, resumeTodo, cancelTodo, updateElapsed, dragFrom, dragOver, onDragStart }) {
  const urg = UM[t.urgency] || URG[0];
  const isActive = activeTodo === t.id;
  const kidTodos = allTodos.filter(c => c.parentId === t.id);
  const hasKids = kidTodos.length > 0;
  const expanded = expandedIds.has(t.id);
  const lastEvt = t.timeline?.[t.timeline.length - 1];
  const isPaused = lastEvt?.type === "pause";
  const isDragging = dragFrom === t.id;
  const isDragOver = dragOver === t.id && dragFrom !== t.id;

  const REVEAL = 72;
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
    setTx(Math.max(-REVEAL, Math.min(REVEAL, swipe.current.baseTx + dx)));
  };
  const onSwipeEnd = () => {
    if (!swipe.current.moving) {
      if (Math.abs(tx) > 10) setTx(0);
      swipe.current = { ...swipe.current, active: false };
      return;
    }
    swipe.current = { ...swipe.current, active: false, moving: false };
    setTx(prev => prev < -REVEAL * 0.5 ? -REVEAL : prev > REVEAL * 0.5 ? REVEAL : 0);
  };
  const closeSwipe = () => setTx(0);

  return (
    <>
      <div
        data-todo-id={t.id}
        style={{
          position: "relative", overflow: "hidden",
          borderBottom: "1px solid #F0EDE6",
          borderTop: isDragOver ? "2px solid #E8A838" : undefined,
          paddingLeft: depth * 24,
          opacity: isDragging ? 0.25 : 1,
          transition: "opacity 0.15s",
          animation: "slideUp .3s ease both",
        }}
      >
        {/* Delete action – right side (swipe left to reveal) */}
        <div style={{
          position: "absolute", right: 0, top: 0, bottom: 0, width: REVEAL,
          background: "#FF3B30", display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <button onClick={() => { closeSwipe(); deleteTodo(t.id); }} style={{
            background: "none", border: "none", color: "#FFF", cursor: "pointer",
            display: "flex", flexDirection: "column", alignItems: "center", gap: 3, padding: 8,
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
            transform: `translateX(${tx}px)`,
            transition: swipe.current.moving ? "none" : "transform 0.25s cubic-bezier(0.25,1,0.5,1)",
            background: "#FDFBF7",
            padding: "4px 0",
          }}
          onTouchStart={onSwipeStart}
          onTouchMove={onSwipeMove}
          onTouchEnd={onSwipeEnd}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 0" }}>
            {/* Urgency dot */}
            <div style={{ width: depth ? 8 : 10, height: depth ? 8 : 10, borderRadius: "50%", background: urg.color, flexShrink: 0, boxShadow: `0 0 0 ${depth?2:3}px ${urg.ring}` }} />
            {/* Content */}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: depth ? 14 : 15, lineHeight: 1.4, color: "#2C2C2C", display: "flex", alignItems: "center", gap: 6 }}>
                {depth > 0 && <span style={{ color: "#CCC", fontSize: 12 }}>↳</span>}
                {t.text}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4, flexWrap: "wrap" }}>
                <span style={{ fontSize: 10, color: urg.color, fontWeight: 600, background: urg.bg, padding: "2px 8px", borderRadius: 5 }}>{urg.label}</span>
                <span style={{ fontSize: 10, color: "#BBB", display: "flex", alignItems: "center", gap: 2 }}><Ic.Clock s={10}/>{fmtMin(t.duration)}</span>
                {t.elapsed > 0 && !isActive && <span style={{ fontSize: 10, color: "#AAA" }}>已用{fmtSec(t.elapsed)}</span>}
                {isPaused && !isActive && <span style={{ fontSize: 10, color: "#E8A838", fontWeight: 600 }}>⏸暂停中</span>}
                {hasKids && <span style={{ fontSize: 10, color: "#BBB" }}>{kidTodos.filter(c=>c.done).length}/{kidTodos.length}子任务</span>}
              </div>
            </div>
            {/* Expand toggle */}
            {hasKids && (
              <button style={S.ib} onClick={() => toggleExpand(t.id)}>
                {expanded ? <Ic.Up s={14}/> : <Ic.Down s={14}/>}
              </button>
            )}
            {/* Actions */}
            {!depth && <button style={{ ...S.ib, color: "#CCC" }} onClick={() => { closeSwipe(); onAddSub(t.id); }} title="拆解"><Ic.Split s={14}/></button>}
            <button style={{ ...S.ib, color: "#CCC" }} onClick={() => { closeSwipe(); setEditingTodo(t.id); setShowAdd(false); }}><Ic.Edit s={14}/></button>
            {!isActive && !isPaused && (
              <button onClick={() => startTodo(t.id)} style={{
                width: 34, height: 34, borderRadius: 10, border: "none",
                background: `linear-gradient(135deg,${urg.bg},${urg.ring}55)`,
                color: urg.color, display: "flex", alignItems: "center", justifyContent: "center",
                cursor: "pointer",
              }}><Ic.Play s={13}/></button>
            )}
            {isPaused && !isActive && (
              <button onClick={() => resumeTodo(t.id)} style={{
                width: 34, height: 34, borderRadius: 10, border: "none",
                background: `linear-gradient(135deg,${urg.bg},${urg.ring}55)`,
                color: urg.color, display: "flex", alignItems: "center", justifyContent: "center",
                cursor: "pointer",
              }}><Ic.Play s={13}/></button>
            )}
          </div>
          {/* Active timer */}
          {isActive && (
            <FocusTimer
              todo={t}
              onComplete={el => completeTodo(t.id, el)}
              onPause={el => pauseTodo(t.id, el)}
              onUpdate={type => { if (type === "resume") resumeTodo(t.id); }}
              onCancel={() => cancelTodo(t.id)}
            />
          )}
        </div>
      </div>
      {/* Children */}
      {expanded && subs}
    </>
  );
}

/* ── Main App ── */
export default function MochiApp() {
  const [initState] = useState(loadAll);
  const [data, setData] = useState(initState.data);
  const [tab, setTab] = useState("todo");
  const [editingNote, setEditingNote] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [addSubParent, setAddSubParent] = useState(null);
  const [editingTodo, setEditingTodo] = useState(null);
  const [activeTodo, setActiveTodo] = useState(initState.activeTodoId);
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
  const dragFromRef = useRef(null);
  const dragOverRef = useRef(null);
  const dragYRef = useRef(0);
  const ntRef = useRef(null);

  useEffect(() => { save(data); }, [data]);
  useEffect(() => { if (editingNote && ntRef.current) ntRef.current.focus(); }, [editingNote]);

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
          if (a.urgency !== b.urgency || a.parentId !== b.parentId) return d;
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

  const updateTodoInfo = (id, info) => { setData(d => ({ ...d, todos: d.todos.map(t => t.id===id?{...t,...info}:t) })); setEditingTodo(null); };

  const startTodo = (id) => {
    const todo = data.todos.find(t => t.id === id);
    saveTimerSession(id, Date.now(), todo?.elapsed || 0);
    setData(d => ({ ...d, todos: d.todos.map(t => {
      if (t.id !== id) return t;
      const tl = [...(t.timeline||[]), { type: "start", at: Date.now() }];
      return { ...t, timeline: tl };
    })}));
    setActiveTodo(id);
  };

  const pauseTodo = (id, elapsed) => {
    clearTimerSession();
    setData(d => ({ ...d, todos: d.todos.map(t => {
      if (t.id !== id) return t;
      const tl = [...(t.timeline||[]), { type: "pause", at: Date.now() }];
      return { ...t, timeline: tl, elapsed };
    })}));
    setActiveTodo(null);
  };

  const resumeTodo = (id) => {
    const todo = data.todos.find(t => t.id === id);
    saveTimerSession(id, Date.now(), todo?.elapsed || 0);
    setData(d => ({ ...d, todos: d.todos.map(t => {
      if (t.id !== id) return t;
      const tl = [...(t.timeline||[]), { type: "resume", at: Date.now() }];
      return { ...t, timeline: tl };
    })}));
    setActiveTodo(id);
  };

  const CHEERS = ["干得漂亮！🔥","太强了！💪","完美收工！✨","效率拉满！🚀","又搞定一个！🎯","你就是传说！⚡","节奏起来了！🎶","无人能挡！💥"];
  const completeTodo = (id, elapsed) => {
    clearTimerSession();
    setData(d => ({ ...d, todos: d.todos.map(t => {
      if (t.id !== id) return t;
      const tl = [...(t.timeline||[]), { type: "complete", at: Date.now() }];
      return { ...t, done: true, elapsed, actualDuration: elapsed, doneTs: Date.now(), timeline: tl };
    })}));
    setActiveTodo(null);
    setCelebration({ msg: CHEERS[Math.floor(Math.random()*CHEERS.length)], elapsed });
    setTimeout(() => setCelebration(null), 2200);
  };

  const deleteTodo = (id) => {
    setData(d => ({ ...d, todos: d.todos.filter(t => t.id !== id && t.parentId !== id) }));
    if (activeTodo === id) setActiveTodo(null);
  };

  const cancelTodo = (id) => {
    // Restore elapsed to what it was before this session (baseElapsed from saved session)
    let preSessionElapsed = 0;
    try {
      const s = localStorage.getItem(TIMER_SK);
      if (s) {
        const { todoId, baseElapsed } = JSON.parse(s);
        if (todoId === id) preSessionElapsed = baseElapsed;
      }
    } catch {}
    clearTimerSession();
    setData(d => ({ ...d, todos: d.todos.map(t => {
      if (t.id !== id) return t;
      // Strip the last start event so timeline stays clean
      const tl = [...(t.timeline || [])];
      const lastStartIdx = [...tl].map(e => e.type).lastIndexOf("start");
      if (lastStartIdx >= 0) tl.splice(lastStartIdx, 1);
      return { ...t, elapsed: preSessionElapsed, timeline: tl };
    })}));
    setActiveTodo(null);
    setCanceledTimer(true);
    setTimeout(() => setCanceledTimer(false), 3000);
  };

  // Notes
  const createNote = () => { const c=NC[Math.floor(Math.random()*NC.length)]; const n={id:uid(),title:"",body:"",ts:Date.now(),color:c}; setData(d=>({...d,notes:[n,...d.notes]})); setEditingNote(n.id); };
  const updateNote = (id,f,v) => { setData(d=>({...d,notes:d.notes.map(n=>n.id===id?{...n,[f]:v,ts:Date.now()}:n)})); };
  const deleteNote = (id) => { setData(d=>({...d,notes:d.notes.filter(n=>n.id!==id)})); setEditingNote(null); };

  const pending = data.todos.filter(t => !t.done && !t.parentId);
  const allPending = data.todos.filter(t => !t.done);
  const done = data.todos.filter(t => t.done);
  const doneByDate = {};
  done.forEach(t => { const k = toBJ(t.doneTs||t.ts).toDateString(); if(!doneByDate[k]) doneByDate[k]=[]; doneByDate[k].push(t); });
  const sortedDK = Object.keys(doneByDate).sort((a,b)=>new Date(b)-new Date(a));

  const urgSort = (a, b) => { const o = {critical:0,medium:1,low:2}; return (o[a.urgency]??3)-(o[b.urgency]??3); };

  // Helper to render todo tree
  const renderTodo = (t, depth = 0) => {
    const kids = data.todos.filter(c => c.parentId === t.id && !c.done).sort(urgSort);
    if (editingTodo === t.id) {
      return (
        <div key={t.id} style={{ paddingLeft: depth * 24 }}>
          <TaskForm initial={t} onSave={info=>updateTodoInfo(t.id,info)} onCancel={()=>setEditingTodo(null)} isSubtask={!!t.parentId}/>
          {kids.map(c => renderTodo(c, depth + 1))}
        </div>
      );
    }
    return (
      <TodoRow key={t.id} t={t} depth={depth} activeTodo={activeTodo} setActiveTodo={setActiveTodo}
        setEditingTodo={setEditingTodo} setShowAdd={setShowAdd} deleteTodo={deleteTodo}
        startTodo={startTodo} onAddSub={id => { setAddSubParent(id); setShowAdd(false); setEditingTodo(null); setExpandedIds(s => { const n = new Set(s); n.add(id); return n; }); }}
        expandedIds={expandedIds} toggleExpand={toggleExpand} allTodos={data.todos}
        completeTodo={completeTodo} pauseTodo={pauseTodo} resumeTodo={resumeTodo} cancelTodo={cancelTodo}
        updateElapsed={(id,e) => setData(d=>({...d,todos:d.todos.map(x=>x.id===id?{...x,elapsed:e}:x)}))}
        dragFrom={dragFrom} dragOver={dragOver} onDragStart={startDrag}>
        {kids.map(c => renderTodo(c, depth + 1))}
        {addSubParent === t.id && (
          <div style={{ paddingLeft: (depth + 1) * 24 }}>
            <TaskForm isSubtask onSave={info => addTodo(info, t.id)} onCancel={() => setAddSubParent(null)} />
          </div>
        )}
      </TodoRow>
    );
  };

  // ── Note Editor ──
  if (editingNote) {
    const n = data.notes.find(x=>x.id===editingNote);
    if (!n) { setEditingNote(null); return null; }
    return (
      <div style={{...S.ctn,background:n.color.bg}}>
        <div style={S.edH}>
          <button style={S.ib} onClick={()=>setEditingNote(null)}><Ic.Back/></button>
          <button style={{...S.ib,color:n.color.accent}} onClick={()=>deleteNote(n.id)}><Ic.Trash/></button>
        </div>
        <div style={{padding:"8px 28px"}}>
          <input ref={ntRef} style={{...S.neT,color:n.color.accent}} placeholder="标题" value={n.title} onChange={e=>updateNote(n.id,"title",e.target.value)} />
          <textarea style={S.neB} placeholder="写点什么..." value={n.body} onChange={e=>updateNote(n.id,"body",e.target.value)} />
        </div>
        <style>{CSS}</style>
      </div>
    );
  }

  // ── Done History ──
  if (view === "done") {
    return (
      <div style={S.ctn}>
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
                      const urg = UM[t.urgency]||URG[0];
                      const over = t.actualDuration > (t.duration||30)*60;
                      return (
                        <div key={t.id} style={{ padding: "12px 4px", borderBottom: "1px solid #F0EDE6" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                            <div style={{ width:8,height:8,borderRadius:4,background:urg.color,flexShrink:0 }}/>
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
        <style>{CSS}</style>
      </div>
    );
  }

  // ── Main View ──
  return (
    <div style={S.ctn}>
      <div style={{ padding:"52px 24px 12px" }}>
        <div style={{ display:"flex",alignItems:"center",gap:10 }}>
          <span style={{ fontSize:28,color:"#E8A838" }}>✦</span>
          <span style={{ fontSize:28,fontWeight:700,letterSpacing:"-0.5px" }}>Mochi</span>
        </div>
        <div style={{ fontSize:14,color:"#999",marginTop:4,paddingLeft:38,fontFamily:"'Noto Serif SC',serif" }}>
          {new Date().toLocaleDateString("zh-CN",{month:"long",day:"numeric",weekday:"long"})}
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display:"flex",gap:6,padding:"16px 24px 8px",alignItems:"center" }}>
        {[["todo","待办",<Ic.Todo s={18} key="t"/>,allPending.length],["notes","笔记",<Ic.Note s={18} key="n"/>,data.notes.length]].map(([k,l,ic,c])=>(
          <button key={k} onClick={()=>{setTab(k);setShowAdd(false);setEditingTodo(null);setAddSubParent(null);}}
            style={{...S.tab,...(tab===k?S.tabA:{})}}>{ic}<span>{l}</span>{c>0&&<span style={S.bdg}>{c}</span>}</button>
        ))}
        {done.length>0&&(
          <button onClick={()=>setView("done")} style={{...S.tab,marginLeft:"auto",gap:5,padding:"10px 14px"}}>
            <Ic.Cal s={15}/><span style={{fontSize:13}}>{done.length}</span>
          </button>
        )}
      </div>

      <div style={{ padding:"12px 24px" }}>
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

            {/* Sorted by urgency, top-level only */}
            {[...pending].sort((a,b)=>{
              const o={critical:0,medium:1,low:2};
              return (o[a.urgency]??3)-(o[b.urgency]??3);
            }).map(t => renderTodo(t, 0))}
          </>
        ):(
          <>
            {data.notes.length===0&&(
              <div style={S.empty}><div style={{fontSize:48}}>📝</div><div style={{fontSize:17,fontWeight:600,color:"#AAA",marginTop:8}}>还没有笔记</div></div>
            )}
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
              {data.notes.map((n,i)=>(
                <div key={n.id} onClick={()=>setEditingNote(n.id)} style={{
                  padding:"16px 14px",borderRadius:16,cursor:"pointer",background:n.color.bg,
                  borderLeft:`3px solid ${n.color.accent}`,animation:"popIn .35s ease both",
                  animationDelay:`${i*50}ms`,minHeight:120,display:"flex",flexDirection:"column",gap:8,
                }}>
                  <div style={{fontSize:15,fontWeight:600,color:n.color.accent,lineHeight:1.3}}>{n.title||"无标题"}</div>
                  <div style={{fontSize:13,color:"#777",lineHeight:1.5,flex:1}}>{n.body?n.body.slice(0,80)+(n.body.length>80?"...":""):"空笔记"}</div>
                  <div style={{fontSize:11,color:"#BBB"}}>{fmtBJ(n.ts)}</div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      <button onClick={()=>{if(tab==="todo"){setShowAdd(true);setEditingTodo(null);setAddSubParent(null);} else createNote();}} style={S.fab}>
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
          📵 离开超过5分钟，本次专注已取消
        </div>
      )}

      {/* Drag ghost overlay */}
      {dragFrom && (() => {
        const todo = data.todos.find(t => t.id === dragFrom);
        if (!todo) return null;
        const urg = UM[todo.urgency] || URG[0];
        return (
          <div style={{
            position: "fixed", left: 16, right: 16,
            top: dragY - dragHalfH,
            zIndex: 1000, background: "#FDFBF7", borderRadius: 16,
            padding: "12px 16px",
            boxShadow: `0 16px 48px rgba(0,0,0,0.22), 0 0 0 2px ${urg.ring}`,
            transform: "scale(1.03)", pointerEvents: "none",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ width: 10, height: 10, borderRadius: "50%", background: urg.color, flexShrink: 0, boxShadow: `0 0 0 3px ${urg.ring}` }}/>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 15, fontWeight: 600, color: "#2C2C2C" }}>{todo.text}</div>
                <div style={{ display: "flex", gap: 6, marginTop: 3 }}>
                  <span style={{ fontSize: 10, color: urg.color, fontWeight: 600, background: urg.bg, padding: "2px 8px", borderRadius: 5 }}>{urg.label}</span>
                  <span style={{ fontSize: 10, color: "#BBB" }}>{fmtMin(todo.duration)}</span>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      <style>{CSS}</style>
    </div>
  );
}

const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@400;700&family=Outfit:wght@400;500;600;700&display=swap');
  * { box-sizing:border-box; margin:0; padding:0; -webkit-tap-highlight-color:transparent; }
  @keyframes slideUp { from{opacity:0;transform:translateY(12px)} to{opacity:1;transform:translateY(0)} }
  @keyframes popIn { from{opacity:0;transform:scale(.92)} to{opacity:1;transform:scale(1)} }
  @keyframes fabPulse { 0%,100%{box-shadow:0 4px 20px rgba(51,51,51,.25)} 50%{box-shadow:0 4px 30px rgba(51,51,51,.4)} }
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
`;

const S = {
  ctn:{fontFamily:"'Outfit','Noto Serif SC',sans-serif",background:"#FDFBF7",minHeight:"100vh",maxWidth:430,margin:"0 auto",position:"relative",paddingBottom:100,color:"#2C2C2C",overflowX:"hidden"},
  tab:{display:"flex",alignItems:"center",gap:6,padding:"10px 18px",borderRadius:24,border:"none",background:"#F0EDE6",color:"#888",fontSize:15,fontWeight:500,cursor:"pointer",transition:"all .25s",fontFamily:"inherit"},
  tabA:{background:"#2C2C2C",color:"#FFF"},
  bdg:{background:"#E8A838",color:"#FFF",fontSize:11,fontWeight:600,borderRadius:10,padding:"1px 7px",marginLeft:2},
  ib:{background:"none",border:"none",cursor:"pointer",display:"flex",alignItems:"center",padding:6,borderRadius:10,color:"#555"},
  fab:{position:"fixed",bottom:32,right:"calc(50% - 195px + 24px)",width:56,height:56,borderRadius:"50%",border:"none",background:"#2C2C2C",color:"#FFF",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",animation:"fabPulse 3s ease infinite",zIndex:100},
  empty:{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",paddingTop:80,gap:4},
  edH:{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"52px 20px 12px"},
  neT:{fontSize:26,fontWeight:700,border:"none",background:"transparent",outline:"none",fontFamily:"'Outfit',sans-serif",letterSpacing:"-0.5px",width:"100%"},
  neB:{fontSize:16,lineHeight:1.8,border:"none",background:"transparent",outline:"none",fontFamily:"'Noto Serif SC',serif",color:"#444",resize:"none",minHeight:"60vh",width:"100%",marginTop:12},
};
