/* =========================================================
   数据层：本地 IndexedDB（离线可用）+ Supabase（跨设备同步）
   设计原则：
     1. 离线优先 —— 任何写入都先落本地，网络请求一律异步，绝不阻塞计时
     2. 只追加不修改 —— solves 表只 INSERT，永不 UPDATE，天然避免多端冲突
     3. 幂等 —— 每条记录带 client_id（本地生成 UUID），重复上传不会产生重复数据
     4. 匿名体验 —— 未登录也能完整使用，登录后本地数据一次性迁移到云端
   ========================================================= */

/* ---------------- 本地存储：IndexedDB 极简封装 ---------------- */

const DB_NAME = 'cubetimer';
const DB_VER = 1;
let _db = null;

function openDB() {
  return new Promise((resolve, reject) => {
    if (_db) return resolve(_db);
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('solves')) {
        const st = db.createObjectStore('solves', { keyPath: 'client_id' });
        st.createIndex('created_at', 'created_at');
        st.createIndex('session_id', 'session_id');
      }
      if (!db.objectStoreNames.contains('sessions')) {
        db.createObjectStore('sessions', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'k' });
      }
    };
    req.onsuccess = (e) => { _db = e.target.result; resolve(_db); };
    req.onerror = (e) => reject(e);
  });
}

function tx(store, mode, fn) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    const req = fn(s);
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

/**
 * IndexedDB 可能因隐私模式、file:// 限制或存储被禁用而打开失败。
 * 此时自动降级到 localStorage，绝不让调用方因存储不可用而崩溃。
 */
function withFallback(idbFn, lsFn, ...args) {
  try {
    return Promise.resolve(idbFn(...args)).catch(() => lsFn(...args));
  } catch (e) {
    return Promise.resolve().then(() => lsFn(...args));
  }
}

/** IndexedDB 为主 + localStorage 镜像（互为冗余，任一侧缺失自动补齐） */
const LS_KEY = (st) => 'ct_' + st;
const keyOf = (v) => (v && (v.client_id || v.id || v.k)) || null;
const memoryStore = { solves: new Map(), sessions: new Map(), meta: new Map() };

function lsLoad(st) {
  try {
    const raw = localStorage.getItem(LS_KEY(st));
    if (raw) JSON.parse(raw).forEach((v) => memoryStore[st].set(keyOf(v), v));
  } catch (e) { /* 忽略 */ }
}
function lsSave(st) {
  try { localStorage.setItem(LS_KEY(st), JSON.stringify([...memoryStore[st].values()])); } catch (e) { /* 超限忽略 */ }
}

function lsPut(st, val) { memoryStore[st].set(keyOf(val), val); lsSave(st); }
function lsPutAll(st, vals) { (vals || []).forEach((v) => memoryStore[st].set(keyOf(v), v)); lsSave(st); }
function lsGet(st, key) { if (!memoryStore[st].has(key)) lsLoad(st); return memoryStore[st].get(key); }
function lsAll(st) { if (!memoryStore[st].size) lsLoad(st); return [...memoryStore[st].values()]; }
function lsDel(st, key) { memoryStore[st].delete(key); lsSave(st); }
function lsClear(st) { memoryStore[st].clear(); try { localStorage.removeItem(LS_KEY(st)); } catch (e) { /* 忽略 */ } }

/* 真正的 IndexedDB 操作。注意：之前这里误写成 idb 调用自身，
   导致栈溢出并被降级分支吞掉，所有数据只留在内存里 —— 一刷新就丢。
   那是「历史记录消失 / 每次都要重新登录」的真正原因。 */
const idbRaw = {
  put: (st, val) => tx(st, 'readwrite', (s) => s.put(val)),
  putAll: (st, vals) => tx(st, 'readwrite', (s) => { (vals || []).forEach((v) => s.put(v)); }),
  get: (st, key) => tx(st, 'readonly', (s) => s.get(key)),
  all: (st) => tx(st, 'readonly', (s) => s.getAll()),
  del: (st, key) => tx(st, 'readwrite', (s) => s.delete(key)),
  clear: (st) => tx(st, 'readwrite', (s) => s.clear()),
};

const idb = {
  async put(st, val) {
    try { await idbRaw.put(st, val); } catch (e) { /* IndexedDB 不可用则只走镜像 */ }
    lsPut(st, val);                       // 始终同步镜像（互为冗余）
  },
  async putAll(st, vals) {
    try { await idbRaw.putAll(st, vals); } catch (e) { /* 降级 */ }
    lsPutAll(st, vals);
  },
  async get(st, key) {
    try {
      const v = await idbRaw.get(st, key);
      if (v !== undefined) return v;
    } catch (e) { /* 降级 */ }
    return lsGet(st, key);
  },
  async all(st) {
    let list = [];
    try { list = (await idbRaw.all(st)) || []; } catch (e) { /* 降级 */ }
    const merged = new Map();
    lsAll(st).forEach((v) => merged.set(keyOf(v), v));
    list.forEach((v) => merged.set(keyOf(v), v));      // IndexedDB 优先
    const out = [...merged.values()];
    // 只在 localStorage 里的记录回填进 IndexedDB（自愈）
    const have = new Set(list.map(keyOf));
    const missing = out.filter((v) => !have.has(keyOf(v)));
    if (missing.length) { try { await idbRaw.putAll(st, missing); } catch (e) { /* 忽略 */ } }
    return out;
  },
  async del(st, key) {
    try { await idbRaw.del(st, key); } catch (e) { /* 降级 */ }
    lsDel(st, key);
  },
  async clear(st) {
    try { await idbRaw.clear(st); } catch (e) { /* 降级 */ }
    lsClear(st);
  },
};

const store = {
  get available() {
    try { return typeof indexedDB !== 'undefined'; } catch (e) { return false; }
  },
  put: (st, v) => idb.put(st, v),
  putAll: (st, vs) => idb.putAll(st, vs),
  get: (st, k) => idb.get(st, k),
  all: (st) => idb.all(st),
  del: (st, k) => idb.del(st, k),
  clear: (st) => idb.clear(st),
  uuid: uuid,
  localDateKey: localDateKey,
};

