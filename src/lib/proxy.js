import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

let initialized = false;
/** @type {string|null} */
let activeProxyUrl = null;

/**
 * 读取项目根目录 .env（不覆盖已有环境变量）
 */
function loadDotEnv() {
  const envPath = path.join(ROOT, '.env');
  let text;
  try {
    text = fs.readFileSync(envPath, 'utf8');
  } catch {
    return;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key && process.env[key] == null) process.env[key] = val;
  }
}

/**
 * 优先级：DOUYIN_PROXY > HTTPS_PROXY > HTTP_PROXY > ALL_PROXY
 */
export function getProxyUrl() {
  const raw =
    process.env.DOUYIN_PROXY ||
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    process.env.ALL_PROXY ||
    '';
  const url = String(raw).trim();
  return url || null;
}

/**
 * Playwright proxy 配置（支持 http/https/socks5，以及 user:pass@host）
 * @returns {{server:string, username?:string, password?:string}|undefined}
 */
export function getPlaywrightProxy() {
  const url = getProxyUrl();
  if (!url) return undefined;
  try {
    const u = new URL(url);
    const server = `${u.protocol}//${u.host}`;
    const cfg = { server };
    if (u.username) cfg.username = decodeURIComponent(u.username);
    if (u.password) cfg.password = decodeURIComponent(u.password);
    return cfg;
  } catch {
    return { server: url };
  }
}

/**
 * 脱敏展示用
 */
export function getProxyDisplay() {
  const url = getProxyUrl();
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.username || u.password) {
      u.username = u.username ? '***' : '';
      u.password = u.password ? '***' : '';
    }
    return u.toString();
  } catch {
    return '(configured)';
  }
}

/**
 * 初始化：加载 .env，并让 Node 全局 fetch 走代理（undici）
 */
export async function initProxy() {
  if (initialized) return activeProxyUrl;
  initialized = true;
  loadDotEnv();

  const proxyUrl = getProxyUrl();
  activeProxyUrl = proxyUrl;
  if (!proxyUrl) {
    console.log('[proxy] 未配置代理（DOUYIN_PROXY / HTTPS_PROXY）');
    return null;
  }

  try {
    const undici = await import('undici');
    const agent = new undici.ProxyAgent(proxyUrl);
    undici.setGlobalDispatcher(agent);
    console.log(`[proxy] fetch 已启用: ${getProxyDisplay()}`);
  } catch (err) {
    console.warn(
      `[proxy] 无法设置全局 fetch 代理（${err.message}），Playwright 仍会尝试使用代理`,
    );
  }

  return proxyUrl;
}
