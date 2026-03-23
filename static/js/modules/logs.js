// ═══════════════════════════════════════════════════════════════
// 仙迹日志 · 使用日志模块
// ═══════════════════════════════════════════════════════════════

let currentPage = 1;
const PAGE_SIZE = 50;

// ── 操作类型映射 ──
const ACTION_MAP = {
  imagine: '🎨 图片生成',
  video: '🎬 视频生成',
  chat: '💬 Chat',
};

// ── 加载统计 ──
async function loadLogStats() {
  try {
    const resp = await fetch('/api/logs/stats');
    const data = await resp.json();
    if (data.ok || data.success) {
      document.getElementById('log-stat-total').textContent = data.total ?? 0;
      document.getElementById('log-stat-success').textContent = data.success ?? 0;
      document.getElementById('log-stat-error').textContent = data.error ?? 0;
      document.getElementById('log-stat-today').textContent = data.today ?? 0;
    }
  } catch (e) {
    console.error('加载日志统计失败:', e);
  }
}

// ── 加载日志列表 ──
async function loadLogs(page = 1) {
  currentPage = page;
  const action = document.getElementById('log-filter-action')?.value || '';
  const status = document.getElementById('log-filter-status')?.value || '';

  const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
  if (action) params.set('action', action);
  if (status) params.set('status', status);

  try {
    const resp = await fetch(`/api/logs?${params}`);
    const data = await resp.json();

    if (data.success) {
      renderLogTable(data.logs || []);
      renderPagination(data.total || 0, data.page || 1, data.limit || PAGE_SIZE);
      document.getElementById('log-count').textContent = `共 ${data.total} 条`;
    }
  } catch (e) {
    console.error('加载日志失败:', e);
  }
}

// ── 渲染日志表格 ──
function renderLogTable(logs) {
  const tbody = document.getElementById('log-table-body');
  if (!tbody) return;

  if (logs.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-cell">暂无日志</td></tr>';
    return;
  }

  tbody.innerHTML = logs.map(log => {
    const time = formatTime(log.timestamp);
    const action = ACTION_MAP[log.action] || log.action;
    const tokenName = log.token_name || log.token_id?.slice(0, 8) + '...';
    const duration = log.duration >= 1000
      ? `${(log.duration / 1000).toFixed(1)}s`
      : `${Math.round(log.duration)}ms`;
    const isSuccess = log.status >= 200 && log.status < 400;
    const statusClass = isSuccess ? 'log-status-ok' : 'log-status-err';
    const statusText = isSuccess ? `✓ ${log.status}` : `✗ ${log.status}`;
    const error = log.error ? escapeHtml(log.error.slice(0, 80)) : '—';

    return `<tr>
      <td class="log-time">${time}</td>
      <td>${action}</td>
      <td class="log-token" title="${log.token_id || ''}">${tokenName}</td>
      <td class="log-duration">${duration}</td>
      <td><span class="${statusClass}">${statusText}</span></td>
      <td class="log-error" title="${escapeHtml(log.error || '')}">${error}</td>
    </tr>`;
  }).join('');
}

// ── 渲染分页 ──
function renderPagination(total, page, limit) {
  const el = document.getElementById('log-pagination');
  if (!el) return;

  const totalPages = Math.ceil(total / limit);
  if (totalPages <= 1) {
    el.innerHTML = '';
    return;
  }

  let html = '';

  // 上一页
  if (page > 1) {
    html += `<button class="btn btn-sm btn-secondary" onclick="window._loadLogs(${page - 1})">上一页</button>`;
  }

  // 页码
  const start = Math.max(1, page - 2);
  const end = Math.min(totalPages, page + 2);

  for (let i = start; i <= end; i++) {
    const active = i === page ? 'active' : '';
    html += `<button class="btn btn-sm ${active ? '' : 'btn-secondary'} page-btn ${active}" 
              onclick="window._loadLogs(${i})">${i}</button>`;
  }

  // 下一页
  if (page < totalPages) {
    html += `<button class="btn btn-sm btn-secondary" onclick="window._loadLogs(${page + 1})">下一页</button>`;
  }

  el.innerHTML = html;
}

// ── 清空日志 ──
async function clearLogs() {
  if (!confirm('确定要清空所有日志吗？此操作不可撤销。')) return;

  try {
    const resp = await fetch('/api/logs', { method: 'DELETE' });
    const data = await resp.json();
    if (data.success) {
      await loadLogStats();
      await loadLogs(1);
    }
  } catch (e) {
    console.error('清空日志失败:', e);
  }
}

// ── 工具函数 ──
function formatTime(isoStr) {
  try {
    const d = new Date(isoStr);
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const h = String(d.getHours()).padStart(2, '0');
    const m = String(d.getMinutes()).padStart(2, '0');
    const s = String(d.getSeconds()).padStart(2, '0');
    return `${month}-${day} ${h}:${m}:${s}`;
  } catch {
    return isoStr;
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ── 初始化 ──
export async function initLogs() {
  // 全局暴露给分页按钮使用
  window._loadLogs = loadLogs;

  // 绑定事件
  document.getElementById('btn-filter-logs')?.addEventListener('click', () => loadLogs(1));
  document.getElementById('btn-refresh-logs')?.addEventListener('click', () => {
    loadLogStats();
    loadLogs(currentPage);
  });
  document.getElementById('btn-clear-logs')?.addEventListener('click', clearLogs);

  // Tab 切换时自动加载
  window.onTabSwitch = (function(orig) {
    return function(tab) {
      if (orig) orig(tab);
      if (tab === 'logs') {
        loadLogStats();
        loadLogs(currentPage);
      }
    };
  })(window.onTabSwitch);
}
