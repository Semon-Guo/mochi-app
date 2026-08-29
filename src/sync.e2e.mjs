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

  console.log("\n── 待办：本人多设备互通，组内互不可见 ──");
  let dT = base();
  dT = Sync.stampChanges(dT, {
    ...dT,
    todos: [{ id: "td1", text: "跑柱子", elapsed: 3600, duration: 60,
              timeline: [{ type: "start", at: 1 }, { type: "pause", at: 2 }] }],
    notes: [{ id: "n1", title: "私人笔记", body: "不该上传" }],
  }, 20000);
  chk("待办进入待同步队列", Sync.pendingCount(dT) === 1, String(Sync.pendingCount(dT)));
  chk("笔记始终不进队列", !dT._sync.stamps.n1);

  res = await syncDevice("A", dT, a.token);
  dT = res.data;
  chk("待办推送成功", res.pushed === 1, `pushed=${res.pushed}`);

  let dA3 = base();
  res = await syncDevice("A3", dA3, a.token);
  dA3 = res.data;
  const gotTodo = (dA3.todos || []).find((t) => t.id === "td1");
  chk("本人的另一台设备拉得到待办", !!gotTodo, `todos=${(dA3.todos || []).length}`);
  chk("计时数据完整同步", gotTodo?.elapsed === 3600, String(gotTodo?.elapsed));
  chk("timeline 也同步了", (gotTodo?.timeline || []).length === 2);

  let dP2 = base();
  res = await syncDevice("P", dP2, prof.token);
  dP2 = res.data;
  chk("导师拉不到学生的待办", (dP2.todos || []).length === 0, `todos=${(dP2.todos || []).length}`);

  let dB2 = base();
  res = await syncDevice("B", dB2, b.token);
  dB2 = res.data;
  chk("其他学生也拉不到", (dB2.todos || []).length === 0, `todos=${(dB2.todos || []).length}`);

  console.log("\n── 关掉开关后待办不再上传 ──");
  asDevice("A4");
  Sync.setServer(BASE);
  Sync.setSyncTodos(false);
  let dOff = base();
  dOff = Sync.stampChanges(dOff, {
    ...dOff, todos: [{ id: "td2", text: "关了开关之后建的" }],
  }, 30000);
  chk("关闭后待办不打戳", Sync.pendingCount(dOff) === 0, String(Sync.pendingCount(dOff)));
  const before = await syncDevice("A4", dOff, a.token);
  chk("关闭后不推送待办", before.pushed === 0, `pushed=${before.pushed}`);
  // 本地新建的 td2 当然还在本地，只是不参与同步；要验证的是不会把服务器上的
  // td1 拉下来，也不会把 td2 推上去
  chk("关闭后拉不到服务器上的待办", !(before.data.todos || []).some((t) => t.id === "td1"),
      (before.data.todos || []).map((t) => t.id).join(",") || "空");
  chk("本地新建的待办不受影响，仍在本地", (before.data.todos || []).some((t) => t.id === "td2"));
  Sync.setSyncTodos(true);

  console.log("\n── 同一台设备换账号（数据必须隔离）──");
  // 设备 D：先用账号 A 建记录并同步
  asDevice("D");
  Sync.setServer(BASE);
  Sync.setDataOwner?.(null);
  let dD = base();
  dD = Sync.stampChanges(dD, {
    ...dD,
    projects: [{ id: "dp1", name: "A 的私密项目" }],
    records: [{ id: "dr1", projectId: "dp1", at: Date.now(), text: "A 的实验记录", photos: [] }],
    todos: [{ id: "dt1", text: "A 的待办" }],
  }, 40000);
  res = await syncDevice("D", dD, a.token);
  dD = res.data;
  chk("账号 A 在设备 D 上同步成功", res.pushed === 3, `pushed=${res.pushed}`);

  // 换成账号 B 登录同一台设备
  const afterSwitch = await Sync.switchAccount(dD, a.user.id, b.user.id);
  chk("换账号后 A 的实验记录被清除", (afterSwitch.records || []).length === 0,
      `剩 ${(afterSwitch.records || []).length} 条`);
  chk("换账号后 A 的项目被清除", (afterSwitch.projects || []).length === 0,
      `剩 ${(afterSwitch.projects || []).length} 个`);
  chk("换账号后 A 的待办被清除", (afterSwitch.todos || []).length === 0,
      `剩 ${(afterSwitch.todos || []).length} 条`);
  chk("同步游标被重置", !(afterSwitch._sync?.cursor), String(afterSwitch._sync?.cursor));
  chk("待推送队列被清空（否则会把 A 的数据推到 B 名下）",
      Sync.pendingCount(afterSwitch) === 0, String(Sync.pendingCount(afterSwitch)));

  // B 同步：不该拿到 A 的东西，也不该把 A 的东西推上去
  res = await syncDevice("D", afterSwitch, b.token);
  const dSwitched = res.data;
  chk("B 同步后没有推送任何 A 的数据", res.pushed === 0, `pushed=${res.pushed}`);
  chk("B 看不到 A 的记录", !(dSwitched.records || []).some((r) => r.id === "dr1"));

  // 从服务器侧确认 A 的记录没有被划到 B 名下
  asDevice("D2"); Sync.setServer(BASE);
  const checkA = await syncDevice("D2", base(), a.token);
  const still = (checkA.data.records || []).find((r) => r.id === "dr1");
  chk("A 的记录仍属于 A，内容完好", still?.text === "A 的实验记录", still?.text || "丢失");

  console.log("\n── 清空本机后必须能全量拉回 ──");
  // 复现用户遇到的问题：清空后如果拿旧 data（旧游标）去同步，会一条都拉不回来
  asDevice("RESET"); Sync.setServer(BASE);
  let dR = base();
  res = await syncDevice("RESET", dR, a.token);
  dR = res.data;
  const beforeReset = (dR.records || []).length;
  chk("清空前有数据", beforeReset > 0, `records=${beforeReset}`);
  const staleCursor = dR._sync?.cursor || 0;

  const cleared = await Sync.resetLocalData();
  chk("清空后本地为空", (cleared.records || []).length === 0);
  chk("清空后游标归零", (cleared._sync?.cursor || 0) === 0);

  // 正确做法：用清空后的那份去同步
  res = await syncDevice("RESET", cleared, a.token);
  chk("用清空后的数据同步能全量拉回", (res.data.records || []).length === beforeReset,
      `拉回 ${(res.data.records || []).length} / 原有 ${beforeReset}`);

  // 错误做法（修复前的行为）：拿着旧游标去要增量，什么都拉不到
  const wrong = { ...cleared, _sync: { ...cleared._sync, cursor: staleCursor } };
  res = await syncDevice("RESET", wrong, a.token);
  // 加了自愈之后，即使带着旧游标也能恢复：本地空 + 游标非 0 会被判定为
  // 状态错乱，自动从头拉一次
  const wrong2 = { ...cleared, _sync: { ...cleared._sync, cursor: staleCursor } };
  res = await syncDevice("RESET", wrong2, a.token);
  chk("本地空但游标非 0 时会自愈并全量拉回",
      (res.data.records || []).length === beforeReset,
      `拉回 ${(res.data.records || []).length} / 原有 ${beforeReset}`);

  console.log("\n── 旧版本升级：数据来路不明就得清 ──");
  // 模拟旧版本遗留：有同步过的数据，但没有归属记录
  asDevice("OLD"); Sync.setServer(BASE);
  Sync.setDataOwner(null);
  let dOld = base();
  res = await syncDevice("OLD", dOld, a.token);
  dOld = res.data;
  Sync.setDataOwner(null);                       // 抹掉归属，装成旧版本的状态
  chk("旧版本遗留的数据里有同步游标", (dOld._sync?.cursor || 0) > 0, String(dOld._sync?.cursor));
  const migrated = await Sync.switchAccount(dOld, null, b.user.id);
  chk("来路不明的数据被清除", (migrated.records || []).length === 0,
      `剩 ${(migrated.records || []).length} 条`);

  // 而真正的首次登录（离线攒的数据、从未同步）必须保留
  asDevice("FRESH"); Sync.setServer(BASE);
  Sync.setDataOwner(null);
  let dFresh = Sync.stampChanges(base(), {
    ...base(), records: [{ id: "own1", projectId: "x", at: Date.now(), text: "登录前自己记的" }],
  }, 50000);
  const kept = await Sync.switchAccount(dFresh, null, a.user.id);
  chk("首次登录时离线攒的数据不会被清掉",
      (kept.records || []).some((r) => r.id === "own1"), `records=${(kept.records || []).length}`);

  console.log("\n── 同一账号在新设备上登录 ──");
  // D3 之前用过账号 B，游标是脏的；改登 A 后必须拿得到 A 的全部数据
  asDevice("D3"); Sync.setServer(BASE);
  let dD3 = base();
  res = await syncDevice("D3", dD3, b.token);       // 先以 B 同步一轮，把游标推上去
  dD3 = res.data;
  const dirtyCursor = dD3._sync?.cursor || 0;
  chk("设备上已有别的账号留下的游标", dirtyCursor > 0, String(dirtyCursor));

  const switched = await Sync.switchAccount(dD3, b.user.id, a.user.id);
  res = await syncDevice("D3", switched, a.token);
  const gotA = res.data;
  chk("换回账号 A 后能拉到 A 的实验记录",
      (gotA.records || []).some((r) => r.id === "dr1"), `records=${(gotA.records || []).length}`);
  chk("也能拉到 A 的待办（原来会因游标不重置而漏掉）",
      (gotA.todos || []).some((t) => t.id === "dt1"), `todos=${(gotA.todos || []).length}`);

  console.log(`\n${"=".repeat(46)}\n通过 ${passed} 项，失败 ${failed} 项\n${"=".repeat(46)}`);
} finally {
  proc.kill();
  rmSync(tmp, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
