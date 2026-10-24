'use strict';
/**
 * 场地选型：把服务端返回的原始数据结构化，并按「时段优先 + 场地优先」打分。
 *
 * 数据结构（实测还原自 pages-custom-home-siteAppoint"）：
 *   getAppointmentTimeSlot → timeList: [{ value:"18:00-19:00", status:"0|1" }]
 *   getSiteAppointInfo     → nodeMap[楼层] = {
 *                              nodeListMap: { 场地nodeid: [ {id, sitename, coordinate, ...} ] }
 *                            }
 *   其中 timeslot 矩阵的行=场地、列=时段，选中某个 (场地,时段) 即 ticket:
 *       { id: 场地nodeid, time: "18:00-19:00", price, idInfo: 场地nodeid, location }
 */

const { parseSlot } = require('./config');

/** 分钟数 → "HH:MM"。用于把「紧邻的下一个小时」拼成时段字符串去查网格。 */
function hhmmOf(min) {
  const m = Number(min);
  if (!Number.isFinite(m)) return '';
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}


/**
 * ★★ 解析 /phone/getNodeAppointInfoList 的返回 —— 抢场的主数据源。
 *
 * 实测（2026-10-10）该接口一次请求就给出**整馆的场地×时段网格**，
 * 且把「为什么不可订」都标好了，比 getSiteAppointInfo + getAppointmentTimeSlot 加起来还全：
 *
 *   resultData = {
 *     bookingStartDate / bookingEndDate / bookingStartTime / bookingEndTime,
 *     releaseStatus / releaseOpen / nextReleaseAt / releaseMode / targetMode,
 *     maxSelect:"2"        ← 单次最多时段数（=2 小时）
 *     minSelect:"1", capacity:"4"（每片场地容量4人）, latetime:"40",
 *     checkintime:"10"（可提前10分钟进场）, checkouttime:"0",
 *     parentNodeId / parentNodeName, childrenNum:"3",
 *     timeList: [{time:"08:00-19:00", type:"8230001"|"8230002"}],
 *     nodeTimeList: [ { id:场地nodeid, nodename:"羽毛球场地1", timeList:[ {
 *         time, type, disabled:true|false,
 *         msg:"haveLimit"|"haveTicket"|"teacher",
 *         limitSummary:"体育部教学"|"校工会",
 *         bookedPreview:{bookerUsername,bookerIdserial}
 *     } ] } ]
 *   }
 *
 * 一个时段对某片场地**可以订**的判定：该场地 timeList 里对应 time 的项 `disabled !== true`。
 * `disabled:true` 的三种原因：
 *   haveLimit + limitSummary → 教学/工会占用（每天都有，固定不可订）
 *   haveTicket               → 已被别人订走（bookedPreview 里能看到是谁）
 *   teacher                  → 教师/工作人员占用
 *
 * @returns {null|{dateFields:object, slots:object[], courts:object[], grid:object}}
 *   slots: [{time, type, disabled, disabledCount, reason, bookableCourts:string[]}]
 *   courts:[{id, name, tel, capacity, bookableTimes:string[]}]
 */
function parseNodeAppointGrid(raw, opts = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const nodeTimeList = Array.isArray(raw.nodeTimeList) ? raw.nodeTimeList : [];
  if (!nodeTimeList.length) return null;

  const courts = [];
  const grid = {}; // courtId -> { time -> item }
  const slotMeta = new Map(); // time -> {type, item}

  for (const court of nodeTimeList) {
    const id = String(court.id == null ? '' : court.id);
    if (!id) continue;
    const times = [];
    const row = {};
    for (const item of Array.isArray(court.timeList) ? court.timeList : []) {
      const time = String(item.time || '');
      if (!time) continue;
      row[time] = item;
      if (item.disabled !== true) times.push(time);
      if (!slotMeta.has(time)) slotMeta.set(time, { type: item.type, item });
    }
    grid[id] = row;
    courts.push({
      id,
      name: String(court.nodename || court.nodecode || `场地${courts.length + 1}`),
      tel: court.tel || raw.tel || '',
      capacity: court.capacity == null ? null : String(court.capacity),
      bookableTimes: times,
      address: court.nodephone || null,
    });
  }
  if (!courts.length) return null;

  // 时段视图：类型（8230001 非高峰 / 8230002 高峰）对所有场地一致，取第一个场地即可
  const order = [];
  for (const c of courts) {
    for (const t of Object.keys(grid[c.id] || {})) if (!order.includes(t)) order.push(t);
  }
  order.sort((a, b) => {
    const sa = parseSlot(a);
    const sb = parseSlot(b);
    return (sa ? sa.from : 0) - (sb ? sb.from : 0);
  });

  const slots = order.map((time) => {
    const meta = slotMeta.get(time) || {};
    const bookableCourts = [];
    const reasons = new Map();
    for (const c of courts) {
      const item = (grid[c.id] || {})[time];
      if (!item) continue;
      if (item.disabled === true) {
        const key = `${item.msg || 'disabled'}${item.limitSummary ? ':' + item.limitSummary : ''}`;
        reasons.set(key, (reasons.get(key) || 0) + 1);
      } else {
        bookableCourts.push(c.id);
      }
    }
    return {
      time,
      type: meta.type == null ? null : String(meta.type),
      bookableCourts,
      bookableCount: bookableCourts.length,
      disabledCount: courts.length - bookableCourts.length,
      reasons: Array.from(reasons.entries()).map(([k, n]) => ({ reason: k, courts: n })),
    };
  });

  const dateFields = {
    date: opts.date || null,
    bookingStartDate: raw.bookingStartDate || null,
    bookingEndDate: raw.bookingEndDate || null,
    bookingStartTime: raw.bookingStartTime || null,
    bookingEndTime: raw.bookingEndTime || null,
    releaseStatus: raw.releaseStatus || '',
    releaseOpen: raw.releaseOpen !== false,
    nextReleaseAt: raw.nextReleaseAt || null,
    releaseMode: raw.releaseMode || '',
    targetMode: raw.targetMode || '',
    targetPeriodLabel: raw.targetPeriodLabel || '',
    userMessage: raw.userMessage || '',
    maxSelect: raw.maxSelect == null ? null : String(raw.maxSelect),
    minSelect: raw.minSelect == null ? null : String(raw.minSelect),
    lateTime: raw.latetime == null ? null : String(raw.latetime),
    checkInTime: raw.checkintime == null ? null : String(raw.checkintime),
    checkOutTime: raw.checkouttime == null ? null : String(raw.checkouttime),
    capacity: raw.capacity == null ? null : String(raw.capacity),
    tel: raw.tel || null,
    parentNodeId: raw.parentNodeId || null,
    parentNodeName: raw.parentNodeName || null,
  };

  return { dateFields, slots, courts, grid };
}

