/* 同步引擎的纯逻辑测试：node src/sync.test.mjs
 *
 * stampChanges 和 mergeIncoming 是整套同步的地基，LWW、墓碑、dirty 判断
 * 出一点偏差就会静默丢数据，所以这里把每条规则都钉住。
 */
import { stampChanges, mergeIncoming, pendingCount, planPhotoSync, PHOTO_RETRY_AFTER,
         LAB_KINDS, ALL_KINDS, canUseTodo, setAuth, onAuthChange } from "./sync.js";
import { countByDay, buildWall, streaks, monthStats, yearsWith, badgeState } from "./achievements.js";
import { migrateLab } from "./migrate.js";
import { freshRecords, FRESH_WINDOW } from "./seen.js";

let passed = 0, failed = 0;
const chk = (name, cond, info = "") => {
  if (cond) { passed++; console.log(`  PASS  ${name}${info ? "  " + info : ""}`); }
  else { failed++; console.log(`  FAIL  ${name}${info ? "  " + info : ""}`); }
};

const base = () => ({ todos: [], notes: [], projects: [], records: [] });
const rec = (id, text) => ({ id, projectId: "p1", at: 1000, weather: "晴", text, photos: [] });

console.log("\n── stampChanges ──");
{
  const prev = base();
  const next = { ...base(), records: [rec("r1", "标定完成")] };
  const out = stampChanges(prev, next, 5000, ALL_KINDS);
  chk("新增记录会打戳", out._sync.stamps.r1?.at === 5000 && out._sync.stamps.r1?.t === "records",
      JSON.stringify(out._sync.stamps.r1));
}
{
  const prev = stampChanges(base(), { ...base(), records: [rec("r1", "旧")] }, 5000, ALL_KINDS);
  const next = { ...prev, records: [rec("r1", "新")] };
  const out = stampChanges(prev, next, 7000, ALL_KINDS);
  chk("修改记录会更新戳", out._sync.stamps.r1.at === 7000, String(out._sync.stamps.r1.at));
}
{
  const prev = stampChanges(base(), { ...base(), records: [rec("r1", "x")] }, 5000, ALL_KINDS);
  const next = { ...prev, records: [] };
  const out = stampChanges(prev, next, 8000, ALL_KINDS);
  chk("删除记录会留墓碑", out._sync.tombs.r1?.at === 8000 && out._sync.tombs.r1?.t === "records");
  chk("删除后不再保留戳", !out._sync.stamps.r1);
}
{
  const prev = stampChanges(base(), { ...base(), records: [rec("r1", "x")] }, 5000, ALL_KINDS);
  const out = stampChanges(prev, prev, 9000, ALL_KINDS);
  chk("无变化时不产生新对象（否则 setData 会无限循环）", out === prev);
}
{
  // 待办可选同步：关掉时完全不碰，开着时参与——但笔记任何情况下都不上传
  const prev = stampChanges(base(), { ...base(), records: [rec("r1", "x")] }, 5000, ALL_KINDS);
  const next = { ...prev, todos: [{ id: "t1", text: "写代码" }], notes: [{ id: "n1", title: "私人" }] };

  const off = stampChanges(prev, next, 9000, LAB_KINDS);
  chk("关闭待办同步时，待办不打戳", !off._sync.stamps.t1, Object.keys(off._sync.stamps).join(","));

  const on = stampChanges(prev, next, 9000, ALL_KINDS);
  chk("开启待办同步时，待办参与", !!on._sync.stamps.t1 && on._sync.stamps.t1.t === "todos");
  chk("笔记在任何设置下都不同步", !off._sync.stamps.n1 && !on._sync.stamps.n1);
}
{
  const prev = stampChanges(base(), { ...base(), records: [rec("r1", "x")] }, 5000, ALL_KINDS);
  const revived = { ...prev, records: [] };
  const dead = stampChanges(prev, revived, 6000, ALL_KINDS);
  const back = stampChanges(dead, { ...dead, records: [rec("r1", "复活")] }, 7000, ALL_KINDS);
  chk("删除后重新出现会清掉墓碑", !back._sync.tombs.r1 && !!back._sync.stamps.r1);
}

