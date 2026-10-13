/* CubeTimer 全量自检：覆盖本地存储、统计、打乱、云端 CRUD、界面状态机 */
setTimeout(async function(){
  var P=[], pass=0, fail=0;
  function chk(name, cond, extra){ if(cond){pass++;P.push('PASS  '+name);} else {fail++;P.push('FAIL  '+name+(extra?'  ['+extra+']':''));} }
  function log(m){P.push('      '+m);}
  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  try {
    document.getElementById('auth-skip').click();

    /* ---------- 1. ID 生成 ---------- */
    var bad = 0;
    for (var i=0;i<200;i++){ if(!UUID_RE.test(uuid())) bad++; }
    chk('uuid() 200 次全部合法', bad===0, bad+' 个非法');
    chk('store.uuid 已暴露', typeof store.uuid === 'function');
    chk('store.localDateKey 已暴露', typeof store.localDateKey === 'function');

    /* ---------- 2. 本地存储 CRUD ---------- */
    await store.clear('solves');
    var r1 = await saveSolve({ event:'3x3', scramble:'R U', timeMs: 5000, sessionId: uuid() });
    var r2 = await saveSolve({ event:'3x3', scramble:'F R', timeMs: 4000 });
    chk('saveSolve 写入 2 条', (await store.all('solves')).length === 2);
    chk('saveSolve 生成合法 client_id', UUID_RE.test(r1.client_id));
    chk('saveSolve 生成合法 session_id', UUID_RE.test(r1.session_id||''), String(r1.session_id));
    await deleteSolve(r2.client_id);
    chk('deleteSolve 本地删除生效', (await store.all('solves')).length === 1);
    await store.clear('solves');

    /* ---------- 3. 打乱生成合法性 ---------- */
    var viol = 0, seen = {};
    for (var k=0;k<2000;k++){
      var sc = scrambleFor('3x3'), toks = sc.split(' ');
      if (toks.length !== 20) viol++;
      for (var m=0;m<toks.length;m++){
        var face = toks[m][0];
        seen[face] = (seen[face]||0)+1;
        if (m>0 && toks[m-1][0] === face) viol++;                       // 同面相邻
        if (m>0 && 'RL'.indexOf(toks[m-1][0])>=0 && 'RL'.indexOf(face)>=0) viol++;
        if (m>0 && 'UD'.indexOf(toks[m-1][0])>=0 && 'UD'.indexOf(face)>=0) viol++;
        if (m>0 && 'FB'.indexOf(toks[m-1][0])>=0 && 'FB'.indexOf(face)>=0) viol++;
      }
    }
    chk('打乱 2000 条零违规', viol===0, viol+' 条违规');
    chk('打乱各面分布均匀(±1%)', Object.keys(seen).length===6 && Object.values(seen).every(function(v){return Math.abs(v/2000/6*6*2000/(2000*20/6)-1)<0.02;}), JSON.stringify(seen));

    /* ---------- 4. 统计口径 ---------- */
    var mk=function(ms,o){return Object.assign({time_ms:ms,penalty:0,dnf:false,event:'3x3',created_at:Date.now(),date_key:'2026-10-09'},o||{});};
    var s5=[mk(10000),mk(9000),mk(11000),mk(12000),mk(10500)];
    var bo=boResult(s5,5);
    chk('Bo5 取最快 9.0', bo.bo===9000, String(bo.bo));
    chk('Bo5 去极值平均 10.5', bo.trimmed===10500, String(bo.trimmed));
    chk('Bo5 全部平均 10.5', bo.mean===10500, String(bo.mean));
    chk('5 次有效判定完成', bo.complete===true);
    var withDnf=[mk(10000),mk(9000),mk(11000),mk(12000),mk(0,{dnf:true})];
    var bo2=boResult(withDnf,5);
    chk('含 DNF 时需补转', bo2.needExtra===true);
    chk('含 DNF 时 Bo 为 null', bo2.bo===null);
    var st=statsOf([mk(1000),mk(2000),mk(3000)]);
    chk('statsOf 最快/最慢/平均正确', st.best===1000&&st.worst===3000&&st.mean===2000, JSON.stringify(st));
    var pen=effectiveMs({time_ms:5000,penalty:2});
    chk('罚时 +2 生效 (7.0)', pen===7000, String(pen));

    /* ---------- 5. 云端全链路（注册→上传→拉取→删除） ---------- */
    var email='cubetimer-sweep-'+Date.now()+'@example.com';
    await initSupabase({ url: window.SB_DEFAULT_CFG.url, key: window.SB_DEFAULT_CFG.key });
    await signUp(email,'sweep123456');
    chk('云端注册登录成功', !!(SB.user && SB.user.id));
    // 故意插入一条「非法 ID」老数据，验证自愈
    await store.put('solves', { client_id: String(Date.now()), event:'3x3', scramble:'OLD', time_ms:7777,
      penalty:0, inspection_penalty:0, dnf:false, session_id:String(Date.now()-1),
      device:'legacy', created_at:Date.now(), date_key:localDateKey(new Date()), synced:false });
    await saveSolve({ event:'3x3', scramble:'A', timeMs:3300 });
    await saveSolve({ event:'3x3', scramble:'B', timeMs:3400 });
    log('本机成绩数: ' + (await store.all('solves')).length + '（含 1 条非法 ID 的老数据）');
    var push = await forcePushAll();
    chk('全量上传成功 3 条', push.pushed===3, 'pushed='+push.pushed+' err='+(push.err||'无'));
    chk('非法 ID 老数据已自愈上传', UUID_RE.test((await store.all('solves')).filter(function(x){return x.scramble==='OLD';})[0].client_id));
    // 换设备
    await store.clear('solves');
    var got = await pullFromCloud();
    chk('换设备拉取 3 条', got===3, 'pulled='+got);
    var times=(await allSolves()).map(function(x){return x.time_ms;}).sort();
    chk('拉取内容正确 (3300/3400/7777)', times.join(',')==='3300,3400,7777', times.join(','));
    // 云端删除
    var first=(await allSolves())[0];
    await deleteSolve(first.client_id);
    await new Promise(function(r){setTimeout(r,1200);});
    await store.clear('solves');
    var afterDel = await pullFromCloud();
    chk('云端删除生效（剩 2 条）', afterDel===2, 'pulled='+afterDel);
    // 重复上传幂等
    await store.clear('solves');
    await pullFromCloud();
    var again = await forcePushAll();
    await store.clear('solves');
    var dedup = await pullFromCloud();
    chk('重复上传不产生重复数据（仍 2 条）', dedup===2, 'pulled='+dedup);

    /* ---------- 6. 界面状态机 ---------- */
    await store.clear('solves');
    S.cache = [];
    function kd(){document.dispatchEvent(new KeyboardEvent('keydown',{code:'Space',key:' ',bubbles:true}));}
    function ku(){document.dispatchEvent(new KeyboardEvent('keyup',{code:'Space',key:' ',bubbles:true}));}
    kd();
    chk('按住进入 armed', $('#timer-box').className.indexOf('armed')>=0);
    await new Promise(function(r){setTimeout(r,620);});
    chk('按住达标进入 ready 且未计时', S.phase==='ready' && $('#display').textContent==='0.00', S.phase);
    ku();
    chk('松开开始计时 running', S.phase==='running');
    await new Promise(function(r){setTimeout(r,300);});
    kd();
    chk('按一下停止进入 review', S.phase==='review');
    ku();
    await new Promise(function(r){setTimeout(r,400);});
    chk('成绩已入库 1 条', (await store.all('solves')).length===1);
    chk('删除按钮存在且可见', (function(){var b=document.querySelector('#solves .solve-del');return !!b && parseFloat(getComputedStyle(b).opacity)>0.1;})());
    kd(); ku();
    await new Promise(function(r){setTimeout(r,300);});

    /* ---------- 7. 统计页与图表 ---------- */
    document.querySelector('.tab[data-view="stats"]').click();
    await new Promise(function(r){setTimeout(r,400);});
    try { drawChart(S.cache); chk('drawChart 按天渲染无异常', true); } catch(e){ chk('drawChart 按天渲染无异常', false, e.message); }
    try { document.querySelector('#chart-mode button[data-m="month"]').click();
          document.querySelector('#chart-metric button[data-k="best"]').click();
          chk('图表切换按月/最快无异常', true); } catch(e){ chk('图表切换按月/最快无异常', false, e.message); }
    try { document.querySelector('#chart-metric button[data-k="count"]').click();
          chk('图表切换次数据无异常', true); } catch(e){ chk('图表切换次数据无异常', false, e.message); }
    try { renderDayDetail(localDateKey(new Date()));
          chk('指定日期渲染无异常', true); } catch(e){ chk('指定日期渲染无异常', false, e.message); }
    chk('日期输入框已填充', /^\d{4}-\d{2}-\d{2}$/.test($('#day-pick').value), $('#day-pick').value);
  } catch (e) {
    fail++; P.push('FAIL  巡检异常: ' + e.message);
  }
  P.push('');
  P.push('===== ' + pass + ' 通过 / ' + fail + ' 失败 =====');
  var pre=document.createElement('pre'); pre.id='sweep';
  pre.style.cssText='position:fixed;top:0;left:0;right:0;height:100%;overflow:auto;background:#000;color:#0f0;padding:10px;font:11px monospace;z-index:99999;white-space:pre-wrap';
  pre.textContent=P.join('\n'); document.body.appendChild(pre);
  document.title='SWEEP_DONE';
}, 1800);
