/* 评论的纯数据逻辑。单独一个 .js 是为了能在 node 里直接单测——
   UI 在 Comments.jsx 里，带 JSX 的文件 node 跑不了。 */

export const LIKE = "like";
export const REPLY = "reply";

/** 一次遍历建好索引。逐条记录去 filter 是 O(记录数 × 评论数)，组里数据一多就卡。 */
export function indexComments(comments) {
  const map = new Map();
  for (const c of comments || []) {
    if (!c?.recordId) continue;
    let e = map.get(c.recordId);
    if (!e) map.set(c.recordId, (e = { replies: [], likes: [] }));
    (c.kind === LIKE ? e.likes : e.replies).push(c);
  }
  for (const e of map.values()) e.replies.sort((a, b) => (a.at || 0) - (b.at || 0));
  return map;
}

const EMPTY = { replies: [], likes: [] };
export const threadOf = (index, recordId) => index.get(recordId) || EMPTY;

/** 本机新建的评论还没有 ownerId（那是服务器回填的），所以「没有」也算我的 */
export const isMine = (c, meId) => !c.ownerId || c.ownerId === meId;
export const myLike = (thread, meId) => thread.likes.find((c) => isMine(c, meId));