console.log("\n── pendingCount ──");
{
  const d = stampChanges(base(), { ...base(), records: [rec("r1", "x")] }, 5000, ALL_KINDS);
  chk("未推送的记录算作待同步", pendingCount(d) === 1, String(pendingCount(d)));
  d._sync.pushed.r1 = 5000;
  chk("推送后不再计入", pendingCount(d) === 0, String(pendingCount(d)));
  d._sync.stamps.r1 = { t: "records", at: 6000 };
  chk("再次修改后重新计入", pendingCount(d) === 1, String(pendingCount(d)));
}

console.log("\n── mergeIncoming ──");
const freshSync = (d) => ({
  stamps: { ...(d._sync?.stamps || {}) }, tombs: { ...(d._sync?.tombs || {}) },
  pushed: { ...(d._sync?.pushed || {}) }, cursor: 0, lastSyncAt: 0,
});
{
  const d = base();
  const sync = freshSync(d);
  const out = mergeIncoming(d, sync, {
    records: [{ id: "r9", ownerId: "u1", updatedAt: 100, data: { text: "来自服务器", projectId: "p1" } }],
  });
  chk("拉入新记录", out.records.length === 1 && out.records[0].text === "来自服务器");
  chk("拉入的记录带 ownerId（导师视图要用）", out.records[0].ownerId === "u1");
  chk("拉入后立刻是干净的，不会被回推", pendingCount(out) === 0, String(pendingCount(out)));
}
{
  let d = stampChanges(base(), { ...base(), records: [rec("r1", "本地版本")] }, 5000, ALL_KINDS);
  d._sync.pushed.r1 = 5000;                       // 已同步过
  const out = mergeIncoming(d, freshSync(d), {
    records: [{ id: "r1", ownerId: "u1", updatedAt: 9000, data: { ...rec("r1", "服务器新版本") } }],
  });
  chk("服务器版本更新时覆盖本地", out.records[0].text === "服务器新版本", out.records[0].text);
}
{
  let d = stampChanges(base(), { ...base(), records: [rec("r1", "本地未推送的改动")] }, 9000, ALL_KINDS);
  const out = mergeIncoming(d, freshSync(d), {
    records: [{ id: "r1", ownerId: "u1", updatedAt: 5000, data: { ...rec("r1", "服务器旧版本") } }],
  });
  chk("本地有更新的未推改动时不被覆盖", out.records[0].text === "本地未推送的改动", out.records[0].text);
  chk("该记录仍待推送", pendingCount(out) === 1, String(pendingCount(out)));
}
{
  let d = stampChanges(base(), { ...base(), records: [rec("r1", "x")] }, 5000, ALL_KINDS);
  d._sync.pushed.r1 = 5000;
  const out = mergeIncoming(d, freshSync(d), {
    records: [{ id: "r1", ownerId: "u1", updatedAt: 9000, data: null, deletedAt: 9000 }],
  });
  chk("拉到墓碑会删掉本地记录", out.records.length === 0, `剩 ${out.records.length} 条`);
  chk("本地留下墓碑", !!out._sync.tombs.r1);
}
{
  const d = base();
  const out = mergeIncoming(d, freshSync(d), {
    projects: [{ id: "p1", ownerId: "u1", updatedAt: 100, data: { name: "编码孔径" } }],
    records: [{ id: "r1", ownerId: "u1", updatedAt: 100, data: { projectId: "p1", text: "a" } }],
  });
  chk("projects 和 records 一起合并", out.projects.length === 1 && out.records.length === 1);
}

