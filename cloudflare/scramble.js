/* =========================================================
   WCA 规范打乱公式生成器
   规则（依据 WCA Regulations Article A / scrambles 通用约束）：
     1. 随机选取一个面转动（U D L R F B）
     2. 不能与前一步转同一个面
     3. 不能与前两步在同一条轴上（如 R L、R' L' 会出现等效抵消）
     4. 最后两步不能互为逆且同轴（如 R ... R'）
     5. 不能连续三步同轴（避免过于简单）
   ========================================================= */

const FACES = ['U', 'D', 'L', 'R', 'F', 'B'];
const SUFFIX = ["", "'", '2'];

/** 面的轴：U/D -> 1, R/L -> 2, F/B -> 3 */
const AXIS = { U: 1, D: 1, R: 2, L: 2, F: 3, B: 3 };

const randInt = (n) => Math.floor(Math.random() * n);
const pick = (arr) => arr[randInt(arr.length)];

/**
 * 生成一条 WCA 合法的打乱公式
 * @param {number} length 步数（3x3 用 20）
 */
function genScramble(length = 20) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const seq = [];
    let ok = true;

    for (let i = 0; i < length; i++) {
      let face, suffix, tries = 0;

      do {
        face = pick(FACES);
        suffix = pick(SUFFIX);
        tries++;
        if (tries > 200) { ok = false; break; }
      } while (!isLegal(seq, face, suffix));

      if (!ok) break;
      seq.push({ face, suffix });
    }

    if (!ok || seq.length !== length) continue;

    // 最终检查：打乱后不能与还原态等价（防止公式过于简单）
    const text = fmtScramble(seq);
    if (scrambleTooSimple(text)) continue;

    return text;
  }
  // 兜底（正常不会走到）
  return "R U R' U' R U F'";
}

function fmtScramble(seq) {
  return seq.map((m) => m.face + m.suffix).join(' ');
}

/** 判断在 seq 之后追加 face+suffix 是否合法 */
function isLegal(seq, face, suffix) {
  if (seq.length === 0) return true;

  const last = seq[seq.length - 1];

  // 规则 2：不能与前一步同面
  if (last.face === face) return false;

  // 规则 3：前一步与当前不能同轴（R 与 L 同轴）
  if (AXIS[last.face] === AXIS[face]) return false;

  // 规则 5：不能连续三步同轴
  if (seq.length >= 2) {
    const prev = seq[seq.length - 2];
    if (AXIS[prev.face] === AXIS[face]) return false;
  }

  // 规则 4：最后两步互为逆且同轴（如 R ... R'）
  if (seq.length >= 2 && suffix !== "2") {
    const prev = seq[seq.length - 2];
    if (prev.face === face && prev.suffix !== "2" && prev.suffix !== suffix) {
      return false;
    }
  }

  return true;
}

/* ---------- 魔方引擎（用于验证打乱是否「真的打乱了」） ---------- */

const CUBE_FACES = {
  U: { n: [0, 1, 0], r: [1, 0, 0], u: [0, 0, -1] },
  R: { n: [1, 0, 0], r: [0, 0, -1], u: [0, 1, 0] },
  F: { n: [0, 0, 1], r: [1, 0, 0], u: [0, 1, 0] },
  D: { n: [0, -1, 0], r: [1, 0, 0], u: [0, 0, 1] },
  L: { n: [-1, 0, 0], r: [0, 0, 1], u: [0, 1, 0] },
  B: { n: [0, 0, -1], r: [-1, 0, 0], u: [0, 1, 0] },
};
const CUBE_FACE_ORDER = ['U', 'R', 'F', 'D', 'L', 'B'];

