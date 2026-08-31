/* 老数据的迁移，以及它要用到的那点常量。
 *
 * 单独一个 .js 是为了能在 node 里单测——这段代码每次启动都跑，一旦悄悄
 * 少留一个字段，表现是「用着用着东西就没了」，很难从界面上倒推。
 */

export const NC = [
  {bg:"#FFF8E7",accent:"#E8A838"},{bg:"#F0F7EE",accent:"#5A9E4B"},
  {bg:"#EEF2FA",accent:"#5B7FC7"},{bg:"#FBF0F0",accent:"#D4696A"},
  {bg:"#F5F0FA",accent:"#8B6AAF"},{bg:"#F0F8F8",accent:"#4A9A96"},
];

export function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

// P1 的项目/实验/记录三层拍平成项目 + 记录两层，一条内容都不丢
export function migrateLab(d) {
  // 用「摘掉旧字段」而不是「只留白名单字段」——白名单写法会把之后新增的字段
  // 一并抹掉，而这是每次启动都跑的。ownerId 和 members 就这么丢过：学生端
  // 以为组级项目是自己的（于是给了删除入口，删了还推不上去），导师端一重载
  // 就丢掉成员名单，下次一推把服务器上的名单清空，全组失去那个项目。
  // setup/stack/code 必须摘掉：它们在下面会被转成记录，留着每次启动都重转一遍。
  const projects = (d.projects || []).map(({ setup, stack, code, ...pr }) => ({
    ...pr,
    id: pr.id, name: pr.name || code || "未命名项目",
    startedAt: pr.startedAt || Date.now(),
    color: pr.color || NC[0],
  }));
  const records = [...(d.records || [])];
  (d.projects || []).forEach(pr => {
    [pr.setup, pr.stack].filter(Boolean).forEach((txt, i) =>
      records.push({ id: uid(), projectId: pr.id, at: (pr.startedAt || Date.now()) + i, weather: "", text: txt, photos: [] }));
  });
  (d.experiments || []).forEach(ex => {
    if (ex.title) records.push({ id: uid(), projectId: ex.projectId, at: ex.startedAt || Date.now(), weather: "", text: ex.title, photos: [] });
    (ex.entries || []).forEach(e => {
      if (!e.text) return;
      records.push({ id: e.id, projectId: ex.projectId, at: e.at, weather: "", text: e.text, photos: [] });
    });
  });
  return { ...d, projects, records: records.sort((a, b) => a.at - b.at), experiments: [] };
}
