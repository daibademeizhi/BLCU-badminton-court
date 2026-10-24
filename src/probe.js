'use strict';
/**
 * 只读探测工具（联调第一步，不会产生任何订单、不修改任何数据）
 *
 * 用途：拿到 token 后，把「抢场所需知道的一切」全部读出来并落盘。
 * 安全：只用查询类接口（getBookingTimeRange / getAppointmentTimeSlot /
 *       getSiteAppointInfo / getConfigDataByType / getPaywayList）。
 *
 * 运行：
 *   node src/probe.js set-token <token> [学工号]   # 把 token 写进 config.yaml 并立刻验证
 *   node src/probe.js check    # 验证 token + 读放场表 + 目标日期可用时段（默认）
 *   node src/probe.js courts   # 枚举所有可订日期的场地与时段
 *   node src/probe.js pay      # 只读地探支付通道（取价 + 支付方式列表，不下单）
 *
 * 产出：终端结论 + logs/probe-<时间戳>.json（完整原始响应）
 */

const fs = require('fs');
const path = require('path');

const { ApiClient } = require('./client');
const { loadConfig } = require('./config');
const { fmtTime, fmtFull, toMinutes, ServerClock } = require('./util');
const { pickAccno, pickAutoChannel, channelNeedsPassword, describePayway, CHANNELS } = require('./pay');
const { parseNodeAppointGrid } = require('./target');

const rule = (t) => {
  console.log('\n' + '─'.repeat(70));
  if (t) console.log(' ' + t);
  console.log('─'.repeat(70));
};

function makeClient(cfg) {
  return new ApiClient({
    baseUrl: cfg.baseUrl,
    prefix: cfg.prefix,
    token: cfg.auth.token,
    timeout: cfg.net.timeoutMs,
    minInterval: Math.max(cfg.net.minIntervalMs, 250),
    verbose: !!cfg.verbose,
  });
}

/**
 * 验证 token 是否有效，并尽量确认身份。
 *
 * ⚠️ 教训（2026-10-10 实测）：`/phone/getUserInfoByIdCard` 对任何 token 都返回 403，
 * 它**不能**用来判断 token 有效性 —— 之前把它当第一判据，导致有效 token 被误报成
 * 「token 被拒绝」。真正的判据是业务接口（getBookingTimeRange）+ getPhoneHome。
 */
async function probeIdentity(api, cfg, dump) {
  // ① 权威判据：业务接口能读通 = token 有效
  try {
    const r = await api.call('/phone/getBookingTimeRange', { nodeid: cfg.venue.nodeid }, { retries: 0 });
    dump.steps.identity = { path: '/phone/getBookingTimeRange', ok: true, response: r };
    console.log('  ✅ token 有效（getBookingTimeRange 读通）');
    if (!cfg.auth.usercode) {
      console.log('     ⚠️  config.yaml 里的 usercode（学工号）还是空的 —— 下单时 reservationPerson 必须填对');
    }
    return true;
  } catch (e) {
    if (e.status === 401) {
      console.error(`\n❌ token 已失效（HTTP 401）—— 请按「从浏览器开发者工具里抓一次 token」的办法 重新抓取。\n`);
      dump.steps.identity = { path: '/phone/getBookingTimeRange', error: 'HTTP 401' };
      return false;
    }
    if (e.status === 403) {
      // 403 可能是 token 缺失/被 WAF 拦，也可能是这个接口本身要额外参数；
      // 继续用下一组接口交叉验证，不要急着下"token 无效"的结论。
      console.warn(`  ⚠️  getBookingTimeRange 返回 403（继续交叉验证其它接口…）`);
      dump.steps.identity = { path: '/phone/getBookingTimeRange', error: 'HTTP 403' };
    } else {
      dump.steps.identity = { path: '/phone/getBookingTimeRange', error: `${e.status || ''} ${e.message}` };
      console.warn(`  ⚠️  getBookingTimeRange 失败：${e.message}`);
    }
  }

  // ② 交叉验证：getPhoneHome（能返回 nodeList 说明身份被接受）
  try {
    const r = await api.call('/phone/getPhoneHome', {}, { retries: 0 });
    const nodes = (r && r.nodeList) || [];
    console.log(`  ✅ 身份被接受（getPhoneHome 返回 ${nodes.length} 个场馆节点）`);
    console.log(`     场馆：${nodes.slice(0, 6).map((n) => n.nodename).join('、')}${nodes.length > 6 ? '…' : ''}`);
    dump.steps.home = { nodeList: nodes };
    return true;
  } catch (e) {
    dump.steps.home = { error: `${e.status || ''} ${e.message}` };
    console.error(`  ❌ getPhoneHome 也失败（HTTP ${e.status || '?'}）：${e.message}`);
    if (e.status === 401 || e.status === 403) {
      console.error('     两个接口都不通 —— token 大概率已失效，请重新抓取。\n');
      return false;
    }
  }
  return true;
}