/* ---------------- 工具 ---------------- */

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** 本地日期（YYYY-MM-DD，按用户本地时区，不使用 UTC） */
function localDateKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function fmtDateCN(key) {
  const [y, m, d] = key.split('-');
  return `${y}年${+m}月${+d}日`;
}

function weekdayCN(key) {
  const [y, m, d] = key.split('-').map(Number);
  return '周' + '日一二三四五六'[new Date(y, m - 1, d).getDay()];
}

/* =========================================================
   Supabase 云端接入
   直接调用官方 REST API，不依赖任何第三方 CDN 脚本。
   原因：国内网络下 CDN 动态 import 常失败，会导致登录毫无反应。
   ========================================================= */

const SB = {
  url: '',
  key: '',
  token: null,       // 登录后的 access_token（约 1 小时过期）
  refresh: null,     // refresh_token（长期有效，用于静默续期）
  user: null,        // { id, email }
  base: '',          // '' = 直连 supabase.co；'/sb' = 走本机代理（手机/被拦网络用）
  netOk: true,       // 上次与服务器通信是否正常
  needsReauth: false, // 服务器明确拒绝凭据（需用户重新登录），但本地会话仍保留
};

/** 保存的配置 */
async function getSupabaseConfig() {
  const saved = await store.get('meta', 'sb_config');
  if (saved && saved.url && saved.key) return saved;
  // 回落到随文件携带的 supabase-config.js：换网址/换浏览器也能自动生效
  const d = (typeof window !== 'undefined') ? window.SB_DEFAULT_CFG : null;
  if (d && d.url && d.key) return { url: d.url, key: d.key, fromFile: true };
  return null;
}
async function saveSupabaseConfig(cfg) {
  await store.put('meta', { k: 'sb_config', url: cfg.url, key: cfg.key });
}

/** 校验配置格式 */
function normalizeConfig(cfg) {
  let url = (cfg && cfg.url ? String(cfg.url) : '').trim();
  if (!url) return { ok: false, msg: '请填写 Project URL' };
  // 去掉结尾斜杠、补全协议
  url = url.replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  const key = (cfg && cfg.key ? String(cfg.key) : '').trim();
  if (!key) return { ok: false, msg: '请填写 anon public key' };
  return { ok: true, url, key };
}

/**
 * 连通性测试：直接请求一个轻量接口，明确区分
 * 「配置错误」与「网络不通」——避免用户点了没反应却不知原因
 */
async function testConnection(url, key) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    // 与 sbFetch 保持一致：两个字段都带（新版 key 的要求）
    const res = await fetch(`${url}/auth/v1/settings`, {
      headers: { apikey: key, Authorization: 'Bearer ' + key },
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) {
      return { ok: false, msg: `密钥可能被拒绝（HTTP ${res.status}），请检查 anon key 是否填错` };
    }
    return { ok: true, msg: '连接正常' };
  } catch (e) {
    const aborted = e && (e.name === 'AbortError' || String(e.message).includes('abort'));
    return {
      ok: false,
      msg: aborted
        ? '连接超时（8 秒）。该 Supabase 域名在当前网络下不可达，通常是国内网络限制所致'
        : '无法连接到该地址。请检查 URL 是否正确，或换个网络环境试试',
    };
  }
}

async function initSupabase(cfg) {
  const n = normalizeConfig(cfg);
  if (!n.ok) throw new Error(n.msg);

  // 先落配置，再探测：代理探测（detectProxy）依赖 SB.url / SB.key 已就位。
  // 否则「直连被拦 + 本机有代理」的网络（手机经电脑转发）会误判为不可用。
  SB.url = n.url;
  SB.key = n.key;

  // 先看本机是否存有登录会话：有的话即使当前网络不通，
  // 也要继续恢复会话（离线保持登录），不能因为一次探测失败就退成未登录
  let savedSession = null;
  try { savedSession = await store.get('meta', 'sb_session'); } catch (e) { /* 忽略 */ }
  const hasSaved = !!(savedSession && savedSession.token);

  const health = await testConnection(n.url, n.key);
  // 探测本机代理（server.js 提供 /sb/* 反向转发）：
  // 手机等直连 supabase.co 被拦的网络，通过电脑中转即可使用云端
  SB.base = await detectProxy(n);
  // 直连不通、本机又没有可用代理、且没有可恢复的会话 —— 这才判定为不可用
  if (!health.ok && !SB.base && !hasSaved) throw new Error(health.msg);

  // 恢复已有登录态：access_token 约 1 小时过期，
  // 过期后用 refresh_token 换新，而不是让用户重新输密码
  const saved = await store.get('meta', 'sb_session');
  if (saved && saved.token) {
    SB.token = saved.token;
    SB.refresh = saved.refresh || null;
    SB.user = saved.user || null;         // 先信任本地会话
    SB.needsReauth = false;

    /* 铁律：绝不自动登出本地会话。
       即使服务器返回 401 / 凭据错误，也只标记需要重新登录，
       用户在联网状态下点「重新登录」即可；
       否则网络波动、代理故障都会把人踢出去（这正是之前的 bug）。 */

    /** 是否确属「凭据被服务器拒绝」（严格匹配，避免把网络/404 误判） */
    const isRejected = (msg) => {
      const m = String(msg || '').toLowerCase();
      return /invalid login|invalid jwt|jwt expired|token is expired|refresh token|invalid_grant|invalid credentials|用户不存在|user not found|session.*not found|unauthorized|email not confirmed/i.test(m);
    };

    try {
      const me = await sbMe();
      if (me && me.id) { SB.user = me; SB.netOk = true; return SB; }
    } catch (e) {
      if (isRejected(e && e.message)) SB.needsReauth = true;
      else SB.netOk = false;
      return SB;                          // 无论哪种，都保留会话
    }

    if (SB.refresh) {
      try {
        const u = await sbRefresh();
        if (u && u.id) { SB.user = u; SB.netOk = true; SB.needsReauth = false; return SB; }
      } catch (e2) {
        if (isRejected(e2 && e2.message)) SB.needsReauth = true;
        else SB.netOk = false;
      }
    }
    return SB;                            // 保留本地会话，等用户联网后自动恢复
  }
  return SB;
}

