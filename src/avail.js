'use strict';
/**
 * 只读查询：某一天（或最近几天）还有哪些时段、哪些场地可以订。
 *
 * 用途：给「马上抢 / 帮买」这种交互式流程提供数据 —— 先看见还有哪些场，
 *       再决定买哪一个。本身**绝不产生订单、不改任何数据**。
 *
 * 运行：
 *   node src/avail.js                      # 默认 T+2 那一天，人读格式
 *   node src/avail.js --rel 1              # 明天
 *   node src/avail.js --date 2026-10-21    # 指定日期
 *   node src/avail.js --days 3 --json      # T+0/T+1/T+2 三天，机器读（菜单用）
 *
 * 为什么要有 --json：菜单（PowerShell）要拿它渲染「选哪天 → 选哪个时段」的列表。
 * 让脚本输出给人看的表格再用正则去抠，是最容易出错的接法 —— 直接把结构吐出来，
 * 菜单那边 ConvertFrom-Json 就行。
 *
 * 输出结构（--json）：
 *   { ok: true, serverNow: '...', venue: '羽毛球',
 *     days: [ { date, weekday, ok, message, openSlots,
 *               slots: [ { time: '18:00-19:00', count: 2,
 *                          courts: [ { id, name } ] } ] } ] }
 *   某一天查不到（还没放场 / 整馆满）时该天的 ok=false 并带 message，不影响其它天。
 */

const { loadConfig } = require('./config');
const { ApiClient } = require('./client');
const { ensureToken } = require('./login');
const { parseNodeAppointGrid } = require('./target');
const { fmtServerDate, fmtServer } = require('./util');

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 星期几（纯按日期算，不依赖本机时区：用 UTC 中午的构造避开夏令时/时区偏移） */
function weekdayOf(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  if (!m) return '';
  return WEEK[new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay()] || '';
}

/** 服务端口径的「今天 + N 天」（服务端时区固定 UTC+8） */
function serverDatePlus(days) {
  const today = new Date(Date.now() + 8 * 3600 * 1000);
  const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + days));
  return d.toISOString().slice(0, 10);
}

function parseArgs(argv) {
  const o = { date: null, rel: null, days: 1, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--date' || a === '-d') o.date = argv[++i];
    else if (a.startsWith('--date=')) o.date = a.slice('--date='.length);
    else if (a === '--rel') o.rel = Number(argv[++i]);
    else if (a.startsWith('--rel=')) o.rel = Number(a.slice('--rel='.length));
    else if (a === '--days') o.days = Number(argv[++i]);
    else if (a.startsWith('--days=')) o.days = Number(a.slice('--days='.length));
    else if (a === '--json') o.json = true;
  }
  return o;
}

/** 决定要查哪些日期 */
function resolveDates(args) {
  if (args.date) return [String(args.date)];
  if (Number.isFinite(args.days) && args.days > 1) {
    const base = Number.isFinite(args.rel) ? args.rel : 0;
    const out = [];
    for (let i = 0; i < args.days; i++) out.push(serverDatePlus(base + i));
    return out;
  }
  const rel = Number.isFinite(args.rel) ? args.rel : 2;
  return [serverDatePlus(rel)];
}

function makeClient(cfg, token) {
  return new ApiClient({
    baseUrl: cfg.baseUrl,
    prefix: cfg.prefix,
    token,
    timeout: cfg.net.timeoutMs,
    minInterval: Math.max(cfg.net.minIntervalMs, 250),
    verbose: !!cfg.verbose,
  });
}

/** 查一天；任何失败都收成 { ok:false, message }，不抛 */
async function queryDay(api, cfg, date) {
  let raw;
  try {
    raw = await api.getNodeAppointInfoList({ parentNodeId: cfg.venue.nodeid, appointDate: date });
  } catch (e) {
    return { date, weekday: weekdayOf(date), ok: false, message: e.message || String(e), openSlots: 0, slots: [] };
  }
  if (!raw || raw.success !== true || !raw.resultData) {
    return {
      date, weekday: weekdayOf(date), ok: false,
      message: (raw && raw.message) || '无数据', openSlots: 0, slots: [],
    };
  }
  const grid = parseNodeAppointGrid(raw.resultData, { date });
  if (!grid) {
    return { date, weekday: weekdayOf(date), ok: false, message: '网格为空（该日期可能还没放场）', openSlots: 0, slots: [] };
  }
  const nameById = new Map((grid.courts || []).map((c) => [String(c.id), c.name]));
  const slots = (grid.slots || [])
    .filter((s) => s && s.bookableCount > 0)
    .map((s) => ({
      time: s.time,
      count: s.bookableCount,
      courts: (s.bookableCourts || []).map((id) => ({ id: String(id), name: nameById.get(String(id)) || String(id) })),
    }))
    .sort((a, b) => String(a.time).localeCompare(String(b.time)));
  return {
    date,
    weekday: weekdayOf(date),
    ok: true,
    message: slots.length ? '' : '这一天已经没有空场地了（全满）',
    openSlots: slots.length,
    slots,
  };
}

function printHuman(res) {
  console.log(`场馆：${res.venue}    服务端时间：${res.serverNow}`);
  for (const d of res.days) {
    console.log('');
    const head = `${d.date}（${d.weekday || '?'}）`;
    if (!d.ok) {
      console.log(`${head}  ✗ ${d.message}`);
      continue;
    }
    if (!d.slots.length) {
      console.log(`${head}  ✗ ${d.message}`);
      continue;
    }
    console.log(`${head}  ✓ ${d.openSlots} 个时段有空场`);
    for (const s of d.slots) {
      const names = s.courts.map((c) => c.name).join('、');
      console.log(`   ${s.time}  剩 ${s.count} 片  ${names}`);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const quiet = args.json;
  const { config } = loadConfig();

  const auth = await ensureToken(config, {
    log: (level, msg) => { if (!quiet) console.log(`[${level}] ${msg}`); },
  });
  const api = makeClient(config, auth.token);

  const dates = resolveDates(args);
  const days = [];
  for (const d of dates) {
    days.push(await queryDay(api, config, d));
  }
  const res = {
    ok: days.some((d) => d.ok),
    venue: config.venue.name || '',
    serverNow: fmtServer(Date.now()),
    days,
  };

  if (args.json) {
    console.log(JSON.stringify(res, null, 2));
  } else {
    printHuman(res);
  }
  process.exitCode = res.ok ? 0 : 1;

  // 供调试：为什么某天查不到
  if (!res.ok && args.json) {
    // 保持 stdout 只有一份 JSON（菜单要解析），原因已经在 days[].message 里
  }
  void fmtServerDate;
}

main().catch((e) => {
  const msg = (e && e.message) || String(e);
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ ok: false, error: msg, days: [] }, null, 2));
  } else {
    console.error(`★ 查询失败：${msg}`);
  }
  process.exitCode = 1;
});
