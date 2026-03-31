// ═══════════════════════════════════════════════════════════════
// Token 管理模块
// ═══════════════════════════════════════════════════════════════

import { workersApi, api, log, clearLog, downloadJSON, copyToClipboard, bus } from './utils.js';

const PAGE_SIZE = 50;
const FLASK_BASE = 'http://localhost:8086';
let allTokens = [];
let currentPage = 1;
const diagnosisResults = new Map();
const selectedTokenIds = new Set();

const DIAGNOSIS_LABELS = {
  ok: '可用',
  rate_limited: '限流',
  auth_invalid: '失效',
  ws_upgrade_failed: '握手失败',
  upstream_blocked: '被拦截',
  unknown_error: '未知错误',
};

const DIAGNOSIS_BADGE_CLASSES = {
  ok: 'diagnosis-ok',
  rate_limited: 'diagnosis-rate-limited',
  auth_invalid: 'diagnosis-auth-invalid',
  ws_upgrade_failed: 'diagnosis-ws-upgrade-failed',
  upstream_blocked: 'diagnosis-upstream-blocked',
  unknown_error: 'diagnosis-unknown-error',
};

export async function initTokens() {
  document.getElementById('btn-import-tokens').onclick = importTokens;
  document.getElementById('btn-clear-tokens').onclick = clearAllTokens;
  document.getElementById('btn-nsfw-all').onclick = enableNsfwAll;
  document.getElementById('btn-export-tokens').onclick = exportTokens;
  document.getElementById('btn-diagnose-all').onclick = diagnoseAllTokens;
  document.getElementById('btn-fetch-cf').onclick = fetchCfClearance;

  // 远程同步
  const syncBtn = document.getElementById('btn-sync-to-remote');
  const remoteInput = document.getElementById('remote-server-url');
  if (syncBtn && remoteInput) {
    remoteInput.value = localStorage.getItem('remote_server_url') || '';
    syncBtn.onclick = syncToRemote;
  }

  bus.on('refresh-tokens', loadTokens);
  await loadTokens();
}

async function loadTokens() {
  try {
    const data = await workersApi('/api/tokens');
    allTokens = data.tokens || [];
    const currentIds = new Set(allTokens.map(token => token.id));
    for (const id of diagnosisResults.keys()) {
      if (!currentIds.has(id)) diagnosisResults.delete(id);
    }
    updateTokenStats(data);
    updateDiagnosisSummary();
    currentPage = 1;
    renderTokenList();
    renderPagination();
  } catch (e) {
    console.error('加载令牌失败', e);
    document.getElementById('token-list').innerHTML =
      `<div class="empty-state">加载失败: ${e.message}</div>`;
  }
}

function updateTokenStats(data) {
  document.getElementById('token-stat-total').textContent = data.total || 0;
  document.getElementById('token-stat-active').textContent = data.active || 0;
}

function getDiagnosisLabel(code) {
  return DIAGNOSIS_LABELS[code] || '未知错误';
}

function getDiagnosisBadgeClass(code) {
  return DIAGNOSIS_BADGE_CLASSES[code] || 'diagnosis-unknown-error';
}

