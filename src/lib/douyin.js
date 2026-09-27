import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const DEFAULT_HEADERS = {
  'User-Agent': DESKTOP_UA,
  Accept: '*/*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  Referer: 'https://www.douyin.com/',
};

/**
 * 从任意抖音分享文本/链接中提取 aweme_id
 */
export function extractAwemeId(input) {
  const text = String(input || '').trim();
  if (!text) throw new Error('请提供抖音视频链接');

  const patterns = [
    /douyin\.com\/video\/(\d+)/i,
    /iesdouyin\.com\/share\/video\/(\d+)/i,
    /aweme_id=(\d+)/i,
    /modal_id=(\d+)/i,
    /\/note\/(\d+)/i,
  ];

  for (const re of patterns) {
    const m = text.match(re);
    if (m?.[1]) return m[1];
  }

  // 纯数字 ID
  if (/^\d{15,25}$/.test(text)) return text;

  throw new Error('无法从输入中解析抖音视频 ID，请粘贴完整视频链接');
}

/**
 * 解析短链重定向，拿到最终长链
 */
async function resolveRedirect(url) {
  const res = await fetch(url, {
    method: 'GET',
    redirect: 'follow',
    headers: DEFAULT_HEADERS,
  });
  return res.url || url;
}

function pickBestUrl(candidates = []) {
  const urls = candidates
    .flatMap((c) => {
      if (!c) return [];
      if (typeof c === 'string') return [c];
      if (Array.isArray(c.url_list)) return c.url_list;
      if (c.url) return [c.url];
      return [];
    })
    .filter(Boolean)
    .map((u) => u.replace(/playwm/g, 'play'));

  // 优先无水印 / 直链
  const ranked = [...urls].sort((a, b) => {
    const score = (u) =>
      (u.includes('play/') ? 3 : 0) +
      (u.includes('snssdk') ? 2 : 0) +
      (u.includes('aweme') ? 1 : 0) -
      (u.includes('playwm') ? 5 : 0);
    return score(b) - score(a);
  });

  return ranked[0] || null;
}

function digVideoMeta(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 8) return null;

  // 常见结构：aweme_detail / aweme / item
  const aweme =
    obj.aweme_detail ||
    obj.aweme ||
    obj.item ||
    obj.videoDetail ||
    (obj.video && obj.author ? obj : null);

  if (aweme?.video) {
    const v = aweme.video;
    const playAddr =
      v.play_addr ||
      v.playAddr ||
      v.download_addr ||
      v.downloadAddr ||
      v.bit_rate?.[0]?.play_addr ||
      null;

    const uri = playAddr?.uri || v.play_addr?.uri || v.vid || null;
    const url = pickBestUrl([
      playAddr,
      v.play_addr_h264,
      v.download_addr,
      ...(v.bit_rate || []).map((b) => b.play_addr),
    ]);

    return {
      awemeId: String(aweme.aweme_id || aweme.awemeId || aweme.group_id || ''),
      desc: aweme.desc || aweme.title || '',
      author: aweme.author?.nickname || aweme.author?.unique_id || '',
      duration: v.duration || aweme.duration || null,
      videoUri: uri,
      videoUrl: url,
      cover: pickBestUrl([v.cover, v.origin_cover, v.dynamic_cover]),
    };
  }

  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = digVideoMeta(item, depth + 1);
      if (found?.videoUrl || found?.videoUri) return found;
    }
    return null;
  }

  for (const key of Object.keys(obj)) {
    const found = digVideoMeta(obj[key], depth + 1);
    if (found?.videoUrl || found?.videoUri) return found;
  }
  return null;
}

function parseEmbeddedJson(html) {
  const patterns = [
    /window\._ROUTER_DATA\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/i,
    /window\.__RENDER_DATA__\s*=\s*"([^"]+)"/i,
    /<script id="RENDER_DATA" type="application\/json">([^<]+)<\/script>/i,
    /window\._SSR_HYDRATED_DATA\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/i,
  ];

  for (const re of patterns) {
    const m = html.match(re);
    if (!m?.[1]) continue;
    try {
      let raw = m[1];
      if (re.source.includes('RENDER_DATA') && !raw.trim().startsWith('{')) {
        raw = decodeURIComponent(raw);
      }
      return JSON.parse(raw);
    } catch {
      // continue
    }
  }
  return null;
}

