const form = document.getElementById('form');
const modeEl = document.getElementById('mode');
const fpsField = document.getElementById('fpsField');
const intervalField = document.getElementById('intervalField');
const submitBtn = document.getElementById('submit');
const statusEl = document.getElementById('status');
const statusText = document.getElementById('statusText');
const resultEl = document.getElementById('result');
const metaEl = document.getElementById('meta');
const videoLink = document.getElementById('videoLink');
const jsonLink = document.getElementById('jsonLink');
const openFrame = document.getElementById('openFrame');
const saveFrame = document.getElementById('saveFrame');
const closeJobBtn = document.getElementById('closeJob');
const viewer = document.getElementById('viewer');
const viewerImg = document.getElementById('viewerImg');
const viewerIndex = document.getElementById('viewerIndex');
const viewerSlider = document.getElementById('viewerSlider');
const viewerStrip = document.getElementById('viewerStrip');
const prevBtn = document.getElementById('prevBtn');
const nextBtn = document.getElementById('nextBtn');
const playToggle = document.getElementById('playToggle');
const urlInput = document.getElementById('url');
const urlClear = document.getElementById('urlClear');

const JOB_KEY = 'douyin_frames_current_job';

/** @type {{ urls: string[], index: number, playTimer: number|null, jobId: string|null }} */
const gallery = {
  urls: [],
  index: 0,
  playTimer: null,
  jobId: null,
};

// 先挡住表单默认提交，避免整页刷新回到初始态
form.addEventListener('submit', (e) => {
  e.preventDefault();
  startExtract();
});
submitBtn.addEventListener('click', (e) => {
  e.preventDefault();
  startExtract();
});

enhanceSelects(form);
modeEl.addEventListener('change', syncModeFields);
syncModeFields();
bindUrlClear();
bindViewer();
bindJobLifecycle();

function syncUrlClear() {
  if (!urlClear || !urlInput) return;
  urlClear.hidden = !urlInput.value.trim();
}

function bindUrlClear() {
  if (!urlInput || !urlClear) return;
  syncUrlClear();
  urlInput.addEventListener('input', syncUrlClear);
  urlClear.addEventListener('click', () => {
    urlInput.value = '';
    syncUrlClear();
    urlInput.focus();
  });
}

function syncModeFields() {
  const mode = modeEl.value;
  fpsField.hidden = mode !== 'fps';
  intervalField.hidden = mode !== 'seconds';
}

function setStatusRunning() {
  statusEl.hidden = false;
  statusEl.classList.remove('is-done', 'is-error');
}

function setStatusDone(message) {
  statusEl.hidden = false;
  statusEl.classList.remove('is-error');
  statusEl.classList.add('is-done');
  statusText.textContent = message;
  statusText.classList.remove('error');
}

function setStatusError(message) {
  statusEl.hidden = false;
  statusEl.classList.remove('is-done');
  statusEl.classList.add('is-error');
  statusText.textContent = message;
  statusText.classList.add('error');
}

/** 用深色自定义菜单替换原生 select，避免 Windows 白底浅字 */
function enhanceSelects(root) {
  root.querySelectorAll('select').forEach((select) => {
    if (select.closest('.custom-select')) return;

    const wrap = document.createElement('div');
    wrap.className = 'custom-select';
    select.parentNode.insertBefore(wrap, select);
    wrap.appendChild(select);

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'custom-select__trigger';
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');

    const label = document.createElement('span');
    label.className = 'custom-select__label';
    const chevron = document.createElement('span');
    chevron.className = 'custom-select__chevron';
    chevron.setAttribute('aria-hidden', 'true');
    trigger.append(label, chevron);

    const menu = document.createElement('ul');
    menu.className = 'custom-select__menu';
    menu.setAttribute('role', 'listbox');

    const options = [...select.options].map((opt, index) => {
      const li = document.createElement('li');
      li.className = 'custom-select__option';
      li.setAttribute('role', 'option');
      li.dataset.value = opt.value;
      li.textContent = opt.textContent;
      if (opt.selected) li.classList.add('is-selected');
      li.addEventListener('click', () => {
        select.selectedIndex = index;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        sync();
        close();
      });
      menu.appendChild(li);
      return li;
    });

    wrap.append(trigger, menu);

    function sync() {
      const current = select.options[select.selectedIndex];
      label.textContent = current?.textContent || '';
      options.forEach((li, i) => {
        li.classList.toggle('is-selected', i === select.selectedIndex);
      });
    }

    function open() {
      document.querySelectorAll('.custom-select.is-open').forEach((el) => {
        if (el !== wrap) el.classList.remove('is-open');
      });
      wrap.classList.add('is-open');
      trigger.setAttribute('aria-expanded', 'true');
    }

    function close() {
      wrap.classList.remove('is-open');
      trigger.setAttribute('aria-expanded', 'false');
    }

    trigger.addEventListener('click', (e) => {
      e.preventDefault();
      if (wrap.classList.contains('is-open')) close();
      else open();
    });

    sync();
  });

  document.addEventListener('click', (e) => {
    document.querySelectorAll('.custom-select.is-open').forEach((el) => {
      if (!el.contains(e.target)) {
        el.classList.remove('is-open');
        el.querySelector('.custom-select__trigger')?.setAttribute('aria-expanded', 'false');
      }
    });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.custom-select.is-open').forEach((el) => {
        el.classList.remove('is-open');
        el.querySelector('.custom-select__trigger')?.setAttribute('aria-expanded', 'false');
      });
    }
  });
}