function printRange(d, clock) {
  const list = Array.isArray(d.dateList) ? d.dateList : [];
  console.log(`  releaseStatus   ${d.releaseStatus || '（空）'}    releaseOpen ${d.releaseOpen}    releaseMode ${d.releaseMode || '—'}`);
  console.log(`  nextReleaseAt   ${d.nextReleaseAt || '（空）'}`);
  if (d.nextReleaseAt) {
    const ms = clock._parse(d.nextReleaseAt);
    if (ms) {
      console.log(`                  = ${fmtFull(ms)}（服务器时间线），距现在 ${((ms - clock.now()) / 1000 / 60).toFixed(1)} 分钟`);
    }
  }
  console.log(`  可订窗口        ${d.bookingstarttime || '—'} ~ ${d.bookingendtime || '—'}`);
  console.log(`  maxbooktime     ${d.maxbooktime}    minselectnum ${d.minselectnum}    floorNum ${d.floorNum}`);
  if (d.userMessage) console.log(`  服务端提示      ${d.userMessage}`);

  console.log(`\n  —— dateList（${list.length} 天，status="1" 才是已开放可订）——`);
  const open = list.filter((x) => String(x.status) === '1');
  for (const it of list) {
    const mark = String(it.status) === '1' ? '✅' : '  ';
    console.log(`  ${mark} ${it.date}   status=${it.status}`);
  }
  console.log(`  可订天数 ${open.length}／${list.length}`);
  return open;
}

function printSlots(value, slots) {
  const arr = Array.isArray(slots) ? slots : [];
  console.log(`\n  ── ${value} ── 共 ${arr.length} 个时段，可订（status="1"）：`);
  const open = arr.filter((s) => String(s && s.status) === '1');
  if (!open.length) {
    console.log('     （今日无场）');
    return open;
  }
  const byHour = new Map();
  for (const s of open) byHour.set(s.value, (byHour.get(s.value) || 0) + 1);
  console.log('     ' + open.map((s) => s.value).join('  '));
  return open;
}

