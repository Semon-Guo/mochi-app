/* 用 CDP 驱动无头 Chrome 给 dev/preview.html 截图：等页面自己说「渲染好了」再拍，
   不靠 --virtual-time-budget（那个会把 IndexedDB 的 promise 卡死）。
   用法: node shot.mjs <url> <out.png> [width] [waitTitlePrefix] */
import { writeFileSync } from "node:fs";

const [url, out, width = "430", wait = "READY"] = process.argv.slice(2);
const PORT = 9333;
// 先起一个带调试端口的无头 Chrome：
//   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
//     --remote-debugging-port=9333 --user-data-dir=/tmp/mochi-shot --hide-scrollbars &

const j = async (p) => (await fetch(`http://127.0.0.1:${PORT}${p}`)).json();
let ver;
for (let i = 0; i < 60; i++) {
  try { ver = await j("/json/version"); break; } catch { await new Promise(r => setTimeout(r, 250)); }
}
if (!ver) { console.error("连不上 Chrome 调试端口"); process.exit(1); }

// 新版 Chrome 的 /json/new 只接受 PUT
const target = await (await fetch(
  `http://127.0.0.1:${PORT}/json/new?${encodeURIComponent("about:blank")}`,
  { method: "PUT" })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
};
const send = (method, params = {}) => new Promise((res) => {
  const i = ++id; pending.set(i, res);
  ws.send(JSON.stringify({ id: i, method, params }));
});
await new Promise((r) => { ws.onopen = r; });

await send("Emulation.setDeviceMetricsOverride",
  { width: +width, height: 900, deviceScaleFactor: 2, mobile: false });
await send("Page.enable");
await send("Page.navigate", { url });

let ok = false;
for (let i = 0; i < 120; i++) {
  const r = await send("Runtime.evaluate", { expression: "document.title" });
  if (String(r?.result?.value || "").startsWith(wait)) { ok = true; break; }
  await new Promise((r) => setTimeout(r, 250));
}
if (!ok) {
  const dom = await send("Runtime.evaluate", { expression: "document.body.innerText.slice(0,500)" });
  const errs = await send("Runtime.evaluate", { expression: "(window.__errs||[]).join(' | ')" });
  console.error("页面没就绪。title 一直不对。body:", dom?.result?.value, "errs:", errs?.result?.value);
}

// 整页高度
const h = await send("Runtime.evaluate",
  { expression: "Math.min(document.documentElement.scrollHeight, 8000)" });
const full = Math.max(400, Math.ceil(h?.result?.value || 900));
await send("Emulation.setDeviceMetricsOverride",
  { width: +width, height: full, deviceScaleFactor: 2, mobile: false });
await new Promise((r) => setTimeout(r, 400));

const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
writeFileSync(out, Buffer.from(shot.data, "base64"));
console.log(`已截 ${out}  ${width}×${full}`);
ws.close();
process.exit(ok ? 0 : 2);
