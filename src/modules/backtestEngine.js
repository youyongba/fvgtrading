/**
 * backtestEngine - 历史回测
 * --------------------------------------------
 * 与实盘共用：dataEngine、signalScanner、riskManager
 *
 * 流程：
 *   1. 用户提交起止日期（东八区）、初始资金、手续费率
 *   2. 拉取 1H 与 15m K 线（限定区间）
 *   3. 预计算 VWAP / ATR / FVG
 *   4. 遍历 15m K 线（按收盘时间）：
 *      - 若有持仓：用本根 K 线 high/low 判断 TP/SL 是否被穿透；
 *        穿透即按目标价成交（防止偷价：先判 SL 后判 TP，按方向取最不利者）
 *      - 若无持仓：执行 signalScanner，若有信号 → 经 riskManager 通过 → 开仓
 *   5. 统计绩效，写入 SQLite
 *
 * 防偷价规则：
 *   - 信号触发当根 K 线，按"收盘价"开仓（与实盘 15m 收盘判定一致）
 *   - 平仓在"下一根" K 线开始评估（避免使用同根 K 线的高低点判定 SL/TP）
 */
const { v4: uuidv4 } = (() => {
  // 极简 UUID（不引入额外依赖）
  return {
    v4: () =>
      'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
      }),
  };
})();

const dataEngine = require('./dataEngine');
const signalScanner = require('./signalScanner');
const { createRiskManager } = require('./riskManager');
const config = require('../config');
const logger = require('../utils/logger');
const db = require('../utils/db');
const {
  formatMs,
  formatNow,
  dateStrToMs,
} = require('../utils/timeUtil');

const tasks = new Map(); // taskId → { status, progress, result }

function listTasks(limit = 50) {
  return db
    .prepare(
      `SELECT id, status, start_date, end_date, initial_capital, fee_rate,
              progress, created_at, updated_at, error
       FROM backtest_tasks ORDER BY created_at DESC LIMIT ?`
    )
    .all(limit);
}

function getTask(id) {
  const row = db
    .prepare('SELECT * FROM backtest_tasks WHERE id = ?')
    .get(id);
  if (!row) return null;
  let trades = [];
  let equity = [];
  if (row.status === 'done') {
    trades = db
      .prepare(
        `SELECT * FROM backtest_trades WHERE task_id = ? ORDER BY open_ts ASC`
      )
      .all(id);
    equity = db
      .prepare(
        `SELECT ts, ts_cn, equity FROM backtest_equity WHERE task_id = ? ORDER BY ts ASC`
      )
      .all(id);
  }
  return {
    ...row,
    result: row.result ? JSON.parse(row.result) : null,
    trades,
    equity,
  };
}

/**
 * 启动一次回测（异步，不阻塞 HTTP 请求）
 * @param {{startDate:string, endDate:string, initialCapital?:number, feeRate?:number}} opts
 */
