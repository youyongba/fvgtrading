/**
 * webhookExecutor - 交易 Webhook 与飞书通知
 * --------------------------------------------
 * 设计原则（极重要）：
 *   1. 交易 Webhook 必须在"当前事件循环"立即触发，不等待任何 I/O
 *   2. 飞书通知必须异步执行（setImmediate），即使飞书完全失败也绝不阻塞交易
 *   3. 落库（trades 表）也通过 setImmediate 排队，避免抢占 Webhook 发送时机
 *
 * 实现：
 *   - 使用 Node 内置 https.request 而非 axios，省去封装开销
 *   - 不使用 await：fire-and-forget；返回 socket 写完即视为已发出
 *   - 飞书签名校验：HmacSHA256(timestamp + "\n" + secret) base64
 */
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');

const config = require('../config');
const logger = require('../utils/logger');
const { formatMs, nowMs } = require('../utils/timeUtil');
const db = require('../utils/db');

/**
 * 极速 POST JSON：fire-and-forget，立即返回。
 * 不使用 Promise 等待结果，确保不阻塞主流程。
 */
function fastPostJson(urlStr, body) {
  try {
    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? https : http;
    const data = Buffer.from(JSON.stringify(body));
    const req = lib.request(
      {
        method: 'POST',
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + (u.search || ''),
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': data.length,
        },
        // 关键：握手与首字节超时较短，避免上游卡死阻塞 socket
        timeout: 5000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          // 仅作日志，不影响主路径
          if (res.statusCode >= 200 && res.statusCode < 300) {
            logger.ok(
              `webhook 200 ${u.host}${u.pathname} ${Buffer.concat(
                chunks
              ).toString('utf8').slice(0, 200)}`
            );
          } else {
            logger.warn(
              `webhook ${res.statusCode} ${u.host}${u.pathname} ${Buffer.concat(
                chunks
              ).toString('utf8').slice(0, 200)}`
            );
          }
        });
      }
    );
    req.on('error', (err) => logger.error('webhook err:', err.message));
    req.on('timeout', () => req.destroy(new Error('timeout')));
    // 立即写入 + end，触发 TCP 发送
    req.write(data);
    req.end();
  } catch (err) {
    logger.error('webhook fatal:', err.message);
  }
}

/**
 * 构造交易 Webhook payload
 */
function buildPayload({ action, direction, signal, trigger, entryIndex }) {
  const ts = nowMs(); // 东八区当前 Unix 毫秒（绝对时间，与时区无关）
  const base = {
    token: config.webhookToken,
    symbol: config.symbol,
    timestamp: String(ts),
  };
  if (action === 'open_long' || action === 'open_short') {
    return {
      ...base,
      action,
      leverage: config.leverage,
      position_size: `${config.positionSize}%`,
      order_type: 'market',
      entry_index: entryIndex || 1,
    };
  }
  // 平仓（止盈 / 止损）
  return {
    ...base,
    action, // take_profit / stop_loss
    direction, // long / short
    close_percent: '100%',
    order_type: 'market',
    trigger, // tp_4 / sl
  };
}

/**
 * ========== 对外 API ==========
 * 立即发送交易 Webhook，并异步排队飞书通知 + 落库。
 *
 * @param {object} ev
 * @param {'open_long'|'open_short'|'take_profit'|'stop_loss'} ev.action
 * @param {'long'|'short'} ev.direction
 * @param {string} [ev.signal]
 * @param {string} [ev.trigger]   tp_4 / sl
 * @param {number} ev.price       触发价（仅用于通知/日志）
 * @param {string} [ev.note]
 */
function fireTradeWebhook(ev) {
  const ts = nowMs();
  const payload = buildPayload({
    action: ev.action,
    direction: ev.direction,
    signal: ev.signal,
    trigger: ev.trigger,
    entryIndex: ev.entryIndex,
  });

  // 1) ★ 第一时间发送交易 Webhook（同步进入 socket 写队列）
  fastPostJson(config.webhookUrl, payload);

  // 2) 异步：飞书通知（不阻塞）
  setImmediate(() => {
    try {
      sendFeishuTradeMessage(ev, ts);
    } catch (e) {
      logger.error('feishu schedule error:', e.message);
    }
  });

  // 3) 异步：落库
  setImmediate(() => {
    try {
      db.prepare(
        `INSERT INTO trades (ts_ms, ts_cn, action, direction, signal, price, trigger, note, payload)
         VALUES (?,?,?,?,?,?,?,?,?)`
      ).run(
        ts,
        formatMs(ts),
        ev.action,
        ev.direction || null,
        ev.signal || null,
        ev.price || null,
        ev.trigger || null,
        ev.note || null,
        JSON.stringify(payload)
      );
    } catch (e) {
      logger.error('db insert trade error:', e.message);
    }
  });

  logger.trade(
    `${ev.action} ${ev.direction || ''} @${ev.price ?? '-'} signal=${
      ev.signal || '-'
    }`
  );
}

/**
 * 飞书签名（自定义机器人安全设置）
 * 算法：base64( HmacSHA256( timestampSec + "\n" + secret, "" ) )
 */
function feishuSign(timestampSec, secret) {
  const stringToSign = `${timestampSec}\n${secret}`;
  return crypto
    .createHmac('sha256', stringToSign)
    .update('')
    .digest('base64');
}

/**
 * 发送飞书文本消息（异步）
 */
function sendFeishuTradeMessage(ev, ts) {
  if (!config.feishuWebhookUrl) return;
  const dirCN =
    ev.direction === 'long' ? '做多' : ev.direction === 'short' ? '做空' : '-';
  const actionCN = {
    open_long: '开仓',
    open_short: '开仓',
    take_profit: '止盈平仓',
    stop_loss: '止损平仓',
  }[ev.action] || ev.action;

  const text =
    `【交易信号】\n` +
    `方向：${dirCN}\n` +
    `动作：${actionCN}\n` +
    `品种：${config.symbol}\n` +
    `价格：${formatPrice(ev.price)}\n` +
    `时间：${formatMs(ts)}（东八区）\n` +
    `备注：${ev.note || ev.signal || '-'}`;

  const timestampSec = String(Math.floor(ts / 1000));
  const body = {
    timestamp: timestampSec,
    sign: feishuSign(timestampSec, config.feishuWebhookSecret),
    msg_type: 'text',
    content: { text },
  };
  fastPostJson(config.feishuWebhookUrl, body);
}

function formatPrice(p) {
  if (p == null) return '-';
  return Number(p).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

module.exports = {
  fireTradeWebhook,
  sendFeishuTradeMessage,
  feishuSign,
  fastPostJson,
};
