/* 个人成就树 —— 一面自己的贡献墙。
 *
 * 这一页是用来替掉积分榜的，所以先说清楚它**不是**什么：
 * 没有名次，没有分数，没有奖励，也拿不到任何一个别人的数字——它读的是本机那份
 * 「我自己的记录」，一个接口都不调，也没有「去看别人的成就树」这种入口。
 *
 * 但**别把它说成隐私**。墙是从记录算出来的，而记录本身照常可见：个人课题全组
 * 看得到，导师端每个人的详情页里还有一张按天的活跃热力图，跟这面墙是同一份数据。
 * 所以界面上只说「只算你自己的记录」，绝不说「只有你看得到」——那句话是假的，
 * 学生信了它，会把不想让人知道的节奏也当成是藏起来了的。
 *
 * 留下的只有 GitHub 那面绿墙：今天记了一条，墙上就亮一格。它要回答的不是
 * 「我排第几」，而是「我这个月有没有虚度」——回头看见一整片绿，那份踏实感
 * 是自己给自己的，不用跟同门抢。
 *
 * 数据逻辑在 achievements.js 里（能在 node 里单测），这里只管画。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { buildWall, streaks, monthStats, yearsWith, yearStats, badgeState } from "./achievements.js";

const C = {
  bg: "#FDFBF7", panel: "#FFF", ink: "#2C2C2C", sub: "#8C8478",
  dim: "#B0A99B", line: "#EDE8DE", hair: "#F4F0E7", edge: "#E8E4DA",
  green: "#5A9E4B", amber: "#C08A1E",
};
const MONO = "'JetBrains Mono','SF Mono','Menlo',monospace";

/* 四档：没记 / 1 条 / 2 条 / 记满。档位对着一天最多 3 条，不是随手挑的深浅——
   格子的颜色因此是有字面意思的，看一眼就知道那天写了几条。 */
const SHADE = ["#F0ECE2", "#C9E2C0", "#8FC47F", "#4E8F3F"];
const CELL = 10, GAP = 3, STEP = CELL + GAP;
const WD = ["一", "二", "三", "四", "五", "六", "日"];

/* ── 一个格子 ──
   还没到的日子画成透明：灰格子看着像是已经旷了，而那是还没发生的事。 */
function Cell({ c, size = CELL }) {
  const title = c.future ? "" : `${c.y}/${c.m}/${c.d} · ${c.n ? `${c.n} 条` : "没有记录"}`;
  return (
    <div title={title} className={c.today && c.n ? "wall-today" : undefined} style={{
      width: size, height: size, borderRadius: 2.5, boxSizing: "border-box",
      background: c.future ? "transparent" : SHADE[c.level],
      outline: c.future ? "none" : "1px solid rgba(0,0,0,.03)",
      // 今天单独描一圈，好在一片格子里一眼找到「今天亮没亮」
      boxShadow: c.today ? `0 0 0 1.5px ${c.n ? C.green : C.dim}` : undefined,
    }} />
  );
}

/* ── 墙本身 ── */
function Wall({ cols, size = CELL }) {
  return (
    <div style={{ display: "flex", gap: GAP }}>
      {/* key 用那一周的周一，不用下标：主页那张卡量完宽度会改周数，
          用下标的话同一周会换一个 key，被拆掉重建，今天那格的动画就放两遍 */}
      {cols.map((col) => (
        <div key={col[0].ms} style={{ display: "grid", gap: GAP }}>
          {col.map((c) => <Cell key={c.ms} c={c} size={size} />)}
        </div>
      ))}
    </div>
  );
}

/** 图例。没有它，深一格浅一格就只是好看，不知道在说什么。 */
const Legend = () => (
  <span style={{ display: "inline-flex", alignItems: "center", gap: 3,
    fontSize: 10, color: C.dim, fontFamily: MONO }}>
    少
    {SHADE.map((s, i) => (
      <span key={i} style={{ width: 8, height: 8, borderRadius: 2, background: s }} />
    ))}
    多
  </span>
);

/**
 * 容器有多宽就画多少列。
 *
 * 主页那张卡不该横向滚动——首页上一条会吃掉手势的滚动区是很烦的东西。
 * 所以量一下宽度，能塞几周画几周，右边永远是本周。
 */
function useFitWeeks(max = 53) {
  const ref = useRef(null);
  const [n, setN] = useState(16);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      const w = el.clientWidth;
      if (w > 0) setN(Math.max(6, Math.min(max, Math.floor((w + GAP) / STEP))));
    };
    fit();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [max]);
  return [ref, n];
}

