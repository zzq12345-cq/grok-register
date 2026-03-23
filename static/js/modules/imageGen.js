// ═══════════════════════════════════════════════════════════════
// 图片生成模块
// ═══════════════════════════════════════════════════════════════

import { workersApi, readStream, log, clearLog } from './utils.js';

let imageData = [];
let selectedIndex = -1;

export async function initImageGen() {
  document.getElementById('btn-generate-images').onclick = startGenerate;
  document.getElementById('btn-load-more').onclick = loadMore;

  imageData = [];
  selectedIndex = -1;
}

async function startGenerate() {
  const prompt = document.getElementById('image-prompt').value.trim();
  const count = parseInt(document.getElementById('image-count').value) || 10;
  const aspect = document.getElementById('image-aspect').value;
  const nsfw = document.getElementById('image-nsfw').value === 'true';

  if (!prompt) {
    alert('请输入提示词');
    return;
  }

  const btn = document.getElementById('btn-generate-images');
  const progress = document.getElementById('image-progress');
  const statusText = document.getElementById('image-status');

  btn.disabled = true;
  btn.textContent = '造像中...';
  progress.style.display = 'block';
  clearLog('image-log');

  try {
    await readStream(
      `/api/imagine`,
      { prompt, aspect_ratio: aspect, enable_nsfw: nsfw, count },
      {
        onProgress: (data) => {
          const bar = progress.querySelector('.progress-fill');
          bar.style.width = `${data.progress}%`;
          statusText.textContent = `生成中... ${data.current}/${data.total}`;
        },
        onInfo: (data) => {
          log('image-log', data.message, 'info');
        },
        onData: (data) => {
          if (data.url || data.image_url) {
            addImage(data);
          }
        },
        onError: (data) => {
          log('image-log', data, 'error');
        },
        onDone: () => {
          btn.disabled = false;
          btn.textContent = '🖼️ 开始造像';
          statusText.textContent = '完成！';
          setTimeout(() => { progress.style.display = 'none'; }, 2000);
        }
      }
    );
  } catch (e) {
    log('image-log', '生成失败: ' + e.message, 'error');
    btn.disabled = false;
    btn.textContent = '🖼️ 开始造像';
    statusText.textContent = '失败';
  }
}

function addImage(data) {
  const url = data.url || data.image_url;
  const prompt = data.prompt || document.getElementById('image-prompt').value;
  const postId = data.post_id || data.id || Date.now().toString(36);

  imageData.push({ url, prompt, postId });

  const grid = document.getElementById('image-grid');
  const empty = grid.querySelector('.empty-state');
  if (empty) empty.remove();

  const card = document.createElement('div');
  card.className = 'image-card';
  card.dataset.index = imageData.length - 1;
  card.innerHTML = `
    <img src="${url}" alt="${prompt}">
    <div class="image-info">
      <div class="image-prompt">${prompt}</div>
    </div>
  `;

  card.onclick = () => selectImage(imageData.length - 1);
  grid.appendChild(card);

  log('image-log', `已生成图片 ${imageData.length}`, 'success');
}

function selectImage(index) {
  // 清除之前的选中
  document.querySelectorAll('.image-card').forEach(c => c.classList.remove('selected'));

  if (index === selectedIndex) {
    selectedIndex = -1;
    return;
  }

  selectedIndex = index;
  const cards = document.querySelectorAll('.image-card');
  if (cards[index]) {
    cards[index].classList.add('selected');
  }

  // 传递到视频页面
  const data = imageData[index];
  window.selectedVideoImage = data;

  // 更新视频预览
  document.getElementById('video-url').value = data.url;
  document.getElementById('video-post-id').value = data.postId;

  const preview = document.getElementById('video-preview');
  document.getElementById('video-preview-img').src = data.url;
  document.getElementById('video-preview-prompt').textContent = data.prompt;
  preview.style.display = 'flex';

  // 跳转提示
  alert('已选择图片，请切换到「影像合成」页面生成视频');
}

async function loadMore() {
  // 实现加载更多逻辑
  log('image-log', '加载更多功能开发中...', 'info');
}
