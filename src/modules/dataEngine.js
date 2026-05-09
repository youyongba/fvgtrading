/**
 * dataEngine - K线获取与指标计算
 * --------------------------------------------
 * 提供：
 *  - fetchOHLCV(timeframe, since, limit)   通过 ccxt 拉取币安永续 K 线
 *  - computeVWAP(klines)                   1H VWAP（按东八区自然日重置）
 *  - computeATR(klines, period)            ATR(N)
 *  - findFVGs(klines)                      识别 FVG，返回 {bullish[], bearish[]}
 *
 * K 线格式：[ ts(ms), open, high, low, close, volume ]
 *
 * FVG 定义（三根 K 线 c1,c2,c3）：
 *   - 看涨 FVG: c1.high < c3.low  → 形成上行缺口；C1 最低点 = c1.low
 *   - 看跌 FVG: c1.low  > c3.high → 形成下行缺口；C1 最高点 = c1.high
 *   FVG 在 1H 周期识别，"C1 点" 始终指向第一根 K 线。
 *
 * 注意：本模块不涉及任何时区展示逻辑，时间戳一律保留 Unix 毫秒。
 */
const ccxt = require('ccxt');
const { startOfDayCN } = require('../utils/timeUtil');

const exchange = new ccxt.binanceusdm({
  enableRateLimit: true,
  options: { defaultType: 'future' },
});

/**
 * 拉取 K 线
 * @param {string} symbol  例如 'BTC/USDT:USDT'
 * @param {string} timeframe  '15m' | '1h'
 * @param {number} since   起始 ms
 * @param {number} limit   每批最多 1500
 */
async function fetchOHLCV(symbol, timeframe, since, limit = 1500) {
  return exchange.fetchOHLCV(symbol, timeframe, since, limit);
}

/**
 * 分页拉取一段时间内的全部 K 线
 */
async function fetchOHLCVRange(symbol, timeframe, sinceMs, untilMs) {
  const tfMs = exchange.parseTimeframe(timeframe) * 1000;
  let cursor = sinceMs;
  const out = [];
  while (cursor < untilMs) {
    const batch = await fetchOHLCV(symbol, timeframe, cursor, 1500);
    if (!batch || batch.length === 0) break;
    for (const k of batch) {
      if (k[0] >= untilMs) break;
      out.push(k);
    }
    const last = batch[batch.length - 1][0];
    if (last + tfMs <= cursor) break; // 防止死循环
    cursor = last + tfMs;
    // 简单限速
    await new Promise((r) => setTimeout(r, exchange.rateLimit));
  }
  return out;
}

/**
 * 计算 1H VWAP（按"东八区自然日"重置）
 * @param {Array} klines1h
 * @returns {Array<{ts:number, vwap:number}>}
 */
function computeVWAP(klines1h) {
  const out = [];
  let curDay = null;
  let cumPV = 0;
  let cumV = 0;
  for (const k of klines1h) {
    const [ts, , high, low, close, vol] = k;
    const day = startOfDayCN(ts);
    if (day !== curDay) {
      curDay = day;
      cumPV = 0;
      cumV = 0;
    }
    const tp = (high + low + close) / 3;
    cumPV += tp * vol;
    cumV += vol;
    const vwap = cumV > 0 ? cumPV / cumV : close;
    out.push({ ts, vwap });
  }
  return out;
}

/**
 * 取某 ts 对应的 1H VWAP（向前查找最近的 1H K 线对应值）
 */