function startBacktest(opts) {
  const id = uuidv4();
  const now = formatNow();
  const startDate = opts.startDate;
  const endDate = opts.endDate;
  const initialCapital = Number(opts.initialCapital) || config.backtestInitialCapital;
  const feeRate = Number(opts.feeRate);
  const finalFeeRate = Number.isFinite(feeRate) ? feeRate : config.backtestFeeRate;

  db.prepare(
    `INSERT INTO backtest_tasks
       (id, status, start_date, end_date, initial_capital, fee_rate, progress, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(id, 'pending', startDate, endDate, initialCapital, finalFeeRate, 0, now, now);

  tasks.set(id, { status: 'pending', progress: 0 });

  setImmediate(() => runBacktest(id, {
    startDate,
    endDate,
    initialCapital,
    feeRate: finalFeeRate,
  }).catch((e) => {
    logger.error('backtest fatal:', e.message);
    db.prepare(
      `UPDATE backtest_tasks SET status='error', error=?, updated_at=? WHERE id=?`
    ).run(e.message, formatNow(), id);
  }));

  return id;
}

async function runBacktest(taskId, opts) {
  const t0 = Date.now();

  // 启动前预检（快速失败）
  try {
    await dataEngine.ping();
  } catch (e) {
    db.prepare(
      `UPDATE backtest_tasks SET status='error', error=?, updated_at=? WHERE id=?`
    ).run(
      `无法连接币安: ${e.message}（请检查网络或在 .env 配置 HTTPS_PROXY）`,
      formatNow(),
      taskId
    );
    tasks.set(taskId, { status: 'error', progress: 0 });
    logger.error(`回测预检失败 ${taskId}: ${e.message}`);
    return;
  }

  const setStatus = (status, extra = {}) => {
    const fields = ['status', 'updated_at'];
    const values = [status, formatNow()];
    if (extra.progress != null) {
      fields.push('progress');
      values.push(extra.progress);
    }
    if (extra.result != null) {
      fields.push('result');
      values.push(JSON.stringify(extra.result));
    }
    if (extra.error != null) {
      fields.push('error');
      values.push(extra.error);
    }
    const sql =
      `UPDATE backtest_tasks SET ` +
      fields.map((f) => `${f}=?`).join(', ') +
      ` WHERE id=?`;
    db.prepare(sql).run(...values, taskId);
    tasks.set(taskId, {
      status,
      progress: extra.progress ?? tasks.get(taskId)?.progress ?? 0,
    });
  };

  setStatus('running', { progress: 0 });
  logger.info(`回测任务 ${taskId} 启动: ${opts.startDate} ~ ${opts.endDate}`);

  const sinceMs = dateStrToMs(opts.startDate, '00:00:00');
  const untilMs = dateStrToMs(opts.endDate, '23:59:59');

  // 1) 拉取 K 线（额外多取 30 天 1H 用于指标预热）
  const warmup1h = sinceMs - 30 * 24 * 60 * 60 * 1000;
  const k1h = await dataEngine.fetchOHLCVRange(
    config.ccxtSymbol,
    '1h',
    warmup1h,
    untilMs
  );
  const k15 = await dataEngine.fetchOHLCVRange(
    config.ccxtSymbol,
    '15m',
    sinceMs,
    untilMs
  );
  if (k15.length === 0) {
    setStatus('error', { error: 'no 15m kline returned' });
    return;
  }
  setStatus('running', { progress: 5 });

  const vwapArr = dataEngine.computeVWAP(k1h);
  const atrArr = dataEngine.computeATR(k1h, 14);
  const fvgs = dataEngine.findFVGs(k1h);

  // 2) 风控独立实例
  const risk = createRiskManager({ initialCapital: opts.initialCapital });

  // 3) 状态
  let equity = opts.initialCapital;
  let position = null; // { direction, entry, tp, sl, qty, signal, openedAt, openIndex, note }
  const trades = [];
  const equityCurve = [];

  const insTrade = db.prepare(
    `INSERT INTO backtest_trades
      (task_id, open_ts, open_ts_cn, close_ts, close_ts_cn,
       direction, signal, entry, exit, qty, pnl, pnl_pct, exit_reason, fee,
       stop_loss, take_profit, tp_src, hold_bars)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const insEquity = db.prepare(
    `INSERT INTO backtest_equity (task_id, ts, ts_cn, equity) VALUES (?,?,?,?)`
  );

  const total = k15.length;
  let lastReportedPct = 0;

  for (let i = 0; i < total; i++) {
    const bar = k15[i]; // [ts, o, h, l, c, v]
    const [ts, , high, low, close] = bar;
    if (ts < sinceMs) continue;

    // ===== 已有持仓：在"本根 K 线"判断 TP/SL =====
    // 注意：position 可能是上一根开的（信号触发当根开仓），所以从 i = openIndex+1 起才允许判定
    if (position && i > position.openIndex) {
      let exit = null;
      let reason = null;
      // 防偷价：保守地按方向取"较先触发"的那个
      if (position.direction === 'long') {
        const hitSL = low <= position.sl;
        const hitTP = high >= position.tp.price;
        if (hitSL && hitTP) {
          // 同根 K 线同时穿透 → 取最坏（止损先发生）
          exit = position.sl;
          reason = 'sl';
        } else if (hitSL) {
          exit = position.sl;
          reason = 'sl';
        } else if (hitTP) {
          exit = position.tp.price;
          reason = 'tp';
        }
      } else {
        const hitSL = high >= position.sl;
        const hitTP = low <= position.tp.price;
        if (hitSL && hitTP) {
          exit = position.sl;
          reason = 'sl';
        } else if (hitSL) {
          exit = position.sl;
          reason = 'sl';
        } else if (hitTP) {
          exit = position.tp.price;
          reason = 'tp';
        }
      }
      if (exit != null) {
        const grossPct =
          position.direction === 'long'
            ? (exit - position.entry) / position.entry
            : (position.entry - exit) / position.entry;
        const notional = equity * (config.positionSize / 100) * config.leverage;
        const pnlGross = notional * grossPct;
        const fee = notional * opts.feeRate * 2; // 开 + 平
        const pnl = pnlGross - fee;
        equity += pnl;
        risk.closePosition({ pnl, ts });
        // ★ 修复：close_ts 用本根 K 线"收盘时刻"（ts + 15min），
        //   与 open_ts（信号那根 K 线收盘时刻）至少差 15min，避免开平仓时间相同
        const closeTs = ts + 15 * 60 * 1000;
        const holdBars = i - position.openIndex;
        trades.push({
          open_ts: position.openedAt,
          close_ts: closeTs,
          direction: position.direction,
          signal: position.signal,
          entry: position.entry,
          exit,
          qty: notional / position.entry,
          pnl,
          pnl_pct: grossPct,
          exit_reason: reason,
          fee,
          stop_loss: position.sl,
          take_profit: position.tp.price,
          tp_src: position.tp.src,
          hold_bars: holdBars,
        });
        insTrade.run(
          taskId,
          position.openedAt,
          formatMs(position.openedAt),
          closeTs,
          formatMs(closeTs),
          position.direction,
          position.signal,
          position.entry,
          exit,
          notional / position.entry,
          pnl,
          grossPct,
          reason,
          fee,
          position.sl,
          position.tp.price,
          position.tp.src,
          holdBars
        );
        position = null;
      }
    }

    // ===== 无持仓：扫描信号（以本根 K 线收盘判定）=====
    if (!position) {
      const vwap = dataEngine.vwapAt(vwapArr, ts);
      const atr = dataEngine.atrAt(atrArr, ts);
      const activeFvgs = dataEngine.activeFvgsAt(fvgs, ts, k15);
      const sig = signalScanner.scanSignals({
        k15: bar,
        vwap,
        activeFvgs,
      });
      if (sig) {
        const can = risk.canOpen(sig.direction, ts);
        if (can.ok) {
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
            minStopPct: config.minStopLossPct,
          });
          if (tp && Number.isFinite(sl)) {
            risk.openPosition(sig.direction, ts);
            position = {
              direction: sig.direction,
              entry: sig.entry,
              tp,
              sl,
              signal: sig.name,
              note: sig.reason,
              openedAt: ts + 15 * 60 * 1000, // 视为收盘后开仓
              openIndex: i,
            };
          }
        }
      }
    }

    // 净值曲线（每 4 根 K 线 = 1 小时记录一次，避免数据过大）
    if (i % 4 === 0 || i === total - 1) {
      equityCurve.push({ ts, equity });
      insEquity.run(taskId, ts, formatMs(ts), equity);
    }

    const pct = Math.floor((i / total) * 90) + 5;
    if (pct - lastReportedPct >= 5) {
      lastReportedPct = pct;
      setStatus('running', { progress: pct });
    }
  }

  // 4) 绩效统计
  const result = computeStats({
    trades,
    initialCapital: opts.initialCapital,
    finalEquity: equity,
    equityCurve,
    elapsedMs: Date.now() - t0,
  });

  setStatus('done', { progress: 100, result });
  logger.ok(
    `回测完成 ${taskId} 总盈亏 ${result.totalPnL.toFixed(2)} 胜率 ${(
      result.winRate * 100
    ).toFixed(1)}%`
  );
}

