/* 个人成就树的纯数据逻辑。单独一个 .js 是为了能在 node 里直接单测——
   UI 在 Achievements.jsx 里，带 JSX 的文件 node 跑不了。

   这里一个跨人比较的函数都没有，是刻意的。全组排名次的东西删掉了，剩下的
   只回答一个问题：**我这个月有没有虚度**。所以每个数字的主语都是「我」——
   连续多少天、有多少天留下过记录、累计多少条。没有分数，也没有别人。 */

import { toBJ } from "./time.js";

/* 全组按北京时间归日。按各自本地时区分天的话，同一条记录在不同人的界面上
   会落在不同日期，跟服务端的日限额、日历页也就对不上了。 */
const bjMidnight = (ts) => { const d = toBJ(ts); d.setHours(0, 0, 0, 0); return d; };
/* 步进一天用 setDate 而不是加 86400000：浏览器所在时区有夏令时的话，
   加固定毫秒会落到前一天的 23 点或后一天的 1 点上。 */
const stepDay = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); x.setHours(0, 0, 0, 0); return x; };

/** 每天记了几条，键是那天（北京时间）零点的时间戳。 */
export function countByDay(records) {
  const m = new Map();
  for (const r of records || []) {
    if (!r?.at) continue;
    const k = bjMidnight(r.at).getTime();
    m.set(k, (m.get(k) || 0) + 1);
  }
  return m;
}

/** 格子的深浅。0 = 那天没记；1..3 越记越深，3 是一天的上限，记满就是最深那档。 */
export const levelOf = (n) => (n <= 0 ? 0 : Math.min(3, n));

/**
 * 贡献墙的格子：一列是一周（周一在上），从左往右排到 endTs 那一周。
 *
 * 周一起头是跟 app 其他地方对齐的（课表、日历都是周一起）。GitHub 用周日，
 * 但这是给中国的课题组用的，一周从周一开始。
 *
 * 还没到的日子标成 future 而不是 0 条：本周剩下的几天画成灰格子，看着像是
 * 已经旷了——而那是还没发生的事。
 */
export function buildWall(records, { weeks = 53, endTs = Date.now(), now = Date.now() } = {}) {
  const counts = countByDay(records);
  const today = bjMidnight(now).getTime();
  const end = bjMidnight(endTs);
  // 最后一列是 endTs 所在的那一周：先退到那周的周一
  const lastMon = stepDay(end, -((end.getDay() + 6) % 7));
  const cols = [];
  for (let w = weeks - 1; w >= 0; w--) {
    const mon = stepDay(lastMon, -w * 7);
    const col = [];
    for (let i = 0; i < 7; i++) {
      const d = stepDay(mon, i);
      const ms = d.getTime();
      const n = counts.get(ms) || 0;
      col.push({
        ms, n, level: levelOf(n),
        y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate(),
        today: ms === today, future: ms > today,
      });
    }
    cols.push(col);
  }
  return cols;
}

/**
 * 连续天数。
 *
 * 今天还没记**不算断**：一天还没过完，00:01 就把连续清零，只会让人觉得
 * 这东西在跟自己作对。所以今天空着就从昨天开始往回数。
 */
export function streaks(records, now = Date.now()) {
  const counts = countByDay(records);
  const has = (d) => (counts.get(d.getTime()) || 0) > 0;

  let cur = bjMidnight(now);
  if (!has(cur)) cur = stepDay(cur, -1);
  let current = 0;
  while (has(cur)) { current++; cur = stepDay(cur, -1); }

  const days = [...counts.entries()].filter(([, n]) => n > 0).map(([ms]) => ms).sort((a, b) => a - b);
  let longest = 0, run = 0, prev = null;
  for (const ms of days) {
    run = (prev !== null && stepDay(new Date(prev), 1).getTime() === ms) ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = ms;
  }
  return {
    current, longest,
    activeDays: days.length,
    total: (records || []).filter((r) => r?.at).length,
    firstAt: days[0] ?? null,
    lastAt: days[days.length - 1] ?? null,
  };
}

/** 某个自然月的小结。主页那张卡上「本月 11 天有记录」就是它。 */
export function monthStats(records, now = Date.now()) {
  const counts = countByDay(records);
  const t = bjMidnight(now);
  const y = t.getFullYear(), m = t.getMonth();
  let days = 0, total = 0;
  for (const [ms, n] of counts) {
    const d = new Date(ms);
    if (d.getFullYear() === y && d.getMonth() === m && n > 0) { days++; total += n; }
  }
  // 到今天为止这个月过了几天——分母用整月的话，1 号那天永远是「1/31」
  return { days, total, elapsed: t.getDate(), monthDays: new Date(y, m + 1, 0).getDate() };
}

/** 有记录的年份，从新到旧。墙上的年份切换按钮用它。 */
export function yearsWith(records) {
  const ys = new Set();
  for (const r of records || []) if (r?.at) ys.add(bjMidnight(r.at).getFullYear());
  return [...ys].sort((a, b) => b - a);
}

/** 某一年的小结。切到「2025」时上面那排数字换成那一年的。 */
export function yearStats(records, year) {
  const counts = countByDay(records);
  let days = 0, total = 0;
  for (const [ms, n] of counts) {
    if (new Date(ms).getFullYear() === year && n > 0) { days++; total += n; }
  }
  return { days, total };
}

/**
 * 成长台阶。
 *
 * 每一条的判据都只跟自己有关：连续了多久、留下过多少天、写了多少条。
 * 没有「比谁多」这种条件，也不给任何实物奖励——一给奖励，人就开始算
 * 怎么用最少的力气够到它，这一页就又变成了刷分。
 */
export const BADGES = [
  { key: "first", icon: "🌱", name: "破土", need: "写下第一条记录", at: (s) => s.total >= 1 },
  { key: "w1", icon: "🍃", name: "一周", need: "连续 7 天有记录", at: (s) => s.longest >= 7 },
  { key: "m1", icon: "🌿", name: "满月", need: "连续 30 天有记录", at: (s) => s.longest >= 30 },
  { key: "d100", icon: "🌳", name: "百日", need: "连续 100 天有记录", at: (s) => s.longest >= 100 },
  { key: "a10", icon: "📅", name: "十天", need: "累计 10 天有记录", at: (s) => s.activeDays >= 10 },
  { key: "a50", icon: "🗓", name: "五十天", need: "累计 50 天有记录", at: (s) => s.activeDays >= 50 },
  { key: "a200", icon: "📆", name: "两百天", need: "累计 200 天有记录", at: (s) => s.activeDays >= 200 },
  { key: "n50", icon: "📗", name: "五十条", need: "累计 50 条记录", at: (s) => s.total >= 50 },
  { key: "n200", icon: "📚", name: "两百条", need: "累计 200 条记录", at: (s) => s.total >= 200 },
];

/** 台阶的达成情况。没达成的也返回，界面上淡着显示——看得见下一级才有台阶可上。 */
export const badgeState = (s) => BADGES.map((b) => ({ ...b, got: !!b.at(s) }));