/* ── 主页上那张卡 ──
   「今天有没有亮」得在主页就看得见，点进去才知道的话，这个机制一天也用不上。 */
export function WallCard({ records, todayCount = 0, dailyCap = 3, onOpen }) {
  // 上限给满一年：手机上大概能塞 28 周，桌面那档宽度正好摊开一整年。
  // 卡死在 30 的话，宽屏上右边会空掉一大块，看着像是没画完。
  const [ref, weeks] = useFitWeeks(53);
  const cols = useMemo(() => buildWall(records, { weeks }), [records, weeks]);
  const s = useMemo(() => streaks(records), [records]);
  const mo = useMemo(() => monthStats(records), [records]);

  return (
    <button onClick={onOpen} style={{
      width: "100%", display: "block", textAlign: "left", marginBottom: 10,
      padding: "12px 13px 11px", borderRadius: 13, cursor: "pointer", fontFamily: "inherit",
      border: `1px solid ${C.edge}`, background: C.panel, color: C.ink,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 10 }}>
        <span style={{ fontSize: 15 }}>🌳</span>
        <span style={{ fontSize: 14, fontWeight: 700, flex: 1 }}>我的成就树</span>
        <span style={{ fontSize: 11.5, fontWeight: 700, fontFamily: MONO,
          color: todayCount ? C.green : C.dim }}>
          {todayCount ? `今天亮了 ${todayCount}/${dailyCap}` : "今天还没亮"}
        </span>
        <span style={{ color: C.dim, fontSize: 15, lineHeight: 1 }}>›</span>
      </div>
      {/* 量宽度的那一层要自己独占一行，跟格子分开：格子是 flex 子项，
          它的 clientWidth 会被内容撑着走，量出来永远是「刚好装下现在这些」 */}
      <div ref={ref} style={{ overflow: "hidden" }}>
        <Wall cols={cols} />
      </div>
      <div style={{ marginTop: 9, fontSize: 11, color: C.sub, fontFamily: MONO }}>
        {s.total === 0
          ? "记下第一条，墙上就会亮起第一格"
          : `连续 ${s.current} 天 · 本月 ${mo.days} 天有记录`}
      </div>
    </button>
  );
}

/* ── 月份刻度 ──
   哪一列是「10 月」得标出来，否则一年的墙就是一片没有坐标的绿。
   只在换月的那一列标，且跟上一个标至少隔 3 列，免得挤成一团。 */
function MonthRuler({ cols }) {
  const marks = [];
  let last = -1, lastAt = -99;
  cols.forEach((col, i) => {
    const m = col[0].m;
    if (m !== last && i - lastAt >= 3) { marks.push({ i, m }); lastAt = i; }
    last = m;
  });
  return (
    <div style={{ position: "relative", height: 13, marginBottom: 3,
      width: cols.length * STEP }}>
      {marks.map(({ i, m }) => (
        <span key={i} style={{ position: "absolute", left: i * STEP, top: 0,
          fontSize: 9.5, color: C.dim, fontFamily: MONO, whiteSpace: "nowrap" }}>{m} 月</span>
      ))}
    </div>
  );
}

const Panel = ({ title, children, style }) => (
  <div style={{ border: `1px solid ${C.line}`, borderRadius: 14, background: C.panel,
    padding: "13px 14px", marginBottom: 10, ...style }}>
    {title && (
      <div style={{ fontSize: 10.5, fontWeight: 700, color: C.sub, letterSpacing: "0.4px",
        marginBottom: 10 }}>{title}</div>
    )}
    {children}
  </div>
);

const Num = ({ v, label }) => (
  <div style={{ flex: 1, minWidth: 0 }}>
    <div style={{ fontSize: 21, fontWeight: 800, fontFamily: MONO, letterSpacing: "-0.5px",
      lineHeight: 1.1 }}>{v}</div>
    <div style={{ fontSize: 10.5, color: C.sub, marginTop: 3 }}>{label}</div>
  </div>
);

