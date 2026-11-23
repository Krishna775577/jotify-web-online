// Jotify Web: serve the compiled Flutter website + a limited catalog API relay.
// Node 20+; no npm dependencies. This is not an audio CDN proxy.
// Only deploy if you are authorized to access/relay the upstream catalog API.
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const isHosted = Boolean(process.env.PORT);
const port = Number(process.env.PORT || process.env.JOTIFY_PROXY_PORT || 8765);
const host = process.env.HOST || (isHosted ? '0.0.0.0' : '127.0.0.1');
const webRoot = path.resolve(__dirname, 'public');
const UPSTREAM = 'https://www.jiosaavn.com/api.php';
const ALLOWED_METHODS = new Set(['GET', 'HEAD']);
const mime = {
  '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.mjs':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8',
  '.json':'application/json; charset=utf-8', '.wasm':'application/wasm',
  '.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg',
  '.jpeg':'image/jpeg', '.gif':'image/gif', '.webp':'image/webp',
  '.ico':'image/x-icon', '.ttf':'font/ttf', '.otf':'font/otf',
  '.woff':'font/woff', '.woff2':'font/woff2', '.txt':'text/plain; charset=utf-8',
  '.bin':'application/octet-stream', '.frag':'text/plain; charset=utf-8'
};
const buckets = new Map();
function respond(res, status, payload, headers={}) {
  res.writeHead(status, {
    'Content-Type':'application/json; charset=utf-8',
    'Cache-Control':'no-store',
    'X-Content-Type-Options':'nosniff',
    ...headers,
  });
  res.end(JSON.stringify(payload));
}
function limited(ip) {
  const now=Date.now(), limit=180, windowMs=60000;
  if (buckets.size > 3000) {
    for (const [key, v] of buckets) if (now-v.started>windowMs) buckets.delete(key);
  }
  const b=buckets.get(ip);
  if (!b || now-b.started>windowMs) { buckets.set(ip,{started:now,count:1}); return false; }
  b.count++;
  return b.count > limit;
}
async function relay(req,res,url) {
  if (req.method !== 'GET') return respond(res,405,{status:'failure',error:'GET only'});
  const call=url.searchParams.get('__call');
  if (!call || !/^[A-Za-z][A-Za-z0-9_.]{0,90}$/.test(call) || url.search.length>4096)
    return respond(res,400,{status:'failure',error:'Invalid catalog request'});
  const ip=(req.socket.remoteAddress || 'unknown');
  if (limited(ip)) return respond(res,429,{status:'failure',error:'Rate limited'});
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),18000);
  try {
    const upstream=await fetch(UPSTREAM + url.search, {
      method:'GET',
      headers:{Accept:'application/json, text/plain, */*',Cookie:'L=hindi'},
      signal:controller.signal
    });
    const len=Number(upstream.headers.get('content-length')||0);
    if (len>12_000_000) return respond(res,502,{status:'failure',error:'Upstream response too large'});
    const bytes=Buffer.from(await upstream.arrayBuffer());
    if (bytes.length>12_000_000) return respond(res,502,{status:'failure',error:'Upstream response too large'});
    const ct=upstream.headers.get('content-type')||'application/octet-stream';
    console.log(`[Saavn] ${call} => ${upstream.status}, ${bytes.length} bytes`);
    res.writeHead(upstream.status, {
      'Content-Type':ct, 'Cache-Control':'no-store',
      'X-Content-Type-Options':'nosniff'
    });
    res.end(bytes);
  } catch (err) {
    console.error('[Saavn] Upstream failed:',err.message);
    respond(res,502,{status:'failure',error:'Music service unavailable'});
  } finally {clearTimeout(timer);}
}

