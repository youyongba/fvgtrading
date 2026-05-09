/**
 * binanceWs - 币安实时 markPrice 接入
 * --------------------------------------------
 * 订阅：btcusdt@markPrice@1s （combined stream 形式）
 * 完整地址：wss://fstream.binance.com/stream?streams=btcusdt@markPrice@1s
 *
 * 核心要求：
 *   - 接收到价格后必须在 50ms 内完成 TP / SL 判定，并立即触发 Webhook
 *   - 任何指标计算 / 飞书通知 / 落库均不得阻塞 onPriceTick
 *
 * 指标更新策略：
 *   - 1H/15m K 线由独立的轻量调度器拉取（每分钟一次），与 tick 解耦
 *   - tick 仅做"价格 vs 已计算好的 TP / SL"对比
 *
 * 自动重连：指数退避（1s → 2s → 5s → 10s → 30s 上限）
 */
const WebSocket = require('ws');
const config = require('../config');
const logger = require('../utils/logger');
const dataEngine = require('./dataEngine');
const signalScanner = require('./signalScanner');
const { liveRisk } = require('./riskManager');
const webhookExecutor = require('./webhookExecutor');
const { nowMs, startOfDayCN } = require('../utils/timeUtil');

let ws = null;
let reconnectDelay = 1000;
const MAX_DELAY = 30000;
let running = false;

// === 实时上下文 ===
const ctx = {
  lastPrice: null,
  lastTickAt: 0,
  vwapArr: [],
  atrArr: [],
  fvgs: { bullish: [], bearish: [] },
  k15: [], // 最近的 15m K 线
  k1h: [], // 最近的 1H K 线
  position: null, // { direction, entry, tp, sl, signal, note, openedAt }
  // 状态摘要（暴露给 /api/status）
  stats: {
    startedAt: null,
    ticks: 0,
    lastDecisionMs: 0,
  },
};

function getStatus() {
  return {
    running,
    lastPrice: ctx.lastPrice,
    lastTickAt: ctx.lastTickAt,
    position: ctx.position,
    risk: liveRisk.snapshot(),
    stats: ctx.stats,
    vwapNow:
      ctx.vwapArr.length > 0
        ? ctx.vwapArr[ctx.vwapArr.length - 1].vwap
        : null,
    atrNow:
      ctx.atrArr.length > 0
        ? ctx.atrArr[ctx.atrArr.length - 1].atr
        : null,
  };
}

/**
 * 连接 WebSocket
 */
function connect() {
  if (!running) return;
  const url = config.binanceWsCombined;
  logger.info(`WS connecting → ${url}`);
  ws = new WebSocket(url, {
    handshakeTimeout: config.binanceWsHandshakeMs,
  });

  ws.on('open', () => {
    logger.ok('WS connected');
    reconnectDelay = 1000;
  });

  ws.on('message', (raw) => {
    // 极速路径：尽量快、避免 throw
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const data = msg.data || msg;
    if (!data || !data.p) return;
    const price = parseFloat(data.p);
    if (!Number.isFinite(price)) return;
    onPriceTick(price);
  });

  ws.on('close', (code) => {
    logger.warn(`WS closed code=${code}`);
    scheduleReconnect();
  });

  ws.on('error', (err) => {
    logger.error('WS error:', err.message);
    try {
      ws.terminate();
    } catch (_) {
      /* ignore */
    }
  });
}

function scheduleReconnect() {
  if (!running) return;
  setTimeout(connect, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_DELAY);
}

/**
 * ★ 核心快速路径：必须在 50ms 内完成
 *  - 仅做"价格 vs 已经预先算好的 TP / SL"对比
 *  - 一旦命中：立即 fireTradeWebhook（zero-delay）
 */
function onPriceTick(price) {
  const t0 = nowMs();
  ctx.lastPrice = price;
  ctx.lastTickAt = t0;
  ctx.stats.ticks += 1;

  const pos = ctx.position;
  if (pos) {
    let hit = null;
    if (pos.direction === 'long') {
      if (price >= pos.tp.price) hit = 'tp';
      else if (price <= pos.sl) hit = 'sl';
    } else {
      if (price <= pos.tp.price) hit = 'tp';
      else if (price >= pos.sl) hit = 'sl';
    }
    if (hit) {
      // 1) 立即触发 Webhook（同步发送）
      webhookExecutor.fireTradeWebhook({
        action: hit === 'tp' ? 'take_profit' : 'stop_loss',
        direction: pos.direction,
        trigger: hit === 'tp' ? 'tp_4' : 'sl',
        price,
        note: hit === 'tp' ? `tp(${pos.tp.src})` : '止损',
      });
      // 2) 估算 PnL（按比例）→ 喂给风控
      const pnlPct =
        pos.direction === 'long'
          ? (price - pos.entry) / pos.entry
          : (pos.entry - price) / pos.entry;
      const pnl = pnlPct * config.positionSize * config.leverage; // 名义本金=1 时的等效百分比
      liveRisk.closePosition({ pnl, ts: t0 });
      ctx.position = null;
      ctx.stats.lastDecisionMs = nowMs() - t0;
      return;
    }
  }
  ctx.stats.lastDecisionMs = nowMs() - t0;
}

