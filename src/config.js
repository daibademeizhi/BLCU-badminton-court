'use strict';
/**
 * 配置加载与校验。
 *
 * 配置来源优先级：命令行 --config <file> > ./config.yaml > ./config.example.yaml
 * 解析：优先尝试可选依赖 js-yaml；不可用时回退到内置的极简 YAML 子集解析器
 *      （支持嵌套映射、数组、行内数组、注释、引号标量 —— 覆盖本项目配置所需语法）。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// ───────────────────────── 极简 YAML 子集解析器 ─────────────────────────

function stripComment(line) {
  let out = '';
  let inS = false;
  let inD = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inD) inS = !inS;
    else if (ch === '"' && !inS) inD = !inD;
    else if (ch === '#' && !inS && !inD && (i === 0 || /\s/.test(line[i - 1]))) break;
    out += ch;
  }
  return out.replace(/\s+$/, '');
}

function parseScalar(raw) {
  const s = raw.trim();
  if (s === '') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d*\.\d+$/.test(s)) return parseFloat(s);
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    if (!inner) return [];
    // ★ 必须按**括号深度**切分，不能直接 split(',')：
    //   课表写成 [['08:00','09:40'], ['10:10','11:50']] 时，朴素 split 会把内层数组
    //   切碎（"['08:00'" / "'09:40']" …）。生成 config.yaml 的等价性断言就是这样
    //   逮到问题的。
    const parts = [];
    let depth = 0;
    let inQuote = null;
    let buf = '';
    for (let i = 0; i < inner.length; i++) {
      const ch = inner[i];
      if (inQuote) {
        buf += ch;
        if (ch === inQuote) inQuote = null;
        continue;
      }
      if (ch === '"' || ch === "'") { inQuote = ch; buf += ch; continue; }
      if (ch === '[' || ch === '{') depth++;
      if (ch === ']' || ch === '}') depth--;
      if (ch === ',' && depth === 0) { parts.push(buf); buf = ''; continue; }
      buf += ch;
    }
    parts.push(buf);
    return parts.filter((x) => x.trim() !== '').map((x) => parseScalar(x));
  }
  return s;
}

/** 把 YAML 文本切成 [缩进, 内容] 序列（丢弃空行与纯注释行） */
function tokenize(text) {
  const lines = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = stripComment(raw);
    if (!line.trim()) continue;
    const indent = line.match(/^ */)[0].length;
    lines.push({ indent, text: line.trim() });
  }
  return lines;
}

function parseBlock(lines, pos, indent) {
  if (pos >= lines.length) return { value: null, next: pos };
  const isSeq = lines[pos].text.startsWith('- ') || lines[pos].text === '-';
  const container = isSeq ? [] : {};
  let i = pos;

  while (i < lines.length) {
    const cur = lines[i];
    if (cur.indent < indent) break;
    if (cur.indent > indent) throw new Error(`YAML 缩进异常: "${cur.text}"`);

    if (isSeq) {
      if (!cur.text.startsWith('-')) break;
      const rest = cur.text.slice(1).trim();
      if (rest === '') {
        const sub = parseBlock(lines, i + 1, lines[i + 1] ? lines[i + 1].indent : indent + 2);
        container.push(sub.value);
        i = sub.next;
      } else if (/^[^:]+:\s/.test(rest) || /^[^:]+:$/.test(rest)) {
        // 数组项是映射：把 "- key: value" 提升为一个虚拟缩进层级
        const virtual = [{ indent: indent + 2, text: rest }];
        let j = i + 1;
        while (j < lines.length && lines[j].indent > indent) {
          virtual.push(lines[j]);
          j++;
        }
        const sub = parseBlock(virtual, 0, indent + 2);
        container.push(sub.value);
        i = j;
      } else {
        container.push(parseScalar(rest));
        i++;
      }
    } else {
      const ci = cur.text.indexOf(':');
      if (ci < 0) throw new Error(`YAML 非法行: "${cur.text}"`);
      const key = cur.text.slice(0, ci).trim();
      const rest = cur.text.slice(ci + 1).trim();
      if (rest !== '') {
        container[key] = parseScalar(rest);
        i++;
      } else {
        const nextLine = lines[i + 1];
        if (!nextLine || nextLine.indent <= indent) {
          container[key] = null;
          i++;
        } else {
          const sub = parseBlock(lines, i + 1, nextLine.indent);
          container[key] = sub.value;
          i = sub.next;
        }
      }
    }
  }
  return { value: container, next: i };
}

