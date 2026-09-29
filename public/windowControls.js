/**
 * 无边框窗口控制：便携启动器 IPC / Tauri / Edge --app 回退。
 */

function isTauri() {
  return Boolean(window.__TAURI_INTERNALS__ || window.__TAURI__);
}

function getDesktopShell() {
  return window.douyinFramesDesktop || null;
}

function isAppShell() {
  const q = new URLSearchParams(window.location.search);
  return (
    isTauri() ||
    Boolean(getDesktopShell()?.shell) ||
    q.get('shell') === '1' ||
    document.documentElement.classList.contains('is-app-shell') ||
    window.matchMedia('(display-mode: standalone)').matches
  );
}

async function getTauriWindow() {
  const api = window.__TAURI__;
  if (api?.window?.getCurrentWindow) {
    return api.window.getCurrentWindow();
  }
  await new Promise((r) => setTimeout(r, 50));
  return window.__TAURI__?.window?.getCurrentWindow?.() || null;
}

function syncMaxButton(maximized) {
  const maxBtn = document.getElementById('winMax');
  if (!maxBtn) return;
  maxBtn.classList.toggle('is-restored', Boolean(maximized));
  maxBtn.title = maximized ? '还原' : '最大化';
  maxBtn.setAttribute('aria-label', maxBtn.title);
}

export function bindWindowControls() {
  const minBtn = document.getElementById('winMin');
  const maxBtn = document.getElementById('winMax');
  const closeBtn = document.getElementById('winClose');
  if (!minBtn && !maxBtn && !closeBtn) return;

  if (isAppShell() || isTauri()) {
    document.documentElement.classList.add('is-app-shell');
  }

  const syncMaximized = async () => {
    try {
      const shell = getDesktopShell();
      if (shell?.shell) {
        syncMaxButton(document.documentElement.dataset.maximized === '1');
        return;
      }
      const win = await getTauriWindow();
      if (!win || !maxBtn) return;
      const maximized = await win.isMaximized();
      syncMaxButton(maximized);
    } catch {
      // ignore
    }
  };

  minBtn?.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      const shell = getDesktopShell();
      if (shell?.minimize) {
        shell.minimize();
        return;
      }
      const win = await getTauriWindow();
      if (win) await win.minimize();
    } catch {
      // Edge --app 无法最小化
    }
  });

  maxBtn?.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      const shell = getDesktopShell();
      if (shell?.maximize) {
        shell.maximize();
        return;
      }
      const win = await getTauriWindow();
      if (win) {
        await win.toggleMaximize();
        await syncMaximized();
      }
    } catch {
      // ignore
    }
  });

  closeBtn?.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      const shell = getDesktopShell();
      if (shell?.close) {
        shell.close();
        return;
      }
      const win = await getTauriWindow();
      if (win) {
        await win.close();
        return;
      }
    } catch {
      // fall through
    }
    window.close();
  });

  const titlebar = document.querySelector('.titlebar');
  titlebar?.addEventListener('dblclick', async (e) => {
    if (e.target.closest('.titlebar__controls, .win-btn')) return;
    try {
      const shell = getDesktopShell();
      if (shell?.maximize) {
        shell.maximize();
        return;
      }
      const win = await getTauriWindow();
      if (win) {
        await win.toggleMaximize();
        await syncMaximized();
      }
    } catch {
      // ignore
    }
  });

  titlebar?.addEventListener('mousedown', async (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('.titlebar__controls, .win-btn, a, button, input')) return;
    try {
      const shell = getDesktopShell();
      if (shell?.drag) {
        shell.drag();
        return;
      }
      const win = await getTauriWindow();
      if (win) await win.startDragging();
    } catch {
      // ignore
    }
  });

  syncMaximized();
  setTimeout(syncMaximized, 300);
  window.addEventListener('resize', () => {
    syncMaximized();
  });
}
