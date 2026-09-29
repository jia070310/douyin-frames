import { looksLikeDirectVideoUrl, buildBookmarklet } from './bookmarklet.js?v=1';
import { bindWindowControls } from './windowControls.js?v=1';

const form = document.getElementById('form');
const modeEl = document.getElementById('mode');
const fpsField = document.getElementById('fpsField');
const intervalField = document.getElementById('intervalField');
const submitBtn = document.getElementById('submit');
const statusEl = document.getElementById('status');
const statusText = document.getElementById('statusText');
const statusLogWrap = document.getElementById('statusLogWrap');
const statusLogEl = document.getElementById('statusLog');
const resultEl = document.getElementById('result');
const metaEl = document.getElementById('meta');
const videoLink = document.getElementById('videoLink');
const jsonLink = document.getElementById('jsonLink');
const openFrame = document.getElementById('openFrame');
const saveFrame = document.getElementById('saveFrame');
const closeJobBtn = document.getElementById('closeJob');
const clearCacheBtn = document.getElementById('clearCache');
const viewer = document.getElementById('viewer');
const viewerImg = document.getElementById('viewerImg');
const viewerIndex = document.getElementById('viewerIndex');
const viewerSlider = document.getElementById('viewerSlider');
const viewerStrip = document.getElementById('viewerStrip');
const prevBtn = document.getElementById('prevBtn');
const nextBtn = document.getElementById('nextBtn');
const playToggle = document.getElementById('playToggle');
const frameLightbox = document.getElementById('frameLightbox');
const lightboxImg = document.getElementById('lightboxImg');
const lightboxMeta = document.getElementById('lightboxMeta');
const lightboxClose = document.getElementById('lightboxClose');
const lightboxBackdrop = document.getElementById('lightboxBackdrop');
const lightboxPrev = document.getElementById('lightboxPrev');
const lightboxNext = document.getElementById('lightboxNext');
const urlInput = document.getElementById('url');
const urlClear = document.getElementById('urlClear');
const videoUrlInput = document.getElementById('videoUrl');
const videoUrlClear = document.getElementById('videoUrlClear');
const videoFileInput = document.getElementById('videoFile');
const douyinCookieInput = document.getElementById('douyinCookie');
const cookieSaveBtn = document.getElementById('cookieSave');
const cookieClearBtn = document.getElementById('cookieClear');
const cookieStatusEl = document.getElementById('cookieStatus');
const agentStatusEl = document.getElementById('agentStatus');
const emptyState = document.getElementById('emptyState');
const statusBarHint = document.getElementById('statusBarHint');

const JOB_KEY = 'douyin_frames_current_job';

/** @type {{ urls: string[], index: number, playTimer: number|null, jobId: string|null }} */
const gallery = {
  urls: [],
  index: 0,
  playTimer: null,
  jobId: null,
};

/** 抽帧 API 根地址 */
let remoteBase = window.location.origin;

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
bindClearable(urlInput, urlClear);
bindClearable(videoUrlInput, videoUrlClear);
bindViewer();
bindJobLifecycle();
bindCookiePanel();
bindBookmarklet();
bindWindowControls();
bindAbout();
initClientConfig();

let extracting = false;

function bindAbout() {
  const dialog = document.getElementById('aboutDialog');
  const openers = [
    document.getElementById('aboutOpen'),
    document.getElementById('aboutOpenFooter'),
  ].filter(Boolean);
  const closers = [
    document.getElementById('aboutClose'),
    document.getElementById('aboutBackdrop'),
  ].filter(Boolean);
  if (!dialog || !openers.length) return;

  const open = () => {
    dialog.hidden = false;
    document.body.classList.add('has-about');
    document.getElementById('aboutClose')?.focus();
  };
  const close = () => {
    dialog.hidden = true;
    document.body.classList.remove('has-about');
  };

  openers.forEach((el) => el.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    open();
  }));
  closers.forEach((el) => el.addEventListener('click', (e) => {
    e.preventDefault();
    close();
  }));
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !dialog.hidden) close();
  });

  fetch(remoteUrl('/api/health'))
    .then((r) => r.json())
    .then((data) => {
      const ver = document.getElementById('aboutVersion');
      if (ver && data?.version) ver.textContent = `v${data.version}`;
    })
    .catch(() => {});
}

