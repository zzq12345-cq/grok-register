/**
 * Grok 注册助手 - 前端交互逻辑
 * SSE 实时更新 + DOM 操作
 */

// ═══════════════════════════════════════════════════════════
//  状态
// ═══════════════════════════════════════════════════════════

let isRunning = false;
let eventSource = null;
let logCount = 0;
const MAX_LOG_LINES = 500;

// DOM 缓存
const DOM = {
    btnStart: document.getElementById('btnStart'),
    btnStop:  document.getElementById('btnStop'),
    threadSlider: document.getElementById('threadSlider'),
    threadCount:  document.getElementById('threadCount'),
    taskCount:    document.getElementById('taskCount'),
    headlessToggle: document.getElementById('headlessToggle'),
    toggleLabel:  document.getElementById('toggleLabel'),
    toggleHint:   document.getElementById('toggleHint'),
    statTotal:    document.getElementById('statTotal'),
    statSuccess:  document.getElementById('statSuccess'),
    statFail:     document.getElementById('statFail'),
    statRate:     document.getElementById('statRate'),
    threadProgressList: document.getElementById('threadProgressList'),
    logConsole:   document.getElementById('logConsole'),
    resultList:   document.getElementById('resultList'),
    resultCount:  document.getElementById('resultCount'),
    lanternRunning: document.getElementById('lanternRunning'),
    lanternStopped: document.getElementById('lanternStopped'),
};

// ═══════════════════════════════════════════════════════════
//  任务控制
// ═══════════════════════════════════════════════════════════

async function startTasks() {
    const threads = parseInt(DOM.threadCount.value) || 1;
    const count = parseInt(DOM.taskCount.value) || 1;
    const headless = DOM.headlessToggle.checked;
    const modeLabel = headless ? '无头模式' : '有头模式';

    try {
        const resp = await fetch('/api/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ threads, count, headless }),
        });

        const data = await resp.json();
        if (data.success) {
            setRunningState(true);
            addLog(`[系统] 任务已启动: ${threads} 线程 × ${count} 任务 (${modeLabel})`, 'info');
            connectSSE();
        } else {
            addLog(`[系统] 启动失败: ${data.error}`, 'error');
        }
    } catch (e) {
        addLog(`[系统] 请求异常: ${e.message}`, 'error');
    }
}

async function stopTasks() {
    try {
        const resp = await fetch('/api/stop', { method: 'POST' });
        const data = await resp.json();
        if (data.success) {
            addLog('[系统] 已发送停止信号，等待任务结束...', 'warn');
        } else {
            addLog(`[系统] 停止失败: ${data.error}`, 'error');
        }
    } catch (e) {
        addLog(`[系统] 请求异常: ${e.message}`, 'error');
    }
}

// ═══════════════════════════════════════════════════════════
//  SSE 连接
// ═══════════════════════════════════════════════════════════

function connectSSE() {
    if (eventSource) {
        eventSource.close();
    }

    eventSource = new EventSource('/api/stream');

    eventSource.onmessage = function (event) {
        try {
            const data = JSON.parse(event.data);
            handleSSEMessage(data);
        } catch (e) {
            console.error('SSE 解析错误:', e);
        }
    };

    eventSource.onerror = function () {
        console.warn('SSE 连接断开，3秒后重连...');
        eventSource.close();
        setTimeout(() => {
            if (isRunning) connectSSE();
        }, 3000);
    };
}

function handleSSEMessage(data) {
    switch (data.type) {
        case 'log':
            handleLog(data);
            break;
        case 'progress':
            updateThreadProgress(data.thread_id, data.current, data.total);
            break;
        case 'success':
        case 'fail':
            updateStats(data);
            if (data.type === 'success') {
                fetchResults();
            }
            break;
        case 'status':
            if (data.running === false) {
                setRunningState(false);
                addLog(`[系统] ${data.message || '任务已结束'}`, 'info');
            }
            break;
        case 'heartbeat':
            break;
        default:
            // 初始状态数据
            if ('total_tasks' in data) {
                updateStats(data);
            }
    }
}

// ═══════════════════════════════════════════════════════════
//  日志
// ═══════════════════════════════════════════════════════════

function handleLog(data) {
    const msg = data.message || '';
    let level = 'step';

    if (msg.includes('✅') || msg.includes('✓') || msg.includes('成功') || msg.includes('🎉')) {
        level = 'success';
    } else if (msg.includes('❌') || msg.includes('失败') || msg.includes('异常') || msg.includes('TIMEOUT')) {
        level = 'error';
    } else if (msg.includes('⚠') || msg.includes('等待')) {
        level = 'warn';
    } else if (msg.includes('[系统]') || msg.includes('[步骤')) {
        level = 'info';
    }

    addLog(msg, level);
}

function addLog(message, level = 'step') {
    const entry = document.createElement('div');
    entry.className = `log-entry log-${level}`;
    entry.textContent = message;
    DOM.logConsole.appendChild(entry);

    logCount++;

    // 限制日志行数
    if (logCount > MAX_LOG_LINES) {
        const first = DOM.logConsole.firstChild;
        if (first) DOM.logConsole.removeChild(first);
        logCount--;
    }

    // 自动滚动到底部
    DOM.logConsole.scrollTop = DOM.logConsole.scrollHeight;
}

function clearLog() {
    DOM.logConsole.innerHTML = '';
    logCount = 0;
    addLog('[系统] 日志已清空', 'info');
}

// ═══════════════════════════════════════════════════════════
//  统计更新
// ═══════════════════════════════════════════════════════════

