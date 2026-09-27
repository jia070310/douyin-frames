import { chromium } from 'playwright';
import { extractAwemeId, normalizeDouyinInput } from './douyin.js';
import { getPlaywrightProxy } from './proxy.js';

/**
 * 用无头浏览器打开抖音网页版，严格绑定 aweme_id 拿原视频直链。
 * 避免误抓「推荐视频 / 相关视频」的播放地址。
 * 机房 IP 请配置 DOUYIN_PROXY（住宅/移动代理）。
 */
export async function resolveViaBrowser(inputUrl, { timeoutMs = 60_000 } = {}) {
  const normalized = await normalizeDouyinInput(inputUrl);
  const awemeId = extractAwemeId(normalized);
  const pageUrl = `https://www.douyin.com/video/${awemeId}`;
  const proxy = getPlaywrightProxy();

  const browser = await chromium.launch({
    headless: true,
    proxy,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  });

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

        // 详情 / 相关 JSON：只接受目标 aweme_id
        if (
          (/\/aweme\/v1\/web\/aweme\/detail\/?/i.test(url) ||
            /iteminfo|aweme\/detail/i.test(url)) &&
          (ct.includes('json') || ct.includes('text/plain'))
        ) {
          const text = await response.text().catch(() => '');
          if (!text) return;
          let data = null;
          try {
            data = JSON.parse(text);
          } catch {
            return;
          }
          const item = data?.aweme_detail || data?.item_list?.[0] || null;
          if (item && String(item.aweme_id) === String(awemeId)) {
            applyItem(found, item, awemeId);
          }
          return;
        }

        // 媒体流：必须带本视频 id，排除推荐流
        if (isLikelyMediaUrl(url, ct) && urlMatchesAweme(url, awemeId)) {
          const clean = url.replace(/playwm/g, 'play');
          pushCandidate(found, clean);
          if (!found.videoUrl || /__vid=/.test(clean)) {
            found.videoUrl = clean;
          }
        }
      } catch {
        // ignore
      }
    });

    // 先拿 ttwid 等 cookie，再进作品页
    await page.goto('https://www.douyin.com/', {
      waitUntil: 'domcontentloaded',
      timeout: Math.min(timeoutMs, 30_000),
    }).catch(() => {});
    await page.waitForTimeout(1500);

    await page.goto(pageUrl, {
      waitUntil: 'domcontentloaded',
      timeout: timeoutMs,
    });

    await page.waitForSelector('video', { timeout: 20_000 }).catch(() => {});

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

    const deadline = Date.now() + Math.min(timeoutMs, 28_000);
    while (Date.now() < deadline) {
      if (found.videoUrl) break;

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

        const stuck = (document.body?.innerText || '').includes('视频数据加载中');

        return { matched, srcs, title, stuck };
      }, awemeId);

      if (fromDom.title && !found.desc) found.desc = fromDom.title;

      for (const s of fromDom.matched) pushCandidate(found, s);
      if (fromDom.matched[0]) {
        found.videoUrl = fromDom.matched[0];
        break;
      }

      if (found.videoUrl && found.videoUri) break;
      await page.waitForTimeout(400);
    }

    if (found.videoUri) {
      const hi = `https://aweme.snssdk.com/aweme/v1/play/?video_id=${encodeURIComponent(
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
      const hint = proxy
        ? '请确认代理为住宅/移动线路且可访问抖音'
        : '当前服务器机房 IP 易被抖音拦截，请配置环境变量 DOUYIN_PROXY（住宅/移动代理）后重启';
      throw new Error(
        `浏览器模式未能获取【本作品】视频地址（可能被风控/需登录）。${hint}`,
      );
    }

    if (
      /__vid=|aweme_id=/.test(found.videoUrl) &&
      !urlMatchesAweme(found.videoUrl, awemeId)
    ) {
      throw new Error('解析到的视频地址与目标作品 ID 不一致，已中止，避免下错视频');
    }

    let buffer;
    try {
      buffer = await downloadWithContext(context, found.videoUrl);
    } catch (err) {
      const fallback = found.candidates.find(
        (u) =>
          u !== found.videoUrl &&
          (urlMatchesAweme(u, awemeId) || /zjcdn|douyinvod|tos-cn-ve/i.test(u)),
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
