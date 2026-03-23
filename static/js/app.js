// ═══════════════════════════════════════════════════════════════
// 仙侠绘卷 · 主入口
// ═══════════════════════════════════════════════════════════════

import { initRegister } from './modules/register.js';
import { initTokens } from './modules/tokens.js';
import { initApiKeys } from './modules/apikeys.js';
import { initImageGen } from './modules/imageGen.js';
import { initVideoGen } from './modules/videoGen.js';
import { initLogs } from './modules/logs.js';

// ═══════════════════════════════════════════════════════════════
// Tab 切换系统
// ═══════════════════════════════════════════════════════════════

function initTabs() {
  const tabs = document.querySelectorAll('.tab-btn');
  const panels = document.querySelectorAll('.panel');

  tabs.forEach(tab => {
    tab.onclick = () => {
      const target = tab.dataset.tab;

      // 更新 Tab 状态
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      // 更新面板状态
      panels.forEach(p => p.classList.remove('active'));
      const panel = document.getElementById(`panel-${target}`);
      if (panel) panel.classList.add('active');

      // 触发面板显示事件
      if (window.onTabSwitch) {
        window.onTabSwitch(target);
      }
    };
  });
}

// ═══════════════════════════════════════════════════════════════
// 全局工具函数
// ═══════════════════════════════════════════════════════════════

// 日志工具
window.log = (elementId, message, type = 'info') => {
  const el = document.getElementById(elementId);
  if (!el) return;

  const line = document.createElement('div');
  line.className = `log-line ${type}`;
  const time = new Date().toLocaleTimeString();
  line.textContent = `[${time}] ${message}`;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
};

window.clearLog = (elementId) => {
  const el = document.getElementById(elementId);
  if (el) el.innerHTML = '';
};

// 状态指示
window.setStatus = (text, type = 'info') => {
  const statusText = document.getElementById('statusText');
  const statusDot = document.getElementById('statusDot');
  if (statusText) statusText.textContent = text;
  if (statusDot) {
    statusDot.classList.remove('error');
    if (type === 'error') statusDot.classList.add('error');
  }
};

// ═══════════════════════════════════════════════════════════════
// 初始化
// ═══════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', async () => {
  console.log('🚀 仙侠绘卷启动...');
  console.log('Workers URL:', window.WORKERS_URL);

  // 初始化 Tab 系统
  initTabs();

  // 初始化各模块
  try {
    await initRegister();
    console.log('✅ 注册模块就绪');
  } catch (e) {
    console.error('注册模块初始化失败:', e);
  }

  try {
    await initTokens();
    console.log('✅ 灵牌模块就绪');
  } catch (e) {
    console.error('灵牌模块初始化失败:', e);
  }

  try {
    await initApiKeys();
    console.log('✅ 符钥模块就绪');
  } catch (e) {
    console.error('符钥模块初始化失败:', e);
  }

  try {
    await initImageGen();
    console.log('✅ 造像模块就绪');
  } catch (e) {
    console.error('造像模块初始化失败:', e);
  }

  try {
    await initVideoGen();
    console.log('✅ 影像模块就绪');
  } catch (e) {
    console.error('影像模块初始化失败:', e);
  }

  try {
    await initLogs();
    console.log('✅ 日志模块就绪');
  } catch (e) {
    console.error('日志模块初始化失败:', e);
  }

  window.setStatus('就绪', 'info');
  console.log('✨ 仙侠绘卷初始化完成！');
});