async function runCheck(cfg, api, dump) {
  const clock = new ServerClock();
  const badminton = (cfg.target.hourPriority || []).map((r) => `${r.raw}`).join(' > ');

  rule('[1/4] 验证 token');
  const ok = await probeIdentity(api, cfg, dump);
  if (!ok) return 2;

  rule('[2/4] 放场时刻表（最关键的一步）');
  const t0 = Date.now();
  const range = await api.getBookingTimeRange(cfg.venue.nodeid);
  const t1 = Date.now();
  dump.steps.bookingTimeRange = { t0, t1, data: range };

  const srv = clock._parse(range.serverNow) || clock._parse(range.serverToday);
  if (srv) {
    const off = clock.calibrate(srv, t0, t1);
    console.log(`  服务器时间      ${range.serverNow || range.serverToday}`);
    console.log(`  本机时钟偏移    ${off >= 0 ? '+' : ''}${Math.round(off)} ms（往返 ${t1 - t0} ms）`);
  } else {
    console.log('  ⚠️  未读到 serverNow/serverToday，无法校准时钟');
  }
  const openDates = printRange(range, clock);

  rule('[3/4] 目标日期可用时段（整馆网格，与 grab.js 同源）');
  const pick = cfg.target.date || (openDates.length ? openDates[openDates.length - 1].date : (range.dateList || [])[0]?.date);
  if (!pick) {
    console.log('  没有可用日期');
    return 0;
  }
  console.log(`  目标日期 ${pick}    用户优先级 ${badminton || '（未配置）'}`);
  if (String((range.dateList || []).find((x) => x.date === pick)?.status) !== '1') {
    console.log('  ⚠️  该日期尚未开放（status≠"1"），此时网格接口会回「暂未发布预约规则」，属正常现象');
  }

  // ★ 必须用 getNodeAppointInfoList（整馆网格），不能用 getAppointmentTimeSlot。
  //   getAppointmentTimeSlot 只回答「这一天这个时段是否对外放号」，**不反映某片场地是否已被订走**
  //   —— 2026-10-10 实测它把 10-12 全天 14 个时段都报成 status=1，而网格显示 6 片场地
  //   各有大半被教学/预约占满。抢场判断必须基于网格的 disabled 标志（见 src/target.js）。
  const gridRes = await api.getNodeAppointInfoList({ parentNodeId: cfg.venue.nodeid, appointDate: pick });
  const grid = gridRes && gridRes.success && gridRes.resultData ? parseNodeAppointGrid(gridRes.resultData, { date: pick }) : null;
  dump.steps.grid = { date: pick, ok: !!grid, raw: gridRes };

  if (!grid) {
    console.log(`  网格获取失败：${(gridRes && gridRes.message) || '无数据'}`);
    return 0;
  }
  console.log(`  场地 ${grid.courts.length} 片`);
  const open = grid.slots
    .map((s) => ({ label: s.time, value: s.time, free: s.bookableCount, detail: s }))
    .filter((s) => s.free > 0);
  if (!open.length) {
    console.log('  该日期整馆无空位');
  } else {
    for (const s of open) {
      console.log(`     ${s.value}  ✅ ${s.free} 片空`);
    }
  }

  rule('[4/4] 该日期能不能凑出目标时段');
  const prio = cfg.target.hourPriority || [];
  const hitPrio = prio.filter((r) => open.some((s) => overlap(s.value, r)));
  if (!open.length) {
    console.log('  目标日期暂无可用时段（放场前正常）');
  } else if (hitPrio.length) {
    console.log(`  ✅ 命中优先级第 ${prio.indexOf(hitPrio[0]) + 1} 档：${hitPrio[0].raw}`);
    console.log('  → 可以直接跑抢场：node src/grab.js --dry-run');
  } else {
    console.log(`  ⚪ 有场但都不在优先级表内（优先级表：${badminton}）`);
  }
  return 0;
}

async function runCourts(cfg, api, dump) {
  rule('枚举所有可订日期的场地与时段');
  const range = await api.getBookingTimeRange(cfg.venue.nodeid);
  dump.steps.bookingTimeRange = { data: range };
  const dates = (range.dateList || []).filter((x) => String(x.status) === '1').map((x) => x.date);
  if (!dates.length) {
    console.log('  当前没有任何已开放可订的日期（放场前正常）');
    return 0;
  }
  console.log(`  可订日期：${dates.join(', ')}`);
  dump.steps.daySlots = [];
  for (const date of dates) {
    const tl = await api.getAppointmentTimeSlot(date, cfg.venue.nodeid);
    const open = tl.filter((s) => String(s.status) === '1');
    dump.steps.daySlots.push({ date, total: tl.length, open: open.map((s) => s.value) });
    console.log(`\n  ── ${date} ── 共 ${tl.length} 个时段，可订 ${open.length} 个`);
    if (open.length) console.log('     ' + open.map((s) => s.value).join('  '));
  }
  return 0;
}

