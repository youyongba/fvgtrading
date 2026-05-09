/* 实盘监控前端 */
const $ = (sel) => document.querySelector(sel);

const fmtTs = (ms) => {
  if (!ms) return '-';
  const d = new Date(ms);
  const z = (n) => String(n).padStart(2, '0');
  // 浏览器侧也用东八区显示
  const opts = { timeZone: 'Asia/Shanghai', hour12: false };
  return d.toLocaleString('zh-CN', opts).replace(/\//g, '-');
};
const fmtPrice = (p) => (p == null ? '-' : Number(p).toLocaleString('en-US', {
  minimumFractionDigits: 2, maximumFractionDigits: 2,
}));

async function fetchStatus() {
  const res = await fetch('/api/status').then(r => r.json());
  if (!res.ok) return;
  // 系统状态
  const live = res.live;
  const dot = live.running ? '<span class="dot live"></span>' : '<span class="dot off"></span>';
  $('#systemStatus').innerHTML = dot + (live.running ? '运行中' : '未运行');
  $('#systemStatus').className = 'metric ' + (live.running ? 'pos' : 'muted');

  $('#lastPrice').innerText = fmtPrice(live.lastPrice);
  $('#lastTickAt').children[1].innerText = fmtTs(live.lastTickAt);
  $('#lastDecisionMs').innerText = (live.stats?.lastDecisionMs ?? 0) + ' ms';
  $('#tickCount').innerText = live.stats?.ticks ?? 0;

  // 持仓
  if (live.position) {
    const p = live.position;
    $('#position').innerHTML = `
      <div class="kv"><span class="k">方向</span><span class="${p.direction === 'long' ? 'pos' : 'neg'}">${p.direction === 'long' ? '做多' : '做空'}</span></div>
      <div class="kv"><span class="k">信号</span><span>${p.signal || '-'}</span></div>
      <div class="kv"><span class="k">入场</span><span>${fmtPrice(p.entry)}</span></div>
      <div class="kv"><span class="k">止盈</span><span>${fmtPrice(p.tp?.price)} (${p.tp?.src || '-'})</span></div>
      <div class="kv"><span class="k">止损</span><span>${fmtPrice(p.sl)}</span></div>
      <div class="kv"><span class="k">备注</span><span>${p.note || '-'}</span></div>
    `;
  } else {
    $('#position').innerHTML = '<span class="badge">空仓</span>';
  }

  // 风控
  const r = live.risk || {};
  $('#risk').innerHTML = `
    <div class="kv"><span class="k">连续亏损</span><span>${r.consecutiveLosses ?? 0}</span></div>
    <div class="kv"><span class="k">日内 PnL</span><span class="${(r.dailyPnL||0)>=0?'pos':'neg'}">${(r.dailyPnL||0).toFixed(4)}</span></div>
    <div class="kv"><span class="k">暂停至</span><span>${r.pauseUntil ? fmtTs(r.pauseUntil) : '-'}</span></div>
    <div class="kv"><span class="k">VWAP</span><span>${fmtPrice(live.vwapNow)}</span></div>
    <div class="kv"><span class="k">ATR(14)</span><span>${live.atrNow ? Number(live.atrNow).toFixed(2) : '-'}</span></div>
  `;

  // 配置
  const cfg = res.config;
  $('#config').innerHTML = `
    <div><div class="kv"><span class="k">品种</span><span>${cfg.symbol}</span></div></div>
    <div><div class="kv"><span class="k">杠杆</span><span>${cfg.leverage}x</span></div></div>
    <div><div class="kv"><span class="k">仓位</span><span>${cfg.positionSize}%</span></div></div>
    <div><div class="kv"><span class="k">单笔风险</span><span>${cfg.maxRiskPerTrade}%</span></div></div>
    <div><div class="kv"><span class="k">日亏上限</span><span>${cfg.maxDailyLoss}%</span></div></div>
    <div><div class="kv"><span class="k">连亏上限</span><span>${cfg.maxConsecutiveLosses}</span></div></div>
  `;
}

async function fetchTrades() {
  const res = await fetch('/api/trades?limit=50').then(r => r.json());
  if (!res.ok) return;
  const tbody = $('#tradesTable tbody');
  tbody.innerHTML = res.trades.map(t => `
    <tr>
      <td>${t.ts_cn}</td>
      <td><span class="badge ${t.action.startsWith('open') ? 'blue' : (t.action === 'take_profit' ? 'green' : 'red')}">${t.action}</span></td>
      <td>${t.direction === 'long' ? '做多' : t.direction === 'short' ? '做空' : '-'}</td>
      <td>${t.signal || '-'}</td>
      <td>${fmtPrice(t.price)}</td>
      <td>${t.trigger || '-'}</td>
      <td>${t.note || '-'}</td>
    </tr>
  `).join('');
}

$('#btnStart').addEventListener('click', async () => {
  await fetch('/api/start', { method: 'POST' });
  fetchStatus();
});
$('#btnStop').addEventListener('click', async () => {
  await fetch('/api/stop', { method: 'POST' });
  fetchStatus();
});

setInterval(fetchStatus, 1000);
setInterval(fetchTrades, 5000);
fetchStatus();
fetchTrades();