function bindClearable(input, clearBtn) {
  if (!input || !clearBtn) return;
  const sync = () => {
    clearBtn.hidden = !input.value.trim();
  };
  sync();
  input.addEventListener('input', sync);
  clearBtn.addEventListener('click', () => {
    input.value = '';
    sync();
    input.focus();
  });
}

function bindBookmarklet() {
  const link = document.getElementById('bookmarkletLink');
  if (!link) return;
  const href = buildBookmarklet(window.location.origin);
  link.setAttribute('href', href);
  link.addEventListener('click', (e) => {
    e.preventDefault();
    alert(
      '请把「抖音抽帧」链接拖到浏览器收藏栏（不要单击）。\n\n然后在抖音作品页点播放 → 再点收藏栏里的书签，会自动带回直链（不必登录，登录弹窗可忽略）。',
    );
  });
}

function bindCookiePanel() {
  if (!douyinCookieInput) return;

  const setStatus = (text) => {
    if (cookieStatusEl) cookieStatusEl.textContent = text || '';
  };

  fetch(`${remoteBase}/api/cookies`)
    .then((r) => r.json())
    .then((data) => {
      if (data?.hasCookie) setStatus(`已保存（${data.length} 字符）`);
      else setStatus('');
    })
    .catch(() => {});

  cookieSaveBtn?.addEventListener('click', async () => {
    const cookie = douyinCookieInput.value.trim();
    if (!cookie) {
      setStatus('请先粘贴 Cookie');
      return;
    }
    cookieSaveBtn.disabled = true;
    try {
      const res = await fetch(`${remoteBase}/api/cookies`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cookie }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '保存失败');
      setStatus(`已保存（${data.length || cookie.length} 字符），可重新解析`);
      douyinCookieInput.value = '';
    } catch (err) {
      setStatus(err?.message || '保存失败');
    } finally {
      cookieSaveBtn.disabled = false;
    }
  });

  cookieClearBtn?.addEventListener('click', async () => {
    cookieClearBtn.disabled = true;
    try {
      await fetch(`${remoteBase}/api/cookies`, { method: 'DELETE' });
      douyinCookieInput.value = '';
      setStatus('已清除');
    } catch {
      setStatus('清除失败');
    } finally {
      cookieClearBtn.disabled = false;
    }
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
  if (emptyState) emptyState.hidden = true;
  if (statusLogEl) statusLogEl.textContent = '';
  if (statusLogWrap) statusLogWrap.hidden = true;
}

function setStatusDone(message) {
  statusEl.hidden = false;
  statusEl.classList.remove('is-error');
  statusEl.classList.add('is-done');
  statusText.textContent = message;
  statusText.classList.remove('error');
  if (statusLogWrap) statusLogWrap.hidden = true;
  if (emptyState) emptyState.hidden = true;
}

function setStatusError(message) {
  statusEl.hidden = false;
  statusEl.classList.remove('is-done');
  statusEl.classList.add('is-error');
  statusText.textContent = message;
  statusText.classList.add('error');
  if (emptyState) emptyState.hidden = true;
}

function renderStatusLog(log) {
  if (!statusLogEl || !statusLogWrap) return;
  if (!Array.isArray(log) || !log.length) {
    statusLogWrap.hidden = true;
    return;
  }
  statusLogWrap.hidden = false;
  const lines = log.map((item) => {
    const ts = item.t ? new Date(item.t).toLocaleTimeString('zh-CN', { hour12: false }) : '';
    const stage = item.stage ? `[${item.stage}] ` : '';
    return `${ts}  ${stage}${item.message || ''}`;
  });
  statusLogEl.textContent = lines.join('\n');
  statusLogEl.scrollTop = statusLogEl.scrollHeight;
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

function remoteUrl(path) {
  if (!path) return remoteBase;
  if (/^https?:\/\//i.test(path)) return path;
  return `${remoteBase}${path.startsWith('/') ? '' : '/'}${path}`;
}

async function initClientConfig() {
  remoteBase = window.location.origin;
  // 浏览器里预览成「窗口」；Electron/Tauri 注入后再去掉该 class
  const inDesktopShell = Boolean(window.electronAPI || window.__TAURI__ || window.douyinFramesDesktop);
  document.body.classList.toggle('is-browser-preview', !inDesktopShell);
  if (statusBarHint) {
    statusBarHint.textContent = inDesktopShell ? '桌面应用' : remoteBase.replace(/^https?:\/\//, '');
  }
  refreshAgentStatus();
  applyQueryVideoUrl();
  await restoreStoredJob();
}

async function restoreStoredJob() {
  const jobId = getStoredJobId();
  if (!jobId) return;
  try {
    const res = await fetch(remoteUrl(`/api/jobs/${jobId}`));
    const data = await res.json().catch(() => ({}));
    if (res.status === 404) {
      clearStoredJobId();
      return;
    }
    if (!res.ok) return;

    gallery.jobId = jobId;
    if (data.stage === 'done' && data.result) {
      renderResult(data.result);
      setStatusDone(`已恢复上次结果：${data.result.frames?.count ?? 0} 张`);
      return;
    }
    if (data.stage === 'error') {
      clearStoredJobId();
      return;
    }
    // 仍在跑：继续轮询
    setStatusRunning();
    statusText.textContent = data.message || '恢复未完成任务…';
    extracting = true;
    submitBtn.disabled = true;
    try {
      const result = await pollJob(jobId);
      renderResult(result);
      setStatusDone(`完成：导出 ${result.frames.count} 张图片`);
    } catch (err) {
      setStatusError(friendlyResolveError(err.message || String(err)));
    } finally {
      extracting = false;
      submitBtn.disabled = false;
    }
  } catch {
    // 忽略启动恢复失败
  }
}

function refreshAgentStatus() {
  if (!agentStatusEl) return;
  agentStatusEl.classList.add('is-on');
  agentStatusEl.classList.remove('is-off');
  agentStatusEl.textContent = '本机就绪 · 解析与抽帧在本机完成';
}

function applyQueryVideoUrl() {
  try {
    const q = new URLSearchParams(window.location.search);
    const vu = q.get('videoUrl');
    if (vu && videoUrlInput) {
      videoUrlInput.value = vu;
      videoUrlInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
  } catch {
    // ignore
  }
}

async function startExtract() {
  if (extracting) return;
  const url = (urlInput?.value || '').trim();
  let videoUrl = (videoUrlInput?.value || '').trim();
  const file = videoFileInput?.files?.[0] || null;

  if (!videoUrl && looksLikeDirectVideoUrl(url)) {
    videoUrl = url;
  }

  if (!file && !url && !videoUrl) {
    setStatusError('请粘贴抖音链接、视频直链，或上传本地视频');
    (urlInput || videoFileInput || videoUrlInput)?.focus();
    return;
  }

  extracting = true;
  stopAutoplay();
  resultEl.hidden = true;
  viewer.hidden = true;
  setStatusRunning();
  statusText.classList.remove('error');
  submitBtn.disabled = true;

  // 若高级里粘了 Cookie 但还没点保存，开始时一并写入
  const pendingCookie = douyinCookieInput?.value?.trim();
  if (pendingCookie) {
    try {
      await fetch(`${remoteBase}/api/cookies`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cookie: pendingCookie }),
      });
      douyinCookieInput.value = '';
      if (cookieStatusEl) cookieStatusEl.textContent = 'Cookie 已随本次任务保存';
    } catch {
      // ignore; resolve may still fail without cookies
    }
  }

  const previousJobId = getStoredJobId();
  const options = {
    mode: modeEl.value,
    fps: Number(document.getElementById('fps').value) || 1,
    interval: Number(document.getElementById('interval').value) || 1,
    format: document.getElementById('format').value,
    releaseJobId: previousJobId || undefined,
  };

  try {
    let jobId;

    if (file) {
      statusText.textContent = `正在读取本地视频（${(file.size / 1024 / 1024).toFixed(1)} MB）…`;
      const created = await uploadVideoJob(file, {
        ...options,
        sourceUrl: url || file.name,
        meta: { sourceUrl: url || file.name, via: 'local-upload', author: '', desc: file.name },
      });
      jobId = created.jobId;
      statusText.textContent = '本机正在抽帧…';
    } else if (videoUrl) {
      statusText.textContent = '本机按直链下载并抽帧…';
      const created = await createServerJob({
        videoUrl,
        meta: url ? { sourceUrl: url, via: 'local-direct-url' } : { via: 'local-direct-url' },
        ...options,
      });
      jobId = created.jobId;
    } else {
      statusText.textContent = '本机解析抖音并处理…';
      const created = await createServerJob({ url, ...options });
      jobId = created.jobId;
    }

    setStoredJobId(jobId);
    gallery.jobId = jobId;

    const result = await pollJob(jobId);
    renderResult(result);
    const n = result.frames?.count ?? 0;
    const isNote = result.contentType === 'images' || result.meta?.contentType === 'images';
    setStatusDone(isNote ? `完成：图文 ${n} 张图片` : `完成：导出 ${n} 张图片`);
  } catch (err) {
    const msg = err.message || String(err);
    if (/任务不存在/i.test(msg)) clearStoredJobId();
    setStatusError(friendlyResolveError(msg));
  } finally {
    extracting = false;
    submitBtn.disabled = false;
  }
}

async function uploadVideoJob(file, jobMeta) {
  let res;
  try {
    res = await fetch(`${remoteBase}/api/jobs/with-video`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Job-Meta': JSON.stringify(jobMeta),
      },
      body: file,
    });
  } catch (err) {
    throw new Error(err?.message || 'Failed to fetch');
  }
  const raw = await res.text();
  let data;
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error(res.ok ? '服务器返回了无法解析的响应' : `上传失败（HTTP ${res.status}）`);
  }
  if (!res.ok) throw new Error(data.error || `上传失败（HTTP ${res.status}）`);
  return data;
}

