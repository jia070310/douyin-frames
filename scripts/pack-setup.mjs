/**
 * 安装包（瘦身）：不含便携 Node / FFmpeg。
 * 首次运行：启动器检测系统 Node，没有则下载到 %LOCALAPPDATA%\DouyinFrames\runtime\node；
 * FFmpeg 由应用检测，缺失则下载精简包到 runtime\ffmpeg。
 *
 *   node scripts/pack-setup.mjs
 *
 * 产物：
 *   dist/DouyinFrames-setup/app/          安装内容
 *   dist/DouyinFrames-setup/*.iss
 *   dist/DouyinFrames-Setup-*.exe         （有 Inno Setup 时）
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import https from 'node:https';
import http from 'node:http';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'dist', 'DouyinFrames-setup');
const APP = path.join(OUT, 'app');
const LAUNCHER_DIR = path.join(ROOT, 'packaging', 'launcher');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || '1.1.0';

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd || ROOT,
      env: { ...process.env, ...opts.env },
      stdio: 'inherit',
      shell: opts.shell ?? process.platform === 'win32',
      windowsHide: true,
    });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exit ${code}`))));
  });
}

async function rmrf(p) {
  await fsp.rm(p, { recursive: true, force: true }).catch(() => {});
}

async function copyDir(src, dest, { filter } = {}) {
  await fsp.mkdir(dest, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const ent of entries) {
    const from = path.join(src, ent.name);
    const to = path.join(dest, ent.name);
    if (filter && !filter(from, ent)) continue;
    if (ent.isDirectory()) await copyDir(from, to, { filter });
    else await fsp.copyFile(from, to);
  }
}

function httpGet(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib
      .get(url, { headers: { 'User-Agent': 'douyin-frames-pack' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (redirects > 8) return reject(new Error('redirect loop'));
          res.resume();
          return resolve(httpGet(res.headers.location, redirects + 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        resolve(res);
      })
      .on('error', reject);
  });
}

async function download(url, dest, onProgress) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const res = await httpGet(url);
  const total = Number(res.headers['content-length'] || 0);
  let done = 0;
  if (onProgress && total) {
    res.on('data', (chunk) => {
      done += chunk.length;
      onProgress(Math.min(99, Math.round((done / total) * 100)));
    });
  }
  await pipeline(res, createWriteStream(dest));
  onProgress?.(100);
}

async function du(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries = [];
    try {
      entries = await fsp.readdir(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else {
        try {
          total += (await fsp.stat(full)).size;
        } catch {
          // ignore
        }
      }
    }
  }
  return total;
}

async function buildLauncher(destRoot) {
  console.log('[setup] building DouyinFrames.exe…');
  const targetDir = path.join(ROOT, 'dist', '.launcher-target');
  await fsp.mkdir(targetDir, { recursive: true });
  await run('cargo', ['build', '--release'], {
    cwd: LAUNCHER_DIR,
    env: { CARGO_TARGET_DIR: targetDir },
    shell: false,
  });
  const builtCandidates = [
    path.join(targetDir, 'x86_64-pc-windows-gnu', 'release', 'DouyinFrames.exe'),
    path.join(targetDir, 'release', 'DouyinFrames.exe'),
  ];
  const built = builtCandidates.find((p) => fs.existsSync(p));
  if (!built) throw new Error('未找到 DouyinFrames.exe');
  await fsp.copyFile(built, path.join(destRoot, 'DouyinFrames.exe'));

  const iconIco = path.join(ROOT, 'packaging', 'icons', 'icon.ico');
  if (fs.existsSync(iconIco)) {
    try {
      const require = createRequire(import.meta.url);
      const { rcedit } = require('rcedit');
      await rcedit(path.join(destRoot, 'DouyinFrames.exe'), { icon: iconIco });
      console.log('[setup] exe icon OK');
    } catch (e) {
      console.warn('[setup] 写 exe 图标失败:', e.message);
    }
  }

  const findLoader = () => {
    const bundled = path.join(LAUNCHER_DIR, 'WebView2Loader.dll');
    if (fs.existsSync(bundled)) return bundled;
    const roots = [
      path.join(targetDir, 'x86_64-pc-windows-gnu', 'release', 'build'),
      path.join(targetDir, 'release', 'build'),
      path.join(process.env.USERPROFILE || '', '.cargo', 'registry', 'src'),
    ].filter((p) => p && fs.existsSync(p));
    for (const root of roots) {
      const stack = [root];
      while (stack.length) {
        const cur = stack.pop();
        let entries;
        try {
          entries = fs.readdirSync(cur);
        } catch {
          continue;
        }
        for (const name of entries) {
          const full = path.join(cur, name);
          let st;
          try {
            st = fs.statSync(full);
          } catch {
            continue;
          }
          if (st.isDirectory()) {
            stack.push(full);
            continue;
          }
          if (
            name === 'WebView2Loader.dll' &&
            (cur.endsWith(`${path.sep}x64`) || full.includes(`${path.sep}x64${path.sep}`))
          ) {
            return full;
          }
        }
      }
    }
    return null;
  };
  const loader = findLoader();
  if (!loader) throw new Error('未找到 WebView2Loader.dll');
  await fsp.copyFile(loader, path.join(destRoot, 'WebView2Loader.dll'));
  console.log('[setup] launcher OK');
}

function findIscc() {
  const candidates = [
    process.env.ISCC_PATH,
    'iscc',
    path.join(process.env['ProgramFiles(x86)'] || '', 'Inno Setup 6', 'ISCC.exe'),
    path.join(process.env.ProgramFiles || '', 'Inno Setup 6', 'ISCC.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Inno Setup 6', 'ISCC.exe'),
    path.join(ROOT, 'dist', '.inno-setup', 'ISCC.exe'),
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (c === 'iscc') {
        execFileSync('where', ['iscc'], { stdio: 'ignore', windowsHide: true });
        return 'iscc';
      }
      if (fs.existsSync(c)) return c;
    } catch {
      // continue
    }
  }
  return null;
}

async function ensureIscc() {
  const existing = findIscc();
  if (existing) return existing;

  console.log('[setup] 未找到 Inno Setup，正在下载编译器…');
  const cache = path.join(ROOT, 'dist', '.inno-setup');
  await fsp.mkdir(cache, { recursive: true });
  const installer = path.join(cache, 'innosetup-install.exe');
  const urls = [
    'https://github.com/jrsoftware/issrc/releases/download/is-6_7_3/innosetup-6.7.3.exe',
    'https://github.com/jrsoftware/issrc/releases/download/is-7_1_0/innosetup-7.1.0-x64.exe',
  ];
  let ok = false;
  for (const url of urls) {
    try {
      await download(url, installer, (p) => process.stdout.write(`\r[setup] inno ${p}%   `));
      process.stdout.write('\n');
      ok = true;
      break;
    } catch (e) {
      console.warn('[setup] inno mirror fail:', e.message);
    }
  }
  if (!ok) {
    // 尝试 winget（可能需要确认）
    try {
      console.log('[setup] 尝试 winget 安装 Inno Setup…');
      await run(
        'winget',
        ['install', '--id', 'JRSoftware.InnoSetup', '-e', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity'],
        { shell: false },
      );
      return findIscc();
    } catch (e) {
      console.warn('[setup] winget 失败:', e.message);
      return null;
    }
  }

  await run(
    installer,
    ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', `/DIR=${cache}`],
    { shell: false },
  );

  const iscc = path.join(cache, 'ISCC.exe');
  return fs.existsSync(iscc) ? iscc : findIscc();
}

async function ensureInnoLanguages(isccPath) {
  const compilerDir = path.dirname(isccPath);
  const langDir = path.join(compilerDir, 'Languages');
  await fsp.mkdir(langDir, { recursive: true });

  const needed = [
    'ChineseSimplified.isl',
    'ChineseTraditional.isl',
    'Japanese.isl',
    'Korean.isl',
  ];
  const base =
    'https://raw.githubusercontent.com/jrsoftware/issrc/main/Files/Languages';
  for (const name of needed) {
    const dest = path.join(langDir, name);
    if (fs.existsSync(dest) && (await fsp.stat(dest)).size > 1000) continue;
    // 优先用仓库缓存
    const bundled = path.join(ROOT, 'packaging', 'inno-languages', name);
    if (fs.existsSync(bundled)) {
      await fsp.copyFile(bundled, dest);
      console.log('[setup] lang from repo:', name);
      continue;
    }
    try {
      await download(`${base}/${name}`, dest);
      await fsp.mkdir(path.join(ROOT, 'packaging', 'inno-languages'), { recursive: true });
      await fsp.copyFile(dest, bundled).catch(() => {});
      console.log('[setup] lang downloaded:', name);
    } catch (e) {
      console.warn(`[setup] 语言包 ${name} 失败:`, e.message);
    }
  }
  return langDir;
}

async function writeIss() {
  const iconIco = path.join(ROOT, 'packaging', 'icons', 'icon.ico');
  const iconLine = fs.existsSync(iconIco)
    ? `SetupIconFile=${iconIco.replace(/\\/g, '/')}\nUninstallDisplayIcon={app}\\DouyinFrames.exe`
    : 'UninstallDisplayIcon={app}\\DouyinFrames.exe';

  const iss = `; 由 scripts/pack-setup.mjs 生成 — 请勿手改后指望下次不被覆盖
#define MyAppName "Douyin Frames"
#define MyAppVersion "${VERSION}"
#define MyAppPublisher "jinchan"
#define MyAppURL "https://github.com/jia070310/douyin-frames"
#define MyAppExeName "DouyinFrames.exe"

[Setup]
AppId={{B7E2C4A1-9F3D-4E8B-A2C1-5D8E9F0A1B2C}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
DefaultDirName={localappdata}\\Programs\\DouyinFrames
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=${OUT.replace(/\\/g, '/')}
OutputBaseFilename=DouyinFrames-Setup-${VERSION}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ShowLanguageDialog=yes
ArchitecturesInstallIn64BitMode=x64compatible
${iconLine}

[Languages]
Name: "chinesesimplified"; MessagesFile: "compiler:Languages\\ChineseSimplified.isl"
Name: "chinesetraditional"; MessagesFile: "compiler:Languages\\ChineseTraditional.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "japanese"; MessagesFile: "compiler:Languages\\Japanese.isl"
Name: "korean"; MessagesFile: "compiler:Languages\\Korean.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "app\\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\\{#MyAppName}"; Filename: "{app}\\{#MyAppExeName}"
Name: "{group}\\{cm:UninstallProgram,{#MyAppName}}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\\{#MyAppName}"; Filename: "{app}\\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#MyAppName}}"; Flags: nowait postinstall skipifsilent

[CustomMessages]
chinesesimplified.CreateDesktopIcon=创建桌面快捷方式
chinesesimplified.AdditionalIcons=附加图标：
chinesetraditional.CreateDesktopIcon=建立桌面捷徑
chinesetraditional.AdditionalIcons=附加圖示：
english.CreateDesktopIcon=Create a desktop shortcut
english.AdditionalIcons=Additional icons:
japanese.CreateDesktopIcon=デスクトップにショートカットを作成する
japanese.AdditionalIcons=追加アイコン:
korean.CreateDesktopIcon=바탕 화면 바로 가기 만들기
korean.AdditionalIcons=추가 아이콘:

[UninstallDelete]
Type: filesandordirs; Name: "{app}\\DouyinFrames-launch.log"
`;
  const issPath = path.join(OUT, 'DouyinFrames.iss');
  await fsp.writeFile(issPath, iss, 'utf8');
  return issPath;
}

async function main() {
  console.log('[setup] out =', OUT);
  await rmrf(OUT);
  await fsp.mkdir(APP, { recursive: true });

  await copyDir(path.join(ROOT, 'src'), path.join(APP, 'src'));
  await copyDir(path.join(ROOT, 'public'), path.join(APP, 'public'));

  const pkg = JSON.parse(await fsp.readFile(path.join(ROOT, 'package.json'), 'utf8'));
  delete pkg.devDependencies;
  delete pkg.dependencies['@ffmpeg-installer/ffmpeg'];
  delete pkg.dependencies['@ffprobe-installer/ffprobe'];
  delete pkg.postinstall;
  pkg.scripts = {
    start: 'node src/server.js',
    desktop: 'node src/desktop.js',
    cli: 'node src/cli.js',
  };
  await fsp.writeFile(path.join(APP, 'package.json'), JSON.stringify(pkg, null, 2));

  console.log('[setup] npm install（不含 FFmpeg 预编译包）…');
  await run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], {
    cwd: APP,
    env: { PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' },
  });
  await rmrf(path.join(APP, 'node_modules', 'playwright', '.local-browsers'));
  await rmrf(path.join(APP, 'node_modules', 'playwright-core', '.local-browsers'));
  await rmrf(path.join(APP, 'node_modules', '@ffmpeg-installer'));
  await rmrf(path.join(APP, 'node_modules', '@ffprobe-installer'));

  await buildLauncher(APP);

  await fsp.writeFile(
    path.join(APP, '使用说明.txt'),
    [
      'Douyin Frames 安装版',
      '================',
      '',
      '本包不内置 Node / FFmpeg：',
      '  · 优先使用系统已安装的 Node.js 18+',
      '  · 若无 Node，首次启动会下载便携 Node 到 %LOCALAPPDATA%\\DouyinFrames\\runtime\\node',
      '  · FFmpeg 同理，缺失时下载精简包到 runtime\\ffmpeg',
      '',
      '需已安装 Microsoft Edge WebView2 运行时（Win10/11 通常已有）。',
      '',
      '仓库：https://github.com/jia070310/douyin-frames',
      '',
    ].join('\r\n'),
    'utf8',
  );

  const issPath = await writeIss();
  const mb = ((await du(APP)) / (1024 * 1024)).toFixed(1);
  console.log(`[setup] app ≈ ${mb} MB（不含 Node/FFmpeg）`);

  let iscc = null;
  try {
    iscc = await ensureIscc();
  } catch (e) {
    console.warn('[setup] 准备 Inno Setup 失败:', e.message);
  }

  if (iscc) {
    try {
      await ensureInnoLanguages(iscc);
    } catch (e) {
      console.warn('[setup] 语言包准备失败:', e.message);
    }
    const issPath2 = await writeIss();
    console.log('[setup] compiling installer with', iscc);
    try {
      await run(iscc, [issPath2], { cwd: OUT, shell: false });
      const setupExe = path.join(OUT, `DouyinFrames-Setup-${VERSION}.exe`);
      if (fs.existsSync(setupExe)) {
        console.log(`[setup] 安装包: ${setupExe}`);
      } else {
        console.log('[setup] 已调用 ISCC，请检查 OutputDir');
      }
    } catch (e) {
      console.warn('[setup] 多语言编译失败，回退仅英文…', e.message);
      let iss = await fsp.readFile(issPath2, 'utf8');
      iss = iss.replace(
        /\[Languages\][\s\S]*?\n(?=\[Tasks\])/,
        '[Languages]\nName: "english"; MessagesFile: "compiler:Default.isl"\n\n',
      );
      await fsp.writeFile(issPath2, iss, 'utf8');
      await run(iscc, [issPath2], { cwd: OUT, shell: false });
      console.log(`[setup] 安装包: ${path.join(OUT, `DouyinFrames-Setup-${VERSION}.exe`)}`);
    }
  } else {
    console.warn('[setup] 未生成 Setup.exe。可安装 Inno Setup 6 后重跑，或手动编译:');
    console.warn(`  ISCC.exe "${issPath}"`);
  }

  console.log('[setup] 应用目录:', APP);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
