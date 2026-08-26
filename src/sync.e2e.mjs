/* 前端同步引擎 × 后端服务 的端到端测试：node src/sync.e2e.mjs
 *
 * 起一个真实的服务实例（临时目录、明文 HTTP、不碰正式数据），
 * 用前端真正的 stampChanges / syncOnce / mergeIncoming 模拟两台设备来回同步。
 * 单测各自绿不代表拼起来是对的，这里验证的就是「拼起来」。
 */
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SERVER = join(HERE, "..", "server", "mochi_server.py");
const PORT = 39218;
const BASE = `http://127.0.0.1:${PORT}`;
const INVITE = "e2e-invite";

// sync.js 依赖 localStorage —— 每个「设备」一份独立的存储
const stores = {};
let current = "A";
globalThis.localStorage = {
  getItem: (k) => (stores[current]?.[k] ?? null),
  setItem: (k, v) => { (stores[current] ||= {})[k] = String(v); },
  removeItem: (k) => { delete stores[current]?.[k]; },
};
const asDevice = (name) => { current = name; stores[name] ||= {}; };

const Sync = await import("./sync.js");

let passed = 0, failed = 0;
const chk = (name, cond, info = "") => {
  if (cond) { passed++; console.log(`  PASS  ${name}${info ? "  " + info : ""}`); }
  else { failed++; console.log(`  FAIL  ${name}${info ? "  " + info : ""}`); }
};

const base = () => ({ todos: [], notes: [], projects: [], records: [] });

/** 模拟一台设备：本地数据 + 一次完整同步 */
async function syncDevice(dev, data, token) {
  asDevice(dev);
  Sync.setServer(BASE);   // 每台设备各自存服务器地址，新设备要先配
  const { sync, incoming, pushed, pulled } = await Sync.syncOnce(data, token);
  return { data: Sync.mergeIncoming(data, sync, incoming), pushed, pulled };
}

const tmp = mkdtempSync(join(tmpdir(), "mochi-e2e-"));
const proc = spawn("python3", [SERVER], {
  env: { ...process.env, MOCHI_DATA: tmp, MOCHI_PORT: String(PORT), MOCHI_INVITE_CODE: INVITE,
         MOCHI_ORIGINS: "http://localhost:5173" },
  stdio: ["ignore", "pipe", "pipe"],
});