/**
 * 探测「本机代理」是否真的存在（server.js 提供的 /sb/* 反代）。
 *
 * 教训：静态托管站（如 CloudStudio/Vercel）会把**未知路径回退成 index.html 并返回 200**，
 * 所以绝不能只看状态码 —— 之前就是因此误判，导致线上站点把登录请求发到静态网页上，
 * 表现为「登录看起来成功、但什么数据都没有」（手机看不到成绩的真正原因）。
 * 现在必须同时满足：Content-Type 是 JSON、内容能解析成对象、且像 Supabase 的响应。
 */
async function detectProxy(n) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 3500);
    const pr = await fetch('/sb/auth/v1/health', {
      signal: c.signal,
      headers: { Accept: 'application/json', apikey: n.key, Authorization: 'Bearer ' + n.key },
    });
    clearTimeout(t);
    const ct = String(pr.headers.get('content-type') || '').toLowerCase();
    if (ct.indexOf('application/json') < 0) return '';      // HTML/文本 ⇒ 不是代理
    let d = null;
    try { d = JSON.parse(await pr.text()); } catch (e) { return ''; }
    if (!d || typeof d !== 'object' || Array.isArray(d)) return '';
    // Supabase GoTrue 的 health 形如 { version, name, description }
    if (d.version || d.name || d.description) return '/sb';
    if (pr.status === 401) return '/sb';                    // 缺 key 时上游会 401（JSON）
    return '';
  } catch (e) {
    return '';                                              // 没有代理 → 直连 Supabase
  }
}

/** 本机是否保存过登录会话（无论当前网络能否验证） */
async function hasSavedSession() {
  try {
    const saved = await store.get('meta', 'sb_session');
    return !!(saved && saved.token);
  } catch (e) { return false; }
}

/** 用 refresh_token 换新的 access_token（ Supabase 官方端点） */
let _refreshing = null;
async function sbRefresh() {
  if (!SB.refresh) throw new Error('没有 refresh_token');
  if (_refreshing) return _refreshing;          // 并发调用复用同一次刷新
  _refreshing = (async () => {
    try { return await _doRefresh(); } finally { _refreshing = null; }
  })();
  return _refreshing;
}

async function _doRefresh() {
  const d = await sbFetch('/auth/v1/token?grant_type=refresh_token', {
    method: 'POST',
    body: { refresh_token: SB.refresh },
  });
  if (!d || !d.access_token) throw new Error('续期失败');
  SB.token = d.access_token;
  SB.refresh = d.refresh_token || SB.refresh;
  SB.user = d.user ? { id: d.user.id, email: d.user.email } : SB.user;
  await store.put('meta', { k: 'sb_session', token: SB.token, refresh: SB.refresh, user: SB.user });
  return SB.user;
}

/** 底层请求封装（401 且 token 过期时自动用 refresh_token 续期并重试一次） */
async function sbFetch(path, opts = {}, _retried) {
  if (!SB.url || !SB.key) throw new Error('尚未配置 Supabase');
  // Supabase 新版 API key（sb_publishable_ 开头）要求 apikey 与
  // Authorization 两个字段同时存在；未登录时用 publishable key本身
  // 充当 Bearer（与官方 supabase-js 的行为一致），否则会 401。
  const headers = {
    apikey: SB.key,
    Authorization: 'Bearer ' + (SB.token || SB.key),
    'Content-Type': 'application/json',
  };

  const MAX_TRY = 3;            // 网络抖动时最多尝试 3 次
  let lastErr = null;

  for (let attempt = 1; attempt <= MAX_TRY; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25000);
    try {
      const res = await fetch(`${SB.base || SB.url}${path}`, {
        method: opts.method || 'GET',
        headers: Object.assign(headers, opts.headers || {}),
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        signal: ctrl.signal,
      });
      clearTimeout(timer);

      let data = null;
      const text = await res.text();
      const ctype = String(res.headers.get('content-type') || '').toLowerCase();
      if (text) { try { data = JSON.parse(text); } catch (e) { data = text; } }

      // 关键防线：请求成功但返回的不是 JSON（例如被静态站点的 HTML 页面接管），
      // 必须报错，绝不能让上层误以为“调用成功”
      if (res.ok && text && ctype.indexOf('application/json') < 0) {
        throw new Error('接口返回的不是数据（Content-Type: ' + (ctype || '未知') + '），请求可能被网页接管，请检查访问地址');
      }

      if (!res.ok) {
        const detail = (data && (data.error_description || data.msg || data.message || data.error))
          || (typeof data === 'string' ? data.slice(0, 120) : '');
        // access_token 过期：用 refresh_token 续期后重试一次
        // 注意：续期请求自身 401 时绝不能再走这里，否则递归刷新会死循环
        const isRefreshCall = String(path).indexOf('grant_type=refresh_token') >= 0;
        if (res.status === 401 && !_retried && SB.refresh && !isRefreshCall
            && /jwt|expired|invalid|token/i.test(detail)) {
          try { await sbRefresh(); } catch (e) { /* 续期失败，按原错误抛出 */ }
          return sbFetch(path, opts, true);
        }
        // 5xx 与 429 属于服务端/限流，值得重试
        if ((res.status >= 500 || res.status === 429) && attempt < MAX_TRY) {
          lastErr = new Error(mapAuthError(detail || `HTTP ${res.status}`));
          await sleep(500 * attempt);
          continue;
        }
        throw new Error(mapAuthError(detail || `HTTP ${res.status}`));
      }
      return data;
    } catch (e) {
      clearTimeout(timer);
      if (e instanceof Error && e.message.indexOf('HTTP') === 0) throw e;  // 业务错误不重试
      const isNet = (e && (e.name === 'AbortError' || String(e.message).includes('abort')))
        || e instanceof TypeError;
      if (!isNet) throw e;
      lastErr = new Error(e.name === 'AbortError' || String(e.message).includes('abort')
        ? '请求超时，请检查网络'
        : '网络不可达，请检查网络连接或换个网络环境');
      if (attempt < MAX_TRY) { await sleep(600 * attempt); continue; }
      throw lastErr;
    }
  }
  throw lastErr || new Error('网络错误');
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** 获取当前登录用户 */
async function sbMe() {
  if (!SB.token) return null;
  const d = await sbFetch('/auth/v1/user');
  return d && d.id ? { id: d.id, email: d.email } : null;
}