function truncateText(text, maxLength = 48) {
  if (!text) return '';
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function formatDiagnosisMessage(result) {
  const detail = result.message || result.detail || '未知错误';
  return `${getDiagnosisLabel(result.code)} · ${detail}`;
}

function getLogTypeForDiagnosis(code, ok) {
  if (ok) return 'success';
  if (code === 'rate_limited') return 'info';
  return 'error';
}

function storeDiagnosisResult(result) {
  if (!result || !result.token_id) return;
  diagnosisResults.set(result.token_id, result);
}

function renderDiagnosisBadge(tokenId) {
  const result = diagnosisResults.get(tokenId);
  if (!result) return '';
  return `<span class="status-badge ${getDiagnosisBadgeClass(result.code)}">${getDiagnosisLabel(result.code)}</span>`;
}

function renderDiagnosisBlock(tokenId) {
  const result = diagnosisResults.get(tokenId);
  if (!result) return '';

  const checkedAt = result.checked_at
    ? new Date(result.checked_at).toLocaleTimeString()
    : '';

  return `
    <div class="token-diagnostic">
      上次诊断: ${truncateText(formatDiagnosisMessage(result))}${checkedAt ? ` · ${checkedAt}` : ''}
    </div>
  `;
}

function updateDiagnosisSummary() {
  const summaryEl = document.getElementById('diagnose-summary');
  if (!summaryEl) return;

  const counts = {
    ok: 0,
    rate_limited: 0,
    auth_invalid: 0,
    ws_upgrade_failed: 0,
    upstream_blocked: 0,
    unknown_error: 0,
  };

  let diagnosed = 0;
  for (const token of allTokens) {
    const result = diagnosisResults.get(token.id);
    if (!result) continue;
    diagnosed += 1;
    counts[result.code] = (counts[result.code] || 0) + 1;
  }

  if (diagnosed === 0) {
    summaryEl.textContent = '尚未执行诊断';
    return;
  }

  const parts = [
    `可用 ${counts.ok}`,
    `限流 ${counts.rate_limited}`,
    `失效 ${counts.auth_invalid}`,
    `握手失败 ${counts.ws_upgrade_failed}`,
    `拦截 ${counts.upstream_blocked}`,
    `未知 ${counts.unknown_error}`,
  ];
  summaryEl.textContent = `已诊断 ${diagnosed} 个：${parts.join(' · ')}`;
}

function renderTokenList() {
  const list = document.getElementById('token-list');
  const start = (currentPage - 1) * PAGE_SIZE;
  const pageTokens = allTokens.slice(start, start + PAGE_SIZE);

  if (pageTokens.length === 0) {
    list.innerHTML = '<div class="empty-state">暂无令牌，请先导入</div>';
    updateBatchUI();
    return;
  }

  list.innerHTML = pageTokens.map(t => `
    <div class="token-item">
      <label class="token-checkbox">
        <input type="checkbox" data-token-id="${t.id}" ${selectedTokenIds.has(t.id) ? 'checked' : ''}
          onchange="window.toggleTokenSelect('${t.id}', this.checked)" />
      </label>
      <div class="token-info" style="flex:1">
        <div class="token-name">
          ${t.name}
          ${t.nsfw_enabled ? '<span class="status-badge" style="background:rgba(212,168,75,0.15);color:var(--gold-deep);border-color:var(--gold-bright);">NSFW</span>' : ''}
        </div>
        <div class="token-meta">使用次数: ${t.use_count || 0} · SSO_RW: ${t.has_sso_rw ? '✓' : '✗'} · UserID: ${t.has_user_id ? '✓' : '✗'}</div>
        ${renderDiagnosisBlock(t.id)}
      </div>
      <div class="token-actions">
        <span class="status-badge ${t.status}">${t.status === 'active' ? '活跃' : t.status}</span>
        ${renderDiagnosisBadge(t.id)}
        <button class="btn btn-sm btn-secondary" onclick="window.diagnoseToken('${t.id}', this)">诊断</button>
        <button class="btn btn-sm btn-secondary" onclick="window.deleteToken('${t.id}')">删除</button>
      </div>
    </div>
  `).join('');

  updateBatchUI();
}

function updateBatchUI() {
  const countEl = document.getElementById('batch-selected-count');
  const batchBtn = document.getElementById('btn-batch-delete');
  if (countEl) countEl.textContent = `已选 ${selectedTokenIds.size} 个`;
  if (batchBtn) batchBtn.disabled = selectedTokenIds.size === 0;
}

window.toggleTokenSelect = (id, checked) => {
  if (checked) selectedTokenIds.add(id);
  else selectedTokenIds.delete(id);
  updateBatchUI();
};

window.toggleSelectAll = (checked) => {
  if (checked) {
    allTokens.forEach(t => selectedTokenIds.add(t.id));
  } else {
    selectedTokenIds.clear();
  }
  renderTokenList();
};

window.batchDeleteTokens = async () => {
  if (selectedTokenIds.size === 0) return;
  if (!confirm(`确定删除选中的 ${selectedTokenIds.size} 个令牌？\n同时会删除对应的本地账号文件，此操作不可撤销！`)) return;

  const btn = document.getElementById('btn-batch-delete');
  btn.disabled = true;
  btn.textContent = '删除中...';

  try {
    // 1. 从 Worker D1 数据库批量删除
    const ids = Array.from(selectedTokenIds);
    const res = await workersApi('/api/tokens/batch-delete', 'POST', { ids });

    // 2. 同时删除本地账号文件（通过 Flask）
    if (res.deleted_names && res.deleted_names.length > 0) {
      try {
        await api(FLASK_BASE + '/api/batch-delete-tokens', 'POST', { names: res.deleted_names });
      } catch (e) {
        console.warn('删除本地文件失败（Flask 未启动？）:', e.message);
      }
    }

    selectedTokenIds.clear();
    alert(`成功删除 ${res.deleted} 个令牌`);
    await loadTokens();
  } catch (e) {
    alert('批量删除失败: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '🗑️ 批量删除';
  }
};

function renderPagination() {
  const container = document.getElementById('token-pagination');
  const totalPages = Math.ceil(allTokens.length / PAGE_SIZE);

  if (totalPages <= 1) {
    container.innerHTML = `<span style="color:var(--text-muted);font-size:12px;">共 ${allTokens.length} 条</span>`;
    return;
  }

  let html = '';
  html += `<button class="btn btn-sm btn-secondary" ${currentPage === 1 ? 'disabled' : ''} onclick="window.goToTokenPage(${currentPage - 1})">上一页</button>`;

  const maxVisible = 5;
  let startPage = Math.max(1, currentPage - Math.floor(maxVisible / 2));
  let endPage = Math.min(totalPages, startPage + maxVisible - 1);
  if (endPage - startPage < maxVisible - 1) startPage = Math.max(1, endPage - maxVisible + 1);

  if (startPage > 1) {
    html += `<button class="btn btn-sm btn-secondary" onclick="window.goToTokenPage(1)">1</button>`;
    if (startPage > 2) html += `<span style="padding:0 8px;color:var(--text-muted)">...</span>`;
  }

  for (let i = startPage; i <= endPage; i++) {
    if (i === currentPage) {
      html += `<button class="btn btn-sm" disabled style="background:var(--gold-bright);color:white;border-color:var(--gold-bright)">${i}</button>`;
    } else {
      html += `<button class="btn btn-sm btn-secondary" onclick="window.goToTokenPage(${i})">${i}</button>`;
    }
  }

  if (endPage < totalPages) {
    if (endPage < totalPages - 1) html += `<span style="padding:0 8px;color:var(--text-muted)">...</span>`;
    html += `<button class="btn btn-sm btn-secondary" onclick="window.goToTokenPage(${totalPages})">${totalPages}</button>`;
  }

  html += `<button class="btn btn-sm btn-secondary" ${currentPage === totalPages ? 'disabled' : ''} onclick="window.goToTokenPage(${currentPage + 1})">下一页</button>`;
  html += `<span style="margin-left:12px;color:var(--text-muted);font-size:12px;">共 ${allTokens.length} 条</span>`;

  container.innerHTML = html;
}

window.goToTokenPage = (page) => {
  const totalPages = Math.ceil(allTokens.length / PAGE_SIZE);
  if (page < 1 || page > totalPages) return;
  currentPage = page;
  renderTokenList();
  renderPagination();
};

window.deleteToken = async (id) => {
  if (!confirm('确定删除此令牌？')) return;
  try {
    await workersApi(`/api/tokens/${id}`, 'DELETE');
    diagnosisResults.delete(id);
    await loadTokens();
  } catch (e) {
    alert('删除失败: ' + e.message);
  }
};

window.diagnoseToken = async (id, button) => {
  const btn = button instanceof HTMLElement ? button : null;
  const originalText = btn ? btn.textContent : '';

  if (btn) {
    btn.disabled = true;
    btn.textContent = '诊断中...';
  }

  document.getElementById('diagnose-log').style.display = 'block';
  log('diagnose-log', `开始诊断令牌 ${id}...`, 'info');

  try {
    const data = await workersApi(`/api/tokens/${id}/diagnose`, 'POST');
    storeDiagnosisResult(data.result);
    updateDiagnosisSummary();
    renderTokenList();
    log('diagnose-log', `${data.result.token_name}: ${formatDiagnosisMessage(data.result)}`, getLogTypeForDiagnosis(data.result.code, data.result.ok));
  } catch (e) {
    log('diagnose-log', `诊断失败: ${e.message}`, 'error');
    alert('诊断失败: ' + e.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = originalText || '诊断';
    }
  }
};

async function importTokens() {
  const text = document.getElementById('input-tokens').value.trim();
  if (!text) return alert('请输入内容');

  const btn = document.getElementById('btn-import-tokens');
  btn.disabled = true;
  btn.textContent = '导入中...';

  try {
    const res = await workersApi('/api/tokens/import', 'POST', { text });
    if (res.success) {
      alert(`成功导入 ${res.imported} 个令牌`);
      document.getElementById('input-tokens').value = '';
      await loadTokens();
    } else {
      alert(res.error || '导入失败');
    }
  } catch (e) {
    alert('导入失败: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '导入数据';
  }
}

async function clearAllTokens() {
  if (!confirm('确定清空所有令牌？此操作不可撤销！')) return;
  try {
    await workersApi('/api/tokens', 'DELETE');
    await loadTokens();
  } catch (e) {
    alert('操作失败: ' + e.message);
  }
}

async function exportTokens() {
  if (allTokens.length === 0) return alert('暂无令牌可导出');

  try {
    const data = await workersApi('/api/tokens/export');
    if (data.tokens && data.tokens.length > 0) {
      downloadJSON(data.tokens, `grok-tokens-${new Date().toISOString().slice(0, 10)}.json`);
      alert(`已导出 ${data.tokens.length} 个令牌`);
    }
  } catch (e) {
    alert('导出失败: ' + e.message);
  }
}

async function enableNsfwAll() {
  if (!confirm('确定为所有令牌启用 NSFW？')) return;

  const progress = document.getElementById('nsfw-progress');
  const bar = progress.querySelector('.progress-fill');
  const logEl = document.getElementById('nsfw-log');

  progress.style.display = 'block';
  bar.style.width = '0%';
  logEl.style.display = 'block';
  clearLog('nsfw-log');
  log('nsfw-log', '开始批量启用 NSFW...', 'info');

  let offset = 0;
  let totalSuccess = 0;
  let totalFail = 0;

  try {
    while (true) {
      const data = await workersApi('/api/tokens/enable-nsfw', 'POST', { offset });

      if (!data.success) {
        log('nsfw-log', `错误: ${data.error || '未知错误'}`, 'error');
        break;
      }

      if (data.results) {
        for (const r of data.results) {
          if (r.success) {
            log('nsfw-log', `[成功] ${r.name}`, 'success');
            totalSuccess++;
          } else {
            log('nsfw-log', `[失败] ${r.name}: ${r.message}`, 'error');
            totalFail++;
          }
        }
      }

      const pct = data.total > 0 ? (data.processed / data.total * 100) : 100;
      bar.style.width = pct + '%';

      if (data.done) {
        log('nsfw-log', `批量完成! 成功: ${totalSuccess}, 失败: ${totalFail}`, 'success');
        await loadTokens();
        break;
      }

      offset = data.next_offset;
      await new Promise(r => setTimeout(r, 100));
    }
  } catch (e) {
    log('nsfw-log', '错误: ' + e.message, 'error');
  } finally {
    setTimeout(() => { progress.style.display = 'none'; }, 2000);
  }
}

async function diagnoseAllTokens() {
  if (!confirm('确定诊断全部活跃令牌？这会逐个探测图片接口，可能需要一些时间。')) return;

  const btn = document.getElementById('btn-diagnose-all');
  const progress = document.getElementById('diagnose-progress');
  const bar = progress.querySelector('.progress-fill');

  btn.disabled = true;
  btn.textContent = '诊断中...';
  progress.style.display = 'block';
  bar.style.width = '0%';
  document.getElementById('diagnose-log').style.display = 'block';
  clearLog('diagnose-log');
  log('diagnose-log', '开始批量诊断活跃令牌...', 'info');

  let offset = 0;
  let total = 0;
  const summary = {
    ok: 0,
    rate_limited: 0,
    auth_invalid: 0,
    ws_upgrade_failed: 0,
    upstream_blocked: 0,
    unknown_error: 0,
  };

  try {
    while (true) {
      const data = await workersApi('/api/tokens/diagnose', 'POST', {
        offset,
        active_only: true,
        delay_ms: 250,
      });

      total = data.total || total;
      if (total === 0) {
        log('diagnose-log', '没有可诊断的活跃令牌', 'info');
        break;
      }

      for (const result of data.results || []) {
        storeDiagnosisResult(result);
        summary[result.code] = (summary[result.code] || 0) + 1;
        log('diagnose-log', `${result.token_name}: ${formatDiagnosisMessage(result)}`, getLogTypeForDiagnosis(result.code, result.ok));
      }

      updateDiagnosisSummary();
      renderTokenList();

      const pct = data.total > 0 ? (data.processed / data.total * 100) : 100;
      bar.style.width = pct + '%';

      if (data.done) {
        log('diagnose-log', `批量诊断完成：可用 ${summary.ok}，限流 ${summary.rate_limited}，失效 ${summary.auth_invalid}，握手失败 ${summary.ws_upgrade_failed}，拦截 ${summary.upstream_blocked}，未知 ${summary.unknown_error}`, 'success');
        break;
      }

      offset = data.next_offset;
      await new Promise(r => setTimeout(r, 100));
    }
  } catch (e) {
    log('diagnose-log', '错误: ' + e.message, 'error');
    alert('批量诊断失败: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '诊断全部活跃令牌';
    setTimeout(() => { progress.style.display = 'none'; }, 2000);
  }
}

async function syncToRemote() {
  const remoteInput = document.getElementById('remote-server-url');
  const resultEl = document.getElementById('sync-result');
  const btn = document.getElementById('btn-sync-to-remote');
  const remoteUrl = (remoteInput.value || '').trim();

  if (!remoteUrl) {
    resultEl.textContent = '❌ 请输入服务器地址';
    resultEl.style.color = 'var(--danger)';
    return;
  }

  localStorage.setItem('remote_server_url', remoteUrl);
  btn.disabled = true;
  btn.textContent = '同步中...';
  resultEl.textContent = '正在推送...';
  resultEl.style.color = 'var(--text-muted)';

  try {
    const data = await workersApi('/api/sync-tokens-to-remote', 'POST', { remote_url: remoteUrl });
    if (data.success) {
      const remote = data.remote_response || {};
      resultEl.textContent = `✅ 推送 ${data.sent} 个 → 新增 ${remote.added || 0} 个，服务器总计 ${remote.total || '?'} 个`;
      resultEl.style.color = 'var(--success)';
    } else {
      resultEl.textContent = `❌ ${data.error || '同步失败'}`;
      resultEl.style.color = 'var(--danger)';
    }
  } catch (e) {
    resultEl.textContent = `❌ ${e.message}`;
    resultEl.style.color = 'var(--danger)';
  } finally {
    btn.disabled = false;
    btn.textContent = '⬆️ 同步到服务器';
  }
}

async function fetchCfClearance() {
  if (!confirm('确定获取 CF 验证？将启动 Chrome 浏览器逐个令牌过 Cloudflare 验证。')) return;

  const btn = document.getElementById('btn-fetch-cf');
  const progress = document.getElementById('cf-progress');
  const bar = progress.querySelector('.progress-fill');
  const logEl = document.getElementById('cf-log');

  btn.disabled = true;
  btn.textContent = '获取中...';
  progress.style.display = 'block';
  bar.style.width = '0%';
  logEl.style.display = 'block';
  clearLog('cf-log');
  log('cf-log', '正在启动 Chrome 并获取 CF 验证...', 'info');

  try {
    const data = await workersApi('/api/fetch-cf-clearance', 'POST', {});

    if (!data.success) {
      log('cf-log', `错误: ${data.error || '未知错误'}`, 'error');
      return;
    }

    let totalSuccess = 0;
    let totalFail = 0;
    for (const r of (data.results || [])) {
      if (r.success) {
        log('cf-log', `[成功] ${r.name}: ${r.message}`, 'success');
        totalSuccess++;
      } else {
        log('cf-log', `[失败] ${r.name}: ${r.message}`, 'error');
        totalFail++;
      }
    }

    bar.style.width = '100%';
    log('cf-log', `完成! 成功: ${totalSuccess}, 失败: ${totalFail}`, 'success');
    await loadTokens();
  } catch (e) {
    log('cf-log', '错误: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '🔐 获取 CF 验证';
    setTimeout(() => { progress.style.display = 'none'; }, 2000);
  }
}