try {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  asDevice("A");
  Sync.setServer(BASE);

  console.log("\n── 注册 ──");
  asDevice("A");
  const a = await Sync.register({ username: "alice", password: "alice-passwd-1", displayName: "爱丽丝", inviteCode: INVITE });
  chk("学生 A 注册", a.user.role === "student", a.user.role);
  asDevice("B");
  Sync.setServer(BASE);
  const b = await Sync.register({ username: "bob", password: "bob-passwd-11", displayName: "鲍勃", inviteCode: INVITE });
  chk("学生 B 注册", b.user.role === "student");
  asDevice("P");
  Sync.setServer(BASE);
  const p = await Sync.register({ username: "prof", password: "prof-passwd-1", displayName: "导师", inviteCode: INVITE });
  execFileSync("python3", [join(HERE, "..", "server", "set_role.py"), "prof", "advisor"],
               { env: { ...process.env, MOCHI_DATA: tmp } });
  const prof = await Sync.login("prof", "prof-passwd-1");
  chk("导师角色由服务器授予", prof.user.role === "advisor", prof.user.role);

  console.log("\n── A 建记录并同步上去 ──");
  let dA = base();
  dA = Sync.stampChanges(dA, { ...dA, projects: [{ id: "p1", name: "编码孔径成像", color: "#5B7FC7" }] }, 1000);
  dA = Sync.stampChanges(dA, { ...dA, records: [{ id: "r1", projectId: "p1", at: 1000, weather: "晴", text: "完成暗场标定", photos: [] }] }, 1100);
  chk("本地有 2 条待同步", Sync.pendingCount(dA) === 2, String(Sync.pendingCount(dA)));

  let res = await syncDevice("A", dA, a.token);
  dA = res.data;
  chk("推送成功", res.pushed === 2, `pushed=${res.pushed}`);
  chk("推送后没有残留待同步", Sync.pendingCount(dA) === 0, String(Sync.pendingCount(dA)));

  console.log("\n── 隔离性 ──");
  let dB = base();
  res = await syncDevice("B", dB, b.token);
  dB = res.data;
  chk("学生 B 拉不到 A 的记录", dB.records.length === 0 && dB.projects.length === 0,
      `projects=${dB.projects.length} records=${dB.records.length}`);

  let dP = base();
  res = await syncDevice("P", dP, prof.token);
  dP = res.data;
  chk("导师能拉到 A 的记录", dP.records.length === 1 && dP.projects.length === 1,
      `projects=${dP.projects.length} records=${dP.records.length}`);
  chk("导师看到的记录带 ownerId", dP.records[0].ownerId === a.user.id);
  chk("记录内容正确", dP.records[0].text === "完成暗场标定", dP.records[0].text);

  console.log("\n── A 的第二台设备（同一账号）──");
  let dA2 = base();
  res = await syncDevice("A2", dA2, a.token);
  dA2 = res.data;
  chk("A 的新设备拉到自己的全部记录", dA2.records.length === 1 && dA2.projects.length === 1);

  console.log("\n── 双向：A2 改，A 拉回 ──");
  dA2 = Sync.stampChanges(dA2, {
    ...dA2, records: dA2.records.map((r) => ({ ...r, text: "完成暗场标定 + 平场校正" })),
  }, 5000);
  res = await syncDevice("A2", dA2, a.token);
  dA2 = res.data;
  chk("A2 推送修改", res.pushed === 1, `pushed=${res.pushed}`);

  res = await syncDevice("A", dA, a.token);
  dA = res.data;
  chk("A 拉回 A2 的修改", dA.records[0].text === "完成暗场标定 + 平场校正", dA.records[0].text);
  chk("拉回后不会再推一遍", Sync.pendingCount(dA) === 0, String(Sync.pendingCount(dA)));

  console.log("\n── 冲突：两台设备同时改同一条 ──");
  dA = Sync.stampChanges(dA, { ...dA, records: dA.records.map((r) => ({ ...r, text: "A 的版本（较早）" })) }, 8000);
  dA2 = Sync.stampChanges(dA2, { ...dA2, records: dA2.records.map((r) => ({ ...r, text: "A2 的版本（较晚）" })) }, 9000);
  await syncDevice("A", dA, a.token);            // 先推较早的
  res = await syncDevice("A2", dA2, a.token);    // 再推较晚的
  dA2 = res.data;
  const after = await syncDevice("A", { ...dA, _sync: { ...dA._sync } }, a.token);
  chk("较晚的改动获胜（LWW）", after.data.records[0].text === "A2 的版本（较晚）", after.data.records[0].text);

  console.log("\n── 删除传播 ──");
  dA2 = Sync.stampChanges(dA2, { ...dA2, records: [] }, 12000);
  chk("删除产生墓碑", !!dA2._sync.tombs.r1);
  res = await syncDevice("A2", dA2, a.token);
  dA2 = res.data;
  chk("墓碑被推送", res.pushed === 1, `pushed=${res.pushed}`);

  res = await syncDevice("P", dP, prof.token);
  dP = res.data;
  chk("导师那边的记录也被删掉", dP.records.length === 0, `剩 ${dP.records.length} 条`);

  console.log("\n── 待办不上传 ──");
  let dC = base();
  dC = Sync.stampChanges(dC, {
    ...dC,
    todos: [{ id: "t1", text: "私人待办", elapsed: 3600, timeline: [{ type: "start", at: 1 }] }],
    notes: [{ id: "n1", title: "私人笔记" }],
  }, 20000);
  chk("待办和笔记不进待同步队列", Sync.pendingCount(dC) === 0, String(Sync.pendingCount(dC)));
  res = await syncDevice("B", dC, b.token);
  chk("同步一轮后服务器上依然没有待办", res.pushed === 0, `pushed=${res.pushed}`);

  console.log(`\n${"=".repeat(46)}\n通过 ${passed} 项，失败 ${failed} 项\n${"=".repeat(46)}`);
} finally {
  proc.kill();
  rmSync(tmp, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
