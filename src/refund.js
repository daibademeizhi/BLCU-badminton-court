'use strict';
/**
 * 退订退款（自带查询 + 取消，钱原路退回一卡通）。
 *
 * 平台没有单独的「退款」接口：退订接口 `/phone/userCancelBooking` 就是退款 ——
 * 官方前端 `pages/custom/order/orderDetail` 的 cancelBooking/commit 干的事，本脚本 1:1 复刻：
 *   POST /phone/userCancelBooking  { id, txamt, booktype, payway[, cancelremark] }
 *     id      = 订单详情里的 `id`（一小时的票一张票，两小时的预约就是两条订单记录）
 *     txamt   = 订单详情里的 `payallamt`（★ 不是列表里的 txamt，列表那个是单时段金额）
 *     booktype/payway = 订单详情原值
 * 成功判据：HTTP 200 + success:true（返回 resultData 常为 null），订单 status 由 1 变 2（已退款）。
 *
 * 用法：
 *   node src/refund.js                      # 列出「未使用」的订单（可退的）
 *   node src/refund.js --all                # 连已退款/已用的也列出来
 *   node src/refund.js --json               # 机器读（菜单用）
 *   node src/refund.js --booking 255477     # 只预览，不退
 *   node src/refund.js --booking 255477 --yes     # 真退这一条（一小时）
 *   node src/refund.js --orderno 134645 --yes     # 退这一笔订单下所有未使用时段
 *
 * 安全设计：不带 --yes 永远只预览；status≠1（已退款/已使用）一律跳过，绝不重复退。
 */

const { loadConfig } = require('./config');
const { ApiClient } = require('./client');
const { ensureToken } = require('./login');
const { fmtServer } = require('./util');

const STATUS_TEXT = {
  '1': '未使用',
  '2': '已退款',
  '8': '已使用',
  '9': '待支付',   // 2026-11-12 实测：锁场成功但支付失败，订单停在这一档
  '12': '排队中',
};

function statusText(s) {
  return STATUS_TEXT[String(s)] || `状态${s}`;
}

/** 未使用 = 可退。其余一律不碰。 */
function isRefundable(item) {
  return !!item && String(item.status) === '1';
}

/** 把列表项整理成稳定结构（列表接口字段名比较飘，这里只挑用得到的） */
function normalizeItem(it, i) {
  const tx = it.txamt != null ? String(it.txamt) : '';
  const total = it.totaltxamt != null ? String(it.totaltxamt) : tx;
  return {
    index: i + 1,
    bookingno: String(it.bookingno || ''),
    orderno: String(it.orderno || ''),
    id: String(it.id || ''),
    nodename: String(it.nodename || ''),
    bookingtime: String(it.bookingtime || ''),
    txamt: tx,
    totaltxamt: total,
    status: String(it.status || ''),
    statusText: statusText(it.status),
    refundable: isRefundable(it),
    createdate: String(it.createdate || ''),
  };
}

/** 取消接口的 payload（★ 字段与官方前端 commit() 完全一致） */
function buildCancelPayload(detail, remark) {
  const p = {
    id: detail.id,
    txamt: detail.payallamt,
    booktype: detail.booktype,
    payway: detail.payway,
  };
  if (remark && String(remark).trim()) p.cancelremark = String(remark).trim();
  return p;
}

function parseArgs(argv) {
  const o = { all: false, json: false, booking: null, orderno: null, yes: false, remark: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') o.all = true;
    else if (a === '--json') o.json = true;
    else if (a === '--yes' || a === '-y') o.yes = true;
    else if (a === '--booking') o.booking = String(argv[++i] || '');
    else if (a.startsWith('--booking=')) o.booking = a.slice('--booking='.length);
    else if (a === '--orderno') o.orderno = String(argv[++i] || '');
    else if (a.startsWith('--orderno=')) o.orderno = a.slice('--orderno='.length);
    else if (a === '--remark') o.remark = String(argv[++i] || '');
    else if (a.startsWith('--remark=')) o.remark = a.slice('--remark='.length);
  }
  return o;
}

