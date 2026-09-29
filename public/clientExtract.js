/**
 * 纯用户浏览器端提取抖音视频直链（第一步专用）
 * - 不调用本站 /api/proxy-fetch（那是机房出口）
 * - 不走本机 agent、不走 DOUYIN_PROXY
 * - 只做：本地抽 ID + 浏览器直连/跨域代理拉页 + 本地解析 HTML
 */

export function extractDouyinUrl(input) {
  const text = String(input || '').trim();
  if (!text) throw new Error('请提供抖音视频链接');

  const urlMatch = text.match(
    /https?:\/\/(?:v\.douyin\.com|(?:www\.)?iesdouyin\.com|(?:www\.)?douyin\.com)\/[^\s"'<>，。；！？）\]]+/i,
  );
  if (urlMatch?.[0]) {
    return urlMatch[0].replace(/[),.;！？]+$/g, '');
  }

  const short = text.match(/(?:^|\s)(v\.douyin\.com\/[A-Za-z0-9_-]+\/?)/i);
  if (short?.[1]) return `https://${short[1]}`;

  if (/^https?:\/\//i.test(text)) return text;
  throw new Error('未识别到抖音链接');
}

export function extractAwemeId(input) {
  const text = String(input || '').trim();
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
  if (/^\d{15,25}$/.test(text)) return text;
  return null;
}

const CORS_PROXIES = [
  (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  (u) => `https://corsproxy.io/?${encodeURIComponent(u)}`,
  (u) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`,
];

function looksLikeBlockedPage(html) {
  const s = String(html || '');
  return (
    /captcha|验证码|安全验证|sdk-glue|gfkadpd|请完成验证/i.test(s) &&
    !/play_addr|playAddr|RENDER_DATA/i.test(s)
  );
}

function pickPlayUrl(candidates) {
  const list = [...new Set(candidates.filter(Boolean).map((u) => String(u).replace(/playwm/g, 'play')))];
  list.sort((a, b) => {
    const score = (u) =>
      (/\.mp4/i.test(u) ? 10 : 0) +
      (/play\?|\/play\//i.test(u) ? 8 : 0) +
      (/aweme\/v1\/play/i.test(u) ? 6 : 0);
    return score(b) - score(a);
  });
  return list[0] || null;
}

function digVideoMeta(obj, depth = 0) {
  if (!obj || depth > 12) return null;
  if (typeof obj === 'string') {
    if (/^https?:\/\//i.test(obj) && /(\.mp4|\/play\/|aweme\/v1\/play)/i.test(obj)) {
      return { videoUrl: obj.replace(/playwm/g, 'play') };
    }
    return null;
  }
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = digVideoMeta(item, depth + 1);
      if (found?.videoUrl) return found;
    }
    return null;
  }
  if (typeof obj !== 'object') return null;

  const candidates = [];
  const pushUrlList = (node) => {
    if (!node) return;
    const list = node.url_list || node.urlList || node.urls;
    if (Array.isArray(list)) candidates.push(...list);
    if (typeof node.url === 'string') candidates.push(node.url);
    if (typeof node.uri === 'string' && !/^https?:/i.test(node.uri)) {
      candidates.push(
        `https://aweme.snssdk.com/aweme/v1/play/?video_id=${encodeURIComponent(node.uri)}&ratio=1080p&line=0`,
      );
    }
  };
  pushUrlList(obj.play_addr || obj.playAddr);
  pushUrlList(obj.download_addr || obj.downloadAddr);
  const bit = obj.bit_rate || obj.bitRate;
  if (Array.isArray(bit)) bit.forEach((b) => pushUrlList(b.play_addr || b.playAddr));
  if (bit && !Array.isArray(bit)) pushUrlList(bit);

  const videoUrl = pickPlayUrl(candidates);
  if (videoUrl) {
    return {
      awemeId: String(obj.aweme_id || obj.awemeId || ''),
      videoUrl,
    };
  }
  for (const key of Object.keys(obj)) {
    const found = digVideoMeta(obj[key], depth + 1);
    if (found?.videoUrl) return found;
  }
  return null;
}

function parseEmbeddedJson(html) {
  const patterns = [
    /window\._ROUTER_DATA\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/i,
    /<script id="RENDER_DATA" type="application\/json">([^<]+)<\/script>/i,
    /window\.__RENDER_DATA__\s*=\s*"([^"]+)"/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (!m?.[1]) continue;
    try {
      let raw = m[1];
      if (!raw.trim().startsWith('{') && !raw.trim().startsWith('[')) {
        raw = decodeURIComponent(raw);
      }
      return JSON.parse(raw);
    } catch {
      // continue
    }
  }
  return null;
}

