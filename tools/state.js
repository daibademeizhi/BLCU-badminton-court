'use strict';
/**
 * state.js — 「抢场偏好」的持久化（只读写两个小文本文件，不碰 config.yaml）
 *
 * 为什么单独存文件、而不是直接改 config.yaml：
 *   ① config.yaml 里全是注释和结构，用脚本回写等于重新拼一份配置，
 *      一旦拼错就是把整个抢场脚本搞挂（最坏情况：静默抢错场地）。
 *   ② 这两个东西是**用户临时意愿**（明天有课就换个顺序），不是项目配置；
 *      放 config.yaml 里反而会被 git 跟踪、被误提交。
 *   ③ 纯文本一行一段，出问题时 `cat data/priority.txt` 一眼就能看懂。
 *
 * 两个文件（都在 data/ 下，已被 .gitignore 排除）：
 *   data/priority.txt  按优先级顺序，一行一段，例如：
 *                        16:00-18:00
 *                        17:00-19:00
 *                        15:00-17:00
 *   data/timed.txt     定时抢用哪种模式，一行二选一：
 *                        priority              按 priority.txt 的顺序试（保留兜底）
 *                        window 18:00-20:00    只抢这一段（严格模式，没有就收手）
 *                      文件不存在 / 空 = 什么都不覆盖，照 config.yaml 的 hourPriority
 *
 * 命令（都打印一行 JSON，方便 PowerShell 那边 ConvertFrom-Json）：
 *   node state.js show
 *   node state.js prio-set "16:00-18:00,17:00-19:00,15:00-17:00"
 *   node state.js prio-reorder "3,1,2"      # 编号按当前顺序（从 1 开始）
 *   node state.js prio-clear
 *   node state.js timed-set priority
 *   node state.js timed-set window 18:00-20:00
 *   node state.js timed-clear
 *
 * ★ 所有校验都复用 src/config.js 的 parseWindowList —— 菜单里手打的东西
 *   和 grab.js 命令行必须是**同一套解析规则**，否则会出现「菜单说保存成功、
 *   抢的时候却报看不懂」这种最难查的错。
 */

const fs = require('fs');
const path = require('path');

// 安装位置有两种可能，都要能跑：
//   ① 部署后：脚本贴在项目根目录（/root/blcu/state.js），src/ 就在旁边；
//   ② 仓库里：脚本在 router/ 下，src/ 在上一级。
const ROOT = fs.existsSync(path.join(__dirname, 'src', 'config.js'))
  ? __dirname
  : path.join(__dirname, '..');
const { parseWindowList } = require(path.join(ROOT, 'src', 'config'));

const PR_FILE = path.join(ROOT, 'data', 'priority.txt');
const TM_FILE = path.join(ROOT, 'data', 'timed.txt');
// 2026-11-11 加：菜单改成一键开抢之后，多出两个文件。
//   data/mode.txt          default | once（本次临时优先级只在下一趟定时抢里用一次）
//   data/once-priority.txt 「这一次」的优先级，一行一段，按顺序试
const MODE_FILE = path.join(ROOT, 'data', 'mode.txt');
const ONCE_FILE = path.join(ROOT, 'data', 'once-priority.txt');

function ensureDataDir() {
  const d = path.join(ROOT, 'data');
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
}

function readLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch (e) {
    return [];
  }
}

function readPriority() {
  const raw = readLines(PR_FILE);
  if (!raw.length) return [];
  try {
    const wins = parseWindowList([raw.join(',')]);
    return (wins || []).map((w) => w.raw);
  } catch (e) {
    // 文件被人手改坏了：如实报出来，不要静默当成空（否则定时抢会悄悄换成 config 的偏好）
    return { error: `data/priority.txt 内容看不懂：${e.message}` };
  }
}

function readTimed() {
  const raw = readLines(TM_FILE);
  if (!raw.length) return { mode: 'config' };
  const line = raw[0];
  if (/^priority$/i.test(line)) return { mode: 'priority' };
  const m = /^window\s+(.+)$/i.exec(line);
  if (m) {
    try {
      const wins = parseWindowList([m[1]]);
      return { mode: 'window', window: wins.map((w) => w.raw).join(',') };
    } catch (e) {
      return { mode: 'config', error: `data/timed.txt 内容看不懂：${e.message}` };
    }
  }
  return { mode: 'config', error: `data/timed.txt 内容看不懂：${line}` };
}

function readMode() {
  const raw = readLines(MODE_FILE);
  if (!raw.length) return 'default';
  const v = raw[0].toLowerCase();
  return v === 'once' ? 'once' : 'default';
}

