// ═══════════════════════════════════════════════════════════════
// 工具函数模块
// ═══════════════════════════════════════════════════════════════

// API 封装
export async function api(url, method = 'GET', body = null) {
  const options = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) options.body = JSON.stringify(body);

  try {
    const resp = await fetch(url, options);
    if (!resp.ok) {
      const errorText = await resp.text();
      try {
        const errorJson = JSON.parse(errorText);
        throw new Error(errorJson.detail || errorJson.message || errorJson.error || resp.statusText);
      } catch {
        throw new Error(errorText || resp.statusText);
      }
    }
    const text = await resp.text();
    return text ? JSON.parse(text) : null;
  } catch (e) {
    throw e;
  }
}

// Workers API 封装 (通过 Flask 代理，避免 CORS)
export async function workersApi(endpoint, method = 'GET', body = null) {
  // 走本地 Flask 代理路由，不直接跨域
  const url = endpoint;
  const options = {
    method,
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
  };
  if (body) options.body = JSON.stringify(body);

  try {
    const resp = await fetch(url, options);
    if (!resp.ok) {
      const errorText = await resp.text();
      try {
        const errorJson = JSON.parse(errorText);
        throw new Error(errorJson.detail || errorJson.message || errorJson.error || resp.statusText);
      } catch {
        throw new Error(errorText || resp.statusText);
      }
    }
    const text = await resp.text();
    return text ? JSON.parse(text) : null;
  } catch (e) {
    throw e;
  }
}

// 日志输出
export function log(elementId, message, type = 'info') {
  const logEl = document.getElementById(elementId);
  if (!logEl) return;

  const line = document.createElement('div');
  line.className = `log-line ${type}`;
  const time = new Date().toLocaleTimeString();
  line.textContent = `[${time}] ${message}`;

  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

export function clearLog(elementId) {
  const el = document.getElementById(elementId);
  if (el) el.innerHTML = '';
}

// SSE 流读取
export async function readStream(url, body, callbacks) {
  const { onProgress, onData, onInfo, onError, onDone } = callbacks;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let currentEvent = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        if (onDone) onDone({});
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) { currentEvent = null; continue; }
        if (trimmed.startsWith('event: ')) { currentEvent = trimmed.substring(7).trim(); continue; }
        if (trimmed.startsWith('data: ')) {
          try {
            const jsonStr = trimmed.substring(6);
            const data = JSON.parse(jsonStr);
            const eventType = currentEvent || data.type;

            switch (eventType) {
              case 'progress': if (onProgress) onProgress(data); break;
              case 'image':
              case 'complete': if (onData) onData(data); break;
              case 'info':
              case 'start': if (onInfo) onInfo(data); break;
              case 'error': if (onError) onError(data.message || data.error || '未知错误'); break;
              case 'done': if (onDone) onDone(data); return;
            }
          } catch (e) {
            console.warn('解析 SSE 数据失败:', line, e);
          }
        }
      }
    }
  } catch (e) {
    if (onError) onError(e.message);
    if (onDone) onDone({});
  }
}

// 事件总线
class EventBus {
  constructor() { this.listeners = {}; }
  on(event, callback) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(callback);
  }
  emit(event, data) {
    if (this.listeners[event]) {
      this.listeners[event].forEach(cb => cb(data));
    }
  }
}

export const bus = new EventBus();

// 复制到剪贴板
export async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
    return true;
  }
}

// 下载文件
export function downloadJSON(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
