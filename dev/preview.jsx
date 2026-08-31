/* 排版自检页：用真实组件 + 造的数据渲染，所以看到的就是线上的样子。
 *
 * 为什么需要它：界面上的错，测试基本抓不到。migrateLab 每次启动都把项目的
 * ownerId 和 members 抹掉这个 bug，就是渲染出学生端那一屏、看见本该是
 * 「组级项目」标签的位置摆着删除按钮，才发现的。
 *
 *   npm run dev
 *   node dev/shot.mjs "http://localhost:5173/mochi-app/dev/preview.html" out.png
 *
 * 参数：?app=1 看学生端（否则是导师端）、?view=按项目 切页签、?open=xxx 点进详情。
 */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AdvisorView } from "../src/AdvisorView.jsx";
import MochiApp, { CSS } from "../todo-notes-app.jsx";   // 导师端依赖主应用的全局样式
import { putPhoto } from "../src/photos.js";

const PROF = { id: "prof", displayName: "郭老师", username: "dr.guo", role: "admin" };
localStorage.setItem("mochi_auth", JSON.stringify({ token: "x", user: PROF }));
localStorage.removeItem("mochi_seen_records");

const MEMBERS = [
  { id: "u1", displayName: "郭思蒙", username: "semon", role: "student", inGroup: true,
    projects: 3, records: 42, lastAt: Date.now() - 2 * 3600e3 },
  { id: "u2", displayName: "李文倩", username: "wenqian", role: "student", inGroup: true,
    projects: 2, records: 27, lastAt: Date.now() - 26 * 3600e3 },
  { id: "u3", displayName: "张亦弛", username: "yichi", role: "student", inGroup: true,
    projects: 1, records: 9, lastAt: Date.now() - 9 * 86400e3 },
  { id: "prof", ...PROF, inGroup: false, projects: 0, records: 0, lastAt: 0 },
];

window.fetch = async (url) => {
  const u = String(url);
  const body = u.includes("/api/overview") ? { members: MEMBERS }
    : u.includes("/api/project-log") ? { entries: [
        { at: Date.now() - 2 * 3600e3, actor: "dr.guo", detail: "双矩法实时公里级三维重建：加入 wenqian" },
        { at: Date.now() - 3 * 86400e3, actor: "prof2", detail: "双矩法实时公里级三维重建：加入 semon；移出 yichi" },
      ] }
    : {};
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
};

const H = 3600e3, D = 86400e3;
const MOCK_TODOS = [
  { id: "t1", text: "跑 FPM 重建", done: true, importance: "main",
    doneTs: Date.now() - 3 * H, actualDuration: 7200, timeline: [] },
  { id: "t2", text: "整理标定数据", done: true, importance: "side",
    doneTs: Date.now() - 1 * D, actualDuration: 3300, timeline: [] },
  { id: "t3", text: "读 Zheng 2013", done: true, importance: "casual",
    doneTs: Date.now() - 2 * D, actualDuration: 5400, timeline: [] },
  { id: "t4", text: "写投稿正文", done: false, importance: "main",
    remind: { at: Date.now() + 2 * D } },
];
const data = {
  projects: [
    { id: "p1", name: "双矩法实时公里级三维重建", color: "#5B7FC7", ownerId: "u1" },
    { id: "p2", name: "组级项目：光场重建", color: "#5A9E4B", ownerId: "prof", members: ["u1", "u2"] },
    { id: "p3", name: "单像素相机标定", color: "#C08A1E", ownerId: "u2" },
  ],
  records: [
    { id: "r1", ownerId: "u1", projectId: "p1", at: Date.now() - 2 * H, weather: "☀️ 晴",
      text: "第三轮扫描，NA 0.42。重建 PSNR 28.3 dB，比上次高 1.1。暗场是前一天测的，光路没动过。",
      photos: ["ph1", "ph2"],
      files: [{ id: "f1", name: "psnr_sweep.csv", size: 4300, mime: "text/csv" },
              { id: "f2", name: "recon_014.mat", size: 9_012_345, mime: "application/octet-stream" }] },
    { id: "r2", ownerId: "u2", projectId: "p2", at: Date.now() - 6 * H, weather: "⛅ 多云",
      text: "把 LED 阵列换成 32×32，采集时间从 11 min 降到 4 min。", photos: ["ph3"], files: [] },
    { id: "r3", ownerId: "u3", projectId: "p3", at: Date.now() - 30 * H,
      text: "标定板拍糊了，明天重来。", photos: [], files: [] },
    { id: "r4", ownerId: "u1", projectId: "p2", at: Date.now() - 3 * D,
      text: "光场重建第一版跑通，但边缘有明显振铃。", photos: ["ph4"], files: [] },
  ],
  milestones: [
    { id: "m1", ownerId: "u1", at: Date.now() + 4 * D, title: "Optica 投稿截止", kind: "deadline",
      projectId: "p1", note: "正文 + 补充材料一起交" },
    { id: "m2", ownerId: "u1", at: Date.now() + 1 * D, title: "组会汇报：光场重建进展",
      kind: "meeting", projectId: "p2" },
    { id: "m3", ownerId: "u1", at: Date.now() - 6 * D, title: "中期检查通过",
      kind: "milestone", projectId: "p1" },
    { id: "m4", ownerId: "u1", at: Date.now() + 11 * D, title: "设备年检", kind: "other" },
    { id: "m5", ownerId: "u2", at: Date.now() + 2 * D, title: "开题报告初稿", kind: "milestone" },
  ],
  comments: [
    { id: "c1", ownerId: "prof", recordId: "r4", kind: "reply", byName: "郭老师",
      at: Date.now() - 2.8 * D, text: "振铃多半是正则化权重太小了，试试加一档 TV。" },
    { id: "c2", ownerId: "u1", recordId: "r4", kind: "reply", byName: "郭思蒙",
      at: Date.now() - 2.5 * D, text: "好，我今晚扫一遍 λ。" },
    { id: "c3", ownerId: "prof", recordId: "r4", kind: "like", byName: "郭老师", at: Date.now() - 2.8 * D },
  ],
};

