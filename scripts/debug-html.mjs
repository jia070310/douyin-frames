const awemeId = '7129847345999416576';
const url = `https://www.iesdouyin.com/share/video/${awemeId}`;
const res = await fetch(url, {
  headers: {
    'User-Agent':
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    Accept: 'text/html',
  },
});
const html = await res.text();
for (const name of ['_ROUTER_DATA', 'RENDER_DATA', '_SSR_HYDRATED_DATA', 'play_addr', 'playAddr', 'video_id']) {
  console.log(name, html.includes(name));
}
const m1 = html.match(/window\._ROUTER_DATA\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/i);
const m2 = html.match(/<script id="RENDER_DATA" type="application\/json">([^<]+)<\/script>/i);
const m3 = html.match(/window\.__RENDER_DATA__\s*=\s*"([^"]+)"/i);
console.log({ router: !!m1, renderScript: !!m2, renderWin: !!m3 });
if (m2) {
  try {
    const raw = decodeURIComponent(m2[1]);
    const data = JSON.parse(raw);
    console.log('keys', Object.keys(data).slice(0, 20));
    const s = JSON.stringify(data);
    console.log('has play_addr', s.includes('play_addr'));
    console.log('has video', /"video"/.test(s));
    const uri = s.match(/"uri":"(v[^"]+)"/);
    console.log('uri sample', uri?.[1]?.slice(0, 80));
    const urlMatch = s.match(/https:\\\/\\\/[^"]+play[^"]+/);
    console.log('escaped url', urlMatch?.[0]?.slice(0, 120));
  } catch (e) {
    console.log('parse fail', e.message, m2[1].slice(0, 120));
  }
}
if (m1) {
  try {
    const data = JSON.parse(m1[1]);
    const s = JSON.stringify(data);
    console.log('router keys', Object.keys(data).slice(0, 15));
    console.log('router play_addr', s.includes('play_addr'), 'len', s.length);
  } catch (e) {
    console.log('router parse', e.message);
  }
}

// try iesdouyin reflow/web api
const apis = [
  `https://www.iesdouyin.com/web/api/v2/aweme/iteminfo/?item_ids=${awemeId}`,
  `https://www.iesdouyin.com/aweme/v1/web/aweme/detail/?aweme_id=${awemeId}&aid=1128&device_platform=webapp&channel=channel_pc_web`,
];
for (const api of apis) {
  const r = await fetch(api, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      Referer: url,
    },
  });
  const t = await r.text();
  console.log('api', api.split('?')[0], r.status, t.slice(0, 180).replace(/\s+/g, ' '));
}
