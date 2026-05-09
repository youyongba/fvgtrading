/**
 * 全局配置加载
 * --------------------------------------------
 * 通过 dotenv 读取 .env，并对所有数值型环境变量做合理默认值兜底。
 * 暴露统一的 config 对象供整个项目共享。
 */
require('dotenv').config();

const num = (val, def) => {
  const n = Number(val);
  return Number.isFinite(n) ? n : def;
};

const config = {
  // 币安 WebSocket
  binanceWsBase: process.env.BINANCE_WS_BASE || 'wss://fstream.binance.com/ws',
  binanceWsHandshakeMs: num(process.env.BINANCE_WS_HANDSHAKE_MS, 20000),
  // 实际订阅地址：默认使用 combined stream（更稳定）
  // 单流 `/ws/<name>` 在某些机房会握手成功但不推数据 → 已验证 combined 才是可靠形式
  // 如需手动覆盖整个 URL，在 .env 设置 BINANCE_WS_URL
  binanceWsUrl:
    process.env.BINANCE_WS_URL ||
    'wss://fstream.binance.com/stream?streams=btcusdt@markPrice@1s',

  // 交易 Webhook
  webhookUrl:
    process.env.WEBHOOK_URL ||
    'https://trading.24os.cn/webhook/wh_d113d9b4d838dbd635d4c19c3f0c51d9',
  // Webhook token：从 URL 中截取（用于 JSON body 字段）
  webhookToken: (() => {
    const url = process.env.WEBHOOK_URL || '';
    const m = url.match(/\/(wh_[a-zA-Z0-9]+)$/);
    return m ? m[1] : 'wh_d113d9b4d838dbd635d4c19c3f0c51d9';
  })(),

  // 飞书
  feishuWebhookUrl: process.env.FEISHU_WEBHOOK_URL || '',
  feishuWebhookSecret: process.env.FEISHU_WEBHOOK_SECRET || '',

  // 交易参数
  positionSize: num(process.env.POSITION_SIZE, 3),
  leverage: num(process.env.LEVERAGE, 100),
  maxRiskPerTrade: num(process.env.MAX_RISK_PER_TRADE, 2),
  maxDailyLoss: num(process.env.MAX_DAILY_LOSS, 6),
  maxConsecutiveLosses: num(process.env.MAX_CONSECUTIVE_LOSSES, 3),

  // 服务器
  port: num(process.env.PORT, 3000),

  // 回测
  backtestInitialCapital: num(process.env.BACKTEST_INITIAL_CAPITAL, 10000),
  backtestFeeRate: num(process.env.BACKTEST_FEE_RATE, 0.0004),

  // 交易标的
  symbol: 'BTCUSDT',
  ccxtSymbol: 'BTC/USDT:USDT', // ccxt 永续合约符号

  // 网络
  ccxtTimeoutMs: num(process.env.CCXT_TIMEOUT_MS, 60000),
  // 代理：如 http://127.0.0.1:7890
  // 国内网络访问 fapi.binance.com 不稳时，可在 .env 中配置
  httpsProxy:
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    '',
  httpProxy: process.env.HTTP_PROXY || process.env.http_proxy || '',
};

module.exports = config;