function readOnce() {
  const raw = readLines(ONCE_FILE);
  if (!raw.length) return [];
  try {
    const wins = parseWindowList([raw.join(',')]);
    return (wins || []).map((w) => w.raw);
  } catch (e) {
    return { error: `data/once-priority.txt 内容看不懂：${e.message}` };
  }
}

function writeMode(m) {
  ensureDataDir();
  fs.writeFileSync(MODE_FILE, (m === 'once' ? 'once' : 'default') + '\n', 'utf8');
}

function writeOnce(wins) {
  ensureDataDir();
  fs.writeFileSync(ONCE_FILE, wins.join('\n') + '\n', 'utf8');
}

function clearOnce() {
  try { fs.unlinkSync(ONCE_FILE); } catch (e) { /* 本来就没有 */ }
}

function snapshot() {
  const priority = readPriority();
  const timed = readTimed();
  const out = {
    ok: true,
    priority: Array.isArray(priority) ? priority : [],
    timed,
    mode: readMode(),
    once: readOnce(),
  };
  if (priority && priority.error) { out.ok = false; out.error = priority.error; out.priority = []; }
  if (timed && timed.error) { out.ok = false; out.error = (out.error ? out.error + '；' : '') + timed.error; }
  if (out.once && out.once.error) { out.ok = false; out.error = (out.error ? out.error + '；' : '') + out.once.error; out.once = []; }
  return out;
}

function fail(msg) {
  console.log(JSON.stringify({ ok: false, error: msg }));
  process.exitCode = 2;
}

function writePriority(wins) {
  ensureDataDir();
  fs.writeFileSync(PR_FILE, wins.join('\n') + '\n', 'utf8');
}

function cmdPrioSet(values) {
  const text = values.join(' ');
  let wins;
  try {
    wins = parseWindowList([text]);
  } catch (e) {
    return fail(e.message);
  }
  if (!wins || !wins.length) return fail('没有给出任何时间段');
  if (wins.length > 12) return fail('最多 12 段（再多就不是「优先级」而是没想好）');
  const raws = wins.map((w) => w.raw);
  writePriority(raws);
  console.log(JSON.stringify(Object.assign(snapshot(), { ok: true, saved: raws })));
}

function cmdPrioReorder(spec) {
  const cur = readPriority();
  if (!Array.isArray(cur) || !cur.length) return fail('还没有设置过优先级，先「重新输入」一次');
  const nums = String(spec || '').split(/[,，\s]+/).filter(Boolean).map(Number);
  if (!nums.length) return fail('请给出编号顺序，例如 3,1,2');
  if (nums.some((n) => !Number.isInteger(n) || n < 1 || n > cur.length)) {
    return fail(`编号必须在 1~${cur.length} 之间`);
  }
  if (new Set(nums).size !== nums.length) return fail('编号不能重复');
  if (nums.length !== cur.length) return fail(`需要给出全部 ${cur.length} 个编号`);
  const next = nums.map((n) => cur[n - 1]);
  writePriority(next);
  console.log(JSON.stringify(Object.assign(snapshot(), { ok: true, saved: next })));
}

function cmdPrioClear() {
  try { fs.unlinkSync(PR_FILE); } catch (e) { /* 本来就没有 */ }
  console.log(JSON.stringify(Object.assign(snapshot(), { ok: true, cleared: true })));
}

function cmdTimedSet(args) {
  const mode = String(args[0] || '').toLowerCase();
  ensureDataDir();
  if (mode === 'priority') {
    fs.writeFileSync(TM_FILE, 'priority\n', 'utf8');
    return console.log(JSON.stringify(snapshot()));
  }
  if (mode === 'window') {
    let wins;
    try {
      wins = parseWindowList([args.slice(1).join(' ')]);
    } catch (e) {
      return fail(e.message);
    }
    if (!wins || !wins.length) return fail('没有给出时间段，例如 window 18:00-20:00');
    const raw = wins.map((w) => w.raw).join(',');
    fs.writeFileSync(TM_FILE, `window ${raw}\n`, 'utf8');
    return console.log(JSON.stringify(snapshot()));
  }
  return fail('模式只能是 priority 或 window');
}

function cmdTimedClear() {
  try { fs.unlinkSync(TM_FILE); } catch (e) { /* 本来就没有 */ }
  console.log(JSON.stringify(Object.assign(snapshot(), { ok: true, cleared: true })));
}

