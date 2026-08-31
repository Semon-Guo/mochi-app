/* 积分榜。
 *
 * 分数怎么来的：一条记录 1 分（每天封顶 3 条），导师的每个赞、每条点评各 5 分。
 * 权重差 5 倍是刻意的——记录是自己写的，导师的认可不是，后者才是这个榜想
 * 鼓励的东西。所以榜单上一定要把「记录 / 赞 / 点评」拆开显示，不然分数是个
 * 黑箱，看不出该往哪使劲。
 *
 * 榜单由服务端算：学生本地只有自己的数据，看不见别人的名次，那就不成其为榜。
 */
import { useState, useEffect } from "react";
import * as Sync from "./sync.js";
import { Avatar } from "./AdvisorView.jsx";

const C = {
  bg: "#FDFBF7", panel: "#FFFDF9", ink: "#2C2C2C", sub: "#8C8478",
  dim: "#B0A99B", line: "#EDE8DE", hair: "#F4F0E7", edge: "#E8E4DA",
  gold: "#C9992B", silver: "#9AA0A6", bronze: "#B07A4E", green: "#5A9E4B",
};
const MONO = "'JetBrains Mono','SF Mono','Menlo',monospace";
const PERIODS = [["week", "周榜"], ["month", "月榜"], ["year", "年榜"]];
const MEDAL = { 1: C.gold, 2: C.silver, 3: C.bronze };

function Rank({ n }) {
  const c = MEDAL[n];
  return (
    <div style={{
      width: 28, height: 28, borderRadius: "50%", flexShrink: 0,
      display: "flex", alignItems: "center", justifyContent: "center",
      fontSize: n >= 10 ? 12 : 14, fontWeight: 800, fontFamily: MONO,
      background: c ? c : "transparent", color: c ? "#FFF" : C.dim,
      boxShadow: c ? `0 2px 6px ${c}55` : `inset 0 0 0 1px ${C.line}`,
    }}>{n}</div>
  );
}

const Bits = ({ r }) => (
  <span style={{ fontSize: 10.5, color: C.dim, fontFamily: MONO }}>
    记录 {r.records} · 赞 {r.likes} · 点评 {r.replies}
  </span>
);

