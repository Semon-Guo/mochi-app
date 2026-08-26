import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// 注入构建标识：排查「到底加载的是哪一版」时，不用再靠猜。
// 取自 git commit 而非构建时刻——否则同一份代码每次构建产物都不同，
// 本地和 CI 的文件名永远对不上，没法用它验证部署。
import { execSync } from "node:child_process";
let BUILD = "dev";
try {
  const h = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  const d = execSync('git log -1 --format=%cd --date=format:%m-%d\\ %H:%M', { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  BUILD = `${d} ${h}`;
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
