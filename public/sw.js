/* FVG 交易系统 Service Worker
 * - 仅缓存静态壳；API / 实时数据始终走网络
 * - 任何 fetch 失败必须被捕获，绝不抛 unhandled rejection
 * - 改 CACHE 版本号即可强制清掉旧 SW 的缓存
 */
const CACHE = 'fvg-shell-v8';
const SHELL = [
  '/',
  '/dashboard',
  '/backtest',
  '/manifest.json',
  '/styles.css',
  '/app.js',
  '/backtest.js',
  '/icons/icon.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

/** 安全 fetch：网络失败时返回离线占位，绝不向上抛 */
function safeFetch(req) {
  return fetch(req).catch(() => {
    // API 请求：返回 ok:false 的 JSON，避免前端解析报错
    if (req.url.includes('/api/')) {
      return new Response(
        JSON.stringify({ ok: false, offline: true, error: 'network unavailable' }),
        { status: 503, headers: { 'Content-Type': 'application/json' } }
      );
    }
    // 其他资源：返回空响应（503）
    return new Response('', { status: 503, statusText: 'offline' });
  });
}

self.addEventListener('fetch', (e) => {
  // 只处理 GET 请求；POST/其他放过
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  // API：始终走网络（network-first）
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(safeFetch(e.request));
    return;
  }

  // 静态：缓存命中优先；否则走网络；网络也失败 → 占位
  e.respondWith(
    caches
      .match(e.request)
      .then((cached) => cached || safeFetch(e.request))
      .catch(() => safeFetch(e.request))
  );
});

// 提供给页面调用的强制注销入口（用于切端口/清缓存）
self.addEventListener('message', (e) => {
  if (e.data === 'unregister') {
    self.registration.unregister().then(() => {
      caches.keys().then((keys) => keys.forEach((k) => caches.delete(k)));
    });
  }
});
