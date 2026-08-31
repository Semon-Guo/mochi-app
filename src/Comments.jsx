/* 导师的回复与点赞。
 *
 * 回复做成双向的：单向的「导师说、学生看」没法用——导师问「暗场校正做了吗」，
 * 学生得能在原地答，否则他只能新开一条记录，对话就散了。
 *
 * 一条评论就是 comments 表里的一行，kind 区分回复和赞；取消赞 = 删掉那行。
 * 作者名字冗余存在 data.byName 里：学生拿不到成员名单（那是导师专属接口），
 * 不存的话他只会看到一串 user id。
 */
import { useState } from "react";
import { avatarFallback } from "./avatar.js";
import { LIKE, isMine, myLike } from "./comments.js";

export { LIKE, REPLY, indexComments, threadOf, isMine, myLike } from "./comments.js";

const MONO = "'JetBrains Mono','SF Mono','Menlo',monospace";
const C = { ink: "#2C2C2C", sub: "#8C8478", dim: "#B0A99B", line: "#EDE8DE",
            soft: "#FAF8F3", red: "#C02556", amber: "#E8A838" };


const fmtWhen = (ts) => {
  if (!ts) return "";
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
};

function MiniAvatar({ name, id, size = 22 }) {
  const fb = avatarFallback(name || "?", id);
  return (
    <div style={{ width: size, height: size, borderRadius: "50%", flexShrink: 0,
      background: fb.bg, color: fb.fg, display: "flex", alignItems: "center",
      justifyContent: "center", fontSize: size * 0.44, fontWeight: 700 }}>{fb.initial}</div>
  );
}

/**
 * 一条记录下面的赞和回复。
 * canLike 关掉的是「给自己的记录点赞」——那没什么意义，按钮不该出现。
 */
/* trailing 挂在「赞 / 回复」那一行的末尾。不这么做的话调用方只能把按钮和
   整个 Thread 并排放，线程一有回复就把它顶到最上面去，看着像是属于第一条回复的。 */
export function Thread({ thread, meId, canLike = true, onToggleLike, onReply, onDelete,
                        trailing, replyLabel = "点评" }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [pop, setPop] = useState(0);      // 变一次就重放一次弹跳动画
  const liked = myLike(thread, meId);
  const n = thread.likes.length;

  const send = () => {
    const t = text.trim();
    if (!t) return;
    onReply(t);
    setText("");
    setOpen(false);
  };

  return (
    <div style={{ marginTop: 9 }}>
      {thread.replies.length > 0 && (
        <div style={{ borderLeft: `2px solid ${C.line}`, paddingLeft: 9, margin: "0 0 8px" }}>
          {thread.replies.map((c) => (
            <div key={c.id} style={{ display: "flex", gap: 7, padding: "5px 0" }}>
              <MiniAvatar name={c.byName} id={c.ownerId || c.id} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: C.ink }}>
                    {c.byName || "某人"}
                  </span>
                  <span style={{ fontSize: 10, color: C.dim, fontFamily: MONO }}>{fmtWhen(c.at)}</span>
                  {isMine(c, meId) && onDelete && (
                    <button onClick={() => onDelete(c)} style={{
                      marginLeft: "auto", border: "none", background: "none", cursor: "pointer",
                      color: C.dim, fontSize: 10.5, fontFamily: "inherit", padding: 2,
                    }}>删除</button>
                  )}
                </div>
                <div style={{ fontSize: 13, lineHeight: 1.6, color: C.ink,
                  whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{c.text}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {canLike && (
          <button onClick={() => { if (!liked) setPop((v) => v + 1); onToggleLike?.(); }} style={{
            display: "inline-flex", alignItems: "center", gap: 5, padding: "4px 10px",
            borderRadius: 999, cursor: "pointer", fontFamily: "inherit", fontSize: 12, fontWeight: 600,
            border: `1px solid ${liked ? C.amber : C.line}`,
            background: liked ? "#FFF6E5" : "#FFF", color: liked ? "#B07C14" : C.sub,
            transition: "background .2s ease, border-color .2s ease, color .2s ease",
          }}>
            {/* key 变了才会重新挂载，动画才能重放 */}
            <span key={pop} className={pop ? "like-pop" : undefined}>{liked ? "★" : "☆"}</span>
            赞{n > 0 ? ` ${n}` : ""}
          </button>
        )}
        {!canLike && n > 0 && (
          <span style={{ fontSize: 12, color: "#B07C14", fontWeight: 600 }}>★ {n} 个赞</span>
        )}
        <button onClick={() => setOpen((v) => !v)} style={{
          display: "inline-flex", alignItems: "center", gap: 5, padding: "4px 10px",
          borderRadius: 999, cursor: "pointer", fontFamily: "inherit", fontSize: 12, fontWeight: 600,
          border: `1px solid ${C.line}`, background: "#FFF", color: C.sub,
        }}>💬 {replyLabel}{thread.replies.length ? ` ${thread.replies.length}` : ""}</button>
        {trailing && <span style={{ marginLeft: "auto", flexShrink: 0 }}>{trailing}</span>}
      </div>

      {open && (
        <div style={{ marginTop: 8 }}>
          <textarea
            autoFocus value={text} onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send(); }}
            rows={2} placeholder="写点什么…（⌘/Ctrl + Enter 发送）"
            style={{ width: "100%", padding: "9px 11px", borderRadius: 10, resize: "vertical",
              border: `1px solid ${C.line}`, background: "#FFF", color: C.ink,
              fontSize: 13, fontFamily: "inherit", outline: "none", boxSizing: "border-box" }} />
          <div style={{ display: "flex", gap: 7, marginTop: 6 }}>
            <button onClick={send} disabled={!text.trim()} style={{
              padding: "6px 14px", borderRadius: 9, border: "none", background: C.ink,
              color: "#FFF", fontSize: 12, fontWeight: 600, cursor: "pointer",
              fontFamily: "inherit", opacity: text.trim() ? 1 : 0.4,
            }}>发送</button>
            <button onClick={() => { setOpen(false); setText(""); }} style={{
              padding: "6px 14px", borderRadius: 9, border: `1px solid ${C.line}`,
              background: "#FFF", color: C.sub, fontSize: 12, fontWeight: 600,
              cursor: "pointer", fontFamily: "inherit",
            }}>取消</button>
          </div>
        </div>
      )}
    </div>
  );
}
