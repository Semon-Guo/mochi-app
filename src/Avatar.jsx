/* 头像组件。
 *
 * 单独一个模块的原因跟 PhotoView.jsx 一样：导师端、报备页和主应用都要用它，
 * 而 todo-notes-app.jsx 和 AdvisorView.jsx 之间已经有一条 import 边，
 * 谁再反过来引谁就成环。放这儿谁都能引，谁都不成环。
 */
import { avatarFallback } from "./avatar.js";

const RING_BG = "#FDFBF7";
const RING_LINE = "#EDE8DE";

export function Avatar({ user, size = 36, ring = false }) {
  const fb = avatarFallback(user?.displayName || user?.username, user?.id);
  const common = {
    width: size, height: size, borderRadius: "50%", flexShrink: 0,
    boxShadow: ring ? `0 0 0 2px ${RING_BG}, 0 0 0 3px ${RING_LINE}` : undefined,
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
