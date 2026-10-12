/* =========================================================
   CubeTimer 主逻辑
   状态机：idle → armed(防误触延迟) → running → stopped
   关键需求：
     · 开始响应慢（可配置延迟，防误触）—— 延迟期间再按空格取消
     · 停止立即响应
     · 锁定后其他按键不影响计时
   ========================================================= */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

/* ---------------- 全局状态 ---------------- */

const S = {
  view: 'timer',
  mode: 'bo5',              // bo5 / bo10 / free
  event: '3x3',
  scramble: '',
  session: [],              // 本轮成绩
  sessionId: null,

  phase: 'idle',            // idle / armed / running / stopped
  armTimer: null,           // 防误触定时器
  startAt: 0,
  elapsed: 0,
  rafId: null,

  inspectStart: 0,
  inspectRaf: null,

  locked: false,
  lastResult: null,         // 停止后展示的成绩（用于判罚）
  user: null,
  cfg: null,

  pref: { startDelay: 500, inspect: 1, sound: 1 },
  chartMode: 'day',        // 横坐标粒度：day | month
  chartMetric: 'mean',     // 纵坐标指标：mean | best | worst | count
  dayPick: '',             // 指定日期当前选中的日期
  cache: [],                // 成绩缓存
};

const MODE_N = { bo5: 5, bo10: 10, free: 0 };

/* ---------------- 启动 ---------------- */

document.addEventListener('DOMContentLoaded', async () => {
  // 每一步都独立容错：任何一环失败都不能阻断后续，
  // 否则按钮绑不上，界面表现为「点了没反应」。
  const safe = async (label, fn, fallback) => {
    try { await fn(); } catch (e) {
      console.warn(label + ' 失败:', e);
      if (fallback) { try { fallback(); } catch (e2) { console.warn(label + ' 兜底失败:', e2); } }
    }
  };

  loadPrefs();
  // 恢复图表偏好
  try {
    const c = JSON.parse(localStorage.getItem('ct_chart') || '{}');
    if (c.m === 'month' || c.m === 'day') S.chartMode = c.m;
    if (['mean', 'best', 'worst', 'count'].indexOf(c.k) >= 0) S.chartMetric = c.k;
    $$('#chart-mode button').forEach((b) => b.classList.toggle('on', b.dataset.m === S.chartMode));
    $$('#chart-metric button').forEach((b) => b.classList.toggle('on', b.dataset.k === S.chartMetric));
  } catch (e) { /* 忽略 */ }
  safe('bindUI', async () => bindUI(), () => bindUI());
  await safe('newSession', async () => newSession());
  await safe('loadAll', async () => { S.cache = await visibleSolves(); }, () => { S.cache = []; });
  // 主存储若为空而本机备份有数据 → 自动恢复（防止误清空）
  await safe('recover', async () => {
    const n = await recoverIfEmpty();
    if (n) { S.cache = await visibleSolves(); toast('已从本机备份恢复 ' + n + ' 条成绩'); }
  });
  await safe('render', async () => { renderTimer(); renderStats(); renderHistory(); },
    () => { try { renderTimer(); } catch (e) { /* 忽略 */ } });
  await safe('updateAuthUI', async () => updateAuthUI(), () => updateAuthUI());
  // 同步失败不再静默：红点+ 提示，并记在设置页
  try {
    onSyncError((msg) => {
      setSync(false, true);
      showSyncMsg('同步失败：' + msg, true);
      const el = $('#sync-msg');
      if (el) setTimeout(() => { if (S.user && !lastSyncError()) showSyncMsg('已连接账号', false); }, 6000);
    });
  } catch (e) { /* 忽略 */ }
  await safe('initCloud', async () => initCloud(true));
  // initCloud 确定了云端配置与登录态后，必须重新刷新 UI：
  //  · updateAuthUI —— 否则已登录时顶栏仍显示「登录」，点它又弹出登录框
  //  · loadAll/render —— 按账号归属重新过滤可见成绩
  await safe('refreshAfterCloud', async () => {
    if (S.user) markEverLoggedIn();
    await loadAll();
    updateAuthUI();
    renderStats(); renderHistory(); renderTimer();
  }, () => updateAuthUI());
  // 自动弹登录框的条件收紧：只有「从未登录过 + 本机无会话 + 本次未跳过」才弹
  if (!S.user && !skipAuthThisSession() && !(await hasSavedSession()) && !everLoggedIn()) openAuth('in');
  // 看板娘台词轮换
  startMascotTips();
  // PWA：仅通过 http(s) 访问时注册，双击打开（file://）自动跳过
  if (location.protocol === 'http:' || location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
});

function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem('ct_pref') || '{}');
    Object.assign(S.pref, p);
  } catch (e) { /* 忽略 */ }
}
function savePrefs() {
  localStorage.setItem('ct_pref', JSON.stringify(S.pref));
}

/* ---------------- 本轮会话 ---------------- */

function newSession() {
  S.session = [];
  S.currentRec = null;
  S.sessionId = uuid();
  S.scramble = scrambleFor(S.event);
  resetRun();
  resetInspect();
  $('#scramble').textContent = S.scramble;
  renderTimer();
}

function nextScramble() {
  S.scramble = scrambleFor(S.event);
  resetInspect();                 // 换打乱只复位，不自动开始观察
  $('#scramble').textContent = S.scramble;
}

function resetRun() {
  clearTimeout(S.armTimer);
  cancelAnimationFrame(S.rafId);
  S.phase = 'idle';
  S.elapsed = 0;
  S.lastResult = null;
  stopInspect();
  updateDisplay(0);
  const box = $('#timer-box');
  box.classList.remove('armed', 'running', 'ready');
  $('#hint').textContent = idleHint();
}

/* ---------------- 观察计时 ---------------- */

/** 复位为「待观察」：不自动倒计时，等用户点「开始观察」 */
function resetInspect() {
  stopInspect();
  S.inspectStart = 0;
  const fill = $('#inspect-fill');
  fill.style.width = '100%';
  fill.className = '';
  $('#inspect-text').textContent = S.pref.inspect ? '待观察' : '观察关闭';
}

function startInspect() {
  if (!S.pref.inspect) {
    resetInspect();
    return;
  }
  S.inspectStart = performance.now();
  const TOTAL = 15000;
  const tick = () => {
    const el = performance.now() - S.inspectStart;
    const left = Math.max(0, TOTAL - el);
    const fill = $('#inspect-fill');
    fill.style.width = (left / TOTAL * 100) + '%';
    fill.className = el > 17000 ? 'over' : (el > 15000 ? 'warn' : '');

    const txt = $('#inspect-text');
    if (el <= 15000) txt.textContent = `观察 ${(left / 1000).toFixed(1)}s`;
    else if (el <= 17000) txt.textContent = '+2 罚时';
    else txt.textContent = 'DNF';

    if (el > 17500) { stopInspect(); return; }
    S.inspectRaf = requestAnimationFrame(tick);
  };
  stopInspect();
  S.inspectRaf = requestAnimationFrame(tick);
}

function stopInspect() {
  if (S.inspectRaf) cancelAnimationFrame(S.inspectRaf);
  S.inspectRaf = null;
}

/** 观察罚时：0=无, 2=+2, 999=DNF */
function inspectPenalty() {
  if (!S.pref.inspect || !S.inspectStart) return 0;
  const el = performance.now() - S.inspectStart;
  if (el > 17000) return 999;
  if (el > 15000) return 2;
  return 0;
}

/* =========================================================
   核心：开始 / 停止
   状态机：idle --按住空格--> armed --按住达标--> ready --松开--> running --按一下--> review --空格--> idle
   · 计时从「松开空格」那一刻开始（Stackmat 习惯），按住只是进入就绪态
   · 按住时长不足阈值就松开 = 取消，防误触
   · 停止立即响应
   · 停止后停在 review：先确认罚时 / DNF / 删除，再按空格换下一条
   ========================================================= */