/** 54 个贴纸的 3D 位置与法向 */
const STK = [];
const STK_IDX = {};
(function buildStickers() {
  let i = 0;
  for (const f of CUBE_FACE_ORDER) {
    const { n, r, u } = CUBE_FACES[f];
    for (let row = -1; row <= 1; row++) {
      for (let col = -1; col <= 1; col++) {
        const p = [
          n[0] + r[0] * col + u[0] * row,
          n[1] + r[1] * col + u[1] * row,
          n[2] + r[2] * col + u[2] * row,
        ];
        STK.push({ p, n: n.slice() });
        STK_IDX[`${p[0]},${p[1]},${p[2]}|${n[0]},${n[1]},${n[2]}`] = i++;
      }
    }
  }
})();

function rot90(v, axis, sign) {
  const [x, y, z] = v;
  if (axis === 'x') return sign > 0 ? [x, -z, y] : [x, z, -y];
  if (axis === 'y') return sign > 0 ? [z, y, -x] : [-z, y, x];
  return sign > 0 ? [-y, x, z] : [y, -x, z];
}

const CUBE_MOVES = {
  U: { axis: 'y', test: (p) => p[1] === 1, sign: -1 },
  D: { axis: 'y', test: (p) => p[1] === -1, sign: 1 },
  R: { axis: 'x', test: (p) => p[0] === 1, sign: -1 },
  L: { axis: 'x', test: (p) => p[0] === -1, sign: 1 },
  F: { axis: 'z', test: (p) => p[2] === 1, sign: -1 },
  B: { axis: 'z', test: (p) => p[2] === -1, sign: 1 },
};

const CUBE_MAP = {};
for (const key of Object.keys(CUBE_MOVES)) {
  const mv = CUBE_MOVES[key];
  const map = new Array(54);
  for (let i = 0; i < 54; i++) {
    if (!mv.test(STK[i].p)) { map[i] = -1; continue; }
    const np = rot90(STK[i].p, mv.axis, mv.sign);
    const nn = rot90(STK[i].n, mv.axis, mv.sign);
    map[i] = STK_IDX[`${np[0]},${np[1]},${np[2]}|${nn[0]},${nn[1]},${nn[2]}`];
  }
  CUBE_MAP[key] = map;
}

function applyCubeMove(state, key) {
  const base = key.replace(/['2]/g, '');
  const map = CUBE_MAP[base];
  let times = key.endsWith('2') ? 2 : (key.endsWith("'") ? 3 : 1);
  let st = state;
  for (let t = 0; t < times; t++) {
    const out = st.slice();
    for (let i = 0; i < 54; i++) {
      const j = map[i];
      if (j >= 0) out[j] = st[i];
    }
    st = out;
  }
  return st;
}

function solvedCubeState() { return STK.map((s) => s.n.slice()); }

function applyScramble(state, scramble) {
  let st = state;
  for (const m of scramble.trim().split(/\s+/)) {
    if (m) st = applyCubeMove(st, m);
  }
  return st;
}

/** 打乱后与还原态的差异块数（用于判断打乱是否「太简单」） */
function scrambledPieceCount(scramble) {
  const st = applyScramble(solvedCubeState(), scramble);
  const S = solvedCubeState();
  let diff = 0;
  for (let i = 0; i < 54; i++) {
    if (st[i][0] !== S[i][0] || st[i][1] !== S[i][1] || st[i][2] !== S[i][2]) diff++;
  }
  return diff;
}

/** 差异过少（<12 格）视为过于简单，重新生成 */
function scrambleTooSimple(scramble) {
  return scrambledPieceCount(scramble) < 12;
}

/* ---------- 不同赛制的事件配置 ---------- */
const EVENTS = {
  '3x3': { scrambleLen: 20, name: '三阶魔方' },
  '4x4': { scrambleLen: 46, name: '四阶魔方' },
  '2x2': { scrambleLen: 11, name: '二阶魔方' },
  'OH':  { scrambleLen: 20, name: '单手三阶' },
};

function scrambleFor(event = '3x3') {
  const len = (EVENTS[event] || EVENTS['3x3']).scrambleLen;
  return genScramble(len);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    genScramble, scrambleFor, EVENTS,
    applyScramble, solvedCubeState, scrambledPieceCount, isLegal, AXIS,
  };
}
