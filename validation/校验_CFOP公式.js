/* CFOP 公式页自检：直接借用页面自带的魔方引擎，不依赖任何第三方库。
 *
 * 检查项：
 *   1. 全部公式都能被解析器解析（OLL 57 / PLL 21 / F2L 41 / 桥式 45）
 *   2. 每条公式作用在自己的 case 上，都能回到还原状态（允许整体转动）
 *   3. PLL 的 21 个 case 两两不同（按 U 面 4 向旋转归一化后比较）
 *   4. OLL 的 57 个 case 两两不同；F2L 的 case 合法
 *
 * 说明：个别公式（如 PLL V）自带整体转动 y，必须先把 case 旋回标准视角
 * （让 F2L 落在固定坐标上）再判定，否则会把正常公式误报成错误。
 *
 * 用法：node 校验_CFOP公式.js <CFOP公式学习.html 路径> [...]
 */
const fs = require('fs');
const vm = require('vm');

/** 抽出页面里第一段 <script>（即魔方引擎 + 公式数据 + 界面逻辑） */
function extractScript(html) {
  const s = html.indexOf('<script>');
  if (s < 0) throw new Error('找不到 <script>');
  const e = html.indexOf('</script>', s);
  if (e < 0) throw new Error('找不到 </script>');
  return html.slice(s + '<script>'.length, e);
}

/** 在 Node 里跑页面脚本：给出最小 DOM / localStorage 替身 */
function loadEngine(html) {
  const stubs = {
    console,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    document: {
      addEventListener() {},
      getElementById: () => null,
      querySelectorAll: () => [],
      createElement: () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {} }, appendChild() {}, addEventListener() {} }),
    },
    alert() {},
  };
  const ctx = vm.createContext(stubs);
  const code = extractScript(html) + `
;globalThis.__API = { pll, oll, f2l, bridge, parseAlg, applyAlg, caseFromAlg, solvedState,
  f2lSolved, f2lCaseValid, uFaceUniform, permutationParity, colorAt, deepEq: null };`;
  vm.runInContext(code, ctx, { filename: 'CFOP公式学习.html#script' });
  return ctx.__API;
}

const eq = (a, b) => a.length === b.length && a.every((v, i) => v.every((x, k) => x === b[i][k]));
const ser = (st) => st.map((v) => v.join(',')).join('|');

const WHOLE_MOVES = ['y', "y'", 'y2', 'x', "x'", 'x2', 'z', "z'", 'z2'];

/** 24 个「已还原但朝向不同」的状态 + 各自对应的转动序列 */
function solvedOrientations(api) {
  const out = new Map();
  const q = [['', api.solvedState()]];
  while (q.length) {
    const [seq, st] = q.pop();
    const k = ser(st);
    if (out.has(k)) continue;
    out.set(k, { state: st, seq });
    for (const m of WHOLE_MOVES) q.push([seq ? seq + ' ' + m : m, api.applyAlg(st, m)]);
  }
  return out;
}

/**
 * 把 case 转回标准视角：找到某个整体转动，使 F2L（D 层 + 中层）落在固定坐标上。
 * 找不到就原样返回（此时由后续检查照常报错）。
 */
function normalizeFrame(api, orientations, state) {
  for (const { seq } of orientations.values()) {
    const st = seq ? api.applyAlg(state, seq) : state;
    if (api.f2lSolved(st)) return { state: st, rot: seq || '（无需转动）' };
  }
  return { state, rot: null };
}

/** U 面 4 向旋转归一化：取最小序列作为 case 指纹 */
function canonY(api, state) {
  const rots = ['', 'y', "y'", 'y2'].map((r) => (r ? api.applyAlg(state, r) : state));
  return rots.map(ser).sort()[0];
}

function audit(file) {
  const html = fs.readFileSync(file, 'utf8');
  const api = loadEngine(html);
  const solved = solvedOrientations(api);
  const problems = [];
  const groups = { pll: api.pll, oll: api.oll, f2l: api.f2l, bridge: api.bridge };

  // 1 + 2：解析 + 自解
  for (const [name, list] of Object.entries(groups)) {
    for (const it of list) {
      let toks;
      try {
        toks = api.parseAlg(it.alg);
      } catch (e) {
        problems.push(`[解析失败] ${name} ${it.id}: ${e.message}`);
        continue;
      }
      if (!toks.length) problems.push(`[空公式] ${name} ${it.id}`);
      const st = api.caseFromAlg(it.alg);
      const after = api.applyAlg(st, it.alg);
      if (!solved.has(ser(after))) problems.push(`[无法自解] ${name} ${it.id}: ${it.alg}`);
      const norm = normalizeFrame(api, solved, st);
      if (name === 'f2l' || name === 'bridge') {
        const v = api.f2lCaseValid(norm.state);
        if (!v.ok && name === 'f2l') {
          problems.push(`[F2L case 非法] ${it.id}: 十字错 ${v.badCross} / 底角错 ${v.badCorner} / 中层棱错 ${v.badMidEdge}`);
        }
      } else {
        if (!norm.rot) problems.push(`[${name} case 破坏了 F2L] ${it.id}`);
        // OLL 的定义就是「U 面尚未统一」，只有 PLL 才要求 U 面同色
        if (name === 'pll' && !api.uFaceUniform(norm.state)) problems.push(`[pll case U 面不同色] ${it.id}`);
        const par = api.permutationParity(norm.state);
        if (par.corner !== par.edge) problems.push(`[置换奇偶不合法] ${name} ${it.id}`);
      }
    }
  }

  // 3 + 4：case 去重
  const dup = [];
  for (const name of ['pll', 'oll']) {
    const seen = new Map();
    for (const it of groups[name]) {
      const key = canonY(api, normalizeFrame(api, solved, api.caseFromAlg(it.alg)).state);
      if (seen.has(key)) dup.push(`[${name} case 重复] ${seen.get(key)} 与 ${it.id} 完全相同`);
      else seen.set(key, it.id);
    }
  }
  problems.push(...dup);

  const counts = Object.entries(groups).map(([k, v]) => `${k}=${v.length}`).join(' ');
  return { file, counts, problems };
}

let bad = 0;
const files = process.argv.slice(2);
if (!files.length) {
  console.error('用法：node 校验_CFOP公式.js <CFOP公式学习.html> [...]');
  process.exit(2);
}
for (const f of files) {
  let r;
  try {
    r = audit(f);
  } catch (e) {
    console.log(`\n== ${f}\n   [脚本执行失败] ${e.message}`);
    bad++;
    continue;
  }
  console.log(`\n== ${f}`);
  console.log(`   公式条数：${r.counts}`);
  if (!r.problems.length) console.log('   全部通过：解析 / 自解 / case 去重 / 合法性');
  else {
    bad++;
    r.problems.forEach((p) => console.log('   ✗ ' + p));
  }
}
process.exit(bad ? 1 : 0);
