'use strict';
/**
 * 自检：不接触你的账号，全部在本地跑（最后一个联网项只调用无需 token 的公共接口）。
 *
 *   node src/selftest.js            # 全部检查
 *   node src/selftest.js --offline  # 跳过联网检查
 */

const assert = require('assert');
const path = require('path');

const { parseYaml, loadConfig, normalizeRange, parseSlot, deepMerge, parseWindowSpec, parseWindowList, applyWindowOverrides, applyPriorityOverrides } = require('./config');
const { encrypt, decrypt, wrap } = require('./crypto');
const { buildPlans, extractCourts, orderCourts, findContiguousCombos } = require('./target');
const { ServerClock, fmtDate, toMinutes } = require('./util');
const { ApiClient } = require('./client');
const { AutoPay, pickAccno, money } = require('./pay');

let pass = 0;
let fail = 0;

function t(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ✗ ${name}\n      ${e.message}`);
  }
}

async function ta(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ✗ ${name}\n      ${e.message}`);
  }
}

function section(s) {
  console.log(`\n── ${s} ${'─'.repeat(Math.max(4, 60 - s.length))}`);
}

// ───────────────────────── 1. 加密 ─────────────────────────
section('1. AES 请求加密（复刻前端 84ad 模块）');

t('加密参数：AES-128-CBC / key=iv=0102030405060708 / 大写 HEX', () => {
  const hex = encrypt('{}');
  assert.strictEqual(hex, '66ADD6FE1DFEC38B60861EAA9430296F', `空对象密文不符：${hex}`);
});

t('已知向量：{"nodeid":"1241984413986988032"}', () => {
  const hex = encrypt('{"nodeid":"1241984413986988032"}');
  assert.strictEqual(
    hex,
    '90D43AE200805E9DA4234C2235B6FB3446EA78517212F529FBC114F5F6DAD24746FCB1661B9FAC7E97EB38C9AAE08FFE',
    `密文不符：${hex}`
  );
});

t('往返一致（含中文与数组）', () => {
  for (const v of [{ a: 1, b: '中文测试' }, [1, 2, 3], { deep: { list: ['x', 'y'] } }, '纯字符串']) {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    assert.strictEqual(decrypt(encrypt(s)), s);
  }
});

t('wrap() 产出 {"item":"<HEX>"} 且为 16 字节整数倍', () => {
  const w = wrap({ nodeid: '1241984413986988032' });
  assert.deepStrictEqual(Object.keys(w), ['item']);
  assert.ok(/^[0-9A-F]+$/.test(w.item), 'item 应为大写 HEX');
  assert.strictEqual(w.item.length % 32, 0, 'AES 分组应为 16 字节（32 hex 字符）的整数倍');
});

t('PKCS7 填充正确（恰好一块 → 补出完整新块）', () => {
  // 16 字节明文 = 一个 AES 块，PKCS7 必须再补一整块 0x10 -> 32 字节密文 = 64 hex
  assert.strictEqual(encrypt('0123456789abcdef').length, 64);
  // 15 字节明文只需补 1 字节 -> 仍是 16 字节密文
  assert.strictEqual(encrypt('0123456789abcde').length, 32);
});

// ───────────────────────── 2. 时间 ─────────────────────────
section('2. 时间线与时钟校准');

t('服务器时钟：RTT 最小的样本被采用', () => {
  const c = new ServerClock();
  const t0 = Date.now(); // calibrate 内部用本地中点，测试须以真实时钟为基准
  c.calibrate(t0 + 50 + 5000, t0, t0 + 100);      // rtt=100
  assert.strictEqual(Math.round(c.offset), 5000);
  c.calibrate(t0 + 50 + 6000, t0, t0 + 2000);     // rtt=2000，应被丢弃
  assert.strictEqual(Math.round(c.offset), 5000, '高延迟样本不应覆盖低延迟样本');
});

t('ServerClock 解析多种时间格式', () => {
  const c = new ServerClock();
  const base = Date.parse('2026-10-12T08:00:00');
  assert.strictEqual(c._parse('2026-10-12 08:00:00'), base, '空格分隔');
  assert.strictEqual(c._parse('2026-10-12T08:00:00'), base, 'ISO');
  assert.strictEqual(c._parse('2026-10-12T08:00:00.123456'), base + 123, '微秒截断到毫秒');
  assert.ok(c._parse(1750000000) > 1e12, '秒级时间戳应升为毫秒');
});

t('日期/分钟换算', () => {
  assert.strictEqual(toMinutes('18:00'), 1080);
  assert.strictEqual(toMinutes('08:30'), 510);
  assert.strictEqual(fmtDate(Date.parse('2026-10-12T15:30:00')), '2026-10-12');
});

// ───────────────────────── 3. 配置解析 ─────────────────────────
section('3. YAML 配置解析与归一化');

t('极简 YAML：嵌套映射 / 数组 / 行内数组 / 注释 / 引号', () => {
  const y = parseYaml(`
# 顶层注释
venue:
  nodeid: "1241984413986988032"   # 行尾注释
  name: 羽毛球
target:
  hourPriority:
    - ["18:00", "20:00"]
    - ["19:00", "21:00"]
  courtPriority: []
  sameCourt: true
net:
  timeoutMs: 20000
`);
  assert.strictEqual(y.venue.nodeid, '1241984413986988032');
  assert.strictEqual(y.venue.name, '羽毛球');
  assert.deepStrictEqual(y.target.hourPriority[0], ['18:00', '20:00']);
  assert.strictEqual(y.target.hourPriority.length, 2);
  assert.deepStrictEqual(y.target.courtPriority, []);
  assert.strictEqual(y.target.sameCourt, true);
  assert.strictEqual(y.net.timeoutMs, 20000);
});

t('时段归一化：数组形式与字符串形式等价', () => {
  const a = normalizeRange(['18:00', '20:00']);
  const b = normalizeRange('18:00-20:00');
  const c = normalizeRange('18:00~20:00');
  assert.deepStrictEqual([a.from, a.to], [1080, 1200]);
  assert.deepStrictEqual([b.from, b.to], [1080, 1200]);
  assert.deepStrictEqual([c.from, c.to], [1080, 1200]);
});

t('parseSlot 解析服务端时段字符串', () => {
  const s = parseSlot('18:00-19:00');
  assert.deepStrictEqual([s.from, s.to], [1080, 1140]);
  assert.strictEqual(parseSlot('垃圾数据'), null);
});

t('deepMerge：数组整体替换而非合并', () => {
  const base = { a: { list: [1, 2, 3], keep: 'x' } };
  const over = { a: { list: [9] } };
  const out = deepMerge(base, over);
  assert.deepStrictEqual(out.a.list, [9]);
  assert.strictEqual(out.a.keep, 'x');
});

t('★ 行内数组的嵌套：课表 [["08:00","09:40"], …] 必须解析成数组的数组', () => {
  // 这个回归点来自「生成 config.yaml 的等价性断言」：朴素 split(',') 会把内层数组切碎，
  // 于是 target.schedule.classes.mon 变成一串字符串，避让逻辑静默失效（不报错！）。
  const y = parseYaml(`
target:
  schedule:
    classes:
      mon: [['08:00', '09:40'], ['10:10', '11:50']]
      tue: [['10:10', '11:50']]
      fri: []
`);
  assert.deepStrictEqual(y.target.schedule.classes.mon, [['08:00', '09:40'], ['10:10', '11:50']]);
  assert.deepStrictEqual(y.target.schedule.classes.tue, [['10:10', '11:50']]);
  assert.deepStrictEqual(y.target.schedule.classes.fri, []);
  assert.ok(Array.isArray(y.target.schedule.classes.mon[0]), '内层必须还是数组');
});