/* 按下（keydown / mousedown / touchstart） */
function pressDown() {
  if (S.phase === 'idle') startArmed();
  else if (S.phase === 'running') stopRun();       // 停止立即响应
  else if (S.phase === 'review') nextTurn();        // 空格进入下一把
  /* armed / ready 状态下的再次按下忽略：必须先松开 */
}

/* 松开（keyup / mouseup / touchend） */
function pressUp() {
  if (S.phase === 'armed') cancelArmed();           // 按住时长不足 = 取消
  else if (S.phase === 'ready') startRun();         // 松开才开始计时
}

function startArmed() {
  const delay = Number(S.pref.startDelay) || 0;
  S.phase = 'armed';
  $('#timer-box').classList.add('armed');
  $('#timer-box').classList.remove('running', 'ready');
  updateDisplay(0);
  if (delay > 0) {
    $('#hint').textContent = `继续按住 ${(delay / 1000).toFixed(1)}s · 松开取消`;
    // 按住达标后进入就绪态（注意：不开始计时，等松开）
    S.armTimer = setTimeout(() => {
      if (S.phase !== 'armed') return;
      enterReady();
    }, delay);
  } else {
    enterReady();
  }
}

/** 按住时长已达标：等待松开，此时计时尚未开始 */
function enterReady() {
  if (S.phase !== 'armed') return;
  S.phase = 'ready';
  const box = $('#timer-box');
  box.classList.remove('armed');
  box.classList.add('ready');
  $('#hint').textContent = '松开空格 · 开始计时';
}

function cancelArmed() {
  // armed（按住中）与 ready（按住已达标、等待松开）都要能取消：
  // 触摸被浏览器打断（touchcancel）时状态停在 ready，会让后续操作全部错乱
  if (S.phase !== 'armed' && S.phase !== 'ready') return;
  clearTimeout(S.armTimer);
  S.phase = 'idle';
  $('#timer-box').classList.remove('armed', 'ready');
  $('#hint').textContent = '已取消 · 重新按住空格';
  updateDisplay(0);
  setTimeout(() => { if (S.phase === 'idle') $('#hint').textContent = idleHint(); }, 1200);
}

function startRun() {
  if (S.phase !== 'ready') return;   // 只能从就绪态（松开）进入
  clearTimeout(S.armTimer);
  S.phase = 'running';
  S.startAt = performance.now();
  S.elapsed = 0;
  stopInspect();                     // 开始还原即结束观察

  const box = $('#timer-box');
  box.classList.remove('armed', 'ready');
  box.classList.add('running');
  $('#hint').textContent = '计时中… 按一下立即停止';
  beep(880, 0.05);

  const loop = () => {
    if (S.phase !== 'running') return;
    S.elapsed = performance.now() - S.startAt;
    updateDisplay(S.elapsed);
    S.rafId = requestAnimationFrame(loop);
  };
  S.rafId = requestAnimationFrame(loop);
}

function idleHint() {
  // 触屏设备没有空格，主入口是按住计时区
  if (('ontouchstart' in window) || (navigator.maxTouchPoints > 0)) {
    return '按住计时区 · 松开开始计时';
  }
  return '按住空格 · 松开开始计时';
}

function stopRun() {
  cancelAnimationFrame(S.rafId);
  S.phase = 'review';   // 先进入待确认，commitResult 完成后仍停留在此
  S.elapsed = performance.now() - S.startAt;

  const box = $('#timer-box');
  box.classList.remove('running');

  // 误触保护：0.06s 以下 WCA 判为无效
  if (S.elapsed < 60) {
    toast('太短了，已忽略本次');
    S.phase = 'idle';
    $('#hint').textContent = idleHint();
    updateDisplay(0);
    return;
  }

  const insp = inspectPenalty();
  const dnf = insp === 999;
  updateDisplay(S.elapsed);

  S.lastResult = {
    time_ms: Math.round(S.elapsed),
    inspection_penalty: insp === 999 ? 0 : insp,
    dnf,
  };

  if (dnf) {
    $('#hint').textContent = '观察超时 · 本把 DNF';
    beep(220, 0.16);
  } else {
    const extra = S.lastResult.inspection_penalty ? ' (+2)' : '';
    $('#hint').textContent = fmtTime(effectiveMs(S.lastResult)) + extra + ' · 空格=下一把';
    beep(660, 0.07);
  }

  commitResult();
}

/**
 * 把结果入库，然后停在 review 状态。
 * 不自动换打乱——用户先确认罚时 / DNF，再按空格进入下一把。
 */
async function commitResult() {
  const r = S.lastResult;
  if (!r) return;

  const rec = await saveSolve({
    event: S.event,
    scramble: S.scramble,
    timeMs: r.time_ms,
    penalty: r.penalty || 0,
    inspectionPenalty: r.inspection_penalty || 0,
    dnf: r.dnf,
    sessionId: S.sessionId,
  });

  S.session.push(rec);
  S.cache.push(rec);
  S.currentRec = rec;      // review 期间可被 D / X 修改
  S.lastResult = null;

  /* ---- PB 彩蛋检测（单次） ----
     判定发生在入库后：本次有效成绩严格优于历史所有有效成绩。
     DNF 不参与比较；第一次出成绩也算刷新 PB。 */
  if (!rec.dnf) {
    const others = S.cache.filter((x) =>
      x.event === rec.event && x.client_id !== rec.client_id && !x.dnf);
    const prevBest = others.length
      ? Math.min(...others.map(effectiveMs).filter((x) => x != null))
      : null;
    const cur = effectiveMs(rec);
    if (cur != null && (prevBest == null || cur < prevBest)) {
      showPBParty('单次新纪录！');
      renderStats();
    }
  }

  const need = MODE_N[S.mode];
  if (need) {
    const res = boResult(S.session, need);
    if (res.complete) {
      toast(`本轮完成 · Bo${need} = ${fmtTime(res.bo)}${res.dnfCount ? '（含 DNF，可继续补转）' : ''}`);
      beep(990, 0.1);

      /* ---- PB 彩蛋检测（Bo 赛制） ----
         本轮 Bo 优于历史上所有完整 Bo 轮次；第一轮完整 Bo 也算。 */
      const prevBo = bestBoHistorical(S.event, S.sessionId, need);
      if (res.bo != null && (prevBo == null || res.bo < prevBo)) {
        setTimeout(() => showPBParty(`Bo${need} 新纪录！`), 900);
      }
    }
  }

  // 提示必须在保存成功之后更新：若保存失败，用户不应误以为已记录
  $('#hint').textContent = (r.dnf ? 'DNF' : fmtTime(effectiveMs(rec)))
    + ' · 空格=下一把  D=+2  X=DNF  Del=删除';
  renderTimer();
  renderStats();
}

/**
 * 历史上（不含 excludeSession 这轮）同项目 BoN 赛制的最好成绩。
 * 按 session_id 分组，只统计有效成绩数达标的完整轮次。
 */