function updateStats(data) {
    if ('total_tasks' in data) animateValue(DOM.statTotal, data.total_tasks);
    if ('success' in data) animateValue(DOM.statSuccess, data.success);
    if ('fail' in data) animateValue(DOM.statFail, data.fail);
    if ('rate' in data) {
        const rateStr = data.rate + '%';
        if (DOM.statRate.textContent !== rateStr) {
            DOM.statRate.textContent = rateStr;
            DOM.statRate.classList.add('value-pop');
            setTimeout(() => DOM.statRate.classList.remove('value-pop'), 300);
        }
    }

    // 更新线程进度
    if (data.threads) {
        for (const [tid, info] of Object.entries(data.threads)) {
            updateThreadProgress(parseInt(tid), info.current, info.total);
        }
    }
}

function animateValue(element, newValue) {
    const strVal = String(newValue);
    if (element.textContent !== strVal) {
        element.textContent = strVal;
        element.classList.add('value-pop');
        setTimeout(() => element.classList.remove('value-pop'), 300);
    }
}

// ═══════════════════════════════════════════════════════════
//  线程进度
// ═══════════════════════════════════════════════════════════

function updateThreadProgress(threadId, current, total) {
    let item = document.getElementById(`thread-${threadId}`);

    if (!item) {
        // 清除空提示
        const hint = DOM.threadProgressList.querySelector('.empty-hint');
        if (hint) hint.remove();

        item = document.createElement('div');
        item.id = `thread-${threadId}`;
        item.className = 'thread-item';
        item.innerHTML = `
            <span class="thread-label">线程 ${threadId}</span>
            <div class="thread-bar-bg">
                <div class="thread-bar-fill" style="width: 0%"></div>
            </div>
            <span class="thread-pct">0%</span>
        `;
        DOM.threadProgressList.appendChild(item);
    }

    const pct = total > 0 ? Math.round((current / total) * 100) : 0;
    const fill = item.querySelector('.thread-bar-fill');
    const pctSpan = item.querySelector('.thread-pct');
    const label = item.querySelector('.thread-label');

    fill.style.width = pct + '%';
    pctSpan.textContent = pct + '%';
    label.textContent = `线程 ${threadId}`;
}

// ═══════════════════════════════════════════════════════════
//  结果列表
// ═══════════════════════════════════════════════════════════

async function fetchResults() {
    try {
        const resp = await fetch('/api/results');
        const data = await resp.json();
        renderResults(data.results || []);
    } catch (e) {
        console.error('获取结果失败:', e);
    }
}

function renderResults(results) {
    if (results.length === 0) {
        DOM.resultList.innerHTML = '<div class="empty-hint">暂无结果</div>';
        DOM.resultCount.textContent = '共 0 条';
        return;
    }

    // 只添加新的结果
    const existing = DOM.resultList.querySelectorAll('.result-card').length;
    if (results.length > existing) {
        // 清除空提示
        const hint = DOM.resultList.querySelector('.empty-hint');
        if (hint) hint.remove();

        for (let i = existing; i < results.length; i++) {
            const r = results[i];
            const card = document.createElement('div');
            card.className = 'result-card';
            card.innerHTML = `
                <div class="result-email">${escapeHtml(r.email || '未知邮箱')}</div>
                <div class="result-sso">SSO: ${escapeHtml(r.sso || '...')}</div>
                <div class="result-time">T${r.thread_id} · ${r.time || ''}</div>
            `;
            DOM.resultList.insertBefore(card, DOM.resultList.firstChild);
        }
    }

    DOM.resultCount.textContent = `共 ${results.length} 条`;
}

// ═══════════════════════════════════════════════════════════
//  UI 状态
// ═══════════════════════════════════════════════════════════

function setRunningState(running) {
    isRunning = running;

    DOM.btnStart.disabled = running;
    DOM.btnStop.disabled = !running;
    DOM.threadSlider.disabled = running;
    DOM.threadCount.disabled = running;
    DOM.taskCount.disabled = running;
    DOM.headlessToggle.disabled = running;

    if (running) {
        DOM.lanternRunning.classList.remove('inactive');
        DOM.lanternStopped.classList.add('inactive');
    } else {
        DOM.lanternRunning.classList.add('inactive');
        DOM.lanternStopped.classList.remove('inactive');
        if (eventSource) {
            eventSource.close();
            eventSource = null;
        }
    }
}

// ═══════════════════════════════════════════════════════════
//  工具函数
// ═══════════════════════════════════════════════════════════

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// ═══════════════════════════════════════════════════════════
//  初始化
// ═══════════════════════════════════════════════════════════

(async function init() {
    // 初始状态: 停止灯亮
    setRunningState(false);

    // Toggle 开关交互
    DOM.headlessToggle.addEventListener('change', function() {
        if (this.checked) {
            DOM.toggleLabel.textContent = '无头模式';
            DOM.toggleLabel.style.color = 'var(--ink-light)';
            DOM.toggleHint.textContent = '无头模式: 不显示浏览器窗口';
        } else {
            DOM.toggleLabel.textContent = '有头模式 ✔';
            DOM.toggleLabel.style.color = 'var(--green-jade)';
            DOM.toggleHint.textContent = '推荐：有头模式通过率更高';
        }
    });

    // 拉取一次状态
    try {
        const resp = await fetch('/api/status');
        const data = await resp.json();
        updateStats(data);
        if (data.running) {
            setRunningState(true);
            connectSSE();
            addLog('[系统] 检测到运行中的任务，已连接', 'info');
        }
    } catch (e) {
        console.warn('初始状态获取失败:', e);
    }

    // 拉取已有结果
    fetchResults();
})();
