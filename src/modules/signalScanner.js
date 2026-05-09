/**
 * signalScanner - 6 种信号识别（实盘与回测共用）
 * --------------------------------------------
 *  背景：1H VWAP 之上 = 多头背景；之下 = 空头背景
 *
 *  6 种信号触发条件（全部以 15m 实体收盘价为准，影线刺穿不算）：
 *
 *  陷阱信号（反转 / 与 VWAP 背景无关）：
 *    1) 陷阱多 : 看涨 FVG，low <= c1Low && close > c1Low
 *               （影线下穿 C1 最低，实体收回上方）
 *    2) 陷阱空 : 看跌 FVG，high >= c1High && close < c1High
 *               （影线上穿 C1 最高，实体收回下方）
 *
 *  VWAP 信号（顺势 / 受 VWAP 背景门控）：
 *    3) 支撑多 : low <= vwap && close > vwap   （仅多头背景）
 *    4) 阻力空 : high >= vwap && close < vwap （仅空头背景）
 *
 *  突破信号（顺势 / 受 VWAP 背景门控 / 用 prevClose 判方向）：
 *    5) 突破追多 : 看跌 FVG，prevClose <= c1High && close > c1High （仅多头背景）
 *    6) 突破追空 : 看涨 FVG，prevClose >= c1Low && close < c1Low   （仅空头背景）
 *
 *  优先级（同根 K 线只取一个信号）：陷阱 > VWAP > 突破
 *  —— 陷阱信号最稀缺、风报比最好，优先；突破是最次的顺势信号。
 *
 *  ★ 关键设计：陷阱信号无视 VWAP 背景
 *  规范 6.3 写"仅空头背景触发"，但 SMC 实战中"涨到 1H 看跌 FVG C1 高点 + 跌回"
 *  这种反转陷阱本身就是反转信号，强行用 VWAP 门控会丢失关键信号。所以陷阱多/空
 *  独立于 VWAP 触发；VWAP/突破信号才走背景门控。
 *
 *  ★ 关键设计：突破信号用 prevClose 判方向
 *  原本 open <= c1High 判定会漏 gap up；改用"上一根 15m close <= c1High"判，
 *  既覆盖 gap up，也保证不会重复触发（一旦突破上去，prevClose 就 > c1High 了）。
 *
 *  ★ FVG 列表来源
 *  必须用 dataEngine.formedFvgsAt（仅按"已形成"过滤，不做 close 失效）。
 *  不要用 activeFvgsAt —— 它的失效过滤会把"先突破后反转回踩"的陷阱空 FVG 错误剔除。
 *
 *  返回 null 或 { name, direction, entry, stopLossStruct, fvg, vwap, ts, reason }
 *  最终止损由 computeStopLoss 结合 1.5*ATR / 风险硬上限 / minStopPct 综合得出。
 */

/**
 * @param {object} ctx
 * @param {Array}  ctx.k15        当前 15m K 线 [ts, open, high, low, close, vol]
 * @param {number} [ctx.prevClose] 上一根 15m K 线收盘价，用于突破信号（gap up/down 也覆盖、防重复）
 * @param {number} ctx.vwap       当前 1H VWAP（与 k15 收盘时刻对齐）
 * @param {object} ctx.activeFvgs { bullish:[], bearish:[] } 来自 formedFvgsAt，按形成时间倒序
 * @returns {null | {name,direction,entry,stopLossStruct,fvg,vwap,ts,reason}}
 */
function scanSignals(ctx) {
  const { k15, prevClose = null, vwap, activeFvgs } = ctx;
  if (!k15 || vwap == null) return null;
  const [ts, , high, low, close] = k15;
  const isBull = close > vwap; // 多头背景
  const isBear = close < vwap; // 空头背景

  // ============================================================
  // 优先级 1：陷阱信号（反转 / 无视 VWAP 背景）
  // ============================================================

  // 1) 陷阱多：看涨 FVG，影线刺穿 C1 最低 + 实体收回上方
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

  // 2) 陷阱空：看跌 FVG，影线刺穿 C1 最高 + 实体跌回下方
  for (const f of activeFvgs.bearish) {
    if (high >= f.c1High && close < f.c1High) {
      return signal({
        name: '陷阱空',
        direction: 'short',
        entry: close,
        stopLossStruct: high, // 假突破最高点
        fvg: f,
        vwap,
        ts,
        reason: '15m实体跌回1H看跌FVG C1最高点下方',
      });
    }
  }

  // ============================================================
  // 优先级 2：VWAP 信号（顺势 / 受 VWAP 背景门控）
  // ============================================================

  // 3) 支撑多：刺穿 VWAP 后实体收回（仅多头背景）
  if (isBull && low <= vwap && close > vwap) {
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

  // 4) 阻力空：刺穿 VWAP 后实体跌回（仅空头背景）
  if (isBear && high >= vwap && close < vwap) {
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

  // ============================================================
  // 优先级 3：突破信号（顺势 / VWAP 背景 + prevClose 判突破方向）
  // ============================================================

  // 5) 突破追多：上一根 close 在 c1.high 下方，当根 close 站上（仅多头背景）
  if (isBull && prevClose != null) {
    for (const f of activeFvgs.bearish) {
      if (prevClose <= f.c1High && close > f.c1High) {
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

  // 6) 突破追空：上一根 close 在 c1.low 上方，当根 close 跌穿（仅空头背景）
  if (isBear && prevClose != null) {
    for (const f of activeFvgs.bullish) {
      if (prevClose >= f.c1Low && close < f.c1Low) {
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
