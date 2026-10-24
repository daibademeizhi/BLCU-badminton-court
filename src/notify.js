'use strict';
/**
 * 通知模块：抢到场地后把「去付款」的提示推给用户。
 * 支持：控制台 / 通用 Webhook（企业微信机器人、钉钉、飞书、Bark、Server 酱等均由 webhookUrl 覆盖）
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');

function post(url, body, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error(`webhookUrl 非法: ${url}`)); }
    const isHttps = u.protocol === 'https:';
    const lib = isHttps ? https : http;
    const data = Buffer.from(JSON.stringify(body), 'utf8');
    const req = lib.request(
      {
        host: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + u.search,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      }
    );
    req.on('timeout', () => req.destroy(new Error('webhook 超时')));
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

/**
 * @param {object} cfg  config.pay.notify
 * @param {string} text 通知正文
 * @param {object} log  Logger
 * @param {object} [extra] 附加结构化数据
 */
async function notify(cfg, text, log, extra) {
  const conf = cfg || {};
  if (conf.console !== false && log) log.info(`\n【通知】${text}`);
  if (!conf.webhookUrl) return { ok: true, skipped: true };

  const payload = Object.assign(
    {
      msgtype: 'text',
      text: { content: text },
      // 兼容通用 webhook
      text_content: text,
      content: text,
      message: text,
    },
    extra || {}
  );

  try {
    const res = await post(conf.webhookUrl, payload);
    if (log) log.info(`webhook 推送完成：HTTP ${res.status} ${String(res.body).slice(0, 120)}`);
    return { ok: res.status >= 200 && res.status < 300, status: res.status, body: res.body };
  } catch (e) {
    if (log) log.warn(`webhook 推送失败：${e.message}`);
    return { ok: false, error: e.message };
  }
}

module.exports = { notify, post };
