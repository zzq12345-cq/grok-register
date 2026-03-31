// ═══════════════════════════════════════════════════════════════
// 注册模块
// ═══════════════════════════════════════════════════════════════

import { api, clearLog } from './utils.js';

// 注册相关 API 在 Flask 服务器上 (8086)，不在 Worker (8787) 上
const FLASK_BASE = 'http://localhost:8086';

async function flaskApi(path, method = 'GET', body = null) {
  return api(FLASK_BASE + path, method, body);
}

let running = false;

const TOTAL_STEPS = 8;
const STEP_NAMES = [
  '创建邮箱', '启动浏览器', '打开注册页', '验证码',
  '填写信息', 'Turnstile', '等待结果', '后处理'
];

// 每个线程的计时器 {threadId: {startTime, intervalId, currentStep}}
const threadTimers = {};

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
  const eventSource = new EventSource(FLASK_BASE + '/api/stream');

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
      if (!data.running) stopAllTimers();
      break;
    case 'progress':
      updateThreadProgress(data);
      break;
    case 'log':
      addLog('register-log', data.message, getLogLevel(data.message));
      parseStepFromLog(data.message, data.thread_id);
      break;
    case 'success':
      updateStats(data);
      addResult(data);
      // 所有步骤标记完成
      markAllStepsDone(data.thread_id);
      break;
    case 'fail':
      updateStats(data);
      markStepError(data.thread_id);
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
    const res = await flaskApi('/api/start', 'POST', {
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
    await flaskApi('/api/stop', 'POST');
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
  stopAllTimers();

  for (let i = 0; i < threads; i++) {
    const item = document.createElement('div');
    item.className = 'thread-item';
    item.id = `thread-${i}`;

    // 构建步骤圆点 HTML
    let dotsHtml = '';
    for (let s = 0; s < TOTAL_STEPS; s++) {
      if (s > 0) dotsHtml += `<span class="step-line" data-step="${s}"></span>`;
      dotsHtml += `<span class="step-dot" data-step="${s}" title="${STEP_NAMES[s]}"></span>`;
    }
    dotsHtml += `<span class="step-label">等待启动</span>`;

    item.innerHTML = `
      <div class="thread-label">线程 ${i}</div>
      <div class="thread-bar-bg">
        <div class="thread-bar-fill" style="width: 0%"></div>
      </div>
      <div class="thread-pct">0/${count}</div>
      <div class="thread-steps">${dotsHtml}</div>
      <div class="thread-timer" data-thread="${i}"></div>
    `;
    container.appendChild(item);

    // 初始化计时器状态
    threadTimers[i] = { startTime: null, intervalId: null, currentStep: -1 };
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

// ── 步骤圆点逻辑 ──

function parseStepFromLog(message, threadId) {
  if (threadId === undefined) return;
  const match = message.match(/\[步骤(\d+)\]/);
  if (!match) return;

  const stepNum = parseInt(match[1], 10); // 1-based
  const stepIndex = stepNum - 1;          // 0-based
  if (stepIndex < 0 || stepIndex >= TOTAL_STEPS) return;

  const timer = threadTimers[threadId];
  if (timer) {
    // 启动计时器
    if (!timer.startTime) {
      timer.startTime = Date.now();
      timer.intervalId = setInterval(() => updateThreadTimer(threadId), 1000);
      updateThreadTimer(threadId);
    }
    timer.currentStep = stepIndex;
  }

  updateStepDots(threadId, stepIndex);
}

function updateStepDots(threadId, activeStepIndex) {
  const item = document.getElementById(`thread-${threadId}`);
  if (!item) return;

  const dots = item.querySelectorAll('.step-dot');
  const lines = item.querySelectorAll('.step-line');
  const label = item.querySelector('.step-label');

  dots.forEach((dot, i) => {
    // 清除所有动态 class
    dot.classList.remove('active', 'done', 'error');

    if (i < activeStepIndex) {
      dot.classList.add('done');
    } else if (i === activeStepIndex) {
      dot.classList.add('active');
    }
  });

  lines.forEach((line, i) => {
    line.classList.remove('done', 'active');
    const lineStep = parseInt(line.dataset.step, 10);
    if (lineStep < activeStepIndex) {
      line.classList.add('done');
    } else if (lineStep === activeStepIndex) {
      line.classList.add('active');
    }
  });

  if (label && STEP_NAMES[activeStepIndex]) {
    label.textContent = STEP_NAMES[activeStepIndex];
  }
}

function markAllStepsDone(threadId) {
  const item = document.getElementById(`thread-${threadId}`);
  if (!item) return;

  item.querySelectorAll('.step-dot').forEach(dot => {
    dot.classList.remove('active', 'error');
    dot.classList.add('done');
  });
  item.querySelectorAll('.step-line').forEach(line => {
    line.classList.remove('active');
    line.classList.add('done');
  });
  const label = item.querySelector('.step-label');
  if (label) label.textContent = '完成 ✓';

  stopTimer(threadId);

  // 重置计时器状态供下一个任务复用
  const timer = threadTimers[threadId];
  if (timer) {
    timer.startTime = null;
    timer.currentStep = -1;
  }
}

function markStepError(threadId) {
  const item = document.getElementById(`thread-${threadId}`);
  if (!item) return;

  const timer = threadTimers[threadId];
  const activeStep = timer ? timer.currentStep : -1;
  if (activeStep >= 0) {
    const dots = item.querySelectorAll('.step-dot');
    if (dots[activeStep]) {
      dots[activeStep].classList.remove('active');
      dots[activeStep].classList.add('error');
    }
  }

  // 重置计时器以供下次任务使用
  if (timer) {
    timer.startTime = null;
    timer.currentStep = -1;
  }
}

// ── 倒计时/计时器逻辑 ──

const EXPECTED_DURATION_SEC = 120; // 预估单次注册约 2 分钟

function updateThreadTimer(threadId) {
  const timer = threadTimers[threadId];
  if (!timer || !timer.startTime) return;

  const elapsed = Math.floor((Date.now() - timer.startTime) / 1000);
  const remaining = Math.max(0, EXPECTED_DURATION_SEC - elapsed);
  const min = Math.floor(remaining / 60);
  const sec = remaining % 60;

  const timerEl = document.querySelector(`.thread-timer[data-thread="${threadId}"]`);
  if (!timerEl) return;

  if (remaining > 0) {
    timerEl.textContent = `预计剩余 ${min}:${String(sec).padStart(2, '0')}`;
  } else {
    timerEl.textContent = `已耗时 ${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`;
  }

  // 绿→橙渐变：ratio 0(刚开始/绿) → 1(快到了/橙)
  const ratio = Math.min(1, elapsed / EXPECTED_DURATION_SEC);
  const r = Math.round(90 + ratio * 122);   // 90→212
  const g = Math.round(159 - ratio * 91);   // 159→68
  const b = Math.round(111 - ratio * 36);   // 111→75
  timerEl.style.color = `rgb(${r}, ${g}, ${b})`;
}

function stopTimer(threadId) {
  const timer = threadTimers[threadId];
  if (timer && timer.intervalId) {
    clearInterval(timer.intervalId);
    timer.intervalId = null;
  }
}

function stopAllTimers() {
  for (const id in threadTimers) {
    stopTimer(id);
  }
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
    const res = await flaskApi('/api/import-last', 'POST');
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
    const res = await flaskApi('/api/domains');
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