function bestBoHistorical(event, excludeSession, n) {
  const groups = new Map();
  for (const s of S.cache) {
    if (s.event !== event) continue;
    const key = s.session_id || '__none__';
    if (key === excludeSession) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  let best = null;
  for (const list of groups.values()) {
    const r = boResult(list, n);
    if (r.complete && r.bo != null && (best == null || r.bo < best)) best = r.bo;
  }
  return best;
}

/* ---------------- PB 彩蛋 ---------------- */

let pbTimer = null;

function showPBParty(text) {
  const el = $('#pb-party');
  if (!el) return;
  $('#pb-text').textContent = text;
  el.classList.remove('show');
  void el.offsetWidth;          // 重置动画
  el.classList.add('show');

  // 庆祝音：上行三连音
  beep(660, 0.09);
  setTimeout(() => beep(880, 0.09), 130);
  setTimeout(() => beep(1175, 0.16), 280);

  clearTimeout(pbTimer);
  pbTimer = setTimeout(() => el.classList.remove('show'), 3400);
}

/** review 状态下按空格：换下一条打乱，重新开始观察 */
function nextTurn() {
  const need = MODE_N[S.mode];
  if (need) {
    // Bo 模式下有效成绩已满：开新一轮
    const res = boResult(S.session, need);
    if (res.complete) {
      newSession();
      toast('本轮已存档，开始新一轮');
      renderHistory();
      return;
    }
  }
  S.currentRec = null;
  S.phase = 'idle';
  nextScramble();
  $('#hint').textContent = idleHint();
}

/* ---------------- 罚时 / DNF / 删除 ----------------
   review 状态下修改的是「已入库」的那条记录：
   更新本地后自动重新上传，保持云端一致。
   锁定判断放在函数内部而非只靠 keydown 拦截。 */

async function applyPenalty() {
  if (S.locked) return;
  const rec = S.currentRec;
  if (!rec || rec.dnf) return;
  rec.penalty = (rec.penalty || 0) + 2;
  await store.put('solves', rec);
  const i = S.cache.findIndex((x) => x.client_id === rec.client_id);
  if (i >= 0) S.cache[i] = { ...rec };
  (async () => {
    const uid = await currentUserId();
    if (uid) uploadOne(rec, uid);
  })();
  $('#hint').textContent = fmtTime(effectiveMs(rec)) + ' · 已加 +2 · 空格=下一把';
  renderTimer(); renderStats();
}

async function applyDnf() {
  if (S.locked) return;
  const rec = S.currentRec;
  if (!rec || rec.dnf) return;
  rec.dnf = true;
  rec.penalty = 0;
  await store.put('solves', rec);
  const i = S.cache.findIndex((x) => x.client_id === rec.client_id);
  if (i >= 0) S.cache[i] = { ...rec };
  (async () => {
    const uid = await currentUserId();
    if (uid) uploadOne(rec, uid);
  })();
  $('#hint').textContent = '已标记 DNF · 空格=下一把';
  renderTimer(); renderStats();
}

async function deleteLast() {
  if (S.locked) return;
  const rec = S.currentRec || S.session[S.session.length - 1];
  if (!rec) { toast('本轮没有成绩'); return; }
  S.session = S.session.filter((x) => x.client_id !== rec.client_id);
  S.cache = S.cache.filter((x) => x.client_id !== rec.client_id);
  S.currentRec = null;
  await deleteSolve(rec.client_id);
  toast('已删除本把');
  S.phase = 'idle';
  $('#hint').textContent = idleHint();
  renderTimer(); renderStats(); renderHistory();
}

function endSession() {
  if (S.locked) return;
  if (S.phase === 'running') { cancelAnimationFrame(S.rafId); }
  clearTimeout(S.armTimer);
  S.lastResult = null;
  S.session = [];
  S.sessionId = uuid();
  S.scramble = scrambleFor(S.event);
  resetRun();
  renderTimer();
  toast('本轮已结束');
}

/* ---------------- 显示 ---------------- */

function updateDisplay(ms) {
  $('#display').textContent = fmtTime(ms);
}

function renderTimer() {
  $('#scramble').textContent = S.scramble;
  $('#bo-tag').textContent = S.mode === 'free' ? '自由练习' : 'Bo' + MODE_N[S.mode];

  const list = $('#solves');
  if (!S.session.length) {
    list.innerHTML = '<div style="text-align:center;color:var(--dim-2);font-size:13px;padding:14px 0">还没有成绩，按空格开始第一把</div>';
  } else {
    const valid = S.session.filter((s) => !s.dnf).map(effectiveMs).filter((x) => x != null);
    const best = valid.length ? Math.min(...valid) : null;
    const worst = valid.length ? Math.max(...valid) : null;

    // 最新一把排在最上面；序号仍是「第 N 把」的真实序号
    const rows = S.session.map((s, i) => ({ s: s, no: i + 1 })).reverse();
    list.innerHTML = rows.map(({ s, no }) => {
      const t = effectiveMs(s);
      const isBest = t != null && valid.length > 1 && t === best;
      const isWorst = t != null && valid.length > 1 && t === worst;
      const cls = s.dnf ? 'dnf-s' : (isBest ? 'best' : (isWorst ? 'worst' : ''));
      const badges = [
        s.penalty ? '<span class="badge p">+2</span>' : '',
        s.inspection_penalty ? '<span class="badge i">观察罚时</span>' : '',
      ].join('');
      const when = new Date(s.created_at);
      return `<div class="solve ${cls}">
        <span class="solve-idx">${no}</span>
        <span class="solve-time">${fmtTime(t)}</span>
        ${badges}
        <span class="solve-date">${when.getMonth() + 1}/${when.getDate()}</span>
        <button class="solve-del" data-id="${s.client_id}" title="删除" style="opacity:.6">✕</button>
      </div>`;
    }).join('');

    // 删除按钮
    $$('.solve-del', list).forEach((b) => {
      b.onclick = async (e) => {
        e.stopPropagation();
        const id = b.dataset.id;
        const wasCurrent = S.currentRec && S.currentRec.client_id === id;
        S.session = S.session.filter((x) => x.client_id !== id);
        S.cache = S.cache.filter((x) => x.client_id !== id);
        if (wasCurrent) S.currentRec = null;
        await deleteSolve(id);
        // 删掉的正是刚停下的那一把时，回到待开始状态（与 Del 键一致）
        if (wasCurrent && S.phase === 'review') {
          S.phase = 'idle';
          updateDisplay(0);
          $('#hint').textContent = idleHint();
        }
        toast('已删除');
        renderTimer(); renderStats(); renderHistory();
      };
    });
  }

  // Bo 结果
  const need = MODE_N[S.mode];
  const box = $('#bo-result');
  if (need && S.session.length) {
    const r = boResult(S.session, need);
    box.innerHTML = `
      <div class="bo-grid">
        <div class="bo-cell"><div class="k">最快</div><div class="v hl">${r.best != null ? fmtTime(r.best) : '—'}</div></div>
        <div class="bo-cell"><div class="k">去极值平均</div><div class="v">${r.trimmed != null ? fmtTime(r.trimmed) : '—'}</div></div>
        <div class="bo-cell"><div class="k">全部平均</div><div class="v">${r.mean != null ? fmtTime(r.mean) : '—'}</div></div>
      </div>
      ${r.needExtra ? `<div class="bo-note">本轮出现 DNF，有效成绩 ${r.count}/${need}，需补一次</div>` : ''}
    `;
  } else if (!need && S.session.length) {
    const st = statsOf(S.session);
    box.innerHTML = `<div class="bo-grid">
      <div class="bo-cell"><div class="k">最快</div><div class="v hl">${st.best != null ? fmtTime(st.best) : '—'}</div></div>
      <div class="bo-cell"><div class="k">全部平均</div><div class="v">${st.mean != null ? fmtTime(st.mean) : '—'}</div></div>
      <div class="bo-cell"><div class="k">把数</div><div class="v">${S.session.length}</div></div>
    </div>`;
  } else {
    box.innerHTML = '';
  }
}

/* ---------------- 统计视图 ---------------- */

function renderStats() {
  const list = S.cache.filter((s) => s.event === S.event);
  const st = statsOf(list);

  $('#st-best').textContent = st.best != null ? fmtTime(st.best) : '—';
  $('#st-worst').textContent = st.worst != null ? fmtTime(st.worst) : '—';
  $('#st-mean').textContent = st.mean != null ? fmtTime(st.mean) : '—';
  $('#st-trim').textContent = st.trimmed != null ? fmtTime(st.trimmed) : '—';

  // 统一按时间倒序：最新记录在最上面
  list.sort((a, b) => b.created_at - a.created_at);
  const groups = groupByDate(list);

  drawChart(list);
  renderDayDetail(S.dayPick);

  const box = $('#daily');
  if (!groups.length) {
    box.innerHTML = '<div style="text-align:center;color:var(--dim-2);font-size:13px;padding:16px 0">暂无数据</div>';
    return;
  }
  box.innerHTML = groups.slice(0, 60).map((g) => `
    <div class="day" data-date="${g.date}" title="点击查看该日详情">
      <div class="day-date">
        <div class="day-d">${g.date.slice(5).replace('-', '/')}</div>
        <div class="day-w">${weekdayCN(g.date)}</div>
      </div>
      <div class="day-n">${g.stats.total} 把${g.stats.dnfCount ? ' · DNF ' + g.stats.dnfCount : ''}</div>
      <div class="day-best">${g.stats.best != null ? fmtTime(g.stats.best) : '—'}</div>
      <div class="day-avg">${g.stats.mean != null ? fmtTime(g.stats.mean) : ''}</div>
    </div>`).join('');
}

/* 趋势图：横坐标按天或按月聚合，纵坐标可切换指标。
   横坐标只保留「有记录的周期」——没有成绩的日期直接跳过，不会出现空点。 */

const CHART_METRICS = {
  mean: { label: '平均时间', unit: 'ms', get: (st) => st.mean },
  best: { label: '最快', unit: 'ms', get: (st) => st.best },
  worst: { label: '最慢', unit: 'ms', get: (st) => st.worst },
  count: { label: '成绩数', unit: 'n', get: (st) => st.total },
};

/** 把成绩按「日」或「月」聚合，返回 [{key,label,stats}]，仅含有记录的周期 */
function aggregateByPeriod(list, mode) {
  const map = new Map();
  for (const s of list) {
    const d = new Date(s.created_at);
    const y = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const key = mode === 'month' ? `${y}-${mo}` : `${y}-${mo}-${String(d.getDate()).padStart(2, '0')}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(s);
  }
  const out = [];
  for (const [key, arr] of map) {
    const st = statsOf(arr);
    out.push({
      key,
      label: mode === 'month' ? `${key.slice(0, 4)}/${key.slice(5)}` : `${key.slice(5, 7)}/${key.slice(8)}`,
      stats: st,
    });
  }
  out.sort((a, b) => (a.key < b.key ? -1 : 1));   // 按时间正序
  return out;
}

function drawChart(list) {
  const cv = $('#chart');
  if (!cv) return;
  const ctx0 = cv.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth || 320, h = cv.clientHeight || 150;
  cv.width = w * dpr; cv.height = h * dpr;
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const meta = $('#trend-meta');
  const metric = CHART_METRICS[S.chartMetric] ? S.chartMetric : 'mean';
  const mode = S.chartMode === 'month' ? 'month' : 'day';

  let pts = aggregateByPeriod(list, mode)
    .map((p) => ({ label: p.label, key: p.key, v: CHART_METRICS[metric].get(p.stats), stats: p.stats }))
    .filter((p) => p.v != null && !isNaN(p.v));

  if (!pts.length) {
    if (meta) meta.textContent = '暂无数据';
    ctx.fillStyle = 'rgba(15,23,42,.4)';
    ctx.font = '12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('暂无数据', w / 2, h / 2);
    return;
  }
  // 点太多时只显示最近 40 个周期
  const MAXP = 40;
  const skipped = pts.length > MAXP ? pts.length - MAXP : 0;
  if (skipped > 0) pts = pts.slice(-MAXP);

  const isCount = metric === 'count';
  const vals = pts.map((p) => p.v);
  let min = Math.min(...vals), max = Math.max(...vals);
  if (isCount) { min = 0; max = Math.max(1, max); }
  else if (max - min < 150) { const c = (max + min) / 2; min = c - 400; max = c + 400; }
  else { const pd = (max - min) * 0.15; min -= pd; max += pd; }

  const pad = { l: isCount ? 30 : 44, r: 12, t: 14, b: 26 };
  const X = (i) => (pts.length === 1
    ? pad.l + (w - pad.l - pad.r) / 2
    : pad.l + (i / (pts.length - 1)) * (w - pad.l - pad.r));
  const Y = (v) => pad.t + (1 - (v - min) / (max - min)) * (h - pad.t - pad.b);

  // 网格与刻度
  ctx.strokeStyle = 'rgba(15,23,42,.08)';
  ctx.lineWidth = 1;
  ctx.font = '10px ui-monospace, monospace';
  ctx.fillStyle = 'rgba(15,23,42,.5)';
  ctx.textAlign = 'right';
  const ticks = 3;
  for (let i = 0; i <= ticks; i++) {
    const v = min + (max - min) * (i / ticks);
    const y = Y(v);
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
    ctx.fillText(isCount ? String(Math.round(v)) : (v / 1000).toFixed(1), pad.l - 6, y + 3);
  }

  // 面积
  const grad = ctx.createLinearGradient(0, pad.t, 0, h - pad.b);
  grad.addColorStop(0, 'rgba(47,124,246,.20)');
  grad.addColorStop(1, 'rgba(47,124,246,0)');
  ctx.beginPath();
  ctx.moveTo(X(0), h - pad.b);
  pts.forEach((p, i) => ctx.lineTo(X(i), Y(p.v)));
  ctx.lineTo(X(pts.length - 1), h - pad.b);
  ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();

  // 折线
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(X(i), Y(p.v)) : ctx.moveTo(X(i), Y(p.v))));
  ctx.strokeStyle = '#2f7cf6'; ctx.lineWidth = 2; ctx.stroke();

  // 数据点：点数不多时逐点标注
  ctx.fillStyle = '#2f7cf6';
  pts.forEach((p, i) => {
    ctx.beginPath(); ctx.arc(X(i), Y(p.v), pts.length > 20 ? 2 : 3.2, 0, Math.PI * 2); ctx.fill();
  });
  if (pts.length <= 14) {
    ctx.fillStyle = 'rgba(15,23,42,.6)';
    ctx.textAlign = 'center';
    ctx.font = '10px ui-monospace, monospace';
    pts.forEach((p, i) => {
      const txt = isCount ? String(p.v) : (p.v / 1000).toFixed(1);
      ctx.fillText(txt, X(i), Y(p.v) - 8);
    });
  }

  // 横坐标：只标有记录的日期，且标签过多时抽稀
  ctx.fillStyle = 'rgba(15,23,42,.55)';
  ctx.font = '10px system-ui, sans-serif';
  ctx.textAlign = 'center';
  const step = Math.ceil(pts.length / Math.max(3, Math.floor((w - pad.l - pad.r) / 58)));
  pts.forEach((p, i) => {
    if (i % step !== 0 && i !== pts.length - 1) return;
    ctx.fillText(p.label, X(i), h - 8);
  });

  // 最快点高亮（仅时间指标）
  if (!isCount) {
    let bi = 0;
    pts.forEach((p, i) => { if (p.v < pts[bi].v) bi = i; });
    ctx.beginPath(); ctx.arc(X(bi), Y(pts[bi].v), 5, 0, Math.PI * 2);
    ctx.fillStyle = '#16a34a'; ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
  }

  if (meta) {
    const unitTxt = isCount ? '次' : '秒';
    meta.textContent = `${CHART_METRICS[metric].label} · ${mode === 'month' ? '按月' : '按天'}`
      + `　共 ${pts.length}${skipped ? `（另有较早 ${skipped} 个周期未显示）` : ''} 个数据点`
      + (isCount ? '' : `　最佳点 ${(Math.min(...vals) / 1000).toFixed(2)} ${unitTxt}`);
  }
}

/* ---------------- 指定日期查询 ---------------- */

function shiftDate(iso, deltaDays) {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + deltaDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 渲染指定日期的数据；iso 为空时自动选最近有记录的日期 */
function renderDayDetail(iso) {
  const list = S.cache.filter((s) => s.event === S.event);
  const groups = groupByDate(list);
  if (!groups.length) {
    ['d-count', 'd-best', 'd-mean', 'd-trim'].forEach((id) => { $('#' + id).textContent = '—'; });
    $('#day-list').innerHTML = '<div style="text-align:center;color:var(--dim-2);font-size:13px;padding:14px 0">暂无数据</div>';
    return;
  }
  let key = iso || S.dayPick || groups[0].date;
  // 若该日无记录，允许继续显示（明确提示），不要偷偷跳走
  S.dayPick = key;
  const pick = $('#day-pick');
  if (pick && pick.value !== key) pick.value = key;

  const dayList = list.filter((s) => s.date_key === key)
    .sort((a, b) => b.created_at - a.created_at);   // 最新在上
  const st = statsOf(dayList);
  $('#d-count').textContent = dayList.length ? `${st.total} 把${st.dnfCount ? ' · DNF ' + st.dnfCount : ''}` : '无记录';
  $('#d-best').textContent = st.best != null ? fmtTime(st.best) : '—';
  $('#d-mean').textContent = st.mean != null ? fmtTime(st.mean) : '—';
  $('#d-trim').textContent = st.trimmed != null ? fmtTime(st.trimmed) : '—';

  const box = $('#day-list');
  if (!dayList.length) {
    box.innerHTML = '<div style="text-align:center;color:var(--dim-2);font-size:13px;padding:14px 0">'
      + `${key.replace(/-/g, '/')}（${weekdayCN(key)}）没有成绩记录</div>`;
    return;
  }
  const valid = dayList.filter((s) => !s.dnf);
  const best = st.best, worst = st.worst;
  box.innerHTML = dayList.map((s) => {
    const t = s.dnf ? null : effectiveMs(s);
    const cls = s.dnf ? 'dnf' : (t === best ? 'best' : (t === worst ? 'worst' : ''));
    return `<div class="solve ${cls}">
      <span class="solve-time">${s.dnf ? 'DNF' : fmtTime(t)}</span>
      <span class="solve-scr">${s.scramble || ''}</span>
      <span class="solve-date">${String(new Date(s.created_at).getHours()).padStart(2, '0')}:${String(new Date(s.created_at).getMinutes()).padStart(2, '0')}</span>
    </div>`;
  }).join('');
  void valid;
}

function renderHistory() {
  const ev = $('#filter-event').value;
  const list = (ev ? S.cache.filter((s) => s.event === ev) : S.cache).slice();
  list.sort((a, b) => b.created_at - a.created_at);   // 最新记录在最上面
  const box = $('#history');

  // 未登录时能看到的记录 = 尚未归属任何账号的「本机成绩」。
  // 明确标出来，避免被误认为「没登录却看到了账号数据」。
  const unowned = list.filter((r) => !r.owner).length;
  const notice = (!S.user && unowned > 0)
    ? '<div class="hist-notice">'
      + '<span>本机成绩 ' + unowned + ' 条（尚未关联账号）· 登录后自动归属，其他设备即可看到</span>'
      + '<button class="btn ghost sm" onclick="document.getElementById(\'btn-auth\').click()">登录</button>'
      + '</div>'
    : '';

  if (!list.length) {
    let extra = '';
    if (S.cfg && S.cfg.url && S.cfg.key && !S.user) {
      extra = '<div style="margin-top:8px"><button class="btn ghost" onclick="document.getElementById(\'btn-auth\').click()">登录后查看成绩</button></div>'
            + '<div style="color:var(--dim-2);font-size:12px;margin-top:8px;line-height:1.7">成绩按「账号」隔离：未登录时只显示本机未归属的成绩。<br>登录你的账号即可看到云端与本地全部记录。</div>';
    }
    box.innerHTML = notice + '<div style="text-align:center;color:var(--dim-2);font-size:13px;padding:30px 0">暂无记录</div>' + extra;
    return;
  }

  const groups = groupByDate(list);
  box.innerHTML = notice + groups.map((g, gi) => `
    <div class="hist-day ${gi === 0 ? 'open' : ''}">
      <div class="hist-head">
        <div class="t">
          <span class="hist-d">${fmtDateCN(g.date)}</span>
          <span class="hist-w">${weekdayCN(g.date)}</span>
        </div>
        <div class="hist-sum">
          <span>${g.stats.total} 把</span>
          <span>最快 <b class="b">${g.stats.best != null ? fmtTime(g.stats.best) : '—'}</b></span>
          <span>平均 <b>${g.stats.mean != null ? fmtTime(g.stats.mean) : '—'}</b></span>
        </div>
      </div>
      <div class="hist-list">
        ${g.list.map((s) => {
          const t = effectiveMs(s);
          const when = new Date(s.created_at);
          return `<div class="hist-item">
            <span class="t" style="${s.penalty ? 'color:var(--warn)' : ''}">${fmtTime(t)}</span>
            <span class="s">${s.scramble}</span>
            <span class="solve-date">${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}</span>
            <button class="solve-del" data-id="${s.client_id}" title="删除" style="opacity:.6">✕</button>
          </div>`;
        }).join('')}
      </div>
    </div>`).join('');

  $$('.hist-head', box).forEach((h) => {
    h.onclick = () => h.parentElement.classList.toggle('open');
  });
  $$('.solve-del', box).forEach((b) => {
    b.onclick = async (e) => {
      e.stopPropagation();
      const id = b.dataset.id;
      S.cache = S.cache.filter((x) => x.client_id !== id);
      S.session = S.session.filter((x) => x.client_id !== id);
      await deleteSolve(id);
      toast('已删除');
      renderTimer(); renderStats(); renderHistory();
    };
  });
}

/* ---------------- 数据加载 ---------------- */

async function loadAll() {
  // 只加载「当前账号可见」的成绩：未登录时不显示账号数据
  S.cache = await visibleSolves();
}

/* ---------------- 云端 ---------------- */

async function initCloud(quiet) {
  S.cfg = await getSupabaseConfig();
  const badge = $('#cfg-state');
  // 显示当前来源，提醒用户配置按网址隔离
  const org = $('#cfg-origin');
  if (org) org.textContent = location.protocol + '//' + location.host;

  if (!S.cfg || !S.cfg.url || !S.cfg.key) {
    badge.textContent = '未配置';
    badge.style.color = '';
    $('#cfg-url').value = S.cfg?.url || '';
    $('#cfg-key').value = S.cfg?.key || '';
    return false;
  }

  // 配置来自随文件携带的 supabase-config.js：所有入口都免重复填写
  badge.textContent = S.cfg.fromFile ? '已配置 · 随文件生效' : '连接中…';
  badge.style.color = S.cfg.fromFile ? 'var(--acc)' : 'var(--warn)';

  try {
    await initSupabase(S.cfg);
    // 服务器明确拒绝凭据：提示重新登录，但本地数据与会话不动
    if (SB.needsReauth) {
      badge.textContent = '登录已过期 · 请重新登录';
      badge.style.color = 'var(--worst)';
      showSyncMsg('登录状态已过期，点顶栏「退出」后重新登录即可（本机成绩不会丢）', true);
    }
    const uid = await currentUserId();
    if (uid) {
      S.user = { id: uid };
      setSync(true);
      const moved = await migrateLocalToCloud(uid);
      await flushPendingDeletes();          // 先补删（其他设备删掉的）
      const pulled = await pullFromCloud();
      await flushPendingDeletes();          // 再补删一次（拉取对账后可能新增墓碑）
      await flushPending();
      // 无论有无变化都刷新：删除是「无新增但界面要变」的情况
      await loadAll();
      renderStats(); renderHistory(); renderTimer();
      const removed = (pullLastResult && pullLastResult.removed) || 0;
      if (!quiet && (moved || pulled || removed)) {
        toast(removed ? `已同步：新增 ${moved + pulled} · 移除 ${removed}（在别处删除的）`
                      : `已同步 ${moved + pulled} 条记录`);
      }
    } else {
      setSync(false);
    }
    badge.textContent = '已连接';
    badge.style.color = 'var(--best)';
  } catch (e) {
    setSync(false, true);
    badge.textContent = '连接失败';
    badge.style.color = 'var(--worst)';
    badge.title = e.message || '连接失败';
    if (!quiet) toast('云端连接失败：' + (e.message || '未知错误'));
  }

  $('#cfg-url').value = S.cfg?.url || '';
  $('#cfg-key').value = S.cfg?.key || '';
  return true;
}

function showSyncMsg(text, isErr) {
  const el = $('#sync-msg');
  if (!el) return;
  el.textContent = text;
  el.style.color = isErr ? 'var(--worst)' : 'var(--dim)';
}

function setSync(on, err) {
  const d = $('#sync-dot');
  d.className = 'sync-dot' + (err ? ' err' : (on ? ' on' : ''));
  d.title = err ? '云端连接异常，功能仍可离线使用' : (on ? '已连接账号' : '仅本机');
}

/* ---------------- 账号 UI ---------------- */

let authMode = 'in';

function openAuth(mode) {
  authMode = mode;
  $('#auth-title').textContent = mode === 'in' ? '登录' : '注册';
  $('#auth-sub').textContent = mode === 'in'
    ? '登录后可在手机与其他设备查看成绩'
    : '注册后成绩自动保存在你的账号';
  $('#auth-submit').textContent = mode === 'in' ? '登录' : '注册';
  $('#auth-switch').textContent = mode === 'in' ? '没有账号？去注册' : '已有账号？去登录';
  $('#auth-msg').textContent = '';
  $('#auth-pass').value = '';
  $('#auth-modal').classList.add('show');
  setTimeout(() => $('#auth-email').focus(), 60);
}

async function submitAuth() {
  const email = $('#auth-email').value.trim();
  const pass = $('#auth-pass').value;
  const msg = $('#auth-msg');
  msg.className = 'msg';

  if (!email || !pass) { msg.textContent = '请填写邮箱和密码'; return; }
  if (pass.length < 6) { msg.textContent = '密码至少 6 位'; return; }
  if (!SB.token && !SB.url) {
    msg.textContent = '请先在「设置」页填写 Supabase 配置并保存';
    return;
  }

  $('#auth-submit').disabled = true;
  $('#auth-submit').textContent = '处理中…';
  try {
    if (authMode === 'in') await signIn(email, pass);
    else {
      const r = await signUp(email, pass);
      if (r.needLogin) {
        msg.className = 'msg ok';
        msg.textContent = '注册成功。若提示需要验证，请到邮箱点击链接后登录';
        $('#auth-title').textContent = '登录';
        $('#auth-submit').textContent = '登录';
        authMode = 'in';
        return;
      }
    }
    msg.className = 'msg ok';
    msg.textContent = '成功，正在同步…';
    await new Promise((r) => setTimeout(r, 400));
    $('#auth-modal').classList.remove('show');
    S.user = SB.user;
    markEverLoggedIn();
    // 先把本机未上传的补上去，再把云端已有的拉下来（换设备/重新登录的关键步骤）
    let pushed = 0;
    try { pushed = await flushPending(); } catch (e) { /* 已记录 */ }
    const pulled = await pullFromCloud();
    const cloud = await cloudCount();
    await loadAll();
    renderStats(); renderHistory(); renderTimer();
    setSync(true);
    updateAuthUI();

    // 明确告知结果，避免「登录成功但什么都没发生」的困惑
    if (pulled > 0) {
      toast(`已登录，从云端恢复 ${pulled} 条成绩`);
    } else if (pushed > 0) {
      toast(`已登录，本机 ${pushed} 条成绩已上传到账号`);
    } else if (cloud === 0) {
      toast('已登录，但云端还没有这个账号的成绩');
      showSyncMsg('云端暂无该账号成绩。若成绩在别的设备（如电脑）上，请到那台设备登录后点「全量重新上传」', true);
    } else if (cloud > 0) {
      toast(`已登录，云端 ${cloud} 条（本机已是最新）`);
    } else {
      toast('已登录');
    }
  } catch (e) {
    // 关键：弹窗此时已经关闭，错误必须显示在弹窗之外，否则完全静默
    msg.textContent = e.message || '操作失败';
    toast('登录失败：' + (e.message || '未知错误'));
  } finally {
    $('#auth-submit').disabled = false;
    $('#auth-submit').textContent = authMode === 'in' ? '登录' : '注册';
  }
}

function updateAuthUI() {
  const b = $('#btn-auth');
  if (S.user) {
    b.textContent = '退出';
    b.onclick = async () => {
      await signOut();
      S.user = null;
      setSync(false);
      await loadAll();                     // 按归属重新过滤：账号成绩不再显示
      renderStats(); renderHistory(); renderTimer();
      updateAuthUI();
      toast('已退出登录，账号成绩已隐藏（数据仍保存在本机与云端）');
    };
  } else {
    b.textContent = '登录';
    b.onclick = () => openAuth('in');
  }
}

/* ---------------- 交互绑定 ---------------- */

function bindUI() {
  // 图表：横坐标粒度 + 纵坐标指标
  const redrawChart = () => drawChart(S.cache.filter((x) => x.event === S.event));
  const saveChartPref = () => {
    try { localStorage.setItem('ct_chart', JSON.stringify({ m: S.chartMode, k: S.chartMetric })); } catch (e) { /* 忽略 */ }
  };
  $$('#chart-mode button').forEach((b) => {
    b.onclick = () => {
      $$('#chart-mode button').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      S.chartMode = b.dataset.m; saveChartPref(); redrawChart();
    };
  });
  $$('#chart-metric button').forEach((b) => {
    b.onclick = () => {
      $$('#chart-metric button').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      S.chartMetric = b.dataset.k; saveChartPref(); redrawChart();
    };
  });

  // 指定日期：选择 / 前后翻页
  $('#day-pick').onchange = (e) => renderDayDetail(e.target.value);
  $('#day-prev').onclick = () => renderDayDetail(shiftDate(S.dayPick || localDateKey(new Date()), -1));
  $('#day-next').onclick = () => renderDayDetail(shiftDate(S.dayPick || localDateKey(new Date()), 1));

  // 按天统计：点击某天查看该日详情
  $('#daily').onclick = (e) => {
    const row = e.target.closest('.day');
    if (row && row.dataset.date) {
      renderDayDetail(row.dataset.date);
      $('#day-pick').scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  };

  // 标签页
  $$('#tabs .tab').forEach((t) => {
    t.onclick = () => {
      $$('#tabs .tab').forEach((x) => x.classList.remove('on'));
      t.classList.add('on');
      S.view = t.dataset.view;
      $$('.view').forEach((v) => v.classList.remove('on'));
      $('#view-' + S.view).classList.add('on');
      if (S.view === 'stats') renderStats();
      if (S.view === 'history') renderHistory();
    };
  });

  // 赛制
  $$('#mode button').forEach((b) => {
    b.onclick = () => {
      $$('#mode button').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      S.mode = b.dataset.mode;
      S.session = [];
      S.sessionId = uuid();
      resetRun();
      nextScramble();
      renderTimer();
    };
  });

  // 项目
  $('#event').onchange = (e) => {
    S.event = e.target.value;
    S.session = [];
    resetRun();
    nextScramble();
    renderTimer();
    renderStats();
  };

  // 观察计时快捷开关
  const syncInspectBtn = () => {
    $('#btn-inspect').textContent = '观察计时：' + (Number(S.pref.inspect) ? '开' : '关');
    $('#btn-inspect').style.color = Number(S.pref.inspect) ? 'var(--acc)' : 'var(--dim)';
  };
  syncInspectBtn();
  $('#btn-inspect').onclick = () => {
    S.pref.inspect = Number(S.pref.inspect) ? 0 : 1;
    savePrefs();
    syncInspectBtn();
    toast(S.pref.inspect ? '观察计时已开启（15 秒，超时判罚）' : '观察计时已关闭');
    resetInspect();
  };

  // 「开始观察」：由用户手动启动 15s 倒计时
  $('#btn-begin').onclick = () => {
    if (S.phase === 'running') return;
    if (!S.pref.inspect) { toast('观察计时已关闭，请先点右上角开关开启'); return; }
    startInspect();
  };

  $('#btn-new-scramble').onclick = () => {
    if (S.phase === 'running') { toast('计时中不能换打乱'); return; }
    nextScramble();
  };

  // 计时区：按住开始（鼠标 / 触摸），与空格行为一致
  const tb = $('#timer-box');
  tb.addEventListener('mousedown', (e) => { e.preventDefault(); if (!S.locked || S.phase === 'running') pressDown(); });
  tb.addEventListener('mouseup', () => pressUp());
  tb.addEventListener('touchstart', (e) => { e.preventDefault(); if (!S.locked || S.phase === 'running') pressDown(); }, { passive: false });
  tb.addEventListener('touchend', (e) => { e.preventDefault(); pressUp(); }, { passive: false });
  // 浏览器打断触摸（滚动/来电等）：按住未松开的状态必须复位，否则后续操作全部错乱
  tb.addEventListener('touchcancel', () => { if (S.phase === 'armed' || S.phase === 'ready') cancelArmed(); });
  // Android 长按菜单
  tb.addEventListener('contextmenu', (e) => e.preventDefault());

  // 锁定
  $('#btn-lock').onclick = () => {
    S.locked = !S.locked;
    $('#btn-lock').classList.toggle('on', S.locked);
    $('#lock-text').textContent = S.locked ? '已锁定' : '锁定';
    toast(S.locked ? '已锁定，其他按键不会干扰计时' : '已解锁');
  };

  // 键盘
  document.addEventListener('keydown', (e) => {
    if ($('#auth-modal').classList.contains('show')) {
      if (e.key === 'Enter') submitAuth();
      if (e.key === 'Escape') $('#auth-modal').classList.remove('show');
      return;
    }
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (S.view !== 'timer') return;

    // 空格：按住开始 / 按一下停止。必须过滤长按产生的重复 keydown
    if (e.code === 'Space' || e.key === ' ') {
      e.preventDefault();
      if (e.repeat) return;
      pressDown();
      return;
    }

    // 其余按键：锁定后一律忽略
    if (S.locked) return;

    if (e.key === 'd' || e.key === 'D') applyPenalty();
    else if (e.key === 'x' || e.key === 'X') applyDnf();
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteLast(); }
    else if (e.key === 'Escape') endSession();
  });

  // 松开空格：未达阈值则取消（防误触的核心）
  document.addEventListener('keyup', (e) => {
    if (e.code === 'Space' || e.key === ' ') pressUp();
  });

  // 登录弹窗
  $('#auth-close').onclick = () => { $('#auth-modal').classList.remove('show'); };
  $('#auth-skip').onclick = () => {
    try { sessionStorage.setItem('ct_auth_skip', '1'); } catch (e) { /* 隐私模式下忽略 */ }
    $('#auth-modal').classList.remove('show');
  };
  $('#auth-switch').onclick = () => openAuth(authMode === 'in' ? 'up' : 'in');
  $('#auth-submit').onclick = submitAuth;

  // 从本机备份恢复
  $('#btn-restore-bk').onclick = async () => {
    const n = await restoreFromBackup();
    await loadAll();
    renderStats(); renderHistory(); renderTimer();
    toast(n ? '已从本机备份恢复 ' + n + ' 条成绩' : '备份里没有可恢复的新数据');
    showSyncMsg('本机备份共 ' + backupCount() + ' 条', false);
  };

  // 连接诊断：逐项检查，输出到同步信息行（手机端同样可用）
  $('#btn-diag').onclick = async () => {
    const btn = $('#btn-diag');
    btn.disabled = true; btn.textContent = '诊断中…';
    const lines = [];
    const cfg = await getSupabaseConfig();
    lines.push(`网址 ${location.protocol}//${location.host}`);
    lines.push(cfg && cfg.url ? `配置 ✓ ${cfg.url.replace('https://', '')} · key ${String(cfg.key).slice(0, 18)}…` : '配置 ✗ 未找到');
    if (!cfg || !cfg.url || !cfg.key) {
      showSyncMsg(lines.join('；'), true);
      btn.disabled = false; btn.textContent = '连接诊断';
      return;
    }
    const t0 = performance.now();
    try {
      const r = await fetch(cfg.url + '/auth/v1/settings', {
        headers: { apikey: cfg.key, Authorization: 'Bearer ' + cfg.key },
      });
      const ms = Math.round(performance.now() - t0);
      lines.push(`直连云端 ${r.ok ? '✓' : '✗'} HTTP ${r.status} · ${ms}ms`);
    } catch (e) {
      lines.push(`直连云端 ✗ ${e.message}（${Math.round(performance.now() - t0)}ms）`);
    }
    // 代理可用性 + 手机地址（仅本机代理存在时）
    try {
      const ipr = await fetch('/__lanip');
      if (ipr.ok) {
        const info = await ipr.json();
        lines.push(`代理转发 ✓ 手机请用 http://${info.ip}:${info.port}`);
        SB.base = '/sb';
      }
    } catch (e) { /* 无代理 */ }
    if (S.user) {
      const t1 = performance.now();
      try {
        await sbFetch('/rest/v1/solves?select=client_id&limit=1');
        lines.push(`数据库读取 ✓ ${Math.round(performance.now() - t1)}ms`);
      } catch (e) {
        lines.push(`数据库读取 ✗ ${e.message}`);
      }
    } else {
      lines.push('数据库读取 — 未登录，跳过');
    }
    try {
      const st = await ownerStats();
      lines.push('会话 ' + ((await hasSavedSession()) ? '✓ 已保存' : '✗ 无')
        + (SB.user ? '（' + SB.user.email + '）' : '（未登录）')
        + '；成绩 共 ' + st.total + ' / 本机 ' + st.unowned
        + ' / 本账号 ' + st.mine + ' / 其他账号 ' + st.others);
      if (!SB.user && st.unowned > 0) {
        lines.push('说明：未登录时显示的是「本机成绩」，登录后会归属到你的账号');
      }
      if (SB.user) {
        const cc = await cloudCount();
        lines.push(cc === null ? '云端读取 ✗（拿不到条数）' : '云端该账号 ' + cc + ' 条');
        if (cc === 0) lines.push('云端为空 → 请在「有成绩的那台设备」登录后点「全量重新上传」');
      }
    } catch (e) { /* 忽略 */ }
    const bad = lines.some((x) => x.indexOf('✗') >= 0);
    showSyncMsg(lines.join('；'), bad);
    btn.disabled = false; btn.textContent = '连接诊断';
    toast(bad ? '诊断完成：存在异常，详见设置页提示' : '诊断完成：一切正常');
  };

  // 全量重新上传（补救用）
  $('#btn-sync-all').onclick = async () => {
    if (!S.user) { toast('请先登录账号'); return; }
    const btn = $('#btn-sync-all');
    btn.disabled = true; btn.textContent = '上传中…';
    showSyncMsg('正在全量上传本机成绩…', false);
    const r = await forcePushAll();
    btn.disabled = false; btn.textContent = '全量重新上传';
    if (r.error) { showSyncMsg('上传失败：' + r.error, true); return; }
    await loadAll();
    renderStats(); renderHistory(); renderTimer();
    if (r.err) {
      showSyncMsg(`上传未完成：成功 ${r.pushed} 条 · ${r.err}（请稍后再点一次）`, true);
      toast('上传未完成，可稍后重试');
      return;
    }
    showSyncMsg(`全量上传完成：本机 ${r.total} 把，成功上传 ${r.pushed} 条`, false);
    toast(`已上传 ${r.pushed} 条`);
  };

  // 立即同步（补传 + 拉取）
  $('#btn-sync-now').onclick = async () => {
    if (!S.user) { toast('请先登录账号'); return; }
    const btn = $('#btn-sync-now');
    btn.disabled = true; btn.textContent = '同步中…';
    showSyncMsg('正在同步…', false);
    const r = await syncNow();
    btn.disabled = false; btn.textContent = '立即同步';
    if (r.error) { showSyncMsg('同步失败：' + r.error, true); return; }
    await loadAll();
    renderStats(); renderHistory(); renderTimer();
    if (r.err) {
      showSyncMsg(`已上传 ${r.pushed} 条，其余未成功：${r.err}`, true);
      toast('部分成绩未上传，点「全量重新上传」重试');
      return;
    }
    const cloud = await cloudCount();
    const cloudTxt = cloud === null ? '云端 ?' : `云端 ${cloud} 条`;
    let msg = `本机 ${r.total} 把（待传 ${r.pending}）· 上传 ${r.pushed} · 拉取 ${r.pulled} · ${cloudTxt}`;
    if (r.total === 0 && r.pulled === 0) {
      msg = cloud === 0
        ? '本机与云端都没有成绩。若成绩在别的设备，请在那台设备登录后点「全量重新上传」'
        : `本机暂无成绩 · ${cloudTxt} · 点「立即同步」可再次拉取`;
    } else if (r.pushed === 0 && r.pulled === 0 && r.pending === 0) {
      msg = `本机 ${r.total} 把均已同步 · ${cloudTxt}`;
    }
    showSyncMsg(msg, false);
    toast(r.pushed || r.pulled ? '同步完成' : '无需同步');
  };

  // 设置
  $('#btn-save-cfg').onclick = async () => {
    const url = $('#cfg-url').value.trim();
    const key = $('#cfg-key').value.trim();
    const n = normalizeConfig({ url, key });
    if (!n.ok) { toast(n.msg); return; }

    const btn = $('#btn-save-cfg');
    btn.disabled = true;
    btn.textContent = '测试连接中…';
    try {
      // 先测连通性，把原因说清楚再决定是否保存
      const r = await testConnection(n.url, n.key);
      if (!r.ok) {
        toast(r.msg);
        btn.disabled = false;
        btn.textContent = '保存配置';
        return;
      }
      await saveSupabaseConfig({ url: n.url, key: n.key });
      await initCloud();
      toast('配置已保存并连接成功');
    } catch (e) {
      toast('保存失败：' + (e.message || '未知错误'));
    } finally {
      btn.disabled = false;
      btn.textContent = '保存配置';
    }
  };
  $('#pref-start').value = String(S.pref.startDelay);
  $('#pref-start').onchange = (e) => { S.pref.startDelay = Number(e.target.value); savePrefs(); toast('已保存'); };
  $('#pref-inspect').value = String(S.pref.inspect);
  $('#pref-inspect').onchange = (e) => { S.pref.inspect = Number(e.target.value); savePrefs(); nextScramble(); };
  $('#pref-sound').value = String(S.pref.sound);
  $('#pref-sound').onchange = (e) => { S.pref.sound = Number(e.target.value); savePrefs(); };

  $('#btn-clear').onclick = async () => {
    if (!confirm('确定清空本机所有成绩？此操作不可撤销。')) return;
    // 必须连「防丢失备份」一起清，否则刷新后会被自动恢复
    await clearLocalSolves();
    S.cache = [];
    S.session = [];
    renderTimer(); renderStats(); renderHistory();
    toast('已清空');
  };

  $('#filter-event').onchange = renderHistory;
  $('#btn-export').onclick = exportCSV;

  // 离开页面时取消动画，避免卡顿
  window.addEventListener('beforeunload', () => {
    clearTimeout(S.armTimer);
    cancelAnimationFrame(S.rafId);
    stopInspect();
  });

  startInspect();
}

/* ---------------- 导出 ---------------- */

function exportCSV() {
  if (!S.cache.length) { toast('暂无数据'); return; }
  const head = ['日期', '时间', '项目', '成绩(ms)', '罚时(s)', '观察罚时(s)', 'DNF', '打乱'];
  const rows = S.cache.map((s) => [
    s.date_key,
    new Date(s.created_at).toTimeString().slice(0, 8),
    s.event,
    s.time_ms,
    s.penalty || 0,
    s.inspection_penalty || 0,
    s.dnf ? 'YES' : '',
    s.scramble,
  ]);
  const csv = '﻿' + [head, ...rows].map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `cubetimer-${localDateKey()}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('已导出 CSV');
}

/* ---------------- 提示 / 声音 ---------------- */

let toastT;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('on'), 1900);
}

/* ---------------- 看板娘 ---------------- */

function skipAuthThisSession() {
  try { return sessionStorage.getItem('ct_auth_skip') === '1'; } catch (e) { return false; }
}

/* 是否在这台设备上登录过（一旦登录过，就不再自动弹登录框打扰用户） */
function everLoggedIn() {
  try { return localStorage.getItem('ct_ever_login') === '1'; } catch (e) { return false; }
}
function markEverLoggedIn() {
  try { localStorage.setItem('ct_ever_login', '1'); } catch (e) { /* 忽略 */ }
}

const MASCOT_TIPS = [
  '加油，今天的 PB 在等你！',
  '按住空格，松开那一刻计时才开始哦～',
  '先观察 15 秒，想好第一步再动手吧。',
  'Bo5 取最快，稳住别急！',
  '记得「开始观察」要手动点一下哦。',
  '慢下来才能快——分解步骤做标准。',
  '连续练习 5 组，比狂转一小时更有效。',
  '今天也是适合还原魔方的好天气！',
];
let tipIdx = 0, tipTimer = null;
function startMascotTips() {
  const el = $('#mascot-tip');
  if (!el) return;
  el.onclick = () => {
    tipIdx = (tipIdx + 1) % MASCOT_TIPS.length;
    const span = $('#tip-text');
    span.textContent = MASCOT_TIPS[tipIdx];
    // 重放入场动画
    span.style.animation = 'none';
    void span.offsetWidth;
    span.style.animation = 'tipIn .35s ease';
  };
  tipTimer = setInterval(() => el.click(), 12000);
}

let audioCtx;
function beep(freq, dur) {
  if (!S.pref.sound) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = 'sine';
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.05, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + dur);
    o.connect(g); g.connect(audioCtx.destination);
    o.start();
    o.stop(audioCtx.currentTime + dur);
  } catch (e) { /* 忽略 */ }
}
