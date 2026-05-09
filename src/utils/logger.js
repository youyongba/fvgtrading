/**
 * 简洁日志模块
 * --------------------------------------------
 * - 控制台彩色输出，附带东八区时间戳
 * - 同步落盘到 logs/app.log（按天切分）
 * - 不引入重型依赖，避免影响实时交易主循环性能
 */
const fs = require('fs');
const path = require('path');
const { formatNow } = require('./timeUtil');

const LOG_DIR = path.join(__dirname, '..', '..', 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

const COLORS = {
  reset: '\x1b[0m',
  gray: '\x1b[90m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
};

function logFile() {
  const day = formatNow('YYYY-MM-DD');
  return path.join(LOG_DIR, `app-${day}.log`);
}

function write(level, color, args) {
  const ts = formatNow();
  const text = args
    .map((a) => (typeof a === 'string' ? a : safeStringify(a)))
    .join(' ');
  const line = `[${ts}] [${level}] ${text}`;
  // 控制台
  // eslint-disable-next-line no-console
  console.log(`${color}${line}${COLORS.reset}`);
  // 落盘（同步追加，对量级低足够；如压力大再换异步流）
  try {
    fs.appendFileSync(logFile(), line + '\n');
  } catch (_) {
    // 落盘失败不影响主流程
  }
}

function safeStringify(obj) {
  try {
    return JSON.stringify(obj);
  } catch {
    return String(obj);
  }
}

const logger = {
  info: (...args) => write('INFO', COLORS.cyan, args),
  ok: (...args) => write('OK ', COLORS.green, args),
  warn: (...args) => write('WARN', COLORS.yellow, args),
  error: (...args) => write('ERR ', COLORS.red, args),
  trade: (...args) => write('TRD', COLORS.magenta, args),
  debug: (...args) => write('DBG', COLORS.gray, args),
};

module.exports = logger;
