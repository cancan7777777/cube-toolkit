/* CubeTimer 全量自检 v2：在正确目录的服务上复验关键链路 */
setTimeout(async function () {
  var P = [], pass = 0, fail = 0;
  function chk(n, c, extra) { if (c) { pass++; P.push('PASS  ' + n); } else { fail++; P.push('FAIL  ' + n + (extra ? '  [' + extra + ']' : '')); } }
  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function kd() { document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true })); }
  function ku() { document.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', key: ' ', bubbles: true })); }

  try {
    document.getElementById('auth-skip').click();

    /* 1. ID 与接口 */
    var bad = 0;
    for (var i = 0; i < 200; i++) { if (!UUID_RE.test(uuid())) bad++; }
    chk('uuid() 200 次全合法', bad === 0);
    chk('store.uuid 已暴露', typeof store.uuid === 'function');
    chk('store.localDateKey 已暴露', typeof store.localDateKey === 'function');

    /* 2. 本地 CRUD */
    await store.clear('solves');
    var r1 = await saveSolve({ event: '3x3', scramble: 'R U', timeMs: 5000, sessionId: uuid() });
    chk('saveSolve 写入', (await store.all('solves')).length === 1);
    chk('client_id 合法', UUID_RE.test(r1.client_id));
    chk('session_id 合法', UUID_RE.test(r1.session_id || ''));
    await deleteSolve(r1.client_id);
    chk('deleteSolve 生效', (await store.all('solves')).length === 0);

    /* 3. 打乱 2000 条 */
    var viol = 0;
    for (var k = 0; k < 2000; k++) {
      var toks = scrambleFor('3x3').split(' ');
      if (toks.length !== 20) viol++;
      for (var m = 1; m < toks.length; m++) {
        var a = toks[m - 1][0], b = toks[m][0];
        if (a === b) viol++;
        if ('RL'.indexOf(a) >= 0 && 'RL'.indexOf(b) >= 0) viol++;
        if ('UD'.indexOf(a) >= 0 && 'UD'.indexOf(b) >= 0) viol++;
        if ('FB'.indexOf(a) >= 0 && 'FB'.indexOf(b) >= 0) viol++;
      }
    }
    chk('打乱 2000 条零违规', viol === 0, viol + ' 违规');

    /* 4. 统计 */
    var mk = function (ms, o) { return Object.assign({ time_ms: ms, penalty: 0, dnf: false, event: '3x3', created_at: Date.now(), date_key: '2026-10-10' }, o || {}); };
    var bo = boResult([mk(10000), mk(9000), mk(11000), mk(12000), mk(10500)], 5);
    chk('Bo5 最快 9.0·去极值 10.5·完成', bo.bo === 9000 && bo.trimmed === 10500 && bo.complete === true);
    var bo2 = boResult([mk(10000), mk(9000), mk(11000), mk(12000), mk(0, { dnf: true })], 5);
    chk('DNF 需补转且 Bo 为 null', bo2.needExtra === true && bo2.bo === null);
    chk('罚时 +2 生效', effectiveMs({ time_ms: 5000, penalty: 2 }) === 7000);

    /* 5. 云端全链路 */
    await initSupabase({ url: window.SB_DEFAULT_CFG.url, key: window.SB_DEFAULT_CFG.key });
    await signUp('cubetimer-v2-' + Date.now() + '@example.com', 'verify123456');
    chk('注册登录成功', !!(SB.user && SB.user.id));
    await store.put('solves', { client_id: String(Date.now()), event: '3x3', scramble: 'OLD', time_ms: 7777,
      penalty: 0, inspection_penalty: 0, dnf: false, session_id: String(Date.now() - 1),
      device: 'legacy', created_at: Date.now(), date_key: localDateKey(new Date()), synced: false });
    await saveSolve({ event: '3x3', scramble: 'A', timeMs: 3300 });
    await saveSolve({ event: '3x3', scramble: 'B', timeMs: 3400 });
    var push = await forcePushAll();
    chk('全量上传 3 条（含脏数据自愈）', push.pushed === 3, 'pushed=' + push.pushed + ' err=' + (push.err || '无'));
    chk('脏 client_id 已换发合法 UUID', UUID_RE.test((await store.all('solves')).filter(function (x) { return x.scramble === 'OLD'; })[0].client_id));
    await store.clear('solves');
    var got = await pullFromCloud();
    chk('换设备拉取 3 条', got === 3, 'pulled=' + got);
    var times = (await allSolves()).map(function (x) { return x.time_ms; }).sort();
    chk('内容正确 3300/3400/7777', times.join(',') === '3300,3400,7777', times.join(','));
    var first = (await allSolves())[0];
    await deleteSolve(first.client_id);
    await sleep(1500);
    await store.clear('solves');
    chk('云端删除生效（剩 2 条）', (await pullFromCloud()) === 2);
    await store.clear('solves');
    await pullFromCloud();
    await forcePushAll();
    await store.clear('solves');
    chk('重复上传幂等（仍 2 条）', (await pullFromCloud()) === 2);

    /* 6. 状态机与界面 */
    await store.clear('solves');
    S.cache = [];
    kd();
    chk('按住进入 armed', $('#timer-box').className.indexOf('armed') >= 0);
    await sleep(620);
    chk('达标进入 ready 未计时', S.phase === 'ready' && $('#display').textContent === '0.00');
    ku();
    chk('松开开始 running', S.phase === 'running');
    await sleep(300);
    kd();
    chk('按一下停止 review', S.phase === 'review');
    ku();
    await sleep(500);
    chk('成绩入库 1 条', (await store.all('solves')).length === 1);
    chk('删除按钮可见', (function () { var b = document.querySelector('#solves .solve-del'); return !!b && parseFloat(getComputedStyle(b).opacity) > 0.1; })());
    kd(); ku();
    await sleep(300);

    /* 7. 统计页 */
    document.querySelector('.tab[data-view="stats"]').click();
    await sleep(400);
    try { drawChart(S.cache); chk('图表按天渲染', true); } catch (e) { chk('图表按天渲染', false, e.message); }
    try {
      document.querySelector('#chart-mode button[data-m="month"]').click();
      document.querySelector('#chart-metric button[data-k="best"]').click();
      document.querySelector('#chart-metric button[data-k="count"]').click();
      chk('图表切换按月/指标', true);
    } catch (e) { chk('图表切换按月/指标', false, e.message); }
    try { renderDayDetail(localDateKey(new Date())); chk('指定日期渲染', true); } catch (e) { chk('指定日期渲染', false, e.message); }

    /* 8. 诊断按钮 */
    try {
      document.querySelector('.tab[data-view="settings"]').click();
      await sleep(200);
      $('#btn-diag').click();
      await sleep(4000);
      var msg = $('#sync-msg').textContent;
      chk('连接诊断有输出', msg.indexOf('云端连通') >= 0, msg.slice(0, 60));
    } catch (e) { chk('连接诊断有输出', false, e.message); }
  } catch (e) {
    fail++; P.push('FAIL  巡检异常: ' + e.message);
  }
  P.push('');
  P.push('===== ' + pass + ' 通过 / ' + fail + ' 失败 =====');
  var pre = document.createElement('pre');
  pre.id = 'sweep';
  pre.textContent = P.join('\n');
  pre.style.cssText = 'position:fixed;top:0;left:0;right:0;background:#000;color:#0f0;padding:10px;font:11px monospace;z-index:99999;white-space:pre-wrap';
  document.body.appendChild(pre);
}, 1800);