/* ---------------- 账号 ---------------- */

async function signUp(email, password) {
  const d = await sbFetch('/auth/v1/signup', {
    method: 'POST',
    body: { email, password },
  });
  if (!d || typeof d !== 'object') {
    throw new Error('注册未完成：服务器返回异常，请检查网络或稍后重试');
  }
  // 若开启了邮箱验证，这里不会返回 session
  if (d && d.access_token) {
    SB.token = d.access_token;
    SB.refresh = d.refresh_token || null;
    SB.user = { id: d.user.id, email: d.user.email };
    await store.put('meta', { k: 'sb_session', token: SB.token, refresh: SB.refresh, user: SB.user });
    return { needLogin: false, user: SB.user };
  }
  return { needLogin: true, user: null };
}

async function signIn(email, password) {
  const d = await sbFetch('/auth/v1/token?grant_type=password', {
    method: 'POST',
    body: { email, password },
  });
  // 必须真的拿到登录凭据，否则视为失败（避免“看起来登录成功”却什么都没发生）
  if (!d || typeof d !== 'object' || !d.access_token || !d.user) {
    throw new Error('登录未完成：服务器没有返回登录凭据，请检查网络或稍后重试');
  }
  SB.token = d.access_token;
  SB.refresh = d.refresh_token || null;
  SB.user = { id: d.user.id, email: d.user.email };
  await store.put('meta', { k: 'sb_session', token: SB.token, refresh: SB.refresh, user: SB.user });
  return { user: SB.user };
}

async function signOut() {
  try { if (SB.token) await sbFetch('/auth/v1/logout', { method: 'POST' }); } catch (e) { /* 忽略 */ }
  SB.token = null; SB.refresh = null; SB.user = null;
  await store.del('meta', 'sb_session');
}

function mapAuthError(msg) {
  const m = (msg || '').toLowerCase();
  if (!m) return '操作失败';
  if (m.includes('already registered') || m.includes('already been registered')) return '该邮箱已注册，请直接登录';
  if (m.includes('invalid login') || m.includes('invalid credentials')) return '邮箱或密码错误';
  if (m.includes('email not confirmed')) return '邮箱尚未验证，请到邮箱点击验证链接';
  if (m.includes('password should be') || m.includes('at least 6')) return '密码至少需要 6 位';
  if (m.includes('unable to validate email') || m.includes('invalid email')) return '邮箱格式不正确';
  if (m.includes('rate limit') || m.includes('too many')) return '操作过于频繁，请稍后再试';
  if (m.includes('fetch') || m.includes('network') || m.includes('failed')) return '网络连接失败，请检查网络';
  return msg;
}

/** 当前登录用户 id（未登录返回 null） */
async function currentUserId() {
  return SB.user ? SB.user.id : null;
}

/* ---------------- 同步诊断 ----------------
   过去所有同步失败都被 .catch(() => {}) 吃掉，导致「成绩没上传」这类问题
   完全没有提示，排查起来毫无线索。现在失败会记录并通知界面。 */

let _syncErrHook = null;
let _lastSyncError = '';

/** 注册同步失败回调（由 app.js 注入，用于界面提示） */
function onSyncError(fn) { _syncErrHook = fn; }
function lastSyncError() { return _lastSyncError; }

function reportSyncError(e) {
  const msg = (e && e.message) ? e.message : String(e || '未知错误');
  _lastSyncError = msg;
  try { if (_syncErrHook) _syncErrHook(msg); } catch (x) { /* 忽略 */ }
  return msg;
}

/** 手动同步：先补传本机未上传的，再拉取云端数据，返回 {pushed, pulled} */
async function syncNow() {
  const uid = await currentUserId();
  if (!uid) return { pushed: 0, pulled: 0, total: 0, pending: 0, error: '未登录' };
  const all = await repairBadIds();
  const pending = all.filter((r) => !r.synced).length;
  try {
    await flushPendingDeletes();
    const pushed = await flushPending();
    const pulled = await pullFromCloud();
    const err = _lastSyncError;
    if (!err) _lastSyncError = '';
    return { pushed, pulled, total: all.length, pending, err };
  } catch (e) {
    return { pushed: 0, pulled: 0, total: all.length, pending, error: reportSyncError(e) };
  }
}

/** 修复历史遗留的非法 client_id / session_id（早期版本用过时间戳），
    就地换发合法 UUID，保证这些老成绩也能上传，而不是整批失败。 */
async function repairBadIds() {
  const all = await store.all('solves');
  let fixed = 0;
  for (const r of all) {
    if (!isUuid(r.client_id) || (r.session_id && !isUuid(r.session_id))) {
      const oldId = r.client_id;
      const rec = Object.assign({}, r, {
        client_id: isUuid(r.client_id) ? r.client_id : uuid(),
        session_id: r.session_id && !isUuid(r.session_id) ? null : r.session_id,
      });
      if (oldId !== rec.client_id) await store.del('solves', oldId);
      await store.put('solves', rec);
      fixed++;
    }
  }
  if (fixed) {
    console.warn('[CubeTimer] 已修复 ' + fixed + ' 条非法 ID 记录');
  }
  return store.all('solves');
}