const ytSearchCache = new Map();
const ytClientLimits = new Map();
let ytDay = '', ytRequestsToday = 0;
async function ytSearch(req,res,url) {
  if(req.method !== 'GET') return respond(res,405,{status:'failure',error:'GET only'});
  const query = (url.searchParams.get('q') || '').trim();
  if(query.length < 2 || query.length > 120 || url.search.length > 500)
    return respond(res,400,{status:'failure',error:'Enter a song or artist (2-120 characters).'});
  const apiKey = process.env.YOUTUBE_API_KEY;
  if(!apiKey) return respond(res,503,{status:'failure',error:'YT search needs YOUTUBE_API_KEY in Render environment.'});
  // Cache identical searches to protect YouTube Data API quotas.
  const cacheKey=query.toLocaleLowerCase('en');
  const now=Date.now();
  const cached=ytSearchCache.get(cacheKey);
  if(cached && cached.expires > now)
    return respond(res,200,{status:'ok',source:'youtube',cached:true,items:cached.items});
  const ip=req.socket.remoteAddress || 'unknown';
  if(ytClientLimits.size > 2000) {
    for(const [k,v] of ytClientLimits) if(now-v.at>60000) ytClientLimits.delete(k);
  }
  let entry=ytClientLimits.get(ip);
  if(!entry || now-entry.at>60000) entry={at:now,count:0};
  entry.count++;
  ytClientLimits.set(ip,entry);
  if(entry.count>6) return respond(res,429,{status:'failure',error:'Too many YT searches. Try again in a minute.'});
  const today=new Date(now).toISOString().slice(0,10);
  if(ytDay!==today) {ytDay=today;ytRequestsToday=0;}
  const maxDaily=Math.max(1,Math.min(1000,Number(process.env.YT_MAX_DAILY_SEARCHES || 60) || 60));
  if(ytRequestsToday>=maxDaily) return respond(res,429,{status:'failure',error:'YT search daily limit reached. Try tomorrow.'});
  ytRequestsToday++;
  const params=new URLSearchParams({
    part:'snippet',type:'video',q:query,maxResults:'12',
    videoEmbeddable:'true',safeSearch:'moderate',key:apiKey
  });
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),12000);
  try {
    // Never log the URL: it contains the private API key.
    const upstream=await fetch('https://www.googleapis.com/youtube/v3/search?'+params.toString(),{
      headers:{Accept:'application/json'},signal:controller.signal
    });
    const body=await upstream.json();
    if(!upstream.ok) {
      const reason=body && body.error && body.error.errors && body.error.errors[0] && body.error.errors[0].reason;
      if(upstream.status===403 && (reason==='quotaExceeded' || reason==='dailyLimitExceeded'))
        return respond(res,429,{status:'failure',error:'YouTube search quota exhausted.'});
      if(upstream.status===400 || upstream.status===403)
        return respond(res,502,{status:'failure',error:'YouTube API key or API restrictions need checking in Google Cloud.'});
      return respond(res,502,{status:'failure',error:'YouTube search is temporarily unavailable.'});
    }
    const items=(Array.isArray(body.items)?body.items:[]).map(item=>({
      id:item && item.id && item.id.videoId,
      title:item && item.snippet && item.snippet.title,
      channel:item && item.snippet && item.snippet.channelTitle,
      thumbnail:item && item.snippet && item.snippet.thumbnails &&
        (item.snippet.thumbnails.medium || item.snippet.thumbnails.default || {}).url
    })).filter(item=>/^[A-Za-z0-9_-]{11}$/.test(item.id||'')).slice(0,12);
    if(ytSearchCache.size>300) ytSearchCache.clear();
    ytSearchCache.set(cacheKey,{items,expires:now+15*60*1000});
    return respond(res,200,{status:'ok',source:'youtube',items});
  } catch(err) {
    // Do not leak API keys, query URLs, or upstream error bodies.
    return respond(res,502,{status:'failure',error:'YT search network error. Try again.'});
  } finally {clearTimeout(timer);}
}

function serveStatic(req,res,url) {
  if (!ALLOWED_METHODS.has(req.method)) return respond(res,405,{status:'failure',error:'Method not allowed'});
  let pathname;
  try {pathname=decodeURIComponent(url.pathname);} catch {return respond(res,400,{status:'failure',error:'Bad URL'});}
  if (pathname.includes('\\') || pathname.includes('\0')) return respond(res,400,{status:'failure',error:'Bad path'});
  const rel=pathname==='/'?'index.html':pathname.slice(1);
  let file=path.resolve(webRoot,rel);
  if (!file.startsWith(webRoot+path.sep)) return respond(res,403,{status:'failure',error:'Forbidden'});
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    // Flutter is an SPA. Unknown routes go to index; missing assets must 404.
    if (!path.extname(pathname) && fs.existsSync(path.join(webRoot,'index.html')))
      file=path.join(webRoot,'index.html');
    else return respond(res,404,{status:'failure',error:'Missing file'});
  }
  const ext=path.extname(file).toLowerCase();
  res.writeHead(200,{
    'Content-Type':mime[ext]||'application/octet-stream',
    'Cache-Control':ext==='.html'?'no-cache':'public, max-age=3600',
    'X-Content-Type-Options':'nosniff',
  });
  if(req.method==='HEAD') return res.end();
  fs.createReadStream(file).on('error',()=>res.destroy()).pipe(res);
}
const server=http.createServer((req,res)=>{
  let url;
  try {url=new URL(req.url,`http://${req.headers.host||'localhost'}`);}
  catch{return respond(res,400,{status:'failure',error:'Bad URL'});}
  if(url.pathname==='/health') return respond(res,200,{status:'ok',service:'Jotify Web'});
  if(url.pathname==='/api/yt/search') return void ytSearch(req,res,url);
  if(url.pathname==='/api.php') return void relay(req,res,url);
  serveStatic(req,res,url);
});
server.listen(port,host,()=>{
  console.log(`Jotify Web listening on http://${host}:${port}`);
  if(!fs.existsSync(path.join(webRoot,'index.html')))
    console.warn('No public/index.html yet. Run build_jotify_render.bat in the Flutter project root.');
});
