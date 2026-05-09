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
const { HttpsProxyAgent } = require('https-proxy-agent');
const config = require('../config');
const logger = require('../utils/logger');
const dataEngine = require('./dataEngine');
const signalScanner = require('./signalScanner');
const { liveRisk } = require('./riskManager');
const webhookExecutor = require('./webhookExecutor');
const { nowMs, startOfDayCN, formatMs } = require('../utils/timeUtil');

let ws = null;
let reconnectDelay = 1000;
const MAX_DELAY = 30000;
let running = false;

// 默认 combined stream（已经过实测：单流 /ws/<name> 在某些机房会握手成功但不推数据）
// 可在 .env 覆盖 BINANCE_WS_URL
const WS_URL = config.binanceWsUrl;

// === 实时上下文 ===
const ctx = {
  lastPrice: null,
  lastTickAt: 0,
  vwapArr: [],
  atrArr: [],
  fvgs: { bullish: [], bearish: [] },
  k15: [],
  k1h: [],
  position: null,
  // 状态摘要（暴露给 /api/status）
  stats: {
    startedAt: null,
    ticks: 0,
    lastDecisionMs: 0,
  },
  // WS 健康状态
  wsState: {
    state: 'idle', // idle | connecting | open | closed | error
    url: WS_URL,
    proxy: config.httpsProxy || '',
    connectedAt: 0,
    closedAt: 0,
    attempts: 0,
    lastError: '',
    // 最近一条原始消息样本（前 200 字符），用于排查解析问题
    lastRawSample: '',
    lastRawAt: 0,
    rawMessages: 0,        // 收到的原始消息总数（含未识别）
    parseErrors: 0,        // JSON 解析失败次数
    unrecognized: 0,       // 解析成功但无 .p 字段
  },
  // 最近 30 个 WS 事件（环形）
  events: [],
  // 已被信号"测试过"的 FVG（key = dataEngine.fvgKey(f)）
  // 一旦某 FVG 触发了任意陷阱/突破信号，就加入此集合，
  // 之后不再参与信号扫描，也不在 dashboard 显示。
  testedFvgs: new Set(),
};

const MAX_EVENTS = 30;
function pushEvent(level, message) {
  const ev = { ts: nowMs(), level, message };
  ctx.events.push(ev);
  if (ctx.events.length > MAX_EVENTS) ctx.events.shift();
  // 同步打印到日志
  if (level === 'error') logger.error(`[WS] ${message}`);
  else if (level === 'warn') logger.warn(`[WS] ${message}`);
  else if (level === 'ok') logger.ok(`[WS] ${message}`);
  else logger.info(`[WS] ${message}`);
}

function readyStateText(ws) {
  if (!ws) return 'idle';
  switch (ws.readyState) {
    case WebSocket.CONNECTING: return 'connecting';
    case WebSocket.OPEN: return 'open';
    case WebSocket.CLOSING: return 'closing';
    case WebSocket.CLOSED: return 'closed';
    default: return 'unknown';
  }
}

/**
 * 取当前活跃的 FVG（按形成时间倒序），并按"距离当前价远近"排好序
 *  - 看涨 FVG：c1Low 是关键支撑（陷阱多触发线）；c1High~c3Low 是缺口
 *  - 看跌 FVG：c1High 是关键阻力（陷阱空触发线）；c3High~c1Low 是缺口
 */