/** 从 getSiteAppointInfo 的返回里抽出「场地列表」 */
function extractCourts(nodeAppointData) {
  const courts = [];
  const nodeMap = (nodeAppointData && nodeAppointData.nodeMap) || {};
  for (const floor of Object.keys(nodeMap).sort()) {
    const listMap = (nodeMap[floor] || {}).nodeListMap || {};
    for (const courtId of Object.keys(listMap)) {
      const seats = listMap[courtId] || [];
      const first = seats.find((s) => s && typeof s === 'object') || {};
      courts.push({
        id: String(courtId),
        floor: Number(floor),
        name: first.sitename || first.name || `${floor}楼-${courtId.slice(-4)}`,
        coordinate: first.coordinate || '',
      });
    }
  }
  return courts;
}

/**
 * 判断某个候选时段是否满足目标时段。
 *
 * 目标 "18:00-20:00" 想凑满 2 小时，可以由两个连续的单小时时段拼成。
 * mode:
 *   'exact'  —— 候选必须与目标完全等同时长（默认：目标是2小时，系统也按小时放）
 *   'within' —— 候选落在目标区间内即可（少一点也不介意）
 */
function matchesTarget(slotValue, target, mode = 'exact') {
  const s = parseSlot(slotValue);
  if (!s) return false;
  if (mode === 'within') return s.from >= target.from && s.to <= target.to && s.to > s.from;
  return s.from >= target.from && s.to <= target.to && s.to > s.from;
}

/**
 * 在候选时段集合中，为某个目标区间挑选「覆盖时长最长」的组合。
 * 返回按 (起始分钟, 时长降序) 排序的可用时段列表。
 */
function rankSlots(slotValues, target) {
  const parsed = [];
  for (const v of slotValues) {
    const s = parseSlot(v);
    if (!s) continue;
    const overlap = Math.min(s.to, target.to) - Math.max(s.from, target.from);
    if (overlap <= 0) continue;
    parsed.push({ value: v, from: s.from, to: s.to, overlap });
  }
  parsed.sort((a, b) => (a.from - b.from) || (b.overlap - a.overlap));
  return parsed;
}

/**
 * 核心选型：给出「候选方案」列表，按优先级排序。
 *
 * 每个候选方案 = { slots: ["18:00-19:00","19:00-20:00"], courts: [场地id,...] }
 * 调度器会按方案顺序逐个尝试下单（因为同一 2 小时可以在不同场地完成）。
 *
 * @param {object} p
 * @param {string[]} p.availableSlots   该场次所有 status=1 的时段 value
 * @param {Array}    p.courts            场地列表
 * @param {Array}    p.hourPriority      目标时段优先级（已归一化 {from,to,raw}）
 * @param {string[]} p.courtPriority     场地优先级（nodeid 数组，空=不限）
 * @param {object}   p.slotCourtMap      { "18:00-19:00": Set(可用场地id) | null }
 *                                        null 表示未知（该时段对所有场地都可用）
 * @param {boolean}  p.sameCourt         同一方案内是否必须同一场地
 * @returns {Array<{slots:string[], courts:string[], reason:string, score:number}>}
 */
