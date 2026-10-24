'use strict';
/**
 * config.yaml 凭证写回（token / usercode）
 *
 * 设计原则：**只做行内替换** —— 不动缩进、不重排、不丢注释。
 * 手写 YAML 序列化器会把用户的注释和排版全部搞乱，风险太大。
 */

const fs = require('fs');
const path = require('path');

/**
 * 把 auth.token / auth.usercode 写进 config.yaml。
 *
 * @param {string} file      配置文件路径
 * @param {string} token     新 token（必填）
 * @param {string} [usercode] 学号；为空则不写
 * @param {object} [opts]    {quiet:true 则不打印「已备份」提示}
 * @returns {{hitToken:boolean, hitUser:boolean, backup:string|null, changed:boolean}}
 */
function writeAuthToConfig(file, token, usercode, opts = {}) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);

  let inAuth = false;
  let hitToken = false;
  let hitUser = false;
  let backup = null;
  const quote = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const m = /^(\s*)([A-Za-z_][\w-]*)\s*:(.*)$/.exec(raw);
    if (!m) continue;
    const [, indent, key] = m;

    if (indent.length === 0) {
      inAuth = key === 'auth';
      continue;
    }
    if (!inAuth) continue;

    if (key === 'token' && !hitToken) {
      const curVal = m[3].trim().replace(/^["']|["']$/g, '');
      if (curVal && curVal !== token) {
        // 已有旧 token → 备份一次，避免手抖把好 token 覆盖掉
        backup = `${file}.bak`;
        fs.writeFileSync(backup, text, 'utf8');
        if (!opts.quiet) console.log(`  （原 token 已备份到 ${path.basename(backup)}）`);
      }
      const cmt = raw.indexOf('#') >= 0 ? '  ' + raw.slice(raw.indexOf('#')) : '';
      lines[i] = `${indent}token: ${quote(token)}${cmt}`;
      hitToken = true;
    } else if (key === 'usercode' && usercode && !hitUser) {
      const cmt = raw.indexOf('#') >= 0 ? '  ' + raw.slice(raw.indexOf('#')) : '';
      lines[i] = `${indent}usercode: ${quote(usercode)}${cmt}`;
      hitUser = true;
    }
  }

  if (!hitToken) throw new Error(`在 ${file} 里没找到 auth.token 行，请手动编辑`);
  const out = lines.join('\n');
  fs.writeFileSync(file, out, 'utf8');
  return { hitToken, hitUser, backup, changed: out !== text };
}

/** 只读：读出 config.yaml 里 auth 段的当前值（不加载整个 YAML） */
function readAuthFromConfig(file) {
  const text = fs.readFileSync(file, 'utf8');
  const out = { token: '', usercode: '', allowRenew: null };
  let inAuth = false;
  for (const raw of text.split(/\r?\n/)) {
    const m = /^(\s*)([A-Za-z_][\w-]*)\s*:(.*)$/.exec(raw);
    if (!m) continue;
    const [, indent, key, rest] = m;
    if (indent.length === 0) { inAuth = key === 'auth'; continue; }
    if (!inAuth) continue;
    const val = rest.trim().replace(/^["']|["']$/g, '').split('#')[0].trim();
    if (key === 'token') out.token = val;
    else if (key === 'usercode') out.usercode = val;
    else if (key === 'allowRenew') out.allowRenew = val === 'true' ? true : val === 'false' ? false : val;
  }
  return out;
}

module.exports = { writeAuthToConfig, readAuthFromConfig };