ta('loadConfig 能把 target.schedule 归一化成 {from,to}（坏条目丢弃）', async () => {
  const example = path.resolve(__dirname, '..', 'config.example.yaml');
  const { config } = loadConfig(example);
  const sch = config.target.schedule;
  assert.ok(sch && typeof sch === 'object', 'schedule 必须存在');
  assert.ok(Number.isFinite(config.target.conflictGraceMin), 'conflictGraceMin 必须是数字');
  // 归一化结果只允许是 {from,to} 数字对
  for (const [day, list] of Object.entries(sch.classes)) {
    for (const r of list) {
      assert.ok(Number.isFinite(r.from) && Number.isFinite(r.to) && r.to > r.from,
        `${day} 的条目没归一化成 {from,to}：${JSON.stringify(r)}`);
    }
  }
});

ta('loadConfig 能加载 config.example.yaml 并给出完整默认值', async () => {
  const example = path.resolve(__dirname, '..', 'config.example.yaml');
  const { config } = loadConfig(example);
  assert.ok(config.baseUrl.startsWith('https://'));
  assert.strictEqual(config.venue.nodeid, '1241984413986988032');
  assert.ok(config.target.hourPriority.length >= 1);
  assert.strictEqual(typeof config.target.hourPriority[0].from, 'number');
  assert.strictEqual(config.pay.mode, 'semi');
});

// ───────────────────────── 4. 选型算法 ─────────────────────────
section('4. 场地选型（时段优先 + 同场地约束）');

const COURTS = [
  { id: 'c1', floor: 1, name: '1号场' },
  { id: 'c2', floor: 1, name: '2号场' },
  { id: 'c3', floor: 1, name: '3号场' },
];

t('extractCourts：从 nodeMap 楼层结构抽取场地', () => {
  const nodeAppointData = {
    nodeMap: {
      1: { nodeListMap: { c1: [{ id: 'c1', sitename: '1号场', coordinate: '1-1-1' }], c2: [{ id: 'c2', sitename: '2号场' }] } },
      2: { nodeListMap: { c3: [{ id: 'c3', sitename: '3号场' }] } },
    },
  };
  const cs = extractCourts(nodeAppointData);
  assert.strictEqual(cs.length, 3);
  assert.strictEqual(cs[0].name, '1号场');
  assert.strictEqual(cs[2].floor, 2);
});

t('单时段覆盖整段目标 → 生成方案', () => {
  const plans = buildPlans({
    availableSlots: ['18:00-20:00', '20:00-21:00'],
    courts: COURTS,
    hourPriority: [normalizeRange(['18:00', '20:00'])],
    courtPriority: [],
    sameCourt: true,
  });
  assert.ok(plans.length >= 1);
  assert.deepStrictEqual(plans[0].slots, ['18:00-20:00']);
});

t('两个连续单小时时段自动拼成 2 小时（同场地）', () => {
  const plans = buildPlans({
    availableSlots: ['18:00-19:00', '19:00-20:00', '20:00-21:00'],
    courts: COURTS,
    hourPriority: [normalizeRange(['18:00', '20:00'])],
    courtPriority: [],
    sameCourt: true,
  });
  const combo = plans.find((p) => p.slots.length === 2);
  assert.ok(combo, '应生成拼接方案');
  assert.deepStrictEqual(combo.slots, ['18:00-19:00', '19:00-20:00']);
});

t('不连续的时段不会被拼在一起', () => {
  const plans = buildPlans({
    availableSlots: ['18:00-19:00', '20:00-21:00'],
    courts: COURTS,
    hourPriority: [normalizeRange(['18:00', '20:00'])],
    courtPriority: [],
    sameCourt: true,
  });
  const combo = plans.find((p) => p.slots.length === 2);
  assert.strictEqual(combo, undefined, '18:00-19:00 与 20:00-21:00 中间缺 19:00-20:00，不应拼接');
});

t('时段优先级顺序决定方案顺序（黄金时段排前面）', () => {
  const base = {
    availableSlots: ['19:00-20:00', '20:00-21:00', '18:00-19:00'],
    courts: COURTS,
    hourPriority: [normalizeRange(['20:00', '22:00']), normalizeRange(['18:00', '20:00'])],
    courtPriority: [],
    sameCourt: true,
  };
  // minSlots=1：所有方案都满足最少时段数，此时由「时段优先级」决定顺序
  const loose = buildPlans({ ...base, minSlots: 1 });
  assert.ok(loose.length >= 2);
  assert.deepStrictEqual(loose[0].slots, ['20:00-21:00'], '第一优先级应排在前面');

  // minSlots=2（学校规则：每次必须订满 2 小时）：
  // 凑不满 2 小时的方案即使优先级更高，也必须整体排在后面
  const strict = buildPlans({ ...base, minSlots: 2 });
  assert.deepStrictEqual(strict[0].slots, ['18:00-19:00', '19:00-20:00'], '满足最少时段数的方案优先');
  assert.strictEqual(strict[0].meetsMin, true);
  assert.ok(strict.slice(1).every((p) => p.meetsMin === false), '凑不满的方案只能当降级候选');
});

t('场地优先级影响候选顺序', () => {
  const ordered = orderCourts(['c1', 'c2', 'c3'], ['c3', 'c1']);
  assert.deepStrictEqual(ordered, ['c3', 'c1', 'c2']);
});

t('slotCourtMap 能剔除该时段不可用的场地', () => {
  const plans = buildPlans({
    availableSlots: ['18:00-19:00', '19:00-20:00'],
    courts: COURTS,
    hourPriority: [normalizeRange(['18:00', '20:00'])],
    courtPriority: [],
    sameCourt: true,
    slotCourtMap: {
      '18:00-19:00': new Set(['c1', 'c2']),
      '19:00-20:00': new Set(['c2', 'c3']),
    },
  });
  assert.ok(plans.length >= 1);
  assert.deepStrictEqual(plans[0].courts, ['c2'], '只有 c2 两个时段都可用');
});

t('完全相同方案去重', () => {
  const plans = buildPlans({
    availableSlots: ['18:00-20:00'],
    courts: COURTS,
    hourPriority: [normalizeRange(['18:00', '20:00']), normalizeRange(['18:00', '20:00'])],
    courtPriority: [],
    sameCourt: true,
  });
  const keys = plans.map((p) => p.slots.join(',') + '|' + p.courts.join(','));
  assert.strictEqual(new Set(keys).size, keys.length, '存在重复方案');
});

t('目标时段完全不可用时返回空方案', () => {
  const plans = buildPlans({
    availableSlots: ['08:00-09:00', '09:00-10:00'],
    courts: COURTS,
    hourPriority: [normalizeRange(['18:00', '20:00'])],
    courtPriority: [],
    sameCourt: true,
  });
  assert.strictEqual(plans.length, 0);
});

// 本组含 async 断言，包成函数由文件末尾统一 await（CommonJS 下不能顶层 await）
async function requestTests() {
section('5. 请求封装');

t('ApiClient 解析 baseUrl 并拼出正确路径', () => {
  const c = new ApiClient({ baseUrl: 'https://tygyypt.blcu.edu.cn', prefix: '/service/appointment/appointment' });
  assert.strictEqual(c._host, 'tygyypt.blcu.edu.cn');
  assert.strictEqual(c._port, 443);
  assert.strictEqual(c.prefix + '/phone/getBookingTimeRange', '/service/appointment/appointment/phone/getBookingTimeRange');
});

t('下单熔断：超过上限直接拒绝，不发出请求', async () => {
  const c = new ApiClient({ baseUrl: 'https://example.invalid', prefix: '/x', maxReservationPosts: 2 });
  await assert.rejects(() => c.reservation({ a: 1 }), /未知|网络|ECONN|getaddrinfo|错误/i); // 第一次会真发请求
  // 直接验证计数逻辑
  c.reservationPosts = 2;
  await assert.rejects(
    () => c.reservation({ a: 1 }),
    (e) => /熔断上限/.test(e.message),
    '应触发熔断'
  );
});

t('未知 payway 被拒绝', async () => {
  const c = new ApiClient({ baseUrl: 'https://example.invalid', prefix: '/x' });
  await assert.rejects(
    () => c.payOrder({ payway: '999' }),
    (e) => /未知支付方式/.test(e.message)
  );
});

await ta('业务失败（success=false）不再退避重试 —— 冲刺阶段不能放大请求量', async () => {
  const c = new ApiClient({ baseUrl: 'https://example.invalid', prefix: '/x', minInterval: 0 });
  let calls = 0;
  // 模拟「暂未发布预约规则」：HTTP 200 + success:false
  c._once = async () => {
    calls++;
    return { status: 200, json: { success: false, message: '暂未发布预约规则', resultData: null }, body: '{}', serverDate: null };
  };
  const json = await c.callRaw('/phone/getNodeAppointInfoList', { parentNodeId: 'V', appointDate: 'D' });
  assert.strictEqual(calls, 1, `业务失败只应请求 1 次，实际 ${calls} 次`);
  assert.strictEqual(json.success, false);
  assert.strictEqual(c.stats.bizFail, 1);
  assert.strictEqual(c.stats.ok, 0);
});
}


