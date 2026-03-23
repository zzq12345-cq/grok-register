// ═══════════════════════════════════════════════════════════════
// 注册模块
// ═══════════════════════════════════════════════════════════════

import { api, clearLog } from './utils.js';

let running = false;

export async function initRegister() {
  const btnStart = document.getElementById('btn-start-register');
  const btnStop = document.getElementById('btn-stop-register');
  const threadSlider = document.getElementById('threadSlider');
  const threadCount = document.getElementById('threadCount');

  // 滑块和输入框同步
  threadSlider.oninput = () => threadCount.value = threadSlider.value;
  threadCount.oninput = () => threadSlider.value = threadCount.value;

  btnStart.onclick = startRegister;
  btnStop.onclick = stopRegister;

  document.getElementById('btn-clear-log').onclick = () => {
    clearLog('register-log');
    clearLog('register-results');
  };

  // 导入最新按钮
  const importBtn = document.getElementById('btn-import-last');
  if (importBtn) importBtn.onclick = importLastResult;

  // 加载可用域名列表
  loadDomains();

  // 连接 SSE
  connectSSE();
}

function connectSSE() {
  const eventSource = new EventSource('/api/stream');

  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      handleSSEEvent(data);
    } catch (e) {
      console.warn('解析 SSE 失败:', e);
    }
  };

  eventSource.onerror = () => {
    setTimeout(connectSSE, 3000);
  };
}

function handleSSEEvent(data) {
  switch (data.type) {
    case 'status':
      running = data.running;
      updateButtons();
      updateStatusDot(data.running);
      break;
    case 'progress':
      updateThreadProgress(data);
      break;
    case 'log':
      addLog('register-log', data.message, getLogLevel(data.message));
      break;
    case 'success':
      updateStats(data);
      addResult(data);
      break;
    case 'fail':
      updateStats(data);
      break;
    case 'heartbeat':
      break;
  }
}

async function startRegister() {
  const threadCount = parseInt(document.getElementById('threadCount').value) || 1;
  const taskCount = parseInt(document.getElementById('taskCount').value) || 1;
  const headless = document.getElementById('headlessMode').value === 'true';
  const domain = document.getElementById('emailDomain').value;

  try {
    const res = await api('/api/start', 'POST', {
      threads: threadCount,
      count: taskCount,
      headless,
      domain
    });

    if (res.success) {
      running = true;
      updateButtons();
      clearLog('register-log');
      initThreadProgress(res.threads, res.count);
      setStat('stat-total', res.total);
    }
  } catch (e) {
    alert('启动失败: ' + e.message);
  }
}

async function stopRegister() {
  try {
    await api('/api/stop', 'POST');
  } catch (e) {
    alert('停止失败: ' + e.message);
  }
}

function updateButtons() {
  const btnStart = document.getElementById('btn-start-register');
  const btnStop = document.getElementById('btn-stop-register');

  btnStart.disabled = running;
  btnStop.disabled = !running;

  if (running) {
    btnStart.classList.add('disabled');
    btnStop.classList.remove('disabled');
  } else {
    btnStart.classList.remove('disabled');
    btnStop.classList.add('disabled');
  }
}

function updateStatusDot(isRunning) {
  const dot = document.getElementById('statusDot');
  const text = document.getElementById('statusText');
  if (isRunning) {
    dot.classList.remove('error');
    text.textContent = '运行中';
  } else {
    dot.classList.remove('error');
    text.textContent = '就绪';
  }
}

function initThreadProgress(threads, count) {
  const container = document.getElementById('thread-progress');
  container.innerHTML = '';

  for (let i = 0; i < threads; i++) {
    const item = document.createElement('div');
    item.className = 'thread-item';
    item.id = `thread-${i}`;
    item.innerHTML = `
      <div class="thread-label">线程 ${i}</div>
      <div class="thread-bar-bg">
        <div class="thread-bar-fill" style="width: 0%"></div>
      </div>
      <div class="thread-pct">0/${count}</div>
      <div class="thread-step">等待启动</div>
    `;
    container.appendChild(item);
  }
}

function updateThreadProgress(data) {
  const item = document.getElementById(`thread-${data.thread_id}`);
  if (!item) return;

  const fill = item.querySelector('.thread-bar-fill');
  const pct = item.querySelector('.thread-pct');

  const percent = data.total > 0 ? (data.current / data.total * 100) : 0;
  fill.style.width = percent + '%';
  pct.textContent = `${data.current}/${data.total}`;
}

function updateStats(data) {
  setStat('stat-success', data.success);
  setStat('stat-fail', data.fail);
  setStat('stat-rate', data.rate + '%');
}

function setStat(id, value) {
  const el = document.getElementById(id);
  if (el) {
    el.textContent = value;
    el.classList.add('value-pop');
    setTimeout(() => el.classList.remove('value-pop'), 300);
  }
}

function addLog(containerId, message, level = 'info') {
  const container = document.getElementById(containerId);
  if (!container) return;

  const line = document.createElement('div');
  line.className = `log-entry log-${level}`;
  line.textContent = message;
  container.appendChild(line);
  container.scrollTop = container.scrollHeight;
}

function getLogLevel(msg) {
  if (msg.includes('✅') || msg.includes('成功')) return 'success';
  if (msg.includes('❌') || msg.includes('失败') || msg.includes('错误')) return 'error';
  if (msg.includes('⚠️') || msg.includes('警告')) return 'warn';
  return 'step';
}

function addResult(data) {
  const container = document.getElementById('register-results');
  if (!container) return;

  // 清除空状态
  const empty = container.querySelector('.empty-state');
  if (empty) empty.remove();

  // 显示导入按钮
  const importBtn = document.getElementById('btn-import-last');
  if (importBtn) importBtn.onclick = importLastResult;
  if (importBtn) importBtn.style.display = 'inline-block';

  const card = document.createElement('div');
  card.className = 'result-card';
  card.innerHTML = `
    <div class="result-email">${data.email || '未知邮箱'}</div>
    <div class="result-sso">${data.sso || ''}</div>
    <div class="result-time">${data.time || ''}</div>
  `;
  container.insertBefore(card, container.firstChild);

  // 更新计数
  const countEl = document.getElementById('result-count');
  if (countEl) {
    const count = container.querySelectorAll('.result-card').length;
    countEl.textContent = `共 ${count} 条`;
  }
}

// 一键导入最新注册结果到灵牌名录
async function importLastResult() {
  try {
    const res = await api('/api/import-last', 'POST');
    if (res.success) {
    alert('导入成功! 已添加 ' + res.imported + ' 个账号到灵牌名录');
  } else {
    alert('导入失败: ' + (res.error || '未知错误'));
  }
  } catch (e) {
    alert('导入失败: ' + e.message);
  }
}

// 初始化统计
function initStats() {
  setStat('stat-total', 0);
  setStat('stat-success', 0);
  setStat('stat-fail', 0);
  setStat('stat-rate', '0%');
}
// 加载可用邮箱域名
async function loadDomains() {
  try {
    const res = await api('/api/domains');
    const select = document.getElementById('emailDomain');
    if (res.domains && res.domains.length > 0) {
      for (const domain of res.domains) {
        const option = document.createElement('option');
        option.value = domain;
        option.textContent = domain;
        select.appendChild(option);
      }
    }
  } catch (e) {
    console.warn('加载域名列表失败:', e);
  }
}
