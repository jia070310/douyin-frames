#![windows_subsystem = "windows"]

use std::env;
use std::ffi::OsStr;
use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Write};
use std::os::windows::ffi::OsStrExt;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use tao::{
  event::{Event, WindowEvent},
  event_loop::{ControlFlow, EventLoopBuilder},
  window::WindowBuilder,
};
use wry::WebViewBuilder;

#[derive(Debug, Clone)]
enum UserEvent {
  Minimize,
  Maximize,
  Close,
  Drag,
}

fn dir_of_exe() -> PathBuf {
  env::current_exe()
    .ok()
    .and_then(|p| p.parent().map(|d| d.to_path_buf()))
    .unwrap_or_else(|| PathBuf::from("."))
}

fn to_wide(s: &str) -> Vec<u16> {
  OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
}

fn alert(msg: &str) {
  #[link(name = "user32")]
  extern "system" {
    fn MessageBoxW(
      hwnd: *mut core::ffi::c_void,
      text: *const u16,
      caption: *const u16,
      flags: u32,
    ) -> i32;
  }
  let text = to_wide(msg);
  let caption = to_wide("Douyin Frames");
  unsafe {
    MessageBoxW(
      std::ptr::null_mut(),
      text.as_ptr(),
      caption.as_ptr(),
      0x10,
    );
  }
}

fn append_log(root: &PathBuf, line: &str) {
  let log = root.join("DouyinFrames-launch.log");
  if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(log) {
    let _ = writeln!(f, "{}", line);
  }
}

fn runtime_dir() -> PathBuf {
  let base = env::var_os("LOCALAPPDATA")
    .map(PathBuf::from)
    .or_else(|| env::var_os("APPDATA").map(PathBuf::from))
    .unwrap_or_else(|| PathBuf::from("."));
  base.join("DouyinFrames").join("runtime")
}

fn which_node() -> Option<PathBuf> {
  if let Ok(p) = env::var("NODE_BINARY") {
    let pb = PathBuf::from(&p);
    if pb.is_file() {
      return Some(pb);
    }
  }
  let mut cmd = Command::new("where");
  cmd.arg("node.exe").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
  #[cfg(windows)]
  {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x0800_0000);
  }
  let out = cmd.output().ok()?;
  if !out.status.success() {
    return None;
  }
  let text = String::from_utf8_lossy(&out.stdout);
  text
    .lines()
    .map(str::trim)
    .find(|l| !l.is_empty())
    .map(PathBuf::from)
    .filter(|p| p.is_file())
}

fn download_portable_node(root: &PathBuf, dest_dir: &PathBuf) -> Result<PathBuf, String> {
  let node_exe = dest_dir.join("node.exe");
  if node_exe.is_file() {
    return Ok(node_exe);
  }
  append_log(root, "未检测到 Node，正在下载便携 Node 到本机缓存…");
  let dest_str = dest_dir.to_string_lossy().replace('\'', "''");
  let ps = format!(
    r#"
$ErrorActionPreference = 'Stop'
$dest = '{dest}'
New-Item -ItemType Directory -Force -Path $dest | Out-Null
$index = Invoke-RestMethod 'https://nodejs.org/dist/index.json'
$ver = ($index | Where-Object {{ $_.lts }} | Select-Object -First 1).version
if (-not $ver) {{ $ver = 'v22.14.0' }}
$zipName = "node-$ver-win-x64.zip"
$zipUrl = "https://nodejs.org/dist/$ver/$zipName"
$tmp = Join-Path $env:TEMP ("douyin-frames-node-" + [guid]::NewGuid().ToString())
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$zipPath = Join-Path $tmp $zipName
Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath -UseBasicParsing
Expand-Archive -LiteralPath $zipPath -DestinationPath $tmp -Force
$extracted = Join-Path $tmp ("node-$ver-win-x64")
Copy-Item -Force (Join-Path $extracted 'node.exe') (Join-Path $dest 'node.exe')
if (Test-Path (Join-Path $extracted 'LICENSE')) {{ Copy-Item -Force (Join-Path $extracted 'LICENSE') (Join-Path $dest 'LICENSE') }}
Remove-Item -Recurse -Force $tmp
if (-not (Test-Path (Join-Path $dest 'node.exe'))) {{ throw 'node.exe missing after download' }}
"#,
    dest = dest_str
  );

  let mut cmd = Command::new("powershell.exe");
  cmd.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", &ps])
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
  #[cfg(windows)]
  {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x0800_0000);
  }
  let out = cmd
    .output()
    .map_err(|e| format!("下载 Node 失败（无法启动 PowerShell）：{e}"))?;
  if !out.status.success() {
    let err = String::from_utf8_lossy(&out.stderr);
    let stdout = String::from_utf8_lossy(&out.stdout);
    append_log(root, &format!("[node-download stderr] {err}"));
    append_log(root, &format!("[node-download stdout] {stdout}"));
    return Err(format!(
      "下载便携 Node 失败。请安装 Node.js 18+ 或查看 DouyinFrames-launch.log\n{err}"
    ));
  }
  if !node_exe.is_file() {
    return Err("下载完成但未找到 node.exe".into());
  }
  append_log(root, &format!("portable node ready: {}", node_exe.display()));
  Ok(node_exe)
}