function activeFvgsForDashboard(limit = 5) {
  // 用最新 15m K 线作为评估锚点（与信号判定粒度一致）
  const last15m = ctx.k15.length > 0 ? ctx.k15[ctx.k15.length - 1] : null;
  const refTs = last15m ? last15m[0] : nowMs();
  const refPrice = ctx.lastPrice ?? (last15m ? last15m[4] : null);
  const active = dataEngine.activeFvgsAt(ctx.fvgs, refTs, ctx.k15, {
    excludeKeys: ctx.testedFvgs,
  });

  const decorate = (f) => {
    const distKey = f.type === 'bull' ? f.c1Low : f.c1High;
    return {
      type: f.type,
      tsC1: f.tsC1,
      tsC1CN: formatMs(f.tsC1),
      c1Low: f.c1Low,
      c1High: f.c1High,
      gapLow: f.gapLow,
      gapHigh: f.gapHigh,
      keyPrice: distKey, // 系统判信号的关键 C1 价
      distance: refPrice ? distKey - refPrice : null,
      distancePct: refPrice ? (distKey - refPrice) / refPrice : null,
    };
  };

  const closer = (refPrice, getKey) => (a, b) =>
    Math.abs(getKey(a) - refPrice) - Math.abs(getKey(b) - refPrice);

  const bullish = active.bullish.map(decorate);
  const bearish = active.bearish.map(decorate);
  if (refPrice != null) {
    bullish.sort(closer(refPrice, (f) => f.c1Low));
    bearish.sort(closer(refPrice, (f) => f.c1High));
  }
  return {
    bullish: bullish.slice(0, limit),
    bearish: bearish.slice(0, limit),
    refPrice,
    refTsCN: formatMs(refTs),
  };
}

function getStatus() {
  return {
    running,
    lastPrice: ctx.lastPrice,
    lastTickAt: ctx.lastTickAt,
    position: ctx.position,
    risk: liveRisk.snapshot(),
    stats: ctx.stats,
    ws: {
      ...ctx.wsState,
      readyState: readyStateText(ws),
    },
    events: ctx.events.slice(-MAX_EVENTS),
    vwapNow:
      ctx.vwapArr.length > 0
        ? ctx.vwapArr[ctx.vwapArr.length - 1].vwap
        : null,
    atrNow:
      ctx.atrArr.length > 0
        ? ctx.atrArr[ctx.atrArr.length - 1].atr
        : null,
    fvgs: activeFvgsForDashboard(5),
    testedFvgsCount: ctx.testedFvgs.size,
  };
}

/**
 * 连接 WebSocket
 *  - 若 .env 配置了 HTTPS_PROXY，自动走代理（解决国内 GFW 干扰长连接）
 */
function connect() {
  if (!running) return;
  ctx.wsState.state = 'connecting';
  ctx.wsState.attempts += 1;
  const wsOpts = { handshakeTimeout: config.binanceWsHandshakeMs };
  if (config.httpsProxy) {
    try {
      wsOpts.agent = new HttpsProxyAgent(config.httpsProxy);
      pushEvent('info', `connecting via proxy ${config.httpsProxy} → ${WS_URL}`);
    } catch (e) {
      pushEvent('error', `HTTPS_PROXY 解析失败: ${e.message}`);
    }
  } else {
    pushEvent('info', `connecting → ${WS_URL} (attempt #${ctx.wsState.attempts})`);
  }

  ws = new WebSocket(WS_URL, wsOpts);

  ws.on('open', () => {
    ctx.wsState.state = 'open';
    ctx.wsState.connectedAt = nowMs();
    ctx.wsState.lastError = '';
    reconnectDelay = 1000;
    pushEvent('ok', 'connected');
  });

  ws.on('message', (raw) => {
    ctx.wsState.rawMessages += 1;
    // 第一条与每 100 条采样一次，用于诊断
    if (ctx.wsState.rawMessages === 1 || ctx.wsState.rawMessages % 100 === 0) {
      const sample = String(raw).slice(0, 200);
      ctx.wsState.lastRawSample = sample;
      ctx.wsState.lastRawAt = nowMs();
      pushEvent('info', `msg #${ctx.wsState.rawMessages}: ${sample}`);
    }

    // 极速路径：尽量快、避免 throw
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      ctx.wsState.parseErrors += 1;
      if (ctx.wsState.parseErrors <= 3) {
        pushEvent('warn', `parse error: ${e.message} | raw=${String(raw).slice(0, 120)}`);
      }
      return;
    }
    // 单流：直接是 markPriceUpdate 对象；combined：包了一层 { stream, data }
    const data = msg.data || msg;
    if (!data || data.p == null) {
      ctx.wsState.unrecognized += 1;
      if (ctx.wsState.unrecognized <= 3) {
        pushEvent('warn', `unrecognized payload: ${JSON.stringify(msg).slice(0, 200)}`);
      }
      return;
    }
    const price = parseFloat(data.p);
    if (!Number.isFinite(price)) {
      pushEvent('warn', `invalid price field: ${data.p}`);
      return;
    }
    onPriceTick(price);
  });

  ws.on('close', (code, reason) => {
    ctx.wsState.state = 'closed';
    ctx.wsState.closedAt = nowMs();
    const reasonStr = reason ? reason.toString() : '';
    pushEvent('warn', `closed code=${code} ${reasonStr}`);
    scheduleReconnect();
  });

  ws.on('error', (err) => {
    ctx.wsState.state = 'error';
    ctx.wsState.lastError = err.message;
    pushEvent('error', `error: ${err.message}`);
    try {
      ws.terminate();
    } catch (_) {
      /* ignore */
    }
  });

  // 心跳：币安每 3 分钟发一次 ping
  ws.on('ping', () => {
    pushEvent('info', 'ping ← server, pong →');
    try { ws.pong(); } catch (_) { /* ignore */ }
  });
  ws.on('pong', () => pushEvent('info', 'pong ← server'));
}