/* 造几张假照片，好看清缩略图在版面里的实际份量 */
function fakePhoto(id, hue) {
  const cv = document.createElement("canvas");
  cv.width = 480; cv.height = 360;
  const g = cv.getContext("2d");
  g.fillStyle = `hsl(${hue},18%,22%)`; g.fillRect(0, 0, 480, 360);
  for (let i = 0; i < 90; i++) {
    g.fillStyle = `hsla(${hue + 30},70%,${40 + Math.random() * 45}%,${0.25 + Math.random() * 0.6})`;
    const r = 4 + Math.random() * 30;
    g.beginPath(); g.arc(Math.random() * 480, Math.random() * 360, r, 0, 7); g.fill();
  }
  g.strokeStyle = "rgba(255,255,255,.35)"; g.lineWidth = 2;
  g.strokeRect(60, 45, 360, 270);
  return new Promise((res) => cv.toBlob((b) => putPhoto(id, b).then(res), "image/jpeg", 0.85));
}

/* actions 要真的改数据——空桩的话点赞点了没反应，动效和计数都验不了 */
function Preview() {
  const [d, setD] = useState(data);
  const rid = () => "x" + Math.random().toString(36).slice(2, 8);
  const actions = {
    createProject: (name) => setD((x) => ({ ...x,
      projects: [{ id: rid(), name, color: "#8B6AAF", ownerId: "prof", members: [] }, ...x.projects] })),
    setProjectMembers: (id, members) => setD((x) => ({ ...x,
      projects: x.projects.map((p) => (p.id === id ? { ...p, members } : p)) })),
    addComment: (recordId, kind, text) => setD((x) => ({ ...x,
      comments: [...x.comments, { id: rid(), ownerId: "prof", recordId, kind,
        text: text || "", byName: "郭老师", at: Date.now() }] })),
    dropComment: (c) => setD((x) => ({ ...x, comments: x.comments.filter((y) => y.id !== c.id) })),
  };
  return (
    <>
      <style>{CSS}</style>
      <AdvisorView data={d} onClose={() => {}} onPhoto={() => {}} actions={actions} />
    </>
  );
}

const params = new URLSearchParams(location.search);

/* ?app=1 → 渲染学生端的真实 MochiApp（种好 localStorage 再挂载） */
if (params.get("app")) {
  // ?app=prof 用导师身份看主界面（比如同步条上那个「查看全组记录」入口）
  const WHO = params.get("app") === "prof"
    ? PROF
    : { id: "u1", displayName: "郭思蒙", username: "semon", role: "student" };
  localStorage.setItem("mochi_auth", JSON.stringify({ token: "x", user: WHO }));
  localStorage.setItem("mochi_v3", JSON.stringify({
    todos: MOCK_TODOS, notes: [], projects: data.projects, records: data.records,
    comments: data.comments, milestones: data.milestones,
  }));
  Promise.all([fakePhoto("ph1", 210), fakePhoto("ph2", 30), fakePhoto("ph3", 140), fakePhoto("ph4", 280)])
    .then(() => {
      createRoot(document.getElementById("root")).render(<MochiApp />);
      const click = (sel, t) => {
        const el = [...document.querySelectorAll(sel)]
          .find((x) => x.textContent.replace(/\s+/g, "").includes(t.replace(/\s+/g, "")));
        if (el) el.click();
      };
      setTimeout(() => {
        click("button", params.get("tab") || "记录");
        setTimeout(() => {
          const open = params.get("open");
          if (open) click(".pcard", open);
          setTimeout(() => { document.title = "READY"; }, 600);
        }, 400);
      }, 500);
    });
} else {
Promise.all([fakePhoto("ph1", 210), fakePhoto("ph2", 30), fakePhoto("ph3", 140), fakePhoto("ph4", 280)])
  .then(() => {
    createRoot(document.getElementById("root")).render(
      <Preview />);
    // 想看哪个页签就点哪个，然后再告诉截图脚本可以拍了
    const want = params.get("view");
    setTimeout(() => {
      const click = (t) => {
        const b = [...document.querySelectorAll("button")]
          .find((x) => x.textContent.replace(/\s+/g, "").includes(t.replace(/\s+/g, "")));
        if (b) b.click();
      };
      if (want) click(want);
      const open = params.get("open");
      setTimeout(() => {
        if (open) {
          const card = [...document.querySelectorAll(".adv-card")]
            .find((x) => x.textContent.replace(/\s+/g, "").includes(open.replace(/\s+/g, "")));
          if (card) card.click();
        }
        setTimeout(() => { document.title = "READY"; }, 500);
      }, 300);
    }, 400);
  });
}