/* ── 整页 ── */
export function AchievementTree({ records, projects = [], todayCount = 0, dailyCap = 3, onClose }) {
  const [year, setYear] = useState(null);        // null = 最近一年
  const scroller = useRef(null);

  const s = useMemo(() => streaks(records), [records]);
  const mo = useMemo(() => monthStats(records), [records]);
  const years = useMemo(() => yearsWith(records), [records]);
  const cols = useMemo(() => (year
    ? buildWall(records, { weeks: 53, endTs: new Date(year, 11, 31).getTime() })
    : buildWall(records, { weeks: 53 })), [records, year]);
  const span = useMemo(() => (year ? yearStats(records, year)
    : { days: s.activeDays, total: s.total }), [records, year, s]);
  const badges = useMemo(() => badgeState(s), [s]);
  const next = badges.find((b) => !b.got);

  // 一年的墙比屏幕宽，默认停在最右边——人先想看的永远是这一周
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = year ? 0 : el.scrollWidth;
  }, [year]);

  const byProject = useMemo(() => {
    const n = new Map();
    for (const r of records || []) n.set(r.projectId, (n.get(r.projectId) || 0) + 1);
    return [...n.entries()]
      .map(([id, count]) => ({ id, count, p: projects.find((x) => x.id === id) }))
      .sort((a, b) => b.count - a.count);
  }, [records, projects]);

  const tabBtn = (on) => ({
    padding: "6px 13px", borderRadius: 9, cursor: "pointer", fontFamily: "inherit",
    fontSize: 12.5, fontWeight: 700, flexShrink: 0,
    border: `1px solid ${on ? C.ink : C.line}`,
    background: on ? C.ink : "#FFF", color: on ? "#FFF" : C.sub,
  });

  return (
    <div className="app-shell" style={{
      fontFamily: "'Outfit','Noto Serif SC',sans-serif", background: C.bg, minHeight: "100vh",
      maxWidth: "var(--app-w)", margin: "0 auto", paddingBottom: 48, color: C.ink,
    }}>
      <div style={{ padding: "46px var(--app-pad) 14px", display: "flex", alignItems: "center",
        gap: 11, borderBottom: `1px solid ${C.line}`, marginBottom: 14 }}>
        <button onClick={onClose} className="hit" style={{ border: "none", background: "none",
          cursor: "pointer", color: C.sub, fontSize: 22, padding: "0 4px 3px", lineHeight: 1,
          borderRadius: 8 }}>‹</button>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 20, fontWeight: 700 }}>成就树</div>
          <div style={{ fontSize: 11.5, color: C.sub }}>只算你自己的记录 · 不排名次</div>
        </div>
      </div>

      <div style={{ padding: "0 var(--app-pad)" }}>
        {/* ── 当前连续 ──
            整页最大的那个数字只能是「我」的。放「本周记录数」也行，但连续天数
            是唯一一个**只要今天动手就能保住**的数——它指向的是明天。 */}
        <div style={{ borderRadius: 15, background: C.ink, color: "#FFF",
          padding: "15px 16px", marginBottom: 10 }}>
          <div style={{ display: "flex", alignItems: "center" }}>
            <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.6px",
              color: "rgba(255,255,255,.6)" }}>连续记录</span>
            <span style={{ marginLeft: "auto", fontSize: 11, fontFamily: MONO,
              color: todayCount ? "#9FD98F" : "rgba(255,255,255,.55)" }}>
              {todayCount ? `今天已亮 ${todayCount}/${dailyCap}` : "今天还没亮"}
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 5, marginTop: 4 }}>
            <span style={{ fontSize: 36, fontWeight: 800, fontFamily: MONO,
              letterSpacing: "-1.5px", lineHeight: 1 }}>{s.current}</span>
            <span style={{ fontSize: 14, fontWeight: 700 }}>天</span>
          </div>
          <div style={{ fontSize: 11.5, lineHeight: 1.7, marginTop: 8,
            color: "rgba(255,255,255,.72)" }}>
            {s.total === 0
              ? "还没有记录。写下第一条，这面墙上就会亮起第一格。"
              : todayCount
                ? `这个月已经有 ${mo.days} 天留下了记录，不是虚度的一个月。`
                : s.current > 0
                  ? `昨天为止连了 ${s.current} 天。今天记一条就接上了。`
                  : "断了没关系——今天记一条，连续就从 1 重新开始。"}
          </div>
        </div>

        {/* 有跨年的数据才给切换：只用过一年的人，看到一排年份只会觉得多余 */}
        {years.length > 1 && (
          <div style={{ display: "flex", gap: 6, marginBottom: 10, overflowX: "auto",
            paddingBottom: 2 }}>
            <button onClick={() => setYear(null)} style={tabBtn(year === null)}>最近一年</button>
            {years.map((y) => (
              <button key={y} onClick={() => setYear(y)} style={tabBtn(year === y)}>{y}</button>
            ))}
          </div>
        )}

        <Panel>
          <div style={{ display: "flex", gap: 5 }}>
            {/* 星期标在左边，跟着墙一起固定住——横向滚的时候它不该跟着跑 */}
            <div style={{ display: "grid", gap: GAP, paddingTop: 16, flexShrink: 0 }}>
              {WD.map((w, i) => (
                <div key={w} style={{ height: CELL, fontSize: 9, lineHeight: `${CELL}px`,
                  color: i % 2 ? "transparent" : C.dim, fontFamily: MONO }}>{w}</div>
              ))}
            </div>
            <div ref={scroller} style={{ overflowX: "auto", flex: 1, minWidth: 0,
              paddingBottom: 2 }}>
              <MonthRuler cols={cols} />
              <Wall cols={cols} />
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10,
            paddingTop: 9, borderTop: `1px solid ${C.hair}` }}>
            <span style={{ fontSize: 11, color: C.sub, fontFamily: MONO }}>
              {year ? `${year} 年` : "过去一年"} · {span.total} 条 · {span.days} 天有记录
            </span>
            <span style={{ marginLeft: "auto" }}><Legend /></span>
          </div>
        </Panel>

        {/* 四个数字的主语都是「我」。这一排从头到尾没有一个「比」字——
            全组的数字服务端根本不聚合，界面上也就无从比起。 */}
        <Panel title="有记录的天数与条数">
          <div style={{ display: "flex", gap: 10 }}>
            <Num v={s.activeDays} label="累计天数" />
            <Num v={s.total} label="累计条数" />
            <Num v={s.longest} label="最长连续" />
            <Num v={mo.days} label="本月天数" />
          </div>
        </Panel>

        {/* ── 成长台阶 ──
            没达成的也画出来（淡着），看得见下一级才有台阶可上。达成的不弹彩带、
            不发奖励：一给奖励，人就开始算怎么用最少的力气够到它。 */}
        <Panel title="成长">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
            {badges.map((b) => (
              <span key={b.key} title={b.need} style={{
                display: "inline-flex", alignItems: "center", gap: 5,
                padding: "5px 10px", borderRadius: 999, fontSize: 11.5, fontWeight: 700,
                border: `1px solid ${b.got ? "#D6E8CE" : C.line}`,
                background: b.got ? "#F1F7EE" : "#FBF9F5",
                color: b.got ? "#3F7A33" : C.dim,
                filter: b.got ? "none" : "grayscale(1)", opacity: b.got ? 1 : 0.7,
              }}>
                <span style={{ fontSize: 13 }}>{b.icon}</span>{b.name}
              </span>
            ))}
          </div>
          <div style={{ fontSize: 11.5, color: C.sub, lineHeight: 1.7, marginTop: 10 }}>
            {next ? <>下一级：<b style={{ color: C.ink }}>{next.name}</b> · {next.need}</>
                  : "全部走完了。这面墙接着长就是了。"}
          </div>
        </Panel>

        {byProject.length > 0 && (
          <Panel title="按课题分布">
            {byProject.map(({ id, count, p }) => {
              const pct = Math.round((count / (s.total || 1)) * 100);
              return (
                <div key={id || "none"} style={{ display: "flex", alignItems: "center",
                  gap: 9, padding: "6px 0" }}>
                  <span style={{ fontSize: 12.5, flex: 1, minWidth: 0, overflow: "hidden",
                    textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p?.name || "未归类"}</span>
                  <div style={{ width: 88, height: 5, borderRadius: 3, background: C.hair,
                    overflow: "hidden", flexShrink: 0 }}>
                    <div style={{ width: `${pct}%`, height: "100%",
                      background: p?.color?.accent || p?.color || C.green }} />
                  </div>
                  <span style={{ fontSize: 11, fontFamily: MONO, color: C.sub, width: 26,
                    textAlign: "right", flexShrink: 0 }}>{count}</span>
                </div>
              );
            })}
          </Panel>
        )}

        {/* 这段话是这一页存在的理由，不是装饰，所以它留在页面里而不是只写在代码注释里 */}
        <div style={{ border: `1px solid ${C.line}`, borderRadius: 14, background: "#FBF9F5",
          padding: "13px 14px", fontSize: 11.5, color: C.sub, lineHeight: 1.9 }}>
          这一页<b style={{ color: C.ink }}>只算你自己的记录</b>，
          没有名次、没有分数、也没有奖励——它不是用来跟同门比的，是用来回头看的：
          这个月过去了 {mo.elapsed} 天，你有 <b style={{ color: C.ink }}>{mo.days} 天</b>
          在这面墙上留下了痕迹。
        </div>
      </div>
    </div>
  );
}
