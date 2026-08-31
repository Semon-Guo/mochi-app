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
  const { sync, incoming, pushed, pulled, rejected } = await Sync.syncOnce(data, token);
  return { data: Sync.mergeIncoming(data, sync, incoming), pushed, pulled, rejected };
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

  console.log("\n── 数据文件：切片上传 ──");
  // 这段验的是「几百 MB」那条路真的走得通：切片、续传、字节不串位。
  // 服务端测试只验接口，这里验的是前端那个循环。
  const Files = await import("./files.js");
  const mkBytes = (n, seed) => {
    const b = new Uint8Array(n);
    for (let i = 0; i < n; i++) b[i] = (i * 31 + seed) % 251;
    return b;
  };
  const same = (x, y) => Buffer.compare(Buffer.from(x), Buffer.from(y)) === 0;

  asDevice("A"); Sync.setServer(BASE);
  const bytes = mkBytes(9 * 1024 * 1024, 7);          // 跨 3 个分块（前端切 4MB）
  const file = new File([bytes], "recon_014.mat", { type: "application/octet-stream" });
  const seen = [];
  const meta = await Files.uploadFile(file, "f-e2e", {
    token: a.token, onProgress: (p) => seen.push(p) });
  chk("大文件传完并返回元数据", meta.id === "f-e2e" && meta.size === bytes.length && meta.name === "recon_014.mat",
      JSON.stringify(meta));
  chk("过程中报了多次进度（说明真的切了片）", seen.length >= 3, `${seen.length} 次`);
  chk("进度最终到 100%", seen[seen.length - 1] === 1, String(seen[seen.length - 1]));

  const tk = await fetch(`${BASE}/api/file/f-e2e/ticket`,
    { method: "POST", headers: { Authorization: `Bearer ${a.token}` } }).then((r) => r.json());
  const back = new Uint8Array(await fetch(BASE + tk.url).then((r) => r.arrayBuffer()));
  chk("下回来的字节和原文件逐字节一致", same(back, bytes), `${back.length} / ${bytes.length}`);

  console.log("\n── 数据文件：断了能接着传 ──");
  const bytes2 = mkBytes(9 * 1024 * 1024, 3);
  const file2 = new File([bytes2], "stack.tif", { type: "image/tiff" });
  const ctrl = new AbortController();
  let cut = false;
  try {
    await Files.uploadFile(file2, "f-res", {
      token: a.token, signal: ctrl.signal,
      onProgress: (p) => { if (!cut && p > 0 && p < 1) { cut = true; ctrl.abort(); } },
    });
    chk("传到一半被取消", false, "居然传完了");
  } catch (e) {
    chk("传到一半被取消", e.name === "AbortError", e.name);
  }

  const again = [];
  const meta2 = await Files.uploadFile(file2, "f-res", {
    token: a.token, onProgress: (p) => again.push(p) });
  chk("续传是从断点开始的，不是从 0 重来", again[0] > 0 && again[0] < 1, String(again[0]));
  chk("续传后大小对得上", meta2.size === bytes2.length, String(meta2.size));
  const tk2 = await fetch(`${BASE}/api/file/f-res/ticket`,
    { method: "POST", headers: { Authorization: `Bearer ${a.token}` } }).then((r) => r.json());
  const back2 = new Uint8Array(await fetch(BASE + tk2.url).then((r) => r.arrayBuffer()));
  chk("续传拼出来的文件没有串位", same(back2, bytes2), `${back2.length} / ${bytes2.length}`);

  console.log("\n── 数据文件：元数据随记录同步，导师取得到 ──");
  dA = Sync.stampChanges(dA, { ...dA, records: [...dA.records,
    { id: "r-data", projectId: "p1", at: 2000, weather: "", text: "第三轮扫描", photos: [], files: [meta] }],
  }, 70000);
  res = await syncDevice("A", dA, a.token);
  dA = res.data;

  let dProf = base();
  res = await syncDevice("P", dProf, prof.token);
  dProf = res.data;
  const rd = (dProf.records || []).find((r) => r.id === "r-data");
  chk("导师那边的记录带着文件名和大小", rd?.files?.[0]?.name === "recon_014.mat"
      && rd?.files?.[0]?.size === bytes.length, JSON.stringify(rd?.files));

  const profTk = await fetch(`${BASE}/api/file/f-e2e/ticket`,
    { method: "POST", headers: { Authorization: `Bearer ${prof.token}` } });
  chk("导师能换到下载票", profTk.ok, `HTTP ${profTk.status}`);
  const bobTk = await fetch(`${BASE}/api/file/f-e2e/ticket`,
    { method: "POST", headers: { Authorization: `Bearer ${b.token}` } });
  chk("组里其他学生换不到", bobTk.status === 404, `HTTP ${bobTk.status}`);

  console.log("\n── 组级项目：导师建、学生才拉得到 ──");
  asDevice("P"); Sync.setServer(BASE);
  let dP3 = base();
  res = await syncDevice("P", dP3, prof.token); dP3 = res.data;
  dP3 = Sync.stampChanges(dP3, { ...dP3, projects: [...dP3.projects,
    { id: "gp1", name: "组级项目：光场重建", color: "#5B7FC7", members: [] }] }, 80000);
  res = await syncDevice("P", dP3, prof.token); dP3 = res.data;

  let dGrpA = base();
  res = await syncDevice("A", dGrpA, a.token); dGrpA = res.data;
  chk("没进名单时学生拉不到组级项目",
      !(dGrpA.projects || []).some((p) => p.id === "gp1"),
      `projects=${(dGrpA.projects || []).map((p) => p.id).join(",")}`);

  dP3 = Sync.stampChanges(dP3, { ...dP3,
    projects: dP3.projects.map((p) => p.id === "gp1" ? { ...p, members: [a.user.id] } : p) }, 81000);
  res = await syncDevice("P", dP3, prof.token); dP3 = res.data;

  let dGrpA2 = base();
  res = await syncDevice("A", dGrpA2, a.token); dGrpA2 = res.data;
  const gp = (dGrpA2.projects || []).find((p) => p.id === "gp1");
  chk("纳入名单后学生就拉得到了", !!gp, `projects=${(dGrpA2.projects || []).length}`);
  chk("学生看到的是导师的那份（带 ownerId，界面据此禁掉改名删除）",
      gp?.ownerId === p.user.id, String(gp?.ownerId));

  let dGrpB = base();
  res = await syncDevice("B", dGrpB, b.token); dGrpB = res.data;
  chk("组里别的学生仍然拉不到", !(dGrpB.projects || []).some((x) => x.id === "gp1"));

  console.log("\n── 导师回复与点赞：一路同步到学生那边 ──");
  // 用一条新记录，免得受前面删除测试的影响
  dGrpA2 = Sync.stampChanges(dGrpA2, { ...dGrpA2, records: [...dGrpA2.records,
    { id: "rc1", projectId: "gp1", at: 90000, text: "在组级项目里跑了第一轮", photos: [] }] }, 90000);
  res = await syncDevice("A", dGrpA2, a.token); dGrpA2 = res.data;

  res = await syncDevice("P", dP3, prof.token); dP3 = res.data;
  chk("导师拉到了学生的新记录", (dP3.records || []).some((r) => r.id === "rc1"));

  dP3 = Sync.stampChanges(dP3, { ...dP3, comments: [
    { id: "cm1", recordId: "rc1", kind: "reply", text: "暗场校正做了吗？", byName: "导师", at: 91000 },
    { id: "cm2", recordId: "rc1", kind: "like", byName: "导师", at: 91000 },
  ] }, 91000);
  res = await syncDevice("P", dP3, prof.token); dP3 = res.data;
  chk("回复和赞都推上去了", res.pushed >= 2, `pushed=${res.pushed}`);

  res = await syncDevice("A", dGrpA2, a.token); dGrpA2 = res.data;
  const got = (dGrpA2.comments || []).filter((c) => c.recordId === "rc1");
  chk("学生拉到了导师的回复（这条评论的 owner 是导师，不是他）",
      got.some((c) => c.kind === "reply" && c.text === "暗场校正做了吗？"),
      JSON.stringify(got));
  chk("赞也拉到了", got.some((c) => c.kind === "like"));
  chk("带着作者名字，学生不至于只看到一串 id",
      got.find((c) => c.kind === "reply")?.byName === "导师");

  const ix = (await import("./comments.js")).indexComments(dGrpA2.comments);
  const th = (await import("./comments.js")).threadOf(ix, "rc1");
  chk("索引出来就是 1 条回复 + 1 个赞", th.replies.length === 1 && th.likes.length === 1);

  // 学生回一句，导师要能看到——单向的回复没法用
  dGrpA2 = Sync.stampChanges(dGrpA2, { ...dGrpA2, comments: [...dGrpA2.comments,
    { id: "cm3", recordId: "rc1", kind: "reply", text: "做了，暗场是前一天测的", byName: "爱丽丝", at: 92000 },
  ] }, 92000);
  res = await syncDevice("A", dGrpA2, a.token); dGrpA2 = res.data;
  res = await syncDevice("P", dP3, prof.token); dP3 = res.data;
  chk("学生的回复导师也收得到（对话得能来回）",
      (dP3.comments || []).some((c) => c.id === "cm3" && c.text.startsWith("做了")));

  // 取消赞：墓碑必须传到学生那边，否则赞永远留在他屏幕上
  dP3 = Sync.stampChanges(dP3, { ...dP3,
    comments: dP3.comments.filter((c) => c.id !== "cm2") }, 93000);
  res = await syncDevice("P", dP3, prof.token); dP3 = res.data;
  res = await syncDevice("A", dGrpA2, a.token); dGrpA2 = res.data;
  chk("取消赞会传播到学生那边，不会永远挂着",
      !(dGrpA2.comments || []).some((c) => c.id === "cm2"),
      JSON.stringify((dGrpA2.comments || []).map((c) => c.id)));
  chk("回复不受取消赞影响", (dGrpA2.comments || []).some((c) => c.id === "cm1"));

  console.log("\n── 重点节点：老师定，全组共享 ──");
  asDevice("P"); Sync.setServer(BASE);
  dP3 = Sync.stampChanges(dP3, { ...dP3, milestones: [
    { id: "ms1", at: 1780000000000, title: "Optica 投稿截止", kind: "deadline" }] }, 100000);
  res = await syncDevice("P", dP3, prof.token); dP3 = res.data;
  chk("导师能建重点节点", res.pushed >= 1, `pushed=${res.pushed}`);

  let dMsA = base();
  res = await syncDevice("A", dMsA, a.token); dMsA = res.data;
  let dMsB = base();
  res = await syncDevice("B", dMsB, b.token); dMsB = res.data;
  chk("学生 A 看得到（全组共享，不看归属）",
      (dMsA.milestones || []).some((m) => m.id === "ms1"));
  chk("学生 B 也看得到", (dMsB.milestones || []).some((m) => m.id === "ms1"));

  // 学生改一下，服务端会拒。这里真正要钉的是「被拒之后不能一直重试」——
  // 那会变成每两分钟白发一次，界面上还永远挂着「N 条待同步」。
  dMsA = Sync.stampChanges(dMsA, { ...dMsA,
    milestones: dMsA.milestones.map((m) => m.id === "ms1" ? { ...m, title: "学生改的" } : m) }, 101000);
  chk("改完本地有 1 条待同步", Sync.pendingCount(dMsA) === 1, String(Sync.pendingCount(dMsA)));
  res = await syncDevice("A", dMsA, a.token); dMsA = res.data;
  chk("推上去被拒", res.rejected?.length === 1, JSON.stringify(res.rejected));
  chk("被拒之后不再挂着待同步（否则每 2 分钟白发一次，界面永远显示待同步）",
      Sync.pendingCount(dMsA) === 0, String(Sync.pendingCount(dMsA)));

  res = await syncDevice("A", dMsA, a.token); dMsA = res.data;
  chk("下一轮用服务器那份盖回来——「你无权改它」就该是这个结果",
      dMsA.milestones.find((m) => m.id === "ms1")?.title === "Optica 投稿截止",
      dMsA.milestones.find((m) => m.id === "ms1")?.title);

  dMsA = Sync.stampChanges(dMsA, { ...dMsA, milestones: [...dMsA.milestones,
    { id: "ms-own", at: 1780000000000, title: "学生自己加的", kind: "other" }] }, 102000);
  res = await syncDevice("A", dMsA, a.token); dMsA = res.data;
  chk("学生自己建不了", res.rejected?.some((r) => r.id === "ms-own"), JSON.stringify(res.rejected));
  chk("这条也不会一直重试", Sync.pendingCount(res.data) === 0, String(Sync.pendingCount(res.data)));
  chk("而且本地那条被清掉了——留着就是一份只有他自己看得见的假数据",
      !(res.data.milestones || []).some((m) => m.id === "ms-own"),
      JSON.stringify((res.data.milestones || []).map((m) => m.id)));

  console.log(`\n${"=".repeat(46)}\n通过 ${passed} 项，失败 ${failed} 项\n${"=".repeat(46)}`);
} finally {
  proc.kill();
  rmSync(tmp, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