function makeClient(cfg, token) {
  return new ApiClient({
    baseUrl: cfg.baseUrl,
    prefix: cfg.prefix,
    token,
    timeout: cfg.net.timeoutMs,
    minInterval: Math.max(Number(cfg.net.minIntervalMs) || 0, 300),
    verbose: !!cfg.verbose,
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** 拉订单分页（Spring Page）。ordertype=1 是「场地预约」还是全类型，实测 1 能拿到羽毛球订单。 */
async function fetchList(api, opts = {}) {
  const page = await api.payOrderForPhone({
    status: opts.all ? null : 1,
    ordertype: 1,
    pageNumber: 1,
    pageSize: 50,
  });
  const list = (page && (page.content || page.records || page.list)) || [];
  return list.map(normalizeItem);
}

/** 订单详情（取消前必须拿 payallamt） */
async function fetchDetail(api, bookingno, id) {
  const d = await api.call('/phone/payOrderDetails', { bookingno: String(bookingno), id: String(id) }, { retries: 1 });
  return d || null;
}

/** 退一条（一小时）。返回 {ok, message} */
async function cancelOne(api, order, remark, log) {
  const detail = await fetchDetail(api, order.bookingno, order.id);
  if (!detail) return { bookingno: order.bookingno, ok: false, message: '取不到订单详情' };
  if (!isRefundable(detail)) {
    return { bookingno: order.bookingno, ok: false, message: `状态是「${statusText(detail.status)}」，不是未使用，跳过` };
  }
  const payload = buildCancelPayload(detail, remark);
  let res;
  try {
    res = await api.callRaw('/phone/userCancelBooking', payload, { retries: 0 });
  } catch (e) {
    return { bookingno: order.bookingno, ok: false, message: (e && e.message) || String(e) };
  }
  if (!res || res.success !== true) {
    return { bookingno: order.bookingno, ok: false, message: (res && res.message) || '平台拒绝了取消请求' };
  }
  // 复核：再取一次详情，status 应变成 2（已退款）
  let after = null;
  try { after = await fetchDetail(api, order.bookingno, order.id); } catch (e) { /* 复核失败不算退失败 */ }
  const st = after ? String(after.status) : '';
  if (st && st !== '2') {
    return { bookingno: order.bookingno, ok: false, message: `平台返回成功，但订单状态还是「${statusText(st)}」` };
  }
  if (log) log.info(`已退：${order.bookingtime}  ${order.nodename}  ${order.txamt} 元（bookingno ${order.bookingno}）`);
  return {
    bookingno: order.bookingno,
    ok: true,
    message: '已退款（原路退回）',
    bookingtime: order.bookingtime,
    nodename: order.nodename,
    txamt: order.txamt,
    statusAfter: st || '',
  };
}

function printHuman(orders, argv) {
  if (!orders.length) {
    console.log('没有订单。');
    return;
  }
  const head = argv.all
    ? '全部订单（含已退款/已使用）'
    : '未使用的订单（这些可以退）';
  console.log(`${head}：共 ${orders.length} 条`);
  console.log('');
  for (const o of orders) {
    const mark = o.refundable ? '可退' : '  不可退';
    console.log(`  [${o.index}] ${o.bookingtime.padEnd(17)} ${o.nodename.padEnd(16)} ${String(o.txamt).padStart(6)} 元  ${o.statusText.padEnd(4)} ${mark}  bookingno ${o.bookingno}（订单 ${o.orderno}）`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const quiet = args.json;
  const { config } = loadConfig();
  const log = { info: (m) => { if (!quiet) console.log(`[info] ${m}`); } };

  const auth = await ensureToken(config, { log: (level, msg) => { if (!quiet) console.log(`[${level}] ${msg}`); } });
  const api = makeClient(config, auth.token);

  const all = await fetchList(api, { all: args.all });

  // ── 只是列出来 ──
  if (!args.booking && !args.orderno) {
    const res = { ok: true, serverNow: fmtServer(Date.now()), all: !!args.all, orders: all };
    if (args.json) console.log(JSON.stringify(res, null, 2));
    else printHuman(all, args);
    process.exitCode = 0;
    return;
  }

  // ── 退：先挑出目标 ──
  let targets = [];
  if (args.booking) {
    targets = all.filter((o) => o.bookingno === args.booking);
    if (!targets.length) {
      // 列表里没找到（可能不在第一页/已退款被过滤），直接按 bookingno 找列表全量
      const allList = await fetchList(api, { all: true });
      targets = allList.filter((o) => o.bookingno === args.booking);
    }
  } else {
    targets = all.filter((o) => o.orderno === args.orderno);
  }

  if (!targets.length) {
    const msg = args.booking ? `没找到 bookingno=${args.booking} 的订单` : `没找到订单号 ${args.orderno} 的订单`;
    if (args.json) console.log(JSON.stringify({ ok: false, error: msg, cancelled: [] }, null, 2));
    else console.error(`★ ${msg}`);
    process.exitCode = 1;
    return;
  }

  const refundable = targets.filter((o) => o.refundable);
  const skipped = targets.filter((o) => !o.refundable);

  if (!args.yes) {
    // 预览
    console.log('─ 预览（没有真的退；确认无误后加 --yes）─');
    for (const o of refundable) {
      console.log(`  将退：[${o.bookingtime}] ${o.nodename}  ${o.txamt} 元  bookingno ${o.bookingno}（订单 ${o.orderno}）`);
    }
    for (const o of skipped) {
      console.log(`  跳过：[${o.bookingtime}] ${o.nodename}  状态「${o.statusText}」`);
    }
    if (args.json) {
      console.log(JSON.stringify({ ok: true, dryRun: true, willCancel: refundable, skipped }, null, 2));
    }
    process.exitCode = 0;
    return;
  }

  const cancelled = [];
  const failed = [];
  for (const o of refundable) {
    const r = await cancelOne(api, o, args.remark, log);
    if (r.ok) cancelled.push(r); else failed.push(r);
    await sleep(400); // 限流：别连着打
  }
  for (const o of skipped) failed.push({ bookingno: o.bookingno, ok: false, message: `状态「${o.statusText}」，跳过` });

  const res = { ok: cancelled.length > 0 && failed.length === 0, cancelled, failed };
  if (args.json) console.log(JSON.stringify(res, null, 2));
  else {
    for (const c of cancelled) console.log(`  ✓ 已退 ${c.bookingtime || ''} ${c.nodename || ''} ${c.txamt || ''} 元`);
    for (const f of failed) console.log(`  ✗ ${f.bookingno}：${f.message}`);
    console.log('');
    console.log(`退款完成：${cancelled.length} 条，失败/跳过 ${failed.length} 条。钱原路退回一卡通，座位已释放。`);
  }
  process.exitCode = res.ok ? 0 : (cancelled.length ? 0 : 1);
}

if (require.main === module) {
  main().catch((e) => {
    const msg = (e && e.message) || String(e);
    if (process.argv.includes('--json')) console.log(JSON.stringify({ ok: false, error: msg, cancelled: [] }, null, 2));
    else console.error(`★ 退款失败：${msg}`);
    process.exitCode = 1;
  });
}

module.exports = { STATUS_TEXT, statusText, isRefundable, normalizeItem, buildCancelPayload, parseArgs };
