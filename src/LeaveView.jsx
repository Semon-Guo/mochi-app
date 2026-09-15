/* 报备与请假的界面。
 *
 * 两头共用这一个模块：
 *   LeaveView   学生端整屏——提交条子、看自己的条子、补传病历
 *   LeaveQueue  导师端的一个页签——待批的队列、全组的条子、本月晚到次数
 *   LeaveCard   两边共用的那张卡片
 *
 * 规则全在 leave.js 里，这里一条都不自己判——服务端还有同一套规则的另一份
 * 实现，三处各写一遍必然会走样。
 *
 * 视觉跟导师端一路：实验记录本的样子，数字等宽，少装饰。条子是公文，
 * 不是社交动态。
 */
import { useState, useMemo, useRef } from "react";
import * as L from "./leave.js";
import { toBJ, p2 } from "./time.js";
import { uid } from "./migrate.js";
import { Photo } from "./PhotoView.jsx";
import { Avatar } from "./Avatar.jsx";

const C = {
  bg: "#FDFBF7", panel: "#FFFDF9", ink: "#2C2C2C", sub: "#8C8478",
  dim: "#B0A99B", line: "#EDE8DE", hair: "#F4F0E7",
  amber: "#C08A1E", green: "#5A9E4B", blue: "#5B7FC7", red: "#C02556",
};
const MONO = "'JetBrains Mono','SF Mono','Menlo',monospace";