// ───────────────────────── 6. 支付模块（离线） ─────────────────────────
async function payTests() {
section('6. 支付模块（自动通道：78 账户卡余额 / 77 一卡通支付）');

t('needsPayment：0 元单与次卡单不需要付款', () => {
  assert.strictEqual(AutoPay.needsPayment({ price: 15 }), true, '15 元应需要付款');
  assert.strictEqual(AutoPay.needsPayment({ price: '15.00' }), true, '字符串金额应需要付款');
  assert.strictEqual(AutoPay.needsPayment({ price: 0 }), false, '0 元单不需要付款');
  assert.strictEqual(AutoPay.needsPayment({ price: 15, payway: '27' }), false, '次卡(27)不需要付款');
  assert.strictEqual(AutoPay.needsPayment({ price: 15, payway: '100' }), false, '次卡(100)不需要付款');
  assert.strictEqual(AutoPay.needsPayment({ price: 15, resultData: { payway: '27' } }), false, 'resultData 里的次卡也要识别');
});

t('pickAccno：优先 banknum，其次 accno 等别名', () => {
  assert.strictEqual(pickAccno({ banknum: '2023001' }), '2023001');
  assert.strictEqual(pickAccno({ accno: '2023002' }), '2023002');
  assert.strictEqual(pickAccno({ banknum: ' 2023 ', accno: 'x' }), '2023', 'banknum 优先且去空格');
  assert.strictEqual(pickAccno({}), '', '空对象返回空串');
  assert.strictEqual(pickAccno(null), '', 'null 返回空串');
  assert.strictEqual(pickAccno({ accno: '' }), '', '空串不算命中');
});

t('money：金额统一成两位小数字符串（对齐前端 toFixed(2)）', () => {
  assert.strictEqual(money(15), '15.00');
  assert.strictEqual(money('15.5'), '15.50');
  assert.strictEqual(money(0), '0.00');
  assert.strictEqual(money(undefined), '0.00');
  assert.strictEqual(money('abc'), '0.00');
});

await ta('AutoPay.settle：dry-run 不触碰网络，semi 直接走人工提醒', async () => {
  const notices = [];
  const cfg = {
    venue: { nodeid: 'V1' },
    auth: { usercode: 'U1' },
    pay: { mode: 'semi', accno: '', cardPassword: '', dryRunPay: false, notify: {} },
  };
  const pay = new AutoPay({
    client: { getPaywayList: () => { throw new Error('semi 模式不应调用 getPaywayList'); } },
    cfg,
    log: { info() {}, warn() {}, debug() {}, section() {} },
    notify: async (text) => notices.push(text),
  });

  const r1 = await pay.settle({ dryRun: true, price: 15 }, {});
  assert.strictEqual(r1.paid, false);
  assert.ok(/dry-run/.test(r1.message), `dry-run 应直接返回，实际：${r1.message}`);

  const r2 = await pay.settle({ price: 15, orderno: 'ORD1', slots: ['18:00-19:00'], court: 'C1' }, {});
  assert.strictEqual(r2.mode, 'semi');
  assert.strictEqual(r2.paid, false, 'semi 模式不应自动支付');
  assert.strictEqual(notices.length, 1, '应推送 1 条付款提醒');
  assert.ok(/ORD1/.test(notices[0]), '提醒里应包含订单号');
});

await ta('AutoPay.settle：auto 模式缺卡密码时降级为人工，不提交支付', async () => {
  const notices = [];
  let payCalled = false;
  const cfg = {
    venue: { nodeid: 'V1' },
    auth: { usercode: 'U1' },
    pay: { mode: 'auto', accno: '', cardPassword: '', dryRunPay: false, notify: {} },
  };
  const pay = new AutoPay({
    client: {
      getPaywayList: async () => ([{ payway: '78', banknum: 'BK2023', cardtypename: '校园卡', cardtype: '1' }]),
      getPayPrice: async () => 15,
      accountPayOrder: async () => { payCalled = true; return { success: true, message: '支付成功' }; },
    },
    cfg,
    log: { info() {}, warn() {}, debug() {}, section() {} },
    notify: async (text) => notices.push(text),
  });

  const r = await pay.settle(
    { price: 15, orderno: 'ORD2', slots: ['18:00-19:00'], court: 'C1', date: '2026-10-12' },
    { parentNodeId: 'V1', nodeid: 'V1', court: 'C1', slots: ['18:00-19:00'], date: '2026-10-12', appointInfo: [{ nodeid: 'C1', time: '18:00-19:00' }] }
  );
  assert.strictEqual(payCalled, false, '缺密码时绝不能提交支付');
  assert.strictEqual(r.paid, false);
  assert.strictEqual(r.accno, 'BK2023', 'accno 应从 getPaywayList 的 banknum 自动填充');
  assert.ok(/cardPassword|密码/.test(r.message), `应提示缺密码，实际：${r.message}`);
  assert.ok(notices.length >= 1, '应推送人工支付提醒');
});

await ta('AutoPay.settle：auto 模式完整链路（78 通道可用 + 有密码）→ 支付成功', async () => {
  const notices = [];
  const calls = [];
  const cfg = {
    venue: { nodeid: 'V1' },
    auth: { usercode: 'U1' },
    pay: { mode: 'auto', accno: '', cardPassword: '123456', dryRunPay: false, notify: {} },
  };
  const pay = new AutoPay({
    client: {
      getPaywayList: async (q) => { calls.push(['getPaywayList', q]); return [{ payway: '78', banknum: 'BK2023', cardtype: '1', cardtypename: '校园卡' }]; },
      getPayPrice: async (q) => { calls.push(['getPayPrice', q]); return 15; },
      accountPayOrder: async (q) => { calls.push(['accountPayOrder', q]); return { success: true, message: '支付成功' }; },
    },
    cfg,
    log: { info() {}, warn() {}, debug() {}, section() {} },
    notify: async (text) => notices.push(text),
  });

  const r = await pay.settle(
    { price: 15, orderno: 'ORD3', slots: ['18:00-19:00'], court: 'C1', date: '2026-10-12' },
    { parentNodeId: 'V1', nodeid: 'V1', court: 'C1', slots: ['18:00-19:00'], date: '2026-10-12', appointInfo: [{ nodeid: 'C1', time: '18:00-19:00' }] }
  );
  assert.strictEqual(r.paid, true, `应支付成功，实际：${r.message}`);
  const payCall = calls.find((c) => c[0] === 'accountPayOrder');
  assert.ok(payCall, '应调用 accountPayOrder');
  // baseinfo 精确形状：{txamt(字符串两位小数), orderno, accno, password, payway}
  assert.deepStrictEqual(payCall[1], {
    txamt: '15.00', orderno: 'ORD3', accno: 'BK2023', password: '123456', payway: '78',
  });
  // 取价调用必须是 priceType="2" + getCardPrice=true（复刻 getCardPayPrice）
  const quoteCall = calls.find((c) => c[0] === 'getPayPrice');
  assert.strictEqual(quoteCall[1].priceType, '2');
  assert.strictEqual(quoteCall[1].getCardPrice, true);
  assert.strictEqual(quoteCall[1].cardtype, '1');
  assert.ok(notices.some((n) => /支付成功/.test(n)), '应推送支付成功通知');
});

await ta('AutoPay.settle：服务端没有 78 通道时不硬来，直接转人工', async () => {
  const notices = [];
  let payCalled = false;
  const cfg = {
    venue: { nodeid: 'V1' }, auth: { usercode: 'U1' },
    pay: { mode: 'auto', cardPassword: '123456', accno: 'BK', dryRunPay: false, notify: {} },
  };
  const pay = new AutoPay({
    client: {
      getPaywayList: async () => ([{ payway: '99', title: '微信支付' }]),
      getPayPrice: async () => 15,
      accountPayOrder: async () => { payCalled = true; return { success: true, message: '支付成功' }; },
    },
    cfg,
    log: { info() {}, warn() {}, debug() {}, section() {} },
    notify: async (t) => notices.push(t),
  });
  const r = await pay.prepare({ price: 15, orderno: 'O', slots: [], court: 'C1', date: 'D' }, {});
  assert.strictEqual(r.ok, false);
  assert.ok(/没有无需微信的自动支付通道/.test(r.reason), `理由应说明缺可自动支付的通道，实际：${r.reason}`);
  assert.ok(/78\/77/.test(r.reason), `理由应点明 78/77，实际：${r.reason}`);
  assert.strictEqual(payCalled, false);
});

// 2026-10-10 实测：本账号 getPaywayList 只给 50（统一支付平台→必跳浏览器）与 77（一卡通）。
// 77 是唯一能纯服务端跑完的通道，且学校 checkYktPwd=true（语义为「不校验密码」）→ 不需要密码。
await ta('AutoPay.settle：只有 77（一卡通）时自动选它，无密码直接支付成功', async () => {
  const notices = [];
  const calls = [];
  const cfg = {
    venue: { nodeid: 'V1' },
    auth: { usercode: 'U1' },
    pay: { mode: 'auto', accno: '', cardPassword: '', dryRunPay: false, notify: {} },
  };
  const pay = new AutoPay({
    client: {
      getPaywayList: async () => ([
        { payway: '50', payname: '统一支付平台', opencard: '1', txcode: 'yy050' },
        { payway: '77', payname: '一卡通支付' },
      ]),
      getPayPrice: async () => { throw new Error('77 通道不应调用取卡价接口'); },
      openPlatFormPayOrder: async (q) => { calls.push(['openPlatFormPayOrder', q]); return { success: true, message: '支付成功' }; },
      accountPayOrder: async () => { throw new Error('不应走 78 通道'); },
    },
    cfg,
    log: { info() {}, warn() {}, debug() {}, section() {} },
    notify: async (text) => notices.push(text),
  });

  const r = await pay.settle(
    { price: 80, orderno: 'ORD77', slots: ['18:00-19:00', '19:00-20:00'], court: 'C1', date: '2026-10-12' },
    { parentNodeId: 'V1', nodeid: 'V1', court: 'C1', slots: ['18:00-19:00', '19:00-20:00'], date: '2026-10-12', appointInfo: [] }
  );
  assert.strictEqual(r.paid, true, `77 通道应支付成功，实际：${r.message}`);
  assert.strictEqual(r.payway, '77');
  const call = calls.find((c) => c[0] === 'openPlatFormPayOrder');
  assert.ok(call, '应调用 openPlatFormPayOrder');
  assert.deepStrictEqual(call[1], {
    txamt: '80.00', orderno: 'ORD77', payway: '77', accno: '', password: '',
  });
  assert.ok(notices.some((n) => /支付成功/.test(n)), '应推送支付成功通知');
});
}