/** 全量重新上传：把所有本机成绩标记为未同步再传一遍。
    用于「曾经上传失败但被标记为已同步」或换账号后的补救；
    走 upsert 按client_id 去重，重复执行不会产生重复数据。 */
async function forcePushAll() {
  const uid = await currentUserId();
  if (!uid) return { pushed: 0, pulled: 0, total: 0, error: '未登录' };
  const all = (await repairBadIds()).filter((r) => ownOf(r) === LOCAL_OWNER || ownOf(r) === uid);
  for (const r of all) await store.put('solves', { ...r, synced: false });
  try {
    await flushPendingDeletes();
    const pushed = await flushPending();
    const pulled = await pullFromCloud();
    return { pushed, pulled, total: all.length, err: _lastSyncError };
  } catch (e) {
    return { pushed: 0, pulled: 0, total: all.length, error: reportSyncError(e) };
  }
}

/* ---------------- 同步 ---------------- */

const BATCH = 200;

/** 严格校验是否为合法 UUID（防止把时间戳之类写进 uuid 列导致整批上传失败） */
function isUuid(v) {
  return typeof v === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}
/** 非法 uuid 一律转成 null，避免整批 400 */
function safeUuid(v) { return isUuid(v) ? v : null; }

/** 把一条记录转成数据库行 */
function toRow(r, userId) {
  return {
    client_id: safeUuid(r.client_id),
    user_id: safeUuid(userId),
    event: r.event || '3x3',
    scramble: r.scramble,
    time_ms: r.time_ms,
    penalty: r.penalty || 0,
    inspection_penalty: r.inspection_penalty || 0,
    dnf: !!r.dnf,
    session_id: safeUuid(r.session_id),
    device: r.device || '',
    created_at: new Date(r.created_at).toISOString(),
  };
}

/**
 * 登录后把本地数据迁移到云端。
 * 用 upsert + onConflict 做幂等，重复调用不会产生重复数据。
 */
async function migrateLocalToCloud(userId) {
  /* 关键顺序：**先在本地打上归属，再上传**。
     之前是先上传成功才标记归属 —— 一旦网络连不上 Supabase（国内网络常见），
     本机成绩永远不会被标记，于是「退出登录后仍能看到」，看起来像 bug。
     现在归属是纯本地操作，离线也立即生效；上传失败只是留待下次补传。 */
  const claimed = await claimLocalRecords(userId);
  let pushed = 0;
  try { pushed = await flushPending(); } catch (e) { reportSyncError(e); }
  return claimed || pushed;
}

const PULL_LIMIT = 2000;

/**
 * 拉取云端数据并与本地对账（**云端为准**）。
 * 除了「补上云端新增的」，还会「删掉云端已经不存在的」——
 * 这是「在电脑删除后，手机登录仍能看到」的修复点：
 * 之前只做加法不做减法，被删的记录会永远留在其他设备的本地库里。
 * 返回新增条数（清理掉的条数记在 .removed 上，见 pullLastResult）。
 */
let pullLastResult = { added: 0, removed: 0 };

async function pullFromCloud() {
  if (!SB.user) return 0;
  const uid = SB.user.id;
  const data = await sbFetch(`/rest/v1/solves?select=*&order=created_at.desc&limit=${PULL_LIMIT}`);
  const rows = Array.isArray(data) ? data : [];

  const localAll = await store.all('solves');
  const localIds = new Set(localAll.map((r) => r.client_id));
  const del = await pendingDeleteIds();

  // ---- 加法：云端有、本地没有的 ----
  const fresh = [];
  const cloudIds = new Set();
  for (const r of rows) {
    if (!r.client_id) continue;
    cloudIds.add(r.client_id);
    if (del.has(r.client_id)) continue;         // 我已删过，别拉回来
    if (localIds.has(r.client_id)) continue;
    fresh.push({
      client_id: r.client_id,
      event: r.event,
      scramble: r.scramble,
      time_ms: r.time_ms,
      penalty: r.penalty,
      inspection_penalty: r.inspection_penalty,
      dnf: r.dnf,
      session_id: r.session_id,
      created_at: new Date(r.created_at).getTime(),
      date_key: localDateKey(new Date(r.created_at)),
      owner: uid,                              // 云端记录归当前账号所有
      synced: true,
      device: r.device || '',
    });
  }
  if (fresh.length) await store.putAll('solves', fresh);

  // ---- 减法：本账号、已同步、但云端已不存在 → 说明在别的设备被删了 ----
  let removed = 0;
  const complete = rows.length < PULL_LIMIT;    // 拿全了才敢做删除对账
  if (complete) {
    for (const r of localAll) {
      if (ownOf(r) !== uid) continue;           // 不是本账号的不动
      if (!r.synced) continue;                  // 尚未上传的新成绩不动
      if (cloudIds.has(r.client_id)) continue;  // 云端还有，保留
      await store.del('solves', r.client_id);
      removed++;
    }
    if (removed) await refreshBackup();
  }

  pullLastResult = { added: fresh.length, removed: removed };
  return fresh.length;
}

/** 单条成绩静默上传（失败不影响使用，下一轮或下次登录会补传） */
async function uploadOne(rec, userId) {
  if (!SB.token || !userId) return false;
  try {
    await sbFetch('/rest/v1/solves?on_conflict=client_id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: [toRow(rec, userId)],
    });
    await store.put('solves', { ...rec, owner: userId, synced: true });
    return true;
  } catch (e) {
    return false;
  }
}

/** 批量补传未同步记录 */
async function flushPending() {
  const uid = await currentUserId();
  if (!uid) return 0;
  const all = await store.all('solves');
  // 只补传「未归属」或「属于当前账号」的记录，避免把别的账号数据传上去
  const pending = all.filter((r) => !r.synced && (ownOf(r) === LOCAL_OWNER || ownOf(r) === uid));
  if (!pending.length) return 0;
  let n = 0;
  for (let i = 0; i < pending.length; i += BATCH) {
    const slice = pending.slice(i, i + BATCH);
    try {
      await sbFetch('/rest/v1/solves?on_conflict=client_id', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: slice.map((r) => toRow(r, uid)),
      });
      for (const r of slice) { await store.put('solves', { ...r, owner: uid, synced: true }); n++; }
    } catch (e) { reportSyncError(e); break; }
  }
  return n;
}