function vwapAt(vwapArr, ts) {
  // 二分查找小于等于 ts 的最后一个
  let lo = 0;
  let hi = vwapArr.length - 1;
  let res = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (vwapArr[mid].ts <= ts) {
      res = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return res >= 0 ? vwapArr[res].vwap : null;
}

/**
 * 计算 ATR（基于 1H K 线）
 * @param {Array} klines1h
 * @param {number} period 默认 14
 * @returns {Array<{ts:number, atr:number}>}
 */
function computeATR(klines1h, period = 14) {
  const out = [];
  const trs = [];
  for (let i = 0; i < klines1h.length; i++) {
    const [ts, , high, low, close] = klines1h[i];
    let tr;
    if (i === 0) {
      tr = high - low;
    } else {
      const prevClose = klines1h[i - 1][4];
      tr = Math.max(
        high - low,
        Math.abs(high - prevClose),
        Math.abs(low - prevClose)
      );
    }
    trs.push(tr);
    if (i + 1 < period) {
      out.push({ ts, atr: null });
    } else if (i + 1 === period) {
      const sum = trs.slice(0, period).reduce((a, b) => a + b, 0);
      out.push({ ts, atr: sum / period });
    } else {
      const prev = out[out.length - 1].atr;
      const atr = (prev * (period - 1) + tr) / period;
      out.push({ ts, atr });
    }
  }
  return out;
}

/**
 * 取某 ts 对应的最新 ATR
 */
function atrAt(atrArr, ts) {
  let lo = 0;
  let hi = atrArr.length - 1;
  let res = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (atrArr[mid].ts <= ts) {
      res = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return res >= 0 ? atrArr[res].atr : null;
}

/**
 * FVG 识别（基于 1H K 线）
 * 返回每个 FVG 携带：
 *   { type: 'bull'|'bear', tsC1, c1Low, c1High, c3Low, c3High, gapLow, gapHigh, filled }
 * filled 表示是否被后续 K 线完全填补（用于回测时减少候选）
 *
 * 看涨 FVG: c1.high < c3.low
 *   缺口区间: [c1.high, c3.low]
 *   被填补判断: 后续某根 K 线 close <= c1.high
 * 看跌 FVG: c1.low  > c3.high
 *   缺口区间: [c3.high, c1.low]
 *   被填补判断: 后续某根 K 线 close >= c1.low
 */
function findFVGs(klines1h) {
  const bullish = [];
  const bearish = [];
  for (let i = 2; i < klines1h.length; i++) {
    const c1 = klines1h[i - 2];
    const c3 = klines1h[i];
    const [tsC1, , c1High, c1Low] = c1;
    const [, , c3High, c3Low] = c3;
    if (c1High < c3Low) {
      bullish.push({
        type: 'bull',
        tsC1,
        c1Low,
        c1High,
        c3Low,
        c3High,
        gapLow: c1High,
        gapHigh: c3Low,
      });
    } else if (c1Low > c3High) {
      bearish.push({
        type: 'bear',
        tsC1,
        c1Low,
        c1High,
        c3Low,
        c3High,
        gapLow: c3High,
        gapHigh: c1Low,
      });
    }
  }
  return { bullish, bearish };
}

/**
 * 取在某 ts 之前形成、且尚未被填补的所有 FVG（按形成时间倒序）
 * @param {object} fvgs {bullish,bearish}
 * @param {number} ts
 * @param {Array} klines1h 用于判断"是否已被填补"
 */
function activeFvgsAt(fvgs, ts, klines1h) {
  const isFilled = (fvg) => {
    for (const k of klines1h) {
      if (k[0] <= fvg.tsC1) continue;
      if (k[0] > ts) break;
      const close = k[4];
      if (fvg.type === 'bull' && close <= fvg.c1High) return true;
      if (fvg.type === 'bear' && close >= fvg.c1Low) return true;
    }
    return false;
  };
  const filterAlive = (arr) =>
    arr
      .filter((f) => f.tsC1 < ts && !isFilled(f))
      .sort((a, b) => b.tsC1 - a.tsC1);
  return {
    bullish: filterAlive(fvgs.bullish),
    bearish: filterAlive(fvgs.bearish),
  };
}

module.exports = {
  exchange,
  fetchOHLCV,
  fetchOHLCVRange,
  computeVWAP,
  vwapAt,
  computeATR,
  atrAt,
  findFVGs,
  activeFvgsAt,
};
