import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// 注入构建标识：排查「到底加载的是哪一版」时，不用再靠猜。
// 取自 git commit 而非构建时刻——否则同一份代码每次构建产物都不同，
// 本地和 CI 的文件名永远对不上，没法用它验证部署。
import { execSync } from "node:child_process";
let BUILD = "dev";
try {
  const q = { stdio: ["ignore", "pipe", "ignore"] };
  const h = execSync("git rev-parse --short HEAD", q).toString().trim();
  // 用提交的 UNIX 时间戳再自己按 UTC 格式化：%cd 会跟着本地时区变，
  // CI 在 UTC、我在 UTC+8，同一个 commit 会构建出不同产物，文件名对不上，
  // 那这个版本标识就失去了「用来核对部署」的意义。
  const ts = parseInt(execSync("git log -1 --format=%ct", q).toString().trim(), 10) * 1000;
  const d = new Date(ts);
  const p2 = (n) => String(n).padStart(2, "0");
  BUILD = `${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}Z ${h}`;
} catch {}

export default defineConfig({
  define: { __BUILD__: JSON.stringify(BUILD) },
  base: '/mochi-app/',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon-192.png', 'icon-512.png', 'apple-touch-icon.png'],
      manifest: {
        name: 'Mochi - 专注待办',
        short_name: 'Mochi',
        description: '专注待办 & 笔记',
        theme_color: '#2C2C2C',
        background_color: '#FDFBF7',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/mochi-app/',
        scope: '/mochi-app/',
        icons: [
          {
            src: 'icon-192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: 'icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable',
          },
        ],
      },
      workbox: {
        // 把推送处理器注入生成的 sw.js。用 importScripts 而不是切到 injectManifest，
        // 是为了不动现成的离线缓存策略。
        importScripts: ['push-sw.js'],
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts-cache',
              expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'gstatic-fonts-cache',
              expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
});
