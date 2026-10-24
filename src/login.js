'use strict';
/**
 * 本校 订场系统 —— 自动登录 / token 自动续期
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  核心发现（2026-10-10 实测，见登录协议的实测结论）
 * ══════════════════════════════════════════════════════════════════════════
 *  POST {prefix}/phone/login/idSerialLogin
 *      data = { idserial: "<学号明文>", token: "", pageType: "" }
 *   →  {"success":true,"resultData":{"token":"<JWT>","code":"<学号>",
 *                                    "name":"<姓名>","type":"1","tel":"..."}}
 *
 *  实测的鉴权语义（登录鉴权矩阵探测脚本 全量矩阵）：
 *    不带 token 字段 / token="" / token=<真 JWT>  → ✅ 换发成功
 *    token="BOGUS_TOKEN"                          → ❌ 「登陆异常！」
 *    idserial 前后带空格                          → ❌ 「获取人员信息失败」
 *    连续 3 次换发（0 间隔）                      → ✅ 无频率限制
 *    换发后旧 token                               → ✅ 仍然有效，不互踢
 *
 *  ★ 结论：只要有**学号**，就能随时换发新 token ——
 *    不需要微信内置浏览器、不需要 openid、不需要密码、不需要验证码。
 *    token 寿命约 38~80 分钟，因此抢场前自动换一次即可，无需人工干预。
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  ⚠️ 安全与合规（必读）
 * ══════════════════════════════════════════════════════════════════════════
 *  这个接口对「学号」不做任何二次校验，意味着**理论上知道任何人的学号都能
 *  以他的身份换发 token**。这是学校平台自身的鉴权缺陷。
 *  本项目只允许用于**你自己的学号**；脚本内置了两道闸门：
 *    ① `allowRenew: false` 时绝不换发；
 *    ② 换发目标学号必须与 config.yaml 里 auth.usercode 一致（见 assertSelf）。
 *  请勿用它换发他人账号的 token —— 那是冒用他人身份，务必不要碰。
 */

const https = require('https');
const { wrap } = require('./crypto');

/** 登录接口（不需要 token） */
const PATH_ID_SERIAL_LOGIN = '/phone/login/idSerialLogin';
/** 通用只读接口：用来验证 token 是否真的被服务端接受（真 token 200 / 假 token 401） */
const PATH_VERIFY = '/phone/getInfoByType';
const VERIFY_PAYLOAD = { type: 'appoint_function' };

/** 默认提前多少毫秒算「快过期了」→ 触发续期 */
const DEFAULT_RENEW_MARGIN_MS = 10 * 60 * 1000; // 10 分钟

// ───────────────────────── JWT 解析 ─────────────────────────

/**
 * 解析 JWT 载荷。本系统的载荷形如：
 *   { exp, sub:"datalook", Operator: "{\"idserial\":\"<你的学号>\",\"username\":\"张三\",…}" }
 * 注意 Operator 是**被 JSON 字符串化的对象**，学号在 idserial，不是 payload.code（那是角色码 1201）。
 * @returns {object|null}
 */
function jwtPayload(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    const p = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (p && typeof p.Operator === 'string') {
      try { p.operator = JSON.parse(p.Operator); } catch (e) { /* 保留原字符串 */ }
    } else if (p && p.Operator && typeof p.Operator === 'object') {
      p.operator = p.Operator;
    }
    return p;
  } catch (e) {
    return null;
  }
}

/** 取 JWT 的 exp（秒）。取不到返回 null */
function jwtExpiry(token) {
  const p = jwtPayload(token);
  return p && typeof p.exp === 'number' ? p.exp : null;
}

/** 距离过期还有多少秒（可能为负）。取不到 exp 返回 null */
function tokenSecondsLeft(token, nowMs) {
  const exp = jwtExpiry(token);
  if (exp == null) return null;
  const now = nowMs != null ? nowMs : Date.now();
  return Math.round(exp - now / 1000);
}

/** 从 token 里抽出身份（idserial / 姓名） */
function identityOf(token) {
  const p = jwtPayload(token);
  if (!p) return null;
  const op = p.operator || {};
  return { idserial: op.idserial || null, username: op.username || null, rolecode: op.roleid || op.code || null, exp: p.exp || null };
}

// ───────────────────────── HTTP ─────────────────────────

/**
 * 发一次加密 POST（不依赖 ApiClient，因为登录接口必须在「还没有有效 token」时也能用）。
 * @returns {Promise<{status:number, json:object|null, body:string}>}
 */
