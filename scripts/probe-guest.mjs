const awemeId = '7596637348747106985';
const page = `https://www.douyin.com/video/${awemeId}`;

// 1) warm-up for ttwid
const warm = await fetch('https://www.douyin.com/', {
  redirect: 'manual',
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    Accept: 'text/html',
  },
});
const setCookies = warm.headers.getSetCookie?.() || [];
const joined = setCookies.join('; ') + '; ' + (warm.headers.get('set-cookie') || '');
const ttwid = joined.match(/ttwid=([^;,\s]+)/i)?.[1];
console.log('warm', warm.status, 'ttwid', Boolean(ttwid), ttwid?.slice(0, 20));

const cookie = ttwid ? `ttwid=${ttwid}` : '';

for (const url of [
  `https://www.iesdouyin.com/share/video/${awemeId}`,
  page,
  `https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=${awemeId}&aid=6383&device_platform=webapp`,
]) {
  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      Accept: 'text/html,application/json,*/*',
      Referer: page,
      ...(cookie ? { Cookie: cookie } : {}),
    },
  });
  const text = await res.text();
  const hasPlay = /play_addr|playAddr|"uri":"v/.test(text);
  const mp4 = text.match(/https?:\\?\/\\?\/[^"'\\\s]+(?:\.mp4|\/play\/)[^"'\\\s]*/i)?.[0];
  console.log({
    url: url.slice(0, 60),
    status: res.status,
    len: text.length,
    hasPlay,
    mp4: mp4?.slice(0, 100) || null,
    head: text.slice(0, 120).replace(/\s+/g, ' '),
  });
}

try {
  const { resolveDouyinVideo } = await import('../src/lib/douyin.js');
  const r = await resolveDouyinVideo(page);
  console.log('resolve OK', { via: r.via, url: String(r.videoUrl).slice(0, 100) });
} catch (e) {
  console.log('resolve FAIL', e.message);
}
