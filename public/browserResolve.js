/**
 * 浏览器端解析抖音视频直链：
 * 1) 同源 /api/proxy-fetch 拉 HTML（避免第三方 CORS 代理 Failed to fetch）
 * 2) 在浏览器里抽取 videoUrl
 * 3) 失败再试 /api/resolve-light
 * 最后由网页把 videoUrl 交给服务器下载抽帧。
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
  return text;
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

function looksLikeBlockedPage(html) {
  const s = String(html || '');
  return (
    /captcha|验证码|安全验证|sdk-glue|gfkadpd|__ac_signature|请完成验证/i.test(s) &&
    !/play_addr|playAddr|RENDER_DATA|_ROUTER_DATA[\s\S]{0,200}aweme/i.test(s)
  );
}

async function fetchTextViaSite(url, remoteBase, { timeoutMs = 22000 } = {}) {
  const res = await fetch(`${remoteBase}/api/proxy-fetch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `拉取页面失败 HTTP ${res.status}`);
  if (!data.text || data.text.length < 80) throw new Error('页面内容过短，可能被拦截');
  if (looksLikeBlockedPage(data.text)) {
    throw new Error('抖音返回了验证/风控页（机房出口被拦），无法从页面抽取直链');
  }
  return { text: data.text, finalUrl: data.finalUrl || url };
}

function pickPlayUrl(candidates) {
  const list = [...new Set(candidates.filter(Boolean).map((u) => String(u).replace(/playwm/g, 'play')))];
  list.sort((a, b) => {
    const score = (u) =>
      (/\.mp4/i.test(u) ? 10 : 0) +
      (/play\?|\/play\//i.test(u) ? 8 : 0) +
      (/aweme\/v1\/play/i.test(u) ? 6 : 0) -
      (/playwm/i.test(u) ? 5 : 0);
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

  const bit = obj.bit_rate || obj.bitRate || obj.play_addr || obj.playAddr || obj.download_addr;
  const candidates = [];
  const pushUrlList = (node) => {
    if (!node) return;
    const list = node.url_list || node.urlList || node.urls;
    if (Array.isArray(list)) candidates.push(...list);
    if (typeof node.url === 'string') candidates.push(node.url);
    if (typeof node.uri === 'string' && !node.uri.startsWith('http')) {
      candidates.push(
        `https://aweme.snssdk.com/aweme/v1/play/?video_id=${encodeURIComponent(node.uri)}&ratio=1080p&line=0`,
      );
    }
  };
  pushUrlList(obj.play_addr || obj.playAddr);
  pushUrlList(obj.download_addr || obj.downloadAddr);
  if (Array.isArray(bit)) bit.forEach((b) => pushUrlList(b.play_addr || b.playAddr));
  if (bit && !Array.isArray(bit)) pushUrlList(bit);

  const videoUrl = pickPlayUrl(candidates);
  if (videoUrl) {
    return {
      awemeId: String(obj.aweme_id || obj.awemeId || obj.group_id || ''),
      desc: obj.desc || obj.title || '',
      author: obj.author?.nickname || obj.author?.unique_id || '',
      videoUrl,
      via: 'browser-json',
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
    /window\._SSR_HYDRATED_DATA\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/i,
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
  const data = parseEmbeddedJson(html);
  if (data) {
    const meta = digVideoMeta(data);
    if (meta?.videoUrl) {
      return {
        awemeId: meta.awemeId || awemeId || '',
        desc: meta.desc || '',
        author: meta.author || '',
        videoUrl: meta.videoUrl,
        via: 'browser-html-json',
      };
    }
  }

  const mp4s = [...html.matchAll(/https?:\/\/[^"'\\\s<>]+/gi)]
    .map((m) => m[0])
    .filter((u) => /(\.mp4|aweme\/v1\/play|\/play\/)/i.test(u));
  const videoUrl = pickPlayUrl(mp4s);
  if (videoUrl) {
    return {
      awemeId: awemeId || extractAwemeId(html) || '',
      desc: '',
      author: '',
      videoUrl,
      via: 'browser-html-regex',
    };
  }
  return null;
}

async function normalizeViaServer(input, remoteBase) {
  try {
    const res = await fetch(`${remoteBase}/api/normalize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: input }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function resolveLightViaServer(input, remoteBase) {
  const res = await fetch(`${remoteBase}/api/resolve-light`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: input }),
    signal: AbortSignal.timeout(30000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `轻量解析失败 HTTP ${res.status}`);
  if (!data.videoUrl) throw new Error('轻量解析未返回直链');
  return data;
}

/**
 * 在浏览器中解析，返回 { videoUrl, meta }
 */
export async function resolveInBrowser(input, { remoteBase = window.location.origin, onProgress } = {}) {
  const tip = (msg) => onProgress?.(msg);
  const rawUrl = extractDouyinUrl(input);

  tip('提取视频 ID…');
  let awemeId = extractAwemeId(rawUrl);
  let pageUrl = rawUrl;

  if (!awemeId) {
    tip('展开短链…');
    const norm = await normalizeViaServer(rawUrl, remoteBase);
    if (norm?.awemeId) {
      awemeId = norm.awemeId;
      pageUrl = norm.pageUrl || norm.url || rawUrl;
    } else {
      try {
        const { text, finalUrl } = await fetchTextViaSite(rawUrl, remoteBase);
        awemeId = extractAwemeId(text) || extractAwemeId(finalUrl);
        const embedded =
          text.match(/https?:\/\/(?:www\.)?douyin\.com\/video\/\d+/i)?.[0] ||
          text.match(/https?:\/\/www\.iesdouyin\.com\/share\/video\/\d+/i)?.[0];
        if (embedded) pageUrl = embedded;
        if (!awemeId && embedded) awemeId = extractAwemeId(embedded);
      } catch {
        // continue to light resolve
      }
    }
  }

  if (awemeId) {
    const pages = [
      `https://www.iesdouyin.com/share/video/${awemeId}`,
      `https://www.douyin.com/video/${awemeId}`,
      pageUrl,
    ];

    tip('拉取页面并在浏览器解析直链…');
    for (const page of pages) {
      try {
        const { text } = await fetchTextViaSite(page, remoteBase);
        const meta = parseFromHtml(text, awemeId);
        if (meta?.videoUrl) {
          return {
            videoUrl: meta.videoUrl,
            meta: {
              awemeId,
              desc: meta.desc || '',
              author: meta.author || '',
              pageUrl: `https://www.douyin.com/video/${awemeId}`,
              sourceUrl: rawUrl,
              via: meta.via || 'browser',
            },
          };
        }
      } catch {
        // try next / fallback
      }
    }
  }

  tip('浏览器抽取失败，改用站点轻量解析…');
  try {
    return await resolveLightViaServer(rawUrl, remoteBase);
  } catch (err) {
    throw new Error(
      (err?.message || String(err)) +
        '\n\n原因：网页不能直接跨域访问抖音；由站点代拉时又碰上机房 IP 风控。\n' +
        '可用方案：本机执行 npm run agent 后打开 http://127.0.0.1:3791，或配置住宅代理 DOUYIN_PROXY。',
    );
  }
}
