/**
 * Express 入口
 * --------------------------------------------
 * 暴露 API：
 *   GET  /api/status
 *   GET  /api/trades
 *   POST /api/start
 *   POST /api/stop
 *   POST /api/backtest/start          { startDate, endDate, initialCapital?, feeRate? }
 *   GET  /api/backtest/status/:taskId
 *   GET  /api/backtest/result/:taskId
 *   GET  /api/backtest/list
 *
 * 静态：
 *   /             实盘 dashboard
 *   /dashboard    同上
 *   /backtest     回测仪表盘
 *   /manifest.json /sw.js
 */
const path = require('path');
const express = require('express');

const config = require('./config');
const logger = require('./utils/logger');
const db = require('./utils/db');

const binanceWs = require('./modules/binanceWs');
const backtestEngine = require('./modules/backtestEngine');

const app = express();
app.use(express.json({ limit: '1mb' }));

// 静态资源（PWA 前端）
app.use(express.static(path.join(__dirname, '..', 'public')));

// ===================== 实盘 API =====================
app.get('/api/status', (_req, res) => {
  res.json({
    ok: true,
    timeZone: 'Asia/Shanghai',
    config: {
      symbol: config.symbol,
      leverage: config.leverage,
      positionSize: config.positionSize,
      maxRiskPerTrade: config.maxRiskPerTrade,
      maxDailyLoss: config.maxDailyLoss,
      maxConsecutiveLosses: config.maxConsecutiveLosses,
    },
    live: binanceWs.getStatus(),
  });
});

app.get('/api/trades', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const rows = db
    .prepare(
      `SELECT id, ts_ms, ts_cn, action, direction, signal, price, trigger, pnl, note
       FROM trades ORDER BY ts_ms DESC LIMIT ?`
    )
    .all(limit);
  res.json({ ok: true, trades: rows });
});

app.post('/api/start', (_req, res) => {
  binanceWs.start();
  res.json({ ok: true, status: binanceWs.getStatus() });
});

app.post('/api/stop', (_req, res) => {
  binanceWs.stop();
  res.json({ ok: true, status: binanceWs.getStatus() });
});

// ===================== 回测 API =====================
app.post('/api/backtest/start', (req, res) => {
  const { startDate, endDate, initialCapital, feeRate } = req.body || {};
  if (!startDate || !endDate) {
    return res
      .status(400)
      .json({ ok: false, error: 'startDate / endDate required (YYYY-MM-DD)' });
  }
  const id = backtestEngine.startBacktest({
    startDate,
    endDate,
    initialCapital,
    feeRate,
  });
  res.json({ ok: true, taskId: id });
});

app.get('/api/backtest/status/:taskId', (req, res) => {
  const t = backtestEngine.getTask(req.params.taskId);
  if (!t) return res.status(404).json({ ok: false, error: 'task not found' });
  res.json({
    ok: true,
    id: t.id,
    status: t.status,
    progress: t.progress,
    error: t.error,
  });
});

app.get('/api/backtest/result/:taskId', (req, res) => {
  const t = backtestEngine.getTask(req.params.taskId);
  if (!t) return res.status(404).json({ ok: false, error: 'task not found' });
  res.json({ ok: true, task: t });
});

app.get('/api/backtest/list', (_req, res) => {
  res.json({ ok: true, tasks: backtestEngine.listTasks(50) });
});

// ===================== 页面 =====================
app.get(['/', '/dashboard'], (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'dashboard.html'));
});
app.get('/backtest', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'backtest.html'));
});

// 一键卸载 Service Worker + 清空缓存（切端口/排错时用）
// 访问 http://your-host:port/reset-sw 即可
app.get('/reset-sw', (_req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html><meta charset="utf-8"><title>Reset SW</title>
<body style="background:#0b1020;color:#e6ecff;font-family:-apple-system,sans-serif;padding:20px">
<h2>Service Worker 重置工具</h2>
<pre id="log">running...</pre>
<script>
(async () => {
  const log = document.getElementById('log');
  const append = (m) => log.textContent += '\\n' + m;
  if ('serviceWorker' in navigator) {
    const regs = await navigator.serviceWorker.getRegistrations();
    for (const r of regs) { await r.unregister(); append('unregistered: ' + r.scope); }
  }
  if (window.caches) {
    const keys = await caches.keys();
    for (const k of keys) { await caches.delete(k); append('cache deleted: ' + k); }
  }
  append('done. 关闭所有该域名的标签页后重新打开。');
})();
</script>
</body>`);
});

// ===================== 启动 =====================
app.listen(config.port, () => {
  logger.ok(`FVG 量化交易系统启动成功`);
  logger.info(`监听端口: ${config.port}`);
  logger.info(`实盘仪表盘: http://localhost:${config.port}/`);
  logger.info(`回测仪表盘: http://localhost:${config.port}/backtest`);
});

// 未捕获异常处理（防止整个进程崩溃）
process.on('unhandledRejection', (e) => logger.error('unhandledRejection:', e));
process.on('uncaughtException', (e) => logger.error('uncaughtException:', e));
