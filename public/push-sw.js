/* 推送处理器，由 workbox 的 importScripts 注入生成的 sw.js。
 *
 * 这段代码是 app 关闭时唯一还会运行的东西：系统收到推送后唤醒 Service Worker，
 * 执行这里的 push 处理器弹出通知。页面里的定时器在后台早就被冻结了。
 */

self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (e) { /* 非 JSON 就走默认文案 */ }

  // showNotification 必须包在 waitUntil 里，否则 SW 可能在通知弹出前就被回收。
  // 另外 userVisibleOnly 订阅要求每条推送都必须可见地提示用户，不弹就会被浏览器警告。
  event.waitUntil(
    self.registration.showNotification(d.title || '⏰ Mochi 提醒', {
      body: d.body || '',
      tag: d.tag || 'mochi',
      renotify: true,
      icon: 'icon-192.png',
      badge: 'icon-192.png',
      data: { todoId: d.todoId || null },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // 已经开着就聚焦过去，别再开一个新窗口
    for (const c of all) {
      if (c.url.includes('/mochi-app/')) {
        await c.focus();
        c.postMessage({ type: 'notification-click', todoId: event.notification.data?.todoId });
        return;
      }
    }
    await self.clients.openWindow('./');
  })());
});