/**
 * 周期性刷新指标 + 检测信号（每分钟）
 *  - 拉取 1H 与 15m K 线
 *  - 计算 VWAP / ATR / FVG
 *  - 在 15m K 线"刚收盘"时调用 signalScanner
 */
async function refreshIndicatorsLoop() {
  let backoff = 60_000;
  while (running) {
    try {
      await refreshOnce();
      backoff = 60_000; // 成功后回到 1 分钟节奏
    } catch (e) {
      logger.error(`指标刷新失败（${backoff}ms 后重试）: ${e.message}`);
      backoff = Math.min(backoff * 2, 5 * 60_000); // 最长 5 分钟
    }
    await sleep(backoff);
  }
}

async function refreshOnce() {
  const now = nowMs();
  // 拉取最近 ~30 天的 1H 与 15m K 线（足够覆盖 VWAP/ATR/FVG）
  const since1h = now - 30 * 24 * 60 * 60 * 1000;
  const since15m = now - 7 * 24 * 60 * 60 * 1000;
  const [k1h, k15] = await Promise.all([
    dataEngine.fetchOHLCVRange(config.ccxtSymbol, '1h', since1h, now),
    dataEngine.fetchOHLCVRange(config.ccxtSymbol, '15m', since15m, now),
  ]);
  ctx.k1h = k1h;
  ctx.k15 = k15;
  ctx.vwapArr = dataEngine.computeVWAP(k1h);
  ctx.atrArr = dataEngine.computeATR(k1h, 14);
  ctx.fvgs = dataEngine.findFVGs(k1h);

  // 找最近 1 根"刚收盘"的 15m K 线（与 now 间隔 < 90s 视为刚收盘）
  if (k15.length === 0) return;
  const last = k15[k15.length - 1];
  const closeTs = last[0] + 15 * 60 * 1000;
  if (now - closeTs > 0 && now - closeTs < 90_000) {
    // 在该 K 线收盘时刻评估信号
    if (!ctx.position) {
      const vwap = dataEngine.vwapAt(ctx.vwapArr, last[0]);
      const atr = dataEngine.atrAt(ctx.atrArr, last[0]);
      const activeFvgs = dataEngine.activeFvgsAt(
        ctx.fvgs,
        last[0],
        ctx.k1h
      );
      const sig = signalScanner.scanSignals({
        k15: last,
        vwap,
        activeFvgs,
      });
      if (sig) {
        const can = liveRisk.canOpen(sig.direction, now);
        if (!can.ok) {
          logger.warn(`信号丢弃：${can.reason} | ${sig.name}`);
          return;
        }
        const tp = signalScanner.computeTakeProfit({
          direction: sig.direction,
          entry: sig.entry,
          vwap,
          activeFvgs,
        });
        const sl = signalScanner.computeStopLoss({
          direction: sig.direction,
          entry: sig.entry,
          stopLossStruct: sig.stopLossStruct,
          atr,
        });
        // 立即开仓
        webhookExecutor.fireTradeWebhook({
          action: sig.direction === 'long' ? 'open_long' : 'open_short',
          direction: sig.direction,
          signal: sig.name,
          price: sig.entry,
          note: sig.reason,
        });
        liveRisk.openPosition(sig.direction, now);
        ctx.position = {
          direction: sig.direction,
          entry: sig.entry,
          tp,
          sl,
          signal: sig.name,
          note: sig.reason,
          openedAt: now,
        };
      }
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function start() {
  if (running) return;
  running = true;
  ctx.stats.startedAt = nowMs();
  ctx.stats.startedDay = startOfDayCN(nowMs());
  liveRisk.reset();
  refreshOnce()
    .catch((e) =>
      logger.error(
        `初始指标刷新失败（不影响 WS 接入，将在后台持续重试）: ${e.message}`
      )
    )
    .finally(() => {
      connect();
      refreshIndicatorsLoop();
    });
}

function stop() {
  running = false;
  try {
    ws && ws.close();
  } catch (_) {
    /* ignore */
  }
  ws = null;
  logger.info('WS stopped');
}

module.exports = {
  start,
  stop,
  getStatus,
  ctx,
};
