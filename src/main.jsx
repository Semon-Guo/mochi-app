import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import MochiApp from '../todo-notes-app.jsx';

// Service Worker 换代时自动刷新一次。
// 没有这段的话，发了新版本大家还是看到缓存里的旧界面，只能一个个教清缓存——
// 20 个人的组里这是每次更新都要重来一遍的事。
if ('serviceWorker' in navigator) {
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });
  // 回到前台时主动问一次有没有新版本，别干等浏览器自己去查
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      navigator.serviceWorker.getRegistration().then(r => r?.update()).catch(() => {});
    }
  });
}

const root = createRoot(document.getElementById('root'));
root.render(
  <StrictMode>
    <MochiApp />
  </StrictMode>
);
