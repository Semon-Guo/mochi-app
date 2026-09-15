/* 报备与请假的规则。
 *
 * 规则出自课题组 2026-09-13《关于启用课题组实验记录与科研数据管理系统的通知》
 * 第二节「报备与请假」。这一份和服务端 mochi_server.py 里的 leave_* 那几个函数
 * 是**同一套规则的两份实现**，服务端那份说了算：
 *
 *   - 前端这份决定「界面上显示成什么、能不能点提交」；
 *   - 服务端那份决定「库里存成什么」，客户端报上来的 status 一律不信。
 *
 * 两份必须同时改。规则本身刻意写得很小（就下面几个常量加三个函数），
 * 就是为了让两边好对照——sync.test.mjs 和 test_server.py 里各钉了一遍，
 * 改歪了哪一边都会当场红。
 */

import { toBJ, p2 } from "./time.js";

/* ── 常规工作时间 ──
 * 周一至周五 9:00-11:30、14:00-17:30、19:00-21:30
 * 周六 9:00-11:30、14:00-17:30；周六晚至周日全天休息。
 * 下标就是 Date.getDay()（0 = 周日）。
 */
export const WORK_HOURS = [
  [],                                                   // 周日
  [[540, 690], [840, 1050], [1140, 1290]],              // 周一
  [[540, 690], [840, 1050], [1140, 1290]],
  [[540, 690], [840, 1050], [1140, 1290]],
  [[540, 690], [840, 1050], [1140, 1290]],
  [[540, 690], [840, 1050], [1140, 1290]],              // 周五
  [[540, 690], [840, 1050]],                            // 周六（晚上休息）
];
export const WEEKDAY = ["日", "一", "二", "三", "四", "五", "六"];

/** 上班点：9:00。晚到报备就是「这个点到不了」。 */
export const WORK_START = 540;
/** 晚到报备自动通过的界线：10:00 前到岗的不需要导师审批。 */
export const AUTO_LATE_BY = 600;
/** 事假至少提前 24 小时提交。 */
export const ADVANCE_MS = 24 * 3600 * 1000;
/** 单次事假原则上不超过 3 天。 */
export const PERSONAL_MAX_DAYS = 3;
/** 病假超过 2 天的，返回后要补传病历或就诊票据。 */
export const SICK_PROOF_DAYS = 2;

export const LEAVE_KINDS = [
  { key: "late", label: "晚到报备", icon: "🌅", color: "#C08A1E",
    hint: "前一晚工作较晚，次日 9:00 到不了" },
  { key: "sick", label: "病假", icon: "🩺", color: "#C02556",
    hint: "身体不适需要就医或休养" },
  { key: "personal", label: "事假", icon: "🧳", color: "#5B7FC7",
    hint: "个人或家庭事由需要离开" },
  { key: "comp", label: "补休", icon: "🌙", color: "#5A9E4B",
    hint: "加班或周末值守之后的补休" },
];
export const kindOf = (k) => LEAVE_KINDS.find((x) => x.key === k) || LEAVE_KINDS[3];

/** 只有 late 走「日期 + 到岗时刻」，其余三种走「离返时间」。 */
export const isLate = (l) => l?.kind === "late";

export const LEAVE_STATUS = {
  auto: { label: "自动通过", color: "#5A9E4B", done: true },
  filed: { label: "已备案", color: "#8C8478", done: true },
  pending: { label: "待批准", color: "#C08A1E", done: false },
  approved: { label: "已批准", color: "#5A9E4B", done: true },
  rejected: { label: "未批准", color: "#C02556", done: true },
  canceled: { label: "已撤回", color: "#B0A99B", done: true },
};
export const statusOf = (s) => LEAVE_STATUS[s] || LEAVE_STATUS.pending;

/* ── 北京时间的几个原语 ──
 * 全组按同一时区分天，否则「请了几天」在不同人的界面上会算出不同的数。
 */
export const dayStr = (ts) => {
  const d = toBJ(ts);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
};
/** "2026-09-16" → 那天 00:00 的北京时间戳。 */
export function dayStart(day) {
  const [y, m, d] = String(day || "").split("-").map(Number);
  if (!y || !m || !d) return 0;
  return Date.UTC(y, m - 1, d) - 8 * 3600 * 1000;
}
/** 晚到报备那一天的某个时刻（分钟）对应的时间戳。 */
export const dayAt = (day, minutes) => dayStart(day) + (minutes || 0) * 60000;
export const fmtMin = (m) => `${p2(Math.floor((m || 0) / 60))}:${p2((m || 0) % 60)}`;
export const minOf = (ts) => { const d = toBJ(ts); return d.getHours() * 60 + d.getMinutes(); };
export const weekdayOf = (ts) => toBJ(ts).getDay();