function scheduleReconnect() {
  if (!running) return;
  setTimeout(connect, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_DELAY);
}

/**
 * 静默连接看门狗：每 30 秒检查一次，
 * 若 WS 已经 OPEN 但 60 秒没收到任何消息，主动断开触发重连。
 */
function startWatchdog() {
  setInterval(() => {
    if (!running || !ws || ws.readyState !== WebSocket.OPEN) return;
    const idle = nowMs() - (ctx.lastTickAt || ctx.wsState.connectedAt || 0);
    if (idle > 60_000) {
      logger.warn(`WS 静默 ${Math.round(idle / 1000)}s，强制重连`);
      try { ws.terminate(); } catch (_) { /* ignore */ }
    }
  }, 30_000).unref?.();
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

  // 第一条 tick 与每 60 条采样一次（约 1 分钟一次）
  if (ctx.stats.ticks === 1 || ctx.stats.ticks % 60 === 0) {
    pushEvent('info', `tick #${ctx.stats.ticks} price=${price}`);
  }

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
      // ★ 信号扫描必须用 formedFvgsAt（不做 close 失效过滤）
      //   并排除已被信号"测试过"的 FVG（一次成型只能触发一次）
      const formedFvgs = dataEngine.formedFvgsAt(ctx.fvgs, last[0], {
        excludeKeys: ctx.testedFvgs,
      });
      const prevClose =
        ctx.k15.length >= 2 ? ctx.k15[ctx.k15.length - 2][4] : null;
      const sig = signalScanner.scanSignals({
        k15: last,
        prevClose,
        vwap,
        activeFvgs: formedFvgs,
      });
      if (sig) {
        // ★ 不论风控结果，FVG 已经被这根 K 线"测试"过 → 标记，后续不再参与
        if (sig.fvg) {
          ctx.testedFvgs.add(dataEngine.fvgKey(sig.fvg));
        }
        const can = liveRisk.canOpen(sig.direction, now);
        if (!can.ok) {
          logger.warn(`信号丢弃：${can.reason} | ${sig.name}`);
          return;
        }
        const tp = signalScanner.computeTakeProfit({
          direction: sig.direction,
          entry: sig.entry,
          vwap,
          activeFvgs: formedFvgs,
          minPct: config.takeProfitMinPct,
        });
        const sl = signalScanner.computeStopLoss({
          direction: sig.direction,
          entry: sig.entry,
          stopLossStruct: sig.stopLossStruct,
          atr,
          minStopPct: config.minStopLossPct,
          maxRiskPct: config.maxRiskPerTrade,
          positionSize: config.positionSize,
          leverage: config.leverage,
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
  // ★ 关键：立即启动 WS，不等 ccxt 拉 K 线（避免 REST 慢拖累实时数据）
  connect();
  startWatchdog();
  refreshIndicatorsLoop();
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
