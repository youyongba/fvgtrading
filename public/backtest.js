/* 回测前端 */
const $ = (s) => document.querySelector(s);
const fmtTs = (ms) => {
  if (!ms) return '-';
  const opts = { timeZone: 'Asia/Shanghai', hour12: false };
  return new Date(ms).toLocaleString('zh-CN', opts).replace(/\//g, '-');
};
const fmtNum = (n, d = 2) =>
  n == null || !Number.isFinite(n) ? '-' : Number(n).toFixed(d);
const fmtPct = (n) => (n == null ? '-' : (n * 100).toFixed(2) + '%');

let chart = null;
let pollTimer = null;

const today = new Date();
const ymd = (d) => {
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
};
$('#endDate').value = ymd(today);
const start = new Date(today.getTime() - 30 * 86400 * 1000);
$('#startDate').value = ymd(start);

async function loadTasks() {
  const res = await fetch('/api/backtest/list').then((r) => r.json());
  if (!res.ok) return;
  const tbody = $('#taskTable tbody');
  tbody.innerHTML = res.tasks
    .map((t) => {
      let pnl = '-';
      let wr = '-';
      if (t.status === 'done' && t.result) {
        try {
          const r = JSON.parse(t.result);
          pnl = `<span class="${r.totalPnL >= 0 ? 'pos' : 'neg'} metric" style="font-size:13px">${fmtNum(r.totalPnL)}</span>`;
          wr = fmtPct(r.winRate);
        } catch (_) { /* ignore */ }
      }
      const errAttr = t.error ? ` title="${String(t.error).replace(/"/g, '&quot;')}"` : '';
      return `<tr${errAttr}>
        <td><code>${t.id.slice(0, 8)}</code></td>
        <td>${t.start_date} → ${t.end_date}</td>
        <td><span class="badge ${t.status === 'done' ? 'green' : t.status === 'error' ? 'red' : 'yellow'}">${t.status}</span>${t.error ? `<div style="color:var(--red);font-size:11px;margin-top:4px">${t.error}</div>` : ''}</td>
        <td>${Math.round(t.progress)}%</td>
        <td>${pnl}</td>
        <td>${wr}</td>
        <td><button class="btn" data-id="${t.id}">查看</button></td>
      </tr>`;
    })
    .join('');
  tbody.querySelectorAll('button[data-id]').forEach((b) => {
    b.addEventListener('click', () => loadResult(b.dataset.id));
  });
}

async function loadResult(id) {
  const res = await fetch(`/api/backtest/result/${id}`).then((r) => r.json());
  if (!res.ok) return;
  const t = res.task;
  if (t.status !== 'done' || !t.result) {
    $('#resultCard').style.display = 'block';
    $('#summary').innerHTML = `<div class="card"><span class="badge yellow">${t.status}</span> 进度 ${Math.round(t.progress)}%</div>`;
    return;
  }
  const r = t.result;
  $('#resultCard').style.display = 'block';
  $('#summary').innerHTML = `
    <div><div class="kv"><span class="k">初始资金</span><span>${fmtNum(r.initialCapital)}</span></div></div>
    <div><div class="kv"><span class="k">期末权益</span><span>${fmtNum(r.finalEquity)}</span></div></div>
    <div><div class="kv"><span class="k">总盈亏</span><span class="${r.totalPnL >= 0 ? 'pos' : 'neg'}">${fmtNum(r.totalPnL)}</span></div></div>
    <div><div class="kv"><span class="k">收益率</span><span class="${r.totalReturn >= 0 ? 'pos' : 'neg'}">${fmtPct(r.totalReturn)}</span></div></div>
    <div><div class="kv"><span class="k">胜率</span><span>${fmtPct(r.winRate)} (${r.wins}/${r.totalTrades})</span></div></div>
    <div><div class="kv"><span class="k">最大回撤</span><span class="neg">${fmtPct(r.maxDrawdown)}</span></div></div>
    <div><div class="kv"><span class="k">盈亏比</span><span>${fmtNum(r.profitFactor)}</span></div></div>
    <div><div class="kv"><span class="k">平均盈利</span><span class="pos">${fmtNum(r.avgWin)}</span></div></div>
    <div><div class="kv"><span class="k">平均亏损</span><span class="neg">${fmtNum(r.avgLoss)}</span></div></div>
  `;

  // 净值曲线
  const labels = t.equity.map((e) => fmtTs(e.ts));
  const data = t.equity.map((e) => e.equity);
  if (chart) chart.destroy();
  chart = new Chart($('#equityChart'), {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: '权益',
        data,
        borderColor: '#5ea6ff',
        backgroundColor: 'rgba(94,166,255,0.15)',
        tension: 0.2,
        fill: true,
        pointRadius: 0,
      }],
    },
    options: {
      responsive: true,
      plugins: { legend: { labels: { color: '#e6ecff' } } },
      scales: {
        x: { ticks: { color: '#8a93b8', maxTicksLimit: 8 }, grid: { color: '#2b335a' } },
        y: { ticks: { color: '#8a93b8' }, grid: { color: '#2b335a' } },
      },
    },
  });

  // 月度
  $('#monthlyTable tbody').innerHTML = Object.entries(r.monthly || {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([m, v]) => `<tr>
      <td>${m}</td>
      <td>${v.count}</td>
      <td>${fmtPct(v.wins / v.count)}</td>
      <td class="${v.pnl >= 0 ? 'pos' : 'neg'}">${fmtNum(v.pnl)}</td>
    </tr>`).join('');

  // 交易明细（前 200 条）
  $('#tradeTable tbody').innerHTML = (t.trades || [])
    .slice(0, 200)
    .map((tr) => `<tr>
      <td>${tr.open_ts_cn}</td>
      <td>${tr.close_ts_cn}</td>
      <td>${tr.direction === 'long' ? '做多' : '做空'}</td>
      <td>${tr.signal || '-'}</td>
      <td>${fmtNum(tr.entry)}</td>
      <td>${fmtNum(tr.exit)}</td>
      <td><span class="badge ${tr.exit_reason === 'tp' ? 'green' : 'red'}">${tr.exit_reason}</span></td>
      <td class="${tr.pnl >= 0 ? 'pos' : 'neg'}">${fmtNum(tr.pnl)}</td>
    </tr>`).join('');
}

