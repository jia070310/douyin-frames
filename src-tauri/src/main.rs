#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
  io::{BufRead, BufReader},
  path::{Path, PathBuf},
  process::{Child, Command, Stdio},
  sync::{Arc, Mutex},
  thread,
  time::{Duration, Instant},
};

use tauri::{Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder};

struct Backend(Arc<Mutex<Option<Child>>>);

fn project_root(app: &tauri::AppHandle) -> PathBuf {
  if cfg!(debug_assertions) {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
      .parent()
      .map(|p| p.to_path_buf())
      .unwrap_or_else(|| PathBuf::from("."))
  } else {
    app
      .path()
      .resource_dir()
      .ok()
      .or_else(|| {
        std::env::current_exe()
          .ok()
          .and_then(|p| p.parent().map(|d| d.to_path_buf()))
      })
      .unwrap_or_else(|| PathBuf::from("."))
  }
}

fn which(cmd: &str) -> Option<PathBuf> {
  let path = std::env::var_os("PATH")?;
  for dir in std::env::split_paths(&path) {
    let candidate = dir.join(cmd);
    if candidate.is_file() {
      return Some(candidate);
    }
    let with_exe = dir.join(format!("{cmd}.exe"));
    if with_exe.is_file() {
      return Some(with_exe);
    }
  }
  None
}

fn find_node(root: &Path) -> PathBuf {
  let local = root.join("tools").join("node").join("node.exe");
  if local.is_file() {
    return local;
  }
  which("node").unwrap_or_else(|| PathBuf::from("node"))
}

fn spawn_backend(root: &Path) -> Result<(Child, u16), String> {
  let node = find_node(root);
  let bridge = root.join("src").join("tauri-bridge.js");
  if !bridge.is_file() {
    return Err(format!("找不到后端脚本: {}", bridge.display()));
  }

  let mut child = Command::new(&node)
    .arg(&bridge)
    .current_dir(root)
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .stdin(Stdio::null())
    .spawn()
    .map_err(|e| {
      format!(
        "无法启动 Node 后端（{}）。请安装 Node.js，或把 node.exe 放到 tools/node/。\n{e}",
        node.display()
      )
    })?;

  let stdout = child
    .stdout
    .take()
    .ok_or_else(|| "无法读取后端输出".to_string())?;
  if let Some(stderr) = child.stderr.take() {
    thread::spawn(move || {
      for line in BufReader::new(stderr).lines().flatten() {
        eprintln!("[backend] {line}");
      }
    });
  }

  let mut port = None;
  let deadline = Instant::now() + Duration::from_secs(60);
  let mut reader = BufReader::new(stdout);
  let mut line = String::new();
  while Instant::now() < deadline {
    line.clear();
    match reader.read_line(&mut line) {
      Ok(0) => break,
      Ok(_) => {
        let trimmed = line.trim_end();
        eprintln!("[backend] {trimmed}");
        if let Some(rest) = trimmed.strip_prefix("__DOUYIN_FRAMES_PORT__=") {
          if let Ok(p) = rest.trim().parse::<u16>() {
            port = Some(p);
            break;
          }
        }
      }
      Err(e) => return Err(format!("读取后端输出失败: {e}")),
    }
  }

  // 剩余 stdout 异步消费，避免管道堵死
  thread::spawn(move || {
    for l in reader.lines().flatten() {
      eprintln!("[backend] {l}");
    }
  });

  port
    .map(|p| (child, p))
    .ok_or_else(|| "后端未回报端口，启动失败".to_string())
}

fn kill_backend(state: &Backend) {
  if let Ok(mut guard) = state.0.lock() {
    if let Some(mut child) = guard.take() {
      let _ = child.kill();
      let _ = child.wait();
    }
  }
}

fn main() {
  tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    .setup(|app| {
      let root = project_root(app.handle());
      eprintln!("[tauri] project root: {}", root.display());

      let (child, port) = match spawn_backend(&root) {
        Ok(v) => v,
        Err(e) => {
          eprintln!("[tauri] {e}");
          return Err(e.into());
        }
      };

      app.manage(Backend(Arc::new(Mutex::new(Some(child)))));

      let url = format!("http://127.0.0.1:{port}/boot.html?shell=1");
      let parsed: Url = url.parse().map_err(|e| format!("invalid url: {e}"))?;

      // 无边框窗口：由页面自定义标题栏与右上角按钮控制
      WebviewWindowBuilder::new(app, "main", WebviewUrl::External(parsed))
        .title("Douyin Frames")
        .inner_size(1440.0, 920.0)
        .min_inner_size(1000.0, 680.0)
        .decorations(false)
        .resizable(true)
        .visible(true)
        .build()?;

      Ok(())
    })
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(|app_handle, event| {
      if let RunEvent::Exit = event {
        if let Some(state) = app_handle.try_state::<Backend>() {
          kill_backend(&state);
        }
      }
    });
}
