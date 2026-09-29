import { chromium } from 'playwright';
import {
  extractAwemeId,
  looksLikeNoteInput,
  normalizeDouyinInput,
  pickImageUrlsFromItem,
} from './douyin.js';
import { loadCookieHeader } from './cookies.js';

/**
 * 用无头浏览器打开抖音网页版：
 * - 视频：拦直链并下载
 * - 图文 note：从详情 API / 页面 DOM 收集原图
 */
export async function resolveViaBrowser(
  inputUrl,
  { timeoutMs = 45_000, preferNote = false, onProgress } = {},
) {
  const tip = (msg) => onProgress?.(msg);
  const normalized = await normalizeDouyinInput(inputUrl);
  const awemeId = extractAwemeId(normalized);
  const isNote =
    preferNote || looksLikeNoteInput(normalized) || looksLikeNoteInput(inputUrl);
  const pageUrl = isNote
    ? `https://www.douyin.com/note/${awemeId}`
    : `https://www.douyin.com/video/${awemeId}`;

  const launchOpts = {
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  };
  tip('启动 Edge/Chrome…');
  let browser;
  for (const channel of ['msedge', 'chrome', null]) {
    try {
      browser = await chromium.launch(
        channel ? { ...launchOpts, channel } : launchOpts,
      );
      tip(channel ? `已用 ${channel}` : '已用 Playwright Chromium');
      break;
    } catch {
      // try next
    }
  }
  if (!browser) {
    throw new Error(
      '无法启动浏览器解析。请安装 Edge/Chrome，或执行: npx playwright install chromium',
    );
  }

  /** @type {{videoUrl:string|null, videoUri:string|null, desc:string, author:string, cover:string|null, candidates:string[], images:string[], contentType:string|null}} */
  const found = {
    videoUrl: null,
    videoUri: null,
    desc: '',
    author: '',
    cover: null,
    candidates: [],
    images: [],
    contentType: null,
  };

  try {
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
      locale: 'zh-CN',
      extraHTTPHeaders: {
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
    });

    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    const cookieHeader = await loadCookieHeader();
    let parsedCookies = cookieHeaderToPlaywright(cookieHeader);
    if (!parsedCookies.length) {
      tip('获取访客 ttwid…');
      const ttwid = await fetchGuestTtwid();
      if (ttwid) {
        parsedCookies = cookieHeaderToPlaywright(`ttwid=${ttwid}`);
      }
    }
    if (parsedCookies.length) {
      await context.addCookies(parsedCookies).catch(() => {});
      tip(`已注入 Cookie`);
    }

    const page = await context.newPage();
    // 已有 Cookie 时不再暖场首页，直接进作品页

    page.on('response', async (response) => {
      try {
        const url = response.url();
        const ct = (response.headers()['content-type'] || '').toLowerCase();

        if (/\/aweme\/v1\/web\/aweme\/detail\/?/i.test(url) && ct.includes('json')) {
          const data = await response.json().catch(() => null);
          const item = data?.aweme_detail || null;
          if (item && String(item.aweme_id) === String(awemeId)) {
            applyItem(found, item, awemeId);
            if (found.images?.length) tip(`拦截到详情：图文 ${found.images.length} 张`);
            else if (found.videoUrl) tip('拦截到详情：视频直链');
          }
          return;
        }

        if (isLikelyMediaUrl(url, ct) && urlMatchesAweme(url, awemeId)) {
          const clean = url.replace(/playwm/g, 'play');
          pushCandidate(found, clean);
          if (!found.videoUrl || /__vid=/.test(clean)) {
            found.videoUrl = clean;
            tip('拦截到媒体直链');
          }
        }
      } catch {
        // ignore
      }
    });

    tip(`打开作品页…`);
    await page.goto(pageUrl, {
      waitUntil: 'domcontentloaded',
      timeout: Math.min(timeoutMs, 25_000),
    });

    if (isNote) {
      tip('等待图文图片出现…');
      const deadline = Date.now() + 12_000;
      let lastCount = 0;
      let stableRounds = 0;
      while (Date.now() < deadline) {
        const scraped = await page.evaluate(scrapeNoteImagesFromDom).catch(() => null);
        mergeImages(found, scraped?.images || []);
        if (scraped?.desc && !found.desc) found.desc = scraped.desc;
        const n = found.images.length;
        if (n > lastCount) {
          tip(`已发现图文 ${n} 张…`);
          lastCount = n;
          stableRounds = 0;
        } else if (n > 0) {
          stableRounds += 1;
          // 连续约 0.75s 数量不再增加，认为加载完毕
          if (stableRounds >= 3) break;
        }
        await page.waitForTimeout(250).catch(() => {});
      }
    } else {
      tip('等待视频元素 / 直链…');
      await page.waitForSelector('video', { timeout: 12_000 }).catch(() => {});
      await page.evaluate(() => {
        try {
          const v = document.querySelector('video');
          if (v) {
            v.pause?.();
            v.muted = true;
          }
        } catch {
          // ignore
        }
      });
      // 短轮询：有直链或详情即可离开，最多约 4s
      const deadline = Date.now() + 4_000;
      while (Date.now() < deadline && !found.videoUrl && !found.candidates.length) {
        await page.waitForTimeout(200).catch(() => {});
      }
    }

    // DOM 兜底再扫一次
    const scraped = await page.evaluate(scrapeNoteImagesFromDom).catch(() => ({
      images: [],
      desc: '',
      author: '',
    }));
    if (scraped?.desc && !found.desc) found.desc = scraped.desc;
    if (scraped?.author && !found.author) found.author = scraped.author;
    mergeImages(found, scraped?.images || []);

    if (!found.images.length && !found.videoUrl && !isNote) {
      tip('视频页无直链，尝试 note 页…');
      await page
        .goto(`https://www.douyin.com/note/${awemeId}`, {
          waitUntil: 'domcontentloaded',
          timeout: Math.min(timeoutMs, 15_000),
        })
        .catch(() => {});
      const again = await page.evaluate(scrapeNoteImagesFromDom).catch(() => null);
      mergeImages(found, again?.images || []);
      if (again?.desc && !found.desc) found.desc = again.desc;
      if (again?.author && !found.author) found.author = again.author;
    }

    // 图文：只要拿到图片就直接返回，勿把背景音乐当成视频下载
    if (found.images.length && (isNote || !found.videoUrl || !looksLikeVideoMediaUrl(found.videoUrl))) {
      tip(`图文就绪：${found.images.length} 张`);
      found.contentType = 'images';
      return {
        awemeId,
        desc: found.desc,
        author: found.author,
        duration: null,
        videoUri: null,
        videoUrl: null,
        cover: found.images[0] || found.cover,
        images: found.images,
        contentType: 'images',
        sourceUrl: inputUrl,
        pageUrl: `https://www.douyin.com/note/${awemeId}`,
        via: 'browser-note',
      };
    }

    if (!found.videoUrl && found.candidates.length) {
      found.videoUrl = pickPreferredUrl(found.candidates, awemeId);
    }

    if (found.videoUrl && !looksLikeVideoMediaUrl(found.videoUrl)) {
      found.videoUrl = found.candidates.find((u) => looksLikeVideoMediaUrl(u)) || null;
    }
    found.candidates = found.candidates.filter((u) => looksLikeVideoMediaUrl(u));

    if (!found.videoUrl && !found.images.length) {
      throw new Error(
        isNote
          ? '浏览器模式未能获取图文图片（页面可能需登录或结构变更）'
          : '浏览器模式未能获取【本作品】视频地址（可能被连播/推荐流干扰，或需登录）',
      );
    }

    if (!found.videoUrl && found.images.length) {
      tip(`图文就绪：${found.images.length} 张`);
      return {
        awemeId,
        desc: found.desc,
        author: found.author,
        duration: null,
        videoUri: null,
        videoUrl: null,
        cover: found.images[0],
        images: found.images,
        contentType: 'images',
        sourceUrl: inputUrl,
        pageUrl: `https://www.douyin.com/note/${awemeId}`,
        via: 'browser-note',
      };
    }

    if (
      /__vid=|aweme_id=/.test(found.videoUrl) &&
      !urlMatchesAweme(found.videoUrl, awemeId)
    ) {
      throw new Error('解析到的视频地址与目标作品 ID 不一致，已中止，避免下错视频');
    }

    const tryUrls = uniqueUrls([
      found.videoUrl,
      ...rankCandidates(found.candidates, awemeId),
    ]);

    // CDN 直链交给流水线下载，避免浏览器阶段整包缓冲拖慢「解析」
    const preferred = tryUrls.find(
      (u) => looksLikeVideoMediaUrl(u) && isCdnVideoUrl(u) && !isSnssdkPlayUrl(u),
    );
    if (preferred) {
      tip('已拿到 CDN 直链（交由下载阶段拉取）');
      return {
        awemeId,
        desc: found.desc,
        author: found.author,
        duration: null,
        videoUri: found.videoUri,
        videoUrl: String(preferred).replace(/playwm/g, 'play'),
        cover: found.cover,
        images: found.images,
        contentType: found.images.length ? 'mixed' : 'video',
        sourceUrl: inputUrl,
        pageUrl,
        via: 'browser',
      };
    }

    tip('直链需浏览器会话下载，尝试拉取…');
    let buffer;
    let lastErr;
    for (const u of tryUrls) {
      try {
        buffer = await downloadWithContext(context, u);
        found.videoUrl = u;
        lastErr = null;
        tip('浏览器会话下载成功');
        break;
      } catch (err) {
        lastErr = err;
      }
    }
    if (!buffer) {
      throw lastErr || new Error('视频下载失败');
    }

    return {
      awemeId,
      desc: found.desc,
      author: found.author,
      duration: null,
      videoUri: found.videoUri,
      videoUrl: String(found.videoUrl).replace(/playwm/g, 'play'),
      cover: found.cover,
      images: found.images,
      contentType: found.images.length ? 'mixed' : 'video',
      sourceUrl: inputUrl,
      pageUrl,
      via: 'browser',
      videoBuffer: buffer,
    };
  } finally {
    await browser.close();
  }
}