let extracting = false;

async function startExtract() {
  if (extracting) return;
  const url = (urlInput?.value || '').trim();
  if (!url) {
    setStatusError('请先粘贴抖音视频链接');
    urlInput?.focus();
    return;
  }

  extracting = true;
  stopAutoplay();
  resultEl.hidden = true;
  viewer.hidden = true;
  setStatusRunning();
  statusText.textContent = '任务已提交，正在解析…';
  statusText.classList.remove('error');
  submitBtn.disabled = true;

  const previousJobId = getStoredJobId();

  const body = {
    url,
    mode: modeEl.value,
    fps: Number(document.getElementById('fps').value) || 1,
    interval: Number(document.getElementById('interval').value) || 1,
    format: document.getElementById('format').value,
    releaseJobId: previousJobId || undefined,
  };

  try {
    const create = await fetch('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const created = await create.json();
    if (!create.ok) throw new Error(created.error || '创建任务失败');

    setStoredJobId(created.jobId);
    gallery.jobId = created.jobId;

    const result = await pollJob(created.jobId);
    renderResult(result);
    const delayMin = created.cleanup?.afterReleaseMin ?? 10;
    setStatusDone(
      `完成：导出 ${result.frames.count} 张图片（关闭或换任务后约 ${delayMin} 分钟清理）`,
    );
  } catch (err) {
    setStatusError(err.message || String(err));
  } finally {
    extracting = false;
    submitBtn.disabled = false;
  }
}

async function pollJob(jobId) {
  const labels = {
    queued: '排队中…',
    resolve: '正在解析抖音视频…',
    download: '正在下载原视频…',
    probe: '正在读取视频信息…',
    frames: '正在导出帧图片…',
    done: '完成',
    error: '失败',
  };

  for (;;) {
    await sleep(800);
    const res = await fetch(`/api/jobs/${jobId}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '查询失败');

    statusText.textContent = data.message || labels[data.stage] || data.stage;

    if (data.stage === 'done') return data.result;
    if (data.stage === 'error') throw new Error(data.message || '任务失败');
  }
}

function renderResult(result) {
  resultEl.hidden = false;
  gallery.jobId = result.jobId;
  setStoredJobId(result.jobId);

  const { meta, video, frames } = result;
  metaEl.innerHTML = `
    <div><strong>作者</strong>：${escapeHtml(meta.author || '未知')}</div>
    <div><strong>描述</strong>：${escapeHtml(meta.desc || '（无）')}</div>
    <div><strong>分辨率</strong>：${video.width || '?'}×${video.height || '?'}</div>
    <div><strong>时长</strong>：${video.duration ? video.duration.toFixed(2) + 's' : '?'}</div>
    <div><strong>帧数</strong>：${frames.count}</div>
    <div><strong>输出目录</strong>：output/${result.jobId}/frames</div>
  `;

  videoLink.href = result.videoUrl;
  jsonLink.href = result.resultUrl;

  const urls = frames.names.map((name) => `${result.framesUrlPrefix}${name}`);
  setupGallery(urls);
}

function bindJobLifecycle() {
  // 刷新/回到页面：取消「离开页面」触发的延迟清理
  const existing = getStoredJobId();
  if (existing) {
    fetch(`/api/jobs/${existing}/keep`, { method: 'POST' }).catch(() => {});
  }

  closeJobBtn?.addEventListener('click', async () => {
    const jobId = gallery.jobId || getStoredJobId();
    if (!jobId) {
      resultEl.hidden = true;
      setStatusDone('当前没有可关闭的任务');
      return;
    }
    try {
      const info = await releaseCurrentJob(jobId, 'closed_by_user');
      stopAutoplay();
      resultEl.hidden = true;
      viewer.hidden = true;
      gallery.urls = [];
      gallery.jobId = null;
      clearStoredJobId();
      const mins = info.delayMs != null ? Math.round(info.delayMs / 60000) : 10;
      setStatusDone(
        info.removed
          ? '任务已关闭，数据已清理'
          : `任务已关闭，约 ${mins} 分钟后自动清理服务器数据`,
      );
    } catch (err) {
      setStatusError(err.message || String(err));
    }
  });

  // 关闭/离开页面时标记延迟清理
  window.addEventListener('pagehide', () => {
    const jobId = gallery.jobId || getStoredJobId();
    if (!jobId) return;
    const body = JSON.stringify({ reason: 'page_leave' });
    const blob = new Blob([body], { type: 'application/json' });
    navigator.sendBeacon?.(`/api/jobs/${jobId}/release`, blob);
  });
}

async function releaseCurrentJob(jobId, reason) {
  const res = await fetch(`/api/jobs/${jobId}/release`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || '关闭任务失败');
  return data;
}

function getStoredJobId() {
  try {
    return sessionStorage.getItem(JOB_KEY) || null;
  } catch {
    return null;
  }
}

function setStoredJobId(id) {
  try {
    if (id) sessionStorage.setItem(JOB_KEY, id);
  } catch {
    // ignore
  }
}

function clearStoredJobId() {
  try {
    sessionStorage.removeItem(JOB_KEY);
  } catch {
    // ignore
  }
}

function setupGallery(urls) {
  stopAutoplay();
  gallery.urls = urls;
  gallery.index = 0;
  viewer.hidden = urls.length === 0;
  saveFrame.disabled = urls.length === 0;
  if (!urls.length) return;

  viewerSlider.min = '0';
  viewerSlider.max = String(urls.length - 1);
  viewerSlider.value = '0';

  // 缩略图全部渲染，懒加载；大量帧也可横向拖动浏览
  viewerStrip.innerHTML = urls
    .map(
      (url, i) => `
      <button type="button" class="viewer__thumb" data-index="${i}" title="第 ${i + 1} 帧">
        <img src="${url}" alt="frame ${i + 1}" loading="lazy" decoding="async" />
      </button>`,
    )
    .join('');

  showFrame(0);
}

function bindViewer() {
  prevBtn.addEventListener('click', () => showFrame(gallery.index - 1));
  nextBtn.addEventListener('click', () => showFrame(gallery.index + 1));
  viewerSlider.addEventListener('input', () => {
    showFrame(Number(viewerSlider.value));
  });
  playToggle.addEventListener('click', () => {
    if (gallery.playTimer) stopAutoplay();
    else startAutoplay();
  });
  saveFrame.addEventListener('click', () => {
    saveCurrentFrame().catch((err) => {
      console.error(err);
      alert(err.message || '保存失败');
    });
  });
  viewerStrip.addEventListener('click', (e) => {
    const btn = e.target.closest('.viewer__thumb');
    if (!btn) return;
    showFrame(Number(btn.dataset.index));
  });
  document.addEventListener('keydown', (e) => {
    if (viewer.hidden) return;
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      showFrame(gallery.index - 1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      showFrame(gallery.index + 1);
    } else if (e.key === ' ') {
      // 空格切换自动播放（避免页面滚动）
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      e.preventDefault();
      if (gallery.playTimer) stopAutoplay();
      else startAutoplay();
    }
  });
}

function showFrame(index) {
  if (!gallery.urls.length) return;
  const max = gallery.urls.length - 1;
  const next = Math.max(0, Math.min(max, index));
  gallery.index = next;

  const url = gallery.urls[next];
  viewerImg.src = url;
  viewerIndex.textContent = `${next + 1} / ${gallery.urls.length}`;
  viewerSlider.value = String(next);
  openFrame.href = url;
  saveFrame.disabled = false;

  viewerStrip.querySelectorAll('.viewer__thumb').forEach((el, i) => {
    el.classList.toggle('is-active', i === next);
  });

  const active = viewerStrip.querySelector('.viewer__thumb.is-active');
  active?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
}

async function saveCurrentFrame() {
  if (!gallery.urls.length) throw new Error('没有可保存的帧');
  const url = gallery.urls[gallery.index];
  const nameFromUrl = url.split('/').pop()?.split('?')[0] || `frame_${gallery.index + 1}.jpg`;
  const pad = String(gallery.index + 1).padStart(6, '0');
  const filename = nameFromUrl.startsWith('frame_') ? nameFromUrl : `frame_${pad}.jpg`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`下载当前帧失败 HTTP ${res.status}`);
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(objectUrl);
}

function startAutoplay() {
  if (!gallery.urls.length) return;
  stopAutoplay();
  playToggle.textContent = '暂停';
  playToggle.classList.add('is-playing');
  gallery.playTimer = window.setInterval(() => {
    const next = gallery.index + 1;
    if (next > gallery.urls.length - 1) {
      stopAutoplay();
      return;
    }
    showFrame(next);
  }, 120);
}

function stopAutoplay() {
  if (gallery.playTimer) {
    clearInterval(gallery.playTimer);
    gallery.playTimer = null;
  }
  playToggle.textContent = '自动播放';
  playToggle.classList.remove('is-playing');
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
