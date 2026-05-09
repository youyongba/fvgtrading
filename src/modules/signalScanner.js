/**
 * signalScanner - 6 种信号识别（实盘与回测共用）
 * --------------------------------------------
 *  背景：1H VWAP 之上 = 多头背景；之下 = 空头背景
 *
 *  做多信号（仅多头背景触发）：
 *    1) 陷阱多   : 价格向下刺穿 1H 看涨 FVG 的 C1 最低点，
 *                 随后 15m 实体收盘"站回"该 C1 最低点上方
 *                 (close > c1Low && low <= c1Low)
 *    2) 支撑多   : 15m 期间最低价向下刺穿 1H VWAP，
 *                 收盘站回 VWAP 上方
 *                 (close > vwap && low <= vwap)
 *    3) 突破追多 : 价格到达 1H 看跌 FVG 附近，
 *                 15m 实体收盘"站上"该看跌 FVG 的 C1 最高点
 *                 (close > c1High && open <= c1High)
 *
 *  做空信号（仅空头背景触发）：
 *    4) 陷阱空   : (close < c1High && high >= c1High) 1H 看跌 FVG 的 C1 最高点
 *    5) 阻力空   : (close < vwap && high >= vwap)
 *    6) 突破追空 : (close < c1Low && open >= c1Low) 1H 看涨 FVG 的 C1 最低点
 *
 *  返回 null 或 { name, direction, entry, stopLossStruct, fvg, vwap }
 *  其中 stopLossStruct 是"结构止损价"，最终止损由 webhookExecutor / backtest 结合 1.5*ATR 限幅。
 *
 *  说明：影线刺穿不算 → 全部以 15m K 线"实体收盘价"判定。
 */

/**
 * @param {object} ctx
 * @param {Array} ctx.k15            当前 15m K 线 [ts, open, high, low, close, vol]
 * @param {number} ctx.vwap          当前 1H VWAP（与 k15 收盘时刻对齐）
 * @param {object} ctx.activeFvgs    { bullish:[], bearish:[] } 在该 K 线时刻仍然活跃的 FVG，按形成时间倒序
 * @returns {null | {name,direction,entry,stopLossStruct,fvg,vwap,reason}}
 */
function scanSignals(ctx) {
  const { k15, vwap, activeFvgs } = ctx;
  if (!k15 || vwap == null) return null;
  const [ts, open, high, low, close] = k15;
  const isBull = close > vwap; // 多头背景
  const isBear = close < vwap; // 空头背景

  // ========== 做多分支 ==========
  if (isBull) {
    // 1) 陷阱多：刺穿最近的看涨 FVG C1 最低点后收回
    for (const f of activeFvgs.bullish) {
      if (low <= f.c1Low && close > f.c1Low) {
        return signal({
          name: '陷阱多',
          direction: 'long',
          entry: close,
          stopLossStruct: low, // 假跌破最低点
          fvg: f,
          vwap,
          ts,
          reason: '15m实体站回1H看涨FVG C1最低点上方',
        });
      }
    }
    // 2) 支撑多：刺穿 VWAP 后收回
    if (low <= vwap && close > vwap) {
      return signal({
        name: '支撑多',
        direction: 'long',
        entry: close,
        stopLossStruct: low,
        fvg: null,
        vwap,
        ts,
        reason: '15m实体站回1H VWAP上方',
      });
    }
    // 3) 突破追多：实体站上看跌 FVG 的 C1 最高点
    for (const f of activeFvgs.bearish) {
      if (open <= f.c1High && close > f.c1High) {
        return signal({
          name: '突破追多',
          direction: 'long',
          entry: close,
          stopLossStruct: f.c1High - (close - f.c1High), // 用突破点下方作结构止损
          fvg: f,
          vwap,
          ts,
          reason: '15m实体站上1H看跌FVG C1最高点追多',
        });
      }
    }
  }

  // ========== 做空分支 ==========
  if (isBear) {
    // 4) 陷阱空
    for (const f of activeFvgs.bearish) {
      if (high >= f.c1High && close < f.c1High) {
        return signal({
          name: '陷阱空',
          direction: 'short',
          entry: close,
          stopLossStruct: high,
          fvg: f,
          vwap,
          ts,
          reason: '15m实体跌回1H看跌FVG C1最高点下方',
        });
      }
    }
    // 5) 阻力空
    if (high >= vwap && close < vwap) {
      return signal({
        name: '阻力空',
        direction: 'short',
        entry: close,
        stopLossStruct: high,
        fvg: null,
        vwap,
        ts,
        reason: '15m实体跌回1H VWAP下方',
      });
    }
    // 6) 突破追空
    for (const f of activeFvgs.bullish) {
      if (open >= f.c1Low && close < f.c1Low) {
        return signal({
          name: '突破追空',
          direction: 'short',
          entry: close,
          stopLossStruct: f.c1Low + (f.c1Low - close),
          fvg: f,
          vwap,
          ts,
          reason: '15m实体跌破1H看涨FVG C1最低点追空',
        });
      }
    }
  }
  return null;
}

function signal(o) {
  return o;
}

/**
 * 计算止盈目标（取最近的目标）
 *
 * 做多止盈：上方最近的 1H 看跌 FVG 的 C1 最高点 / 1H VWAP / 入场价 +0.5%
 * 做空止盈：下方最近的 1H 看涨 FVG 的 C1 最低点 / 1H VWAP / 入场价 -0.5%
 * "最近"指数值上距离入场价最近的目标（取得最近 = 收益最小但触发最快）。
 */
function computeTakeProfit({ direction, entry, vwap, activeFvgs }) {
  const candidates = [];
  if (direction === 'long') {
    // 入场价 +0.5%
    candidates.push({ src: 'entry+0.5%', price: entry * 1.005 });
    if (vwap != null && vwap > entry) {
      candidates.push({ src: '1H_VWAP', price: vwap });
    }
    // 上方最近的看跌 FVG C1 最高点
    const above = activeFvgs.bearish
      .map((f) => f.c1High)
      .filter((p) => p > entry)
      .sort((a, b) => a - b);
    if (above.length) {
      candidates.push({ src: '看跌FVG_C1_high', price: above[0] });
    }
    candidates.sort((a, b) => a.price - b.price); // 取最近（最小）
  } else {
    candidates.push({ src: 'entry-0.5%', price: entry * 0.995 });
    if (vwap != null && vwap < entry) {
      candidates.push({ src: '1H_VWAP', price: vwap });
    }
    const below = activeFvgs.bullish
      .map((f) => f.c1Low)
      .filter((p) => p < entry)
      .sort((a, b) => b - a);
    if (below.length) {
      candidates.push({ src: '看涨FVG_C1_low', price: below[0] });
    }
    candidates.sort((a, b) => b.price - a.price); // 取最近（最大）
  }
  return candidates[0] || null;
}

/**
 * 计算最终止损价：结构止损与 1.5*ATR 中取较近者
 */
function computeStopLoss({ direction, entry, stopLossStruct, atr }) {
  let sl = stopLossStruct;
  if (atr && Number.isFinite(atr)) {
    const atrCap = atr * 1.5;
    const dist = Math.abs(entry - stopLossStruct);
    if (dist > atrCap) {
      sl = direction === 'long' ? entry - atrCap : entry + atrCap;
    }
  }
  return sl;
}

module.exports = {
  scanSignals,
  computeTakeProfit,
  computeStopLoss,
};