/** 在页面上下文中收集图文原图（过滤推荐封面） */
function scrapeNoteImagesFromDom() {
  const score = (u) => {
    let n = 0;
    if (/~noop\./i.test(u)) n += 50;
    if (/biz_tag=aweme_images/i.test(u)) n += 40;
    if (/tplv-dy-aweme-images/i.test(u)) n += 30;
    if (/PackSourceEnum_AWEME_DETAIL/i.test(u)) n += 20;
    if (/:q100|:q90/i.test(u)) n += 10;
    if (/RELATED_AWEME|origshort-autoq|image-cut-tos|pcweb_cover/i.test(u) && !/aweme_images/i.test(u))
      n -= 50;
    return n;
  };

  const raw = [];
  for (const img of document.querySelectorAll('img')) {
    const src = img.currentSrc || img.src || '';
    if (!src || !/^https?:\/\//i.test(src)) continue;
    if (!/douyinpic\.com|byteimg\.com/i.test(src)) continue;
    if (!/aweme_images|tplv-dy-aweme-images|~noop\./i.test(src)) continue;
    if (/RELATED_AWEME|origshort-autoq:\d+|image-cut-tos/i.test(src) && !/aweme_images/i.test(src))
      continue;
    raw.push(src);
  }

  /** @type {Map<string, string>} */
  const byId = new Map();
  for (const u of raw) {
    const m = u.match(/\/([^/~?]+)~/);
    const key = m?.[1] || u;
    const prev = byId.get(key);
    if (!prev || score(u) > score(prev)) byId.set(key, u);
  }

  const title = document.title || '';
  const desc = title.replace(/\s*-\s*抖音\s*$/, '').trim();

  return {
    images: [...byId.values()],
    desc,
    author: '',
  };
}

function mergeImages(found, urls) {
  if (!Array.isArray(urls) || !urls.length) return;
  const set = new Set(found.images);
  for (const u of urls) {
    if (!u || set.has(u)) continue;
    set.add(u);
    found.images.push(u);
  }
}

function isCdnVideoUrl(url) {
  return /zjcdn\.com|douyinvod|bytecdn|tos-cn-ve|byteimg\.com|douyinpic/i.test(url);
}

function isSnssdkPlayUrl(url) {
  return /snssdk\.com\/aweme\/v1\/play/i.test(url);
}

function uniqueUrls(urls) {
  const seen = new Set();
  const out = [];
  for (const u of urls) {
    if (!u || seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out;
}

function rankCandidates(candidates, awemeId) {
  const list = [...(candidates || [])];
  list.sort((a, b) => scoreUrl(b, awemeId) - scoreUrl(a, awemeId));
  return list;
}

function scoreUrl(url, awemeId) {
  let s = 0;
  if (urlMatchesAweme(url, awemeId)) s += 50;
  if (isCdnVideoUrl(url)) s += 40;
  if (/\.mp4(\?|$)/i.test(url)) s += 20;
  if (isSnssdkPlayUrl(url)) s -= 30;
  if (/playwm/i.test(url)) s -= 10;
  return s;
}

function pickPreferredUrl(candidates, awemeId) {
  return rankCandidates(candidates, awemeId)[0] || null;
}

function cookieHeaderToPlaywright(header) {
  const parts = String(header || '')
    .replace(/^cookie:\s*/i, '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  /** @type {{name:string,value:string,domain:string,path:string}[]} */
  const out = [];
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!name || /[\s\t]/.test(name)) continue;
    for (const domain of ['.douyin.com', '.iesdouyin.com']) {
      out.push({ name, value, domain, path: '/' });
    }
  }
  return out;
}

async function fetchGuestTtwid() {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4_000);
    const res = await fetch('https://www.douyin.com/', {
      method: 'GET',
      redirect: 'manual',
      signal: ctrl.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        Accept: 'text/html',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
    });
    clearTimeout(timer);
    const raw = res.headers.getSetCookie?.() || [];
    const joined = Array.isArray(raw) ? raw.join(';') : String(res.headers.get('set-cookie') || '');
    return joined.match(/ttwid=([^;,\s]+)/i)?.[1] || '';
  } catch {
    return '';
  }
}