// ── 一键开抢用的三个命令（2026-11-11 加）────────────────────────────────
//   mode-set default            → 下一次用默认优先级（清掉「这一次」）
//   mode-set once "16-18,17-19" → 只这一次用这组顺序（下一次定时抢用完自动清掉）
//   plan                        → 菜单主页要显示的一行 JSON：开关之外的都在这
function cmdModeSet(args) {
  const mode = String(args[0] || '').toLowerCase();
  if (mode === 'default') {
    clearOnce();
    writeMode('default');
    return console.log(JSON.stringify(snapshot()));
  }
  if (mode === 'once') {
    const text = args.slice(1).join(' ');
    let wins;
    try {
      const got = text ? parseWindowList([text]) : readOnce();
      if (got && got.error) throw new Error(got.error);
      wins = got;
    } catch (e) {
      return fail(e.message);
    }
    if (!Array.isArray(wins) || !wins.length) {
      return fail('「这一次」的优先级至少要给一段，例如 16:00-18:00,17:00-19:00');
    }
    if (wins.length > 12) return fail('最多 12 段（再多就不是「优先级」而是没想好）');
    writeOnce(wins.map((w) => w.raw));
    writeMode('once');
    return console.log(JSON.stringify(snapshot()));
  }
  return fail('模式只能是 default 或 once');
}

const WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
function ymd8(ms) {
  const d = new Date(ms + 8 * 3600e3);
  const p = (n) => String(n).padStart(2, '0');
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate());
}

function cmdPlan() {
  const DAY = 86400000;
  const now = Date.now();
  const TZ = 8 * 3600e3;
  // ★ 2026-11-11 修正：以前写死「today+2」，于是下午看面板会说「明早抢 11/13」，
  //   可明早 11/12 07:45 跑的是 T+2 = 11/14。这里先算出「下一次真会跑的时刻」：
  //     · 今天 07:45 之前   → 今天 07:45（今天这一枪还没打）
  //     · 07:45–08:05 之间 → 今天 08:05（主任务刚打完，等兜底）
  //     · 08:05 之后       → 明天 07:45
  //   再按「跑的那天 + 2」推目标日期。
  const bj = new Date(now + TZ);
  const hhmm = bj.getUTCHours() * 100 + bj.getUTCMinutes();
  let pendingOffset = 1;                 // 相对今天的天数
  if (hhmm < 745) pendingOffset = 0;
  else if (hhmm < 805) pendingOffset = 0;
  const targetMs = now + (pendingOffset + 2) * DAY;
  const target = ymd8(targetMs);
  const weekday = WEEKDAY[new Date(targetMs + TZ).getUTCDay()];
  const runDay = ymd8(now + pendingOffset * DAY);

  let priority = [];
  let source = 'config';
  const mode = readMode();
  const once = readOnce();
  const timed = readTimed();
  if (mode === 'once' && Array.isArray(once) && once.length) {
    priority = once; source = 'once';
  } else if (timed.mode === 'window') {
    priority = [timed.window]; source = 'window';
  } else {
    const pr = readPriority();
    if (Array.isArray(pr) && pr.length) { priority = pr; source = 'priority'; }
    else {
      try {
        const cfg = loadConfig().config;
        priority = (cfg.target.hourPriority || []).map((r) => r.raw || (r.from + '-' + r.to));
        source = 'config';
      } catch (e) { priority = []; }
    }
  }

  let last = null;
  try {
    const r = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'last-result.json'), 'utf8'));
    last = { status: r.status || '', targetDate: r.targetDate || '', slots: r.slots || '',
             orderNo: r.orderNo || '', at: r.at || '' };
  } catch (e) { last = null; }

  console.log(JSON.stringify({
    ok: true,
    mode,
    target,
    weekday,
    runAt: runDay + ' 07:45',
    rescueAt: runDay + ' 08:05',
    // 现在这一刻真正等着的是哪一枪（07:45 之后、08:05 之前就是兜底）
    pending: hhmm < 745 ? 'run' : (hhmm < 805 ? 'rescue' : 'run-tomorrow'),
    priority,
    prioritySource: source,
    // 定时抢一律走严格模式：优先级里凑不出连续空场就如实报没抢到，绝不捡别的时间段。
    strict: true,
    last,
  }));
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = String(argv[0] || 'show').toLowerCase();
  const rest = argv.slice(1);
  switch (cmd) {
    case 'show':
    case 'status':
      return console.log(JSON.stringify(snapshot()));
    case 'prio-set':
    case 'prio':
      return cmdPrioSet(rest);
    case 'prio-reorder':
      return cmdPrioReorder(rest[0]);
    case 'prio-clear':
      return cmdPrioClear();
    case 'timed-set':
      return cmdTimedSet(rest);
    case 'timed-clear':
      return cmdTimedClear();
    case 'mode-set':
      return cmdModeSet(rest);
    case 'plan':
      return cmdPlan();
    default:
      return fail(`不认识的命令：${cmd}`);
  }
}

main();