function computeStats({ trades, initialCapital, finalEquity, equityCurve, elapsedMs }) {
  const totalTrades = trades.length;
  const wins = trades.filter((t) => t.pnl > 0).length;
  const losses = trades.filter((t) => t.pnl <= 0).length;
  const totalPnL = finalEquity - initialCapital;
  const winRate = totalTrades > 0 ? wins / totalTrades : 0;
  const avgWin =
    wins > 0
      ? trades.filter((t) => t.pnl > 0).reduce((a, t) => a + t.pnl, 0) / wins
      : 0;
  const avgLoss =
    losses > 0
      ? trades.filter((t) => t.pnl <= 0).reduce((a, t) => a + t.pnl, 0) / losses
      : 0;
  const profitFactor =
    Math.abs(avgLoss) > 0
      ? Math.abs((avgWin * wins) / (avgLoss * losses))
      : avgWin > 0
      ? Infinity
      : 0;

  // 最大回撤
  let peak = -Infinity;
  let maxDD = 0;
  for (const e of equityCurve) {
    if (e.equity > peak) peak = e.equity;
    const dd = peak > 0 ? (peak - e.equity) / peak : 0;
    if (dd > maxDD) maxDD = dd;
  }

  // 月度统计
  const monthly = {};
  for (const t of trades) {
    const key = formatMs(t.close_ts, 'YYYY-MM');
    if (!monthly[key]) monthly[key] = { pnl: 0, count: 0, wins: 0 };
    monthly[key].pnl += t.pnl;
    monthly[key].count += 1;
    if (t.pnl > 0) monthly[key].wins += 1;
  }

  return {
    initialCapital,
    finalEquity,
    totalPnL,
    totalReturn: totalPnL / initialCapital,
    totalTrades,
    wins,
    losses,
    winRate,
    avgWin,
    avgLoss,
    profitFactor,
    maxDrawdown: maxDD,
    monthly,
    elapsedMs,
  };
}

module.exports = {
  startBacktest,
  listTasks,
  getTask,
};