function isLikelyMediaUrl(url, ct) {
  if (url.startsWith('blob:')) return false;
  // 图文配乐常见 mp3/m4a，不当作视频直链
  if (/\.(mp3|m4a|aac)(\?|$)/i.test(url) || ct.includes('audio')) return false;
  if (ct.includes('video') || ct.includes('octet-stream')) return true;
  return (
    /\.mp4(\?|$)/i.test(url) ||
    /zjcdn\.com|douyinvod|bytecdn|tos-cn-ve|snssdk\.com\/aweme\/v1\/play/i.test(url)
  );
}

/** 粗判是否像可抽帧的视频（排除配乐） */
function looksLikeVideoMediaUrl(url) {
  if (!url) return false;
  if (/\.(mp3|m4a|aac)(\?|$)/i.test(url)) return false;
  if (/\/music\/|aweme\/v1\/music|audio/i.test(url) && !/\.mp4/i.test(url)) return false;
  return (
    /\.mp4(\?|$)/i.test(url) ||
    /zjcdn\.com|douyinvod|bytecdn|tos-cn-ve|snssdk\.com\/aweme\/v1\/play|__vid=/i.test(url)
  );
}

function urlMatchesAweme(url, awemeId) {
  if (!url || !awemeId) return false;
  const id = String(awemeId);
  return (
    url.includes(`__vid=${id}`) ||
    url.includes(`aweme_id=${id}`) ||
    url.includes(`item_ids=${id}`) ||
    url.includes(`/video/${id}`) ||
    url.includes(`/note/${id}`)
  );
}