function rawPost(opts, path, payload, token) {
  const {
    baseUrl = 'https://example.invalid',
    prefix = '/service/appointment/appointment',
    timeoutMs = 20000,
  } = opts || {};

  const u = new URL(baseUrl);
  const raw = JSON.stringify(wrap(payload));
  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(raw),
  };
  if (token) headers.token = token;

  return new Promise((resolve) => {
    const req = https.request({
      host: u.hostname,
      port: u.port || 443,
      path: prefix.replace(/\/+$/, '') + path,
      method: 'POST',
      headers,
      timeout: timeoutMs,
    }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(d); } catch (e) { /* 可能为空体 */ }
        resolve({ status: res.statusCode, json, body: d });
      });
    });
    req.on('error', (e) => resolve({ status: 0, json: null, body: 'ERR ' + e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, json: null, body: 'TIMEOUT' }); });
    req.write(raw);
    req.end();
  });
}

// ───────────────────────── 核心 ─────────────────────────

/**
 * 换发新 token。
 *
 * @param {string} usercode 学号（明文）
 * @param {object} [opts]   {baseUrl, prefix, timeoutMs}
 * @returns {Promise<{token:string, usercode:string, name:string, tel:string, type:string, exp:number|null, secondsLeft:number|null}>}
 * @throws {Error} 服务端拒绝时抛出（message 为服务端原文）
 */
async function mintToken(usercode, opts) {
  const id = String(usercode || '').trim();
  if (!id) throw new Error('mintToken 需要学号（auth.usercode）');
  // 服务端对空格敏感，这里主动挡一次（实测 " 2024… " 会返回「获取人员信息失败」）
  if (id !== String(usercode)) throw new Error('学号首尾有空格，请修正 config.yaml 里的 auth.usercode');

  const res = await rawPost(opts, PATH_ID_SERIAL_LOGIN, { idserial: id, token: '', pageType: '' }, null);
  if (!res.json) {
    throw new Error(`换发 token 失败：HTTP ${res.status} 且响应体非 JSON（${String(res.body).slice(0, 80)}）`);
  }
  if (res.json.success !== true || !res.json.resultData || !res.json.resultData.token) {
    throw new Error(`换发 token 被拒：${res.json.message || '未知错误'}`);
  }
  const rd = res.json.resultData;
  const exp = jwtExpiry(rd.token);
  return {
    token: rd.token,
    usercode: rd.code || id,
    name: rd.name || '',
    tel: rd.tel || '',
    type: rd.type || '',
    exp,
    secondsLeft: exp != null ? Math.round(exp - Date.now() / 1000) : null,
  };
}

/**
 * 验证 token 是否真的被服务端接受。
 * 用 /phone/getInfoByType（不带 token → 403；带假 token → 401；真 token → 200 + success）。
 *
 * @returns {Promise<{ok:boolean, status:number, message:string}>}
 */
async function verifyToken(token, opts) {
  if (!token) return { ok: false, status: 0, message: 'token 为空' };
  const res = await rawPost(opts, PATH_VERIFY, VERIFY_PAYLOAD, token);
  if (res.status === 200 && res.json && res.json.success === true) {
    return { ok: true, status: 200, message: '有效' };
  }
  if (res.status === 401) return { ok: false, status: 401, message: 'token 已失效（401）' };
  if (res.status === 403) return { ok: false, status: 403, message: '服务端要求 token（403）' };
  return {
    ok: false,
    status: res.status,
    message: res.json && res.json.message ? res.json.message : `HTTP ${res.status} ${String(res.body).slice(0, 60)}`,
  };
}

/**
 * 保证拿到一个「现在就能用」的 token。
 *
 * 决策顺序（每一步都不做无谓请求）：
 *   1. auth.allowRenew !== true  → 不换发，只验证现有 token
 *   2. 现有 token 的 exp 距现在 > renewBeforeMs → 先验证；有效就直接用（省一次登录请求）
 *   3. 否则（快过期 / 已过期 / 无效 / 没 token）→ 换发 → 验证 → 写入 config.yaml
 *
 * @param {object} cfg           已加载的配置对象（loadConfig().config）
 * @param {object} [opts]
 * @param {Function} [opts.log]  日志函数 (level, msg) 或 log 对象；不传则用 console
 * @param {number} [opts.renewBeforeMs] 提前多久算「快过期」，默认 10 分钟
 * @param {boolean} [opts.force] 强制换发（跳过复用判断）
 * @param {boolean} [opts.write] 是否把新 token 写回 config.yaml，默认 true
 * @returns {Promise<{token:string, renewed:boolean, reason:string, secondsLeft:number|null, usercode:string, name:string, file?:string}>}
 */
