/* 导师端「哪些记录我还没看过」。
 *
 * 只存在本机，不上服务器：这是一个人的阅读状态，没有任何理由让别人（尤其是
 * 被看的学生）知道导师读没读、什么时候读的。
 */
const SK = "mochi_seen_records";

function readAll() {
  try { return JSON.parse(localStorage.getItem(SK) || "{}"); } catch { return {}; }
}
function writeAll(o) {
  try { localStorage.setItem(SK, JSON.stringify(o)); } catch {}
}

/**
 * 取这个人的已读集合。第一次用的时候把「现有的全部」直接记成已读——
 * 否则导师头一回打开，会被课题组历史上的每一条记录糊一脸。
 */
export function loadSeen(userId, existingIds = []) {
  if (!userId) return new Set(existingIds);
  const all = readAll();
  if (!Array.isArray(all[userId])) {
    writeAll({ ...all, [userId]: existingIds });
    return new Set(existingIds);
  }
  return new Set(all[userId]);
}

/** 落盘。顺手丢掉已经不存在的记录 id，不然这个集合只增不减。 */
export function persistSeen(userId, seen, existingIds = []) {
  if (!userId) return;
  const alive = new Set(existingIds);
  writeAll({ ...readAll(), [userId]: [...seen].filter((id) => alive.has(id)) });
}