function parseYaml(text) {
  const lines = tokenize(text);
  if (!lines.length) return {};
  return parseBlock(lines, 0, lines[0].indent).value;
}

function loadYamlFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  try {
    // 可选依赖：装了 js-yaml 就用它，功能更全
    const yaml = require('js-yaml');
    return yaml.load(text);
  } catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND') return parseYaml(text);
    throw e;
  }
}

// ───────────────────────── 配置模型 ─────────────────────────

const DEFAULTS = {
  baseUrl: 'https://tygyypt.blcu.edu.cn',
  prefix: '/service/appointment/appointment',
  venue: {
    nodeid: '1241984413986988032',
    name: '羽毛球',
  },
  auth: {
    token: '',
    usercode: '',
    // 允许脚本用「学号」自动换发新 token（POST /phone/login/idSerialLogin）。
    // 默认 false = 安全闸门关闭状态，脚本只验证不换发；想免除手动喂 token 就改成 true。
    // ⚠️ 该接口对学号不做二次校验（学校平台的鉴权缺陷），因此只填你自己的学号。
    allowRenew: false,
    // 启动时若 token 剩余寿命低于这个值（分钟），就自动换发
    renewBeforeMin: 10,
  },
  target: {
    // 目标日期。留空 = 自动取「服务端当前能订的最后一天」（T+2，即每天 08:00 刚放出的那天）。
    // 注意：写死日期会盖掉命令行 --date / --rel —— CLI 优先级最高，但一旦这里是 10 个字符的
    // 日期字符串，cron 里写的 --rel 2 就完全不起作用（2026-10-11 踩过这个坑）。
    // ★ 历史上这里还有一个 dateMode: auto|fixed 键，但**没有任何代码读它**，已删除，
    //   免得它假装能控制行为（用户改成 fixed 也不会有任何效果）。
    date: '',
    // 时段优先级：数组顺序即优先级；支持 "18:00-20:00"（精确2小时）或 ["18:00","20:00"]
    hourPriority: [['18:00', '20:00']],
    // 场地优先级：数组顺序即优先级，留空 = 任意场地
    courtPriority: [],
    // 同一场地约束：true = 必须存在同一场地能连续提供所需全部时段
    sameCourt: true,
    // 最少几个时段（1 个时段 = 1 小时）。显式写 2 = 凑不满 2 小时就不订。
    minSlots: 2,
    // 最多几个时段
    maxSlots: 2,
    // 课表冲突容忍度（分钟）：显式偏好时段与上课时间重叠超过这个值就整条降级到末尾。
    // 0 = 一点都不能重叠；30 = 允许蹭到课前半小时（默认）。
    conflictGraceMin: 30,
    // 课表：按星期几写「有课」的时间区间，抢场时会自动避开。
    // 留空 {} → 用 grab.js 里的内置课表（DEFAULT_SCHEDULE，钟点待用户核对）。
    // classes = 有课；free = 把某些课标成「其实不上」（可在已有区间上打洞）。
    schedule: { classes: {}, free: {} },
  },
  schedule: {
    // 触发时刻：优先用服务端 nextReleaseAt；该值为空时的兜底时间
    fallbackTriggerTime: '08:00:00',
    // 提前多久启动（毫秒）
    leadMs: 1200,
    // 放场前「慢速候场」复查间隔（毫秒）。放场前只按这个节奏拉网格，
    // 避免为了盯 08:00 而在 07:5x 就把服务器打满。默认 15 秒。
    idlePollMs: 15000,
    // ★ 收尾窗口：离放场时刻不足 finalPollWindowMs 时，把复查节奏从 idlePollMs
    //   收紧到 finalPollMs。起因是 2026-10-25 实测：候场固定 15 秒一次，
    //   08:00:00 开闸后直到 08:00:17.7 才第一次看到「窗口已开」，白晚 17 秒冲刺。
    //   当天抢的是冷门时段没出事；换成秒没的 16:00-18:00 就等于必输。
    finalPollWindowMs: 60000,
    finalPollMs: 500,

    // ★ 放场瞬间快通道（2026-10-28 实测补丁）：离放场时刻 ±releaseRaceMs 内不再睡，
    //   候场连着一轮一轮快查 —— 窗口一滚开就当场转入冲刺。
    //   实测：服务端 08:00:01.1 才滚开窗口，旧逻辑还要再睡满 500ms 才复查，
    //   于是 08:00:02.0 才看到窗口；改完「看到就冲」，不再多等一拍。
    //   0 = 关闭快通道（退回 finalPollMs 节奏）。
    releaseRaceMs: 5000,
    // 放场时刻之后的宽限期（毫秒）：服务端放场可能晚十几秒到几分钟。
    // 宽限期内持续复查目标日期；超过这个期限还没放出来就放弃本轮（绝不抢其它日期）。
    guardGraceMs: 180000,
    // 预热阶段轮询放场状态的间隔（毫秒）
    warmupPollMs: 20000,
    // 冲刺阶段轮询可用时段的间隔（毫秒）
    burstPollMs: 120,
    // 冲刺阶段最长持续（毫秒）
    burstDurationMs: 90000,
    // 命中一次后是否继续尝试其它时段（false = 抢到即停，推荐）
    stopOnFirstHit: true,
  },
  net: {
    timeoutMs: 20000,
    minIntervalMs: 120,
    maxReservationAttempts: 6,
    retriesOnNetworkError: 2,
  },
  safety: {
    // 硬上限：整个进程最多发出多少次下单请求（熔断，防误伤服务器）
    maxReservationPostsPerRun: 8,
    // 同日最多持有订单数（学校规则），命中后即停
    maxOrdersPerDay: 1,
    dryRun: false,
  },
  pay: {
    // auto    = 自动挑一条「服务端能跑完」的通道直接扣款：
    //            优先 78（账户卡余额 → /mobile/pay/accountPayOrder，需要 accno + 密码）
    //            其次 77（一卡通支付 → /mobile/pay/openPlatFormPayOrder，无需 accno/密码）
    //            2026-10-10 实测 BLCU 本账号只有 50（统一支付平台，必跳浏览器）与 77，故实际走 77
    //            任何一步失败都自动降级为「锁场 + 推提醒」，不会反复重试
    // semi    = 只下单锁场，推送付款提醒，你在微信里付（默认、最稳）
    // skip    = 只下单不支付也不提醒
    mode: 'semi',
    // 留空 = 自动按 78 → 77 选通道；填了则强制指定（仍会校验它是否真的可用）
    payway: '',
    // 校园卡账号（一卡通号），仅 78 通道需要。留空时脚本用 getPaywayList 返回的 banknum 自动填充
    accno: '',
    // 卡支付密码，仅 78 通道需要（77 学校配置为不校验密码）。
    // 留空且在 78 通道下 → auto 模式会停在「已备好订单，请手动支付」
    // ⚠️ 填写后本文件等价于支付凭证文件，务必不要提交到仓库/云盘
    cardPassword: '',
    // 77（一卡通）是否需要支付密码：学校 checkYktPwd=true 的语义是「不校验」，
    // 故默认 false；仅当学校改回校验时才置 true
    yktPasswordRequired: false,
    // 演练开关：auto 模式下也只走到「校验通道 + 拿到 accno」，绝不提交支付
    dryRunPay: false,
    // 半自动模式下的通知方式
    notify: {
      console: true,
      webhookUrl: '',
    },
  },
  paths: {
    logs: 'logs',
    state: 'data',
  },
};

