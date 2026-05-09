/**
 * riskManager - 风险控制
 * --------------------------------------------
 * 职责：
 *  1. 防重复开仓：通过 currentPosition 状态控制同一时刻只持有一个方向
 *  2. 连续亏损达到 MAX_CONSECUTIVE_LOSSES → 暂停 1 小时
 *  3. 日内累计亏损达到 MAX_DAILY_LOSS%（以本金计） → 当日停止
 *  4. 日切以东八区 0 点为界
 *
 * 该模块同时被实盘 binanceWs 与 backtestEngine 复用，
 * 实盘使用 createRiskManager() 生成单例；回测使用独立实例避免状态污染。
 *
 * 重要：开仓前必须调用 canOpen(direction)，平仓后必须调用 closePosition({pnl})。
 */
const config = require('../config');
const { startOfDayCN, nowMs } = require('../utils/timeUtil');

function createRiskManager({
  initialCapital,
  maxConsecutiveLosses = config.maxConsecutiveLosses,
  maxDailyLossPct = config.maxDailyLoss,
} = {}) {
  const state = {
    currentPosition: null, // null | 'long' | 'short'
    openedAt: null,
    consecutiveLosses: 0,
    pauseUntil: 0, // Unix ms，连亏暂停至此时间
    dailyAnchor: startOfDayCN(nowMs()), // 当前东八区"自然日"起点 ms
    dailyPnL: 0, // 当日累计 PnL（以货币计）
    capital: initialCapital || 1, // 本金（实盘使用 1 表示按比例计算，回测传入实际值）
    dailyHaltedDay: 0, // 已停盘的"自然日"
  };

  function rollDayIfNeeded(ts = nowMs()) {
    const today = startOfDayCN(ts);
    if (today !== state.dailyAnchor) {
      state.dailyAnchor = today;
      state.dailyPnL = 0;
      // 注意：跨日不清空连亏（连亏是跨自然日的连续亏损序列）
    }
  }

  /**
   * 是否可以开新仓
   * @param {'long'|'short'} _direction
   * @param {number} ts 当前时间 ms（回测中传入 K 线时间；实盘传 nowMs）
   * @returns {{ok:boolean, reason?:string}}
   */
  function canOpen(_direction, ts = nowMs()) {
    rollDayIfNeeded(ts);

    // 1) 防重复开仓（最关键）
    if (state.currentPosition !== null) {
      return { ok: false, reason: 'duplicate_position' };
    }
    // 2) 连亏暂停
    if (state.pauseUntil && ts < state.pauseUntil) {
      return { ok: false, reason: 'pause_after_losses' };
    }
    // 3) 日亏限制
    const dailyLossPct = (state.dailyPnL / state.capital) * 100;
    if (dailyLossPct <= -maxDailyLossPct) {
      return { ok: false, reason: 'daily_loss_limit' };
    }
    return { ok: true };
  }

  /**
   * 标记一笔仓位已开
   */
  function openPosition(direction, ts = nowMs()) {
    state.currentPosition = direction;
    state.openedAt = ts;
  }

  /**
   * 标记一笔仓位已平
   * @param {{pnl:number, ts?:number}} info pnl 为本笔盈亏（货币）
   */
  function closePosition({ pnl = 0, ts = nowMs() } = {}) {
    rollDayIfNeeded(ts);
    state.dailyPnL += pnl;
    if (pnl < 0) {
      state.consecutiveLosses += 1;
      if (state.consecutiveLosses >= maxConsecutiveLosses) {
        // 连亏触发暂停：暂停 1 小时
        state.pauseUntil = ts + 60 * 60 * 1000;
        state.consecutiveLosses = 0; // 触发后清零，避免反复触发
      }
    } else if (pnl > 0) {
      state.consecutiveLosses = 0;
    }
    state.currentPosition = null;
    state.openedAt = null;
  }

  /** 强制重置（用于热重启） */
  function reset() {
    state.currentPosition = null;
    state.openedAt = null;
    state.consecutiveLosses = 0;
    state.pauseUntil = 0;
    state.dailyAnchor = startOfDayCN(nowMs());
    state.dailyPnL = 0;
  }

  function snapshot() {
    return { ...state };
  }

  return {
    canOpen,
    openPosition,
    closePosition,
    reset,
    snapshot,
    state,
  };
}

// 实盘单例（默认资金为 1，仅用于按比例判断风险阈值；
// 回测中应使用 createRiskManager({ initialCapital }) 独立实例）
const liveRisk = createRiskManager({ initialCapital: 1 });

module.exports = {
  createRiskManager,
  liveRisk,
};