async function ensureToken(cfg, opts = {}) {
  const netOpts = { baseUrl: cfg.baseUrl, prefix: cfg.prefix, timeoutMs: (cfg.net && cfg.net.timeoutMs) || 20000 };
  const margin = opts.renewBeforeMs != null
    ? opts.renewBeforeMs
    : (cfg.auth && cfg.auth.renewBeforeMin != null ? Number(cfg.auth.renewBeforeMin) * 60000 : DEFAULT_RENEW_MARGIN_MS);
  const allowRenew = cfg.auth && cfg.auth.allowRenew === true;
  const usercode = (cfg.auth && cfg.auth.usercode) || '';

  const say = (level, msg) => {
    if (opts.log && typeof opts.log === 'function') opts.log(level, msg);
    else if (opts.log && typeof opts.log.info === 'function') {
      (opts.log[level] || opts.log.info).call(opts.log, msg);
    } else {
      console.log(`[${level}] ${msg}`);
    }
  };

  const finish = (token, renewed, reason, extra) => ({
    token, renewed, reason,
    secondsLeft: tokenSecondsLeft(token),
    usercode: (extra && extra.usercode) || usercode,
    name: (extra && extra.name) || '',
    file: extra && extra.file,
  });

  // ① 不允许自动换发
  if (!allowRenew && !opts.force) {
    const v = await verifyToken(cfg.auth.token, netOpts);
    if (!v.ok) {
      const left = tokenSecondsLeft(cfg.auth.token);
      const hint = left != null && left <= 0
        ? 'token 已过期'
        : 'token 无效';
      say('warn', `${hint}（${v.message}）。auth.allowRenew 不是 true，脚本不自动换发。`);
      say('warn', `→ 在 config.yaml 里把 auth.allowRenew 设为 true（只需学号，不需要微信/密码/验证码），或手动跑：node src/login.js`);
      throw new Error(`token 不可用且未开启自动续期：${v.message}`);
    }
    return finish(cfg.auth.token, false, 'allowRenew=false，现有 token 有效');
  }

  // ② 现有 token 还早着过期 → 先验证，能用就不浪费一次登录请求
  if (!opts.force && cfg.auth.token) {
    const left = tokenSecondsLeft(cfg.auth.token);
    if (left != null && left * 1000 > margin) {
      const v = await verifyToken(cfg.auth.token, netOpts);
      if (v.ok) {
        return finish(cfg.auth.token, false, `现有 token 仍有效（还剩 ${Math.floor(left / 60)} 分钟）`);
      }
      say('warn', `现有 token 验证未通过（${v.message}），改为换发新 token`);
    } else if (left != null) {
      say('info', `现有 token 将在 ${Math.max(0, Math.floor(left / 60))} 分钟后过期（阈值 ${Math.round(margin / 60000)} 分钟），换发新 token`);
    }
  }

  // ③ 换发
  if (!usercode) throw new Error('auth.usercode 为空 —— 自动换发 token 需要学号，请在 config.yaml 里填写');
  const minted = await mintToken(usercode, netOpts);
  say('info', `已换发新 token：${minted.name || usercode}（寿命 ${minted.secondsLeft != null ? Math.floor(minted.secondsLeft / 60) + ' 分钟' : '未知'}）`);

  // 换发的必须是自己 —— 防呆闸门
  if (minted.usercode && usercode && String(minted.usercode) !== String(usercode)) {
    throw new Error(`换发回来的学号（${minted.usercode}）与配置里的 auth.usercode（${usercode}）不一致，已中止，请检查配置`);
  }

  // ④ 验证新 token 真的能用
  const v = await verifyToken(minted.token, netOpts);
  if (!v.ok) throw new Error(`换发到的新 token 验证未通过：${v.message}`);

  // ⑤ 写回配置
  let file;
  if (opts.write !== false) {
    try {
      const { writeAuthToConfig } = require('./authfile');
      const r = writeAuthToConfig(cfg.__file, minted.token, minted.usercode || usercode, { quiet: true });
      file = cfg.__file;
      say('info', `新 token 已写入 ${cfg.__file}${r.hitUser ? '（usercode 已同步）' : ''}`);
      // 让内存里的配置也跟上，避免同一进程里又用旧 token
      cfg.auth.token = minted.token;
      cfg.auth.usercode = minted.usercode || usercode;
    } catch (e) {
      say('warn', `新 token 写盘失败（${e.message}）—— 本次运行仍会用新 token，但下次启动会重新换发`);
    }
  }

  return finish(minted.token, true, `已换发新 token（${minted.name || usercode}）`, { usercode: minted.usercode || usercode, name: minted.name, file });
}

