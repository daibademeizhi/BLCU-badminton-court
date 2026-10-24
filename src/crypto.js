'use strict';
/**
 * 加解密模块 —— 精确复刻 本校 订场系统前端的请求加密
 *
 * 前端源码（模块 84ad）：
 *   var t = a.enc.Utf8.parse("0102030405060708");   // KEY
 *   var i = a.enc.Utf8.parse("0102030405060708");   // IV（与 KEY 相同）
 *   Encrypt = AES.encrypt(Utf8.parse(e), t, {iv:i, mode:CBC, padding:Pkcs7})
 *             .ciphertext.toString().toUpperCase();   // → 大写 HEX
 *
 * 规格：AES-128-CBC / Key=IV="0102030405060708" / PKCS7 / 大写十六进制
 *
 * 验证：服务端对同一接口的响应
 *   我方密文  → {"success":false,"message":"账号或密码错误"}   ← 解密成功
 *   垃圾密文  → {"success":false,"message":"解密失败"}          ← 解密失败
 * 证明本模块复刻精确。
 */

const crypto = require('crypto');

const KEY = Buffer.from('0102030405060708', 'utf8');
const IV = Buffer.from('0102030405060708', 'utf8');
const ALGO = 'aes-128-cbc';

/**
 * 加密：明文字符串 → 大写十六进制密文
 * @param {string} plain
 * @returns {string} 大写 HEX
 */
function encrypt(plain) {
  const cipher = crypto.createCipheriv(ALGO, KEY, IV);
  return Buffer.concat([
    cipher.update(Buffer.from(plain, 'utf8')),
    cipher.final(),
  ]).toString('hex').toUpperCase();
}

/**
 * 解密：大写/小写十六进制密文 → 明文字符串
 * @param {string} hexStr
 * @returns {string}
 */
function decrypt(hexStr) {
  const decipher = crypto.createDecipheriv(ALGO, KEY, IV);
  return Buffer.concat([
    decipher.update(Buffer.from(hexStr, 'hex')),
    decipher.final(),
  ]).toString('utf8');
}

/**
 * 将任意对象加密为请求体 { item: "<HEX>" }
 * 对应前端：s = { item: Encrypt(JSON.stringify(e.data)) }
 * @param {*} obj
 * @returns {{item: string}}
 */
function wrap(obj) {
  return { item: encrypt(JSON.stringify(obj)) };
}

/**
 * 尝试解密服务端返回体（若返回的是裸 HEX 密文）
 * 正常情况服务端返回明文 JSON，本函数仅作兜底
 * @param {string} body
 * @returns {string|null}
 */
function tryDecryptBody(body) {
  if (typeof body !== 'string') return null;
  const t = body.trim();
  if (!/^[0-9A-Fa-f]{32,}$/.test(t) || t.length % 2 !== 0) return null;
  try {
    return decrypt(t);
  } catch (e) {
    return null;
  }
}

module.exports = { encrypt, decrypt, wrap, tryDecryptBody, KEY, IV, ALGO };