/** 删除云端记录（本地已删，这里同步删） */
async function deleteFromCloud(clientId) {
  if (!SB.token) throw new Error('未登录，无法删除云端记录');
  // 不吞错误：调用方需要知道是否成功，失败要进墓碑队列重试
  await sbFetch(`/rest/v1/solves?client_id=eq.${encodeURIComponent(clientId)}`, { method: 'DELETE' });
}


/* =========================================================
   成绩记录 API
   ========================================================= */

/**
 * 保存一条成绩
 * @param {object} o {event, scramble, timeMs, penalty, inspectionPenalty, dnf, sessionId}
 */
/* ---------------- 本机备份（防数据丢失） ----------------
   IndexedDB 与 localStorage 互为冗余：任一被清空，都还能从另一处恢复。
   每次保存/删除成绩后同步刷新备份。 */

const BACKUP_KEY = 'ct_solves_backup';

function readBackup() {
  try {
    const raw = localStorage.getItem(BACKUP_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch (e) { return []; }
}

function writeBackup(list) {
  try { localStorage.setItem(BACKUP_KEY, JSON.stringify(list || [])); } catch (e) { /* 超限忽略 */ }
}

/** 把当前库里的成绩刷进备份 */
async function refreshBackup() {
  try { writeBackup(await store.all('solves')); } catch (e) { /* 忽略 */ }
}

/** 本机备份条数 */
function backupCount() { return readBackup().length; }

/** 主存储为空但备份里有数据时，自动恢复（返回恢复条数） */
async function recoverIfEmpty() {
  try {
    const cur = await store.all('solves');
    if (cur.length) return 0;
    const bk = readBackup();
    if (!bk.length) return 0;
    const del = await pendingDeleteIds();
    const use = bk.filter((r) => r && r.client_id && !del.has(r.client_id));
    if (!use.length) return 0;
    await store.putAll('solves', use);
    return use.length;
  } catch (e) { return 0; }
}

/**
 * 清空本机成绩：主存储与「防丢失备份」必须一起清。
 * 只清主存储的话，recoverIfEmpty() 会在下次打开页面时把备份原样灌回来，
 * 表现为「点了清空、刷新一下成绩又全回来了」。
 * 注意：这里只动本机数据，云端记录不受影响（不产生删除任务/墓碑）。
 */
async function clearLocalSolves() {
  await store.clear('solves');
  writeBackup([]);
  try { localStorage.removeItem(BACKUP_KEY); } catch (e) { /* 忽略 */ }
}

/** 手动从备份恢复（合并，按 client_id 去重，不覆盖现有数据） */
async function restoreFromBackup() {
  const bk = readBackup();
  if (!bk.length) return 0;
  const cur = await store.all('solves');
  const have = new Set(cur.map((r) => r.client_id));
  const del = await pendingDeleteIds();
  const add = bk.filter((r) => r && r.client_id && !have.has(r.client_id) && !del.has(r.client_id));
  if (!add.length) return 0;
  await store.putAll('solves', add);
  return add.length;
}

/** 把外部 JSON 备份转换成受控记录，拒绝畸形时间和未知项目。 */
function sanitizeImportedSolve(item) {
  if (!item || typeof item !== 'object') return null;
  const time = Number(item.time_ms);
  if (!Number.isFinite(time) || time < 0 || time > 86400000) return null;

  const rawCreated = typeof item.created_at === 'number'
    ? item.created_at
    : Date.parse(item.created_at);
  const created_at = Number.isFinite(rawCreated) ? rawCreated : Date.now();
  const event = ['3x3', '2x2', '4x4', 'OH'].includes(item.event) ? item.event : '3x3';
  const rawPenalty = Math.max(0, Math.min(60, Number(item.penalty) || 0));
  const penalty = Math.round(rawPenalty / 2) * 2;
  const rawInspection = Number(item.inspection_penalty) || 0;
  const inspection_penalty = rawInspection === 2 ? 2 : 0;
  const dnf = item.dnf === true || item.dnf === 'YES';

  return {
    client_id: isUuid(item.client_id) ? item.client_id : uuid(),
    event,
    scramble: typeof item.scramble === 'string' ? item.scramble.slice(0, 500) : '',
    time_ms: Math.round(time),
    penalty: dnf ? 0 : penalty,
    inspection_penalty: dnf ? 0 : inspection_penalty,
    dnf,
    session_id: isUuid(item.session_id) ? item.session_id : null,
    created_at,
    date_key: localDateKey(new Date(created_at)),
    device: 'JSON 导入',
    owner: currentOwner(),
    synced: false,
  };
}

/**
 * 导入 JSON 备份（兼容 CubeTimer 导出对象和纯数组）。
 * 相同 client_id 会合并更新；若与当前账号归属不同则换发新 ID，避免跨账号覆盖。
 */
async function importSolveData(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error('JSON 格式不正确');
  }
  const rows = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.solves) ? parsed.solves : null);
  if (!rows) throw new Error('没有找到 solves 成绩数组');
  if (rows.length > 20000) throw new Error('一次最多导入 20000 条成绩');

  const before = await store.all('solves');
  const existing = new Map(before.map((r) => [r.client_id, r]));
  const records = [];
  let added = 0;
  let updated = 0;

  for (const item of rows) {
    const rec = sanitizeImportedSolve(item);
    if (!rec) continue;
    const old = existing.get(rec.client_id);
    if (old && ownOf(old) !== rec.owner) {
      rec.client_id = uuid();
      added++;
    } else if (old) {
      updated++;
    } else {
      added++;
    }
    existing.set(rec.client_id, rec);
    records.push(rec);
  }
  if (!records.length) throw new Error('没有可导入的有效成绩');

  await store.putAll('solves', records);
  await refreshBackup();
  return { added, updated, total: records.length };
}