function buildPlans(p) {
  const {
    availableSlots = [],
    courts = [],
    hourPriority = [],
    courtPriority = [],
    slotCourtMap = {},
    sameCourt = true,
    minSlots = 2, // 学校规则：每次最少订满 2 小时（getBookingTimeRange 的 minselectnum）
    maxSlots = 2, // 每次最多时段数；服务端 maxbooktime 优先
  } = p;

  const plans = [];

  for (let hp = 0; hp < hourPriority.length; hp++) {
    const target = hourPriority[hp];
    const targetLen = target.to - target.from;
    if (targetLen <= 0) continue;

    const ranked = rankSlots(availableSlots, target);
    if (!ranked.length) continue;

    // 收集该优先级下的候选组合，再按「同一开始时刻只保留最优的一条」去重，
    // 避免同一个时间跨度因为拼法不同而反复下单（会白白消耗尝试次数与风控额度）。
    const bySpan = new Map(); // startMin -> {combo, len}

    const consider = (combo) => {
      if (combo.length > maxSlots) return;
      const len = combo.reduce((acc, c) => acc + Math.min(c.to, target.to) - Math.max(c.from, target.from), 0);
      if (len <= 0) return;
      const key = `${combo[0].from}`;
      const prev = bySpan.get(key);
      const comboOk = combo.length >= minSlots;
      const prevOk = prev ? prev.combo.length >= minSlots : false;
      // 同一开始时刻的取舍：① 满足最少时段数优先 ② 时长更长优先 ③ 段数更少优先
      const better =
        !prev ||
        (comboOk && !prevOk) ||
        (comboOk === prevOk && (len > prev.len || (len === prev.len && combo.length < prev.combo.length)));
      if (better) bySpan.set(key, { combo, len });
    };

    // 单时段（若它本身就落在目标窗口内）
    if (maxSlots >= 1) for (const s of ranked) consider([s]);

    // 连续时段拼接
    for (const combo of findContiguousCombos(ranked, target, targetLen, maxSlots)) consider(combo);

    for (const { combo, len } of bySpan.values()) {
      const courtIds = sameCourt
        ? intersectCourtsOf(combo, courts, slotCourtMap)
        : unionCourtsOf(combo, courts, slotCourtMap);
      const ordered = orderCourts(courtIds, courtPriority);
      if (!ordered.length) continue;

      const slots = combo.map((c) => c.value);
      const full = len >= targetLen;
      const meetsMin = combo.length >= minSlots;
      plans.push({
        slots,
        courts: ordered,
        sameCourt,
        full,
        meetsMin,
        priorityIndex: hp,
        startMin: combo[0].from,
        coveredLen: len,
        reason: full
          ? `目标时段 ${target.raw} 由 ${slots.join(' + ')} 覆盖（${len} 分钟，${slots.length} 个时段）`
          : `仅覆盖目标时段 ${target.raw} 的 ${len} 分钟：${slots.join(' + ')}`,
      });
    }
  }

  // 排序（严格按这个次序，逐级决胜）：
  //   ① 满足学校最少时段数（默认 2 小时）—— 凑不满的方案在服务端很可能被 minselectnum 直接拒
  //   ② 目标时段优先级（配置里的先后顺序）—— 用户要的是黄金时段，这条要压过「凑得更满」
  //   ③ 凑满整个目标区间
  //   ④ 覆盖时长更长
  //   ⑤ 开始更早
  //   ⑥ 段数更少（少一次下单请求）
  plans.sort(
    (a, b) =>
      (Number(b.meetsMin) - Number(a.meetsMin)) ||
      (a.priorityIndex - b.priorityIndex) ||
      (Number(b.full) - Number(a.full)) ||
      (b.coveredLen - a.coveredLen) ||
      (a.startMin - b.startMin) ||
      (a.slots.length - b.slots.length)
  );

  // 去重（同样的 slots+courts 只留一条）
  const seen = new Set();
  const uniq = [];
  for (const pl of plans) {
    const key = pl.slots.join(',') + '|' + pl.courts.join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(pl);
  }
  return uniq;
}

/** 某个时段可用的场地（按场地优先级排序）*/
function courtsForSlot(slotValue, courts, slotCourtMap, courtPriority, sameCourt) {
  const map = slotCourtMap ? slotCourtMap[slotValue] : null;
  let ids = courts.map((c) => c.id);
  if (map instanceof Set && map.size) ids = ids.filter((id) => map.has(id));
  else if (Array.isArray(map) && map.length) ids = ids.filter((id) => map.includes(id));
  return orderCourts(ids, courtPriority);
}

/** 方案内所有时段都可用（交集）的场地 */
function intersectCourtsOf(combo, courts, slotCourtMap) {
  let ids = courts.map((c) => c.id);
  for (const c of combo) {
    const map = slotCourtMap ? slotCourtMap[c.value] : null;
    if (map instanceof Set && map.size) ids = ids.filter((id) => map.has(id));
    else if (Array.isArray(map) && map.length) ids = ids.filter((id) => map.includes(id));
    if (!ids.length) break;
  }
  return ids;
}

/** 方案内任一时段可用的场地（并集）*/
function unionCourtsOf(combo, courts, slotCourtMap) {
  const set = new Set();
  for (const c of combo) {
    const map = slotCourtMap ? slotCourtMap[c.value] : null;
    if (map instanceof Set && map.size) map.forEach((id) => set.add(id));
    else return courts.map((c2) => c2.id);
  }
  return Array.from(set);
}

/** 按 courtPriority 排序（未列出的排在后面，保持原顺序）*/
function orderCourts(ids, courtPriority = []) {
  if (!courtPriority.length) return ids.slice();
  const rank = new Map(courtPriority.map((id, i) => [String(id), i]));
  return ids.slice().sort((a, b) => {
    const ra = rank.has(String(a)) ? rank.get(String(a)) : 9999;
    const rb = rank.has(String(b)) ? rank.get(String(b)) : 9999;
    return ra - rb;
  });
}