function deepMerge(base, over) {
  if (over === undefined || over === null) return base;
  if (Array.isArray(base) || Array.isArray(over)) return over;
  if (typeof base !== 'object' || typeof over !== 'object') return over;
  const out = Object.assign({}, base);
  for (const k of Object.keys(over)) out[k] = deepMerge(base[k], over[k]);
  return out;
}

/** 把 ["18:00","20:00"] 或 ["18:00-20:00"] 统一成 {from,to}（分钟数） */
function normalizeRange(item) {
  if (Array.isArray(item) && item.length === 2) {
    return { from: toMinutes(item[0]), to: toMinutes(item[1]), raw: `${item[0]}-${item[1]}` };
  }
  const s = String(item || '').replace(/[~—–至]/g, '-').trim();
  const m = s.match(/^(\d{1,2}):?(\d{2})?\s*-\s*(\d{1,2}):?(\d{2})?$/);
  if (!m) throw new Error(`无法解析时段 "${item}"，请用 "HH:MM-HH:MM" 或 ["HH:MM","HH:MM"]`);
  const from = parseInt(m[1], 10) * 60 + parseInt(m[2] || '0', 10);
  const to = parseInt(m[3], 10) * 60 + parseInt(m[4] || '0', 10);
  return { from, to, raw: `${fmt(m[1], m[2])}-${fmt(m[3], m[4])}` };
}

