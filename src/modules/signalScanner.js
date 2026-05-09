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
    //    注意：仅要求 close > c1.high；不强制 open <= c1.high（gap up 也算）
    for (const f of activeFvgs.bearish) {
      if (close > f.c1High) {
        return signal({
          name: '突破追多',
          direction: 'long',
          entry: close,
          stopLossStruct: low, // 突破 K 线最低点：跌穿 = 突破失败
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
    // 6) 突破追空：实体跌破看涨 FVG 的 C1 最低点
    //    注意：仅要求 close < c1.low；不强制 open >= c1.low（gap down 也算）
    for (const f of activeFvgs.bullish) {
      if (close < f.c1Low) {
        return signal({
          name: '突破追空',
          direction: 'short',
          entry: close,
          stopLossStruct: high, // 突破 K 线最高点：突上 = 突破失败
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
 * 计算最终止损价
 *  1) 结构止损 vs 1.5×ATR：取较近者（按规范 6.5）
 *  2) 单笔风险硬上限：止损距离 ≤ MAX_RISK_PER_TRADE / (POSITION_SIZE × LEVERAGE) × entry
 *     —— 保证"单笔亏损 ≤ 本金 maxRiskPerTrade%"（规范 6.5 最后一条）
 *  3) 若最终距离 < minStopPct% × entry，则放宽到 minStopPct
 *     —— 防止 SMC 紧止损被微小波动直接打掉
 *
 * 三道闸的作用顺序：
 *   - 结构止损 → 上界限到 1.5×ATR → 上界再限到"风险硬上限" → 下界放宽到 minStopPct
 *   - 当 minStopPct% × positionSize × leverage / 100 > maxRiskPerTrade%（参数冲突）时，
 *     为保证用户的"最小止损距离"意图不被覆盖，minStopPct 优先级高于风险硬上限。
 *
 * @param {object} p
 * @param {'long'|'short'} p.direction
 * @param {number} p.entry            入场价
 * @param {number} p.stopLossStruct   结构止损价
 * @param {number} p.atr              1H ATR(14)
 * @param {number} [p.minStopPct=0]   最小止损距离百分比
 * @param {number} [p.maxRiskPct=0]   单笔最大本金亏损百分比（默认 0 = 不启用硬上限）
 * @param {number} [p.positionSize=0] 仓位百分比
 * @param {number} [p.leverage=1]     杠杆倍数
 */
function computeStopLoss({
  direction,
  entry,
  stopLossStruct,
  atr,
  minStopPct = 0,
  maxRiskPct = 0,
  positionSize = 0,
  leverage = 1,
}) {
  let sl = stopLossStruct;

  // (1) 1.5×ATR 限幅（结构止损过远时收紧到 1.5×ATR）
  if (atr && Number.isFinite(atr)) {
    const atrCap = atr * 1.5;
    const dist = Math.abs(entry - stopLossStruct);
    if (dist > atrCap) {
      sl = direction === 'long' ? entry - atrCap : entry + atrCap;
    }
  }

  // (2) 单笔风险硬上限：止损价格距离 ≤ maxRiskPct / (positionSize × leverage) × entry
  if (maxRiskPct > 0 && positionSize > 0 && leverage > 0) {
    const maxDistPct = maxRiskPct / (positionSize * leverage); // 价格波动百分比上限
    const maxDist = entry * maxDistPct;
    const curDist = Math.abs(entry - sl);
    if (curDist > maxDist) {
      sl = direction === 'long' ? entry - maxDist : entry + maxDist;
    }
  }

  // (3) 最小止损距离保护（最后兜底，防止过紧）
  if (minStopPct > 0) {
    const minDist = entry * (minStopPct / 100);
    const curDist = Math.abs(entry - sl);
    if (curDist < minDist) {
      sl = direction === 'long' ? entry - minDist : entry + minDist;
    }
  }
  return sl;
}

module.exports = {
  scanSignals,
  computeTakeProfit,
  computeStopLoss,
};
