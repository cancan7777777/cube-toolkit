/* CubeTimer 局域网服务器：静态文件 + Supabase 反向代理
 * 用法: node server.js [端口]   (默认 8902)
 * 手机通过同一 Wi-Fi 访问 http://<电脑IP>:8902 即可同步，
 * 由电脑代为转发 Supabase 请求，绕开手机网络对 supabase.co 的拦截。
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

function defaultSupabaseHost() {
  try {
    const cfg = fs.readFileSync(path.join(__dirname, 'supabase-config.js'), 'utf8');
    const match = cfg.match(/url:\s*['"]https:\/\/([^'"]+)\.supabase\.co['"]/);
    return match ? match[1] + '.supabase.co' : null;
  } catch (e) {
    return null;
  }
}

const SB_HOST = process.env.SUPABASE_HOST || defaultSupabaseHost();
const PORT = Number(process.argv[2]) || 8902;
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};

function lanIP() {
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const it of ifs[name]) {
      if (it.family === 'IPv4' && !it.internal) return it.address;
    }
  }
  return '127.0.0.1';
}

function serveStatic(req, res) {
  // 畸形百分号编码（如 /%）会让 decodeURIComponent 抛异常，
  // 不处理的话异常会冒到 http 回调外层，直接把服务器进程带崩
  let p;
  try {
    p = decodeURIComponent(req.url.split('?')[0]);
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad Request');
    return;
  }
  if (p === '/' || p === '') p = '/index.html';
  // 解析成绝对路径后校验是否仍在站点根目录内。
  // 只比对字符串前缀是不够的：C:\站点-备份 这类兄弟目录同样以 ROOT 开头
  const file = path.resolve(ROOT, path.posix.normalize(p).replace(/^[/\\]+/, ''));
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not Found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(buf);
  });
}

function proxy(req, res) {
  if (!SB_HOST) {
    res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ message: '未配置 Supabase，请填写 timer/supabase-config.js' }));
    return;
  }
  const target = req.url.replace(/^\/sb/, '');
  const headers = Object.assign({}, req.headers);
  delete headers.host; delete headers.origin; delete headers.referer;
  delete headers['accept-encoding'];          // 让上游返回未压缩内容，转发更简单
  const upstream = https.request({
    host: SB_HOST, port: 443, path: target, method: req.method, headers,
  }, (ur) => {
    const h = Object.assign({}, ur.headers);
    delete h['content-encoding'];
    delete h['content-length'];
    h['access-control-allow-origin'] = '*';
    res.writeHead(ur.statusCode || 502, h);
    ur.pipe(res);
  });
  upstream.on('error', (e) => {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: '电脑到 Supabase 的转发失败: ' + e.message }));
  });
  req.pipe(upstream);
}

const server = http.createServer((req, res) => {
  if (req.url === '/__lanip') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ip: lanIP(), port: PORT }));
    return;
  }
  if (req.url.startsWith('/sb/')) { proxy(req, res); return; }
  serveStatic(req, res);
});

server.listen(PORT, '0.0.0.0', () => {
  const ip = lanIP();
  console.log('');
  console.log('  CubeTimer 服务器已启动');
  console.log('  ----------------------------------------');
  console.log('  本机使用:      http://localhost:' + PORT);
  console.log('  手机(同一Wi-Fi): http://' + ip + ':' + PORT);
  console.log('  Supabase 代理:  /sb/*  ->  ' + (SB_HOST || '未配置（计时不受影响）'));
  console.log('  ----------------------------------------');
  console.log('  保持此窗口开着；手机浏览器打开上面的手机地址即可');
  console.log('');
});