/** 在 ranked 中找出「连续且总时长 >= 需求时长」的组合（段数上限 maxSlots，默认 3）*/
function findContiguousCombos(ranked, target, needLen, maxSlots = 0) {
  const combos = [];
  const n = ranked.length;
  const cap = maxSlots > 0 ? maxSlots : 3;
  for (let i = 0; i < n; i++) {
    let acc = [ranked[i]];
    let len = ranked[i].to - ranked[i].from;
    let cursor = ranked[i].to;
    if (len >= needLen && ranked[i].from === target.from && ranked[i].to === target.to) {
      combos.push(acc.slice()); // 恰好等长
      continue;
    }
    for (let j = i + 1; j < n && acc.length < cap; j++) {
      const cur = ranked[j];
      if (cur.from !== cursor) continue; // 不连续
      acc.push(cur);
      len += cur.to - cur.from;
      cursor = cur.to;
      if (len >= needLen) { combos.push(acc.slice()); break; }
    }
  }
  // 按 (起始分钟, 段数) 排序，优先早、段数少
  combos.sort((a, b) => (a[0].from - b[0].from) || (a.length - b.length));
  return combos;
}

/**
 * ★★ 抢场主路径的选型：基于 getNodeAppointInfoList 的网格，
 * 直接给出「有序的目标清单」——每一项都是**已确认可订**的 (场地, 时段组合)。
 *
 * 与 buildPlans 的区别：buildPlans 需要先猜「哪些场地在这个时段可订」，
 * 而这里的网格已经把每片场地每个时段的 disabled 状态明说了，无需猜测，
 * 也不会再出现「场地清单没加载出来 → 退化成不指定场地」那种情况。
 *
 * @param {object} p
 * @param {Array}  p.courts        parseNodeAppointGrid().courts
 * @param {object} p.grid          parseNodeAppointGrid().grid
 * @param {Array}  p.hourPriority  [{from,to,raw}] 目标时段优先级
 * @param {Array}  p.courtPriority [场地nodeid] 场地偏好（空=不限）
 * @param {number} p.maxSlots      单次最多时段数（服务端 maxSelect，通常 2）
 * @param {number} p.minSlots      单次最少时段数（服务端 minSelect，通常 1）
 * @param {boolean} p.sameCourt    同一方案内是否必须同一场地（学校规则：是）
 * @param {string} p.date
 * @returns {Array<{slots:string[], court:string, courtName:string, score:number, reason:string, full:boolean}>}
 */
