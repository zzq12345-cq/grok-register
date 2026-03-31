// ═══════════════════════════════════════════════════════════════
// 视频生成模块
// ═══════════════════════════════════════════════════════════════

import { workersApi, readStream, log, clearLog } from './utils.js';

export function initVideoGen() {
  document.getElementById('btn-generate-video').onclick = startVideoGen;
  clearLog('video-log');
}

async function startVideoGen() {
  const imageUrl = document.getElementById('video-url').value;
  const postId = document.getElementById('video-post-id').value;
  const prompt = document.getElementById('video-prompt').value.trim();
  const duration = parseInt(document.getElementById('video-duration').value) || 6;
  const resolution = document.getElementById('video-resolution').value;
  const mode = document.getElementById('video-mode').value;

  if (!imageUrl) {
    alert('请先在「图灵造像」页面选择一张图片');
    return;
  }

  if (!prompt) {
    alert('请输入动作提示词');
    return;
  }

  const btn = document.getElementById('btn-generate-video');
  const progress = document.getElementById('video-progress');
  const result = document.getElementById('video-result');
  const status = progress.querySelector('.progress-fill');

  btn.disabled = true;
  btn.textContent = '合成中...';
  progress.style.display = 'block';
  status.style.width = '0%';
  result.innerHTML = '';
  clearLog('video-log');

  log('video-log', '开始合成视频...', 'info');

  try {
    await readStream(
      `/api/video/generate`,
      { image_url: imageUrl, post_id: postId, prompt, duration, resolution, mode },
      {
        onProgress: (data) => {
          status.style.width = data.progress + '%';
          log('video-log', data.message || `进度: ${data.progress}%`, 'info');
        },
        onInfo: (data) => {
          log('video-log', data.message, 'info');
        },
        onData: (data) => {
          if (data.video_url) {
            showVideoResult(data.video_url);
            log('video-log', '视频生成成功!', 'success');
          }
        },
        onError: (msg) => {
          log('video-log', msg, 'error');
        },
        onDone: () => {
          btn.disabled = false;
          btn.textContent = '🎬 生成视频';
          setTimeout(() => { progress.style.display = 'none'; }, 2000);
        }
      }
    );
  } catch (e) {
    log('video-log', '合成失败: ' + e.message, 'error');
    btn.disabled = false;
    btn.textContent = '🎬 生成视频';
  }
}

function showVideoResult(videoUrl) {
  const result = document.getElementById('video-result');
  result.innerHTML = `
    <h3>✨ 影像合成完成</h3>
    <video controls autoplay loop>
      <source src="${videoUrl}" type="video/mp4">
      您的浏览器不支持视频播放
    </video>
    <div style="margin-top: 16px;">
      <a href="${videoUrl}" download class="btn btn-secondary">下载视频</a>
    </div>
  `;
  result.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// 全局函数供图片页面调用
window.setVideoImage = function(url, postId, prompt) {
  document.getElementById('video-url').value = url;
  document.getElementById('video-post-id').value = postId;
  document.getElementById('video-prompt').value = prompt || '';

  const preview = document.getElementById('video-preview');
  document.getElementById('video-preview-img').src = url;
  document.getElementById('video-preview-prompt').textContent = prompt || '';
  preview.style.display = 'flex';
};
