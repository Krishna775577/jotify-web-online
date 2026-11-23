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
  if(url.pathname==='/api.php') return void relay(req,res,url);
  serveStatic(req,res,url);
});
server.listen(port,host,()=>{
  console.log(`Jotify Web listening on http://${host}:${port}`);
  if(!fs.existsSync(path.join(webRoot,'index.html')))
    console.warn('No public/index.html yet. Run build_jotify_render.bat in the Flutter project root.');
});
