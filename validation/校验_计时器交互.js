/* 计时器交互自检（纯 Node，无第三方依赖；用替身 DOM 把三个脚本按页面顺序装起来）
 *
 * 检查项：
 *   A. 触摸被浏览器打断（touchcancel）后：状态必须回到 idle，
 *      并且紧接着的一次「抬手」不能把计时器偷偷启动
 *   B. 「清空」按钮：主存储 + 备份一起清，刷新后成绩不会自己回来
 *
 * 用法：node 校验_计时器交互.js [--aux <原始计时器目录>] <计时器目录> [...]
 *   --aux 用于补齐修复包里没带的公共文件（scramble.js 之类）
 * 期望：修复后的目录全绿；修复前在 A（ready 卡住）与 B（成绩复活）上报错。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let confirmAnswer = true;   // 替身 confirm() 的返回值：默认点「确定」

const fails = [];
function check(cond, okMsg, badMsg) {
  if (cond) console.log('   ✓ ' + okMsg);
  else { console.log('   ✗ ' + badMsg); fails.push(badMsg); }
}

/** 万能替身元素：任何属性都能读、都能调用，classList 真实记录 */
function makeEl() {
  const classes = new Set();
  const store = {};
  const el = new Proxy(store, {
    get(t, k) {
      if (k === 'classList') {
        return {
          add: (...c) => c.forEach((x) => classes.add(x)),
          remove: (...c) => c.forEach((x) => classes.delete(x)),
          toggle: (c, f) => (f ? classes.add(c) : classes.delete(c)),
          contains: (c) => classes.has(c),
        };
      }
      if (k === '__classes') return classes;
      if (k === 'style' || k === 'dataset') return t[k] || (t[k] = {});
      if (k === 'addEventListener' || k === 'appendChild' || k === 'removeChild'
        || k === 'scrollIntoView' || k === 'focus' || k === 'click') return () => {};
      if (k === 'children') return [];
      if (k in t) return t[k];
      return () => el;                     // getContext 之类的调用一律返回自身
    },
    set(t, k, v) { t[k] = v; return true; },
  });
  return el;
}

/** 建一个「页面」环境：按 index.html 的顺序装入 scramble.js / store.js / app.js */
function newPage(dir, lsData, { withApp = true, auxDir = dir } = {}) {
  const cache = new Map();
  const pick = (sel) => {
    if (!cache.has(sel)) cache.set(sel, makeEl());
    return cache.get(sel);
  };
  const doc = {
    querySelector: pick,
    getElementById: pick,
    querySelectorAll: () => [],
    addEventListener: () => {},
    createElement: () => makeEl(),
    body: makeEl(),
    documentElement: makeEl(),
    visibilityState: 'visible',
  };
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    document: doc,
    window: { addEventListener: () => {}, AudioContext: undefined },
    localStorage: {
      getItem: (k) => (Object.prototype.hasOwnProperty.call(lsData, k) ? lsData[k] : null),
      setItem: (k, v) => { lsData[k] = String(v); },
      removeItem: (k) => { delete lsData[k]; },
    },
    sessionStorage: {
      getItem: () => null, setItem: () => {}, removeItem: () => {},
    },
    location: { protocol: 'http:', host: 'localhost', href: 'http://localhost/' },
    navigator: { userAgent: 'node-check/1.0', serviceWorker: undefined },
    performance: { now: () => Date.now() },
    requestAnimationFrame: (fn) => setTimeout(fn, 16),
    cancelAnimationFrame: (id) => clearTimeout(id),
    setTimeout, clearTimeout, setInterval, clearInterval,
    confirm: () => confirmAnswer,
    alert: () => {},
    AbortController,
    fetch: async () => { throw new TypeError('offline'); },
    crypto: { randomUUID: () => '00000000-0000-4000-8000-' + String(++newPage.n).padStart(12, '0') },
  };
  newPage.n = newPage.n || 0;
  const ctx = vm.createContext(sandbox);
  const load = (f) => {
    const p = [path.join(dir, f), path.join(auxDir, f)].find((x) => fs.existsSync(x));
    if (!p) throw new Error(`找不到 ${f}（可用 --aux 指定公共文件所在目录）`);
    vm.runInContext(fs.readFileSync(p, 'utf8'), ctx, { filename: f });
  };
  load('scramble.js');
  load('store.js');
  vm.runInContext('globalThis.__API = { store, saveSolve, allSolves, recoverIfEmpty };', ctx);
  if (withApp) {
    load('app.js');
    vm.runInContext('globalThis.__UI = { S, bindUI, pressDown, pressUp, cancelArmed };', ctx);
  }
  return { ctx, doc, pick, ui: ctx.__UI, api: ctx.__API };
}

