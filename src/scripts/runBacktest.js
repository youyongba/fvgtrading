/**
 * 命令行回测入口
 *   node src/scripts/runBacktest.js 2026-01-01 2026-05-01
 */
const { startBacktest, getTask } = require('../modules/backtestEngine');
const logger = require('../utils/logger');

const [, , startDate, endDate] = process.argv;
if (!startDate || !endDate) {
  console.log('Usage: node src/scripts/runBacktest.js YYYY-MM-DD YYYY-MM-DD');
  process.exit(1);
}

const id = startBacktest({ startDate, endDate });
logger.info('回测任务 ID:', id);

const timer = setInterval(() => {
  const t = getTask(id);
  if (!t) return;
  logger.info(`status=${t.status} progress=${Math.round(t.progress)}%`);
  if (t.status === 'done' || t.status === 'error') {
    clearInterval(timer);
    if (t.status === 'done') {
      logger.ok('result:', t.result);
    } else {
      logger.error('error:', t.error);
    }
    process.exit(0);
  }
}, 2000);