async function fetchSharePage(awemeId) {
  const urls = [
    `https://www.iesdouyin.com/share/video/${awemeId}`,
    `https://www.douyin.com/video/${awemeId}`,
  ];

  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: {
          ...DEFAULT_HEADERS,
          'User-Agent': url.includes('iesdouyin') ? MOBILE_UA : DESKTOP_UA,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      });
      if (!res.ok) continue;
      const html = await res.text();
      const data = parseEmbeddedJson(html);
      if (data) {
        const meta = digVideoMeta(data);
        if (meta) return meta;
      }

      // 兜底：直接从 HTML 里抠 mp4
      const mp4 = html.match(/https?:\/\/[^"'\\\s]+\.mp4[^"'\\\s]*/i)?.[0];
      if (mp4) {
        return {
          awemeId,
          desc: '',
          author: '',
          duration: null,
          videoUri: null,
          videoUrl: mp4.replace(/playwm/g, 'play'),
          cover: null,
        };
      }
    } catch {
      // try next
    }
  }
  return null;
}

/**
 * 通过 video_id 走播放接口拿无水印直链
 */
async function resolvePlayUrlByUri(videoUri) {
  if (!videoUri) return null;
  const id = String(videoUri).replace(/^v\d+?\//, '');
  const playApi = `https://aweme.snssdk.com/aweme/v1/play/?video_id=${encodeURIComponent(
    id,
  )}&ratio=1080p&line=0`;

  try {
    const res = await fetch(playApi, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        ...DEFAULT_HEADERS,
        Referer: 'https://www.douyin.com/',
      },
    });

    const loc = res.headers.get('location');
    if (loc) return loc;

    // 有时直接返回视频流
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('video') || ct.includes('octet-stream')) {
      return playApi;
    }
  } catch {
    // ignore
  }
  return playApi;
}

/**
 * 解析抖音链接，返回可下载的原视频元信息
 * 策略：先轻量 HTML/SSR 解析，失败则用 Playwright 拦截直链
 */
export async function resolveDouyinVideo(inputUrl, { useBrowser = true } = {}) {
  let url = String(inputUrl).trim();

  // 短链先展开
  if (/v\.douyin\.com/i.test(url)) {
    url = await resolveRedirect(url);
  }

  const awemeId = extractAwemeId(url);
  let meta = await fetchSharePage(awemeId);

  if (!meta) {
    meta = {
      awemeId,
      desc: '',
      author: '',
      duration: null,
      videoUri: null,
      videoUrl: null,
      cover: null,
    };
  }

  if (!meta.awemeId) meta.awemeId = awemeId;

  // 优先用 uri 走无水印播放接口
  if (meta.videoUri && !meta.videoUrl) {
    const play = await resolvePlayUrlByUri(meta.videoUri);
    if (play) meta.videoUrl = play;
  }

  if (!meta.videoUrl && useBrowser) {
    const { resolveViaBrowser } = await import('./browserResolve.js');
    const browserMeta = await resolveViaBrowser(url);
    meta = { ...meta, ...browserMeta };
  }

  if (!meta.videoUrl && !meta.videoBuffer) {
    throw new Error(
      '未能解析到可下载的视频地址。该视频可能需登录、已删除，或平台接口变更。',
    );
  }

  return {
    ...meta,
    sourceUrl: url,
    pageUrl: `https://www.douyin.com/video/${meta.awemeId}`,
  };
}

/**
 * 下载视频到本地文件
 */
export async function downloadVideo(videoUrl, destPath, { timeoutMs = 120_000 } = {}) {
  await fsp.mkdir(path.dirname(destPath), { recursive: true });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(videoUrl, {
      signal: controller.signal,
      headers: {
        ...DEFAULT_HEADERS,
        Referer: 'https://www.douyin.com/',
      },
      redirect: 'follow',
    });

    if (!res.ok) {
      throw new Error(`下载失败 HTTP ${res.status}`);
    }

    if (!res.body) {
      throw new Error('下载响应无内容');
    }

    await pipeline(res.body, createWriteStream(destPath));

    const stat = await fsp.stat(destPath);
    if (stat.size < 1024) {
      throw new Error('下载的文件过小，可能不是有效视频');
    }

    return { path: destPath, size: stat.size };
  } finally {
    clearTimeout(timer);
  }
}

export function fileExists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}