// ───────────────────────── 7. 登录 / 自动续期（离线） ─────────────────────────
async function loginTests() {
  section('7. 登录模块（学号换发 token + 自动续期闸门）');

  const { jwtPayload, jwtExpiry, tokenSecondsLeft, identityOf, mintToken, ensureToken } = require('./login');

  // 用一份「手工构造」的 JWT 验证解析逻辑（不接触真实 token，也就不会泄漏）
  const payload = {
    exp: 1791623670,
    sub: 'datalook',
    Operator: JSON.stringify({ idserial: '202400000000', username: '某同学', roleid: '1201', code: '1201' }),
  };
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const fakeJwt = `${b64({ alg: 'RS256' })}.${b64(payload)}.SIGNATURE`;

  t('jwtPayload：能解出载荷，并把 Operator 字符串反序列化成对象', () => {
    const p = jwtPayload(fakeJwt);
    assert.ok(p, '应能解析');
    assert.strictEqual(p.exp, 1791623670);
    assert.ok(p.operator && typeof p.operator === 'object', 'Operator 应被反序列化');
    assert.strictEqual(p.operator.idserial, '202400000000');
  });

  t('identityOf：学号取自 Operator.idserial，不是 payload.code（那是角色码 1201）', () => {
    const id = identityOf(fakeJwt);
    assert.strictEqual(id.idserial, '202400000000');
    assert.strictEqual(id.username, '某同学');
    assert.strictEqual(id.rolecode, '1201');
    // 反例保护：payload.code 在这个系统里是角色码，不能被当学号
    assert.notStrictEqual(id.idserial, '1201');
  });

  t('jwtExpiry / tokenSecondsLeft：能算出生死线', () => {
    assert.strictEqual(jwtExpiry(fakeJwt), 1791623670);
    // 传一个「比 exp 早 600 秒」的 nowMs → 应剩 600 秒
    assert.strictEqual(tokenSecondsLeft(fakeJwt, (1791623670 - 600) * 1000), 600);
    // 传一个「比 exp 晚 300 秒」的 nowMs → 应为 -300（已过期）
    assert.strictEqual(tokenSecondsLeft(fakeJwt, (1791623670 + 300) * 1000), -300);
  });

  t('非 JWT / 空值不抛异常，返回 null（不能让坏 token 把脚本炸掉）', () => {
    assert.strictEqual(jwtPayload('not-a-jwt'), null);
    assert.strictEqual(jwtPayload(''), null);
    assert.strictEqual(jwtExpiry('a.b.c'), null);
    assert.strictEqual(tokenSecondsLeft(null), null);
    assert.strictEqual(identityOf('BOGUS'), null);
  });

  await ta('mintToken：空学号直接拒绝，不发请求', async () => {
    await assert.rejects(() => mintToken(''), /需要学号/);
    await assert.rejects(() => mintToken('   '), /需要学号/);
  });

  await ta('mintToken：学号首尾有空格时主动拦截（服务端会返回「获取人员信息失败」）', async () => {
    // 服务端对空格敏感，本地先挡掉能省一次失败请求
    await assert.rejects(() => mintToken(' 202400000000'), /空格/);
  });

  await ta('★ 安全闸门：allowRenew !== true 时 ensureToken 绝不换发 token', async () => {
    // 用一个必定不可用的 token + 关闭开关，验证的是「它不会去调登录接口」
    const cfg = {
      baseUrl: 'https://127.0.0.1:1', // 故意指向不可达地址：一旦它真的发请求，就会超时/报错
      prefix: '/service/appointment/appointment',
      net: { timeoutMs: 300 },
      auth: { token: '', usercode: '202400000000', allowRenew: false },
    };
    let errored = false;
    try {
      await ensureToken(cfg, { log: () => {} });
    } catch (e) {
      errored = true;
      assert.ok(/allowRenew|未开启|不可用/.test(e.message), `错误信息应说明闸门，实际：${e.message}`);
    }
    assert.ok(errored, 'allowRenew=false 且 token 不可用时应当抛错，而不是偷偷换发');
  });

  await ta('ensureToken：allowRenew=true 但缺 usercode → 明确报错，不静默失败', async () => {
    const cfg = {
      baseUrl: 'https://127.0.0.1:1',
      prefix: '/service/appointment/appointment',
      net: { timeoutMs: 300 },
      auth: { token: '', usercode: '', allowRenew: true },
    };
    await assert.rejects(() => ensureToken(cfg, { log: () => {}, write: false }), /usercode/);
  });
}