function buildTargetsFromGrid(p) {
  const {
    courts: courtsIn = [],
    grid = {},
    hourPriority = [],
    courtPriority = [],
    maxSlots = 2,
    minSlots = 1,
    sameCourt = true,
    date = '',
    fallbackRange = null,
    blocked = [],
    conflictGraceMin = 30,
    onlyCourt = null,
  } = p;

  // ★ onlyCourt：「就要这一片场地」。这是**过滤**而不是排序 ——
  //   调用方（--court）明确点名某一片时，其它场地根本不该进候选。
  const onlyId = onlyCourt == null ? '' : String(onlyCourt);
  const courts = onlyId ? courtsIn.filter((c) => String(c && c.id) === onlyId) : courtsIn;

  // ★ 兜底优先级：候选窗口都凑不出来时，允许在「整个放场区间」里任选连续时段。
  //
  // 为什么必须有它：上面的 hourPriority 每一项都是**硬过滤**（时段必须完整落在
  // 目标区间内）。如果不给兜底，配置 ["17:00","19:00"]/["16:00","18:00"]/["18:00","20:00"]
  // 就永远订不到 20:00-22:00 —— 而 2026-10-11 那天 18:00 之后全线被「体育部教学」
  // 固定占用，20:00-21:00（3 片）/ 21:00-22:00（6 片）是当时**唯一**还有 2 小时
  // 连续空场的位置，脚本却在第一步就把它们过滤掉了（日志：「8 个时段有空场地，
  // 匹配出 0 个候选方案」）。
  //
  // 兜底项排在最后 ⇒ 只在偏好时段全部落空时才生效，不影响正常排序。
  let prio = Array.isArray(hourPriority) ? hourPriority.slice() : [];
  if (fallbackRange && fallbackRange.to > fallbackRange.from) {
    const fr = fallbackRange;
    if (!prio.some((x) => x && x.from === fr.from && x.to === fr.to)) {
      prio = prio.concat([{ from: fr.from, to: fr.to, raw: fr.raw || `${fr.from}-${fr.to}` }]);
    }
  }

  // ★ 课表硬约束：显式偏好（用户填的 hourPriority）只要和有课时间重叠**超过**
  //   conflictGraceMin 分钟，就整条降级到末尾 —— 用户 m02402 的原话是「最好不要和我
  //   有课表的时间的冲突」。降级而不是删除：万一当天只有那个窗口有场，还能兜住。
  //   兜底优先级（fr.raw 以「兜底」「空档」开头）本来就已经避开上课时间，不需要再判。
  const grace = Number.isFinite(Number(conflictGraceMin)) ? Math.max(0, Number(conflictGraceMin)) : 30;
  const blk = (Array.isArray(blocked) ? blocked : [])
    .filter((b) => b && Number.isFinite(b.from) && Number.isFinite(b.to) && b.to > b.from);
  const overlapMin = (a, b) => Math.max(0, Math.min(a.to, b.to) - Math.max(a.from, b.from));
  const isFallbackLike = (x) => !!(x && typeof x.raw === 'string' && /^(兜底|空档)/.test(x.raw));
  const conflicted = [];
  const clean = [];
  for (const x of prio) {
    if (!x) continue;
    const over = blk.reduce((acc, b) => acc + overlapMin(x, b), 0);
    if (!isFallbackLike(x) && blk.length && over > grace) {
      conflicted.push({
        from: x.from,
        to: x.to,
        raw: `${x.raw || '偏好时段'}（撞课 ${over} 分钟 > ${grace} 分钟 → 降级）`,
      });
    } else {
      clean.push(x);
    }
  }
  prio = clean.concat(conflicted);

  const bookable = (courtId, time) => {
    const row = grid[courtId] || {};
    const item = row[time];
    return !!item && item.disabled !== true;
  };
  // ★★ 「连着两小时」优先于「一个零散小时」—— 这条判据必须是**全局**的。
  //
  //   踩过的坑（2026-10-12，maxSlots 从 1 改成 2 之后暴露）：
  //   偏好档 [17:00,19:00] 会产出单个 17:00-18:00（该档的 18:00-19:00 被教学占满，
  //   档内永远配不成对），它拿 `(prio.length - hp) * 1e6`（第 1 档 = 1e6 量级）；
  //   而 [16:00,18:00] 档里那个**真正完整的**「16:00-17:00 + 17:00-18:00」只有
  //   `len * 1e3` = 2000 —— 于是残单压过完整单，脚本只抢到 1 小时。
  //   只在一个窗口内部判断没用（实测确认过）：17:00-18:00 在 [17:00,19:00] 档里配不成对，
  //   但它在 [16:00,18:00] 档里能配上，所以判据必须看「同一片场地上紧邻的那一小时能不能订」。
  //
  //   这里先算出「哪些整点后面紧跟着一个**同场地可订**的小时」= viable2Lead，
  //   后面用它把对应的 1 时段残单降级（降 1e6，正好掉到所有完整单之后、
  //   但不会盖过「更次一档」的意义 —— 因为降级只作用于残单，完整单不动）。
  //   注意要**两个方向都看**：某个整点本身可能是「连着两小时」的后半截
  //   （例：[17:00,19:00] 档里的单个 17:00-18:00，它的前一个小时 16:00-17:00
  //    与它在 [16:00,18:00] 档里能凑成完整单）。只往前看会漏掉这种情形（实测确认）。
  const hhmm2 = (min) => `${hhmmOf(min)}-${hhmmOf(min + 60)}`;
  const pairOk = (from) => courts.some((c) => bookable(c.id, hhmm2(from)) && bookable(c.id, hhmm2(from + 60)));
  const viable2Lead = new Set();
  if (Math.max(1, maxSlots) > 1 && minSlots <= 1) {
    const seenFrom = new Set();
    for (const c of courts) {
      for (const t of c.bookableTimes) {
        const s = parseSlot(t);
        if (!s || seenFrom.has(s.from)) continue;
        seenFrom.add(s.from);
        // 自己作为前半截
        if (pairOk(s.from)) viable2Lead.add(s.from);
        // 自己作为后半截（前一小时 + 自己 能凑满两小时同场地）
        if (pairOk(s.from - 60)) viable2Lead.add(s.from);
      }
    }
  }
  const orderIds = orderCourts(courts.map((c) => c.id), courtPriority);
  const courtById = new Map(courts.map((c) => [c.id, c]));
  const targets = [];

  const isFallback = (hp) => prio !== hourPriority && hp === prio.length - 1;

  for (let hp = 0; hp < prio.length; hp++) {
    const target = prio[hp];
    if (!target || target.to <= target.from) continue;

    // 本优先级下、时间上落在目标窗口内的时段（按开始时间排序）
    const inWindow = [];
    for (const c of courts) {
      for (const t of c.bookableTimes) {
        const s = parseSlot(t);
        if (!s) continue;
        if (s.from >= target.from && s.to <= target.to && !inWindow.some((x) => x.value === t)) {
          inWindow.push({ value: t, from: s.from, to: s.to });
        }
      }
    }
    inWindow.sort((a, b) => a.from - b.from || a.to - b.to);
    if (!inWindow.length) continue;

    // 单时段方案 + 连续拼接方案（同一场地内连续）
    const combos = [];
    const cap = Math.max(1, maxSlots);
    // ★ 判据：preferComplete = 一张单里连着 2 小时 优先于 两个零散小时。
    //
    //   踩过的坑（2026-10-12，maxSlots 从 1 改成 2 之后才暴露）：
    //   偏好档 [17:00,19:00] 与 [16:00,18:00] 会**重叠**。旧代码在 [17:00,19:00] 档里
    //   产出单个 17:00-18:00（因为该档的 18:00-19:00 被教学占满，档内永远配不成对），
    //   它拿到 `(prio.length - hp) * 1e6`（第 1 档 = 1e6 量级），而 [16:00,18:00] 档里
    //   那个真正完整的「16:00-17:00 + 17:00-18:00」只有 `len * 1e3` = 2000 ——
    //   于是**残单压过完整单**，脚本只抢到 1 小时。
    //
    //   ★ 所以这条判据必须是**全局**的，不能只在「同一个窗口内」判断：
    //     17:00-18:00 在 [17:00,19:00] 档里配不成对，但它在 [16:00,18:00] 档里能配上。
    //     每个整点只在**它能组成的最长连续段**（也就是最早出现的那个窗口）里判断
    //     「这一段够不够 2 段」—— 够就先收集完整单、把 1 时段残单压到后面去。
    //
    //   预扫：每个起点能拿到的连续段长度（受 cap 限制），只取决于窗口内的时段，
    //   与场地无关，所以扫一遍就够。
    const runLen = new Array(inWindow.length).fill(0);
    for (let i = inWindow.length - 1; i >= 0; i--) {
      if (i === inWindow.length - 1) {
        runLen[i] = 1;
      } else if (inWindow[i + 1].from === inWindow[i].to) {
        runLen[i] = Math.min(cap, runLen[i + 1] + 1);
      } else {
        runLen[i] = 1;
      }
    }
    // 「开头就已经能凑满 cap 段」的起点 —— 这些起点不要再产出 1 时段残单
    const completeLead = new Set();
    for (let i = 0; i < inWindow.length; i++) {
      if (runLen[i] >= cap && cap > 1 && minSlots <= 1) completeLead.add(inWindow[i].from);
    }
    // ★★ 「同一片场地上真的能凑齐 cap 段」的起点集合（completeCover）—— 只收能真正落地的。
    //
    //   踩过的坑（2026-10-12 晚，用周四假想网格暴露）：
    //   completeLead 只按**时间**判断（inWindow 里相邻就往下接），不看场地能不能订。
    //   于是「17-18 全场地订不到」时，第 1 档 [17,19] 里 runLen 仍算 18:00 能凑 2 段
    //   （它接的是 19:00-20:00），把 19:00-20:00 从残单里排除掉 —— 而那个「2 段」组合
    //   其实因为 17-18 订不到、根本生不出来。结果是第 3 档 18-20 只能产出
    //   单个 19:00-20:00（分=4060019），**完整的「18:00-19:00 + 19:00-20:00」**
    //   （分=3119918）永远排不到第一 —— 脚本会去抢 1 小时，而不是连着 2 小时。
    //   所以这里必须按场地逐个验证：同一片场地、整段 cap 小时全部可订。
    const completeCover = new Set();
    if (cap > 1 && minSlots <= 1) {
      for (let i = 0; i < inWindow.length; i++) {
        if (runLen[i] < cap) continue;
        const start = inWindow[i];
        const seg = inWindow.slice(i, i + cap);
        const feasible = seg.every((x) => x.from >= start.from && x.to <= start.to + (cap - 1) * 60)
          && orderIds.some((cid) => seg.every((x) => bookable(cid, x.value)));
        if (feasible) completeCover.add(start.from);
      }
    }
    // 完整单排在前面、残单排在后面（同一档内靠 `(1 - combo.length) * 100` 区分档内先后，
    // 但档之间差 1e6，所以残单**必须**整体降档，不能只靠那 100 分）
    for (let i = 0; i < inWindow.length; i++) {
      const start = inWindow[i];
      const maxChain = Math.max(1, Math.min(cap, runLen[i]));
      let acc = [start];
      // ★ 用 completeCover（落地可行）而不是 completeLead（纸面可行）来跳过残单：
      //   纸面可行但场地订不到的组合，本来就会被下面的 bookable 过滤掉，
      //   却会把同一小时的残单一起吃掉 ⇒ 那一小时彻底没有候选。
      if (!completeCover.has(start.from)) combos.push({ combo: acc.slice(), lead: false, i0: i });
      for (let n = 2; n <= maxChain; n++) {
        acc = acc.concat([inWindow[i + n - 1]]);
        combos.push({ combo: acc.slice(), lead: n === maxChain && maxChain >= cap, i0: i });
      }
    }

    const addedBefore = targets.length;
    for (const entry of combos) {
      const combo = entry.combo;
      const i0 = entry.i0;
      if (combo.length < minSlots || combo.length > cap) continue;
      const len = combo.reduce((a, c) => a + (c.to - c.from), 0);
      if (len <= 0) continue;
      for (const courtId of orderIds) {
        if (!combo.every((c) => bookable(courtId, c.value))) continue;
        const court = courtById.get(courtId) || {};
        const slots = combo.map((c) => c.value);
        const full = len >= target.to - target.from;
        const courtRank = courtPriority.length
          ? Math.max(0, courtPriority.map(String).indexOf(courtId))
          : 0;
        // ★★ 残单降级：这一条只是某组「连着两小时」的**前半截**，而且那组两小时在
        //   **同一片场地**上真的能订到 ⇒ 挪到本档最后。
        //
        //   踩过的坑（2026-10-12 晚）：原判据是 `viable2Lead.has(combo[0].from) && combo.length < cap`，
        //   viable2Lead 是**全局**算的（跨所有档）。于是第 3 档 [18,20] 里那个**完整的**
        //   「18:00-19:00 + 19:00-20:00」什么都没做错，却被它自己的前半截 18:00-19:00
        //   连累：前半截判为「残单」被扣 1e6，而档间差也是 1e6 ⇒ 完整单 3119918 反而
        //   低于第 1 档的残单 18:00-19:00（6060018）。用户要的「连着 2 小时」就这么丢了。
        //   现在改成：只有当**同档内确实存在**一个以同一场地起步的完整两小时单、
        //   且那条完整单比本残单分高时，才降级。完整单自己永远不降级。
        let degradedBy = null;
        if (combo.length < cap && viable2Lead.has(combo[0].from)) {
          const chain = Math.max(1, Math.min(cap, runLen[i0] || 1));
          let bestComplete = null;
          for (let k = 1; k < chain; k++) {
            if (i0 + k >= inWindow.length) break;
            const seg = inWindow.slice(i0, i0 + k + 1);
            if (seg.length < 2) continue;
            if (!seg.every((x) => bookable(courtId, x.value))) continue;
            const best = (prio.length - hp) * 1e6 +
              seg.reduce((a, x) => a + (x.to - x.from), 0) * 1e3 +
              (1 - seg.length) * 100 +
              (courtPriority.length ? -courtRank * 10 : 0) +
              (seg[0].from / 60);
            if (bestComplete == null || best > bestComplete) bestComplete = best;
          }
          const mine = (prio.length - hp) * 1e6 + len * 1e3 +
            (1 - combo.length) * 100 +
            (courtPriority.length ? -courtRank * 10 : 0) +
            (combo[0].from / 60);
          if (bestComplete != null && bestComplete > mine) degradedBy = bestComplete;
        }
        const isDegraded = degradedBy != null;
        // 打分：优先级 > 时长 > 段数少 > 场地偏好 > 开始晚
        //
        // ★ 同一优先级内「开始越晚越优先」——这是 2026-10-11 复盘后改的，原先是最早优先。
        //   原因：兜底区间覆盖一整天（08:00~24:00），若按「最早优先」，兜底档会把
        //   08:00-10:00 排在 20:00-22:00 前面，脚本就会去抢早场 —— 而用户明确要的是
        //   傍晚/晚上。改成最晚优先后，兜底档首选项正是 20:00-22:00（那天唯一的机会）。
        //   这也同时满足「17-19 优先于 16-18」的偏好（同为 2 小时时更晚的开始更靠前）。
        const score =
          (prio.length - hp) * 1e6 +
          len * 1e3 +
          (1 - combo.length) * 100 +
          (courtPriority.length ? -courtRank * 10 : 0) +
          (combo[0].from / 60);
        targets.push({
          slots,
          court: courtId,
          courtName: court.name || courtId,
          date,
          score: isDegraded ? score - 1e6 : score,
          full,
          len,
          // ★★ 「一张单连着 2 小时」标记。只有 `maxSlots >= 2` 时它才可能为 true；
          //   排序把它放在**第一关键字**（见下面的 sort），因为用户 m01954 起的口径是
          //   「先保证连着 2 小时，再谈落在哪个偏好档」。
          //
          //   踩过的坑（2026-10-12 晚，用「周四 17-18 被别人抢走」的假想网格暴露）：
          //   第 1 档 [17,19] 只剩 18:00-19:00 这 1 小时（分=7060018），第 3 档 [18,20] 里
          //   「18:00-19:00 + 19:00-20:00」这个**完整两小时**只有 3119918 —— 纯按 score 排，
          //   脚本会去抢 1 小时，把完整两小时让掉。每档 1e6 的差价靠「多 1 小时只值
          //   1e3×60」永远追不回来，所以必须把「完整两小时」提到档位之前比较。
          //   同一档内、以及同为完整/同为残单时，仍然按 score（档位 → 时长 → 开始晚）排。
          complete2: cap > 1 && combo.length >= cap,
          // 优先级档号（0 = 最高优先级）。配对优先只用它判断「两条是不是同一档」，
          // 不要去解析 reason 字符串 —— 那太脆。
          tier: hp,
          reason:
            `目标时段 ${target.raw} → ${slots.join(' + ')} @ ${court.name || courtId}` +
            `（${len} 分钟，` +
            (isFallback(hp) ? '兜底：任选连续时段' : `第 ${hp + 1} 优先级`) +
            `${full ? '，正好点满' : ''}` +
            `${isDegraded ? '，但有更完整的连续两小时，先让别人' : ''}）`,
        });
      }
    }
  }

  // ★★ 排序：**先「能不能凑成完整两小时」**（complete2），再按 score（档位 → 时长 →
  //   开始越晚越优先）。理由见上面 `complete2` 处的注释：档间 1e6 的差价压过
  //   「多 1 小时」的 1e3×60，不把完整单提到第一关键字，脚本就会拿 1 小时残单
  //   而放掉同一片场地上真正的连续两小时。
  targets.sort((a, b) => (b.complete2 ? 1 : 0) - (a.complete2 ? 1 : 0) || b.score - a.score);
  const seen = new Set();
  const uniq = [];
  for (const t of targets) {
    const key = t.slots.join(',') + '|' + t.court;
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(t);
  }

  // ★ 配对优先：用户要的是「两片场地各 1 小时、两段连着」＝ 两张单。
  //   两张单要落在**首尾相接**的两个小时上（例：A 场 17:00-18:00 + B 场 18:00-19:00），
  //   所以候选排序必须把「能配成对的那一个小时」排在最前面，否则 burst 会先下
  //   两个接不上的孤立小时（甚至同一个小时买两遍），钱花两份、时间凑不成连续两小时。
  //
  //   ★ 为什么允许跨优先级档配对（踩过的坑）：
  //     时段是整点切开的（…16:00-17:00 / 17:00-18:00 / 18:00-19:00…），而偏好区间
  //     形如 [17:00,19:00] —— 于是 17:00-18:00 落在第 1 档、16:00-17:00 掉到后面的档里。
  //     实测只允许同档配对时，「两张单都下 17:00-18:00」照样发生。所以配对条件是纯时间的：
  //     前一段的 to === 后一段的 from。
  //     「连续两小时」是用户明确的硬需求，优先级比「先占住偏好档里的某个整点」更高
  //     （跨档取时段本来就有先例：偏好区间末尾会自动追加「没课的空档」）。
  //
  //   配好的「下一段」挂在 `t.pair` 上，由 src/grab.js 的 _planOrders 一次性下成两张单。
  //   打分：可配对 = 加 `(prio.length + 1) * 1e6`，稳稳压过所有孤立候选（孤立最高约
  //   (prio.length) * 1e6）；再减去「这条链里最低的档号」，于是同样是配对，
  //   档号更小的（更贴近用户偏好）排在前面。
  if (uniq.length > 1) {
    const boundOf = (t) => {
      const se = /(\d{1,2}):(\d{2})\D+(\d{1,2}):(\d{2})/.exec(String((t.slots && t.slots[0]) || ''));
      return se ? { from: +se[1] * 60 + +se[2], to: +se[3] * 60 + +se[4] } : null;
    };
    const bySlot = new Map();
    uniq.forEach((t, i) => {
      const b = boundOf(t);
      if (!b) return;
      // ★ 只登记「真的可订」的候选。踩过的坑：网格里每个时段的 key 都存在
      //   （不可订的只是 disabled=true），若按键去查就会把一个**订不了**的时段
      //   当成配对方，配对计划里出现一张注定失败的第二个小时。
      if (t.court && !bookable(t.court, t.slots[0])) return;
      if (t.slots && t.slots.some((s) => !bookable(t.court || (t.courts || [])[0], s))) {
        // 多时段候选（buildPlans 产物）只要有一段订不了就不参与配对
        const anyOk = (t.courts || [t.court]).some(
          (cid) => t.slots.every((s) => bookable(cid, s))
        );
        if (!anyOk) return;
      }
      const key = String((t.slots && t.slots[0]) || '');
      if (!bySlot.has(key)) bySlot.set(key, { i, b });
    });
    const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
    // 先给所有候选找配对（只记标志与分数加成，最后统一加一次）
    const boostQueue = new Set();
    for (let i = 0; i < uniq.length; i++) {
      const t = uniq[i];
      const b = boundOf(t);
      if (!b) continue;
      // 先找「紧接着的下一段」，没有再找「紧挨着的前一段」（两段连续即可，谁先谁后无所谓）
      let partner = bySlot.get(`${hhmm(b.to)}-${hhmm(b.to + 60)}`);
      if (!partner) partner = bySlot.get(`${hhmm(b.from - 60)}-${hhmm(b.from)}`);
      const pt = partner && partner.i !== i ? uniq[partner.i] : null;
      if (!pt || !pt.slots || !pt.slots.length) continue;
      const ptier = Math.min(
        Number.isFinite(t.tier) ? t.tier : 99,
        Number.isFinite(pt.tier) ? pt.tier : 99
      );
      t.pairable = true;
      t.pair = { court: pt.court, courtName: pt.courtName, slots: pt.slots.slice() };
      t.pairTier = ptier;
      boostQueue.add(t);
      // ★ 配对的两条必须**同分**。踩过的坑：以前只有「先被遍历到的那一条」涨分，
      //   于是同一条链里的两条候选差了一整档（1e6），burst 会先抢走其中一小时、
      //   另一小时被别的候选顶掉 —— 而「连着两小时」本来就要求两条都到手。
      if (pt.pairTier == null) pt.pairTier = ptier;
      boostQueue.add(pt);
    }
    // 再加配对加成：同一条链里的两条加同一个数（取链上最低档号），保证同分
    for (const t of boostQueue) {
      const ptier = Number.isFinite(t.pairTier) ? t.pairTier : 99;
      t.score += (prio.length + 1) * 1e6 - ptier * 1e6;
    }
    // ★★ 这里必须**再带上 complete2 这个第一关键字**。
    //
    //   踩过的坑（2026-10-12 晚，用「周四 17-18 被别人抢走」的假想网格暴露）：
    //   配对加成是给**单时段**候选的（`(prio.length + 1) * 1e6` 量级，稳稳压过所有
    //   孤立候选），它是「两片场地各 1 小时、两张单」那个已被平台拒绝的旧口径留下的。
    //   现在口径是「一张单连着 2 小时、同一片场地」，于是那些被加成的单时段候选会
    //   反过来压过**真正的完整两小时**：实测第 1 档残单 18:00-19:00 拿到 7060018，
    //   而第 3 档「18:00-19:00 + 19:00-20:00」只有 3119918 ⇒ 第一候选变成 1 小时。
    //   complete2 在第一关键字上把完整两小时顶回来；同为完整/同为残单时再按 score
    //   （档位 → 时长 → 开始越晚越优先），所以「完整但档位低」仍然优先于「残单但档位高」。
    uniq.sort((a, b) => (b.complete2 ? 1 : 0) - (a.complete2 ? 1 : 0) || b.score - a.score);
  }
  return uniq;
}

module.exports = {
  extractCourts,
  matchesTarget,
  rankSlots,
  buildPlans,
  orderCourts,
  findContiguousCombos,
  parseNodeAppointGrid,
  buildTargetsFromGrid,
};