async function startBacktest() {
  const body = {
    startDate: $('#startDate').value,
    endDate: $('#endDate').value,
    initialCapital: Number($('#initialCapital').value) || 10000,
    feeRate: Number($('#feeRate').value) || 0.0004,
  };
  const res = await fetch('/api/backtest/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json());
  if (!res.ok) {
    $('#taskHint').className = 'badge red';
    $('#taskHint').textContent = res.error || '启动失败';
    return;
  }
  $('#taskHint').className = 'badge yellow';
  $('#taskHint').textContent = '任务已提交：' + res.taskId.slice(0, 8);
  pollTask(res.taskId);
  loadTasks();
}

function pollTask(id) {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    const r = await fetch(`/api/backtest/status/${id}`).then((r) => r.json());
    if (!r.ok) return;
    if (r.status === 'error') {
      $('#taskHint').className = 'badge red';
      $('#taskHint').textContent = `任务 ${id.slice(0, 8)} 失败：${r.error || '未知错误'}`;
    } else if (r.status === 'done') {
      $('#taskHint').className = 'badge green';
      $('#taskHint').textContent = `任务 ${id.slice(0, 8)} 完成`;
    } else {
      $('#taskHint').className = 'badge yellow';
      $('#taskHint').textContent = `任务 ${id.slice(0, 8)} · ${r.status} · ${Math.round(r.progress)}%`;
    }
    if (r.status === 'done' || r.status === 'error') {
      clearInterval(pollTimer);
      loadTasks();
      if (r.status === 'done') loadResult(id);
    }
  }, 1500);
}

$('#btnStart').addEventListener('click', startBacktest);
loadTasks();
setInterval(loadTasks, 5000);
