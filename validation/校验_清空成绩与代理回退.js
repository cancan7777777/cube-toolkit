/* 计时器数据层自检（纯 Node，无第三方依赖，用假的 localStorage / fetch 顶掉浏览器环境）
 *
 * 检查项：
 *   A. 点「清空」之后：主存储与备份都清空，重新打开页面不会被自动恢复
 *   B. 单条删除之后：备份同步收缩，不会把删掉的成绩又恢复出来
 *   C. 直连 Supabase 被网络拦截、但本机代理（server.js 的 /sb）可用时，
 *      首次登录不再直接报「无法连接」
 *   D. 直连与代理都不通、且本机没有会话时，仍然照常报错（不能一律放行）
 *
 * 用法：node 校验_清空成绩与代理回退.js <store.js 路径> [...]
 * 期望：修复后的 store.js 全绿；修复前的 store.js 会在 A / C 上报错（即被修掉的 bug）。
 */
const fs = require('fs');
const vm = require('vm');

/** 用一份共享的「localStorage 内容」建一个新的页面环境（模拟刷新） */
function newPage(storePath, lsData, fetchImpl) {
  const src = fs.readFileSync(storePath, 'utf8');
  let n = 0;
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    localStorage: {
      getItem: (k) => (Object.prototype.hasOwnProperty.call(lsData, k) ? lsData[k] : null),
      setItem: (k, v) => { lsData[k] = String(v); },
      removeItem: (k) => { delete lsData[k]; },
    },
    sessionStorage: null,
    setTimeout, clearTimeout, AbortController,
    navigator: { userAgent: 'node-check/1.0' },
    crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}` },
    fetch: fetchImpl,
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(src + `
;globalThis.__API = { store, saveSolve, allSolves, deleteSolve, recoverIfEmpty, refreshBackup,
  backupCount, restoreFromBackup, initSupabase, SB,
  clearLocalSolves: (typeof clearLocalSolves === 'function') ? clearLocalSolves : null };`,
  ctx, { filename: storePath });
  return ctx.__API;
}

/** 假响应：netfail=网络不通, json=Supabase 风格的 JSON, html=静态站把未知路径回退成网页, ok=普通 200 */
function fakeResponse(kind) {
  if (kind === 'netfail') throw new TypeError('Failed to fetch');
  const headers = {
    get: () => (kind === 'html' ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8'),
  };
  const body = kind === 'json' ? '{"version":"v2.0","name":"GoTrue","description":"auth"}' : '<!doctype html><html></html>';
  return { ok: kind !== 'html', status: kind === 'html' ? 200 : 200, headers, text: async () => body };
}

const mkFetch = (direct, proxy) => async (url) =>
  fakeResponse(String(url).indexOf('/sb/') >= 0 ? proxy : direct);

const fails = [];
function check(cond, okMsg, badMsg) {
  if (cond) console.log('   ✓ ' + okMsg);
  else { console.log('   ✗ ' + badMsg); fails.push(badMsg); }
}

async function run(storePath) {
  console.log(`\n== ${storePath}`);
  const lsData = {};

  /* ---- A. 清空成绩 ---- */
  let api = newPage(storePath, lsData, mkFetch('netfail', 'html'));
  for (const ms of [12345, 15432, 18888]) await api.saveSolve({ event: '3x3', timeMs: ms, scramble: 'R U R\'' });
  check((await api.allSolves()).length === 3, '清空前本地有 3 条成绩', `清空前成绩条数异常`);
  check(api.backupCount() === 3, '清空前备份有 3 条成绩', `清空前备份条数异常`);

  const used = api.clearLocalSolves ? 'clearLocalSolves()' : 'store.clear(\'solves\')';
  if (api.clearLocalSolves) await api.clearLocalSolves();
  else await api.store.clear('solves');   // 修复前的写法（只清主存储）
  check((await api.allSolves()).length === 0, `清空后（${used}）主存储为空`, `清空后主存储仍有数据`);

  const page2 = newPage(storePath, lsData, mkFetch('netfail', 'html'));   // 模拟刷新页面
  const restored = await page2.recoverIfEmpty();
  const left = (await page2.allSolves()).length;
  check(restored === 0 && left === 0, '刷新后仍为空（备份已一并清掉）', `刷新后成绩又回来了：自动恢复 ${restored} 条、现存 ${left} 条`);

  /* ---- B. 单条删除后，备份同步收缩 ---- */
  const page3 = newPage(storePath, lsData, mkFetch('netfail', 'html'));
  const a = await page3.saveSolve({ event: '3x3', timeMs: 11111 });
  await page3.saveSolve({ event: '3x3', timeMs: 22222 });
  await page3.deleteSolve(a.client_id);
  check(page3.backupCount() === 1, '删除一条后备份只剩 1 条', `删除后备份条数异常：${page3.backupCount()}`);
  const page4 = newPage(storePath, lsData, mkFetch('netfail', 'html'));
  await page4.recoverIfEmpty();
  check((await page4.allSolves()).length === 1, '刷新后仍是 1 条（被删的没有复活）', '刷新后条数异常（删除的成绩复活了）');

  /* ---- C. 直连被拦 + 本机代理可用 ---- */
  const page5 = newPage(storePath, {}, mkFetch('netfail', 'json'));
  let cOk = true, cMsg = '';
  try {
    await page5.initSupabase({ url: 'https://example.supabase.co', key: 'x'.repeat(30) });
    cMsg = page5.SB.base;
  } catch (e) { cOk = false; cMsg = e.message; }
  check(cOk && page5.SB.base === '/sb', '直连不通但 /sb 代理可用时能继续初始化（base=/sb）',
    `直连不通时直接放弃：${cOk ? '未识别到代理 base=' + cMsg : cMsg}`);

  /* ---- D. 直连与代理都不通，且没有本地会话 → 必须报错 ---- */
  const page6 = newPage(storePath, {}, mkFetch('netfail', 'html'));
  let dThrew = false;
  try { await page6.initSupabase({ url: 'https://example.supabase.co', key: 'x'.repeat(30) }); }
  catch (e) { dThrew = true; }
  check(dThrew, '直连与代理都不通时报错（未误放行）', '全部不通时没有报错，用户会看到「假成功」');

  /* ---- E. 直连正常时不受影响 ---- */
  const page7 = newPage(storePath, {}, mkFetch('json', 'html'));
  let eOk = true;
  try { await page7.initSupabase({ url: 'https://example.supabase.co', key: 'x'.repeat(30) }); }
  catch (e) { eOk = false; }
  check(eOk && page7.SB.base === '', '直连正常时走直连（base 为空）', '直连正常时初始化失败');
}

(async () => {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error('用法：node 校验_清空成绩与代理回退.js <store.js> [...]');
    process.exit(2);
  }
  for (const f of files) await run(f);
  console.log(fails.length ? `\n结果：${fails.length} 项不符合预期\n` : '\n结果：全部通过\n');
  process.exit(fails.length ? 1 : 0);
})();
