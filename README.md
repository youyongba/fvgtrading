# FVG 量化交易系统（BTC/USDT 永续）

基于 Express.js 的 BTC/USDT 永续合约自动化量化交易系统，支持 **实盘交易**（通过 Webhook 转发）与 **历史回测**，核心交易逻辑两种模式完全一致。

## 特性

- **6 种 FVG 信号**：陷阱多/支撑多/突破追多 + 陷阱空/阻力空/突破追空
- **东八区时间统一**：所有日志、Webhook、通知、回测时间轴均为 UTC+8
- **零延迟交易 Webhook**：使用 Node 原生 `https.request`，fire-and-forget 发送
- **飞书异步通知**：HmacSHA256 签名，`setImmediate` 排队，绝不阻塞交易
- **防重复开仓**：`riskManager` 在 `signalScanner` 之前进行状态校验
- **风控**：连续亏损暂停 1 小时、日内亏损上限、单笔风险限制
- **PWA 移动端**：暗色全屏、Service Worker、可加入主屏

## 目录结构

```
fvgtrading/
├── package.json
├── .env.example
├── .env
├── src/
│   ├── server.js                  Express 入口
│   ├── config.js                  环境变量加载
│   ├── utils/
│   │   ├── timeUtil.js            东八区时间工具
│   │   ├── logger.js              彩色 + 落盘日志
│   │   └── db.js                  SQLite (better-sqlite3)
│   ├── modules/
│   │   ├── dataEngine.js          ccxt 拉取 K 线 + VWAP/ATR/FVG
│   │   ├── signalScanner.js       6 种信号 + TP/SL 计算
│   │   ├── riskManager.js         防重复开仓 + 连亏 + 日亏控制
│   │   ├── webhookExecutor.js     交易 Webhook + 飞书签名通知
│   │   ├── binanceWs.js           markPrice 实时引擎（50ms 内决策）
│   │   └── backtestEngine.js      回测引擎（与实盘共用核心逻辑）
│   └── scripts/
│       └── runBacktest.js         CLI 回测
└── public/                         PWA 前端
    ├── dashboard.html / app.js
    ├── backtest.html / backtest.js
    ├── styles.css
    ├── manifest.json
    ├── sw.js
    └── icons/icon.svg
```

## 快速开始

```bash
cd fvgtrading
cp .env.example .env       # 已包含项目所需的默认值
npm install
npm start
```

打开浏览器访问：

- 实盘监控：<http://localhost:3000/>
- 历史回测：<http://localhost:3000/backtest>

点击实盘页面的「启动」按钮即可订阅币安 markPrice 流并开始扫描信号；
首次启动会先拉取 1H/15m 历史 K 线计算指标（约几秒）。

## 核心 API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET  | `/api/status` | 系统状态、持仓、风控 |
| GET  | `/api/trades?limit=N` | 最近交易日志 |
| POST | `/api/start` | 启动实盘 |
| POST | `/api/stop`  | 停止实盘 |
| POST | `/api/backtest/start` | `{startDate,endDate,initialCapital?,feeRate?}` |
| GET  | `/api/backtest/status/:taskId` | 进度 |
| GET  | `/api/backtest/result/:taskId` | 完整结果（含交易、净值曲线、月度统计） |
| GET  | `/api/backtest/list` | 历史任务列表 |

## 关键实现说明

### 1. Webhook 零延迟

`webhookExecutor.fireTradeWebhook(ev)` 在调用栈中第一时间通过 `fastPostJson()` 把 JSON 写入 TCP socket，仅之后才用 `setImmediate` 排队飞书通知与数据库写入。任何持仓 TP/SL 命中均在 `binanceWs.onPriceTick` 的 50ms 预算内完成。

### 2. 飞书签名

```js
sign = base64( HmacSHA256( `${timestamp}\n${secret}`, '') )
```

签名计算无网络开销，可在异步路径中安全执行。

### 3. 防重复开仓

`riskManager.canOpen(direction, ts)` 在任何信号触发开仓前必须返回 `{ ok: true }`；`closePosition({pnl})` 平仓后才会重置 `currentPosition` 为 null，从源头杜绝同方向重复开仓。

### 4. 实盘 / 回测共用

`signalScanner.scanSignals(ctx)` 接收纯参数 `{ k15, vwap, activeFvgs }`，对实盘的"刚收盘 15m K 线"和回测中的"遍历到的 15m K 线"使用完全相同的逻辑。`computeTakeProfit / computeStopLoss` 同理。

### 5. 时间统一

`utils/timeUtil.js` 集中处理 dayjs Asia/Shanghai 转换，包括 VWAP 自然日重置、`startOfDayCN` 日切判定、所有展示用字符串。

## 飞书机器人配置

在飞书机器人「安全设置」→「签名校验」中填入 `.env` 里的 `FEISHU_WEBHOOK_SECRET`，与本项目签名实现保持一致即可。

## 风险声明

本仓库为示例工程，**不构成投资建议**。实盘前请充分回测、纸交易并自行承担风险。