console.log("\n── migrateLab：每次启动都跑，不能悄悄少留字段 ──");
{
  const out = migrateLab({ projects: [
    { id: "p1", name: "组级项目", color: { bg: "#fff", accent: "#000" },
      ownerId: "prof", members: ["u1", "u2"] }] });
  const p = out.projects[0];
  chk("保住 ownerId（丢了学生就以为组级项目是自己的，还给删除入口）", p.ownerId === "prof");
  chk("保住 members（丢了导师一重载再一推，服务器上的名单就被清空）",
      JSON.stringify(p.members) === '["u1","u2"]', JSON.stringify(p.members));
}
{
  // 老三层结构：setup/stack 要转成记录，而且只能转一次
  const legacy = { projects: [{ id: "p1", code: "FPM", setup: "光路搭好了", stack: "4f 系统" }],
                   experiments: [], records: [] };
  const once = migrateLab(legacy);
  chk("旧的 setup/stack 转成了记录", once.records.length === 2, String(once.records.length));
  chk("项目名退回 code", once.projects[0].name === "FPM", once.projects[0].name);
  const twice = migrateLab(once);
  chk("再跑一遍不会重复转（否则每次启动都多两条）", twice.records.length === 2,
      String(twice.records.length));
}
{
  const out = migrateLab({ projects: [], experiments: [
    { id: "e1", projectId: "p1", title: "第一次上手", startedAt: 100,
      entries: [{ id: "en1", at: 200, text: "标定完成" }] }], records: [] });
  chk("旧的实验层内容一条不丢", out.records.length === 2 && out.records[1].text === "标定完成");
  chk("实验层被清空", out.experiments.length === 0);
}

console.log("\n── 未读判定（导师端和同步条上的角标共用）──");
{
  const now = 1_000_000_000_000;
  const rs = [
    { id: "a", ownerId: "u1", at: now - 3600e3 },
    { id: "b", ownerId: "u1", at: now - 3600e3 },
    { id: "c", ownerId: "prof", at: now - 3600e3 },              // 自己写的
    { id: "d", ownerId: "u1", at: now - FRESH_WINDOW - 1 },       // 太老
  ];
  const fresh = freshRecords(rs, new Set(["a"]), "prof", now);
  chk("看过的不再算新", !fresh.some((r) => r.id === "a"));
  chk("没看过的算新", fresh.some((r) => r.id === "b"));
  chk("自己写的不算新记录", !fresh.some((r) => r.id === "c"));
  chk("窗口外的老记录不算（已读状态丢了也不会刷屏）", !fresh.some((r) => r.id === "d"));
  chk("已读集合还没初始化时一条都不算", freshRecords(rs, null, "prof", now).length === 0);
}

