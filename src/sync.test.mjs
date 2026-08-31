/* 同步引擎的纯逻辑测试：node src/sync.test.mjs
 *
 * stampChanges 和 mergeIncoming 是整套同步的地基，LWW、墓碑、dirty 判断
 * 出一点偏差就会静默丢数据，所以这里把每条规则都钉住。
 */
import { stampChanges, mergeIncoming, pendingCount, planPhotoSync, PHOTO_RETRY_AFTER,
         LAB_KINDS, ALL_KINDS } from "./sync.js";

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

console.log(`\n${"=".repeat(46)}\n通过 ${passed} 项，失败 ${failed} 项\n${"=".repeat(46)}`);
process.exit(failed ? 1 : 0);