// ───────────────────────── 8. 放场闸门 ─────────────────────────
/**
 * ★ 2026-10-11 事故的回归测试。
 *
 * 那天 07:45 启动抢 10-13，`_targetReady` 只看了「网格里有没有候选场地」：
 * 滚动放场模式下网格会**提前**把即将放出的那天标成可订，于是脚本在 08:00 之前
 * 就连续下单，6 次熔断预算在 6 秒内烧光；等 08:00 真开闸时反而一次都提交不了，
 * 17 秒热窗口白白错过（20:00-22:00 当时有 3 片空场）。
 *
 * 修复 = `_gateOpen()`，两道判据：
 *   ① 有确定的放场时刻，且已经到点；
 *   ② ★ 目标日期必须已经进入网格那版放场窗口（10-11 之后补的第二道闸）。
 *
 * ② 补的原因：`--rel 2` 在窗口还没滚的时刻跑时，`releaseAt` 推出来的是**上一轮**
 * 放场的过去时刻，单看 ① 会被判成「已开闸」，可网格还是昨天那版快照 —— 于是又回到
 * 「开闸前烧光熔断预算」的老路。测试里两个「窗口还没滚」的场景就是钉这件事。
 */
/** 造一个只带闸门所需字段的 Grabber（真实实例，不走网络、不读配置） */
function gateGrabber({ now, releaseAt, targetDate, windowFrom, windowTo, serverToday, startTime }) {
  const { Grabber } = require('./grab');
  const log = { file: null, info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  const g = new Grabber({ target: {}, net: {}, safety: {}, pay: {}, paths: {} }, log, {});
  g.targetDate = targetDate;
  g.releaseAt = releaseAt;
  g._serverToday = serverToday;
  g.clock = { now: () => now, offset: 0, calibrate: () => {} };
  g.grid = {
    dateFields: {
      bookingStartDate: windowFrom,
      bookingEndDate: windowTo,
      bookingStartTime: startTime || '08:00',
    },
  };
  return g;
}

/**
 * 2026-10-25 实测回归：候场固定 15 秒复查 → 08:00:00 开闸后直到 08:00:17.7 才看见
 * 窗口已开，白白晚 17 秒冲刺（当天抢的 12:00-14:00 冷门没事，秒没的时段等于必输）。
 * 修复：收尾窗口（默认最后 60 秒）内把复查间隔收紧到 finalPollMs（默认 500ms），
 *       放场后宽限期内保持快节奏；超出宽限期退回常态，避免过期 releaseAt 空打。
 */
/**
 * 冲刺保险的回归：网格说还有空位、却匹配出 0 个候选 —— 多半是放场瞬间网格没刷齐。
 * 原来的行为是直接按 burstPollMs 再打一轮（拿不完整的网格空打）；
 * 现在改为隔 100ms 重拉一次网格。只在前 3 轮生效，后面就是真的没位。
 */
async function burstInsuranceTests() {
  section('8d. 冲刺保险（网格有空位却 0 候选 → 100ms 后重拉网格）');
  const { Grabber } = require('./grab');

  function mk(slots) {
    const warns = [];
    const log = { file: null, info() {}, warn: (m) => warns.push(m), error() {}, debug() {}, section() {} };
    const cfg = { target: {}, net: {}, safety: {}, pay: {}, paths: {}, schedule: { burstPollMs: 120 } };
    const g = new Grabber(cfg, log, { maxRounds: 2 });
    g.targetDate = '2026-10-27';
    g._targetReady = true;
    g._gateOpen = () => true;
    g._gateReason = () => 'stub';
    g._windowGuard = () => true;
    g._logGrid = () => {};
    g.buildTargets = () => [];
    g._guardDeadline = Date.now() + 10000;
    let fetches = 0;
    g.fetchGridRetry = async () => {
      fetches++;
      return { ok: true, grid: { courts: [{ id: 'c1', name: '羽毛球场地1' }], grid: {}, slots } };
    };
    return { g, warns, fetches: () => fetches };
  }

  await ta('★ 有空位但 0 候选 → 打出「重拉网格」并继续，不直接按 burstPollMs 空打', async () => {
    const { g, warns, fetches } = mk([{ value: '16:00-17:00', bookableCount: 2 }]);
    const r = await g.burst();
    assert.strictEqual(r, false);
    assert.strictEqual(fetches(), 2, '两轮各拉一次网格');
    assert.ok(warns.some((m) => m.includes('100ms 后重拉网格')), '必须提示重拉网格');
  });

  await ta('网格本来就没空位（没放出来/已满）→ 不走保险提示', async () => {
    const { g, warns, fetches } = mk([]);
    await g.burst();
    assert.strictEqual(fetches(), 2);
    assert.ok(!warns.some((m) => m.includes('100ms 后重拉网格')), '空网格不该触发保险');
  });
}

function pollTests() {
  section('8c. 候场复查节奏（2026-10-25 晚 17 秒事故回归）');
  const now = 1759200000000;
  const mk = (releaseAt) => gateGrabber({ now, releaseAt, targetDate: '2026-10-27' });

  t('★ 开闸前 5 秒 → 500ms 一次（别在放场那一刻睡 15 秒）', () => {
    assert.strictEqual(mk(now + 5000)._idleSleepMs(15000), 500);
  });

  t('开闸前 59 秒 → 500ms 一次', () => {
    assert.strictEqual(mk(now + 59000)._idleSleepMs(15000), 500);
  });

  t('开闸前 61 秒（还在收尾窗口外）→ 保持 idlePollMs', () => {
    assert.strictEqual(mk(now + 61000)._idleSleepMs(15000), 15000);
  });

  t('开闸前 30 分钟 → 保持 idlePollMs', () => {
    assert.strictEqual(mk(now + 1800000)._idleSleepMs(15000), 15000);
  });

  t('★ 已过点 60 秒（服务端放场延迟）→ 仍按 500ms 盯', () => {
    assert.strictEqual(mk(now - 60000)._idleSleepMs(15000), 500);
  });

  t('过了放场宽限期（180s）→ 退回常态，不拿过期 releaseAt 空打', () => {
    assert.strictEqual(mk(now - 600000)._idleSleepMs(15000), 15000);
  });

  t('不知道放场时刻 → 用传入的常态间隔', () => {
    assert.strictEqual(mk(null)._idleSleepMs(15000), 15000);
  });

  t('闸门关闭分支（base 2000）在收尾窗口内也会收紧到 500ms', () => {
    assert.strictEqual(mk(now + 3000)._idleSleepMs(2000), 500);
  });
}

/**
 * 2026-10-28 实测：放场窗口由服务端在 08:00:01.1 才滚开，但候场循环「看到窗口滚开」
 * 之后还要再睡满 500ms 才复查，于是 08:00:02.0 才转入冲刺。
 * 修复：① 闸门开着 + 复查拿到滚开后的网格 → 当场冲刺，不再多睡一拍；
 *       ② 离放场时刻 ±releaseRaceMs 内不睡，连着快查（窗口一滚开，下一轮就看得到）。
 */
async function releaseRaceTests() {
  section('8e. 放场瞬间：看到窗口滚开就冲刺（2026-10-28 晚 1 秒回归）');
  const { Grabber } = require('./grab');

  function mk({ now, releaseAt, targetDate, windowFrom, windowTo, serverToday, schedule }) {
    const log = { file: null, info() {}, warn() {}, error() {}, debug() {}, section() {} };
    const g = new Grabber(
      { target: {}, net: {}, auth: { token: '' }, safety: {}, pay: {}, paths: {}, schedule: schedule || {} },
      log,
      {}
    );
    g.targetDate = targetDate;
    g.releaseAt = releaseAt;
    g._serverToday = serverToday;
    g.clock = { now: () => now, offset: 0, calibrate: () => {} };
    g.grid = {
      dateFields: { bookingStartDate: windowFrom, bookingEndDate: windowTo, bookingStartTime: '08:00' },
    };
    g._guardDeadline = now + 60000;
    g.fetchGridRetry = async () => ({
      ok: true,
      grid: {
        courts: [{ id: 'c1', name: '羽毛球场地1' }],
        dateFields: { bookingStartDate: windowFrom, bookingEndDate: '2026-11-03', bookingStartTime: '08:00' },
        slots: [{ value: '16:00-17:00', bookableCount: 3 }],
      },
    });
    return { g };
  }

  const now = 1761955200000;

  await ta('★ 闸门关着、复查一看到窗口滚开 → 立刻返回，不再多睡 500ms 再拉一次', async () => {
    // 目标 11-03 还没进窗口（窗口 10-29~11-02），服务端今天 11-02 仍在窗口内 ⇒ 闸门关
    const { g } = mk({ now, releaseAt: now - 1000, targetDate: '2026-11-03',
      windowFrom: '2026-10-29', windowTo: '2026-11-02', serverToday: '2026-11-02' });
    const t0 = Date.now();
    const out = await g._idleWaitForRelease();
    const ms = Date.now() - t0;
    assert.ok(out && out.dateFields && out.dateFields.bookingEndDate === '2026-11-03', '应返回滚开后的网格');
    assert.ok(ms < 400, `应在第一个复查周期内返回（实测 ${ms}ms），而不是再睡满 500ms`);
  });

  await ta('★ 放场瞬间快通道：±releaseRaceMs 内不睡，窗口一开就返回', async () => {
    const { g } = mk({ now: now + 1000, releaseAt: now, targetDate: '2026-11-03',
      windowFrom: '2026-10-29', windowTo: '2026-11-03', serverToday: '2026-10-29',
      schedule: { releaseRaceMs: 5000, idlePollMs: 15000 } });
    const t0 = Date.now();
    const out = await g._idleWaitForRelease();
    const ms = Date.now() - t0;
    assert.ok(out, '应返回网格');
    assert.ok(ms < 400, `快通道下不该再睡 500ms（实测 ${ms}ms）`);
  });

  await ta('关掉快通道（releaseRaceMs=0）→ 退回「睡一拍再查」的老节奏', async () => {
    const { g } = mk({ now: now + 1000, releaseAt: now, targetDate: '2026-11-03',
      windowFrom: '2026-10-29', windowTo: '2026-11-03', serverToday: '2026-10-29',
      schedule: { releaseRaceMs: 0, idlePollMs: 15000 } });
    const t0 = Date.now();
    await g._idleWaitForRelease();
    const ms = Date.now() - t0;
    assert.ok(ms >= 400, `关闭快通道时应保留 500ms 节奏（实测 ${ms}ms）`);
  });

  t('快通道的边界：放场前 4s 在窗口内，前 6s 已出窗口', () => {
    const base = { now, targetDate: '2026-11-03', windowFrom: '2026-10-29', windowTo: '2026-10-31', serverToday: '2026-10-31', schedule: { releaseRaceMs: 5000 } };
    const a = mk({ ...base, releaseAt: now + 4000 }).g;
    const b = mk({ ...base, releaseAt: now + 6000 }).g;
    assert.strictEqual(a._releaseRace(), true);
    assert.strictEqual(b._releaseRace(), false);
  });
}

function gateTests() {
  section('8. 放场闸门（放场前绝不下单 —— 10-11 事故回归）');

  t('releaseAt 未确定时放行（服务端没给时刻，只能靠服务端拒绝 + 熔断兜底）', () => {
    const g = gateGrabber({ now: 1000, releaseAt: 0, targetDate: '2026-10-13' });
    assert.strictEqual(g._gateOpen(), true);
  });

  t('★ 放场时刻未到 → 关闸（这正是 10-11 烧光熔断的那一幕）', () => {
    const now = 1759200000000; // 任意基准时刻
    const g = gateGrabber({ now, releaseAt: now + 896800, targetDate: '2026-10-13' }); // 距放场 896.8s
    assert.strictEqual(g._gateOpen(), false, '距 08:00 还有 896.8s 时必须关闸');
  });

  t('放场时刻已到、目标日期已在窗口内 → 开闸', () => {
    const now = 1759200000000;
    const g = gateGrabber({
      now, releaseAt: now, targetDate: '2026-10-13',
      windowFrom: '2026-10-11', windowTo: '2026-10-13', serverToday: '2026-10-11',
    });
    assert.strictEqual(g._gateOpen(), true, '目标日期在窗口内且到点 ⇒ 放行');
  });

  t('★ 网格提前显示可订也不能据此下单（时序判据优先于网格判据）', () => {
    // _targetReady 的公式：网格有候选 && 闸门已开。前者为真但后者为假 ⇒ 仍不得冲刺。
    const now = 1759200000000;
    const g = gateGrabber({ now, releaseAt: now + 60000, targetDate: '2026-10-13' });
    g._hasBookableTarget = () => true; // 模拟 07:45 查到 20:00-21:00 有 3 片空场
    assert.strictEqual(g._hasBookableTarget(), true);
    assert.strictEqual(g._gateOpen(), false);
    assert.strictEqual(g._hasBookableTarget() && g._gateOpen(), false, '_targetReady 必须是 false');
  });

  // ── 第二道闸：窗口还没滚 ──────────────────────────────
  t('★★ 窗口还没滚 + 目标日期还没进窗口 → 关闸（`--rel 2` 提前跑的第二道闸）', () => {
    // 服务端今天 2026-10-11，窗口 10-11~10-13（10-13 已在窗口内）
    // 目标 10-14：放场时刻 = 10-14 08:00 − 2 天 = 10-12 08:00（未来）⇒ 判据①就拦住了
    const now = Date.parse('2026-10-11T13:00:00+08:00');
    const g = gateGrabber({
      now, releaseAt: Date.parse('2026-10-12T08:00:00+08:00'), targetDate: '2026-10-14',
      windowFrom: '2026-10-11', windowTo: '2026-10-13', serverToday: '2026-10-11',
    });
    assert.strictEqual(g._gateOpen(), false);
  });

  t('★★ 窗口还没滚 + releaseAt 已是过去时刻 → 仍然关闸（判据②的核心）', () => {
    // 服务端今天 2026-10-12、此刻已过 08:00，但窗口**还停在昨天那版** 10-10~10-12：
    // 目标 10-13 是下一版才放出的日期，网格里那些「可订」都是提前标出来的假象。
    // releaseAt 按「目标 − 窗口跨度天」推 = 10-13 08:00 − 2 天 = 10-11 08:00（过去），
    // ★ 旧代码（只判①）在这里会开闸放行 ⇒ 在真正开闸（10-12 08:00）之前烧光熔断预算。
    const now = Date.parse('2026-10-12T07:45:03+08:00');
    const g = gateGrabber({
      now, releaseAt: Date.parse('2026-10-11T08:00:00+08:00'), targetDate: '2026-10-13',
      windowFrom: '2026-10-10', windowTo: '2026-10-12', serverToday: '2026-10-12',
    });
    assert.strictEqual(g._gateOpen(), false, '窗口还没滚 ⇒ 必须关闸');
    assert.ok(/还没进入放场窗口/.test(g._gateReason()), `关闸原因应说明窗口，实际：${g._gateReason()}`);
  });

  t('★★ 窗口滚动后的同一时刻 → 开闸（第二道闸不能误伤正常抢场）', () => {
    // 与上一条同样的时刻，但窗口已经滚到 10-11~10-13（10-13 进来了）
    const now = Date.parse('2026-10-12T07:45:03+08:00');
    const g = gateGrabber({
      now, releaseAt: Date.parse('2026-10-12T08:00:00+08:00'), targetDate: '2026-10-13',
      windowFrom: '2026-10-11', windowTo: '2026-10-13', serverToday: '2026-10-12',
    });
    assert.strictEqual(g._gateOpen(), false, '到点前仍关闸');
    const g2 = gateGrabber({
      now: now + 900000, releaseAt: Date.parse('2026-10-12T08:00:00+08:00'), targetDate: '2026-10-13',
      windowFrom: '2026-10-11', windowTo: '2026-10-13', serverToday: '2026-10-12',
    });
    assert.strictEqual(g2._gateOpen(), true, '到点且目标已在窗口内 ⇒ 放行');
  });

  t('服务端既没给窗口也没给放场时刻 → 放行（不能把脚本永久锁死）', () => {
    const now = Date.parse('2026-10-12T07:45:03+08:00');
    const g = gateGrabber({ now, releaseAt: now - 1000, targetDate: '2026-10-13' });
    g.grid = { dateFields: {} };
    assert.strictEqual(g._gateOpen(), true);
  });
}

// ───────────────────────── 8b. 订单号交接（离线） ─────────────────────────
/**
 * 2026-10-12 事故回归：抢到了却没付成。
 *
 * 真实经过（07:45 那次 cron）：
 *   [08:00:20] ★ 锁场成功：13:00-14:00 @ 羽毛球场地1  金额=20.00  订单号=129801
 *   [08:00:25] WARN 下单响应里没有 orderno，无法继续支付流程
 *   [08:00:25] 结果标记：SUCCESS  订单号=129801
 *   ⇒ 场地真的锁住了（订单 129801），但**支付一行没走**：支付侧 `settle()` 读的是
 *     `locked.orderno`（全小写，跟接口字段 `resultData.orderno` 对齐），而锁场侧
 *     `_lockOrder()` 只写了 `orderNo`（驼峰）。20 元一分没扣，等支付窗口（实测
 *     08:05:21 到期，约 4 分 56 秒）过去后系统自动释放 —— 表现就是「抢到了却什么都没有」。
 *
 * 这个测试钉的就是「订单号必须用两个名字都能取到」，防止以后再拆坏。
 */
async function orderNoTests() {
  section('8b. 订单号交接（锁场 → 支付，2026-10-12 事故回归）');

  const { Grabber } = require('./grab');
  const { AutoPay } = require('./pay');
  const mkLog = { file: null, info() {}, warn() {}, error() {}, debug() {}, section() {} };

  t('★★ _lockOrder 收到驼峰 orderNo → 自动补出小写 orderno（支付侧读的就是它）', () => {
    const g = new Grabber({ target: {}, net: {}, safety: {}, pay: {}, paths: {} }, mkLog, {});
    const o = { date: '2026-10-14', court: 'C1', courtName: '羽毛球场地1', slots: ['13:00-14:00'], price: '20.00', orderNo: '129801' };
    g._lockOrder(o);
    assert.strictEqual(o.orderno, '129801', '支付侧锁场记录必须能读到 orderno');
    assert.strictEqual(g.result.locked.orderno, '129801');
    assert.strictEqual(g.result.locked, g.result.orders[0], 'locked 永远 = orders[0]');
  });

  t('★ _lockOrder 只收到小写 orderno → 同时补出 orderNo（报表/标记文件两处都在读）', () => {
    const g = new Grabber({ target: {}, net: {}, safety: {}, pay: {}, paths: {} }, mkLog, {});
    const o = { court: 'C1', courtName: '羽毛球场地1', slots: ['13:00-14:00'], price: '20.00', orderno: '129802' };
    g._lockOrder(o);
    assert.strictEqual(o.orderNo, '129802');
  });

  t('★ _lockOrder 两个都没有（接口没给单号）→ 不凭空造号，仍是空', () => {
    const g = new Grabber({ target: {}, net: {}, safety: {}, pay: {}, paths: {} }, mkLog, {});
    const o = { court: 'C1', courtName: '羽毛球场地1', slots: ['13:00-14:00'], price: '20.00' };
    g._lockOrder(o);
    assert.ok(o.orderno == null && o.orderNo == null, '不该造假单号');
  });

  t('★★ settle 能认驼峰 orderNo：不再报「缺少 orderno」', async () => {
    const notices = [];
    const cfg = {
      venue: { nodeid: 'V1' },
      auth: { usercode: 'U1' },
      pay: { mode: 'auto', accno: '', cardPassword: '123456', dryRunPay: false, notify: {}, channels: ['77'] },
    };
    const pay = new AutoPay({
      client: {
        getPaywayList: async () => ([{ payway: '77', banknum: '', cardtypename: '一卡通' }]),
        openPlatFormPayOrder: async () => ({ success: true, message: '支付成功' }),
        accountPayOrder: async () => { throw new Error('不应走 78 通道'); },
      },
      cfg,
      log: mkLog,
      notify: async (text) => notices.push(text),
    });
    // ★ 只给驼峰 orderNo —— 就是 10-12 那次锁场记录的真实形状
    const lock = { price: '20.00', orderNo: '129801', slots: ['13:00-14:00'], court: 'C1', courtName: '羽毛球场地1', date: '2026-10-14' };
    const r = await pay.settle(lock, {
      parentNodeId: 'V1', nodeid: 'V1', court: 'C1',
      slots: ['13:00-14:00'], date: '2026-10-14', appointInfo: [{ nodeid: 'C1', time: '13:00-14:00' }],
    });
    assert.notStrictEqual(r.message, '缺少 orderno', '绝不能因为字段名不一致就说取不到单号');
    assert.strictEqual(r.paid, true, `应支付成功，实际：${r.message}`);
    assert.ok(notices.some((n) => /支付成功/.test(n)), '应推送支付成功通知');
  });
}

// ───────────────────────── 9. 联网 ─────────────────────────
async function online() {
  section('9. 联网（验证服务端在线 + 鉴权闸门生效，不需要 token）');
  const c = new ApiClient({
    baseUrl: 'https://tygyypt.blcu.edu.cn',
    prefix: '/service/appointment/appointment',
    minInterval: 0,
    timeout: 15000,
  });

  // ⚠️ 2026-10 实测：服务端已收紧，连 getInfoByType / getBookingTimeRange 都要求 token（403）。
  // 所以联网组的判据只能是「请求打到了服务端并被它的鉴权层拒绝」，而不是「拿到了配置数据」。
  await ta('站点在线：无 token 请求被服务端鉴权层拦下（403）', async () => {
    await assert.rejects(
      () => c.callRaw('/phone/getInfoByType', { type: 'appoint_function' }, { auth: false, retries: 1 }),
      (e) => {
        assert.strictEqual(e.status, 403, `预期 HTTP 403，实际 ${e.status}`);
        assert.strictEqual(e.kind, 'auth', '403 应被归类为鉴权错误（不重试）');
        return true;
      }
    );
    console.log('      → 403 说明：DNS/TCP/TLS 全通，路径前缀正确，加密体被服务端接受，只差 token');
  });

  await ta('空 body 同样 403（排除"表单/编码格式"的历史误判）', async () => {
    await assert.rejects(
      () => c.callRaw('/phone/getInfoByType', {}, { auth: false, retries: 0 }),
      (e) => e.status === 403,
      '空对象不发 item 字段，服务器仍应返回 403'
    );
  });

  await ta('鉴权分层：无 token → 403；伪造 token → 401', async () => {
    const c2 = new ApiClient({
      baseUrl: 'https://tygyypt.blcu.edu.cn',
      prefix: '/service/appointment/appointment',
      minInterval: 0,
      token: 'BOGUS_TOKEN_FOR_SELFTEST',
    });
    await assert.rejects(
      () => c2.callRaw('/phone/getBookingTimeRange', { nodeid: '1241984413986988032' }, { retries: 0 }),
      (e) => {
        assert.strictEqual(e.status, 401, `伪造 token 预期 401，实际 ${e.status}`);
        assert.strictEqual(e.kind, 'auth', '401 应被归类为鉴权错误');
        return true;
      }
    );
  });
}

// ───────────────────────── 运行 ─────────────────────────
(async () => {
  console.log('BLCU 抢场脚本 · 自检');
  console.log('='.repeat(70));

  // ── 命令行指定时间段（--window / --slots）──
  //   这一组是「可以用选择的时段抢场」这个需求的回归测试：
  //   解析层必须宽容（各种分隔符都认、写错只返回 null），应用层必须严格
  //   （窗口长度/--slots 自相矛盾时要在**开抢之前**报错，而不是空转一整轮）。
  section('2.5 命令行指定时间段（--window / --slots）');

  const W = parseWindowSpec;
  const makeCfg = () => ({
    target: {
      hourPriority: [normalizeRange(['17:00', '19:00'])],
      minSlots: 2,
      maxSlots: 2,
    },
  });

  t('解析 18:00-20:00 → 1080~1200 分钟', () => {
    assert.deepStrictEqual(W('18:00-20:00'), { from: 1080, to: 1200, raw: '18:00-20:00' });
  });

  t('简写 18-20 等价于 18:00-20:00', () => {
    assert.deepStrictEqual(W('18-20'), { from: 1080, to: 1200, raw: '18:00-20:00' });
  });

  t('各种分隔符都认：~ ～ — – 至 到', () => {
    for (const s of ['18:00~20:00', '18:00～20:00', '18:00—20:00', '18:00 至 20:00', '18:00到20:00']) {
      assert.deepStrictEqual(W(s), { from: 1080, to: 1200, raw: '18:00-20:00' }, `写法：${s}`);
    }
  });

  t('解析不出来的一律返回 null（绝不抛异常，菜单里手打错字不该让进程崩）', () => {
    for (const s of ['', '   ', 'abc', '18:00', '25:00-26:00', '18:60-20:00', '20:00-18:00', '18:00-18:00', null, undefined]) {
      assert.strictEqual(W(s), null, `输入：${JSON.stringify(s)}`);
    }
  });

  t('--window 覆盖 hourPriority（只改内存里的 config，不写回文件）', () => {
    const cfg = makeCfg();
    const info = applyWindowOverrides(cfg, { windows: ['19:00-20:00'] });
    assert.ok(info && info.strict, '应返回 strict 窗口信息');
    assert.deepStrictEqual(cfg.target.hourPriority.map((h) => h.raw), ['19:00-20:00']);
  });

  t('★ 窗口只有 1 小时 → minSlots 自动降到 1（否则「最少 2 小时」会让它永远凑不出候选）', () => {
    const cfg = makeCfg();
    assert.strictEqual(cfg.target.minSlots, 2, '前置：config 里是 2');
    const info = applyWindowOverrides(cfg, { windows: ['19:00-20:00'] });
    assert.strictEqual(cfg.target.minSlots, 1);
    assert.strictEqual(info.minSlots, 1);
  });

  t('窗口有 2 小时 → 保留 config 的 minSlots=2', () => {
    const cfg = makeCfg();
    applyWindowOverrides(cfg, { windows: ['18:00-20:00'] });
    assert.strictEqual(cfg.target.minSlots, 2);
  });

  t('--slots 1 可以主动放宽成 1 小时（哪怕窗口有 2 小时）', () => {
    const cfg = makeCfg();
    applyWindowOverrides(cfg, { windows: ['18:00-20:00'], slots: 1 });
    assert.strictEqual(cfg.target.minSlots, 1);
  });

  t('★ --slots 2 配 1 小时窗口 → 开抢前就报错（不能等跑完一轮才发现是空转）', () => {
    assert.throws(
      () => applyWindowOverrides(makeCfg(), { windows: ['19:00-20:00'], slots: 2 }),
      /装不进/
    );
  });

  t('多段窗口：逗号分隔，且以最短的那段为准（保证每段都能用）', () => {
    const cfg = makeCfg();
    const info = applyWindowOverrides(cfg, { windows: ['18:00-20:00,21:00-22:00'] });
    assert.strictEqual(info.windows.length, 2);
    assert.strictEqual(cfg.target.minSlots, 1, '21:00-22:00 只有 1 小时 ⇒ 最少段数必须是 1');
  });

  t('写错的时间段：报错里带上用户原文，方便他改', () => {
    assert.throws(
      () => applyWindowOverrides(makeCfg(), { windows: ['18:00-2x:00'] }),
      (e) => /18:00-2x:00/.test(e.message) && /看不懂/.test(e.message)
    );
  });

  t('不给 --window 时返回 null（不影响原有配置行为）', () => {
    const cfg = makeCfg();
    assert.strictEqual(applyWindowOverrides(cfg, {}), null);
    assert.deepStrictEqual(cfg.target.hourPriority.map((h) => h.raw), ['17:00-19:00']);
  });

  // ── 优先级模式（--priority）──
  //   与 --window 只差一件事，但这一件事决定了「宁可跑空」还是「别白等一天」：
  //   --window 是约束（关兜底），--priority 是偏好（保留兜底）。菜单里两个模式各用一个。
  section('2.6 命令行指定优先级（--priority，按顺序试但保留兜底）');

  t('★ 优先级列表按顺序落在 hourPriority 上', () => {
    const cfg = makeCfg();
    const info = applyPriorityOverrides(cfg, { priority: ['16:00-18:00,17:00-19:00,15:00-17:00'] });
    assert.deepStrictEqual(cfg.target.hourPriority.map((h) => h.raw), ['16:00-18:00', '17:00-19:00', '15:00-17:00']);
    assert.strictEqual(info.strict, false, '★ 优先级模式必须标成非严格 —— grab.js 靠它决定保不保留兜底');
  });

  t('parseWindowList：多值、逗号、全角逗号都能拼成一份列表，并去重', () => {
    const wins = parseWindowList(['16:00-18:00', '17:00-19:00,17-19', '15:00~17:00']);
    assert.deepStrictEqual(wins.map((w) => w.raw), ['16:00-18:00', '17:00-19:00', '15:00-17:00']);
    assert.strictEqual(parseWindowList([]), null);
    assert.strictEqual(parseWindowList(null), null);
  });

  t('★ 优先级模式不动 minSlots（不像 --window 那样按窗口长度降级）', () => {
    const cfg = makeCfg();
    applyPriorityOverrides(cfg, { priority: ['16:00-18:00'] });
    assert.strictEqual(cfg.target.minSlots, 2, '优先级只是排序偏好，不该偷偷改「最少几小时」');
  });

  t('优先级列表里的坏值同样报错（不静默丢掉用户写错的那一段）', () => {
    assert.throws(
      () => applyPriorityOverrides(makeCfg(), { priority: ['16:00-18:00', '晚上'] }),
      (e) => /晚上/.test(e.message) && /看不懂/.test(e.message)
    );
  });

  t('不给 --priority 时返回 null', () => {
    const cfg = makeCfg();
    assert.strictEqual(applyPriorityOverrides(cfg, {}), null);
    assert.strictEqual(applyPriorityOverrides(cfg, { priority: [] }), null);
    assert.deepStrictEqual(cfg.target.hourPriority.map((h) => h.raw), ['17:00-19:00']);
  });

  t('★ 同一份列表：--priority 保留兜底，--window 关掉兜底（两者语义必须不同）', () => {
    const p = makeCfg();
    const pi = applyPriorityOverrides(p, { priority: ['16:00-18:00'] });
    const w = makeCfg();
    const wi = applyWindowOverrides(w, { windows: ['16:00-18:00'] });
    assert.strictEqual(pi.strict, false);
    assert.strictEqual(wi.strict, true);
    assert.deepStrictEqual(p.target.hourPriority.map((h) => h.raw), w.target.hourPriority.map((h) => h.raw));
  });

  // 第 5、6、7 节含 async 断言，此处 await 以保证小结在所有断言之后打印
  await requestTests();
  await payTests();
  await loginTests();
  gateTests();
  pollTests();
  await burstInsuranceTests();
  await releaseRaceTests();
  await orderNoTests();

  if (process.argv.includes('--offline')) {
    console.log('\n（--offline：跳过联网检查）');
  } else {
    await online();
  }

  console.log('\n' + '='.repeat(70));
  console.log(`结果：${pass} 项通过，${fail} 项失败`);
  process.exitCode = fail ? 1 : 0;
})();
