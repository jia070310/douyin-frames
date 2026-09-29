import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** 贴近真实 Chrome 拉 CDN 时的请求头（下载直链用） */
export const BROWSER_DOWNLOAD_HEADERS = {
  'User-Agent': DESKTOP_UA,
  Accept: '*/*',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  'Accept-Encoding': 'identity',
  Referer: 'https://www.douyin.com/',
  Origin: 'https://www.douyin.com',
  'Sec-Fetch-Dest': 'video',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'cross-site',
  'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
};

const DEFAULT_HEADERS = BROWSER_DOWNLOAD_HEADERS;

/**
 * 从任意抖音分享文本/链接中提取可用 URL（优先短链 / 长链）
 * 支持搜索页弹层：…/search/…?modal_id=数字
 */
export function extractDouyinUrl(input) {
  const text = String(input || '')
    .trim()
    .replace(/&amp;/gi, '&');
  if (!text) throw new Error('请提供抖音视频链接');

  const urlMatch = text.match(
    /https?:\/\/(?:v\.douyin\.com|(?:www\.)?iesdouyin\.com|(?:www\.)?douyin\.com)\/[^\s"'<>，。；！？）\]\u3001\u3002]+/i,
  );
  if (urlMatch?.[0]) {
    return urlMatch[0].replace(/[),.;！？]+$/g, '');
  }

  // 无协议的短链
  const short = text.match(/(?:^|\s)(v\.douyin\.com\/[A-Za-z0-9_-]+\/?)/i);
  if (short?.[1]) return `https://${short[1]}`;

  if (/^https?:\/\//i.test(text)) return text;
  return text;
}

/**
 * 从任意抖音分享文本/链接中提取 aweme_id
 * 含搜索页 / 推荐流弹窗：modal_id、item_id 等
 */
export function extractAwemeId(input) {
  const text = String(input || '')
    .trim()
    .replace(/&amp;/gi, '&');
  if (!text) throw new Error('请提供抖音视频链接');

  // 优先从 URL 查询参数读取（搜索页 modal_id 最稳）
  try {
    const maybeUrl = text.startsWith('http') ? text : extractDouyinUrl(text);
    if (/^https?:\/\//i.test(maybeUrl)) {
      const u = new URL(maybeUrl);
      for (const key of ['modal_id', 'aweme_id', 'item_id', 'itemId', 'video_id']) {
        const v = u.searchParams.get(key);
        if (v && /^\d{5,25}$/.test(v)) return v;
      }
    }
  } catch {
    // fall through to regex
  }

  const patterns = [
    /[?&#]modal_id=(\d{5,25})/i,
    /douyin\.com\/video\/(\d+)/i,
    /iesdouyin\.com\/share\/video\/(\d+)/i,
    /[?&#](?:aweme_id|item_id|itemId|video_id)=(\d{5,25})/i,
    /\/note\/(\d+)/i,
  ];

  for (const re of patterns) {
    const m = text.match(re);
    if (m?.[1]) return m[1];
  }

  // 纯数字 ID
  if (/^\d{15,25}$/.test(text)) return text;

  throw new Error(
    '无法从输入中解析抖音视频 ID。请粘贴作品页链接、v.douyin.com 短链，或带 modal_id 的搜索页链接',
  );
}

/** 是否为图文 / note 链接（非视频） */
export function looksLikeNoteInput(input) {
  return /\/note\/\d+/i.test(String(input || ''));
}

/**
 * 若能抽出作品 ID，规范为作品页长链（视频 → /video/，图文 → /note/）
 */
export function toCanonicalVideoUrl(input) {
  const awemeId = extractAwemeId(input);
  if (looksLikeNoteInput(input)) {
    return `https://www.douyin.com/note/${awemeId}`;
  }
  return `https://www.douyin.com/video/${awemeId}`;
}

/**
 * 从 aweme 图文结构里抽出图片直链（优先原图 / download）
 * @param {object} item
 * @returns {string[]}
 */
export function pickImageUrlsFromItem(item) {
  const list =
    item?.images ||
    item?.image_list ||
    item?.imageList ||
    item?.image_infos ||
    [];
  if (!Array.isArray(list) || !list.length) return [];

  const score = (u) => {
    const s = String(u || '');
    let n = 0;
    if (/~noop\./i.test(s)) n += 50;
    if (/biz_tag=aweme_images/i.test(s)) n += 30;
    if (/tplv-dy-aweme-images/i.test(s)) n += 20;
    if (/download/i.test(s)) n += 15;
    if (/:q100|:q90/i.test(s)) n += 10;
    if (/:q75/i.test(s)) n += 5;
    if (/RELATED_AWEME|origshort-autoq|image-cut-tos/i.test(s)) n -= 40;
    return n;
  };

  /** @type {string[]} */
  const out = [];
  for (const im of list) {
    if (!im) continue;
    if (typeof im === 'string') {
      out.push(im);
      continue;
    }
    const candidates = [
      ...(Array.isArray(im.download_url_list) ? im.download_url_list : []),
      ...(Array.isArray(im.downloadUrlList) ? im.downloadUrlList : []),
      ...(Array.isArray(im.url_list) ? im.url_list : []),
      ...(Array.isArray(im.urlList) ? im.urlList : []),
      im.origin_url,
      im.originUrl,
      im.url,
    ]
      .flat()
      .filter((u) => typeof u === 'string' && /^https?:\/\//i.test(u));
    if (!candidates.length) continue;
    candidates.sort((a, b) => score(b) - score(a));
    out.push(candidates[0]);
  }
  return [...new Set(out)];
}

/**
 * 解析短链重定向，拿到最终长链
 */
export async function resolveRedirect(url, { maxHops = 8 } = {}) {
  let current = url;
  for (let i = 0; i < maxHops; i++) {
    const res = await fetch(current, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        ...DEFAULT_HEADERS,
        'User-Agent': MOBILE_UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });

    const loc = res.headers.get('location');
    if (loc) {
      current = new URL(loc, current).href;
      // 已落到含 video/note id 的长链则停止
      if (/douyin\.com\/(?:video|note)\/\d+|iesdouyin\.com\/share\/(?:video|note)\/\d+/i.test(current)) {
        return current;
      }
      continue;
    }

    // 无 Location：可能已是最终页，或 HTML 里仍有跳转
    if (res.status >= 200 && res.status < 400) {
      const finalUrl = res.url || current;
      if (/douyin\.com\/(?:video|note)\/\d+|iesdouyin\.com\/share\/(?:video|note)\/\d+/i.test(finalUrl)) {
        return finalUrl;
      }
      try {
        const html = await res.text();
        const embedded =
          html.match(/https?:\/\/(?:www\.)?douyin\.com\/(?:video|note)\/\d+/i)?.[0] ||
          html.match(/https?:\/\/www\.iesdouyin\.com\/share\/(?:video|note)\/\d+/i)?.[0];
        if (embedded) return embedded;
      } catch {
        // ignore
      }
      return finalUrl;
    }

    break;
  }
  return current;
}

/**
 * 将短链 / 分享文案 / 搜索页弹层链接规范成作品页长链
 */
export async function normalizeDouyinInput(input) {
  let url = extractDouyinUrl(input);
  if (/v\.douyin\.com/i.test(url)) {
    url = await resolveRedirect(url);
  }

  // 搜索页、发现页等带 modal_id 的链接 → 标准作品页（图文保留 /note/）
  try {
    const awemeId = extractAwemeId(url);
    if (awemeId) {
      return looksLikeNoteInput(url) || looksLikeNoteInput(input)
        ? `https://www.douyin.com/note/${awemeId}`
        : `https://www.douyin.com/video/${awemeId}`;
    }
  } catch {
    // keep url
  }

  return url;
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

    const images = pickImageUrlsFromItem(aweme);
    // 图文作品有时仍带空 video 壳，优先按图片处理
    if ((!url && !uri) && images.length) {
      return {
        awemeId: String(aweme.aweme_id || aweme.awemeId || aweme.group_id || ''),
        desc: aweme.desc || aweme.title || '',
        author: aweme.author?.nickname || aweme.author?.unique_id || '',
        duration: null,
        videoUri: null,
        videoUrl: null,
        cover: images[0] || pickBestUrl([v.cover, v.origin_cover, v.dynamic_cover]),
        images,
        contentType: 'images',
        awemeType: aweme.aweme_type,
        via: obj.via || aweme.via || undefined,
      };
    }
    return {
      awemeId: String(aweme.aweme_id || aweme.awemeId || aweme.group_id || ''),
      desc: aweme.desc || aweme.title || '',
      author: aweme.author?.nickname || aweme.author?.unique_id || '',
      duration: v.duration || aweme.duration || null,
      videoUri: uri,
      videoUrl: url,
      cover: pickBestUrl([v.cover, v.origin_cover, v.dynamic_cover]),
      images,
      contentType: images.length ? 'mixed' : 'video',
      awemeType: aweme.aweme_type,
      via: obj.via || aweme.via || undefined,
    };
  }

  // 纯图文：有 images、无 video
  const note =
    obj.aweme_detail ||
    obj.aweme ||
    obj.item ||
    (Array.isArray(obj.images) && (obj.aweme_id || obj.awemeId) ? obj : null);
  if (note && !note.video) {
    const images = pickImageUrlsFromItem(note);
    if (images.length) {
      return {
        awemeId: String(note.aweme_id || note.awemeId || note.group_id || ''),
        desc: note.desc || note.title || '',
        author: note.author?.nickname || note.author?.unique_id || '',
        duration: null,
        videoUri: null,
        videoUrl: null,
        cover: images[0] || null,
        images,
        contentType: 'images',
        awemeType: note.aweme_type,
        via: obj.via || note.via || undefined,
      };
    }
  }

  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = digVideoMeta(item, depth + 1);
      if (found?.videoUrl || found?.videoUri || found?.images?.length) return found;
    }
    return null;
  }

  for (const key of Object.keys(obj)) {
    const found = digVideoMeta(obj[key], depth + 1);
    if (found?.videoUrl || found?.videoUri || found?.images?.length) return found;
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

async function fetchSharePage(awemeId, { preferNote = false } = {}) {
  const urls = preferNote
    ? [
        `https://www.iesdouyin.com/share/note/${awemeId}`,
        `https://www.douyin.com/note/${awemeId}`,
        `https://www.iesdouyin.com/share/video/${awemeId}`,
        `https://www.douyin.com/video/${awemeId}`,
      ]
    : [
        `https://www.iesdouyin.com/share/video/${awemeId}`,
        `https://www.douyin.com/video/${awemeId}`,
        `https://www.iesdouyin.com/share/note/${awemeId}`,
        `https://www.douyin.com/note/${awemeId}`,
      ];
  let cookie = '';
  try {
    cookie = await fetchTtwidCookie();
  } catch {
    // ignore
  }

  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: {
          ...DEFAULT_HEADERS,
          'User-Agent': url.includes('iesdouyin') ? MOBILE_UA : DESKTOP_UA,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          ...(cookie ? { Cookie: cookie } : {}),
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
    if (loc && /^https?:\/\//i.test(loc) && !/login|captcha/i.test(loc)) {
      return loc;
    }

    // 有时直接返回视频流（需足够大，避免反爬小包）
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('video') || ct.includes('octet-stream')) {
      const buf = Buffer.from(await res.arrayBuffer().catch(() => new ArrayBuffer(0)));
      if (buf.length >= 64 * 1024) return playApi;
    }
  } catch {
    // ignore
  }
  // 不再假装 snssdk 地址一定可用（无 Cookie 时常是空壳）
  return null;
}

/**
 * 轻量解析：短链展开 + 分享页 HTML 抽取（纯 HTTP，无浏览器）
 */
export async function resolveDouyinLight(inputUrl) {
  const url = await normalizeDouyinInput(inputUrl);
  const awemeId = extractAwemeId(url);
  let meta = (await fetchSharePage(awemeId)) || (await fetchWebDetail(awemeId));

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

  if (meta.videoUri && !meta.videoUrl) {
    const play = await resolvePlayUrlByUri(meta.videoUri);
    if (play) meta.videoUrl = play;
  }

  if (!meta.videoUrl) {
    throw new Error('轻量解析未能拿到视频直链（页面可能需登录或被风控）');
  }

  return {
    videoUrl: String(meta.videoUrl).replace(/playwm/g, 'play'),
    meta: {
      awemeId: meta.awemeId || awemeId,
      desc: meta.desc || '',
      author: meta.author || '',
      pageUrl: `https://www.douyin.com/video/${meta.awemeId || awemeId}`,
      sourceUrl: url,
      via: meta.via || 'light-html',
    },
  };
}

/** 尝试拿到 Cookie：优先本机已保存的登录 Cookie，其次纯 HTTP 拿 ttwid */
async function fetchTtwidCookie() {
  try {
    const { loadCookieHeader } = await import('./cookies.js');
    const saved = await loadCookieHeader();
    if (saved) return saved;
  } catch {
    // ignore
  }
  try {
    const res = await fetch('https://www.douyin.com/', {
      method: 'GET',
      redirect: 'manual',
      headers: {
        'User-Agent': DESKTOP_UA,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
    });
    const raw = res.headers.getSetCookie?.() || [];
    const joined = Array.isArray(raw) ? raw.join(';') : String(res.headers.get('set-cookie') || '');
    const m = joined.match(/ttwid=([^;,\s]+)/i);
    if (m?.[1]) return `ttwid=${m[1]}`;
  } catch {
    // ignore
  }
  return '';
}

/**
 * Web detail API（纯 HTTP）
 */
async function fetchWebDetail(awemeId) {
  const cookie = await fetchTtwidCookie();
  const api = `https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=${encodeURIComponent(
    awemeId,
  )}&aid=6383&device_platform=webapp`;

  try {
    const res = await fetch(api, {
      headers: {
        'User-Agent': DESKTOP_UA,
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        Referer: `https://www.douyin.com/video/${awemeId}`,
        ...(cookie ? { Cookie: cookie } : {}),
      },
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    const item = data?.aweme_detail || data?.item_list?.[0] || null;
    if (!item) return null;
    const found = digVideoMeta({ aweme_detail: item });
    if (found) {
      found.via = 'web-detail-api';
      if (!found.awemeId) found.awemeId = awemeId;
    }
    return found;
  } catch {
    return null;
  }
}

/**
 * 解析抖音链接（本机，一般不必登录）：
 * 1) 分享页 HTML / Web API
 * 2) yt-dlp（若可用）
 * 3) 无头 Edge/Chrome 打开作品页拦直链（与第一版相同，访客即可）
 */
export async function resolveDouyinVideo(inputUrl, { useBrowser = true } = {}) {
  let url = await normalizeDouyinInput(inputUrl);
  const awemeId = extractAwemeId(url);
  const preferNote = looksLikeNoteInput(url) || looksLikeNoteInput(inputUrl);

  let meta =
    (await fetchSharePage(awemeId, { preferNote })) ||
    (await fetchWebDetail(awemeId)) || {
      awemeId,
      desc: '',
      author: '',
      duration: null,
      videoUri: null,
      videoUrl: null,
      cover: null,
      images: [],
    };

  if (!meta.awemeId) meta.awemeId = awemeId;
  if (!Array.isArray(meta.images)) meta.images = [];

  if (meta.videoUri && !meta.videoUrl) {
    const play = await resolvePlayUrlByUri(meta.videoUri);
    if (play) meta.videoUrl = play;
  }

  // 图文：优先走浏览器抓页面图片（HTTP 分享页常无内嵌数据）
  const needBrowser =
    useBrowser &&
    ((!meta.videoUrl && !meta.videoBuffer && !meta.images?.length) ||
      (preferNote && !meta.images?.length));

  if (needBrowser) {
    try {
      const { resolveViaBrowser } = await import('./browserResolve.js');
      const browserMeta = await resolveViaBrowser(url, { preferNote });
      meta = {
        ...meta,
        ...browserMeta,
        images: browserMeta.images?.length ? browserMeta.images : meta.images,
        via: browserMeta.via || 'browser',
      };
    } catch (err) {
      meta.browserHint = err?.message || String(err);
    }
  }

  // yt-dlp 放在浏览器之后：图文不要用它（常只会下到配乐）
  if (!meta.videoUrl && !meta.videoBuffer && !meta.images?.length && !preferNote) {
    try {
      const { resolveViaYtDlp } = await import('./ytDlp.js');
      const y = await resolveViaYtDlp(url, { autoInstall: true, timeoutMs: 45_000 });
      if (y?.videoUrl) {
        meta.videoUrl = y.videoUrl;
        meta.via = 'yt-dlp';
        if (y.title) meta.desc = meta.desc || y.title;
        if (y.uploader) meta.author = meta.author || y.uploader;
      } else if (y?.errorHint) {
        meta.ytDlpHint = y.errorHint;
      }
    } catch {
      // ignore
    }
  }

  const hasImages = Array.isArray(meta.images) && meta.images.length > 0;

  // 图文优先：有图片时丢掉误抓的配乐/空壳「视频」地址
  if (hasImages && (preferNote || !meta.videoUrl || isLikelyAudioUrl(meta.videoUrl))) {
    meta.videoUrl = null;
    meta.videoUri = null;
    delete meta.videoBuffer;
    meta.contentType = 'images';
  }

  if (!meta.videoUrl && !meta.videoBuffer && !hasImages) {
    const bits = [meta.browserHint, meta.ytDlpHint].filter(Boolean).join('；');
    const hint = bits ? `（${bits}）` : '';
    throw new Error(
      `未能解析到视频直链或图文图片${hint}。可稍后重试，或改用「本地视频」上传。`,
    );
  }

  const pageUrl = preferNote || (hasImages && !meta.videoUrl)
    ? `https://www.douyin.com/note/${meta.awemeId}`
    : `https://www.douyin.com/video/${meta.awemeId}`;

  return {
    ...meta,
    sourceUrl: url,
    pageUrl,
    contentType: hasImages && !meta.videoUrl && !meta.videoBuffer ? 'images' : meta.contentType || 'video',
    via: meta.via || 'http',
  };
}

function isLikelyAudioUrl(url) {
  if (!url) return false;
  return /\.(mp3|m4a|aac)(\?|$)/i.test(url) || /\/music\/|aweme\/v1\/music/i.test(url);
}

/**
 * 下载视频到本地（仅 fetch + 浏览器 Headers，无 Chromium）
 */
export async function downloadVideo(videoUrl, destPath, { timeoutMs = 120_000 } = {}) {
  await fsp.mkdir(path.dirname(destPath), { recursive: true });
  try {
    return await downloadViaFetch(videoUrl, destPath, timeoutMs);
  } catch (err) {
    // 换移动 UA 再试一次
    try {
      return await downloadViaFetch(videoUrl, destPath, timeoutMs, {
        ...BROWSER_DOWNLOAD_HEADERS,
        'User-Agent': MOBILE_UA,
        Referer: 'https://www.iesdouyin.com/',
      });
    } catch (err2) {
      throw new Error(
        `直链下载失败：${err?.message || err}；移动 UA 重试亦失败：${err2?.message || err2}`,
      );
    }
  }
}

async function downloadViaFetch(videoUrl, destPath, timeoutMs, headers = BROWSER_DOWNLOAD_HEADERS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(videoUrl, {
      signal: controller.signal,
      headers: { ...headers },
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (!res.body) throw new Error('下载响应无内容');
    await pipeline(res.body, createWriteStream(destPath));
    return await assertVideoFile(destPath);
  } finally {
    clearTimeout(timer);
  }
}

async function assertVideoFile(destPath) {
  const stat = await fsp.stat(destPath);
  if (stat.size < 1024) {
    throw new Error('下载的文件过小，可能不是有效视频');
  }
  return { path: destPath, size: stat.size };
}

export function fileExists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}