function pushCandidate(found, url) {
  if (!url || found.candidates.includes(url)) return;
  found.candidates.push(url);
}

function applyItem(found, item, awemeId) {
  if (!item) return;
  if (awemeId && item.aweme_id && String(item.aweme_id) !== String(awemeId)) return;

  found.desc = item.desc || found.desc;
  found.author = item.author?.nickname || found.author;

  const images = pickImageUrlsFromItem(item);
  mergeImages(found, images);
  if (images.length && !found.cover) found.cover = images[0];

  const bitRates = [...(item.video?.bit_rate || [])].sort(
    (a, b) => (b.bit_rate || 0) - (a.bit_rate || 0),
  );

  const playAddrs = [
    ...bitRates.map((b) => b.play_addr),
    item.video?.play_addr,
    item.video?.download_addr,
    item.video?.play_addr_h264,
  ].filter(Boolean);

  for (const addr of playAddrs) {
    const uri = addr.uri || item.video?.vid;
    if (uri) found.videoUri = uri;
    for (const u of addr.url_list || []) {
      const clean = String(u).replace(/playwm/g, 'play');
      pushCandidate(found, clean);
      if (!found.videoUrl) found.videoUrl = clean;
    }
  }

  const cover =
    item.video?.cover?.url_list?.[0] || item.video?.origin_cover?.url_list?.[0];
  if (cover) found.cover = cover;

  if (found.videoUri && !found.videoUrl && !found.images.length) {
    found.videoUrl = `https://aweme.snssdk.com/aweme/v1/play/?video_id=${encodeURIComponent(
      found.videoUri,
    )}&ratio=1080p&line=0`;
  }
}

async function downloadWithContext(context, videoUrl) {
  const res = await context.request.get(videoUrl, {
    headers: {
      Referer: 'https://www.douyin.com/',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    },
    timeout: 120_000,
    maxRedirects: 10,
  });
  if (!res.ok()) {
    throw new Error(`浏览器下载视频失败 HTTP ${res.status()}`);
  }
  const ct = (res.headers()['content-type'] || '').toLowerCase();
  const buf = Buffer.from(await res.body());
  if (buf.length < 64 * 1024) {
    const head = buf.slice(0, 200).toString('utf8');
    if (
      ct.includes('json') ||
      ct.includes('html') ||
      ct.includes('text') ||
      /^\s*[<{]/.test(head)
    ) {
      throw new Error('浏览器下载的视频过小，可能不是有效文件');
    }
  }
  if (buf.length < 1024) {
    throw new Error('浏览器下载的视频过小，可能不是有效文件');
  }
  return buf;
}