console.log("\n── planPhotoSync ──");
// 这一组钉的是一个真上过线的 bug：管理员那台设备把学生的照片当成自己的
// 往上传，服务端每次 403，客户端什么都不记，于是每 2 分钟重试一次，
// 两天堆了 424 次，而界面上一点提示都没有。
{
  const plan = planPhotoSync({
    records: [{ id: "r1", photos: ["ph1"] }],          // 本机新建，没有 ownerId
    localIds: new Set(["ph1"]), state: {}, myUserId: "me",
  });
  chk("自己新建的记录，照片要上传", plan.toUpload.includes("ph1"));
}
{
  const plan = planPhotoSync({
    records: [{ id: "r1", ownerId: "me", photos: ["ph1"] }],   // 第二台设备上拉回来的自己的记录
    localIds: new Set(["ph1"]), state: {}, myUserId: "me",
  });
  chk("自己的记录在别的设备上拉回来，照片照样要上传", plan.toUpload.includes("ph1"));
}
{
  const plan = planPhotoSync({
    records: [{ id: "r1", ownerId: "student", photos: ["ph1"] }],
    localIds: new Set(["ph1"]), state: {}, myUserId: "advisor",
  });
  chk("导师本地存着学生的照片，绝不能往上传", plan.toUpload.length === 0,
      JSON.stringify(plan.toUpload));
}
{
  const plan = planPhotoSync({
    records: [{ id: "r1", ownerId: "student", photos: ["ph1"] }],
    localIds: new Set(), state: {}, myUserId: "advisor",
  });
  chk("但导师本地没有时仍然要下载下来看", plan.toDownload.includes("ph1"));
}
{
  const plan = planPhotoSync({
    records: [{ id: "r1", photos: ["ph1"] }],
    localIds: new Set(["ph1"]), state: { ph1: { up: true } }, myUserId: "me",
  });
  chk("传过的不重复传", plan.toUpload.length === 0);
}
{
  const now = 1_000_000_000;
  const plan = planPhotoSync({
    records: [{ id: "r1", photos: ["ph1"] }],
    localIds: new Set(["ph1"]), state: { ph1: { noUp: now - 1000 } }, myUserId: "me", now,
  });
  chk("刚失败过的不立刻重试（死循环的刹车）", plan.toUpload.length === 0);
}
{
  const now = 1_000_000_000;
  const plan = planPhotoSync({
    records: [{ id: "r1", ownerId: "x", photos: ["ph1"] }],
    localIds: new Set(), state: { ph1: { gone: now - 1000 } }, myUserId: "me", now,
  });
  chk("刚下不到的不立刻重下", plan.toDownload.length === 0);
}
// 下面两条钉的是「失败标记不能是永久的」：导师的角色是事后授予的，成为
// 导师之前拉学生的照片必然 403；学生也可能晚一步才把照片传上来。标死了
// 那张照片在这台设备上就再也不会出现。
{
  const now = 1_000_000_000;
  const plan = planPhotoSync({
    records: [{ id: "r1", ownerId: "x", photos: ["ph1"] }],
    localIds: new Set(), state: { ph1: { gone: now - PHOTO_RETRY_AFTER - 1 } }, myUserId: "me", now,
  });
  chk("过了冷却期要再试一次，失败不是永久的", plan.toDownload.includes("ph1"));
}
{
  const now = 1_000_000_000;
  const plan = planPhotoSync({
    records: [{ id: "r1", ownerId: "x", photos: ["ph1"] }],
    localIds: new Set(), state: { ph1: { gone: true } }, myUserId: "me", now,
  });
  chk("老版本存的永久标记升上来后立刻重试", plan.toDownload.includes("ph1"));
}
{
  const plan = planPhotoSync({
    records: [{ id: "r1", ownerId: "someone", photos: ["ph1"] }],
    localIds: new Set(["ph1"]), state: {},
  });
  chk("不知道自己是谁时退回旧行为，不把上传整个停掉", plan.toUpload.includes("ph1"));
}

console.log("\n── 待办的开放权限 ──");
{
  // 界面靠这个函数决定待办那一半显不显示。默认必须是关的：
  // 判反了的话，全组每个人都会看见本该只给几个人开的功能。
  chk("没开放就是看不到", !canUseTodo({ id: "u1", role: "student" }));
  chk("空的 features 也是看不到", !canUseTodo({ id: "u1", features: {} }));
  chk("没登录（没有 user）也是看不到", !canUseTodo(null) && !canUseTodo(undefined));
  chk("管理员不自动有，得显式开", !canUseTodo({ id: "u1", role: "admin" }));
  chk("开放了才看得到", canUseTodo({ id: "u1", features: { todo: true } }));
  chk("只认 true，别的值不算", !canUseTodo({ id: "u1", features: { todo: "yes" } }));
}
{
  // 管理员在服务器上开放之后，客户端是在同步时刷回身份的。主界面不订阅这次
  // 变化的话，得等它自己因为别的原因重渲染才会跟上。
  const seen = [];
  const off = onAuthChange((a) => seen.push(a?.user?.features?.todo === true));
  setAuth({ token: "t", user: { id: "u1", features: { todo: true } } });
  setAuth(null);
  off();
  setAuth({ token: "t", user: { id: "u1", features: { todo: true } } });
  chk("登录态一变就广播，退订后不再收到", seen.length === 2 && seen[0] === true && seen[1] === false,
      JSON.stringify(seen));
}

