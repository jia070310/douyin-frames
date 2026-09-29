const awemeId = process.argv[2] || '7129847345999416576';
const urls = [
  `https://www.iesdouyin.com/share/video/${awemeId}`,
  `https://www.douyin.com/video/${awemeId}`,
];

for (const url of urls) {
  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      Accept: 'text/html',
    },
  });
  const html = await res.text();
  const mp4 = html.match(/https?:\/\/[^"'\\\s]+\.mp4[^"'\\\s]*/i)?.[0];
  console.log({
    url,
    status: res.status,
    len: html.length,
    hasRender: /RENDER_DATA|_ROUTER_DATA|play_addr|aweme_detail/.test(html),
    hasCaptcha: /captcha|验证码|安全验证/.test(html),
    mp4: mp4?.slice(0, 120) || null,
  });
}

const api = `https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=${awemeId}&aid=6383&device_platform=webapp`;
const r2 = await fetch(api, {
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Referer: `https://www.douyin.com/video/${awemeId}`,
  },
});
const t = await r2.text();
console.log({ detailStatus: r2.status, bodyHead: t.slice(0, 240) });

try {
  const { resolveDouyinVideo } = await import('../src/lib/douyin.js');
  const r = await resolveDouyinVideo(`https://www.douyin.com/video/${awemeId}`);
  console.log({
    ok: true,
    via: r.via,
    awemeId: r.awemeId,
    urlHead: String(r.videoUrl || '').slice(0, 100),
  });
} catch (e) {
  console.log({ ok: false, error: e.message });
}