async function run(dir, auxDir) {
  console.log(`\n== ${dir}`);
  const lsData = {};
  const page = newPage(dir, lsData, { auxDir });

  /* ---- A. touchcancel 之后状态复位 ---- */
  page.ui.S.pref.startDelay = 0;           // 0 延迟：按下即进入 ready（等松开才开始）
  page.ui.pressDown();
  check(page.ui.S.phase === 'ready', '按住后进入 ready（等待松开）', `按住后状态异常：${page.ui.S.phase}`);
  page.ui.cancelArmed();                   // touchcancel 走的就是这里
  check(page.ui.S.phase === 'idle', 'touchcancel 后回到 idle', `touchcancel 后卡在 ${page.ui.S.phase}（后续操作会错乱）`);
  const box = page.pick('#timer-box');
  check(!box.__classes.has('armed') && !box.__classes.has('ready'), 'touchcancel 后样式已清干净',
    'touchcancel 后仍残留 armed/ready 样式');
  page.ui.pressUp();                       // 被打断后可能补发一次抬手
  check(page.ui.S.phase !== 'running', '打断后多余的抬手不会启动计时', `打断后多余的抬手把计时启起来了：${page.ui.S.phase}`);

  page.ui.S.phase = 'idle';                // 复位，避免上一项失败串扰
  page.ui.S.pref.startDelay = 500;         // 防误触延迟中的取消（原本就支持，防回归）
  page.ui.pressDown();
  check(page.ui.S.phase === 'armed', '按住后进入 armed（未达延迟）', `armed 阶段异常：${page.ui.S.phase}`);
  page.ui.cancelArmed();
  check(page.ui.S.phase === 'idle', 'armed 阶段取消仍正常', `armed 取消失效：${page.ui.S.phase}`);
  clearTimeout(page.ui.S.armTimer);

  /* ---- B. 「清空」按钮的完整链路 ---- */
  const page2 = newPage(dir, lsData, { auxDir });
  for (const ms of [10000, 11000, 12000]) await page2.api.saveSolve({ event: '3x3', timeMs: ms });
  check((await page2.api.store.all('solves')).length === 3, '清空前有 3 条成绩', '清空前成绩条数异常');
  try {
    await page2.ui.bindUI();               // 绑定按钮（含 #btn-clear）
  } catch (e) {
    console.log('   · 提示：bindUI 在替身 DOM 下报错（不影响清空链路检查）：' + e.message);
  }
  const btn = page2.pick('#btn-clear');
  check(typeof btn.onclick === 'function', '清空按钮已绑定处理函数', '清空按钮没有绑定处理函数（bindUI 未完成）');
  try { await btn.onclick(); } catch (e) { console.log('   · 提示：清空处理函数尾部报错：' + e.message); }
  check((await page2.api.store.all('solves')).length === 0, '点击后主存储已清空', '点击后主存储仍有数据');

  const page3 = newPage(dir, lsData, { withApp: false, auxDir });   // 模拟刷新
  const n = await page3.api.recoverIfEmpty();
  const left = (await page3.api.store.all('solves')).length;
  check(n === 0 && left === 0, '刷新后仍为空（备份也清了）', `刷新后成绩复活：恢复 ${n} 条、现存 ${left} 条`);
}

(async () => {
  const argv = process.argv.slice(2);
  let aux = null;
  const dirs = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--aux') { aux = argv[++i]; continue; }
    dirs.push(argv[i]);
  }
  if (!dirs.length) {
    console.error('用法：node 校验_计时器交互.js [--aux <原始计时器目录>] <计时器目录> [...]');
    process.exit(2);
  }
  for (const d of dirs) {
    try { await run(d, aux || d); }
    catch (e) { console.log(`   ✗ 执行失败：${e.message}`); fails.push(d + ': ' + e.message); }
  }
  console.log(fails.length ? `\n结果：${fails.length} 项不符合预期\n` : '\n结果：全部通过\n');
  process.exit(fails.length ? 1 : 0);
})();
