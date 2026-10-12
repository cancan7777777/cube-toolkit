/* server.js 静态文件服务自检（纯 Node，无第三方依赖）
 *
 * 在临时目录里搭一个站点，用原始 socket 发请求（绕开客户端自动规范化路径），检查：
 *   1. 正常文件仍能访问
 *   2. 畸形百分号编码（/%zz）返回 400，并且服务器不会因此崩掉
 *   3. 路径穿越（/../兄弟目录/文件）拿不到站点以外的文件
 *      —— 尤其是「同级目录名以站点目录名开头」这种情况（cubetimer / cubetimer-backup）
 *   4. 穿越到站点上级目录同样拿不到
 *
 * 用法：node 校验_静态文件服务.js <server.js 路径> [端口]
 * 期望：修复后的 server.js 全绿；修复前会在 2 / 3 上报错。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const fails = [];
function check(cond, okMsg, badMsg) {
  if (cond) console.log('   ✓ ' + okMsg);
  else { console.log('   ✗ ' + badMsg); fails.push(badMsg); }
}

/** 发一条原始 HTTP 请求，返回 { status, body }；连接被直接断开时 status 为 0 */
function rawGet(port, rawPath, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1');
    let buf = '';
    let done = false;
    const finish = (status) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch (e) { /* 忽略 */ }
      const i = buf.indexOf('\r\n\r\n');
      resolve({ status, body: i < 0 ? '' : buf.slice(i + 4) });
    };
    sock.setTimeout(timeoutMs, () => finish(0));
    sock.on('connect', () => sock.write(`GET ${rawPath} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`));
    sock.on('data', (d) => { buf += d.toString('utf8'); });
    sock.on('end', () => {
      const m = buf.match(/^HTTP\/1\.[01] (\d{3})/);
      finish(m ? Number(m[1]) : 0);
    });
    sock.on('error', () => finish(0));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(serverPath, port) {
  console.log(`\n== ${serverPath}`);
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cubetimer-srv-'));
  const root = path.join(base, 'cubetimer');
  fs.mkdirSync(root);
  fs.mkdirSync(path.join(base, 'cubetimer-backup'));            // 同级目录，名字以站点目录名开头
  fs.writeFileSync(path.join(root, 'index.html'), '<h1>site</h1>');
  fs.writeFileSync(path.join(base, 'cubetimer-backup', 'secret.txt'), 'TOP-SECRET-SIBLING');
  fs.writeFileSync(path.join(base, 'outside.txt'), 'TOP-SECRET-PARENT');
  fs.copyFileSync(serverPath, path.join(root, 'server.js'));

  const child = spawn(process.execPath, ['server.js', String(port)], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => { log += d.toString(); });
  child.stderr.on('data', (d) => { log += d.toString(); });
  for (let i = 0; i < 40 && log.indexOf('已启动') < 0; i++) await sleep(100);

  const normal = await rawGet(port, '/index.html');
  check(normal.status === 200 && normal.body.indexOf('site') >= 0, '正常文件可访问（200）', `正常文件访问异常：HTTP ${normal.status}`);

  const bad = await rawGet(port, '/%zz');
  check(bad.status === 400, '畸形编码 /%zz 返回 400', `畸形编码处理异常：HTTP ${bad.status}（应为 400）`);

  const alive = await rawGet(port, '/index.html');
  check(alive.status === 200, '畸形请求之后服务器仍在正常工作', `服务器被畸形请求搞挂了：HTTP ${alive.status}`);

  const leakSibling = await rawGet(port, '/../cubetimer-backup/secret.txt');
  check(leakSibling.status !== 200 && leakSibling.body.indexOf('TOP-SECRET-SIBLING') < 0,
    '同级目录文件读不到（已挡住前缀绕过）', `读到了站点以外的同级目录文件：HTTP ${leakSibling.status}`);

  const leakSibling2 = await rawGet(port, '/..%2fcubetimer-backup%2fsecret.txt');
  check(leakSibling2.status !== 200 && leakSibling2.body.indexOf('TOP-SECRET-SIBLING') < 0,
    '同级目录文件读不到（百分号编码同样挡住）', `百分号编码绕过了校验：HTTP ${leakSibling2.status}`);

  const leakParent = await rawGet(port, '/%2e%2e/outside.txt');
  check(leakParent.status !== 200 && leakParent.body.indexOf('TOP-SECRET-PARENT') < 0,
    '上级目录文件读不到', `读到了站点上级目录的文件：HTTP ${leakParent.status}`);

  try { child.kill(); } catch (e) { /* 忽略 */ }
  await sleep(200);
  try { fs.rmSync(base, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
}

(async () => {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error('用法：node 校验_静态文件服务.js <server.js> [端口]');
    process.exit(2);
  }
  let port = 0;
  const last = files[files.length - 1];
  if (/^\d+$/.test(last)) { port = Number(last); files.pop(); }
  for (let i = 0; i < files.length; i++) await run(files[i], port || 8901 + i);
  console.log(fails.length ? `\n结果：${fails.length} 项不符合预期\n` : '\n结果：全部通过\n');
  process.exit(fails.length ? 1 : 0);
})();