/** 跨了几个自然日（含头含尾）。请到当天下午也算一天，这跟人嘴里说的「请两天」一致。 */
export function spanDays(fromAt, toAt) {
  if (!fromAt || !toAt || toAt < fromAt) return 0;
  const a = dayStart(dayStr(fromAt));
  const b = dayStart(dayStr(toAt));
  return Math.round((b - a) / 86400000) + 1;
}

/** 这条假占了哪些自然日（"YYYY-MM-DD" 列表），日历上标记用。 */
export function daysCovered(l) {
  if (!l) return [];
  if (isLate(l)) return l.day ? [l.day] : [];
  const n = spanDays(l.fromAt, l.toAt);
  if (!n) return [];
  const start = dayStart(dayStr(l.fromAt));
  return Array.from({ length: Math.min(n, 60) }, (_, i) => dayStr(start + i * 86400000));
}

/* ── 规则 ── */

/**
 * 这条报备该是什么状态。**服务端重算一遍，客户端报上来的一律不采信**——
 * 否则把 arriveMin 填成 9:30、status 填成 auto 推上来就等于自己批了自己。
 */
export function statusFor(l) {
  if (!l) return "pending";
  if (l.kind === "late") return (l.arriveMin ?? 1440) < AUTO_LATE_BY ? "auto" : "pending";
  // 病假是口头报备为主（通知第二节（二）），系统这边只负责留痕，不拦人就医。
  if (l.kind === "sick") return "filed";
  return "pending";
}

/** 超过 2 天的病假，返回后要补传病历或就诊票据。 */
export const needsProof = (l) =>
  l?.kind === "sick" && spanDays(l.fromAt, l.toAt) > SICK_PROOF_DAYS;

/** 该补而还没补的。返回之后才算欠着——人还在病着的时候不该催他传票据。 */
export const proofDue = (l, now = Date.now()) =>
  needsProof(l) && now > (l.toAt || 0) && !(l.proof?.photos || []).length;

/**
 * 不合规的地方。**都不阻止提交**：拦下来的结果是这条假根本不进系统，
 * 人退回去口头请假——那正是这套系统要取消的东西。所以照收，标出来给导师看。
 */
export function flagsOf(l, submittedAt = l?.submittedAt || Date.now()) {
  const f = [];
  if (!l) return f;
  if (l.kind === "personal") {
    if (l.fromAt && l.fromAt - submittedAt < ADVANCE_MS) {
      f.push({ key: "rush", text: "未提前 24 小时提交" });
    }
    if (spanDays(l.fromAt, l.toAt) > PERSONAL_MAX_DAYS) {
      f.push({ key: "long", text: `超过 ${PERSONAL_MAX_DAYS} 天` });
    }
  }
  if (l.kind === "late") {
    // 当晚提交才算报备；当天 9:00 之后才补的，是迟到之后补的条子。
    if (l.day && submittedAt > dayAt(l.day, WORK_START)) {
      f.push({ key: "after", text: "当天 9:00 后才提交" });
    }
    if ((l.arriveMin ?? 0) >= AUTO_LATE_BY) {
      f.push({ key: "beyond", text: `晚于 ${fmtMin(AUTO_LATE_BY)} 到岗` });
    }
  }
  return f;
}

/** 提交前的自检：返回一条人话，没问题就返回 ""。 */
export function checkDraft(l, now = Date.now()) {
  if (!l?.kind) return "先选一种报备类型";
  if (l.kind === "late") {
    if (!l.day) return "选一个日期";
    if (l.arriveMin == null) return "填预计到岗时间";
    if (l.arriveMin <= WORK_START) return `${fmtMin(WORK_START)} 前到岗不用报备`;
    if (l.arriveMin >= 1440) return "到岗时间不对";
    if (dayAt(l.day, l.arriveMin) < now - 12 * 3600 * 1000) return "这个时间已经过去了";
    return "";
  }
  if (!l.fromAt || !l.toAt) return "填离开和返回的时间";
  if (l.toAt < l.fromAt) return "返回时间早于离开时间";
  if (spanDays(l.fromAt, l.toAt) > 60) return "时间跨度太长，分几次报备";
  if (!String(l.reason || "").trim()) return "写一下事由";
  return "";
}