export function Leaderboard({ onClose }) {
  const [period, setPeriod] = useState("week");
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);
  const auth = Sync.getAuth();
  const meId = auth?.user?.id;

  useEffect(() => {
    if (!auth) { setLoading(false); setErr("登录后才能看排行榜"); return; }
    let alive = true;
    setLoading(true); setErr("");
    Sync.fetchLeaderboard(auth.token, period, offset)
      .then((r) => { if (alive) { setData(r); setLoading(false); } })
      .catch((e) => { if (alive) { setErr(e.message); setLoading(false); } })
    return () => { alive = false; };
  }, [period, offset, auth?.token]);

  const rows = data?.rows || [];
  const mine = rows.find((x) => x.userId === meId);
  const rules = data?.rules;

  const navBtn = (dis) => ({
    border: "none", background: "none", cursor: dis ? "default" : "pointer",
    color: dis ? C.hair : C.sub, fontSize: 20, padding: "2px 10px", lineHeight: 1,
    fontFamily: "inherit",
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
          <div style={{ fontSize: 20, fontWeight: 700 }}>积分榜</div>
          <div style={{ fontSize: 11.5, color: C.sub }}>
            记录 1 分 · 导师点赞 / 点评各 5 分
          </div>
        </div>
      </div>

      <div style={{ padding: "0 var(--app-pad)" }}>
        <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
          {PERIODS.map(([k, label]) => (
            <button key={k} onClick={() => { setPeriod(k); setOffset(0); }} style={{
              flex: 1, padding: "9px 0", borderRadius: 11, cursor: "pointer", fontFamily: "inherit",
              fontSize: 13.5, fontWeight: 700,
              border: period === k ? `1px solid ${C.ink}` : `1px solid ${C.line}`,
              background: period === k ? C.ink : "#FFF", color: period === k ? "#FFF" : C.sub,
            }}>{label}</button>
          ))}
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "center",
          gap: 6, marginBottom: 12 }}>
          <button onClick={() => setOffset((o) => o - 1)} style={navBtn(false)}>‹</button>
          <div style={{ textAlign: "center", minWidth: 130 }}>
            <div style={{ fontSize: 14.5, fontWeight: 700 }}>{data?.label || "…"}</div>
            <div style={{ fontSize: 10.5, color: C.dim }}>
              {offset === 0 ? "当前" : offset === -1 ? "上一期" : `${-offset} 期前`}
            </div>
          </div>
          <button onClick={() => setOffset((o) => Math.min(0, o + 1))}
            style={navBtn(offset >= 0)}>›</button>
        </div>

        {err && (
          <div style={{ padding: "12px 14px", borderRadius: 12, background: "#FFF0F3",
            border: "1px solid #F3C6D2", color: "#C02556", fontSize: 12.5, lineHeight: 1.6 }}>
            {err}
          </div>
        )}
        {loading && !err && (
          <div style={{ textAlign: "center", color: C.dim, fontSize: 13, padding: "30px 0" }}>
            正在算…
          </div>
        )}

        {/* 自己那一条钉在最上面：翻榜的人第一眼找的就是自己 */}
        {!loading && !err && mine && (
          <div style={{ display: "flex", alignItems: "center", gap: 11, padding: "13px 14px",
            marginBottom: 12, borderRadius: 15, background: C.ink, color: "#FFF" }}>
            <Rank n={mine.rank} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14.5, fontWeight: 700 }}>我</div>
              <span style={{ fontSize: 10.5, color: "rgba(255,255,255,.6)", fontFamily: MONO }}>
                记录 {mine.records} · 赞 {mine.likes} · 点评 {mine.replies}
              </span>
            </div>
            <div style={{ textAlign: "right", flexShrink: 0 }}>
              <div style={{ fontSize: 24, fontWeight: 800, fontFamily: MONO, lineHeight: 1 }}>
                {mine.points}
              </div>
              <div style={{ fontSize: 10, color: "rgba(255,255,255,.6)" }}>分</div>
            </div>
          </div>
        )}

        {!loading && !err && rows.map((r) => {
          const isMe = r.userId === meId;
          return (
            <div key={r.userId} style={{
              display: "flex", alignItems: "center", gap: 11, padding: "11px 13px",
              marginBottom: 7, borderRadius: 14, background: C.panel,
              border: `1px solid ${isMe ? C.edge : C.line}`,
              opacity: r.points ? 1 : .55,
            }}>
              <Rank n={r.rank} />
              <Avatar user={r} size={34} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 700, overflow: "hidden",
                  textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.displayName}</div>
                <Bits r={r} />
                {r.reward && (
                  <div style={{ display: "inline-block", marginTop: 4, fontSize: 10.5,
                    fontWeight: 700, color: "#3F7A33", background: "#EEF6EA",
                    padding: "2px 8px", borderRadius: 999 }}>🎁 {r.reward}</div>
                )}
              </div>
              <div style={{ textAlign: "right", flexShrink: 0 }}>
                <div style={{ fontSize: 19, fontWeight: 800, fontFamily: MONO, lineHeight: 1,
                  color: r.points ? C.ink : C.dim }}>{r.points}</div>
                <div style={{ fontSize: 9.5, color: C.dim }}>分</div>
              </div>
            </div>
          );
        })}

        {!loading && !err && rows.length === 0 && (
          <div style={{ textAlign: "center", color: C.dim, fontSize: 13, padding: "30px 0" }}>
            这一期还没有人得分
          </div>
        )}

        {rules && !loading && !err && (
          <div style={{ marginTop: 14, border: `1px solid ${C.line}`, borderRadius: 14,
            background: C.panel, padding: "13px 14px" }}>
            <div style={{ fontSize: 10.5, fontWeight: 700, color: C.sub, letterSpacing: "0.4px",
              marginBottom: 9 }}>怎么算分 · 拿什么</div>
            <div style={{ fontSize: 12.5, color: C.ink, lineHeight: 1.85 }}>
              一条实验记录 <b>{rules.record} 分</b>，每天最多算 <b>{rules.dailyCap} 条</b>；
              导师的每个赞 <b>{rules.like} 分</b>、每条点评 <b>{rules.reply} 分</b>。
            </div>
            <div style={{ height: 1, background: C.hair, margin: "10px 0" }} />
            {[["周榜", ["第 1 名：1 天事假额度", "前 3 名：免一周值日"]],
              ["月榜", ["第 1 名：2 天事假", "第 2 名：1 天事假", "第 3 名：0.5 天事假"]],
              ["年榜", ["按积分占比分配年终激励"]]].map(([t, items]) => (
              <div key={t} style={{ display: "flex", gap: 10, padding: "4px 0" }}>
                <span style={{ fontSize: 11.5, fontWeight: 700, color: C.sub,
                  width: 34, flexShrink: 0 }}>{t}</span>
                <span style={{ fontSize: 11.5, color: C.sub, lineHeight: 1.7 }}>
                  {items.join("；")}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
