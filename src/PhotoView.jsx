/* 照片的显示组件。
 *
 * 单独一个模块是因为主应用和导师端都要用同一套「Blob → objectURL → 用完撤销」
 * 的逻辑，而 todo-notes-app.jsx 本身 import 了 AdvisorView，反过来引会成环。
 */
import { useState, useEffect } from "react";
import { getPhoto } from "./photos.js";

/** 读一张照片。返回 objectURL；blob 不在本地时返回 null 并置 missing。 */
function usePhotoURL(id) {
  const [state, setState] = useState({ url: null, missing: false });
  useEffect(() => {
    let alive = true, made = null;
    setState({ url: null, missing: false });
    getPhoto(id)
      .then((b) => {
        if (!alive) return;
        // 本地没有这张：同步还没轮到它，或者它压根没被上传方传上来。
        // 得跟「正在加载」区分开——否则界面上就是一个永远空着的灰块。
        if (!b) return setState({ url: null, missing: true });
        made = URL.createObjectURL(b);
        setState({ url: made, missing: false });
      })
      .catch(() => { if (alive) setState({ url: null, missing: true }); });
    return () => { alive = false; if (made) URL.revokeObjectURL(made); };
  }, [id]);
  return state;
}

/** 缩略图。onOpen 收到这张照片的 id。 */
export function Photo({ id, size = 78, onOpen }) {
  const { url, missing } = usePhotoURL(id);
  const clickable = url && onOpen;
  return (
    <div
      onClick={clickable ? (e) => { e.stopPropagation(); onOpen(id); } : undefined}
      title={missing ? "这张还没同步到本机" : undefined}
      style={{
        width: size, height: size, borderRadius: 10, flexShrink: 0, overflow: "hidden",
        background: "#F0EDE6", border: "1px solid #E7E2D6",
        backgroundImage: url ? `url(${url})` : "none",
        backgroundSize: "cover", backgroundPosition: "center",
        cursor: clickable ? "pointer" : "default",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}
    >
      {missing && <span style={{ fontSize: Math.max(11, size * 0.26), opacity: .35 }}>📷</span>}
    </div>
  );
}

/** 全屏大图 */
export function FullPhoto({ id }) {
  const { url, missing } = usePhotoURL(id);
  if (url) {
    return <img src={url} alt="" style={{ maxWidth: "100%", maxHeight: "100%", borderRadius: 10, objectFit: "contain" }} />;
  }
  return (
    <span style={{ color: "#888", fontSize: 13 }}>
      {missing ? "这张照片还没同步到本机" : "载入中…"}
    </span>
  );
}