function fmt(h, m) {
  return `${String(h).padStart(2, '0')}:${String(m || '0').padStart(2, '0')}`;
}

function toMinutes(s) {
  const m = String(s).trim().match(/^(\d{1,2}):?(\d{2})?$/);
  if (!m) throw new Error(`无法解析时间 "${s}"`);
  return parseInt(m[1], 10) * 60 + parseInt(m[2] || '0', 10);
}

/** 解析单个时段字符串 "18:00-19:00" → {from,to} 分钟 */
function parseSlot(slot) {
  const m = String(slot).match(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return {
    from: parseInt(m[1], 10) * 60 + parseInt(m[2], 10),
    to: parseInt(m[3], 10) * 60 + parseInt(m[4], 10),
    raw: slot,
  };
}

/**
 * 解析「想要的时间段」，例如 "18:00-20:00" / "18:00~20:00" / "18-20"。
 *
 * 返回 { from, to, raw }（from/to 是当天的分钟数，0 = 00:00），解析不出来返回 null。
 *
 * ★ 为什么不用 normalizeRange：那个函数是为「config 文件已经写错了要报错」设计的，
 *   解析失败会 throw。而这里的输入来自命令行和交互菜单（用户手打的），
 *   一个笔误不该让整个抢场进程崩掉 —— 所以先返回 null，由调用方统一报错。
 */
function parseWindowSpec(spec) {
  const s = String(spec == null ? '' : spec).trim();
  if (!s) return null;
  const m = s
    .replace(/[~～—–－]|至|到/g, '-')
    .replace(/\s+/g, '')
    .match(/^(\d{1,2}):?(\d{2})?-(\d{1,2}):?(\d{2})?$/);
  if (!m) return null;
  const h1 = Number(m[1]);
  const n1 = Number(m[2] || 0);
  const h2 = Number(m[3]);
  const n2 = Number(m[4] || 0);
  if (!Number.isFinite(h1) || !Number.isFinite(h2)) return null;
  if (h1 < 0 || h1 > 23 || h2 < 0 || h2 > 24) return null;
  if (n1 < 0 || n1 > 59 || n2 < 0 || n2 > 59) return null;
  const from = h1 * 60 + n1;
  const to = h2 * 60 + n2;
  if (to <= from) return null;
  return { from, to, raw: `${fmt(h1, n1)}-${fmt(h2, n2)}` };
}

/**
 * 把 "--window / --priority 的值（可重复写、一个值里可逗号分隔）解析成 wins 列表。
 * 写法宽容（18-20 / 18:00~20:00 / 20:00 至 22:00），但**解析失败一律 throw**：
 * 这种错误必须在开抢之前就喊出来，不能等跑完一整轮才发现在空转。
 */
function parseWindowList(values) {
  const specs = [];
  for (const v of [].concat(values || [])) {
    for (const part of String(v == null ? '' : v).split(/[,，;；\/|]/)) {
      const t = part.trim();
      if (t) specs.push(t);
    }
  }
  if (!specs.length) return null;

  const wins = [];
  const bad = [];
  for (const s of specs) {
    const w = parseWindowSpec(s);
    if (!w) { bad.push(s); continue; }
    if (!wins.some((x) => x.from === w.from && x.to === w.to)) wins.push(w);
  }
  if (bad.length) {
    throw new Error(
      `时间段看不懂：${bad.join('、')}。正确写法：18:00-20:00（也可写 18-20；` +
      '多段用逗号分隔，如 18:00-20:00,20:00-22:00）'
    );
  }
  if (!wins.length) throw new Error('没有解析出任何有效时间段');
  return wins;
}

/**
 * ★ 「按优先级依次试」而不是「只要这一段」：只覆盖排序偏好，**保留兜底**。
 *
 * 与 applyWindowOverrides 的区别只有一处，但语义差很远：
 *   - applyWindowOverrides（--window）  = 约束：只在这几段里选，没有就收手；
 *   - applyPriorityOverrides（--priority）= 偏好：先试第 1 段，再第 2 段……
 *     全都不行时仍然允许兜底到当天其它空档（由 grab.js 的 fallbackRange 负责）。
 *
 * 定时抢的「按优先级顺序」模式用的就是后者：用户想让 16-18 优先，
 * 但绝不希望因为 16-18 满场就白等一天。
 */
function applyPriorityOverrides(cfg, opts) {
  const wins = parseWindowList(opts && opts.priority);
  if (!wins) return null;
  cfg.target.hourPriority = wins.map((w) => ({ from: w.from, to: w.to, raw: w.raw }));
  return { windows: wins, minSlots: null, strict: false };
}

/**
 * 把命令行/菜单指定的时间段落到 config.target 上（**就地改，不写回文件**）。
 *
 * opts.windows：字符串或字符串数组，每个值可以写成 "18:00-20:00"，
 *               也可以用逗号分隔多段（"18:00-20:00,20:00-22:00"）。
 * opts.slots：  这一单最少凑几个时段（1 个 = 1 小时），不填就沿用 config.target.minSlots。
 *
 * 两条语义（都是为了「用户说了只要这一段，就别自作主张」）：
 *   ① 指定窗口后 hourPriority 只留这几段，并且 grab.js 会关掉「偏好落空就兜底到
 *      当天任意空档」—— 否则用户要 18:00-20:00，脚本可能在它满场时偷偷去抢早上。
 *   ② 窗口只有 1 小时时 minSlots 自动降到 1。不降的话「最少 2 小时」这条规则会让
 *      这个窗口永远凑不出候选，表现为「一声不响地抢不到」。
 *
 * 解析失败 / 自相矛盾（比如 --slots 2 配一个 1 小时的窗口）一律 throw ——
 * 这种错误必须在**开抢之前**就喊出来，不能等跑完一整轮才发现在空转。
 */
function applyWindowOverrides(cfg, opts) {
  const wins = parseWindowList(opts && opts.windows);
  if (!wins) return null;

  const shortestHours = Math.min(...wins.map((w) => (w.to - w.from) / 60));
  const cfgMax = Number(cfg.target.maxSlots);
  const maxSlots = Number.isFinite(cfgMax) && cfgMax > 0 ? cfgMax : 2;
  const explicit = Number(opts && opts.slots);
  let minSlots;
  if (Number.isFinite(explicit) && explicit >= 1) {
    if (explicit > shortestHours) {
      throw new Error(
        `--slots ${explicit} 装不进 ${shortestHours} 小时的窗口（${wins.map((w) => w.raw).join(' / ')}）`
      );
    }
    if (explicit > maxSlots) {
      throw new Error(`--slots ${explicit} 超过单张单的时段上限 maxSlots=${maxSlots}`);
    }
    minSlots = Math.floor(explicit);
  } else {
    const cfgMin = Number(cfg.target.minSlots);
    const base = Number.isFinite(cfgMin) && cfgMin > 0 ? cfgMin : 1;
    minSlots = Math.max(1, Math.min(base, maxSlots, Math.floor(shortestHours)));
  }

  cfg.target.hourPriority = wins.map((w) => ({ from: w.from, to: w.to, raw: w.raw }));
  cfg.target.minSlots = minSlots;
  if (maxSlots < minSlots) cfg.target.maxSlots = minSlots;
  return { windows: wins, minSlots, strict: true };
}

function resolveConfigPath(explicit) {
  if (explicit) {
    const p = path.isAbsolute(explicit) ? explicit : path.resolve(process.cwd(), explicit);
    if (!fs.existsSync(p)) throw new Error(`配置文件不存在: ${p}`);
    return p;
  }
  const a = path.join(ROOT, 'config.yaml');
  const b = path.join(ROOT, 'config.example.yaml');
  if (fs.existsSync(a)) return a;
  if (fs.existsSync(b)) return b;
  throw new Error('未找到 config.yaml，请先 cp config.example.yaml config.yaml 并填写 token');
}

function loadConfig(explicitPath) {
  const file = resolveConfigPath(explicitPath);
  const raw = loadYamlFile(file) || {};
  const cfg = deepMerge(DEFAULTS, raw);

  cfg.__file = file;
  cfg.__root = ROOT;

  // 归一化时段优先级
  cfg.target.hourPriority = (cfg.target.hourPriority || []).map(normalizeRange);
  cfg.target.courtPriority = (cfg.target.courtPriority || []).map(String);

  // ★ 课表：把 { mon: [["08:00","09:40"], …], … } 归一化成 { mon: [{from,to}, …], … }
  //   解析不出来的条目直接丢掉（宁可少避让一个时段，也不要因为一条坏配置就整体报错）。
  const normDayMap = (m) => {
    const out = {};
    if (!m || typeof m !== 'object' || Array.isArray(m)) return out;
    for (const [k, v] of Object.entries(m)) {
      if (!Array.isArray(v)) continue;
      const list = [];
      for (const it of v) {
        if (!Array.isArray(it) || it.length < 2) continue;
        const a = toMinutes(it[0]);
        const b = toMinutes(it[1]);
        if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) continue;
        list.push({ from: a, to: b });
      }
      out[String(k)] = list;
    }
    return out;
  };
  if (!cfg.target.schedule || typeof cfg.target.schedule !== 'object') cfg.target.schedule = { classes: {}, free: {} };
  cfg.target.schedule.classes = normDayMap(cfg.target.schedule.classes);
  cfg.target.schedule.free = normDayMap(cfg.target.schedule.free);

  if (!cfg.venue.nodeid) throw new Error('venue.nodeid 不能为空');
  if (!cfg.target.hourPriority.length) throw new Error('target.hourPriority 不能为空');

  cfg.baseUrl = String(cfg.baseUrl).replace(/\/+$/, '');
  cfg.prefix = String(cfg.prefix).replace(/\/+$/, '');

  return { config: cfg, file };
}

module.exports = {
  loadConfig,
  parseYaml,
  deepMerge,
  normalizeRange,
  parseWindowSpec,
  parseWindowList,
  applyWindowOverrides,
  applyPriorityOverrides,
  parseSlot,
  toMinutes,
  DEFAULTS,
  ROOT,
};