/** 提交前该让人看一眼的提醒（不拦提交）。 */
export function warnDraft(l, now = Date.now()) {
  const w = [];
  if (!l) return w;
  if (l.kind === "personal") {
    if ((l.fromAt || 0) - now < ADVANCE_MS) {
      w.push("通知要求事假至少提前 24 小时提交，这条会标记为未提前报备，请当面向导师说明。");
    }
    if (spanDays(l.fromAt, l.toAt) > PERSONAL_MAX_DAYS) {
      w.push(`单次事假原则上不超过 ${PERSONAL_MAX_DAYS} 天，这条是 ${spanDays(l.fromAt, l.toAt)} 天。`);
    }
  }
  if (l.kind === "sick") {
    w.push("病假仍须先口头报备导师，系统这条只是留痕。");
    if (spanDays(l.fromAt, l.toAt) > SICK_PROOF_DAYS) {
      w.push(`超过 ${SICK_PROOF_DAYS} 天的病假，返回后要在这条下面补传病历或就诊票据。`);
    }
  }
  if (l.kind === "late") {
    if ((l.arriveMin ?? 0) >= AUTO_LATE_BY) {
      w.push(`${fmtMin(AUTO_LATE_BY)} 之后到岗的报备需要导师批准。`);
    }
    // 休息日没有 9:00 到岗这回事，报备晚到没有意义。只提醒不拦——真有人
    // 周日来加班、想说一声几点到，拦下来只会让他去发微信。
    if (l.day && isRestDay(dayStart(l.day))) {
      w.push("这天是休息日（周六晚至周日全天休息），不需要报备晚到。");
    }
  }
  return w;
}

/* ── 统计 ──
 * 导师端用。**数的是「报备过的晚到」，不是「迟到」**——这两件事在通知里是
 * 分开的：报备了、且按报备的时间到岗，是合规的；通知第三节（二）要数的
 * 「迟到」是未报备或晚于报备时间到达，那个系统看不见（没有打卡），只有
 * 在场的人知道。把这张表当迟到次数用会冤枉按规矩报备的人。
 */
export function monthKeyOf(ts) { return dayStr(ts).slice(0, 7); }

/** 某人某月报备过几次晚到。撤回的不算。 */
export function lateCount(leaves, ownerId, monthKey) {
  return (leaves || []).filter((l) =>
    l.kind === "late" && l.ownerId === ownerId && l.status !== "canceled" &&
    l.day && l.day.slice(0, 7) === monthKey).length;
}

/** 待导师处理的：等批准的，以及已经该补而没补病历的。 */
export function needsAdvisor(leaves, now = Date.now()) {
  return (leaves || []).filter((l) => l.status === "pending" || proofDue(l, now));
}

/** 本人这边还没了结的。 */
export function myOpen(leaves, myId, now = Date.now()) {
  return (leaves || []).filter((l) =>
    l.ownerId === myId && (l.status === "pending" || proofDue(l, now)));
}

/** 排序：新提交的在上面。 */
export const byNewest = (a, b) => (b.submittedAt || 0) - (a.submittedAt || 0);

/** 这条假覆盖的时间读起来是什么样。 */
export function fmtSpan(l) {
  if (!l) return "";
  if (isLate(l)) {
    const ts = dayStart(l.day);
    const d = toBJ(ts);
    return `${d.getMonth() + 1}月${d.getDate()}日（周${WEEKDAY[d.getDay()]}） ${fmtMin(l.arriveMin)} 到岗`;
  }
  const a = toBJ(l.fromAt), b = toBJ(l.toAt);
  const one = (d) => `${d.getMonth() + 1}月${d.getDate()}日 ${p2(d.getHours())}:${p2(d.getMinutes())}`;
  const n = spanDays(l.fromAt, l.toAt);
  return `${one(a)} — ${one(b)}（${n} 天）`;
}

/** 那天是不是休息日（周日，以及周六晚上之后）。 */
export const isRestDay = (ts) => WORK_HOURS[weekdayOf(ts)].length === 0;
