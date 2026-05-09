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

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function fetchStatus() {
  const res = await fetch('/api/status').then(r => r.json());
  if (!res.ok) return;
  // 系统状态
  const live = res.live;
  const dot = live.running ? '<span class="dot live"></span>' : '<span class="dot off"></span>';
  $('#systemStatus').innerHTML = dot + (live.running ? '运行中' : '未运行');
  $('#systemStatus').className = 'metric ' + (live.running ? 'pos' : 'muted');

  // WebSocket 状态徽章
  const w = live.ws || {};
  const stateLabel = {
    idle: '未连接', connecting: '连接中…', open: 'WS 已连接',
    closing: '关闭中', closed: 'WS 已断开', error: 'WS 错误',
  }[w.readyState || w.state] || (w.readyState || w.state || '-');
  const stateColor = {
    open: 'green', connecting: 'yellow',
    closed: 'red', error: 'red', idle: '',
  }[w.readyState || w.state] || '';
  let wsHtml = `<span class="badge ${stateColor}">${stateLabel}</span>`;
  if (w.attempts > 1 && w.readyState !== 'open') wsHtml += ` <span class="badge">重连第 ${w.attempts} 次</span>`;
  if (w.proxy) wsHtml += ` <span class="badge blue">代理</span>`;
  if (w.lastError && w.readyState !== 'open') {
    wsHtml += `<div style="color:var(--red);font-size:11px;margin-top:4px;">${w.lastError}</div>`;
  }
  if (live.running && w.readyState === 'open' && (live.stats?.ticks || 0) === 0) {
    wsHtml += `<div style="color:var(--yellow);font-size:11px;margin-top:4px;">已连接但未收到推送，等待 markPrice…</div>`;
  }
  $('#wsStatus').innerHTML = wsHtml;

  // WS 事件日志
  if ($('#wsEvents')) {
    const events = (res.live.events || []).slice().reverse();
    const colorMap = { ok: '#16d39a', warn: '#ffce5d', error: '#ff5c7a', info: '#8a93b8' };
    $('#wsEvents').innerHTML = events.length
      ? events.map(ev => `<div><span style="color:#5ea6ff">${fmtTs(ev.ts)}</span> <span style="color:${colorMap[ev.level] || '#8a93b8'}">[${ev.level}]</span> <span style="color:#e6ecff">${escapeHtml(ev.message)}</span></div>`).join('')
      : '<div style="color:var(--muted)">暂无事件，点击启动后会出现连接日志…</div>';

    $('#wsEventStats').innerText =
      `原始消息=${w.rawMessages || 0}  解析失败=${w.parseErrors || 0}  ` +
      `未识别=${w.unrecognized || 0}  最后采样: ${w.lastRawAt ? fmtTs(w.lastRawAt) : '-'}`;
  }

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
