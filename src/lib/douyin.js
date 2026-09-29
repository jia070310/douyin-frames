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

async function fetchSharePage(awemeId, { preferNote = false, onProgress } = {}) {
  // 只打最可能有数据的 2 个地址，并行竞速（旧逻辑 4 个串行太慢）
  const urls = preferNote
    ? [
        `https://www.iesdouyin.com/share/note/${awemeId}`,
        `https://www.douyin.com/note/${awemeId}`,
      ]
    : [
        `https://www.iesdouyin.com/share/video/${awemeId}`,
        `https://www.douyin.com/video/${awemeId}`,
      ];

  let cookie = '';
  try {
    cookie = await fetchTtwidCookie();
  } catch {
    // ignore
  }

  onProgress?.(`HTTP 分享页并行探测（${urls.length}）…`);

  const tryOne = async (url) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 7_000);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: {
          ...DEFAULT_HEADERS,
          'User-Agent': url.includes('iesdouyin') ? MOBILE_UA : DESKTOP_UA,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          ...(cookie ? { Cookie: cookie } : {}),
        },
      });
      if (!res.ok) return null;
      const html = await res.text();
      const data = parseEmbeddedJson(html);
      if (data) {
        const meta = digVideoMeta(data);
        if (meta?.videoUrl || meta?.videoUri || meta?.images?.length) {
          meta.via = meta.via || 'share-html';
          return meta;
        }
      }
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
          images: [],
          via: 'share-html-mp4',
        };
      }
      return null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  const results = await Promise.all(urls.map(tryOne));
  return results.find((m) => m?.videoUrl || m?.videoUri || m?.images?.length) || null;
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

/** @type {{ value: string, at: number } | null} */
let ttwidCache = null;

/** 尝试拿到 Cookie：优先本机已保存的登录 Cookie，其次纯 HTTP 拿 ttwid */
async function fetchTtwidCookie() {
  if (ttwidCache && Date.now() - ttwidCache.at < 90_000) {
    return ttwidCache.value;
  }
  try {
    const { loadCookieHeader } = await import('./cookies.js');
    const saved = await loadCookieHeader();
    if (saved) {
      ttwidCache = { value: saved, at: Date.now() };
      return saved;
    }
  } catch {
    // ignore
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5_000);
    const res = await fetch('https://www.douyin.com/', {
      method: 'GET',
      redirect: 'manual',
      signal: ctrl.signal,
      headers: {
        'User-Agent': DESKTOP_UA,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
    });
    clearTimeout(timer);
    const raw = res.headers.getSetCookie?.() || [];
    const joined = Array.isArray(raw) ? raw.join(';') : String(res.headers.get('set-cookie') || '');
    const m = joined.match(/ttwid=([^;,\s]+)/i);
    if (m?.[1]) {
      const v = `ttwid=${m[1]}`;
      ttwidCache = { value: v, at: Date.now() };
      return v;
    }
  } catch {
    // ignore
  }
  ttwidCache = { value: '', at: Date.now() };
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
 * 1) HTTP 分享页 / Web API（并行）
 * 2) 无头 Edge/Chrome（图文优先；视频在 HTTP 失败后）
 * 3) yt-dlp（已安装时短超时，不在解析时自动下载）
 *
 * @param {string} inputUrl
 * @param {{ useBrowser?: boolean, onProgress?: (msg:string)=>void }} [opts]
 */
