/**
 * 抖音页同源提取：书签脚本在 douyin.com 执行，读 video.currentSrc / 页内 play URL，
 * 再跳回本站并带上 videoUrl（服务器只下载+抽帧）。
 */

export function buildBookmarklet(siteOrigin = window.location.origin) {
  const origin = String(siteOrigin || '').replace(/\/+$/, '');
  // 压缩为一行 javascript: URL
  const body = `
(function(){
  var O=${JSON.stringify(origin)};
  function pick(){
    var v=document.querySelectorAll('video');
    for(var i=0;i<v.length;i++){
      var s=v[i].currentSrc||v[i].src||'';
      if(s&&/^https?:/i.test(s)&&!/^blob:/i.test(s)) return s;
    }
    var html=document.documentElement.innerHTML||'';
    var re=/https?:\\/\\/[^"'\\s<>]+/gi;
    var m=html.match(re)||[];
    var scored=m.filter(function(u){
      return /\\.mp4|aweme\\/v1\\/play|\\/play\\/|zjcdn|byteicdn|douyinvod/i.test(u);
    }).map(function(u){return u.replace(/&amp;/g,'&').replace(/playwm/g,'play');});
    scored.sort(function(a,b){
      function sc(u){return (/\\.mp4/i.test(u)?10:0)+(/aweme\\/v1\\/play/i.test(u)?8:0);}
      return sc(b)-sc(a);
    });
    return scored[0]||'';
  }
  var url=pick();
  if(!url){alert('未在本页找到视频直链。请先打开抖音作品页并开始播放，再点书签。');return;}
  location.href=O+'/?videoUrl='+encodeURIComponent(url)+'&via=bookmarklet';
})();
`.replace(/\s+/g, ' ').trim();
  return `javascript:${encodeURIComponent(body)}`;
}

export function looksLikeDirectVideoUrl(text) {
  const u = String(text || '').trim();
  if (!u || !/^https?:\/\//i.test(u)) return false;
  return (
    /\.mp4(\?|$)/i.test(u) ||
    /\/aweme\/v1\/play/i.test(u) ||
    /\/play\/\?/i.test(u) ||
    /(zjcdn|byteicdn|douyinvod|snssdk\.com|iesdouyin\.com\/.*play)/i.test(u)
  );
}