async function saveSolve(o) {
  const rec = {
    client_id: uuid(),
    event: o.event || '3x3',
    scramble: o.scramble,
    time_ms: o.timeMs,
    penalty: o.penalty || 0,
    inspection_penalty: o.inspectionPenalty || 0,
    dnf: !!o.dnf,
    session_id: o.sessionId || null,
    created_at: Date.now(),
    date_key: localDateKey(),
    device: navigator.userAgent.slice(0, 80),
    owner: currentOwner(),      // 归属当前账号；未登录则为 ''（本机）
    synced: false,
  };
  await store.put('solves', rec);

  await refreshBackup();      // 本机备份（与主存储互为冗余）

  // 后台静默上传，失败不影响使用
  const uid = await currentUserId();
  void 0;
  if (uid) uploadOne(rec, uid).catch((e) => reportSyncError(e));
  return rec;
}

async function deleteSolve(clientId) {
  const before = await store.get('solves', clientId);
  await store.del('solves', clientId);
  await refreshBackup();

  const owner = before ? ownOf(before) : '';
  // 未归属的本机成绩没有云端副本，删掉即可
  if (owner === LOCAL_OWNER) return;

  /* 有归属的记录必须把删除传达到云端，否则其他设备仍会看到它。
     以下两种情况都要先记墓碑：
       · 当前未登录（或登录的是别的账号）→ 等该账号登录后再删
       · 已登录但请求失败（网络问题）→ 下次同步重试 */
  const uid = await currentUserId();
  if (uid && owner === uid) {
    try { await deleteFromCloud(clientId); return; }
    catch (e) { reportSyncError(e); }
  }
  await addPendingDelete(owner, clientId);
}

async function allSolves() {
  const list = await store.all('solves');
  return list.sort((a, b) => b.created_at - a.created_at);
}

/* ---------------- 账号归属（数据隔离） ----------------
   每条成绩带 owner 字段：
     ''  → 未归属账号的本机成绩（未登录时记录的）
     uid → 归属某个账号（云端拉下来的 / 登录后归属过去的）
   展示与上传都按 owner 过滤，解决两个问题：
     · 未登录（或换账号）时不再看到别的账号的成绩
     · A 账号的本机数据不会被上传到 B 账号名下
   owner 缺省视为「本机未归属」，兼容旧数据。 */

const LOCAL_OWNER = '';
function ownOf(r) { return (r && r.owner) ? r.owner : LOCAL_OWNER; }
function currentOwner() { return SB.user ? SB.user.id : LOCAL_OWNER; }

/** 当前登录状态下应当显示的成绩（未登录时只显示未归属的本机成绩） */
async function visibleSolves() {
  const uid = SB.user ? SB.user.id : null;
  const all = await store.all('solves');
  const list = all.filter((r) => {
    const o = ownOf(r);
    if (o === LOCAL_OWNER) return true;        // 本机未归属：始终可见
    return !!uid && o === uid;                  // 归属账号：仅该账号登录时可见
  });
  return list.sort((a, b) => b.created_at - a.created_at);
}

/** 有多少条成绩归属「其他账号」（用于未登录/换账号时的提示） */
async function countOtherOwned() {
  const uid = SB.user ? SB.user.id : null;
  const all = await store.all('solves');
  let n = 0;
  for (const r of all) { const o = ownOf(r); if (o !== LOCAL_OWNER && o !== uid) n++; }
  return n;
}

/* ---------------- 删除传播（墓碑队列） ----------------
   删除必须能传达到其他设备。做法：
     · 本地先删，同时把 client_id 记进「待删除队列」
     · 云端删除成功后从队列移除；失败则留待下次同步重试
     · pullFromCloud 遇到队列里的 id 一律不拉回来（否则会“复活”）
   队列存在 meta 存储里，不需要改数据库结构。 */

const PENDING_DEL_KEY = 'pending_deletes';

async function readPendingDeletes() {
  try {
    const rec = await store.get('meta', PENDING_DEL_KEY);
    const list = rec && Array.isArray(rec.list) ? rec.list : [];
    return list.filter((x) => x && x.clientId && x.owner);
  } catch (e) { return []; }
}

async function writePendingDeletes(list) {
  try { await store.put('meta', { k: PENDING_DEL_KEY, list: list }); } catch (e) { /* 忽略 */ }
}

async function addPendingDelete(owner, clientId) {
  const list = await readPendingDeletes();
  if (list.some((x) => x.clientId === clientId)) return;
  list.push({ owner: owner, clientId: clientId, at: Date.now() });
  await writePendingDeletes(list);
}

/** 队列里属于当前账号的 id 集合（用于阻止“复活”） */
async function pendingDeleteIds() {
  const uid = SB.user ? SB.user.id : null;
  const list = await readPendingDeletes();
  const set = new Set();
  for (const x of list) if (uid && x.owner === uid) set.add(x.clientId);
  return set;
}

/** 重试云端删除；返回成功条数 */
async function flushPendingDeletes() {
  const uid = await currentUserId();
  if (!uid || !SB.token) return 0;
  const list = await readPendingDeletes();
  if (!list.length) return 0;
  const keep = [];
  let n = 0;
  for (const it of list) {
    if (it.owner !== uid) { keep.push(it); continue; }   // 别的账号的，等它登录再处理
    try {
      await deleteFromCloud(it.clientId);
      n++;
    } catch (e) { keep.push(it); reportSyncError(e); break; }
  }
  if (n) await writePendingDeletes(keep);
  return n;
}

/** 云端该账号有多少条成绩（用于诊断「手机上为什么看不到」） */
async function cloudCount() {
  if (!SB.user) return null;
  try {
    const rows = await sbFetch('/rest/v1/solves?select=client_id&limit=5000');
    if (!Array.isArray(rows)) return null;
    return rows.length;
  } catch (e) { reportSyncError(e); return null; }
}