fn resolve_node(root: &PathBuf) -> Result<PathBuf, String> {
  let bundled = root.join("tools").join("node").join("node.exe");
  if bundled.is_file() {
    append_log(root, "using bundled tools\\node\\node.exe");
    return Ok(bundled);
  }
  if let Some(p) = which_node() {
    append_log(root, &format!("using system node: {}", p.display()));
    return Ok(p);
  }
  let cache_dir = runtime_dir().join("node");
  download_portable_node(root, &cache_dir)
}

fn spawn_backend(root: &PathBuf) -> Result<(Child, u16), String> {
  let desktop = root.join("src").join("desktop.js");
  let ffmpeg = root.join("tools").join("ffmpeg").join("ffmpeg.exe");
  let ffprobe = root.join("tools").join("ffmpeg").join("ffprobe.exe");

  if !desktop.is_file() {
    return Err("缺少 src\\desktop.js".into());
  }

  let node = resolve_node(root)?;

  let mut cmd = Command::new(&node);
  cmd.arg(&desktop)
    .current_dir(root)
    .env("DOUYIN_FRAMES_ROOT", root)
    .env("DOUYIN_FRAMES_NO_BROWSER", "1")
    .env("NODE_ENV", "production")
    .env("PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD", "1")
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());

  if ffmpeg.is_file() {
    cmd.env("FFMPEG_PATH", &ffmpeg);
  }
  if ffprobe.is_file() {
    cmd.env("FFPROBE_PATH", &ffprobe);
  }

  #[cfg(windows)]
  {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
  }

  let mut child = cmd.spawn().map_err(|e| format!("无法启动 Node：{e}"))?;

  if let Some(stderr) = child.stderr.take() {
    let root_clone = root.clone();
    thread::spawn(move || {
      for line in BufReader::new(stderr).lines().flatten() {
        append_log(&root_clone, &format!("[stderr] {line}"));
      }
    });
  }

  let stdout = child
    .stdout
    .take()
    .ok_or_else(|| "无法读取 Node 输出".to_string())?;
  let mut reader = BufReader::new(stdout);
  let mut line = String::new();
  // 首次可能下载 FFmpeg，多等一会
  let deadline = Instant::now() + Duration::from_secs(300);
  let mut port = None;

  while Instant::now() < deadline {
    line.clear();
    match reader.read_line(&mut line) {
      Ok(0) => break,
      Ok(_) => {
        let trimmed = line.trim_end();
        append_log(root, &format!("[stdout] {trimmed}"));
        if let Some(rest) = trimmed.strip_prefix("__DOUYIN_FRAMES_PORT__=") {
          if let Ok(p) = rest.trim().parse::<u16>() {
            port = Some(p);
            break;
          }
        }
      }
      Err(e) => return Err(format!("读取输出失败：{e}")),
    }
  }

  thread::spawn(move || {
    for _ in reader.lines() {}
  });

  match port {
    Some(p) => Ok((child, p)),
    None => {
      let _ = child.kill();
      Err("本机服务未回报端口，启动失败。请查看 DouyinFrames-launch.log".into())
    }
  }
}

fn kill_child(child: &Arc<Mutex<Option<Child>>>) {
  if let Ok(mut guard) = child.lock() {
    if let Some(mut c) = guard.take() {
      let _ = c.kill();
      let _ = c.wait();
    }
  }
}

fn sync_maximized_script(maximized: bool) -> String {
  format!(
    r#"
      (function () {{
        var on = {maximized};
        document.documentElement.dataset.maximized = on ? '1' : '';
        var btn = document.getElementById('winMax');
        if (btn) {{
          btn.classList.toggle('is-restored', on);
          btn.title = on ? '还原' : '最大化';
          btn.setAttribute('aria-label', btn.title);
        }}
      }})();
    "#,
    maximized = if maximized { "true" } else { "false" }
  )
}

