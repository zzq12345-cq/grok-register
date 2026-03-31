// ═══════════════════════════════════════════════════════════════
// API Key 管理模块
// ═══════════════════════════════════════════════════════════════

import { workersApi, copyToClipboard } from './utils.js';

export async function initApiKeys() {
  document.getElementById('btn-create-apikey').onclick = createApiKey;
  document.getElementById('btn-copy-apikey').onclick = copyNewKey;
  await loadApiKeys();
}

async function loadApiKeys() {
  try {
    const data = await workersApi('/api/api-keys');
    renderApiKeyList(data.keys || []);
    updateApiKeyStats(data.keys || []);
  } catch (e) {
    console.error('加载密钥失败', e);
    document.getElementById('apikey-list').innerHTML =
      `<div class="empty-state">加载失败: ${e.message}</div>`;
  }
}

function updateApiKeyStats(keys) {
  const total = keys.length;
  const enabled = keys.filter(k => k.enabled !== false).length;
  document.getElementById('apikey-stat-total').textContent = total;
  document.getElementById('apikey-stat-enabled').textContent = enabled;
}

async function createApiKey() {
  const name = document.getElementById('apikey-name').value.trim() || undefined;

  try {
    const data = await workersApi('/api/api-keys', 'POST', { name });

    // 显示新密钥
    const display = document.getElementById('new-apikey-display');
    const valueEl = document.getElementById('new-apikey-value');
    valueEl.textContent = data.key;
    display.style.display = 'block';

    // 清空输入
    document.getElementById('apikey-name').value = '';

    // 刷新列表
    await loadApiKeys();
  } catch (e) {
    alert('创建失败: ' + e.message);
  }
}

async function copyNewKey() {
  const key = document.getElementById('new-apikey-value').textContent;
  const success = await copyToClipboard(key);
  if (success) {
    alert('已复制到剪贴板！');
  }
}

window.toggleApiKey = async (id) => {
  try {
    await workersApi(`/api/api-keys/${id}/toggle`, 'POST');
    await loadApiKeys();
  } catch (e) {
    alert('操作失败: ' + e.message);
  }
};

window.deleteApiKey = async (id) => {
  if (!confirm('确定删除此密钥？此操作不可撤销')) return;

  try {
    await workersApi(`/api/api-keys/${id}`, 'DELETE');
    await loadApiKeys();
  } catch (e) {
    alert('删除失败: ' + e.message);
  }
}

window.copyApiKey = async (key) => {
  const success = await copyToClipboard(key);
  if (success) {
    alert('已复制到剪贴板！');
  }
}

function renderApiKeyList(keys) {
  const list = document.getElementById('apikey-list');

  if (keys.length === 0) {
    list.innerHTML = '<div class="empty-state">暂无密钥</div>';
    return;
  }

  list.innerHTML = keys.map(k => `
    <div class="token-item">
      <div class="token-info">
        <div class="token-name">${k.name || '未命名密钥'}</div>
        <div class="token-meta">
          创建: ${new Date(k.created_at).toLocaleString()}
          ${k.enabled === false ? ' · 已禁用' : ''}
        </div>
      </div>
      <span class="status-badge ${k.enabled !== false ? 'active' : 'inactive'}">
        ${k.enabled !== false ? '已启用' : '已禁用'}
      </span>
      <button class="btn btn-secondary btn-sm" onclick="toggleApiKey('${k.id}')">
        ${k.enabled !== false ? '禁用' : '启用'}
      </button>
      <button class="btn btn-secondary btn-sm" onclick="copyApiKey('${k.key}')">
        复制
      </button>
      <button class="btn btn-danger btn-sm" onclick="deleteApiKey('${k.id}')">删除</button>
    </div>
  `).join('');
}
