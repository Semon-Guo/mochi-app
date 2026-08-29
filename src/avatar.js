/* 头像：正方形居中裁剪 → 192px → JPEG data URL。
 *
 * 存 data URL 而不是走文件端点，是因为导师端一屏要显示十几个人的头像，
 * 走文件就是十几个请求；存在用户表里能随成员列表一次返回。
 */

const SIZE = 192;
const QUALITY = 0.82;

export function fileToAvatar(file) {
  return new Promise((res, rej) => {
    if (!file || !/^image\//.test(file.type)) return rej(new Error("请选择图片文件"));
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        // 居中裁成正方形再缩放，避免非正方图片被拉变形
        const side = Math.min(img.width, img.height);
        const sx = (img.width - side) / 2;
        const sy = (img.height - side) / 2;
        const cv = document.createElement("canvas");
        cv.width = cv.height = SIZE;
        const ctx = cv.getContext("2d");
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(img, sx, sy, side, side, 0, 0, SIZE, SIZE);
        URL.revokeObjectURL(url);
        res(cv.toDataURL("image/jpeg", QUALITY));
      } catch (e) {
        URL.revokeObjectURL(url);
        rej(e);
      }
    };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error("这张图读不了")); };
    img.src = url;
  });
}

/* 没有头像时用名字首字生成一个稳定的占位色块——同一个人每次颜色一样，
   在成员列表里也能靠颜色认人。 */
const HUES = [8, 28, 45, 88, 152, 190, 214, 258, 292, 322];

export function avatarFallback(name = "", id = "") {
  const seed = `${id}${name}`;
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const hue = HUES[h % HUES.length];
  const ch = (name || "?").trim()[0] || "?";
  return { initial: ch.toUpperCase(), bg: `hsl(${hue} 42% 88%)`, fg: `hsl(${hue} 55% 32%)` };
}