const fmtWhen = (ts) => {
  if (!ts) return "—";
  const d = toBJ(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${p2(d.getHours())}:${p2(d.getMinutes())}`;
};

/* ── 北京时间 ↔ 输入框 ──
 * 一律按北京时间读写。全组按同一时区分天（见 time.js），出差的人若按本地
 * 时区填，同一条假在导师那边会落在别的日子上。
 */
const fromInput = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(s || "");
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - 8 * 3600000 : 0;
};
/** 几天后的几点（北京时间），填进输入框的默认值。 */
const dayAtInput = (n, h) => {
  const d = toBJ(Date.now() + n * 86400000);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(h)}:00`;
};
/* 默认离返时间按类型给，不是统一的「明天此刻」：
   - 事假 / 补休排到后天。默认要是正好卡在「提前 24 小时」那条线上，
     人填事由的那十几秒里它就自己越线了，一提交就挂着「未提前报备」。
   - 病假默认今天——人是病了才来填这张表的，不会为三天后的病请假。 */
const kindDefaults = (k) => (k === "sick"
  ? [dayAtInput(0, 9), dayAtInput(0, 18)]
  : [dayAtInput(2, 9), dayAtInput(2, 18)]);

const btn = (bg, fg, extra = {}) => ({
  border: "none", borderRadius: 11, cursor: "pointer", fontFamily: "inherit",
  fontSize: 13.5, fontWeight: 700, padding: "11px 16px", background: bg, color: fg, ...extra,
});
const field = {
  width: "100%", boxSizing: "border-box", padding: "10px 11px", borderRadius: 10,
  border: `1px solid ${C.line}`, background: "#FFF", fontFamily: "inherit",
  fontSize: 14, color: C.ink, outline: "none",
};

function Pill({ status }) {
  const s = L.statusOf(status);
  return (
    <span style={{
      fontSize: 11, fontWeight: 700, padding: "3px 9px", borderRadius: 999, flexShrink: 0,
      color: s.color, background: s.color + "18", border: `1px solid ${s.color}33`,
    }}>{s.label}</span>
  );
}

function Panel({ title, children, style }) {
  return (
    <div style={{ border: `1px solid ${C.line}`, borderRadius: 14, background: C.panel,
      padding: 14, marginBottom: 12, ...style }}>
      {title && (
        <div style={{ fontSize: 11, fontWeight: 700, color: C.sub, letterSpacing: "0.4px",
          textTransform: "uppercase", marginBottom: 9 }}>{title}</div>
      )}
      {children}
    </div>
  );
}

/* ── 常规工作时间 ──
 * 摆在提交表单上面。报备之前先知道要到岗的时间是几点，否则「晚到」相对于
 * 什么都不清楚。
 */
export function WorkHours({ compact = false }) {
  const rows = [
    ["周一至周五", L.WORK_HOURS[1]],
    ["周六", L.WORK_HOURS[6]],
  ];
  return (
    <div style={{ fontSize: 12.5, color: C.sub, lineHeight: 1.9 }}>
      {rows.map(([label, blocks]) => (
        <div key={label} style={{ display: "flex", gap: 10 }}>
          <span style={{ width: 78, flexShrink: 0, color: C.dim, whiteSpace: "nowrap" }}>{label}</span>
          <span style={{ fontFamily: MONO, color: C.ink }}>
            {blocks.map((b) => `${L.fmtMin(b[0])}–${L.fmtMin(b[1])}`).join("  ")}
          </span>
        </div>
      ))}
      <div style={{ display: "flex", gap: 10 }}>
        <span style={{ width: 78, flexShrink: 0, color: C.dim, whiteSpace: "nowrap" }}>周六晚至周日</span>
        <span style={{ color: C.dim }}>休息</span>
      </div>
      {!compact && (
        <div style={{ fontSize: 11.5, color: C.dim, marginTop: 8, lineHeight: 1.7 }}>
          出自课题组 2026 年 9 月 13 日《关于启用课题组实验记录与科研数据管理系统的通知》第二节。
        </div>
      )}
    </div>
  );
}

/* ── 一张条子 ── */
export function LeaveCard({ l, author, me, onPhoto, onCancel, onProof, onDecide, busy }) {
  const k = L.kindOf(l.kind);
  const flags = L.flagsOf(l);
  const due = L.proofDue(l);
  const mine = l.ownerId === me?.id || !l.ownerId;
  const [note, setNote] = useState("");
  const [deciding, setDeciding] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const fileRef = useRef(null);
  const proofs = l.proof?.photos || [];

  return (
    <div style={{ border: `1px solid ${due ? C.red + "55" : C.line}`, borderRadius: 14,
      background: C.panel, padding: 13, marginBottom: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 7 }}>
        <span style={{ fontSize: 15 }}>{k.icon}</span>
        <span style={{ fontSize: 13.5, fontWeight: 700, color: k.color }}>{k.label}</span>
        {author && (
          <span style={{ display: "flex", alignItems: "center", gap: 5, marginLeft: 2 }}>
            <Avatar user={author} size={18} />
            <span style={{ fontSize: 12, color: C.sub }}>{author.displayName}</span>
          </span>
        )}
        <span style={{ flex: 1 }} />
        <Pill status={l.status} />
      </div>

      <div style={{ fontSize: 13.5, color: C.ink, fontFamily: MONO, marginBottom: 6 }}>
        {L.fmtSpan(l)}
      </div>

      {l.reason && (
        <div style={{ fontSize: 13, color: C.ink, lineHeight: 1.7, whiteSpace: "pre-wrap",
          marginBottom: 6 }}>{l.reason}</div>
      )}

      {flags.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 6 }}>
          {flags.map((f) => (
            <span key={f.key} style={{ fontSize: 11, fontWeight: 700, color: C.amber,
              background: "#C08A1E14", border: "1px solid #C08A1E33",
              borderRadius: 7, padding: "2px 8px" }}>⚠ {f.text}</span>
          ))}
        </div>
      )}

      {/* 病历 / 就诊票据。超过 2 天的病假，返回后要补传。 */}
      {L.needsProof(l) && (
        <div style={{ marginTop: 8, padding: "9px 10px", borderRadius: 11,
          background: due ? "#C0255610" : C.hair, border: `1px solid ${due ? C.red + "33" : C.line}` }}>
          <div style={{ fontSize: 11.5, fontWeight: 700, color: due ? C.red : C.sub, marginBottom: 6 }}>
            {proofs.length ? `病历 / 就诊票据 · ${proofs.length} 张`
              : due ? "返回后要补传病历或就诊票据" : `超过 ${L.SICK_PROOF_DAYS} 天，返回后补传病历或就诊票据`}
          </div>
          {proofs.length > 0 && (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {proofs.map((pid) => <Photo key={pid} id={pid} size={58} onOpen={onPhoto} />)}
            </div>
          )}
          {mine && onProof && (
            <>
              <input ref={fileRef} type="file" accept="image/*" multiple hidden
                onChange={async (e) => {
                  const fs = [...(e.target.files || [])];
                  e.target.value = "";
                  if (fs.length) await onProof(l.id, fs);
                }} />
              <button onClick={() => fileRef.current?.click()} disabled={busy}
                style={{ ...btn("#FFF", C.ink, { marginTop: 7, padding: "7px 13px", fontSize: 12,
                  border: `1px solid ${C.line}`, opacity: busy ? .5 : 1 }) }}>
                {proofs.length ? "再传一张" : "上传病历 / 票据"}
              </button>
            </>
          )}
        </div>
      )}

      {/* 导师的批复 */}
      {l.decisionNote && (
        <div style={{ marginTop: 7, fontSize: 12.5, color: C.sub, lineHeight: 1.7,
          paddingLeft: 9, borderLeft: `2px solid ${C.line}` }}>
          导师批复：{l.decisionNote}
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 9,
        fontSize: 11, color: C.dim, fontFamily: MONO }}>
        <span>提交于 {fmtWhen(l.submittedAt)}</span>
        {l.decidedAt > 0 && <span>· 批于 {fmtWhen(l.decidedAt)}</span>}
        <span style={{ flex: 1 }} />
        {mine && onCancel && !["canceled", "rejected"].includes(l.status) && (
          <button onClick={() => {
            if (!confirmCancel) return setConfirmCancel(true);
            setConfirmCancel(false); onCancel(l.id);
          }} style={{ border: "none", background: "none", cursor: "pointer", padding: 2,
            fontFamily: "inherit", fontSize: 11.5, fontWeight: 700,
            color: confirmCancel ? C.red : C.dim }}>
            {confirmCancel ? "确认撤回？" : "撤回"}
          </button>
        )}
      </div>

      {/* 导师的批准 / 不批准 */}
      {onDecide && l.status === "pending" && (
        deciding ? (
          <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${C.line}` }}>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2}
              placeholder="批复（可留空）" style={{ ...field, resize: "vertical", fontSize: 13 }} />
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <button onClick={() => { onDecide(l.id, "approved", note.trim()); setDeciding(false); }}
                style={{ ...btn(C.green, "#FFF", { flex: 1, padding: "9px 0", fontSize: 13 }) }}>批准</button>
              <button onClick={() => { onDecide(l.id, "rejected", note.trim()); setDeciding(false); }}
                style={{ ...btn("#FFF", C.red, { flex: 1, padding: "9px 0", fontSize: 13,
                  border: `1px solid ${C.red}55` }) }}>不批准</button>
              <button onClick={() => setDeciding(false)}
                style={{ ...btn("#FFF", C.dim, { padding: "9px 12px", fontSize: 13,
                  border: `1px solid ${C.line}` }) }}>取消</button>
            </div>
          </div>
        ) : (
          <button onClick={() => setDeciding(true)}
            style={{ ...btn(C.ink, "#FFF", { width: "100%", marginTop: 10, padding: "9px 0", fontSize: 13 }) }}>
            批这条
          </button>
        )
      )}
    </div>
  );
}

/* ── 学生端：整屏 ── */
export function LeaveView({ data, me, onClose, onSubmit, onPatch, onPhoto, addPhotos }) {
  const [kind, setKind] = useState(null);
  const [day, setDay] = useState(() => L.dayStr(Date.now() + 86400000));  // 默认明天
  const [arrive, setArrive] = useState("09:30");
  const [fromAt, setFromAt] = useState(() => kindDefaults("personal")[0]);
  const [toAt, setToAt] = useState(() => kindDefaults("personal")[1]);
  const [reason, setReason] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [showAll, setShowAll] = useState(false);

  const myId = me?.id;
  const mine = useMemo(() => (data.leaves || [])
    .filter((l) => !l.ownerId || l.ownerId === myId).sort(L.byNewest), [data.leaves, myId]);
  const open = useMemo(() => L.myOpen(mine, myId), [mine, myId]);
  const shown = showAll ? mine : mine.slice(0, 8);

  const draft = useMemo(() => {
    if (!kind) return null;
    if (kind === "late") {
      const [h, m] = (arrive || "").split(":").map(Number);
      return { kind, day, arriveMin: Number.isFinite(h) ? h * 60 + (m || 0) : null };
    }
    return { kind, fromAt: fromInput(fromAt), toAt: fromInput(toAt), reason };
  }, [kind, day, arrive, fromAt, toAt, reason]);

  const problem = draft ? L.checkDraft(draft) : "";
  const warns = draft && !problem ? L.warnDraft(draft) : [];

  const reset = () => { setKind(null); setReason(""); setErr(""); };

  const submit = async () => {
    if (!draft || problem) return;
    setBusy(true); setErr("");
    try {
      // status 和 submittedAt 都由服务端定——这里填的只是本地先显示一下，
      // 下一轮同步会被服务器那份盖掉。
      await onSubmit({ id: uid(), ...draft, submittedAt: Date.now(), status: L.statusFor(draft) });
      reset();
    } catch (e) { setErr(e?.message || "提交失败"); }
    setBusy(false);
  };

  const uploadProof = async (id, files) => {
    setBusy(true); setErr("");
    try {
      const ids = await addPhotos(files);
      const l = mine.find((x) => x.id === id);
      onPatch(id, { proof: { photos: [...(l?.proof?.photos || []), ...ids] } });
    } catch (e) { setErr(e?.message || "照片存不进去"); }
    setBusy(false);
  };

  return (
    <div className="app-shell" style={{
      fontFamily: "'Outfit','Noto Serif SC',sans-serif", background: C.bg, minHeight: "100vh",
      maxWidth: "var(--app-w)", margin: "0 auto", paddingBottom: 48, color: C.ink,
    }}>
      <div style={{ padding: "46px var(--app-pad) 14px", display: "flex", alignItems: "center",
        gap: 11, borderBottom: `1px solid ${C.line}`, marginBottom: 14 }}>
        <button onClick={onClose} className="hit" style={{ border: "none", background: "none",
          cursor: "pointer", color: C.sub, fontSize: 22, padding: "0 4px 3px", lineHeight: 1 }}
          title="关闭">‹</button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 19, fontWeight: 700, letterSpacing: "-0.2px" }}>报备与请假</div>
          <div style={{ fontSize: 11.5, color: C.sub, marginTop: 2, fontFamily: MONO }}>
            {open.length ? `${open.length} 条还没了结` : "晚到 · 病假 · 事假 · 补休"}
          </div>
        </div>
      </div>

      <div style={{ padding: "0 var(--app-pad)" }}>
        <Panel title="常规工作时间"><WorkHours /></Panel>

        {!kind ? (
          <Panel title="要报备什么">
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              {L.LEAVE_KINDS.map((k) => (
                <button key={k.key} onClick={() => {
                  const [f, t] = kindDefaults(k.key);
                  setFromAt(f); setToAt(t); setKind(k.key); setErr("");
                }}
                  style={{ ...btn("#FFF", C.ink, { border: `1px solid ${C.line}`, textAlign: "left",
                    padding: "12px 13px", display: "flex", flexDirection: "column", gap: 3 }) }}>
                  <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
                    <span style={{ fontSize: 15 }}>{k.icon}</span>
                    <span style={{ fontSize: 13.5, fontWeight: 700, color: k.color }}>{k.label}</span>
                  </span>
                  <span style={{ fontSize: 11, color: C.dim, fontWeight: 500, lineHeight: 1.5 }}>
                    {k.hint}
                  </span>
                </button>
              ))}
            </div>
          </Panel>
        ) : (
          <Panel title={L.kindOf(kind).label}>
            {kind === "late" ? (
              <>
                <div style={{ fontSize: 12, color: C.sub, lineHeight: 1.7, marginBottom: 10 }}>
                  前一晚工作较晚、次日 {L.fmtMin(L.WORK_START)} 到不了的，当晚提交。
                  <b style={{ color: C.ink }}> {L.fmtMin(L.AUTO_LATE_BY)} 前到岗的自动通过</b>，
                  不用等导师批，但仍然留记录——别把 {L.fmtMin(L.AUTO_LATE_BY)} 当成常规到岗时间。
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <label style={{ flex: 1 }}>
                    <div style={{ fontSize: 11.5, color: C.sub, marginBottom: 4 }}>哪一天</div>
                    <input type="date" value={day} onChange={(e) => setDay(e.target.value)} style={field} />
                  </label>
                  <label style={{ flex: 1 }}>
                    <div style={{ fontSize: 11.5, color: C.sub, marginBottom: 4 }}>预计到岗</div>
                    <input type="time" value={arrive} onChange={(e) => setArrive(e.target.value)} style={field} />
                  </label>
                </div>
              </>
            ) : (
              <>
                <div style={{ fontSize: 12, color: C.sub, lineHeight: 1.7, marginBottom: 10 }}>
                  {kind === "sick" && <>身体不适须<b style={{ color: C.ink }}>先口头报备导师</b>，这里留一条痕迹备查。
                    超过 {L.SICK_PROOF_DAYS} 天的，返回后在这条下面补传病历或就诊票据。</>}
                  {kind === "personal" && <>请<b style={{ color: C.ink }}>至少提前 24 小时</b>提交，
                    注明事由和离返时间，<b style={{ color: C.ink }}>经导师批准后方可离开</b>。
                    单次原则上不超过 {L.PERSONAL_MAX_DAYS} 天。</>}
                  {kind === "comp" && <>加班或周末值守之后的补休，注明事由和离返时间，经导师批准。</>}
                </div>
                <label style={{ display: "block", marginBottom: 8 }}>
                  <div style={{ fontSize: 11.5, color: C.sub, marginBottom: 4 }}>离开时间</div>
                  <input type="datetime-local" value={fromAt}
                    onChange={(e) => setFromAt(e.target.value)} style={field} />
                </label>
                <label style={{ display: "block", marginBottom: 8 }}>
                  <div style={{ fontSize: 11.5, color: C.sub, marginBottom: 4 }}>返回时间</div>
                  <input type="datetime-local" value={toAt}
                    onChange={(e) => setToAt(e.target.value)} style={field} />
                </label>
                <label style={{ display: "block" }}>
                  <div style={{ fontSize: 11.5, color: C.sub, marginBottom: 4 }}>事由</div>
                  <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3}
                    placeholder={kind === "sick" ? "例：发烧，去医院" : "例：家里有事，回家一趟"}
                    style={{ ...field, resize: "vertical" }} />
                </label>
              </>
            )}

            {warns.map((w, i) => (
              <div key={i} style={{ fontSize: 11.5, color: C.amber, lineHeight: 1.7, marginTop: 8,
                padding: "7px 9px", borderRadius: 9, background: "#C08A1E10" }}>⚠ {w}</div>
            ))}
            {(problem || err) && (
              <div style={{ fontSize: 12, color: C.red, marginTop: 8, lineHeight: 1.6 }}>
                {err || problem}
              </div>
            )}

            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <button onClick={submit} disabled={!!problem || busy}
                style={{ ...btn(C.ink, "#FFF", { flex: 1, opacity: problem || busy ? .45 : 1,
                  cursor: problem || busy ? "not-allowed" : "pointer" }) }}>
                {busy ? "提交中…" : "提交"}
              </button>
              <button onClick={reset} style={{ ...btn("#FFF", C.dim, { border: `1px solid ${C.line}` }) }}>
                取消
              </button>
            </div>
          </Panel>
        )}

        <div style={{ fontSize: 11, fontWeight: 700, color: C.sub, letterSpacing: "0.4px",
          textTransform: "uppercase", margin: "18px 2px 9px" }}>
          我的报备 {mine.length > 0 && `· ${mine.length}`}
        </div>
        {mine.length === 0 ? (
          <div style={{ textAlign: "center", padding: "30px 0", color: C.dim, fontSize: 13 }}>
            还没有报备记录
          </div>
        ) : (
          <>
            {shown.map((l) => (
              <LeaveCard key={l.id} l={l} me={me} onPhoto={onPhoto} busy={busy}
                onCancel={(id) => onPatch(id, { status: "canceled" })}
                onProof={uploadProof} />
            ))}
            {mine.length > shown.length && (
              <button onClick={() => setShowAll(true)} style={{ ...btn("#FFF", C.sub,
                { width: "100%", border: `1px solid ${C.line}`, fontSize: 12.5, padding: "9px 0" }) }}>
                还有 {mine.length - shown.length} 条，全部展开
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* ── 导师端：一个页签 ── */
export function LeaveQueue({ leaves = [], byId = {}, me, onPhoto, onDecide }) {
  const [tab, setTab] = useState("todo");   // todo | all | late
  const now = Date.now();
  const pending = useMemo(() => L.needsAdvisor(leaves, now).sort(L.byNewest), [leaves]);
  const all = useMemo(() => [...leaves].sort(L.byNewest), [leaves]);
  const month = L.monthKeyOf(now);

  // 本月谁报备过几次晚到。**这不是迟到次数**——报备了、按报备的时间到岗是
  // 合规的。通知第三节（二）要数的迟到是「未报备」或「晚于报备时间到达」，
  // 系统没有打卡，看不见那件事。这张表只回答「谁在把 10:00 当常规到岗时间」。
  const lateRank = useMemo(() => {
    const m = new Map();
    for (const l of leaves) {
      if (l.kind !== "late" || l.status === "canceled") continue;
      if (!l.day || l.day.slice(0, 7) !== month) continue;
      m.set(l.ownerId, (m.get(l.ownerId) || 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [leaves, month]);

  const list = tab === "todo" ? pending : all;

  return (
    <>
      <div style={{ display: "flex", gap: 6, padding: "0 0 10px" }}>
        {[["todo", `待处理${pending.length ? ` ${pending.length}` : ""}`],
          ["all", `全部 ${all.length}`], ["late", "本月晚到"]].map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)} style={{
            padding: "7px 14px", borderRadius: 10, cursor: "pointer", fontFamily: "inherit",
            fontSize: 12.5, fontWeight: 600,
            border: tab === k ? `1px solid ${C.ink}` : `1px solid ${C.line}`,
            background: tab === k ? C.ink : "#FFF", color: tab === k ? "#FFF" : C.sub,
          }}>{label}</button>
        ))}
      </div>

      {tab === "late" ? (
        <Panel title={`${month} 报备过的晚到`}>
          <div style={{ fontSize: 11.5, color: C.sub, lineHeight: 1.75, marginBottom: 10 }}>
            数的是<b style={{ color: C.ink }}>报备过的晚到</b>，不是迟到。报了备、按报备的时间
            到岗是合规的；通知第三节（二）要数的迟到是「未报备」或「晚于报备时间到达」，
            系统没有打卡，看不见那件事。这张表只回答一个问题：谁在把
            {" "}{L.fmtMin(L.AUTO_LATE_BY)} 当成常规到岗时间。
          </div>
          {lateRank.length === 0 ? (
            <div style={{ color: C.dim, fontSize: 13 }}>本月还没有人报备晚到</div>
          ) : lateRank.map(([uid_, n]) => {
            const u = byId[uid_];
            return (
              <div key={uid_} style={{ display: "flex", alignItems: "center", gap: 9,
                padding: "7px 0", borderBottom: `1px solid ${C.hair}` }}>
                <Avatar user={u} size={24} />
                <span style={{ fontSize: 13, flex: 1, minWidth: 0, overflow: "hidden",
                  textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {u?.displayName || "（已离组）"}
                </span>
                <span style={{ fontFamily: MONO, fontSize: 13, fontWeight: 700,
                  color: n > 3 ? C.red : n >= 3 ? C.amber : C.sub }}>{n} 次</span>
              </div>
            );
          })}
        </Panel>
      ) : list.length === 0 ? (
        <div style={{ textAlign: "center", padding: "36px 0", color: C.dim, fontSize: 13 }}>
          {tab === "todo" ? "没有要处理的条子" : "还没有任何报备"}
        </div>
      ) : (
        list.slice(0, 60).map((l) => (
          <LeaveCard key={l.id} l={l} me={me} author={byId[l.ownerId]} onPhoto={onPhoto}
            onDecide={onDecide} />
        ))
      )}
    </>
  );
}