console.log("\n── 成就墙：按天数格子 ──");
// 主页那面墙的每一格都来自这几个函数。算错一天，人看到的就是「我明明记了
// 却没亮」——这比少一个功能更伤，因为它直接否定了人当天干过的事。
{
  const D = 86400000;
  // 固定一个时刻当「现在」，不然这组断言是哪天跑的就出哪天的结果。
  // 取北京时间的正午，离两边的午夜都够远，时区怎么跳都落在同一天里。
  const noon = (daysAgo) => Date.UTC(2026, 8, 13, 4, 0, 0) - daysAgo * D;
  const NOW = noon(0);
  const at = (daysAgo, n = 1) => Array.from({ length: n },
    (_, i) => ({ id: `r${daysAgo}-${i}`, at: noon(daysAgo), projectId: "p1" }));

  const counts = countByDay([...at(0), ...at(0), ...at(2)]);
  chk("同一天的记录归到一格", [...counts.values()].sort().join(",") === "1,2");
  chk("没有 at 的记录不算进任何一天", countByDay([{ id: "x" }]).size === 0);

  const cols = buildWall(at(0), { weeks: 4, now: NOW, endTs: NOW });
  chk("一列一周、一周七天", cols.length === 4 && cols.every((c) => c.length === 7));
  chk("最后一列是本周", cols[3].some((c) => c.today));
  const flat = cols.flat();
  chk("今天那一格亮着", flat.find((c) => c.today)?.n === 1);
  chk("还没到的日子标成 future，不画成灰格子", flat.filter((c) => c.future).every((c) => c.n === 0));
  chk("过去的日子一律不是 future", flat.filter((c) => !c.future && !c.today).every((c) => c.ms <= flat.find((x) => x.today).ms));

  const deep = buildWall([...at(0), ...at(0), ...at(0), ...at(0)], { weeks: 1, now: NOW, endTs: NOW });
  chk("一天记满（3 条以上）就是最深那档", deep.flat().find((c) => c.today)?.level === 3);

  // 连续天数：今天空着不算断，否则每天 00:01 都要被清一次零
  chk("连着三天就是 3", streaks([...at(0), ...at(1), ...at(2)], NOW).current === 3);
  chk("今天还没记，从昨天往回数", streaks([...at(1), ...at(2)], NOW).current === 2);
  chk("昨天也没记才算断", streaks([...at(2), ...at(3)], NOW).current === 0);
  chk("一条都没有时是 0，不是 NaN", streaks([], NOW).current === 0);

  const s2 = streaks([...at(1), ...at(2), ...at(3), ...at(10), ...at(10)], NOW);
  chk("最长连续认的是历史上最长的那一段", s2.longest === 3, String(s2.longest));
  chk("有记录的天数按天算，一天记两条也只算一天", s2.activeDays === 4, String(s2.activeDays));
  chk("累计条数按条算", s2.total === 5, String(s2.total));

  const mo = monthStats([...at(0), ...at(1)], NOW);
  chk("本月小结只数本月的天", mo.days === 2 && mo.total === 2, JSON.stringify(mo));
  chk("本月的分母是「到今天为止过了几天」", mo.elapsed === 13, String(mo.elapsed));

  chk("年份从新到旧", yearsWith([{ at: noon(0) }, { at: noon(400) }]).join(",") === "2026,2025");

  const b = badgeState(streaks(at(0), NOW));
  chk("写了第一条就有第一级", b.find((x) => x.key === "first").got);
  chk("没够到的台阶也返回，只是没达成", b.find((x) => x.key === "d100").got === false);
}

console.log(`\n${"=".repeat(46)}\n通过 ${passed} 项，失败 ${failed} 项\n${"=".repeat(46)}`);
process.exit(failed ? 1 : 0);