async function runPay(cfg, api, dump) {
  rule('[1/3] 支付相关系统配置');
  const fn = await api.getConfigData('appoint_function');
  dump.steps.payConfig = fn;
  const pick = (c) => {
    const it = (fn || []).find((x) => x.code === c);
    return it ? it.value : '（未配置）';
  };
  for (const c of ['openApprove', 'openFreeHour', 'openContinuousTimeCheck', 'isYktRefund', 'openDeposit']) {
    console.log(`  ${c.padEnd(26)} ${pick(c)}`);
  }
  console.log('  → openApprove=false 表示下单后无需审批；isYktRefund=true 表示校园卡通道存在');

  rule('[2/3] 从网格里找一个真实可订时段用于取价（只读）');
  const range = await api.getBookingTimeRange(cfg.venue.nodeid);
  dump.steps.bookingTimeRange = { data: range };
  const dates = (range.dateList || []).filter((x) => String(x.status) === '1').map((x) => x.date);
  // ★ 用 getNodeAppointInfoList（整馆网格）而不用 getSiteAppointInfo —— 后者对本场馆恒失败
  //   详见网格接口的实测结论；网格是 grab.js 实际使用的数据源，这里保持一致
  let target = null;
  for (const date of dates) {
    const res = await api.getNodeAppointInfoList({ parentNodeId: cfg.venue.nodeid, appointDate: date });
    if (!res || !res.success || !res.resultData) {
      console.log(`  ${date}：${(res && res.message) || '无数据'}`);
      continue;
    }
    const grid = parseNodeAppointGrid(res.resultData, { date });
    const hit = grid && grid.slots.find((s) => s.bookableCount > 0);
    if (!hit) {
      console.log(`  ${date}：整馆无空位`);
      continue;
    }
    const courtId = hit.bookableCourts[0];
    target = { date, slot: hit.time, courtId };
    console.log(`  选中 ${date} ${hit.time}（${date} 有 ${grid.slots.filter((s) => s.bookableCount > 0).length} 个时段有空位）`);
    break;
  }
  if (!target) {
    console.log('  当前没有任何可订时段，无法取价（放场后再来探）');
    return 0;
  }
  const courtId = target.courtId;

  rule('[3/3] 取价 + 支付方式列表');
  const appointInfo = [{ nodeid: courtId, time: target.slot }];
  const price = await api.getPayPrice({
    reserveDate: target.date,
    priceType: '3',
    nodeid: cfg.venue.nodeid,
    appointmentType: '2',
    reservationPerson: cfg.auth.usercode,
    appointInfo,
  });
  console.log(`  getPayPrice → ${price}（元）`);
  dump.steps.price = price;

  try {
    // ⚠️ 实测（2026-10-10）：getPaywayList 会**间歇性 500** —— 同一个 payload 前 3 次成功、
    //    随后连续 5 次 500「获取抵扣次数信息异常」。这是服务端「抵扣次数」子服务的抖动，
    //    不是 payload 问题（单时段/双时段都成功过）。故这里显式重试，抢场时同理。
    const ways = await api.getPaywayList(
      {
        parentNodeId: cfg.venue.nodeid,
        appointInfo,
        appointDetail: [{ nodeid: courtId, appointDetail: [{ appointDate: target.date, timeInfo: target.slot }] }],
        appointDate: target.date,
        booktype: '2',
        wxType: '',
      },
      { retries: 4 }
    );
    dump.steps.payways = ways;
    const list = Array.isArray(ways) ? ways : [];
    console.log(`  getPaywayList → ${list.length} 种：`);
    for (const w of list) {
      const auto = CHANNELS.find((spec) => spec.payway === String(w.payway));
      console.log(
        `     payway=${String(w.payway).padEnd(4)} ${(w.payname || w.paywayname || w.cardtypename || w.title || '').padEnd(14)}` +
        ` 金额=${w.payprice != null ? w.payprice : '-'}  banknum=${w.banknum || '-'}  ` +
        `accno=${w.accno || '-'}  ${auto ? '★ 可纯服务端自动支付' : '（需人工/客户端）'}`
      );
    }

    // 复用 AutoPay 的通道选择逻辑，保证 probe 的结论与真正开抢时一致
    const chosen = pickAutoChannel(list);
    if (!chosen) {
      const ways2 = list.map((w) => describePayway(w)).join('、');
      console.log(`  ! 没有可自动支付的通道（需要 78 或 77）→ auto 模式会降级为「锁场 + 通知你手动付」`);
      console.log(`    服务端提供：${ways2 || '（空）'}`);
      return 0;
    }
    const needsPwd = channelNeedsPassword(chosen, cfg);
    console.log(`  ★ 自动支付通道已选中：payway=${chosen.payway}（${chosen.name}）` +
      `  需要密码=${needsPwd ? '是（要配 pay.cardPassword）' : '否'}`);

    if (chosen.payway === '78') {
      const cardAccno = pickAccno(chosen.item);
      console.log(`     账号字段：banknum=${chosen.item.banknum || '(空)'}  accno=${chosen.item.accno || '(空)'}`);
      console.log(`     卡类型：cardtype=${chosen.item.cardtype || '(空)'}  cardtypename=${chosen.item.cardtypename || '(空)'}`);
      console.log('     -> 把下一行填进 config.yaml 的 pay.accno：');
      console.log(`        accno: "${cardAccno || '(服务端没给账号，需从微信支付页手抄)'}"`);

      // 阶段 0 演练：getCardPayPrice（只读；priceType="2" + getCardPrice=true）
      // 这一步只查询价格，不产生订单，是 auto 模式开抢前能安全验证的唯一环节
      try {
        const cardPrice = await api.getPayPrice({
          nodeid: cfg.venue.nodeid,
          reserveTime: [target.slot],
          reserveDate: target.date,
          accompanyPerson: [],
          reservationPerson: cfg.auth.usercode,
          appointmentType: '2',
          appointInfo,
          groupAppoint: false,
          cardtype: chosen.item.cardtype,
          priceType: '2',
          getCardPrice: true,
          notShowFailDia: true,
        });
        dump.steps.cardPrice = cardPrice;
        console.log(`     ★ getCardPayPrice 校验通过：卡价=${cardPrice} 元 —— 这张卡可用于本单`);
      } catch (e) {
        console.log(`     ! getCardPayPrice 失败：${e.message}`);
        console.log('       -> 该卡类型可能对本单不可用；auto 模式会在开抢时自动降级为人工支付');
      }
    } else {
      console.log(`     通道 77 无需 accno、无需密码，将提交 openPlatFormPayOrder：`);
      console.log(`        { txamt:"<金额>", orderno:"<下单返回>", payway:"77", accno:"", password:"" }`);
    }
    console.log('  → 结论：auto 模式可在服务端跑完支付；真正扣款发生在下单成功之后。');
  } catch (e) {
    console.log(`  getPaywayList 失败：${e.status || ''} ${e.message}`);
  }
  return 0;
}