fn app_icon() -> Option<tao::window::Icon> {
  // Windows 窗口/任务栏图标边长须 ≤256；关于页仍用大图
  let bytes = include_bytes!("../../icons/icon-256.png");
  let img = image::load_from_memory(bytes).ok()?.into_rgba8();
  let (w, h) = img.dimensions();
  tao::window::Icon::from_rgba(img.into_raw(), w, h).ok()
}

#[cfg(windows)]
fn set_app_user_model_id() {
  #[link(name = "shell32")]
  extern "system" {
    fn SetCurrentProcessExplicitAppUserModelID(app_id: *const u16) -> i32;
  }
  let id: Vec<u16> = OsStr::new("Jinchan.DouyinFrames")
    .encode_wide()
    .chain(std::iter::once(0))
    .collect();
  unsafe {
    let _ = SetCurrentProcessExplicitAppUserModelID(id.as_ptr());
  }
}

fn main() {
  #[cfg(windows)]
  set_app_user_model_id();

  let root = dir_of_exe();
  append_log(&root, "launcher start (frameless webview)");

  let (child, port) = match spawn_backend(&root) {
    Ok(v) => v,
    Err(e) => {
      append_log(&root, &e);
      alert(&e);
      return;
    }
  };

  let child = Arc::new(Mutex::new(Some(child)));
  let url = format!("http://127.0.0.1:{port}/boot.html?shell=1");
  append_log(&root, &format!("open {url}"));

  let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
  let proxy = event_loop.create_proxy();

  let mut window_builder = WindowBuilder::new()
    .with_title("Douyin Frames")
    .with_decorations(false)
    .with_inner_size(tao::dpi::LogicalSize::new(1440.0, 920.0))
    .with_min_inner_size(tao::dpi::LogicalSize::new(1000.0, 680.0))
    .with_resizable(true);
  if let Some(icon) = app_icon() {
    append_log(&root, "window icon loaded");
    window_builder = window_builder.with_window_icon(Some(icon));
  } else {
    append_log(&root, "window icon FAILED");
  }

  let window = match window_builder.build(&event_loop) {
    Ok(w) => w,
    Err(e) => {
      kill_child(&child);
      alert(&format!("创建窗口失败：{e}"));
      return;
    }
  };
  // 再建一次更稳妥：部分环境 builder 阶段图标不会进任务栏
  if let Some(icon) = app_icon() {
    window.set_window_icon(Some(icon));
  }

  let proxy_ipc = proxy.clone();
  let webview = match WebViewBuilder::new()
    .with_url(&url)
    .with_initialization_script(
      r#"
        window.douyinFramesDesktop = {
          shell: true,
          post(cmd) {
            try { window.ipc.postMessage(String(cmd)); } catch (_) {}
          },
          minimize() { this.post('minimize'); },
          maximize() { this.post('maximize'); },
          close() { this.post('close'); },
          drag() { this.post('drag'); }
        };
        document.documentElement.classList.add('is-app-shell');
      "#,
    )
    .with_ipc_handler(move |req| match req.body().as_str() {
      "minimize" => {
        let _ = proxy_ipc.send_event(UserEvent::Minimize);
      }
      "maximize" => {
        let _ = proxy_ipc.send_event(UserEvent::Maximize);
      }
      "close" => {
        let _ = proxy_ipc.send_event(UserEvent::Close);
      }
      "drag" => {
        let _ = proxy_ipc.send_event(UserEvent::Drag);
      }
      _ => {}
    })
    .build(&window)
  {
    Ok(v) => v,
    Err(e) => {
      kill_child(&child);
      alert(&format!(
        "创建 WebView2 失败：{e}\n请确认已安装 Microsoft Edge WebView2 运行时。"
      ));
      return;
    }
  };

  let child_for_loop = child.clone();
  event_loop.run(move |event, _, control_flow| {
    *control_flow = ControlFlow::Wait;
    match event {
      Event::UserEvent(UserEvent::Minimize) => {
        window.set_minimized(true);
      }
      Event::UserEvent(UserEvent::Maximize) => {
        let next = !window.is_maximized();
        window.set_maximized(next);
        let _ = webview.evaluate_script(&sync_maximized_script(next));
      }
      Event::UserEvent(UserEvent::Drag) => {
        let _ = window.drag_window();
      }
      Event::UserEvent(UserEvent::Close)
      | Event::WindowEvent {
        event: WindowEvent::CloseRequested,
        ..
      } => {
        kill_child(&child_for_loop);
        *control_flow = ControlFlow::Exit;
      }
      Event::WindowEvent {
        event: WindowEvent::Resized(_),
        ..
      } => {
        let _ = webview.evaluate_script(&sync_maximized_script(window.is_maximized()));
      }
      _ => {}
    }
  });
}
