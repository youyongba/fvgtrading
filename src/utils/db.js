/**
 * SQLite 数据访问层
 * --------------------------------------------
 * 表：
 *   trades            - 实盘交易日志
 *   backtest_tasks    - 回测任务（含进度）
 *   backtest_trades   - 单笔回测交易明细
 *   backtest_equity   - 回测净值曲线
 */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'fvgtrading.sqlite'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts_ms INTEGER NOT NULL,                 -- Unix ms (UTC)
  ts_cn TEXT NOT NULL,                    -- 东八区可读
  action TEXT NOT NULL,                   -- open_long / open_short / take_profit / stop_loss
  direction TEXT,                         -- long / short
  signal TEXT,                            -- 信号名称（陷阱多/支撑多 等）
  price REAL,
  trigger TEXT,                           -- tp / sl
  pnl REAL,                               -- 盈亏（结算时）
  note TEXT,
  payload TEXT
);

CREATE TABLE IF NOT EXISTS backtest_tasks (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,                   -- pending / running / done / error
  start_date TEXT NOT NULL,               -- YYYY-MM-DD (东八区)
  end_date TEXT NOT NULL,
  initial_capital REAL,
  fee_rate REAL,
  progress REAL DEFAULT 0,
  result TEXT,                            -- JSON 绩效统计
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS backtest_trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  open_ts INTEGER,
  open_ts_cn TEXT,
  close_ts INTEGER,
  close_ts_cn TEXT,
  direction TEXT,
  signal TEXT,
  entry REAL,
  exit REAL,
  qty REAL,
  pnl REAL,
  pnl_pct REAL,
  exit_reason TEXT,
  fee REAL,
  stop_loss REAL,
  take_profit REAL,
  tp_src TEXT,
  hold_bars INTEGER
);

CREATE TABLE IF NOT EXISTS backtest_equity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  ts INTEGER,
  ts_cn TEXT,
  equity REAL
);

CREATE INDEX IF NOT EXISTS idx_trades_ts ON trades(ts_ms);
CREATE INDEX IF NOT EXISTS idx_btr_task ON backtest_trades(task_id);
CREATE INDEX IF NOT EXISTS idx_bte_task ON backtest_equity(task_id);
`);

// 幂等表迁移：旧版本可能没有这些列，逐个尝试 ALTER（已存在会抛异常忽略即可）
const ensureColumn = (table, col, type) => {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  } catch (_) {
    /* 已存在 */
  }
};
ensureColumn('backtest_trades', 'stop_loss', 'REAL');
ensureColumn('backtest_trades', 'take_profit', 'REAL');
ensureColumn('backtest_trades', 'tp_src', 'TEXT');
ensureColumn('backtest_trades', 'hold_bars', 'INTEGER');

module.exports = db;