async function createServerJob(body) {
  let res;
  try {
    res = await fetch(`${remoteBase}/api/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(err?.message || 'Failed to fetch');
  }
  const raw = await res.text();
  let data;
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error(res.ok ? '服务器返回了无法解析的响应' : `创建任务失败（HTTP ${res.status}）`);
  }
  if (!res.ok) throw new Error(data.error || `创建任务失败（HTTP ${res.status}）`);
  return data;
}

function friendlyResolveError(msg) {
  if (/Failed to fetch|NetworkError|Load failed|fetch failed|ECONNREFUSED|network/i.test(msg)) {
    return (
      '连不上本机服务（Failed to fetch）。\n' +
      '请在本项目目录重新运行：npm start\n' +
      '然后用 http://127.0.0.1:3780 打开（不要混用 localhost / 127.0.0.1 两个地址）。'
    );
  }
  if (/任务不存在/i.test(msg)) {
    return '本机服务已重启或旧任务已失效，请重新点击「开始提取」。';
  }
  if (/未能获取该作品|验证码|需登录|页面结构/i.test(msg)) {
    return msg;
  }
  if (/未能获取|风控|captcha|本作品|未能解析|cookies|Cookie|反爬|浏览器/i.test(msg)) {
    return (
      '本机解析失败。一般不必登录；会先试 HTTP，再试本机 Edge/Chrome 打开作品页取直链。\n' +
      '仍失败可改用「本地视频」，或展开「高级」用书签从已打开的作品页带回直链。\n' +
      `详情：${msg}`
    );
  }
  return msg;
}

async function pollJob(jobId) {
  const labels = {
    queued: '排队中…',
    resolve: '本机解析抖音作品…',
    download: '正在下载…',
    probe: '正在读取视频信息…',
    frames: '正在导出帧图片…',
    done: '完成',
    error: '失败',
  };

  for (;;) {
    const res = await fetch(`${remoteBase}/api/jobs/${jobId}`);
    const data = await res.json().catch(() => ({}));
    if (res.status === 404) {
      clearStoredJobId();
      throw new Error(data.error || '任务不存在');
    }
    if (!res.ok) throw new Error(data.error || '查询失败');

    statusText.textContent = data.message || labels[data.stage] || data.stage;
    if (data.stage === 'done' || data.stage === 'error') {
      if (statusLogWrap) statusLogWrap.hidden = true;
    } else {
      renderStatusLog(data.log);
    }

    if (data.stage === 'done') return data.result;
    if (data.stage === 'error') throw new Error(data.message || '任务失败');

    // 解析阶段更勤轮询，便于动态显示详情
    await sleep(data.stage === 'resolve' ? 350 : 700);
  }
}

function renderResult(result) {
  resultEl.hidden = false;
  if (emptyState) emptyState.hidden = true;
  gallery.jobId = result.jobId;
  setStoredJobId(result.jobId);

  const { meta, video, frames } = result;
  const isNote = result.contentType === 'images' || meta?.contentType === 'images';
  const typeLabel = isNote ? '图文' : '视频抽帧';

  metaEl.innerHTML = `
    <div><strong>类型</strong>：${escapeHtml(typeLabel)}</div>
    <div><strong>作者</strong>：${escapeHtml(meta.author || '未知')}</div>
    <div><strong>描述</strong>：${escapeHtml(meta.desc || '（无）')}</div>
    ${
      isNote
        ? `<div><strong>图片数</strong>：${frames.count}</div>`
        : `<div><strong>分辨率</strong>：${video?.width || '?'}×${video?.height || '?'}</div>
    <div><strong>时长</strong>：${video?.duration ? video.duration.toFixed(2) + 's' : '?'}</div>
    <div><strong>帧数</strong>：${frames.count}</div>`
    }
    <div><strong>输出目录</strong>：output/${result.jobId}/frames</div>
  `;

  if (videoLink) {
    if (isNote || !result.videoUrl) {
      videoLink.hidden = true;
      videoLink.removeAttribute('href');
    } else {
      videoLink.hidden = false;
      videoLink.href = remoteUrl(result.videoUrl);
      videoLink.textContent = '原视频';
    }
  }
  if (openFrame) openFrame.textContent = isNote ? '打开图片' : '打开帧';
  if (saveFrame) saveFrame.textContent = isNote ? '保存图片' : '保存帧';
  jsonLink.href = remoteUrl(result.resultUrl);

  const prefix = remoteUrl(result.framesUrlPrefix);
  const urls = frames.names.map((name) => `${prefix}${name}`);
  setupGallery(urls);
}

function bindJobLifecycle() {
  closeJobBtn?.addEventListener('click', async () => {
    const jobId = gallery.jobId || getStoredJobId();
    if (!jobId) {
      resultEl.hidden = true;
      if (emptyState) emptyState.hidden = false;
      setStatusDone('当前没有可关闭的任务');
      return;
    }
    try {
      await releaseCurrentJob(jobId, 'closed_by_user');
      stopAutoplay();
      resultEl.hidden = true;
      viewer.hidden = true;
      gallery.urls = [];
      gallery.jobId = null;
      clearStoredJobId();
      if (emptyState) emptyState.hidden = false;
      setStatusDone('已关闭当前任务（缓存仍保留，可用「清理缓存」删除）');
    } catch (err) {
      setStatusError(err.message || String(err));
    }
  });

  clearCacheBtn?.addEventListener('click', async () => {
    if (extracting) {
      setStatusError('正在抽帧，请稍后再清理');
      return;
    }
    const ok = window.confirm('清空本机抽帧缓存与上传临时文件？当前预览也会关闭。');
    if (!ok) return;
    clearCacheBtn.disabled = true;
    try {
      const res = await fetch(remoteUrl('/api/cleanup'), { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '清理失败');
      stopAutoplay();
      resultEl.hidden = true;
      viewer.hidden = true;
      gallery.urls = [];
      gallery.jobId = null;
      clearStoredJobId();
      if (emptyState) emptyState.hidden = false;
      const mb = data.freedBytes != null ? (data.freedBytes / 1024 / 1024).toFixed(1) : '0';
      setStatusDone(`已清理 ${data.removed ?? 0} 个任务缓存，约释放 ${mb} MB`);
    } catch (err) {
      setStatusError(err.message || String(err));
    } finally {
      clearCacheBtn.disabled = false;
    }
  });
}

async function releaseCurrentJob(jobId, reason) {
  const res = await fetch(remoteUrl(`/api/jobs/${jobId}/release`), {
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
  const stage = document.querySelector('.viewer__stage');
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
    // 真正拖动滚动后会 suppress；纯单击走这里
    if (viewerStrip.dataset.suppressClick === '1') {
      delete viewerStrip.dataset.suppressClick;
      return;
    }
    const btn = e.target.closest('.viewer__thumb');
    if (!btn || !viewerStrip.contains(btn)) return;
    showFrame(Number(btn.dataset.index));
  });
  document.addEventListener('keydown', (e) => {
    if (isLightboxOpen()) {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeFrameLightbox();
        return;
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        showFrame(gallery.index - 1);
        return;
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        showFrame(gallery.index + 1);
        return;
      }
    }
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
  bindStageDrag(stage);
  bindStripDrag(viewerStrip);
  bindLightbox();
}

function isLightboxOpen() {
  return frameLightbox && !frameLightbox.hidden;
}

function openFrameLightbox() {
  if (!frameLightbox || !gallery.urls.length) return;
  frameLightbox.hidden = false;
  document.body.classList.add('has-lightbox');
  syncLightboxImage();
}

function closeFrameLightbox() {
  if (!frameLightbox) return;
  frameLightbox.hidden = true;
  document.body.classList.remove('has-lightbox');
}

function syncLightboxImage() {
  if (!lightboxImg || !gallery.urls.length) return;
  const url = gallery.urls[gallery.index];
  lightboxImg.src = url;
  if (lightboxMeta) {
    lightboxMeta.textContent = `第 ${gallery.index + 1} / ${gallery.urls.length} 帧`;
  }
}

function bindLightbox() {
  if (!frameLightbox) return;
  lightboxClose?.addEventListener('click', closeFrameLightbox);
  lightboxBackdrop?.addEventListener('click', closeFrameLightbox);
  lightboxPrev?.addEventListener('click', (e) => {
    e.stopPropagation();
    showFrame(gallery.index - 1);
  });
  lightboxNext?.addEventListener('click', (e) => {
    e.stopPropagation();
    showFrame(gallery.index + 1);
  });
  frameLightbox.addEventListener('click', (e) => {
    if (e.target === frameLightbox) closeFrameLightbox();
  });
}

/** 在预览区按住左右拖动：拖得越多切帧越多（适合几百帧 scrub） */
function bindStageDrag(stage) {
  if (!stage) return;
  const PX_PER_FRAME = 6;
  let dragging = false;
  let startX = 0;
  let startIndex = 0;
  let pointerId = null;
  let moved = false;

  stage.addEventListener('pointerdown', (e) => {
    if (viewer.hidden || !gallery.urls.length) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.target.closest('.viewer__nav')) return;
    dragging = true;
    moved = false;
    startX = e.clientX;
    startIndex = gallery.index;
    pointerId = e.pointerId;
    stage.setPointerCapture(e.pointerId);
    stage.classList.add('is-dragging');
    stopAutoplay();
  });

  stage.addEventListener('pointermove', (e) => {
    if (!dragging || e.pointerId !== pointerId) return;
    const dx = e.clientX - startX;
    if (Math.abs(dx) > 3) moved = true;
    // 向左拖 → 下一帧；向右拖 → 上一帧
    const delta = Math.round(-dx / PX_PER_FRAME);
    if (delta !== 0) showFrame(startIndex + delta);
  });

  const endDrag = (e) => {
    if (!dragging || (pointerId != null && e.pointerId !== pointerId)) return;
    dragging = false;
    pointerId = null;
    stage.classList.remove('is-dragging');
    if (!moved) {
      openFrameLightbox();
      return;
    }
    const dx = e.clientX - startX;
    if (Math.abs(dx) >= 24 && Math.round(-dx / PX_PER_FRAME) === 0) {
      showFrame(startIndex + (dx < 0 ? 1 : -1));
    }
  };

  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);
  stage.addEventListener('lostpointercapture', () => {
    dragging = false;
    pointerId = null;
    stage.classList.remove('is-dragging');
  });
}

/** 底部缩略图栏：超过阈值才拖动滚动；未拖动则单击选中 */
function bindStripDrag(strip) {
  if (!strip) return;
  const THRESHOLD = 6;
  let tracking = false;
  let dragging = false;
  let startX = 0;
  let startScroll = 0;
  let pointerId = null;

  strip.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    tracking = true;
    dragging = false;
    startX = e.clientX;
    startScroll = strip.scrollLeft;
    pointerId = e.pointerId;
  });

  strip.addEventListener('pointermove', (e) => {
    if (!tracking || e.pointerId !== pointerId) return;
    const dx = e.clientX - startX;
    if (!dragging && Math.abs(dx) > THRESHOLD) {
      dragging = true;
      strip.setPointerCapture(e.pointerId);
      strip.classList.add('is-dragging');
      strip.dataset.suppressClick = '1';
    }
    if (dragging) {
      strip.scrollLeft = startScroll - dx;
    }
  });

  const endDrag = (e) => {
    if (!tracking || (pointerId != null && e.pointerId !== pointerId)) return;
    const didDrag = dragging;
    tracking = false;
    dragging = false;
    pointerId = null;
    strip.classList.remove('is-dragging');

    if (didDrag) {
      // 拖动结束：短暂抑制 click，避免误选
      strip.dataset.suppressClick = '1';
      window.setTimeout(() => delete strip.dataset.suppressClick, 120);
      return;
    }

    // 未拖动 = 单击：直接选中缩略图（不依赖 click，兼容 pointer capture）
    delete strip.dataset.suppressClick;
    const thumb =
      (e.target instanceof Element && e.target.closest('.viewer__thumb')) ||
      document.elementFromPoint(e.clientX, e.clientY)?.closest?.('.viewer__thumb');
    if (thumb && strip.contains(thumb)) {
      e.preventDefault();
      showFrame(Number(thumb.dataset.index));
    }
  };

  strip.addEventListener('pointerup', endDrag);
  strip.addEventListener('pointercancel', endDrag);
  strip.addEventListener('lostpointercapture', () => {
    tracking = false;
    dragging = false;
    pointerId = null;
    strip.classList.remove('is-dragging');
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

  if (isLightboxOpen()) syncLightboxImage();
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
