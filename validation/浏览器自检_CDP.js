/* =========================================================
   CubeTimer 浏览器自检（CDP 版，可重复运行）
   ---------------------------------------------------------
   为什么用 CDP 而不是 chrome --dump-dom：
     · --dump-dom + --virtual-time-budget 会让 setTimeout 瞬间跳过，
       而网络请求是真实的 → 探针经常来不及输出，结果不可靠
     · 无头模式 rAF 不触发，计时类断言会出现假失败
   CDP 方式（Node 22 自带全局 WebSocket）可以精确控制时序、把结果取回。

   ⚠️ 安全铁律：必须指定独立的 --user-data-dir（临时目录）。
      不加会直接使用你日常的浏览器配置，测试脚本里的清空操作会毁掉真实成绩！

   用法：
     1) 先启动本机服务（在 魔方计时器 目录下）：
          node server.js 8910
     2) 运行本自检：
          node 浏览器自检_CDP.js
   ========================================================= */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.env.CT_BASE || 'http://127.0.0.1:8910';
const PORT = 9333;
const PROFILE = path.join(os.tmpdir(), 'ct-selftest-prof');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(url) {
  return new Promise((res, rej) => {
    http.get(url, (r) => {
      let b = '';
      r.on('data', (c) => (b += c));
      r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
}
async function waitDevtools() {
  for (let i = 0; i < 80; i++) {
    try { return await getJson(`http://127.0.0.1:${PORT}/json/version`); } catch (e) { await sleep(300); }
  }
  throw new Error('DevTools 未就绪（Chrome 是否启动成功？）');
}

let ws = null, msgId = 0;
const pending = new Map();
function send(method, params) {
  return new Promise((res, rej) => {
    const id = ++msgId;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
}
function onMsg(raw) {
  let m; try { m = JSON.parse(raw); } catch (e) { return; }
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
  }
}
async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, timeout: 90000 });
  if (r.exceptionDetails) return 'ERR ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
  return r.result && r.result.value;
}
async function nav(url) { await send('Page.navigate', { url }); await sleep(3000); }

const STAMP = Date.now();
const A = `ct-selftest-A-${STAMP}@example.com`;
const B = `ct-selftest-B-${STAMP}@example.com`;
const NL = String.fromCharCode(10);

(async () => {
  fs.rmSync(PROFILE, { recursive: true, force: true });   // 用全新 profile，绝不碰真实数据
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--disable-extensions',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, 'about:blank',
  ], { stdio: 'ignore' });

  const out = [];
  try {
    await waitDevtools();
    const t = (await getJson(`http://127.0.0.1:${PORT}/json`)).find((x) => x.type === 'page');
    ws = new global.WebSocket(t.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    ws.onmessage = (e) => onMsg(e.data);
    await send('Page.enable');
    await send('Runtime.enable');

    // ---- 阶段1：首次打开（无会话）→ 注册账号 A ----
    await nav(`${BASE}/index.html`);
    out.push('[1] 首次打开 / 注册账号 A');
    out.push(await ev(`(async()=>{const P=[];await new Promise(r=>setTimeout(r,1200));
      P.push('    自动弹登录框='+(document.getElementById('auth-modal').classList.contains('show')?'是（预期）':'否【异常】'));
      const c=await getSupabaseConfig(); await initSupabase(c);
      let r; try{r=await signIn('${A}','aaaa123456');}catch(e){r=await signUp('${A}','aaaa123456');}
      P.push('    登录='+(SB.user?SB.user.email:'失败'));
      await flushPending(); await pullFromCloud();
      for(let i=0;i<3;i++) await saveSolve({event:'3x3',scramble:"R U R'",timeMs:3000+i*100,sessionId:uuid()});
      await loadAll(); renderStats(); renderHistory();
      document.querySelector('.tab[data-view="history"]').click(); await new Promise(r=>setTimeout(r,400));
      P.push('    历史显示='+document.querySelectorAll('#history .hist-item').length+' 条（应 3）');
      return P.join(${JSON.stringify(NL)});})()`));

    // ---- 阶段2：同一浏览器重开页面 ----
    await nav(`${BASE}/index.html`);
    out.push('[2] 同一浏览器重开页面（等价刷新）');
    out.push(await ev(`(async()=>{const P=[];await new Promise(r=>setTimeout(r,2000));
      P.push('    自动弹登录框='+(document.getElementById('auth-modal').classList.contains('show')?'是【错误】':'否【正确】'));
      const bt=document.getElementById('btn-auth').textContent;
      P.push('    顶栏按钮='+bt+(bt==='退出'?'【正确】':'【错误】'));
      P.push('    会话用户='+(SB.user?SB.user.email:'null'));
      document.querySelector('.tab[data-view="history"]').click(); await new Promise(r=>setTimeout(r,400));
      P.push('    历史显示='+document.querySelectorAll('#history .hist-item').length+' 条（应 3）');
      document.getElementById('btn-auth').click(); await new Promise(r=>setTimeout(r,300));
      P.push('    点顶栏按钮='+(document.getElementById('auth-modal').classList.contains('show')?'弹出【错误】':'未弹【正确】'));
      return P.join(${JSON.stringify(NL)});})()`));

    // ---- 阶段3：退出登录 → 账号数据必须隐藏 ----
    out.push('[3] 退出登录（账号数据应隐藏）');
    out.push(await ev(`(async()=>{const P=[];
      await signOut(); S.user=null; await loadAll(); renderStats(); renderHistory();
      P.push('    本机库='+(await store.all('solves')).length+' 条 / 可见='+S.cache.length+' 条（应 0）');
      document.querySelector('.tab[data-view="history"]').click(); await new Promise(r=>setTimeout(r,400));
      P.push('    历史显示='+document.querySelectorAll('#history .hist-item').length+' 条');
      P.push('    空态提示='+(document.getElementById('history').innerHTML.indexOf('登录后查看成绩')>=0?'有':'无'));
      return P.join(${JSON.stringify(NL)});})()`));

    // ---- 阶段4：换账号 B → 不得串号 ----
    out.push('[4] 换账号 B（数据不得串号）');
    out.push(await ev(`(async()=>{const P=[];
      let r; try{r=await signIn('${B}','bbbb123456');}catch(e){r=await signUp('${B}','bbbb123456');}
      S.user=SB.user; await migrateLocalToCloud(SB.user.id); const pu=await pullFromCloud(); await loadAll();
      P.push('    B 登录='+(SB.user?SB.user.email:'失败')+' 从云端拉到='+pu);
      P.push('    B 可见='+S.cache.length+' 条（应 0）');
      const cl=await sbFetch('/rest/v1/solves?select=client_id&limit=1000');
      P.push('    B 名下云端='+(cl?cl.length:'null')+' 条（应 0，未串号）');
      return P.join(${JSON.stringify(NL)});})()`));
  } catch (e) {
    out.push('自检异常: ' + e.message);
  } finally {
    try { ws && ws.close(); } catch (e) {}
    chrome.kill();
    fs.rmSync(PROFILE, { recursive: true, force: true });
    console.log(out.join(NL));
  }
})();
