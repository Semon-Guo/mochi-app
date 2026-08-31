/* 数据文件：原始测量结果，跟照片走的完全是两条路。
 *
 * 照片是压好的缩略证据，几百 KB，存 IndexedDB 再由同步循环推上去，每台设备
 * 都留一份。数据文件动辄几百 MB——真按那个路子来，本地库会被撑爆，手机上
 * 更是直接崩掉，而且没人希望自己的手机后台默默拉下组里所有人的数据集。
 *
 * 所以：选中文件就直接分块传到服务器，本地不留副本；记录里只带文件名和大小
 * 这点元数据（跟着记录正文一起同步），谁要看原始数据谁点一下现下。
 *
 * 代价是上传必须在线。这是有意的取舍——离线时假装存下了、回头再传，对几百 MB
 * 的东西只会变成「以为传上去了其实没有」，那比当场说清楚糟得多。
 */
import { getServer } from "./sync.js";

/** 前端切片大小。切太小是白白多几百个来回，切太大则断线一次就白传一大截。 */
const CHUNK = 4 * 1024 * 1024;
const RETRIES = 3;

export function fmtBytes(n) {
  if (!(n > 0)) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

async function req(path, { method = "POST", token, body, raw, ctype, signal } = {}) {
  const res = await fetch(getServer() + path, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(raw !== undefined ? { "Content-Type": ctype || "application/octet-stream" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: raw !== undefined ? raw : (body !== undefined ? JSON.stringify(body) : undefined),
    signal,
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out?.error || `HTTP ${res.status}`);
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 把一个文件传上去，返回记进记录里的那点元数据。
 * onProgress 收到 0~1 的进度；signal 可以中途取消。
 */
export async function uploadFile(file, id, { token, onProgress, signal } = {}) {
  if (!token) throw new Error("要先登录才能上传数据文件");
  const mime = file.type || "application/octet-stream";
  const meta = { name: file.name, size: file.size, mime };

  // init 同时是「问断点在哪」：中断后重来一次就从服务器已收到的位置接着传，
  // 不用把前面几百 MB 再走一遍。
  const start = () => req(`/api/file/${id}/init`, { token, body: meta, signal });

  let { received, done } = await start();
  onProgress?.(done ? 1 : received / file.size);

  let fails = 0;
  while (!done) {
    if (signal?.aborted) throw new DOMException("已取消", "AbortError");
    const end = Math.min(received + CHUNK, file.size);
    try {
      const r = await req(`/api/file/${id}?offset=${received}`, {
        token, raw: file.slice(received, end), ctype: mime, signal });
      received = r.received;
      done = r.done;
      fails = 0;
    } catch (e) {
      if (e.name === "AbortError") throw e;
      if (++fails > RETRIES) throw e;
      await sleep(500 * fails);
      ({ received, done } = await start());   // 以服务器的进度为准，别猜
    }
    onProgress?.(done ? 1 : received / file.size);
  }
  return { id, ...meta };
}

/** 撤掉一个还没被记录引用的文件。服务器也会定期回收，这里只是让它立刻消失。 */
export async function dropFile(id, token) {
  if (!token) return;
  await req(`/api/file/${id}/drop`, { token }).catch(() => {});
}

/**
 * 下载。几百 MB 的东西必须交给浏览器自己去拉——能断点续传、能进下载列表、
 * 不占页面内存。而 <a href> 带不上 Authorization 头，所以先换一张五分钟有效
 * 的下载票，长期 token 不进 URL、不进服务器日志。
 */
export async function downloadFile(f, token) {
  const { url } = await req(`/api/file/${f.id}/ticket`, { token });
  const a = document.createElement("a");
  a.href = getServer() + url;
  a.rel = "noopener";
  a.download = f.name || "";      // 同源时生效；跨域时靠服务端的 Content-Disposition
  document.body.appendChild(a);
  a.click();
  a.remove();
}
