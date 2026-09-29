import { chromium } from 'playwright';
import { extractAwemeId, normalizeDouyinInput } from './douyin.js';

/**
 * 用无头浏览器打开抖音网页版，严格绑定 aweme_id 拿原视频直链。
 * 避免误抓「推荐视频 / 相关视频」的播放地址。
 */
export async function resolveViaBrowser(inputUrl, { timeoutMs = 60_000 } = {}) {
  const normalized = await normalizeDouyinInput(inputUrl);
  const awemeId = extractAwemeId(normalized);
  const pageUrl = `https://www.douyin.com/video/${awemeId}`;

  // 优先用本机 Edge/Chrome（无需另下 Chromium，也不用登录账号）
  const launchOpts = {
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  };
  let browser;
  for (const channel of ['msedge', 'chrome', null]) {
    try {
      browser = await chromium.launch(
        channel ? { ...launchOpts, channel } : launchOpts,
      );
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

  /** @type {{videoUrl:string|null, videoUri:string|null, desc:string, author:string, cover:string|null, candidates:string[]}} */
  const found = {
    videoUrl: null,
    videoUri: null,
    desc: '',
    author: '',
    cover: null,
    candidates: [],
  };

  try {
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      viewport: { width: 1440, height: 900 },
      locale: 'zh-CN',
      extraHTTPHeaders: {
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
    });

    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    const page = await context.newPage();

    page.on('response', async (response) => {
      try {
        const url = response.url();
        const ct = (response.headers()['content-type'] || '').toLowerCase();

        // 详情 API：只接受目标 aweme_id
        if (/\/aweme\/v1\/web\/aweme\/detail\/?/i.test(url) && ct.includes('json')) {
          const data = await response.json().catch(() => null);
          const item = data?.aweme_detail || null;
          if (item && String(item.aweme_id) === String(awemeId)) {
            applyItem(found, item, awemeId);
          }
          return;
        }

        // 媒体流：必须带本视频 id，排除推荐流
        if (isLikelyMediaUrl(url, ct) && urlMatchesAweme(url, awemeId)) {
          const clean = url.replace(/playwm/g, 'play');
          pushCandidate(found, clean);
          // 优先保留带 __vid= 的直链
          if (!found.videoUrl || /__vid=/.test(clean)) {
            found.videoUrl = clean;
          }
        }
      } catch {
        // ignore
      }
    });

    await page.goto(pageUrl, {
      waitUntil: 'domcontentloaded',
      timeout: timeoutMs,
    });

    await page.waitForSelector('video', { timeout: 20_000 }).catch(() => {});

    // 尽量停在当前作品，避免连播切到推荐
    await page.evaluate(() => {
      try {
        localStorage.setItem('douyin_pc_web_auto_play_next', '0');
      } catch {
        // ignore
      }
      for (const v of document.querySelectorAll('video')) {
        try {
          v.loop = true;
          v.autoplay = true;
          v.muted = true;
          v.play?.().catch?.(() => {});
        } catch {
          // ignore
        }
      }
    }).catch(() => {});

    const deadline = Date.now() + Math.min(timeoutMs, 25_000);
    while (Date.now() < deadline) {
      const fromDom = await page.evaluate((id) => {
        const videos = [...document.querySelectorAll('video')];
        const srcs = videos
          .flatMap((v) => [
            v.src,
            v.currentSrc,
            ...[...v.querySelectorAll('source')].map((s) => s.src),
          ])
          .filter((s) => s && !s.startsWith('blob:'));

        const matched = srcs.filter(
          (s) =>
            s.includes(`__vid=${id}`) ||
            s.includes(`aweme_id=${id}`) ||
            s.includes(`/video/${id}`),
        );

        const title =
          document
            .querySelector('[data-e2e="browse-video-desc"], [data-e2e="video-desc"], .video-info-detail')
            ?.textContent?.trim() ||
          document.title.replace(/\s*-\s*抖音\s*$/, '').trim();

        return { matched, srcs, title };
      }, awemeId);

      if (fromDom.title && !found.desc) found.desc = fromDom.title;

      for (const s of fromDom.matched) pushCandidate(found, s);
      if (fromDom.matched[0]) {
        found.videoUrl = fromDom.matched[0];
        break;
      }

      // 已有 detail 解析出的地址也可结束
      if (found.videoUrl && found.videoUri) break;
      await page.waitForTimeout(400);
    }

    // 有 videoUri 时优先走 1080p 无水印播放接口（画质通常更好）
    if (found.videoUri) {
      const hi =
        `https://aweme.snssdk.com/aweme/v1/play/?video_id=${encodeURIComponent(
          found.videoUri,
        )}&ratio=1080p&line=0`;
      pushCandidate(found, hi);
      found.videoUrl = hi;
    }

    if (!found.videoUrl && found.candidates.length) {
      found.videoUrl =
        found.candidates.find((u) => urlMatchesAweme(u, awemeId)) || found.candidates[0];
    }

    if (!found.videoUrl) {
      throw new Error(
        '浏览器模式未能获取【本作品】视频地址（可能被连播/推荐流干扰，或需登录）',
      );
    }

    // 最终校验：能识别 id 的链接必须匹配
    if (
      /__vid=|aweme_id=/.test(found.videoUrl) &&
      !urlMatchesAweme(found.videoUrl, awemeId)
    ) {
      throw new Error('解析到的视频地址与目标作品 ID 不一致，已中止，避免下错视频');
    }

    // 用浏览器上下文下载更稳（带 cookie / 防盗链）
    let buffer;
    try {
      buffer = await downloadWithContext(context, found.videoUrl);
    } catch (err) {
      // 1080p 接口失败时回退到已匹配的 CDN 直链
      const fallback = found.candidates.find(
        (u) => u !== found.videoUrl && (urlMatchesAweme(u, awemeId) || /zjcdn|douyinvod|tos-cn-ve/i.test(u)),
      );
      if (!fallback) throw err;
      found.videoUrl = fallback;
      buffer = await downloadWithContext(context, fallback);
    }

    return {
      awemeId,
      desc: found.desc,
      author: found.author,
      duration: null,
      videoUri: found.videoUri,
      videoUrl: String(found.videoUrl).replace(/playwm/g, 'play'),
      cover: found.cover,
      sourceUrl: inputUrl,
      pageUrl,
      via: 'browser',
      videoBuffer: buffer,
    };
  } finally {
    await browser.close();
  }
}

function isLikelyMediaUrl(url, ct) {
  if (url.startsWith('blob:')) return false;
  if (ct.includes('video') || ct.includes('octet-stream')) return true;
  return (
    /\.mp4(\?|$)/i.test(url) ||
    /zjcdn\.com|douyinvod|bytecdn|tos-cn-ve|snssdk\.com\/aweme\/v1\/play/i.test(url)
  );
}

function urlMatchesAweme(url, awemeId) {
  if (!url || !awemeId) return false;
  const id = String(awemeId);
  return (
    url.includes(`__vid=${id}`) ||
    url.includes(`aweme_id=${id}`) ||
    url.includes(`item_ids=${id}`) ||
    url.includes(`/video/${id}`)
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
      // detail 里的地址优先（通常就是本作品）
      if (!found.videoUrl) found.videoUrl = clean;
    }
  }

  const cover =
    item.video?.cover?.url_list?.[0] || item.video?.origin_cover?.url_list?.[0];
  if (cover) found.cover = cover;

  if (found.videoUri && !found.videoUrl) {
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
  });
  if (!res.ok()) {
    throw new Error(`浏览器下载视频失败 HTTP ${res.status()}`);
  }
  const buf = Buffer.from(await res.body());
  if (buf.length < 1024) {
    throw new Error('浏览器下载的视频过小，可能不是有效文件');
  }
  return buf;
}