function parseFromHtml(html, awemeId) {
  if (looksLikeBlockedPage(html)) {
    throw new Error('拿到的是验证/风控页，不是作品页');
  }
  const data = parseEmbeddedJson(html);
  if (data) {
    const meta = digVideoMeta(data);
    if (meta?.videoUrl) {
      return { awemeId: meta.awemeId || awemeId || '', videoUrl: meta.videoUrl, via: 'html-json' };
    }
  }
  const urls = [...html.matchAll(/https?:\/\/[^"'\\\s<>]+/gi)]
    .map((m) => m[0])
    .filter((u) => /(\.mp4|aweme\/v1\/play|\/play\/)/i.test(u));
  const videoUrl = pickPlayUrl(urls);
  if (videoUrl) return { awemeId: awemeId || '', videoUrl, via: 'html-regex' };
  return null;
}

async function fetchHtmlDirect(url) {
  const res = await fetch(url, {
    mode: 'cors',
    credentials: 'omit',
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`直连 HTTP ${res.status}`);
  return { text: await res.text(), finalUrl: res.url || url, via: 'direct-cors' };
}

async function fetchHtmlViaPublicProxy(url) {
  let lastErr = null;
  for (const build of CORS_PROXIES) {
    const proxyUrl = build(url);
    try {
      const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) {
        lastErr = new Error(`公共代理 HTTP ${res.status}`);
        continue;
      }
      const text = await res.text();
      if (text.length < 80) {
        lastErr = new Error('公共代理返回过短');
        continue;
      }
      return { text, finalUrl: url, via: 'public-cors-proxy' };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('公共跨域代理全部失败');
}

async function fetchHtmlInBrowser(url, onProgress) {
  // 1) 浏览器直连抖音（通常被 CORS 拦截，记日志）
  try {
    onProgress?.(`尝试浏览器直连 ${url}`);
    return await fetchHtmlDirect(url);
  } catch (err) {
    onProgress?.(`直连失败（预期内）：${err.message || err}`);
  }
  // 2) 公共 CORS 代理（请求从用户浏览器发出，不是我们机房）
  onProgress?.('尝试公共跨域代理拉取页面…');
  return fetchHtmlViaPublicProxy(url);
}

/**
 * @returns {Promise<{videoUrl:string, awemeId:string, via:string, pageUrl:string}>}
 */
export async function resolveVideoUrlInUserBrowser(input, { onProgress } = {}) {
  const tip = (m) => onProgress?.(m);
  const raw = extractDouyinUrl(input);
  let awemeId = extractAwemeId(raw);
  let pageUrl = raw;

  if (!awemeId && /v\.douyin\.com/i.test(raw)) {
    tip('短链：在浏览器侧展开…');
    const { text, finalUrl } = await fetchHtmlInBrowser(raw, tip);
    awemeId = extractAwemeId(finalUrl) || extractAwemeId(text);
    const embedded =
      text.match(/https?:\/\/(?:www\.)?douyin\.com\/video\/\d+/i)?.[0] ||
      text.match(/https?:\/\/www\.iesdouyin\.com\/share\/video\/\d+/i)?.[0];
    if (embedded) pageUrl = embedded;
    if (!awemeId && embedded) awemeId = extractAwemeId(embedded);
  }

  if (!awemeId) {
    throw new Error('无法得到 awemeId（短链展开或输入格式失败）');
  }

  const candidates = [
    `https://www.iesdouyin.com/share/video/${awemeId}`,
    `https://www.douyin.com/video/${awemeId}`,
    pageUrl,
  ];

  let lastErr = null;
  for (const page of candidates) {
    try {
      tip(`解析页面：${page}`);
      const { text, via: fetchVia } = await fetchHtmlInBrowser(page, tip);
      const parsed = parseFromHtml(text, awemeId);
      if (parsed?.videoUrl) {
        return {
          videoUrl: parsed.videoUrl,
          awemeId,
          pageUrl: `https://www.douyin.com/video/${awemeId}`,
          via: `${fetchVia}+${parsed.via}`,
        };
      }
      lastErr = new Error('页面中未找到 play 直链');
    } catch (err) {
      lastErr = err;
      tip(`该页失败：${err.message || err}`);
    }
  }

  throw new Error(lastErr?.message || '用户浏览器未能提取视频直链');
}