/** 归属统计：用于界面说明「未登录时看到的是哪些成绩」 */
async function ownerStats() {
  const uid = SB.user ? SB.user.id : null;
  const all = await store.all('solves');
  let unowned = 0, mine = 0, others = 0;
  for (const r of all) {
    const o = ownOf(r);
    if (o === LOCAL_OWNER) unowned++;
    else if (uid && o === uid) mine++;
    else others++;
  }
  return { total: all.length, unowned: unowned, mine: mine, others: others, loggedIn: !!uid };
}

/** 把未归属的本机成绩标记为属于指定账号（登录时调用） */
async function claimLocalRecords(uid) {
  const all = await store.all('solves');
  const mine = all.filter((r) => ownOf(r) === LOCAL_OWNER);
  if (!mine.length) return 0;
  await store.putAll('solves', mine.map((r) => Object.assign({}, r, { owner: uid })));
  return mine.length;
}

/* =========================================================
   统计
   ========================================================= */

/** 单把成绩的最终显示时间（毫秒），DNF 返回 null */
function effectiveMs(s) {
  if (s.dnf) return null;
  return s.time_ms + (s.penalty || 0) * 1000 + (s.inspection_penalty || 0) * 1000;
}

function fmtTime(ms) {
  if (ms == null) return 'DNF';
  const t = ms / 1000;
  if (t < 60) return t.toFixed(2);
  const m = Math.floor(t / 60);
  return `${m}:${(t - m * 60).toFixed(2).padStart(5, '0')}`;
}

/**
 * 计算一组成绩的统计量
 * 支持：
 *   best      最快
 *   worst     最慢
 *   mean      全部平均（不去极值）
 *   trimmed   去掉最快最慢后的平均
 *   count     有效成绩数
 *   dnfCount  DNF 次数
 */
function statsOf(solves) {
  const valid = solves.map(effectiveMs).filter((x) => x != null);
  const sorted = valid.slice().sort((a, b) => a - b);
  const dnfCount = solves.filter((s) => s.dnf).length;
  const out = {
    count: valid.length,
    dnfCount,
    total: solves.length,
    best: sorted[0] ?? null,
    worst: sorted[sorted.length - 1] ?? null,
    mean: null,
    trimmed: null,
  };
  if (valid.length) out.mean = Math.round(valid.reduce((a, b) => a + b, 0) / valid.length);
  if (sorted.length >= 3) {
    const mid = sorted.slice(1, -1);
    out.trimmed = Math.round(mid.reduce((a, b) => a + b, 0) / mid.length);
  }
  return out;
}

/** 计算一个固定长度窗口的 WCA Average：去掉最快、最慢后取中间值。
    最多允许一个 DNF；DNF 视为最慢并被剔除，两个及以上 DNF 返回 null。 */
function averageOfWindow(window) {
  if (!window || window.length < 3) return null;
  const values = window.map((s) => effectiveMs(s));
  const invalidCount = values.filter((v) => v == null || !Number.isFinite(v)).length;
  if (invalidCount > 1) return null;
  const sorted = values
    .map((v) => (v == null || !Number.isFinite(v) ? Infinity : v))
    .sort((a, b) => a - b);
  const middle = sorted.slice(1, -1).filter((v) => Number.isFinite(v));
  if (middle.length !== window.length - 2 || !middle.length) return null;
  return Math.round(middle.reduce((a, b) => a + b, 0) / middle.length);
}

/** 返回最近 n 把的滚动平均；顺序按时间正序，不受调用方排序影响。 */
function rollingAverage(solves, n) {
  const list = (solves || []).slice().sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
  if (list.length < n) return null;
  return averageOfWindow(list.slice(-n));
}

/** 返回历史所有完整窗口中的最佳滚动平均。 */
function bestRollingAverage(solves, n) {
  const list = (solves || []).slice().sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
  if (list.length < n) return null;
  let best = null;
  for (let i = 0; i <= list.length - n; i++) {
    const avg = averageOfWindow(list.slice(i, i + n));
    if (avg != null && (best == null || avg < best)) best = avg;
  }
  return best;
}

/**
 * Bo5 / Bo10 一次赛制结果
 *
 * WCA 赛制规则：
 *   - 做满 N 次后取最快一次（Bo）
 *   - 若出现 DNF，有效成绩不足 N 次，则本轮成绩作废，需额外补一次（re-solve）
 *
 * 返回：
 *   bo          本轮成绩（最快一次），未完成时为 null
 *   needExtra   是否需要补转
 *   complete    是否已完成（有效成绩已达 N 次）
 */
function boResult(solves, n) {
  const valid = solves.filter((s) => !s.dnf);
  const dnfCount = solves.length - valid.length;
  const st = statsOf(valid);

  // 有效成绩满 N 次才算本轮完成；否则需补转
  const complete = valid.length >= n;
  const needExtra = !complete;

  return {
    n,
    bo: complete ? st.best : null,
    best: st.best,
    worst: st.worst,
    mean: st.mean,
    trimmed: st.trimmed,
    count: valid.length,
    dnfCount,
    needExtra,
    complete,
  };
}

/** 按日期分组（精确到天） */
function groupByDate(solves) {
  const m = new Map();
  for (const s of solves) {
    const k = s.date_key || localDateKey(new Date(s.created_at));
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(s);
  }
  return [...m.entries()].sort((a, b) => b[0].localeCompare(a[0]))
    .map(([date, list]) => ({ date, list, stats: statsOf(list) }));
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    genScramble, scrambleFor, EVENTS, applyScramble, solvedCubeState,
    scrambleTooSimple, scrambledPieceCount,
    localDateKey, fmtDateCN, weekdayCN, uuid,
    saveSolve, deleteSolve, allSolves, statsOf, boResult, groupByDate,
    averageOfWindow, rollingAverage, bestRollingAverage,
    fmtTime, effectiveMs,
  };
}