export async function resolveDouyinVideo(inputUrl, { useBrowser = true, onProgress } = {}) {
  const tip = (msg) => onProgress?.(msg);

  tip('规范化链接…');
  let url = await normalizeDouyinInput(inputUrl);
  const awemeId = extractAwemeId(url);
  const preferNote = looksLikeNoteInput(url) || looksLikeNoteInput(inputUrl);
  tip(`作品 ID ${awemeId}${preferNote ? '（图文）' : ''}`);

  /** @type {Promise<any>|null} */
  let browserPromise = null;
  const startBrowser = () => {
    if (!useBrowser || browserPromise) return browserPromise;
    tip('启动本机浏览器解析…');
    browserPromise = import('./browserResolve.js')
      .then(({ resolveViaBrowser }) =>
        resolveViaBrowser(url, {
          preferNote,
          timeoutMs: preferNote ? 35_000 : 45_000,
          onProgress: tip,
        }),
      )
      .catch((err) => {
        const message = err?.message || String(err);
        tip(`浏览器解析失败：${message}`);
        return { __error: message };
      });
    return browserPromise;
  };

  tip('HTTP 并行解析（分享页 + 详情接口）…');
  const [shareMeta, detailMeta] = await Promise.all([
    fetchSharePage(awemeId, { preferNote, onProgress: tip }),
    fetchWebDetail(awemeId),
  ]);

  let meta =
    (shareMeta?.videoUrl || shareMeta?.images?.length ? shareMeta : null) ||
    (detailMeta?.videoUrl || detailMeta?.images?.length ? detailMeta : null) ||
    shareMeta ||
    detailMeta || {
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
    tip('通过 video_id 换直链…');
    const play = await resolvePlayUrlByUri(meta.videoUri);
    if (play) {
      meta.videoUrl = play;
      tip('已拿到播放直链');
    }
  }

  if (meta.videoUrl || meta.images?.length) {
    tip(
      meta.images?.length
        ? `HTTP 已拿到图文 ${meta.images.length} 张（${meta.via || 'http'}）`
        : `HTTP 已拿到视频直链（${meta.via || 'http'}）`,
    );
  } else {
    tip('HTTP 未拿到媒体，改用浏览器…');
  }

  const needBrowser =
    useBrowser &&
    ((!meta.videoUrl && !meta.videoBuffer && !meta.images?.length) ||
      (preferNote && !meta.images?.length));

  if (needBrowser) {
    const browserMeta = await startBrowser();
    if (browserMeta && !browserMeta.__error) {
      meta = {
        ...meta,
        ...browserMeta,
        images: browserMeta.images?.length ? browserMeta.images : meta.images,
        via: browserMeta.via || 'browser',
      };
      tip(
        browserMeta.images?.length
          ? `浏览器已拿到图文 ${browserMeta.images.length} 张`
          : '浏览器已拿到视频地址',
      );
    } else if (browserMeta?.__error) {
      meta.browserHint = browserMeta.__error;
    }
  }

  // yt-dlp：仅本机已安装时短超时尝试；解析阶段不自动下载（避免卡 20MB）
  if (!meta.videoUrl && !meta.videoBuffer && !meta.images?.length && !preferNote) {
    tip('尝试 yt-dlp（若已安装）…');
    try {
      const { resolveViaYtDlp, findYtDlp } = await import('./ytDlp.js');
      if (!findYtDlp()) {
        tip('未安装 yt-dlp，跳过');
      } else {
        const y = await resolveViaYtDlp(url, { autoInstall: false, timeoutMs: 20_000 });
        if (y?.videoUrl) {
          meta.videoUrl = y.videoUrl;
          meta.via = 'yt-dlp';
          if (y.title) meta.desc = meta.desc || y.title;
          if (y.uploader) meta.author = meta.author || y.uploader;
          tip('yt-dlp 已拿到直链');
        } else if (y?.errorHint) {
          meta.ytDlpHint = y.errorHint;
          tip(`yt-dlp 未成功：${y.errorHint}`);
        }
      }
    } catch (err) {
      tip(`yt-dlp 异常：${err?.message || err}`);
    }
  }

  const hasImages = Array.isArray(meta.images) && meta.images.length > 0;

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

  const pageUrl =
    preferNote || (hasImages && !meta.videoUrl)
      ? `https://www.douyin.com/note/${meta.awemeId}`
      : `https://www.douyin.com/video/${meta.awemeId}`;

  tip(`解析完成（via=${meta.via || 'http'}）`);
  return {
    ...meta,
    sourceUrl: url,
    pageUrl,
    contentType:
      hasImages && !meta.videoUrl && !meta.videoBuffer ? 'images' : meta.contentType || 'video',
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
