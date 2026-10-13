/* =========================================================
   CubeTimer 跨设备同步自检（CDP 版）
   ---------------------------------------------------------
   验证三件事：
     1) 电脑上传的成绩，另一台设备（全新配置）登录后能看到
     2) 在电脑删除某条成绩后，另一台设备同步后**不再出现**
     3) 退出登录状态下删除，也会在下次登录时补删到云端
     4) 账号数据隔离：未登录时不显示账号成绩

   ⚠️ 安全铁律：必须使用独立的 --user-data-dir（脚本已用临时目录）。
      绝不能用你日常的浏览器配置 —— 测试脚本含清库操作。

   用法（先在 魔方计时器 目录启动服务：node server.js 8910）：
     node 跨设备同步自检_CDP.js                # 打本机 http://127.0.0.1:8910
     CT_BASE=https://xxx.app.workbuddy.host node 跨设备同步自检_CDP.js   # 打线上
   ========================================================= */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.env.CT_BASE || 'http://127.0.0.1:8910';
const EMAIL = `ct-sync-${Date.now()}@example.com`;
const PASS = 'synctest123456';
const NL = String.fromCharCode(10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (u) => new Promise((res, rej) => {
  http.get(u, (r) => { let b = ''; r.on('data', (c) => b += c); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej);
});

async function runOn(deviceTag, port, profile, body, wipe) {
  if (wipe) fs.rmSync(profile, { recursive: true, force: true });
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--disable-extensions',
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore' });
  let ws = null, id = 0;
  const pend = new Map();
  const send = (m, p) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p || {} })); });
  const onMsg = (raw) => { let m; try { m = JSON.parse(raw); } catch (e) { return; } if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } };
  try {
    for (let i = 0; i < 80; i++) { try { await getJson(`http://127.0.0.1:${port}/json/version`); break; } catch (e) { await sleep(300); } }
    const t = (await getJson(`http://127.0.0.1:${port}/json`)).find((x) => x.type === 'page');
    ws = new global.WebSocket(t.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    ws.onmessage = (e) => onMsg(e.data);
    await send('Page.enable'); await send('Runtime.enable');
    await send('Page.navigate', { url: BASE + '/index.html' });
    await sleep(5000);
    const r = await send('Runtime.evaluate', { expression: `(async()=>{const P=[];${body}return P.join(${JSON.stringify(NL)});})()`, awaitPromise: true, returnByValue: true, timeout: 90000 });
    return r.exceptionDetails ? ('ERR ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text)) : (r.result && r.result.value);
  } finally { try { ws && ws.close(); } catch (e) {} chrome.kill(); await sleep(600); }
}

const READY = `for (let i=0;i<60;i++){ if (typeof getSupabaseConfig==='function' && typeof store!=='undefined') break; await new Promise(r=>setTimeout(r,500)); }`;
const LOGIN = `document.getElementById('auth-skip').click();
  const c=await getSupabaseConfig(); await initSupabase(c);
  let r; try{r=await signIn('${EMAIL}','${PASS}');}catch(e){r=await signUp('${EMAIL}','${PASS}');}
  S.user=SB.user;
  const list = async()=> (await visibleSolves()).map(x=>x.time_ms).sort((a,b)=>a-b).join(',');
  const cloud = async()=> ((await sbFetch('/rest/v1/solves?select=client_id,time_ms&limit=1000'))||[]).map(x=>x.time_ms).sort((a,b)=>a-b).join(',');`;

(async () => {
  console.log('站点: ' + BASE);
  console.log('账号: ' + EMAIL + NL);
  const A = path.join(os.tmpdir(), 'ct-sync-A');
  const B = path.join(os.tmpdir(), 'ct-sync-B');

  console.log('[设备A] 登录 + 造 3 条成绩 + 全量上传');
  console.log(await runOn('A', 9261, A, `${READY}
    ${LOGIN}
    for(let i=0;i<3;i++) await saveSolve({event:'3x3',scramble:"R U R'",timeMs:2000+i*100,sessionId:uuid()});
    const f=await forcePushAll();
    P.push('    本机='+await list()+' | 云端='+await cloud()+' | 上传='+f.pushed+' 错误='+(f.err||'无'));`, true));

  console.log(NL + '[设备B] 全新配置登录（模拟手机）→ 应看到 3 条');
  console.log(await runOn('B', 9262, B, `${READY}
    ${LOGIN}
    await flushPendingDeletes();
    const pulled=await pullFromCloud(); await loadAll();
    P.push('    云端='+await cloud());
    P.push('    设备B可见='+await list()+' 条数='+(await visibleSolves()).length+'（应 3）');`, true));

  console.log(NL + '[设备A] 删除 1 条');
  console.log(await runOn('A', 9261, A, `${READY}
    ${LOGIN}
    const arr = (await store.all('solves')).filter(x=>x.owner===SB.user.id).sort((a,b)=>a.created_at-b.created_at);
    await deleteSolve(arr[0].client_id);
    await new Promise(r=>setTimeout(r,1500));
    P.push('    删除 time_ms='+arr[0].time_ms+' 后 → 本机='+await list()+' | 云端='+await cloud());
    P.push('    墓碑队列='+(await readPendingDeletes()).length+'（立即删除成功时应为 0）');`, false));

  console.log(NL + '[设备B] 重新打开页面（自动同步）→ 被删的记录必须消失');
  console.log(await runOn('B', 9262, B, `${READY}
    ${LOGIN}
    const boot = JSON.parse(JSON.stringify(pullLastResult));
    P.push('    页面启动自动同步: 新增='+boot.added+' 移除='+boot.removed+'（移除应 1）');
    await loadAll();
    P.push('    设备B可见='+await list()+' 条数='+(await visibleSolves()).length+'（应 2）');`, false));

  console.log(NL + '[设备A] 退出登录后删除 → 重新登录补删');
  console.log(await runOn('A', 9261, A, `${READY}
    ${LOGIN}
    const mine = (await store.all('solves')).filter(x=>x.owner===SB.user.id).sort((a,b)=>a.created_at-b.created_at);
    await signOut(); S.user=null;
    await deleteSolve(mine[0].client_id);
    P.push('    退出状态下删除 time_ms='+mine[0].time_ms+' → 墓碑队列='+(await readPendingDeletes()).length+'（应 1）');
    P.push('    此时云端仍='+await cloud()+'（尚未删除）');
    await signIn('${EMAIL}','${PASS}'); S.user=SB.user;
    const n = await flushPendingDeletes();
    await new Promise(r=>setTimeout(r,800));
    P.push('    重新登录后补删='+n+' 条 → 云端='+await cloud());
    P.push('    墓碑队列剩余='+(await readPendingDeletes()).length+'（应 0）');`, false));

  console.log(NL + '[隔离检查] 未登录时不得显示账号成绩');
  console.log(await runOn('B', 9262, B, `${READY}
    ${LOGIN}
    await signOut(); S.user=null; await loadAll();
    P.push('    退出后 可见='+S.cache.length+' 条（应 0）');
    P.push('    本机库仍有='+(await store.all('solves')).length+' 条（数据未丢）');`, false));
})();