function overlap(slotValue, range) {
  const m = String(slotValue || '').match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
  if (!m) return false;
  const from = Number(m[1]) * 60 + Number(m[2]);
  const to = Number(m[3]) * 60 + Number(m[4]);
  return Math.min(to, range.to) - Math.max(from, range.from) > 0;
}

// writeAuthToConfig 已抽到 src/authfile.js（login.js 也要用，放这里会形成循环依赖）
const { writeAuthToConfig } = require('./authfile');

/**
 * 解析 JWT 载荷并抽出身份。
 *
 * 本系统（本校 体育场馆预约平台）的 token 是 RSA 签名的 JWT，载荷形如：
 *   { exp, sub:"datalook", Operator: "{\"idserial\":\"<你的学号>\",\"username\":\"张三\",
 *                                        \"code\":\"1201\",\"roleid\":\"1201\",\"id\":2505291…}" }
 * 注意 Operator 是**被 JSON 字符串化的对象**，学号在 `idserial`，不是 payload.code（那里是角色码）。
 */
function jwtInfo(token) {
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  let payload = null;
  try {
    payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch (e) {
    return null;
  }
  let operator = null;
  try { operator = typeof payload.Operator === 'string' ? JSON.parse(payload.Operator) : payload.Operator; } catch (e) { /* ignore */ }

  const info = {
    payload,
    operator,
    idserial: (operator && operator.idserial) || payload.idserial || null,
    username: (operator && operator.username) || payload.username || payload.name || null,
    roleCode: (operator && operator.code) || null,
    exp: payload.exp || null,
    sub: payload.sub || null,
  };
  // 兜底：有些部署会直接把学号放进 usercode / userCode
  if (!info.idserial) {
    const alt = payload.usercode || payload.userCode;
    if (alt && /^\d{4,}$/.test(String(alt))) info.idserial = String(alt);
  }
  return info;
}

/** set-token：把 token/usercode 写进 config.yaml，并立刻验证一次 */
async function runSetToken(file) {
  const token = process.argv[3];
  const usercode = process.argv[4] || '';

  if (!token) {
    rule('用法');
    console.log('  node src/probe.js set-token <token> [学工号]');
    console.log('');
    console.log('  例：');
    console.log('    node src/probe.js set-token eyJhbGciOiJIUzI1NiJ9.xxx.yyy 2023123456');
    console.log('');
    console.log('  token 怎么拿 → 从浏览器开发者工具里抓一次 token（微信里登录一次，F12/抓包看请求头 token）');
    return 1;
  }

  const { config: cfg } = loadConfig();
  const clean = String(token).trim().replace(/^token:\s*/i, '').replace(/^["']|["']$/g, '');

  let detected = usercode.trim();
  const info = jwtInfo(clean);
  if (info) {
    if (!detected && info.idserial) detected = String(info.idserial);
    console.log('\n  JWT 载荷（token 自带的身份信息）：');
    if (info.username) console.log(`    username  = ${info.username}`);
    if (info.idserial) console.log(`    idserial  = ${info.idserial}   ← 这就是下单要用的 reservationPerson（学工号）`);
    if (info.roleCode) console.log(`    rolecode  = ${info.roleCode}`);
    if (info.sub) console.log(`    sub       = ${info.sub}`);
    if (info.exp) {
      const left = info.exp * 1000 - Date.now();
      console.log(`    exp       = ${info.exp}  (${new Date(info.exp * 1000).toLocaleString('zh-CN')})`);
      console.log(`    → 还剩 ${(left / 3600000).toFixed(1)} 小时（${left > 0 ? '尚未过期' : '★ 已过期！'}）`);
    }
  } else {
    console.log('\n  （这不是标准 JWT，跳过载荷解析；不影响使用）');
  }

  const res = writeAuthToConfig(file, clean, detected);
  console.log('\n  ✅ 已写入 config.yaml');
  console.log(`     token    ${clean.slice(0, 24)}…（${clean.length} 字符）`);
  console.log(`     usercode ${detected ? detected + (res.hitUser ? '' : '（解析自 JWT，请核对）') : '（空 —— 下单时必须填对，可再跑一次带上学工号）'}`);

  rule('立刻验证一次（只读接口）');
  const api = makeClient({ ...cfg, auth: { token: clean, usercode: detected } });
  try {
    const r = await api.call('/phone/getBookingTimeRange', { nodeid: cfg.venue.nodeid }, { retries: 0 });
    const open = (r.dateList || []).filter((d) => String(d.status) === '1').map((d) => d.date);
    console.log(`  ✅ token 有效！`);
    console.log(`     releaseStatus = ${r.releaseStatus || '-'}   releaseOpen = ${r.releaseOpen}`);
    console.log(`     nextReleaseAt = ${r.nextReleaseAt || '-'}   已开放日期 = ${open.join(', ') || '（无）'}`);
    console.log(`     可订窗口 ${r.bookingstarttime || '-'} ~ ${r.bookingendtime || '-'}   maxbooktime=${r.maxbooktime}  minselectnum=${r.minselectnum}`);
    return 0;
  } catch (e) {
    console.error(`  ❌ 验证失败：HTTP ${e.status || '?'} ${e.message}`);
    if (e.status === 401 || e.status === 403) {
      console.error('     token 被拒绝。请确认复制了完整的 token（含所有点号），且未混入 "token:" 前缀或空格。');
    } else {
      console.error('     网络或服务端问题，稍后重试；token 已写入 config.yaml。');
    }
    return 2;
  }
}

async function main() {
  const cmd = (process.argv[2] || 'check').toLowerCase();
  const { config: cfg, file } = loadConfig();

  if (cmd === 'set-token') {
    const code = await runSetToken(file);
    process.exit(code);
  }

  if (!cfg.auth.token && cfg.auth.allowRenew !== true) {
    console.error('\n❌ config.yaml 里的 auth.token 是空的。两条路：');
    console.error('   ① 推荐：设 auth.allowRenew: true 并填 auth.usercode —— 脚本自动换发（不需要微信/密码/验证码）');
    console.error('   ② 手动：node src/login.js --renew，或 node src/probe.js set-token <token> <学工号>\n');
    process.exit(1);
  }

  // 自动续期（与 grab.js 同一套逻辑）：快过期 / 已失效 / 为空时换发一个新 token
  if (cfg.auth.allowRenew === true) {
    try {
      const { ensureToken } = require('./login');
      const r = await ensureToken(cfg, { log: (l, m) => console.log(`  [${l}] ${m}`) });
      if (r.renewed) console.log(`  🔑 ${r.reason}`);
    } catch (e) {
      console.error(`\n❌ 自动续期失败：${e.message}`);
      console.error('   （若想手动处理：node src/login.js --renew）\n');
      process.exit(1);
    }
  }

  const api = makeClient(cfg);
  const dump = { probedAt: new Date().toISOString(), cmd, host: cfg.baseUrl, nodeid: cfg.venue.nodeid, steps: {} };

  console.log('='.repeat(70));
  console.log(' 本校 订场系统 —— 只读探测（不产生订单）');
  console.log('='.repeat(70));
  console.log(` 服务器     ${cfg.baseUrl}${cfg.prefix}`);
  console.log(` 配置文件   ${file}`);
  console.log(` 场馆 nodeid ${cfg.venue.nodeid}（${cfg.venue.name}）`);
  console.log(` usercode   ${cfg.auth.usercode || '（未配置！下单会失败）'}`);
  console.log(` 探测时间   ${fmtFull(Date.now())}（本机）`);

  let code = 0;
  try {
    if (cmd === 'check') code = await runCheck(cfg, api, dump);
    else if (cmd === 'courts') code = await runCourts(cfg, api, dump);
    else if (cmd === 'pay') code = await runPay(cfg, api, dump);
    else {
      console.error(`\n未知子命令：${cmd}（可用：set-token / check / courts / pay）\n`);
      process.exit(1);
    }
  } catch (e) {
    rule('探测中断');
    console.error(`  HTTP ${e.status || '?'}  ${e.message}`);
    if (e.status === 403) console.error('  token 被拒绝：检查 token 是否复制完整 / 是否已过期');
    if (e.status === 401) console.error('  token 已失效：重新抓一次');
    code = 3;
  }

  const outDir = path.join(__dirname, '..', 'logs');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const outFile = path.join(outDir, `probe-${stamp}.json`);
  fs.writeFileSync(outFile, JSON.stringify(dump, null, 2), 'utf8');

  rule('探测结束');
  const st = api.stats || {};
  console.log(`  API 调用  ${st.total || 0} 次（成功 ${st.ok || 0}／业务失败 ${st.bizFail || 0}／HTTP 失败 ${st.httpFail || 0}／鉴权失败 ${st.authFail || 0}）`);
  console.log(`  原始响应  ${outFile}`);
  console.log(`  ${fmtTime(Date.now())}`);
  console.log('\n  下一步：node src/grab.js --dry-run   （只观察不下单）\n');
  process.exit(code);
}

main().catch((e) => {
  console.error('\n探测异常终止：', e && e.stack ? e.stack : e);
  process.exit(1);
});