// ───────────────────────── CLI ─────────────────────────

function fmtLeft(sec) {
  if (sec == null) return '未知';
  if (sec <= 0) return `已过期 ${Math.floor(-sec / 60)} 分钟`;
  return `还剩 ${Math.floor(sec / 60)} 分 ${sec % 60} 秒`;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('-h') || argv.includes('--help')) {
    console.log(`用法:
  node src/login.js                   查看当前 token 状态（只读，不发登录请求）
  node src/login.js --renew           强制换发一个新 token 并写入 config.yaml
  node src/login.js --ensure          按需续期（快过期才换）——grab.js 启动时自动做同样的事
  node src/login.js --check           只验证当前 token 是否被服务端接受

原理：POST /phone/login/idSerialLogin {idserial:<你的学号>} → 直接返回新 token。
      不需要微信、不需要密码、不需要验证码。
配置：config.yaml 的 auth.usercode 必须是你的学号，auth.allowRenew 必须为 true。`);
    return 0;
  }

  const { loadConfig } = require('./config');
  const { config: cfg, file } = loadConfig();

  console.log(`配置文件 : ${file}`);
  console.log(`学号     : ${cfg.auth.usercode || '（空！请填 auth.usercode）'}`);
  console.log(`自动续期 : ${cfg.auth.allowRenew === true ? '✅ 已开启 (allowRenew: true)' : '❌ 未开启 (allowRenew 需要为 true)'}`);

  const ident = identityOf(cfg.auth.token);
  console.log(`当前 token: ${cfg.auth.token ? (ident ? `${ident.idserial || '?'} / ${ident.username || '?'}` : '（非 JWT 格式）') : '（空）'}`);
  console.log(`           ${fmtLeft(tokenSecondsLeft(cfg.auth.token))}`);

  const wantRenew = argv.includes('--renew') || argv.includes('--force');
  const wantEnsure = argv.includes('--ensure');
  const wantCheck = argv.includes('--check');

  if (wantRenew || wantEnsure) {
    if (cfg.auth.allowRenew !== true) {
      console.error('\n❌ config.yaml 里 auth.allowRenew 不是 true —— 拒绝自动换发。');
      console.error('   这是安全闸门：只有你明确开启后，脚本才会用学号换发 token。');
      return 2;
    }
  }

  if (wantRenew) {
    const r = await ensureToken(cfg, { force: true, log: (l, m) => console.log(`  ${m}`) });
    console.log(`\n✅ ${r.reason}`);
    console.log(`   新 token 到期时间：${fmtLeft(r.secondsLeft)}`);
    console.log(`   写入文件：${r.file || '（未写入）'}`);
    return 0;
  }

  if (wantEnsure) {
    const r = await ensureToken(cfg, { log: (l, m) => console.log(`  [${l}] ${m}`) });
    console.log(`\n✅ ${r.reason}（${fmtLeft(r.secondsLeft)}）`);
    return 0;
  }

  if (wantCheck) {
    const v = await verifyToken(cfg.auth.token, { baseUrl: cfg.baseUrl, prefix: cfg.prefix });
    console.log(`\n服务端验证：${v.ok ? '✅ ' : '❌ '}${v.message}`);
    console.log(`（用 ${PATH_VERIFY} 探测：不带 token → 403，带假 token → 401，带真 token → 200）`);
    return v.ok ? 0 : 2;
  }

  // 无参数：给个建议
  const left = tokenSecondsLeft(cfg.auth.token);
  console.log('');
  if (cfg.auth.token && left != null && left > 600) {
    console.log('→ token 看起来还有效。要确认的话：node src/login.js --check');
  } else {
    console.log('→ token 需要更新。执行：node src/login.js --renew');
  }
  if (cfg.auth.allowRenew !== true) {
    console.log('→ ⚠️ auth.allowRenew 不是 true，grab.js 不会自动续期，到点会因 401 直接退出。');
  }
  return 0;
}

if (require.main === module) {
  main().then((c) => { process.exitCode = c || 0; }).catch((e) => {
    console.error(`\n❌ ${e.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  mintToken,
  verifyToken,
  ensureToken,
  jwtPayload,
  jwtExpiry,
  tokenSecondsLeft,
  identityOf,
  rawPost,
  PATH_ID_SERIAL_LOGIN,
  PATH_VERIFY,
  DEFAULT_RENEW_MARGIN_MS,
};
