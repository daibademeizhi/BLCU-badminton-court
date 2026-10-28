'use strict';
/**
 * 抢场主流程
 *
 * ── 数据源 ──────────────────────────────────────────────────────────────
 *  只用两个接口就能完成全部判断：
 *   ① POST /phone/getNodeAppointInfoList {parentNodeId, appointDate}
 *      一次拿到「放场规则 + 单次上限 + 整馆场地×时段网格 + 每个不可订时段的原因」。
 *   ② POST /phone/getPayPrice / POST /phone/reservation  取价与锁场。
 *
 *  历史上的错误路径（已废弃）：先 getBookingTimeRange → getAppointmentTimeSlot →
 *  getSiteAppointInfo。实测 getSiteAppointInfo 恒返回「获取座位预约情况异常」，
 *  导致场地清单永远加载失败、退化成「不指定场地」，且每轮白白多花两次请求。
 *
 * ── 时间线 ──────────────────────────────────────────────────────────────
 *  T-预热   拉一次网格 → 用 serverNow 校准时钟（按 UTC+8 解析，避免本机时区干扰）
 *           → 定出目标日期与放场时刻（nextReleaseAt，缺省则用 bookingStartTime）。
 *  T-待命   睡眠到放场时刻 - leadMs。
 *  T+0      冲刺：高频轮询网格；一旦目标日期出现「目标时段 + 有空场地」的组合，
 *           立刻按打分顺序取价 → POST /phone/reservation 锁场。
 *  T+n      支付：pay.mode = auto 走校园卡余额通道，否则推送付款提示（半自动）。
 *
 * ── 用法 ────────────────────────────────────────────────────────────────
 *  node src/grab.js                      # 按配置执行（自动等待放场时刻）
 *  node src/grab.js --poll               # 不抢，只打印当前网格（安全，随时可跑）
 *  node src/grab.js --now --dry-run      # 立刻冲刺但不真正下单（联调演练）
 *  node src/grab.js --date 2026-10-13    # 指定目标日期（优先级最高）
 *  node src/grab.js --rel 2              # 目标日期 = 本机今天 + 2 天（T+2；盖过 config 里的日期）
 *  node src/grab.js --rel 2 --window 18:00-20:00   # 只在 18:00-20:00 这段里抢
 */

const path = require('path');
const fs = require('fs');
const { loadConfig, parseSlot, applyWindowOverrides, applyPriorityOverrides } = require('./config');
const { ApiClient, ApiError } = require('./client');
const { ServerClock, sleep, fmtFull, fmtServer, fmtServerDate, parseServerTs, serverDateTime, toMinutes } = require('./util');
const { Logger } = require('./log');
const { parseNodeAppointGrid, buildTargetsFromGrid } = require('./target');
const { notify } = require('./notify');
const { AutoPay } = require('./pay');
const { ensureToken, tokenSecondsLeft } = require('./login');

// ───────────────────────── 课表（时段级硬约束）─────────────────────────

/** "HH:MM" → 当天分钟数；解析不出来返回 null（不抛异常，坏配置只跳过） */
function safeToMin(v) {
  try {
    const n = toMinutes(v);
    return Number.isFinite(n) ? n : null;
  } catch (e) {
    return null;
  }
}

/** 分钟数 → "HH:MM" */
function fmtHM(min) {
  const m = Math.max(0, Math.min(24 * 60, Math.round(min)));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** 星期键归一化：mon/1/mon.… → 0=周一 … 6=周日 */
function normWeekKey(k) {
  const s = String(k).trim().toLowerCase();
  const map = {
    mon: 0, monday: 0, '1': 0,
    tue: 1, tues: 1, tuesday: 1, '2': 1,
    wed: 2, weds: 2, wednesday: 2, '3': 2,
    thu: 3, thur: 3, thurs: 3, thursday: 3, '4': 3,
    fri: 4, friday: 4, '5': 4,
    sat: 5, saturday: 5, '6': 5,
    sun: 6, sunday: 6, '7': 6, '0': 6,
  };
  return Object.prototype.hasOwnProperty.call(map, s) ? map[s] : null;
}

/** "YYYY-MM-DD" → 0=周一 … 6=周日（按日期本身算，不依赖本机时区/时钟）*/
function weekdayOfDateStr(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || '').trim());
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return (d.getUTCDay() + 6) % 7;
}

/** 区间列表合并（重叠/相邻的并成一个）*/
function mergeIntervals(list) {
  const arr = list
    .filter((x) => x && Number.isFinite(x.from) && Number.isFinite(x.to) && x.to > x.from)
    .map((x) => ({ from: x.from, to: x.to }))
    .sort((a, b) => a.from - b.from || a.to - b.to);
  const out = [];
  for (const it of arr) {
    const last = out[out.length - 1];
    if (last && it.from <= last.to) last.to = Math.max(last.to, it.to);
    else out.push({ from: it.from, to: it.to });
  }
  return out;
}

/** 区间集合一次做差：[aStart, aEnd) 里挖掉 blocks 之后剩下的空档 */
function subtractIntervals(aStart, aEnd, blocks) {
  let free = [{ from: aStart, to: aEnd }];
  for (const b of blocks) {
    const next = [];
    for (const seg of free) {
      if (b.to <= seg.from || b.from >= seg.to) { next.push(seg); continue; }
      if (b.from > seg.from) next.push({ from: seg.from, to: Math.min(b.from, seg.to) });
      if (b.to < seg.to) next.push({ from: Math.max(b.to, seg.from), to: seg.to });
    }
    free = next;
  }
  return free.filter((s) => s.to > s.from);
}

/**
 * ★ 内置课表（2026-2027 第一学期，第 6 周，来自校园系统截图 G:\图片\课表.jpg，
 *   经 J:\DS\Personal Info\01-education\education.md 第 6 节核对）。
 *
 * ⚠️ 截图里只有「第几节」，没有钟点，所以下面的钟点用的是北语常见口径：
 *      一、二节 08:00-09:40   三、四节 10:10-11:50   五、六节 14:00-15:40
 *      九、十节 18:30-20:05   十一、十二节 20:15-21:50
 *    其中「九、十节」的**结束时刻**直接决定傍晚能不能打球，是整个避让逻辑里最敏感
 *    的数字 —— 请到教务系统核对一次。config.yaml 的 target.schedule 一旦非空就会
 *    完全覆盖这里的默认值。
 */
/**
 * ★ 课表避让的总开关。
 *
 * 三态语义（写进 config.yaml 的 target.schedule 里）：
 *   - `target.schedule.enabled: false`  → **完全不避让**，任何时段都能订。
 *   - `target.schedule.classes` 非空    → 用配置里的课表（权威，覆盖内置）。
 *   - 都没有                            → 用下面的 DEFAULT_SCHEDULE。
 *
 * 为什么不做「空对象 = 空课表」这种隐式推断：那样 `classes: {}` 会同时表示
 * 「我还没填」和「我就是要全天可订」两种相反的意思，调试时根本分不清。
 */
function scheduleEnabled(cfg) {
  const sch = (cfg && cfg.target && cfg.target.schedule) || {};
  return sch.enabled !== false;
}

const DEFAULT_SCHEDULE = {
  mon: [['08:00', '09:40'], ['10:10', '11:50']],
  tue: [['10:10', '11:50']],
  wed: [['08:00', '09:40'], ['10:10', '11:50'], ['14:00', '15:40'], ['18:30', '21:05']],
  // ★ 周四只有「日语专题阅读与写作」（一、二节 08:00-09:40）与「日语口译（一）」
  //   （五、六节 14:00-15:40）—— **晚上没有课**。
  //   踩过的坑（2026-10-12）：这里原本还写了 ['18:30','20:05']，那其实是**周三**第九节
  //   「生活中的法律常识」（教二301）的钟点，被串到周四来了。后果是：周四 18:00-20:00
  //   这个用户明确要的傍晚档被自己的课表避让降级，脚本白让出 18:00-20:00 —— 而用户
  //   周四 15:40 之后就完全没课（用户原话：「我周四晚上都没课」）。
  thu: [['08:00', '09:40'], ['14:00', '15:40']],
  fri: [],
};

/** 默认把「星期三的晚课」标成不上（用户 m02402：星期三的晚课我基本不去）*/
const DEFAULT_FREE_OVERRIDE = {
  wed: [['18:30', '21:05']],
};

// ───────────────────────── CLI ─────────────────────────

function parseArgs(argv) {
  const out = { flags: new Set(), opts: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config' || a === '-c') out.opts.config = argv[++i];
    else if (a === '--date' || a === '-d') out.opts.date = argv[++i];
    else if (a === '--rel') out.opts.rel = argv[++i];
    else if (a === '--expect') out.opts.expect = argv[++i];
    else if (a === '--interval') out.opts.interval = Number(argv[++i]);
    else if (a === '--max-rounds') out.opts.maxRounds = Number(argv[++i]);
    // ★ --window 可重复（每次一段），也支持 --window=18:00-20:00 这种写法；
    //   一个值里用逗号分隔多段同样认（解析在 config.applyWindowOverrides 里）。
    else if (a === '--window' || a === '--win' || a === '-w') {
      if (!out.opts.windows) out.opts.windows = [];
      out.opts.windows.push(argv[++i]);
    } else if (a.startsWith('--window=')) {
      if (!out.opts.windows) out.opts.windows = [];
      out.opts.windows.push(a.slice('--window='.length));
    } else if (a === '--slots') out.opts.slots = Number(argv[++i]);
    // ★ --priority：按顺序试（偏好，保留兜底）；与 --window（约束，关掉兜底）互斥。
    else if (a === '--priority' || a === '--prior') {
      if (!out.opts.priority) out.opts.priority = [];
      out.opts.priority.push(argv[++i]);
    } else if (a.startsWith('--priority=')) {
      if (!out.opts.priority) out.opts.priority = [];
      out.opts.priority.push(a.slice('--priority='.length));
    } else if (a === '--court') out.opts.court = argv[++i];
    else if (a.startsWith('--court=')) out.opts.court = a.slice('--court='.length);
    // ★ --no-wait：不等放场。给「帮买」用 —— 用户是看着「现在还剩几片」点的，
    //   那一刻就能下单；这一下没抢到（被别人抢先）应该立刻如实失败，
    //   而不是挂进候场循环等到明天早上（那在用户眼里就是「卡死」）。
    else if (a === '--no-wait') out.flags.add('no-wait');
    else if (a === '--help' || a === '-h') out.flags.add('help');
    else if (a.startsWith('--')) out.flags.add(a.slice(2));
  }
  return out;
}

const argv = process.argv.slice(2);
const cli = parseArgs(argv);

if (cli.flags.has('help')) {
  console.log(`
BLCU 羽毛球抢场脚本

用法：
  node src/grab.js [选项]

选项：
  -c, --config <path>     指定配置文件（默认 ./config.yaml，回退 ./config.example.yaml）
  -d, --date <YYYY-MM-DD> 指定目标日期（优先级最高，盖过 --rel 与 config）
      --rel <±N>          目标日期 = 本机今天 + N 天（如 --rel 2 = T+2）
                          ★ 优先级：--date > --rel > config.target.date > 窗口最后一天
                            所以 cron 里传 --rel 2 就一定抢 T+2，不受 config 里遗留日期影响
      --expect <HH:MM>    期望放场时刻（仅用于日志提示；实际以服务端 nextReleaseAt 为准）
  -w, --window <时段>     只用这个时间段抢，如 --window 18:00-20:00（也认 18-20）
                          可重复写多次 = 多个备选；一个值里用逗号分隔多段也行
                          ★ 指定后进入「严格模式」：只在这几段里选，
                            不会再像平时那样「偏好落空就兜底到当天任意空档」
      --slots <n>         配合 --window：这一单最少凑 n 小时（默认沿用
                          config.target.minSlots，但不超过窗口长度）
      --priority <时段>   按顺序试的**偏好**列表，如 --priority 16:00-18:00,17:00-19:00
                          ★ 与 --window 的区别：--window 是约束（只在里面选、没有就收手），
                            --priority 是偏好（都落空时仍允许兜底到当天其它空档）
      --court <场地id>    点名某一片场地（其余场地不进候选）。配合菜单「挑场地」用
      --no-wait           不等放场，现在不能下单就直接失败（「帮买」用）
      --interval <ms>     覆盖冲刺轮询间隔（默认 configuration schedule.burstPollMs）
      --max-rounds <n>    最多冲刺轮数（默认 configuration schedule.maxRounds）
      --now               忽略等待，立刻冲刺（调试用）
      --poll              安全模式：打印当前网格与放场状态后退出，不抢
      --dry-run           走到「提交下单」前停住，不真正下单
      --verbose           输出调试日志
`);
  process.exit(0);
}

// ───────────────────────── 抢场器 ─────────────────────────

class Grabber {
  constructor(cfg, log, opts = {}) {
    this.cfg = cfg;
    this.log = log;
    this.opts = opts;
    this.clock = new ServerClock();
    this.rows = {};       // 本程序运行期间的所有日志行（用于 {lines} 通知）
    this.rows.rows = [];  // 兼容旧占位

    this.targetDate = opts.date || null;
    this.targets = [];
    this.grid = null;     // 最近一次的 parseNodeAppointGrid 结果
    this.releaseAt = null;
    this._releaseSeenAt = null; // 候场里「刚看到放场窗口滚开」的时刻（避免放场瞬间重复拉网格）
    this.result = {
      at: Date.now(),
      targetDate: null,
      releaseAt: null,
      attempts: [],
      // ★ orders = 本次真正锁下来的订单列表（可能不止一张，「两片场地各 1 小时」要两张单）。
      //   locked 保留为「第一张」（= orders[0]），因为报告/落盘/支付的老代码都读它；
      //   新代码请优先读 orders。两者永远同步更新（见 _lockOrder）。
      orders: [],
      locked: null,
      paid: null,
      paidAll: null,
      error: null,
      rounds: 0,
      http: 0,
      observed: [],      // 每次拉到的网格摘要
    };
  }

  // ── 基础设施 ──

  get api() {
    if (!this._api) {
      this._api = new ApiClient({
        baseUrl: this.cfg.baseUrl,
        prefix: this.cfg.prefix,
        token: this.cfg.auth.token,
        timeout: this.cfg.net.timeoutMs,
        minInterval: Math.max(this.cfg.net.minIntervalMs, 250),
        maxReservationPosts: this.cfg.net.maxReservationAttempts,
        verbose: !!this.opts.verbose,
      });
    }
    return this._api;
  }

  // ── 拉取网格 ──

  /**
   * 拉「指定日期」的整馆网格。
   * 注意：getNodeAppointInfoList 用的是 callRaw，返回完整响应体 ——
   * 「尚未放场」是正常状态（success=false + message），不是异常，必须自己判。
   */
  async fetchGrid(date) {
    const d = date || this.targetDate;
    if (!d) throw new ApiError('未确定目标日期，无法拉取网格', 0, null, 'business');
    const t0 = Date.now();
    const raw = await this.api.getNodeAppointInfoList({
      parentNodeId: this.cfg.venue.nodeid,
      appointDate: d,
    });
    const rtt = Date.now() - t0;
    this.result.http++;
    if (!raw || raw.success !== true || !raw.resultData) {
      const msg = (raw && raw.message) || '无数据';
      const isAuth = !raw || msg === '登录超时' || /登录|token|鉴权/i.test(msg);
      return { ok: false, message: msg, rtt, authHint: isAuth };
    }
    const grid = parseNodeAppointGrid(raw.resultData, { date: d });
    if (!grid) {
      return { ok: false, message: '网格为空（nodeTimeList 无场地）', rtt, raw: raw.resultData };
    }
    this.grid = grid;
    // ★ 网格必须是「目标日期那一份」才允许当目标网格缓存。
    //   踩过的坑：warmup 先探「服务端今天」拿放场窗口，探完 _targetGrid 就留着今天那一份；
    //   之后 _idleWaitForRelease / burst 换成了目标日期的网格，_targetGrid 却还是旧的，
    //   于是 _hasBookableTarget()（读 _targetGrid）说「有候选」、buildTargets()（读 this.grid）
    //   说「0 个候选」，两条判据各说各话：闸门被一个不存在的候选顶开，真正能订的时段却
    //   一个都没被尝试，冲刺空转到把预算耗光。这里统一：只给「当前目标日期」盖章。
    if (d && this.targetDate && String(d) === String(this.targetDate)) {
      this._targetGrid = grid;
    }

    // 用 serverNow 校准时钟（按 UTC+8 解析）
    if (raw.resultData.serverNow) {
      const t = parseServerTs(raw.resultData.serverNow);
      if (t) this.clock.calibrate(t, t0, Date.now());
    }
    return { ok: true, grid, rtt };
  }

  /** 网络抖动时的宽容版：3 次尝试，每次都重新加密 */
  async fetchGridRetry(date, tries = 3) {
    let last = null;
    for (let i = 0; i < tries; i++) {
      try {
        return await this.fetchGrid(date);
      } catch (e) {
        last = e;
        this.log.warn(`  拉网格第 ${i + 1}/${tries} 次失败：${e.message}`);
        await sleep(300 + i * 300);
      }
    }
    throw last;
  }

  // ── 预热：定目标日期与放场时刻 ──

  async warmup() {
    // 先用「服务端今天」探一次，拿到日历与规则；目标日期未定则自动挑。
    // ★ 注意：目标日期可能「还没放出来」（例如 10-11 07:50 想看 10-13），
    //   这时服务端会回业务失败「该场馆暂无场地可预约」——那不是错误，是常态，
    //   所以这里不抛异常，而是继续等待放场（由 _idleWaitForRelease 复查）。
    const todayDate = this.opts.date || null;
    let probe = null;
    if (todayDate) {
      probe = await this.fetchGridRetry(todayDate, 1);
    } else {
      // 服务端今天 = 本地时间也要按 UTC+8 口径推，避免时区干扰
      const guessToday = fmtServerDate(Date.now());
      probe = await this.fetchGridRetry(guessToday);
      if (!probe.ok) {
        // 今天没放（例如已过 23:59 结算窗口），试明天
        const tomorrow = fmtServerDate(Date.now() + 86400000);
        this.log.info(`服务端今天（${guessToday}）未放场，改试 ${tomorrow}`);
        probe = await this.fetchGridRetry(tomorrow);
      }
    }

    const f = (probe.grid && probe.grid.dateFields) || {};
    if (!probe.ok) {
      // 预探失败也要让流程继续：目标日期固定时，真正的判据是
      // 「目标日期是否进入窗口」，而那要靠后续复查
      this.log.warn(`预探网格未成功：${probe.message}（继续按候场逻辑复查目标日期）`);
    }
    if (f.bookingStartDate || f.bookingEndDate) {
      this.log.info(
        `放场窗口 ${f.bookingStartDate} ~ ${f.bookingEndDate}  ` +
        `releaseStatus=${f.releaseStatus} releaseMode=${f.releaseMode} targetMode=${f.targetMode}`
      );
      this.log.info(`预订时段 ${f.bookingStartTime} ~ ${f.bookingEndTime}   单次最多 ${f.maxSelect} 小时   每片容量 ${f.capacity} 人`);
    }
    const serverToday = fmtServerDate(this.clock.now());
    this._serverToday = serverToday; // 供 _gateOpen() 判断「今天在不在放场窗口里」
    this.log.info(
      `服务端时间 ${fmtServer(this.clock.now())}（本机 ${fmtFull(Date.now())}，` +
      `时钟偏差 ${((this.clock.offset || 0) / 1000).toFixed(1)}s）`
    );

    // 目标日期：--date > --rel > 配置里的 target.date > 窗口最后一天（= 每天 08:00 刚放出来的那一天）
    //
    // ★ 2026-10-11 踩的坑：原来 --rel 排在 target.date **之后**，于是路由器 cron 里写的
    //   `--rel 2` 被 config.yaml 里遗留的 `date: "2026-10-13"` 整个盖掉 —— 表面每天都在跑，
    //   实际永远盯着 10-13；过了那天之后被日期护栏挡住，静默地一次都抢不到。
    //   现在 --rel 在 config 之前：cron 传 --rel 2 就一定抢 T+2，config 的日期只当默认值。
    const cfgTarget = (this.cfg.target && this.cfg.target.date) || '';
    if (!this.targetDate && this.opts.rel != null && String(this.opts.rel).trim() !== '') {
      const n = parseInt(String(this.opts.rel).replace(/^\+/, ''), 10);
      if (Number.isFinite(n)) {
        this.targetDate = fmtServerDate(Date.now() + n * 86400000);
        const shadow = cfgTarget ? `（注意 config.yaml 里还写着 target.date: "${String(cfgTarget).trim()}"，本次以 --rel 为准）` : '';
        this.log.info(`目标日期（按 --rel ${this.opts.rel} 计算）：${this.targetDate}${shadow}`);
        if (shadow) {
          this.log.warn(
            `config.yaml 的 target.date 和命令行 --rel 同时存在 → 用 --rel ${this.opts.rel}（${this.targetDate}）。` +
            `想固定日期就把 target.date 写上并**去掉** cron 里的 --rel。`
          );
        }
      } else {
        this.log.warn(`--rel ${this.opts.rel} 不是有效天数，忽略它`);
      }
    }
    if (!this.targetDate && cfgTarget) {
      this.targetDate = String(cfgTarget).trim();
      this.log.info(`目标日期（取自 config.yaml 的 target.date）：${this.targetDate}`);
    }
    if (!this.targetDate) {
      this.targetDate = f.bookingEndDate || f.date;
      this.log.info(`目标日期（自动取窗口最后一天 = 每天 08:00 新放出的那天）：${this.targetDate}`);
    }

    // 放场时刻：nextReleaseAt 优先；否则按「目标日期 − 窗口跨度」天的 bookingStartTime 推
    this.releaseAt = this._resolveReleaseAt(f, serverToday);
    if (this.releaseAt) {
      const delta = this.releaseAt - this.clock.now();
      this.log.info(
        `放场时刻 ${fmtServer(this.releaseAt)}（距现在 ${(delta / 1000).toFixed(1)}s）` +
        (delta < 0 ? '  ← 已过（该日期的放场早就发生了）' : '')
      );
    } else {
      this.log.info('服务端未下发 nextReleaseAt，且目标日期未确定放场时刻 → 直接进入冲刺轮询');
    }

    // 若目标日期与预热用的不是同一天，补拉一次目标日期的网格
    const probedDate = f.date;
    if (probedDate !== this.targetDate) {
      const g2 = await this.fetchGridRetry(this.targetDate);
      if (g2.ok) {
        this._targetGrid = g2.grid;
        this.log.info(`已补拉目标日期 ${this.targetDate} 的网格`);
      } else {
        if (g2.authHint) {
          throw new ApiError(
            `鉴权失败/会话失效（服务端返回「${g2.message}」）——请按 recon/TOKEN.md 重新抓 token 后执行 ` +
            `node src/probe.js set-token <token>`,
            0, null, 'auth'
          );
        }
        this.log.info(`目标日期 ${this.targetDate} 当前：${g2.message}（预期如此，等放场即可）`);
      }
    } else {
      this._targetGrid = this.grid;
    }

    // 目标日期是否**现在**就能下单？两个条件缺一不可：
    //   ① 网格里确实有匹配的候选场地；
    //   ② 已经到了放场时刻。
    // ★ 2026-10-11 事故：只判 ① 的话，滚动放场模式下网格会**提前**把即将放出的那天
    //   标成可订（07:45 查 10-13 时 20:00-21:00 显示 3 片空），于是脚本在 08:00 前
    //   就疯狂下单，连吃「预约将于 08:00:00 开放」，把熔断预算全部烧光 —— 等真开闸
    //   时反而一次都提交不了。所以 ② 是硬闸门。
    this._targetReady = this._hasBookableTarget() && this._gateOpen();
    this.log.info(
      this._targetReady
        ? '目标日期已可下单 → 直接进入冲刺'
        : (this._hasBookableTarget()
          ? `目标日期网格已有候选场地，但尚未开闸（${this._gateReason()}）→ 先候场，到点再提交`
          : `目标日期 ${this.targetDate} 暂无可订场地 → 将等到放场时刻`)
    );

    this._logGrid();
  }

  /**
   * ★ 下单闸门：放场时刻之前一律不提交预约。
   *
   * 滚动放场模式下，网格接口会**提前**把尚未放出的日期标成「可订」，但 `reservation`
   * 会回业务失败「预约将于 <时刻> 开放」。这种请求既拿不到订单，又会消耗熔断预算，
   * 一旦在开闸前烧光，真正的抢场窗口（实测只有十几秒）就完全错过了。
   *
   * 两条判据（都必须满足才放行）：
   *   ① 有确定的放场时刻，且已经到点；
   *   ② ★ 服务端「今天」已经**不在**网格那版放场窗口里了 —— 也就是窗口滚动过至少一次。
   *
   * ② 是 2026-10-11 事故补的第二道闸。原因：`--rel 2` 在窗口还没滚的时刻跑时，
   * `releaseAt` 按「目标日期 − 窗口跨度天」推出来的是**上一轮放场的过去时刻**，
   * 单看 ① 会被判成「已开闸」，可网格其实还是昨天那一版快照（目标日期压根没进去），
   * 下单只会连吃业务失败、把熔断预算烧光 —— 和 10-11 那天一模一样的死法。
   * 窗口还没滚 ⇒ 真正开闸在「今天 bookingStartTime」那一刻 ⇒ 先关闸候场。
   *
   * ⚠ 这里刻意用 grid 自己的 dateFields 而不是「本次网格是哪一天的快照」：
   *   dateFields 跟网格是同一次响应里下来的，天然同步，不依赖调用方先设好某个字段。
   *   即使网格已经换成目标日期的快照，只要目标日期落在窗口里就放行，不会误伤正常抢场。
   *
   * （服务端既没给窗口也没给放场时刻时只能放行，靠 reservation 自身拒绝 + 熔断兜底；
   *   真开闸那一刻本函数会放行，紧急通道不受影响。）
   */
  _gateOpen() {
    return this._gateClosedReason() === null;
  }

  /** 闸门为什么关着；开着时返回 null。留给日志用，避免把原因写成两句重复的话。 */
  _gateReason() {
    const why = this._gateClosedReason();
    return why === null ? '闸门已开' : why;
  }

  _gateClosedReason() {
    if (!this.releaseAt) return null;
    if (this.clock.now() < this.releaseAt) {
      return `未到放场时刻 ${fmtServer(this.releaseAt)}`;
    }

    const f = (this.grid && this.grid.dateFields) || {};
    const a = f.bookingStartDate;
    const b = f.bookingEndDate;
    if (a && b && this.targetDate && !(this.targetDate >= a && this.targetDate <= b)) {
      // 目标日期还没进窗口 ⇒ 服务端还没放出它 ⇒ 现在下单只会吃业务失败。
      // 「今天是否还在窗口内」用来区分两种情形（见 _resolveReleaseAt 的注释）：
      //   今天仍在窗口内 → 上一轮放场过后窗口还没滚 ⇒ 真正的开闸时刻是今天 08:00
      //   今天已不在窗口内 → 窗口至少滚过一次，但目标日期仍没进来 ⇒ 放行交给护栏/熔断
      const today = this._serverToday || fmtServerDate(this.clock.now());
      if (today >= a && today <= b) {
        return `目标 ${this.targetDate} 还没进入放场窗口 ${a} ~ ${b}` +
          `（服务端今天 ${today} 仍在窗口内）→ 真正开闸时刻为今天 ${f.bookingStartTime || '08:00'}`;
      }
    }
    return null;
  }

  /**
   * 「目标日期那份网格」的唯一入口。
   *
   * ★ 为什么必须有它：`_hasBookableTarget()` 读 `_targetGrid || this.grid`，
   *   而 `buildTargets()` 原来只读 `this.grid`。两份不是同一张网格时就会互相打脸 ——
   *   线上实测：`_hasBookableTarget()=true` 但 `buildTargets()=0 个候选`，
   *   结果是闸门被一个不存在的候选顶开、真正能订的时段一个都没试。
   *
   * 判据（按优先级）：
   *   ① `_targetGrid` 的日期就是目标日期 → 用它（fetchGrid 只给目标日期盖这个章）；
   *   ② 否则 `this.grid` 的日期对得上目标日期 → 用它；
   *   ③ 都不对（只有探窗口用的日期）→ 宁可用 `_targetGrid`，最后才回落到 `this.grid`。
   */
  _gridForTarget() {
    const d = this.targetDate ? String(this.targetDate) : null;
    const tg = this._targetGrid;
    const tgDate = (tg && tg.dateFields && tg.dateFields.date) || null;
    if (tg && d && tgDate && String(tgDate) === d) return tg;
    const g = this.grid;
    const gDate = (g && g.dateFields && g.dateFields.date) || null;
    if (g && d && gDate && String(gDate) === d) return g;
    if (tg && Array.isArray(tg.courts) && tg.courts.length) return tg;
    return g || tg || null;
  }

  _hasBookableTarget() {
    const g = this._gridForTarget();
    if (!g) return false;
    try {
      return this.buildTargets().length > 0;
    } catch (e) {
      return false;
    }
  }

  /**
   * 放场时刻推导。
   *
   * 实测（2026-10-10）：releaseMode=ROLLING、targetMode=ROLLING、nextReleaseAt=null。
   * 这种「滚动放场」模式下服务端不给绝对时刻，但规则等价于：
   *   每天 bookingStartTime（08:00）把 bookingEndDate 往后推一天。
   * 于是对「窗口最后一天」这个目标而言，它的放场时刻就是**目标日期当天往前推 3 天的那个 08:00**，
   * 也就是「今天(或最近一个) 08:00」——但必须落在窗口外，否则今天就已经放过了。
   *
   * 简化实现：目标日期的放场时刻 = 目标日期 - spanDays 天的 bookingStartTime，
   * 其中 spanDays = bookingEndDate - bookingStartDate（实测 = 2）。
   *
   * ★ 2026-10-11 修掉的坑：原来算出来的时刻**已过**时会「往后滚」到「今天/明天 08:00」，
   *   于是 `--rel 2` 在窗口已经滚过一天之后会得到一个**凭空捏造的过去时刻**，
   *   `_gateOpen()` 直接放行 ⇒ 又回到「开闸前把熔断预算烧光」的老路。
   *   现在不再滚：算出过去时刻 = 「这个日期的放场早就发生了」，放行与否交给 `_gateOpen()`
   *   用「今天到底在不在窗口里」再判一次（见那边的说明）。
   */
  _resolveReleaseAt(f, serverToday) {
    const next = parseServerTs(f.nextReleaseAt);
    if (next) return next;

    const startHHMM = f.bookingStartTime || this.cfg.schedule.releaseTime || '08:00';

    // 目标日期是「窗口最后一天」时：放场时刻 = 目标日期的 bookingStartTime 减「窗口跨度」天
    let spanDays = 0;
    if (f.bookingStartDate && f.bookingEndDate) {
      const a = parseServerTs(`${f.bookingStartDate} 00:00`);
      const b = parseServerTs(`${f.bookingEndDate} 00:00`);
      if (a && b) spanDays = Math.max(0, Math.round((b - a) / 86400000));
    }
    const targetStart = serverDateTime(this.targetDate, startHHMM);
    return targetStart == null ? null : targetStart - spanDays * 86400000;
  }

  _logGrid() {
    const g = this.grid;
    if (!g) return;
    this.log.info(`\n场地 ${g.courts.length} 片：${g.courts.map((c) => c.name).join('、')}`);
    const now = this.clock.now();
    const rows = g.slots.map((s) => {
      const label = s.bookableCount > 0 ? `✅ ${s.bookableCount}片` : '⛔ 满';
      const why = s.reasons.length
        ? '  ' + s.reasons.map((r) => `${r.reason}×${r.courts}`).join(' ')
        : '';
      return `  ${s.time}  ${label}${why}`;
    });
    for (const r of rows) this.log.info(r);
    const open = g.slots.filter((s) => s.bookableCount > 0);
    this.log.info(
      `当前共有 ${open.length} 个时段还有空场地（服务端时间 ${fmtServer(now)}）`
    );
  }

  // ── 目标清单 ──

  /**
   * ★ 课表：算出目标日期那天，哪些时间**不能**打球（有课）。
   *
   * 为什么要有它：用户 2026-10-11 明确要求「最好不要和我课表的时间冲突，除了星期三
   * 的晚课（我基本不去）」。课表是**按星期几**固定的，而 targetDate 是每天滚动的
   * （T+2），所以这里按 targetDate 的星期几现算，不写死日期。
   *
   * 处理顺序（后写的规则可以覆盖前面的）：
   *   ① 先按 config 的 target.schedule.classes[星期几] 取当天课程区间；
   *   ② 再用 target.schedule.free[星期几] 把某些课「标成没课」——
   *      注意这里必须能在已有区间上**挖洞**（例如周三 18:30-21:05 整段标空），
   *      所以是「整段置空」而不是「取并集」。
   *
   * 返回 { blocks, free, dayIndex, source }：
   *   blocks   当天「有课」的合并区间（分钟，可含 24:00 = 1440）
   *   free     把 blocks 从可订时段里挖掉后剩下的空档
   *   source   'config' = 来自 config.yaml（权威）；'default' = 内置课表（待用户核对）
   */
  _dayBlocks(f) {
    const sch = (this.cfg.target && this.cfg.target.schedule) || {};
    const dayIndex = weekdayOfDateStr(this.targetDate);
    const enabled = scheduleEnabled(this.cfg);
    const rawClasses = enabled ? (sch.classes || {}) : {};
    const rawFree = enabled ? (sch.free || {}) : {};
    const hasCfg =
      Object.keys(rawClasses).length > 0 || Object.keys(rawFree).length > 0;
    const src = hasCfg ? rawClasses : DEFAULT_SCHEDULE;
    const override = hasCfg ? rawFree : DEFAULT_FREE_OVERRIDE;

    const toRanges = (list) => {
      const out = [];
      for (const it of list || []) {
        if (!Array.isArray(it) || it.length < 2) continue;
        const a = safeToMin(it[0]);
        let b = safeToMin(it[1]);
        if (a == null || b == null) continue;
        // 允许写成 ["18:30","25:00"] 表示跨零点；同时把 24:00 当成合法右端点
        if (b <= a && b < 24 * 60) continue;
        out.push({ from: a, to: Math.min(b, 24 * 60) });
      }
      return out;
    };

    let blocks = [];
    if (dayIndex != null) {
      for (const [key, list] of Object.entries(src)) {
        if (normWeekKey(key) !== dayIndex) continue;
        blocks = blocks.concat(toRanges(list));
      }
    }

    // 二次覆盖：把「实际上不上」的课挖掉（在已有区间上打洞，而不是取并集）
    if (dayIndex != null) {
      for (const [key, list] of Object.entries(override)) {
        if (normWeekKey(key) !== dayIndex) continue;
        for (const r of toRanges(list)) {
          const next = [];
          for (const b of blocks) next.push(...subtractIntervals(b.from, b.to, [r]));
          blocks = mergeIntervals(next);
        }
      }
    }

    const fromMin = safeToMin((f && f.bookingStartTime) || '') ?? 8 * 60;
    let toMin = safeToMin((f && f.bookingEndTime) || '') ?? 24 * 60;
    if (toMin % 60 !== 0) toMin = Math.ceil(toMin / 60) * 60;
    toMin = Math.min(toMin, 24 * 60);

    const blocksADay = mergeIntervals(blocks);
    const free = subtractIntervals(fromMin, toMin, blocksADay);
    return { blocks: blocksADay, free, dayIndex, source: hasCfg ? 'config' : 'default', fromMin, toMin };
  }

  buildTargets() {
    // ★ 用 _gridForTarget()：与 _hasBookableTarget() 读**同一张网格**。
    const g = this._gridForTarget();
    if (!g) return [];
    const sameCourt = this.cfg.target.sameCourt !== false;
    // ★ 每个候选最多几个时段。**配置显式写的值优先**，服务端 maxSelect 只在配置留空时用。
    //   为什么必须配置优先：服务端 maxSelect 实测 = "2"，若让它优先，
    //   `maxSlots: 1`（＝「两片场地各 1 小时」，每个候选只含 1 个时段）就永远不生效 ——
    //   脚本会回到「一片场地打满 2 小时」，而不是下两张单。
    //   注意服务端的 maxSelect/maxbooktime 仍然是**上限护栏**：配置写得比它大也没用，
    //   超出的时段在服务端会被拒。
    const configuredMax = Number(this.cfg.target.maxSlots);
    const maxSlots = Number.isFinite(configuredMax) && configuredMax > 0
      ? configuredMax
      : Number(g.dateFields.maxSelect || 2);
    // ★ 课表：先算出当天「有课」的区间，再据此筛掉冲突的候选窗口
    const day = this._dayBlocks(g.dateFields);
    this._lastDayBlocks = day;
    // ★ 兜底区间 = 整个放场时段（服务端 bookingStartTime ~ bookingEndTime）挖掉上课时间。
    //   没有它的话，hourPriority 就成了一道硬墙：2026-10-11 那天 18:00 起被教学
    //   占满，而配置里最晚的候选只到 20:00，于是 20:00-22:00 这个唯一还有连续空场
    //   的位置在第一步就被过滤掉了 —— 日志表现为「8 个时段有空场地，匹配出 0 个候选方案」。
    //
    // ★★ 但命令行/菜单**明确指定了时间段**（--window）时必须关掉它：
    //   用户说了「只要 18:00-20:00」，脚本就不该在它满场时偷偷去抢早上 08:00 ——
    //   那正是他要这个功能想避免的事。严格模式下宁可如实报「没抢到」。
    const strictWindow = !!(this.opts && this.opts.windows && this.opts.windows.length);
    const fallbackRange = strictWindow ? null : this._fallbackRange(g.dateFields, day);
    // ★ 最少段数：配置显式写的值优先，服务端 minSelect 只在配置留空时用，最后兜底 2。
    //   ★ 2026-10-11 起配置写的是 1（用户改成「两片场地各 1 小时」= 每条候选 1 个时段）。
    //   留空时的兜底 2 是保守默认：宁可跑空也不下 1 小时残单（服务端 minSelect 实测 "1"）。
    const configuredMin = Number(this.cfg.target.minSlots);
    const serverMin = Number(g.dateFields.minSelect);
    const minSlots = Number.isFinite(configuredMin) && configuredMin > 0
      ? configuredMin
      : (Number.isFinite(serverMin) && serverMin > 0 ? serverMin : 2);

    // ★ 兜底优先级：把「没课的空档」逐段追加到偏好列表末尾。
    //   例如周二只有 10:10-11:50 一门课，空档是 08:00-10:10 与 11:50-24:00；
    //   偏好时段（17-19/16-18/18-20）都撞到周二晚课 18:30 时，就会降级到这些空档。
    //
    //   ★★ 顺序必须是「越晚的空档越优先」（倒序追加）：
    //     这里每一段都是**独立优先级**，靠前的优先级分数高一整档（1e6），
    //     所以「按时间从早到晚追加」会让 08:00-10:10 压过 11:50-24:00 ——
    //     于是周二的兜底会跑去抢早上 08:00-10:00，正好是用户明确否掉的
    //     「宁可跑空也不要上午/中午」。倒序后，最晚的空档（含傍晚）先试。
    let hourPriority = this.cfg.target.hourPriority;
    if (fallbackRange && fallbackRange.to > fallbackRange.from) {
      const cur = Array.isArray(hourPriority) ? hourPriority.slice() : [];
      const has = (a, b) => cur.some((x) => x && x.from === a && x.to === b);
      const gaps = ((fallbackRange.gaps && fallbackRange.gaps.length)
        ? fallbackRange.gaps.slice()
        : [{ from: fallbackRange.from, to: fallbackRange.to }]
      ).filter((gp) => gp && gp.to > gp.from).sort((a, b) => b.from - a.from);
      for (const gp of gaps) {
        if (has(gp.from, gp.to)) continue;
        cur.push({ from: gp.from, to: gp.to, raw: `空档 ${fmtHM(gp.from)}-${fmtHM(gp.to)}（避课）` });
      }
      hourPriority = cur;
    }

    const targets = buildTargetsFromGrid({
      courts: g.courts,
      grid: g.grid,
      hourPriority,
      courtPriority: this.cfg.target.courtPriority || [],
      // ★ --court：用户在菜单里点了「就要这片场地」时，候选只保留这一片。
      //   不加这个过滤的话 courtPriority 只是**排序**（其它场地仍会被尝试），
      //   等于「帮你买了另一片你没点的场地」。
      onlyCourt: (this.opts && this.opts.court) || null,
      maxSlots: Number.isFinite(maxSlots) && maxSlots > 0 ? maxSlots : 2,
      minSlots,
      sameCourt,
      date: this.targetDate,
      fallbackRange,
      blocked: day.blocks,
      conflictGraceMin: this.cfg.target.conflictGraceMin,
    });
    this._lastMinSlots = minSlots;
    return targets;
  }

  /**
   * 兜底区间：整个可订时段（含 bookingStartTime ~ bookingEndTime）。
   *
   * 取值的可靠性：这两个字段是服务端下发的放场规则（实测 "08:00" ~ "23:59"），
   * 解析不出就返回 null —— 宁可不兜底，也不去订一个自己都算不准的时间段。
   */
  _fallbackRange(f, day) {
    const raw = `${(f && f.bookingStartTime) || ''}-${(f && f.bookingEndTime) || ''}`;
    const parts = String(raw).split('-');
    if (parts.length !== 2) return null;
    const toMin = (s) => {
      const m = /^(\d{1,2}):(\d{2})$/.exec(String(s).trim());
      if (!m) return null;
      return Number(m[1]) * 60 + Number(m[2]);
    };
    let from = toMin(parts[0]);
    let to = toMin(parts[1]);
    if (from == null || to == null) return null;
    // 服务端给的是 "23:59"，而最后一个整点时段是 23:00-23:59/或到 22:00-23:00，
    // 这里统一向上取整到整点，避免把最后一小时切掉。
    if (to % 60 !== 0) to = Math.ceil(to / 60) * 60;
    if (to <= from) return null;
    const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

    // ★ 课表约束：把「有课」的时间段从可下单区间里挖掉（用户 m02402 的要求）。
    //   注意这里是**交集**而不是覆盖：既不能早于放场时段，也不能撞课。
    //
    //   ★ 没有课的那天 gaps 也要给（＝整段可订区间）：返回对象的形状不能随
    //     「当天有没有课」变来变去 —— 调用方一个 `if (gaps)` 判错就会把整段区间
    //     当成一个空档、甚至整个兜底都丢掉（线上排查时就被这形状坑过一次）。
    const blocks = (day && day.blocks) || [];
    const free = blocks.length ? subtractIntervals(from, to, blocks) : [{ from, to }];
    // ★ 只用「整体区间」当傍晚偏好信号（候选方案按开始晚优先排序），
    //   而空缺出来的每一段空档由 buildTargets 单独追加成兜底优先级 —— 两者分工不同，
    //   不能把多个空档粗暴压成一个 [max(from), min(to)] 区间（那样可能变成空集）。
    return {
      from, to,
      gaps: free,
      blocked: blocks.map((b) => `${hhmm(b.from)}-${hhmm(b.to)}`),
      raw: blocks.length
        ? `兜底 ${hhmm(from)}-${hhmm(to)}（已避开上课时间）`
        : `兜底 ${hhmm(from)}-${hhmm(to)}`,
    };
  }

  // ── 下单：取价 → 提交 ──

  async tryOne(t, round) {
    // ★ 一个候选可能对应**多张单**（两片场地各 1 小时 = 两张单）。
    //   这里一次性把它们排好并逐张提交 —— 关键是「一次尝试里把两张单都下掉」，
    //   不能只下第一张就回去重排候选（那样第二张会被排到别的小时上，
    //   实测会出现「两张单都是 17:00-18:00」这种同一个小时买两遍的荒唐结果）。
    const plan = this._planOrders(t);
    const parts = (plan.orders || []).slice(0, Math.max(0, this._orderBudget() - this.result.orders.length));
    if (!parts.length) {
      this.result.attempts.push({
        label: `${(t.slots || []).join('+')} @ ${t.courtName || t.court || '(无场地)'}`,
        court: t.court || null, courtName: t.courtName || null, slots: t.slots || [],
        price: null, ok: false, message: '没有可下单体（时段与场地凑不出一张合法订单）', at: null, round,
      });
      return false;
    }
    if (plan.reason) this.log.info(`  下单计划：${plan.reason}`);
    let anyOk = false;
    for (const part of parts) {
      // ★ 不 break：用户要的是**连着两小时**，抢到 17:00-18:00 之后还得接着抢 18:00-19:00。
      //   旧代码在下单循环里是「一单成功就 return true」，那样永远只有 1 小时。
      const ok = await this._submitOne(part, round);
      if (ok) anyOk = true;
      // 预算用完了就别再提交（一张单也是一次真金白银的预约）
      if (this.result.orders.length >= this._orderBudget()) break;
    }
    return anyOk;
  }

  /** 提交一张单：取价 → 组装 → POST。part = { court, courtName, slots } */
  async _submitOne(part, round) {
    const court = part.court;
    const courtName = part.courtName || court;
    const slots = Array.isArray(part.slots) ? part.slots.slice() : [];
    const appointInfo = slots.map((time) => ({ nodeid: court, time }));
    const appointDetail = [{
      nodeid: court,
      appointDetail: slots.map((timeInfo) => ({ appointDate: this.targetDate, timeInfo })),
    }];
    const label = `${slots.join('+')} @ ${courtName}`;
    const rec = { label, court, courtName, slots, price: null, ok: false, message: '', at: null, round };

    // ① 取价
    let price = null;
    try {
      const params = {
        reserveDate: this.targetDate,
        priceType: '3',
        nodeid: this.cfg.venue.nodeid,
        appointmentType: '2',
        reservationPerson: this.cfg.auth.usercode,
        appointInfo,
      };
      const pr = await this.api.getPayPrice(params);
      price = pr == null ? null : Number(pr);
      if (Number.isNaN(price)) price = null;
    } catch (e) {
      if (e instanceof ApiError && e.kind === 'auth') throw this._fatal(e, '取价时鉴权失败');
      rec.message = `取价失败：${e.message}`;
      this.result.attempts.push(rec);
      return false;
    }
    rec.price = price;
    if (price == null || price <= 0) {
      rec.message = `取价异常：${JSON.stringify(price)}（疑似不可订或规则未发布）`;
      this.result.attempts.push(rec);
      this.log.warn(`  ${label} → ${rec.message}`);
      return false;
    }

    const amount = price.toFixed(2);

    // ② 组装下单体（逐字复刻前端 gotoPay）
    const reserveTime = (this.grid.slots || []).map((s) => s.time);
    const priceParams = {
      nodeid: this.cfg.venue.nodeid,
      reserveDate: this.targetDate,
      reserveTime,
      accompanyPerson: [],
      reservationPerson: this.cfg.auth.usercode,
      appointmentType: '2',
      appointInfo,
      groupAppoint: false,
      payprice: amount,
      followPerson: [],
      followPersonNum: 0,
      appointDetail,
      txamt: amount,
      booktype: '2',
    };
    const payload = {
      parentNodeId: this.cfg.venue.nodeid,
      nodeid: this.cfg.venue.nodeid,
      followPerson: [],
      followPersonNum: 0,
      reservationPerson: this.cfg.auth.usercode,
      appointDetail,
      appointInfo,
      payprice: amount,
      txamt: amount,
      booktype: '2',
      appointDate: this.targetDate,
      reserveDate: this.targetDate,
      reserveTime,
      appointmentType: '2',
      appointType: '2',
      groupAppoint: false,
      priceParams,
    };

    if (this.cfg.safety.dryRun || this.opts.dryRun) {
      this.log.info(`  [DRY-RUN] 将提交下单：${label}  金额=${amount}`);
      this.log.debug(`  payload=${JSON.stringify(payload)}`);
      rec.ok = true;
      rec.message = 'dry-run 未真实提交';
      this.result.attempts.push(rec);
      this._lockOrder({
        dryRun: true,
        date: this.targetDate,
        court,
        courtName,
        slots,
        price: amount,
        payload,
      });
      return true;
    }

    // ③ 提交
    const t0 = Date.now();
    // ★ 提交失败（含 HTTP 5xx）不能往外抛：抛出去会绕开 rec 的记录，
    //   结果是「熔断额度被消耗、但结果清单里看不到这次尝试」——
    //   2026-10-11 那次 HTTP 500（/phone/reservation）就是这样凭空吃掉一次额度的。
    let res = null;
    try {
      res = await this.api.reservation(payload);
    } catch (e) {
      if (e instanceof ApiError && e.kind === 'auth') throw this._fatal(e, '下单时鉴权失败');
      rec.at = Date.now() - t0;
      rec.message = `提交异常：${e.message}`;
      this.result.attempts.push(rec);
      this.log.warn(`  ${label} → ${rec.message}`);
      // ★ 熔断上限是不可恢复状态：client.reservationPosts 到顶之后**每一次**提交都会
      //   立刻抛同一句，重试一万次也不会变好。所以这里必须让上层知道，否则 burst()
      //   会继续把剩下的几百轮跑完 —— 2026-10-13 实测：一个进程在 12:40:55 撞到上限后，
      //   一直空转到 12:48 还在每 500ms 打一次「已达下单请求熔断上限」，
      //   期间正好碰上放场就会把最后一次机会也浪费在注定失败的提交上。
      if (/熔断上限/.test(String(e.message || ''))) this._breakerTripped = true;
      return false;
    }
    rec.at = Date.now() - t0;
    rec.raw = res;
    // ★ 永久性拒绝：服务端明确说「这件事今天不可能成」（配额用完、不在窗口、已失效…），
    //   这类失败换候选、换轮次都不会变好。记下来让 burst() 本轮立刻收手 ——
    //   HTTP 500 / 超时那种瞬时故障**不算**（下一轮可能就好了）。
    //   2026-10-13 12:36 实测：5 次「每人每天最多可预定1次，已超出」被当成普通失败，
    //   burst 空转了 12 分钟。只给一个明确字符串，日志里能直接看出下次收手的原因。
    if (res && !res.success) {
      const rej = String(res.message || '');
      if (/每天|已超出|上限|不在预约|未开放|不可预约|已失效|已过期/.test(rej)) {
        this._permanentReject = rej;
      }
    }
    const orderNo = this._orderNo(res);
    if (res && res.success) {
      rec.ok = true;
      rec.message = res.message || '预约成功';
      this.result.attempts.push(rec);
      this._lockOrder({
        date: this.targetDate,
        court,
        courtName,
        slots,
        price: amount,
        orderNo,
        payway: (payload && payload.payway) || '',
        payload,
      });
      this.log.info(`  ★ 锁场成功：${label}  金额=${amount}  订单号=${orderNo || '（响应未给，稍后从订单接口取）'}`);
      return true;
    }

    rec.message = (res && res.message) || '下单失败';
    this.result.attempts.push(rec);
    this.log.warn(`  ${label} → 下单失败：${rec.message}`);
    return false;
  }

  _orderNo(res) {
    const d = (res && res.resultData) || {};
    if (typeof d === 'string' || typeof d === 'number') return String(d);
    return d.orderno || d.orderNo || d.orderid || d.orderId || d.id || d.no || '';
  }

  /**
   * 锁下一张单：统一写进 result.orders，并让 result.locked 永远 = orders[0]。
   *
   * 为什么要有这个方法：一次冲刺可能产生**不止一张单**（「两片场地各 1 小时」＝两张单
   * 各 1 小时，凑成连续的 2 小时）。老代码到处直接写 `this.result.locked = {...}`，
   * 那样第二张单会覆盖第一张 —— 第一张单就此丢失、也不会被支付，等于白锁一个场
   * 还留下违约风险。所以所有下单成功路径都必须走这里。
   *
   * ★ 2026-10-12 事故：这里原先只写 `orderNo`（驼峰），而支付侧 `src/pay.js` 的
   *   `settle()` 读的是 `locked.orderno`（全小写，与接口字段 `resultData.orderno` 一致）。
   *   结果**每一次抢到场地都会走到「下单响应里没有 orderno，无法继续支付流程」**，
   *   场地锁住了、钱一分没付，等支付窗口过去就被系统释放（10-14 那张单 129801 实测
   *   08:05:21 到期失效，status=9「已失效」）—— 表现就是「抢到了却什么都没有」。
   *   所以这里两个名字都写。
   */
  _lockOrder(order) {
    if (order && order.orderNo != null && order.orderno == null) order.orderno = order.orderNo;
    if (order && order.orderno != null && order.orderNo == null) order.orderNo = order.orderno;
    this.result.orders.push(order);
    this.result.locked = this.result.orders[0];
    return order;
  }

  /**
   * 把一个候选方案拆成「一张或多张下单体」。
   *
   * 背景（2026-10-11 之后用户明确要的打法）：
   *   学校一次最多让选 maxSelect 个时段（实测 2）；用户要的是**两片场地各 1 小时**、
   *   而且**两段要连着**（例：A 场 17:00-18:00 + B 场 18:00-19:00）。
   *   服务端下单体里每个 time 只挂**一个** nodeid，所以「两片场地」必须拆成两张单。
   *
   * ★ 关键：配对好的两段必须**在同一次 tryOne 里一起下**。
   *   如果只下第一张就回去重排候选，第二张会按分数取到「另一个场地上的同一个小时」——
   *   实测就是这个结果：`[["17:00-18:00"],["17:00-18:00"]]`，同一个小时买两遍、
   *   钱花了两份、时间还是只有 1 小时。所以这里直接给出「要下的整组单」。
   *
   * 返回：`{ orders: [{ court, courtName, slots }], reason }`；拆不出单体时 orders 为空。
   */
  _planOrders(t) {
    const all = this._gridCourts();
    const byId = new Map(all.map((c) => [String(c.id), c]));
    const name = (id) => ((byId.get(String(id)) || {}).name) || id;

    // 情形①：候选本身就带场地（buildTargetsFromGrid 的产物 —— 生产路径走这里）。
    if (t.court) {
      const slots = Array.isArray(t.slots) ? t.slots.slice() : [];
      if (!slots.length) return { orders: [], reason: '' };
      const orders = [{ court: t.court, courtName: t.courtName || name(t.court), slots }];

      // ★ 配对：候选带着「下一段」时（src/target.js 标好的 `pair`），把下一段
      //   一起排进来，两张单一次下掉 —— 这才是用户要的「连着两小时」。
      //   场地用一个能订的就行（用同一片场地也没问题：不同小时是两张独立单）。
      const partner = t.pair;
      if (partner && Array.isArray(partner.slots) && partner.slots.length) {
        const cur = slots[0];
        const next = partner.slots[0];
        const court = this._canBook(partner.court, next)
          ? partner.court
          : (this._canBook(t.court, next) ? t.court : null);
        if (court) {
          orders.push({ court, courtName: name(court), slots: [next] });
          return {
            orders,
            reason: `${cur} @ ${name(t.court)} + ${next} @ ${name(court)}（配对：连着两小时，两张单）`,
          };
        }
        // 下一段一片场地都订不上 → 退化成只下这一小时（仍然合规，只是不连续）
        this.log.warn(
          `  配对失败：${next} 没有任何可订场地（先把 ${cur} 这一小时占住，下一轮再补）`
        );
      }
      return { orders, reason: '' };
    }

    // 情形②：候选只给了「可用的场地池」（buildPlans 的产物），逐时段挑场地。
    const slots = Array.isArray(t.slots) ? t.slots.slice() : [];
    const pool = Array.isArray(t.courts) ? t.courts : [];
    if (!slots.length || !pool.length) return { orders: [], reason: '' };
    const pick = (slot) => pool.find((id) => this._canBook(id, slot));
    const assigned = new Map(); // courtId -> slots[]
    for (const slot of slots) {
      const id = pick(slot);
      if (!id) continue; // 这个时段在池子里没有任何一片场地能订 → 丢弃
      const key = String(id);
      if (!assigned.has(key)) assigned.set(key, { court: id, courtName: name(id), slots: [] });
      assigned.get(key).slots.push(slot);
    }
    // 保持原时段顺序（拼单体的 appointInfo 顺序变了不影响服务端，但日志好读）
    const out = [];
    for (const slot of slots) {
      for (const o of assigned.values()) {
        if (o.slots.includes(slot) && !out.includes(o)) out.push(o);
      }
    }
    // 同一场地的时段合并回一张单（默认 maxSelect=2，超过就要拆）
    const cap = Math.max(1, Number((this.grid && this.grid.dateFields && this.grid.dateFields.maxSelect) || 2));
    const merged = [];
    for (const o of out) {
      for (let i = 0; i < o.slots.length; i += cap) {
        merged.push({ court: o.court, courtName: o.courtName, slots: o.slots.slice(i, i + cap) });
      }
    }
    return { orders: merged, reason: '' };
  }

  /** 目标场地列表（网格里的全部场地） */
  _gridCourts() {
    const cs = this.grid && Array.isArray(this.grid.courts) ? this.grid.courts : [];
    return cs.filter((c) => c && c.id);
  }

  /** 某片场地在某个时段是否可订（网格里 disabled !== true） */
  _canBook(courtId, slotValue) {
    const row = (this.grid && this.grid.grid && this.grid.grid[courtId]) || {};
    const item = row[slotValue];
    return !!item && item.disabled !== true;
  }

  /** 该方案要下几张单：maxOrdersPerDay 是硬上限，剩下的直接丢掉 */
  _orderBudget() {
    const cap = Number(this.cfg.safety && this.cfg.safety.maxOrdersPerDay);
    return Number.isFinite(cap) && cap > 0 ? cap : 1;
  }

  // ── 冲刺 ──

  /**
   * 放场前「慢速候场」：每 idlePollMs 拉一次网格。
   * 只要目标日期一旦出现在窗口里（放出来了），立刻返回，转入冲刺；
   * 同时把网格刷新回服务端最新状态（顺便校准时钟）。
   * 返回最后取到的网格。
   */
  /**
   * 候场复查间隔：离放场时刻越近，复查越密。
   * ★ 2026-10-25 实测：候场固定 15 秒一次 → 08:00:00 开闸，程序直到 08:00:17.7
   *   才第一次看到「窗口已开」，白白晚 17 秒才冲刺。冲刺再快也补不回这 17 秒，
   *   所以收尾窗口（默认最后 60 秒）内改成每 500ms 复查一次。
   * baseMs：常态间隔；已过放场时刻但窗口还没滚（服务端放场延迟）时保持同一快节奏。
   */
  _idleSleepMs(baseMs) {
    const sched = this.cfg.schedule || {};
    const winMs = Math.max(Number(sched.finalPollWindowMs || 60000), 5000);
    const finMs = Math.max(Number(sched.finalPollMs || 500), 100);
    if (!this.releaseAt) return baseMs;
    const left = this.releaseAt - this.clock.now();
    // 只在「放场前一刻 ~ 放场后宽限期」这段用快节奏：
    //   - left 在收尾窗口内（含刚过点，服务端放场可能晚十几秒）；
    //   - 过了宽限期还开着闸却没放出来，说明不是「正在放场」，退回常态节奏，
    //     免得一份过期的 releaseAt 让程序以 500ms 一轮空打服务器。
    const graceMs = Math.max(Number(sched.guardGraceMs || 180000), 30000);
    if (left <= winMs && left > -graceMs) return Math.min(baseMs, finMs);
    return baseMs;
  }

  /**
   * 是否处在「放场瞬间快通道」：离 releaseAt 不到 ±releaseRaceMs。
   * 这段里候场不再按 idlePollMs/finalPollMs 睡，而是连着一轮一轮快查 ——
   * 服务端什么时候把窗口滚开，我们下一轮就看得到，不必再等满一个复查周期。
   */
  _releaseRace() {
    const sched = this.cfg.schedule || {};
    const raceMs = Math.max(Number(sched.releaseRaceMs || 0) || 0, 0);
    if (!raceMs || !this.releaseAt) return false;
    const left = this.releaseAt - this.clock.now();
    return left <= raceMs && left > -raceMs;
  }

  async _idleWaitForRelease() {
    const sched = this.cfg.schedule || {};
    const idleMs = Math.max(Number(sched.idlePollMs || 15000), 5000);
    const startHHMM = ((this._targetGrid || this.grid || {}).dateFields || {}).bookingStartTime
      || sched.releaseTime || '08:00';
    // 兜底期限：等到「下一次放场时刻 + 宽限期」还没有目标日期就放弃，
    // 免得无限期挂着空转（目标日期不在窗口里时 releaseAt 可能是 null）
    // ⚠ 宽限期要给足：服务端放场可能比 08:00 晚十几秒到几分钟，太紧会白等一场。
    const graceMs = Math.max(Number(sched.guardGraceMs || 180000), 30000);
    if (!this._guardDeadline) {
      // ★ 兜底期限要按「真正的下一次放场」算，不能直接 releaseAt + grace：
      //   releaseAt 可能是**上一轮**放场留下的过去时刻（窗口还没滚），
      //   照它加宽限期会得到一个已经过去的期限 ⇒ 循环第一圈就「候场超时」退出。
      const now = this.clock.now();
      const today0 = serverDateTime(fmtServerDate(now), startHHMM);
      // 候选①：今天/明天的 bookingStartTime（还没到就是今天，到了就是明天）
      const nextDaily = today0 == null ? null : (today0 > now ? today0 : today0 + 86400000);
      // 候选②：releaseAt —— 取两者中较早的那个。宽限期一到就放手，
      //        免得服务端那天压根没放出来时白等一整天。
      let base = nextDaily;
      if (this.releaseAt && this.releaseAt > now && (base == null || this.releaseAt < base)) {
        base = this.releaseAt;
      }
      this._guardDeadline = (base == null ? now + 6 * 3600000 : base) + graceMs;
      this.log.info(`  兜底期限：${fmtServer(this._guardDeadline)}（到点仍未等到目标日期就放弃，绝不抢错日期）`);
    }
    const winSec = Math.round(Math.max(Number(sched.finalPollWindowMs || 60000), 5000) / 1000);
    const finLogMs = Math.max(Number(sched.finalPollMs || 500), 100);
    this.log.info(
      `  目标日期尚未放场 → 放场前每 ${(idleMs / 1000).toFixed(0)} 秒复查一次` +
      `（最后 ${winSec} 秒收紧到每 ${finLogMs}ms 一次；平时不打扰服务器）`
    );
    let last = this._targetGrid || this.grid;
    let loggedClosed = false;
    for (;;) {
      // ★ 每一轮都以闸门的实时判断为准，别再拿 releaseAt 单独比时间：
      //   「已经过了 releaseAt」不等于「现在可以下单」——窗口还没滚的时候，
      //   releaseAt 是上一轮放场留下的过去时刻，此时下单只会吃业务失败并烧掉熔断预算。
      if (!this._gateOpen()) {
        if (!loggedClosed) {
          loggedClosed = true;
          this.log.info(
            `  尚未开闸（${this._gateReason()}）→ 只轮询网格、不下单` +
            (this._hasBookableTarget() ? '（网格已提前显示候选场地，但那不是可下单状态）' : '')
          );
        }
        // 闸门关着时窗口大概还没滚，网格几乎每刻都在变 —— 用快节奏复查，
        // 否则「真正开闸」那一刻可能正好落在 15 秒的盲区里。
        const fresh = await this._recheckTargetGrid(last);
        // ★ 2026-10-28 实测：这里原来把复查结果丢掉、继续睡 500ms 再拉一次，
        //   于是「服务端 08:00:01.1 滚开窗口」到「08:00:02.0 转入冲刺」白等一个周期。
        //   现在只要拿到滚开后的网格、且闸门确实已开，就当场冲刺，不再多睡一拍。
        if (fresh) {
          last = fresh;
          if (this._gateOpen()) {
            this._releaseSeenAt = this.clock.now();
            this.log.info(`  目标日期 ${this.targetDate} 已进入放场窗口 → 立即转入冲刺`);
            return last;
          }
        }
        // 放场瞬间（±releaseRaceMs）连查 250ms 一轮，其余收尾时间按 500ms 查
        await sleep(this._releaseRace() ? 250 : this._idleSleepMs(2000));
        continue;
      }

      // ★ 放场瞬间快通道：±releaseRaceMs 内不睡，直接连查（见 _releaseRace 的说明）
      if (!this._releaseRace()) await this._sleepKeepingTokenFresh(this._idleSleepMs(idleMs));
      try {
        const g = await this.fetchGridRetry(this.targetDate, 1);
        if (g.ok) {
          last = g.grid;
          this._targetGrid = g.grid;
          this.grid = g.grid;
          if (this._windowGuard(g.grid)) {
            this._releaseSeenAt = this.clock.now();
            this.log.info(`  目标日期 ${this.targetDate} 已进入放场窗口 → 立即转入冲刺`);
            return last;
          }
        }
      } catch (e) {
        await this._handleIdleFetchError(e);
      }

      // ★ 这里**不能**再写 `if (clock.now() >= this.releaseAt) return last;`。
      //   原来那句会绕过闸门：窗口还没滚时，releaseAt 是个早就过去的时刻，
      //   于是「过了 releaseAt 就转入冲刺」直接放行，在开闸前把熔断预算烧光。
      //   闸门开着时上面的 _windowGuard 已经会让它返回；闸门关着时循环开头会拦住。
      if (this._guardDeadline && this.clock.now() >= this._guardDeadline) {
        throw this._fatal(
          new ApiError(
            `等到 ${fmtServer(this._guardDeadline)} 目标日期 ${this.targetDate} 仍未放出来 —— 放弃本轮，绝不抢其它日期`,
            0, null, 'business'
          ),
          '候场超时'
        );
      }
    }
  }

  /**
   * 闸门关着时的快节奏网格复查。只在看场窗口刚滚动的那一刻有用 ——
   * 目标日期一旦进入窗口，网格里就能看到它，于是可以立刻转入冲刺。
   * 返回新网格（失败返回 null），由调用方决定要不要采纳。
   */
  async _recheckTargetGrid(last) {
    try {
      const g = await this.fetchGridRetry(this.targetDate, 1);
      if (g.ok) {
        this._targetGrid = g.grid;
        this.grid = g.grid;
        if (this._windowGuard(g.grid)) return g.grid;
      }
    } catch (e) {
      await this._handleIdleFetchError(e);
    }
    return null;
  }

  /** 候场期间抓网格失败的统一处理：鉴权失效就治，其它错误只记一笔继续等。 */
  async _handleIdleFetchError(e) {
    if (e instanceof ApiError && e.kind === 'auth') {
      if (!(await this._healAuth())) throw this._fatal(e, '候场期间鉴权失败');
    } else {
      this.log.warn(`  候场复查异常（忽略，稍后重试）：${e.message}`);
    }
  }

  /**
   * 日期护栏：确认目标日期确实落在服务端当前放场窗口内。
   * 目的：防止「只想抢 10-13」的意图在窗口未后移时被静默改成别的日期（例如抢到 10-12）。
   * 返回 true 表示可以继续；false 表示这一轮不该下单（调用方等待下一轮）。
   */
  _windowGuard(g) {
    const f = (g && g.dateFields) || {};
    const a = f.bookingStartDate;
    const b = f.bookingEndDate;
    const t = this.targetDate;
    if (!t) return true;                              // 没定目标日期，交给原逻辑
    if (!a || !b) return true;                        // 服务端没给窗口，无从判断
    if (t >= a && t <= b) return true;                // 落在窗口内 → 放行

    // 不在窗口内：说明目标日期还没放出来（例如 10-11 07:50 时的 10-13）
    const now = Date.now();
    if (!this._guardWarnAt || now - this._guardWarnAt > 5000) {
      this._guardWarnAt = now;
      this.log.warn(
        `日期护栏：目标 ${t} 不在服务端放场窗口 [${a} ~ ${b}] 内 → 本轮不下单` +
        `（等窗口后移；如需改口径请改 config.yaml 的 target.date）`
      );
    }
    return false;
  }

  async burst() {
    const sched = this.cfg.schedule || {};
    const maxRounds = Number(this.opts.maxRounds || sched.maxRounds || 600);
    const pollMs = Math.max(Number(this.opts.interval || sched.burstPollMs || 300), 250);
    this.log.info(
      `\n冲刺：轮询 getNodeAppointInfoList（间隔 ${pollMs}ms，最多 ${maxRounds} 轮，目标 ${this.targetDate}）`
    );

    let emptyStreak = 0;
    let gateWaitLogged = 0;
    for (let round = 1; round <= maxRounds; round++) {
      this.result.rounds = round;
      let g;
      try {
        g = await this.fetchGridRetry(this.targetDate);
      } catch (e) {
        if (e instanceof ApiError && e.kind === 'auth') {
          if (await this._healAuth()) { await sleep(pollMs); continue; }
          throw this._fatal(e, '冲刺轮询时鉴权失败');
        }
        const es = Date.now() - this.result.at;
        // 网络抖动不致命：记录后继续，但避免无限打
        if (round % 10 === 0) this.log.warn(`第 ${round} 轮异常：${e.message}（已跑 ${(es / 1000).toFixed(0)}s）`);
        await sleep(pollMs);
        continue;
      }

      // ★ 闸门没开（还没到放场时刻）→ 这一轮绝不提交下单。
      //   放场前每 2 秒复查一次网格即可，不必用冲刺级频率打服务器；
      //   到点立刻全力冲刺。这是 2026-10-11 事故的直接修复点。
      if (!this._gateOpen()) {
        gateWaitLogged++;
        if (gateWaitLogged === 1 || gateWaitLogged % 15 === 0) {
          this.log.info(
            `  闸门未开（${this._gateReason()}）→ ` +
            `只轮询网格、不下单，已等 ${gateWaitLogged} 轮（约 ${Math.round(gateWaitLogged * 2)}s）`
          );
          if (g.ok) this._logGrid();
        }
        await sleep(2000);
        continue;
      }
      gateWaitLogged = 0;

      if (!g.ok) {
        emptyStreak++;
        if (round === 1 || emptyStreak === 5 || emptyStreak % 20 === 0) {
          this.log.info(`第 ${round} 轮：目标日期尚未放场（${g.message}）`);
        }
        // ★ --now / --no-wait 是「立即试一次」的语义：目标日期没放出来时不该在这里空转几百轮
        if ((this.opts.now || this.opts.noWait) && !this._targetReady) {
          this.log.info('目标日期现在不能下单，本次不等（--now / --no-wait）');
          return false;
        }
        // 正常路径下 burst 只在放场时刻之后运行；给一个迟到的兜底期限，避免无限打服务器
        if (this._guardDeadline && Date.now() > this._guardDeadline) {
          throw this._fatal(
            new ApiError(`到达兜底期限（${fmtServer(this._guardDeadline)}）目标日期仍未放出来`, 0, null, 'business'),
            '冲刺等待放场超时'
          );
        }
        await sleep(pollMs);
        continue;
      }
      emptyStreak = 0;

      // ★ 日期护栏：目标日期必须落在服务端当前窗口内，否则坚决不下单
      if (!this._windowGuard(g.grid)) {
        await sleep(Math.max(pollMs, 500));
        continue;
      }

      const targets = this.buildTargets();
      if (round <= 3 || round % 20 === 0) {
        const open = (g.grid.slots || []).filter((s) => s.bookableCount > 0).length;
        this.log.info(`第 ${round} 轮：${open} 个时段有空场地，匹配出 ${targets.length} 个候选方案`);
        if (targets.length && round <= 3) {
          for (const t of targets.slice(0, 3)) this.log.info(`    · ${t.reason}`);
        }
      }
      if (!targets.length) {
        // --now 是「立刻试一次」的语义：当天没有可用组合时不该在这里空转上千轮
        if (this.opts.now) {
          this.log.info('--now：当前没有匹配到任何候选方案，本轮不等待');
          return false;
        }
        // ★ 预演模式没有「等到空位出现」的意义（它不下单、也不会因为等而多出场地），
        //   却在 2026-10-14 实测空转了 5 分钟（目标 10-15 已放场且满场，250ms × 1500 轮），
        //   而且 SSH 断开后这些空转进程还会留在路由器上。预演就当场收手。
        if (this.opts.dryRun) {
          this.log.info('预演模式：当前没有匹配到任何候选方案 → 立即收手（预演不等待空位）');
          return false;
        }
        // ★ 指定了时间段（--window）时同理：等下去也不会凭空多出「你要的那几小时」，
        //   而 250ms × 1500 轮的空转会把 SSH 断开后的进程留在机器上（踩过两次）。
        //   直接如实收手，用户换个时段再按一次扳机即可。
        if (this.opts.windows && this.opts.windows.length) {
          this.log.info(
            `指定时间段（${this.opts.windows.map((w) => w.raw || w).join(' / ')}）：` +
            '当前没有匹配到任何候选方案 → 立即收手（换个时段再试一次即可）'
          );
          return false;
        }
        // ★ 保险：网格显示还有空位、却一个方案都匹配不出来 —— 多半是放场瞬间
        //   网格/时段表还没刷齐（2026-10-25 首轮直接匹配出 25 个候选，是正常情况；
        //   但万一遇到 0 个，别拿这份不完整的网格继续 120ms 一轮地空打）。
        //   隔 100ms 重拉一次网格再匹配；只在前 3 轮做，后面就是真的没位了。
        const openSlotCnt = (g.grid.slots || []).filter((sl) => sl.bookableCount > 0).length;
        if (openSlotCnt > 0 && round <= 3 && !this.opts.now) {
          this.log.warn(
            `第 ${round} 轮：网格显示还有 ${openSlotCnt} 个时段有空场地，却没匹配出方案 → 100ms 后重拉网格`
          );
          await sleep(100);
          continue;
        }
        await sleep(pollMs);
        continue;
      }

      // 按打分顺序尝试；同一轮内最多试 maxReservationAttempts 次
      const budget = this._orderBudget();
      if (this.result.orders.length >= budget) return true;
      // ★ 2026-10-12 改口径后 `maxOrdersPerDay` = 1：平台硬规则「每人每天最多可预定1次」，
      //   所以 needOrders 正常就是 1（一张单，单里含最多 2 个时段 = 连着 2 小时）。
      //   保留 needOrders 的算法是为了容错：万一将来预算被调大，这里同样不会
      //   「一单成功就 return true」而少抢。
      const needOrders = Math.max(0, budget - this.result.orders.length);
      const maxTry = Math.max(
        needOrders,
        Math.min(targets.length, Number(this.cfg.net.maxReservationAttempts || 4))
      );
      // ★ 本轮有没有吃到「永久性拒绝」（服务端明确说这件事不可能成）。
      //   每轮开头重置：上一轮吃过拒单，不代表下一轮也不行（网格变了、别人退单了）。
      this._permanentReject = null;
      const bookedNow = () => {
        const s = new Set();
        for (const o of this.result.orders) for (const sl of (o.slots || [])) s.add(String(sl));
        return s;
      };
      // ★ 同一个时段只试一次。候选表里「同一时段 × 不同场地」是**每个场地一条**：
      //   那天只剩 13:00-14:00 可打时，候选表就是 6 条一模一样的 13:00-14:00。
      //   挨个试一遍等于为同一个时段打 6 次下单请求 —— 2026-10-13 12:36 那次
      //   实测就是这样：5 条「每人每天最多可预定1次」+1 次 500 在一轮里把熔断预算烧光。
      //   场地由服务端按可订情况分配，脚本没必要替它挑（挑也一样，第一轮网格里
      //   6 片都可订）。所以按 slots 去重，日志里第一句就说破。
      const trySig = new Set();
      for (let i = 0; i < maxTry; i++) {
        if (this.result.orders.length >= budget) return true;
        // ★ 熔断已到顶：后面每一轮都只会拿到同一句错误，继续跑纯属空转（还会把
        //   「还剩几轮」的耐心浪费在注定失败的提交上）。立刻收手，把结果如实报出去。
        if (this._breakerTripped) break;
        const t = targets[i];
        if (!t) break;
        // ★ 绝不为同一个小时买两遍：抢到「17:00-18:00」之后还要补第二个小时，
        //   但下一个候选很可能只是**同一时段在另一片场地**上的副本。照单全收的话
        //   就会花钱买两个一模一样的 17:00-18:00（实测踩过），时间还是 1 小时。
        //   配对好的「连着两小时」由 _planOrders 在一次 tryOne 里就下完，不依赖这里。
        const mine = (t.slots || []).map(String);
        if (mine.length && mine.every((s) => bookedNow().has(s))) {
          const dup = mine.join('+');
          if (!this._dupSkipLogged || this._dupSkipLogged !== dup) {
            this.log.info(`  跳过：${dup} 已经抢到了（不再为同一个小时买第二遍）`);
            this._dupSkipLogged = dup;
          }
          continue;
        }
        // 这一轮里同一个时段已经试过了（只是换了片场地）→ 不再重复提交
        const sig = mine.join('+');
        if (sig && trySig.has(sig)) {
          this.log.info(`  跳过：${sig} 这一轮已经试过了（同一时段的另一片场地不再重复提交）`);
          continue;
        }
        if (sig) trySig.add(sig);
        this.log.info(`  尝试 (${i + 1}/${maxTry})：${t.reason}`);
        let ok = false;
        try {
          ok = await this.tryOne(t, round);
        } catch (e) {
          if (e instanceof ApiError && e.kind === 'auth') throw this._fatal(e, '下单时鉴权失败');
          this.log.warn(`  尝试异常：${e.message}`);
        }
        // 闸门在尝试过程中关上（理论上不会发生，这里只做保险）
        if (!this._gateOpen()) break;
        // ★ 服务端刚刚明确说「这件事今天不可能成」（配额用完/不在窗口/已失效）：
        //   同一个候选列表里的下一条、下一条… 只会收到同一句话。2026-10-13 12:36
        //   实测就是这样把 6 次熔断预算一次烧光的（5 条「每人每天最多可预定1次」）。
        //   立刻停止本轮 —— 留一句原文在日志里，让「为什么没抢到」一眼看得懂。
        if (!ok && this._permanentReject) {
          this.log.warn(`  服务端明确拒绝（${this._permanentReject}）→ 本轮不再换候选重试`);
          break;
        }
        // 下单失败最常见的两种原因，值得立刻重读网格再判断
        if (!ok) {
          try {
            const again = await this.fetchGrid(this.targetDate);
            if (again.ok) this.grid = again.grid;
          } catch (e) { /* 忽略，下一轮会再拉 */ }
        }
        await sleep(80);
      }
      // ★ 够数就收手；只抢到一部分（例如那天只剩 1 小时可打）也是**成功**，
      //   绝不能再当失败处理：老代码 `if (ok) return true` 才会在部分成功时返回 true，
      //   改成一味追求 budget 会让「抢到 1 小时」被判成「没抢到」，
      //   08:30 的兜底脚本看到 FAILED 还会再冲一次（重复占场 + 重复扣款风险）。
      if (this.result.orders.length >= budget) return true;
      if (this.result.orders.length > 0) {
        this.log.info(
          `本轮已经抢到 ${this.result.orders.length}/${budget} 张单（不连续也不强求），收工`
        );
        return true;
      }
      // ★ 熔断到顶且一无所获：再转多少轮都是同一句错误。立刻结束冲刺，
      //   别再每 500ms 空转一遍（旧行为实测空转了 7 分钟）。
      if (this._breakerTripped) {
        this.log.warn('下单熔断额度已到顶，且本轮没有抢到任何场地 → 结束冲刺（不再空转）');
        return false;
      }
      // ★ 吃到永久性拒绝也一样：服务端说的是「这个人今天不能再订场了」，网格再怎么
      //   变这句话也不会变。2026-10-13 12:36 那次实测，第一轮就被回了 5 次
      //   「每人每天最多可预定1次，2026-10-13已超出」+1 次 HTTP 500，熔断预算当场烧光，
      //   之后每 250ms 一轮空转 12 分钟（进程最后要人工 kill）。
      if (this._permanentReject) {
        this.log.warn(
          `服务端明确拒绝（${this._permanentReject}）→ 本轮不可能再成，结束冲刺（不再空转）`
        );
        return false;
      }
      await sleep(pollMs);
    }

    this.log.warn(`冲刺结束：已达最大轮数 ${maxRounds}，仍未抢到`);
    return false;
  }

  async waitForRelease() {
    const leadMs = Number((this.cfg.schedule && this.cfg.schedule.leadMs) || 1500);
    if (this.opts.now || this.opts.poll) return;
    // ★ --no-wait（帮买）：现在不能下单就立刻失败，绝不进候场循环。
    //   候场循环是为「08:00 放场」设计的，会一直等十几个小时；而帮买是
    //   「用户看着列表点的这一下」，等下去只会让他以为程序卡死。
    if (this.opts.noWait) {
      this.log.info('帮买模式（--no-wait）：不等放场，现在就直接冲刺一次');
      return;
    }
    // ★ 预演绝不等待放场。
    //   预演的意义是「现在就能看到会抢哪一场」；目标日期还没放出来的时候
    //   （网格整片满、0 个空时段），等 12 小时也变不出场地来。
    //   2026-10-19 20:26 实测：手动预演 3 天后的日期，直接挂进「放场前每 15 秒复查」
    //   的候场循环，最多要等十几小时，用户看到的就是「预演卡住了」。
    if (this.opts.dryRun) {
      this.log.info(
        '预演模式：目标日期现在还不能下单（多半是还没到放场时刻）→ 立即收手，不等待放场'
      );
      return;
    }
    // 目标日期现在就能下单（已到放场时刻，或窗口内本来就能订的日子）
    // → 立刻冲刺，不必等下一个放场时刻
    if (this._targetReady) {
      this.log.info('目标日期已可下单，跳过等待');
      return;
    }
    // ★ 分两段等：
    //   ① 放场前「慢速候场」—— 每 idlePollMs(默认 15s) 复查一次网格，
    //      目标日期一旦进入窗口就立刻转冲刺（未必真要等到 releaseAt）；
    //   ② releaseAt 前 leadMs 处收窄到秒级，睡醒后立刻开抢。
    if (this.releaseAt) {
      const leftSec = ((this.releaseAt - this.clock.now()) / 1000).toFixed(1);
      this.log.info(`待命：距放场时刻还有 ${leftSec}s（${fmtServer(this.releaseAt - leadMs)} 开始冲刺）`);
    } else {
      this.log.info('待命：服务端未给出放场时刻（目标日期可能还没放出来）→ 按候场逻辑复查');
    }
    const seen = await this._idleWaitForRelease();
    if (this.releaseAt) {
      const rest = this.releaseAt - leadMs - this.clock.now();
      if (rest > 0) {
        this.log.info(`  收窄待命：睡眠 ${(rest / 1000).toFixed(1)}s，到 ${fmtServer(this.releaseAt - leadMs)} 开始冲刺`);
        await this._sleepKeepingTokenFresh(rest);
      }
    }
    // ★ 候场里刚拿到过网格（2 秒内）就别再拉一次：放场瞬间那一拉相当于白等半秒。
    if (seen && this._releaseSeenAt && this.clock.now() - this._releaseSeenAt <= 2000) {
      this.log.info(`放场时刻已到，网格已刷新（${((seen && seen.courts) || []).length} 片场地）`);
    } else {
      // 睡醒后立刻重拉一次（放场瞬间窗口已翻开）
      try {
        const g = await this.fetchGridRetry(this.targetDate, 1);
        if (g.ok) this.log.info(`放场时刻已到，网格已刷新（${g.grid.courts.length} 片场地）`);
        else this.log.warn(`放场时刻已到，但网格仍不可用：${g.message}（继续冲刺轮询）`);
      } catch (e) {
        this.log.warn(`放场后预拉网格失败：${e.message}（继续冲刺轮询）`);
      }
    }
  }

  /**
   * 分段睡眠，并在 token 快过期前顺手续期。
   *
   * 背景：token 寿命只有 38~80 分钟，而「早上 8:00 抢场」通常要从前一天深夜
   * 就开始待命 —— 傻睡到点必然 401。这里每段最多睡 5 分钟，每段醒来检查一次
   * token 剩余寿命，低于 renewBeforeMin 就换一个（换发只要一次请求，成本极低）。
   */
  async _sleepKeepingTokenFresh(totalMs) {
    const SEG = 5 * 60 * 1000;              // 每段最长 5 分钟
    const marginMin = Number((this.cfg.auth && this.cfg.auth.renewBeforeMin) || 10);
    const marginMs = marginMin * 60000;
    let left = totalMs;
    while (left > 0) {
      const chunk = Math.min(left, SEG);
      // 若这一觉睡完 token 就快过期了，先续期再睡，避免睡过去才发现过期
      const secsLeft = tokenSecondsLeft(this.cfg.auth.token);
      if (secsLeft != null) {
        const willBeLeft = secsLeft * 1000 - chunk;
        if (willBeLeft <= marginMs) {
          try { await this.ensureAuth(`待命期间续期（还需等 ${(left / 60000).toFixed(1)} 分钟）`); }
          catch (e) { this.log.warn(`待命期间续期失败：${e.message}（到点仍会再试一次）`); }
        }
      }
      await sleep(chunk);
      left -= chunk;
    }
  }

  // ── 鉴权 / token 续期 ──

  /**
   * 保证手上有一个「现在就能用」的 token。
   * 走 src/login.js 的 ensureToken：默认只在快过期/无效时才真的换发一次。
   * 换发成功后同时更新内存配置与 ApiClient，后面的请求立刻用新 token。
   */
  async ensureAuth(reason) {
    const r = await ensureToken(this.cfg, {
      log: (lvl, msg) => (lvl === 'warn' ? this.log.warn(msg) : this.log.info(msg)),
    });
    if (r.token) {
      this.cfg.auth.token = r.token;
      if (this._api) this._api.setToken(r.token);
    }
    const left = r.secondsLeft != null ? `${Math.floor(r.secondsLeft / 60)} 分钟` : '未知';
    this.log.info(`鉴权就绪${reason ? '（' + reason + '）' : ''}：${r.reason}，剩余寿命 ${left}`);
    this.result.auth = { renewed: r.renewed, reason: r.reason, secondsLeft: r.secondsLeft, name: r.name };
    return r;
  }

  /** 鉴权失败时的一次性自愈：换发新 token 后重试。返回是否已换新 */
  async _healAuth() {
    if (this._healedAuth) return false;
    this._healedAuth = true;
    this.log.warn('检测到鉴权失败（401/403），尝试自动换发新 token 后重试一次…');
    try {
      await this.ensureAuth('鉴权失败自愈');
      return true;
    } catch (e) {
      this.log.error(`自动换发 token 失败：${e.message}`);
      return false;
    }
  }

  // ── 支付 ──

  async settle() {
    const orders = (this.result.orders && this.result.orders.length)
      ? this.result.orders
      : (this.result.locked ? [this.result.locked] : []);
    if (!orders.length) return;
    // 演练单（dry-run）不需要支付；混着真实单时只跳过演练单
    const real = orders.filter((o) => o && !o.dryRun);
    if (!real.length) return;

    const pay = new AutoPay({
      client: this.api,
      cfg: this.cfg,
      log: this.log,
      notify: async (text) => {
        try { await notify(this.cfg.pay.notify, text, this.log); } catch (e) { /* ignore */ }
      },
    });

    // ★ 逐张支付，但**不能一张失败就退出**：两片场地各 1 小时是两张独立订单，
    //   第一张付失败不该把第二张也拖成未支付（那样两张单都会过期，白锁一场）。
    //   每张单的支付窗口只有 2 分 24 秒，所以这里不能有任何多余等待。
    const results = [];
    for (let i = 0; i < real.length; i++) {
      const locked = real[i];
      if (!AutoPay.needsPayment(locked)) {
        this.log.info(`第 ${i + 1}/${real.length} 张单无需支付（0 元或次卡通道）`);
        results.push({ paid: true, mode: 'skipped', message: '无需支付', orderNo: locked.orderNo || null });
        continue;
      }
      const ctx = {
        parentNodeId: this.cfg.venue.nodeid,
        date: this.targetDate,
        court: locked.court,
        courtName: locked.courtName,
        slots: locked.slots,
        amount: locked.price,
        orderNo: locked.orderNo,
        appointInfo: locked.slots.map((time) => ({ nodeid: locked.court, time })),
        appointDetail: [{
          nodeid: locked.court,
          appointDetail: locked.slots.map((timeInfo) => ({ appointDate: this.targetDate, timeInfo })),
        }],
      };
      this.log.info(
        `\n支付 第 ${i + 1}/${real.length} 张：模式 ${this.cfg.pay.mode}，` +
        `订单号 ${locked.orderNo || '（未知）'}，金额 ${locked.price}，` +
        `${(locked.slots || []).join('+')} @ ${locked.courtName || locked.court}`
      );
      let r = null;
      try {
        r = await pay.settle(locked, ctx);
      } catch (e) {
        r = { paid: false, mode: this.cfg.pay.mode, message: `支付异常：${e.message}` };
      }
      results.push(Object.assign({ orderNo: locked.orderNo || null }, r || {}));
      if (!r || !r.paid) {
        this.log.warn(
          `  第 ${i + 1} 张单支付未完成：${(r && r.message) || '未知原因'}` +
          `（继续处理后面的单，别让它也被拖过期）`
        );
      }
    }

    // 兼容老字段：paid = 第一张的结果；paidAll = 全部订单的结果
    this.result.paidAll = results;
    this.result.paid = results[0];
    if (real.length > 1) {
      const done = results.filter((r) => r && r.paid).length;
      this.log.info(`支付汇总：${done}/${real.length} 张已完成`);
    }
  }

  // ── 报告 ──

  report() {
    const r = this.result;
    this.log.info('\n══════════ 结果 ══════════');
    this.log.info(`目标日期：${this.targetDate}`);
    this.log.info(`下单尝试：${r.attempts.length} 次（冲刺 ${r.rounds} 轮，接口调用 ${r.http} 次）`);
    for (const a of r.attempts.slice(-8)) {
      const short = a.raw && a.raw.success ? '成功' : '失败';
      const msg = a.message && a.message.length > 90 ? a.message.slice(0, 90) + '…' : a.message;
      this.log.info(`  - ${a.label}  金额=${a.price}  ${short}  ${msg}${a.at ? `  ${a.at}ms` : ''}`);
    }
    if (r.orders && r.orders.length) {
      this.log.info(`★ 已锁定 ${r.orders.length} 张单：`);
      for (let i = 0; i < r.orders.length; i++) {
        const o = r.orders[i];
        this.log.info(
          `   ${i + 1}. ${(o.slots || []).join(' + ')} @ ${o.courtName || o.court}` +
          `  金额 ${o.price}${o.orderNo ? `  订单号 ${o.orderNo}` : ''}${o.dryRun ? '  [DRY-RUN]' : ''}`
        );
      }
    } else {
      this.log.info('未抢到');
    }
    if (r.paidAll && r.paidAll.length) {
      const done = r.paidAll.filter((x) => x && x.paid).length;
      this.log.info(`支付：${done}/${r.paidAll.length} 张已完成`);
      for (let i = 0; i < r.paidAll.length; i++) {
        const p = r.paidAll[i] || {};
        this.log.info(
          `   ${i + 1}. ${p.paid ? '已完成' : '未完成'}  模式=${p.mode}` +
          `${p.orderNo ? `  订单号 ${p.orderNo}` : ''}  ${p.message || ''}`
        );
        // ★ 未付成功时把支付诊断（含服务端原始响应体）再打一遍到报告尾部 ——
        //   这样即使只翻 `logs/run-*.log` 的最后几行也能看到服务端到底说了什么。
        if (!p.paid && p.diag) {
          this.log.info(`      支付诊断：POST ${p.diag.url || '(未知)'}  ` +
            `参数=${JSON.stringify(p.diag.payload || {})}`);
          this.log.info(`      原始响应体：${p.diag.raw || '(没抓到)'}`);
          for (const a of (p.diag.attempts || [])) {
            this.log.info(`      第 ${a.attempt} 次：${a.ms}ms  success=${a.success}  ` +
              `message=${a.message || '(空)'}`);
          }
        }
      }
    } else if (r.paid) {
      this.log.info(`支付：${r.paid.paid ? '已完成' : '未完成'}  模式=${r.paid.mode}  ${r.paid.message || ''}`);
    }
    const stats = this.api.stats;
    this.log.info(`接口统计：${JSON.stringify(stats)}，下单提交 ${this.api.reservationPosts} 次`);
    if (this.log.file) this.log.info(`日志文件：${this.log.file}`);
    return r;
  }

  _fatal(e, ctx) {
    const err = new Error(`${ctx}：${e.message}`);
    err.cause = e;
    err.fatal = true;
    this.result.error = err.message;
    return err;
  }

  // 兼容旧测试：网格模式下的「场地清单」就是 grid.courts
  async loadCourts() {
    if (this.grid) return this.grid.courts;
    const g = await this.fetchGridRetry(this.targetDate);
    if (!g.ok) return [];
    return g.grid.courts;
  }

  // ── 编排 ──

  async run() {
    await this.ensureAuth('启动');
    await this.warmup();
    this.result.targetDate = this.targetDate;
    this.result.releaseAt = this.releaseAt;

    if (this.opts.poll) {
      this.log.info('\n--poll 安全模式：仅观察，不进入冲刺');
      this.log.info(`网格日期=${this.grid.dateFields.date} 场地=${this.grid.courts.length} 片 时段=${this.grid.slots.length} 个`);
      this._logGrid();
      return this.result;
    }

    await this.waitForRelease();

    try {
      await this.burst();
      await this.settle();
    } catch (e) {
      this.result.error = this.result.error || e.message;
      this.log.error(`执行中断：${e.message}`);
    }
    return this.report();
  }
}

// ───────────────────────── 入口 ─────────────────────────

async function main() {
  const { config, file } = loadConfig(cli.opts.config);
  // ★ 时间段覆盖（--window / --slots）：必须**在**读 config 之后、构造 Grabber 之前做。
  //   解析失败要在这里就退出 —— 带着错的时间段一路跑下去，只会在几十轮之后
  //   以「0 个候选方案」的形式表现出来，用户根本看不出是自己参数写错了。
  let winInfo = null;
  let prioInfo = null;
  try {
    // ★ 两个入口互斥，语义也不同：
    //   --window   = 约束（严格模式，只在给定时段里选，没有就收手）
    //   --priority = 偏好（按列表顺序试，全落空时仍允许兜底到当天其它空档）
    //   同时给时以 --window 为准（约束更强的一方赢）。
    winInfo = applyWindowOverrides(config, cli.opts);
    if (!winInfo) prioInfo = applyPriorityOverrides(config, cli.opts);
  } catch (e) {
    console.error(`★ 时间段参数有误：${e.message}`);
    process.exit(2);
  }
  // --court：点名某一片场地（过滤，不是排序）
  if (cli.opts.court) {
    config.target.courtPriority = [String(cli.opts.court)];
    config.target.sameCourt = true;
  }
  const logDir = path.isAbsolute(config.paths.logs) ? config.paths.logs : path.join(config.__root, config.paths.logs);
  const log = new Logger({ dir: logDir, verbose: cli.flags.has('verbose') || !!config.verbose });

  log.info(`配置文件：${file}`);
  log.info(`目标场馆：${config.venue.name}（${config.venue.nodeid}）`);
  log.info(`时段优先：${config.target.hourPriority.map((h) => h.raw).join(' > ')}`);
  if (winInfo) {
    log.info(
      `★ 时间段由命令行指定：${winInfo.windows.map((w) => w.raw).join(' / ')}` +
      '（严格模式：只在这几段里选，不会兜底到别的时段）'
    );
    log.info(`  单次下单最少 ${winInfo.minSlots} 个时段（由窗口长度与 --slots 决定）`);
  }
  if (prioInfo) {
    log.info(
      `★ 优先级由命令行指定：${prioInfo.windows.map((w) => w.raw).join(' > ')}` +
      '（按顺序试；全都不行时仍允许兜底到当天其它空档）'
    );
  }
  log.info(`场地优先：${config.target.courtPriority.length ? config.target.courtPriority.join(' > ') : '（不限）'}`);
  log.info(`支付模式：${config.pay.mode}${config.safety.dryRun || cli.flags.has('dry-run') ? '   [DRY-RUN 不会真实下单]' : ''}`);

  if (!config.auth.token) {
    if (config.auth.allowRenew === true && config.auth.usercode) {
      log.info('auth.token 为空 —— 但已开启自动续期，启动时会用学号换发一个（无需微信/密码/验证码）');
    } else {
      log.error('配置缺少 auth.token。两条路：');
      log.error('  ① 推荐：在 config.yaml 里设 auth.allowRenew: true 并填好 auth.usercode，脚本会自己换发 token');
      log.error('  ② 手动：node src/login.js --renew，或按 recon/TOKEN.md 抓一次 token 填进 config.yaml');
      process.exitCode = 2;
      log.close();
      return;
    }
  }
  if (!config.auth.usercode) {
    log.warn('配置缺少 auth.usercode（学工号）。下单时 reservationPerson 会为空，可能被服务端拒绝。');
  }

  const g = new Grabber(config, log, {
    date: cli.opts.date,
    rel: cli.opts.rel,
    now: cli.flags.has('now'),
    noWait: cli.flags.has('no-wait'),
    poll: cli.flags.has('poll'),
    dryRun: cli.flags.has('dry-run') || config.safety.dryRun,
    interval: cli.opts.interval,
    maxRounds: cli.opts.maxRounds,
    verbose: cli.flags.has('verbose'),
    // ★ 传下去的是**解析后的窗口**（{from,to,raw}）：grab.js 靠它判断
    //   「这次是不是只许在指定时段里抢」，从而决定要不要兜底到当天任意空档。
    windows: winInfo ? winInfo.windows : null,
    // ★ 点名场地也必须传进 Grabber：buildTargets() 读的是 this.opts.court，
    //   只改 config.target.courtPriority 那只是「排序」，其它场地照样会被尝试
    //   （2026-10-19 实测：菜单里点「羽毛球场地1」，预演仍列出场地1/3/4 四个候选）。
    court: cli.opts.court ? String(cli.opts.court) : null,
  });

  /**
   * 写一份机器可读的结果标记（logs/last-result.json）。
   * 为什么需要：这是一次性无人值守任务，事后（或兜底脚本）必须能一眼判断
   * 「到底抢到没有」，不能靠人去翻日志里有没有「★ 已锁定」。
   */
  const writeMarker = (r, fatal) => {
    try {
      // ★ 可能有两张单（两片场地各 1 小时）。标记文件必须**两张都记**，
      //   否则 08:30 的兜底脚本只看到第一张、以为没抢满还会再冲一次。
      const orders = ((r && r.orders) || []).slice();
      const locked = (r && r.locked) || orders[0] || null;
      const realOrders = orders.filter((o) => o && !o.dryRun);
      // ★★ 「这一趟是不是预演」必须看**运行模式**，不能只看订单的 dryRun 标记。
      //   踩过的坑：原来写 `orders.length > 0 && realOrders.length === 0`，
      //   而「满场没抢到」那种预演 orders 是**空数组** ⇒ 算出来 false ⇒ 标记照写，
      //   实测把线上那条 130191 SUCCESS 覆盖成了 FAILED（我当场用 rebuild-marker.js 才救回来）。
      const anyDry = !!(g.opts && g.opts.dryRun) || (orders.length > 0 && realOrders.length === 0);
      const ok = realOrders.length > 0;
      const marker = {
        at: new Date().toISOString(),
        targetDate: (locked && locked.date) || g.targetDate || cli.opts.date || null,
        status: ok ? 'SUCCESS' : fatal ? 'ERROR' : 'FAILED',
        dryRun: anyDry,
        orderCount: orders.length,
        orderNo: (locked && locked.orderNo) || null,
        court: (locked && locked.courtName) || (locked && locked.court) || null,
        slots: (locked && locked.slots) || null,
        price: locked ? locked.price : null,
        paid: (r && r.paid && r.paid.paid) || false,
        payMessage: (r && r.paid && r.paid.message) || null,
        // ★★ 支付诊断（2026-10-12 加）：失败时那句「支付请求失败」是服务端内部的兜底文案，
        //   单看它分不清「参数不对」和「账号没在支付平台开通」。这里把请求目标、实测用的参数、
        //   以及**服务端返回的原始响应体**（client.lastRaw）一起落盘，事后不用再重抢一次场地。
        payDiag: (r && r.paid && r.paid.diag) || null,
        // 两张单全貌：时段 / 场地 / 订单号 / 金额 / 是否已付
        // ★ orders[i].court 存的是**场地名**（给人看的），场地 id 在 courtId。
        //   这里顺带也写一份 courtName，免得看标记文件的人/脚本按字面意思去取
        //   `orders[i].courtName` 拿到 undefined（预检 dry-run 就是这么踩的）。
        orders: orders.map((o, i) => ({
          index: i + 1,
          court: o.courtName || o.court || null,
          courtName: o.courtName || null,
          courtId: o.court || null,
          slots: o.slots || null,
          orderNo: o.orderNo || null,
          price: o.price || null,
          dryRun: !!o.dryRun,
          paid: !!(r && r.paidAll && r.paidAll[i] && r.paidAll[i].paid),
        })),
        totalPrice: orders.length
          ? orders.reduce((acc, o) => acc + (Number(o.price) || 0), 0).toFixed(2)
          : null,
        error: (r && r.error) || fatal || null,
      };
      // ★★ 预演**不许**覆盖生产标记（2026-10-14 踩过）：标记里记的是「上一次真实抢场」
      //   的订单号/时段/是否已付，而 dry-run 也会一路走到这里、把今早那条 SUCCESS 冲成
      //   FAILED（订单本身没丢，丢的是本地这份凭据）。落盘的东西只认真实运行。
      //   注意 dry-run 跑的是同一份 burst 逻辑，前面那些步骤都不会真实下单，
      //   所以这里只是「不落盘」，不是「少做判断」。
      if (marker.dryRun) {
        log.info(`结果标记：${marker.status}（dry-run，不覆盖 data/last-result.json）`);
        return;
      }
      const stateDir = path.isAbsolute(config.paths.state)
        ? config.paths.state
        : path.join(config.__root, config.paths.state);
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(path.join(stateDir, 'last-result.json'), JSON.stringify(marker, null, 2), 'utf8');
      // 同时放到 /tmp 一份：LuCI/SSH 下看最快，且不占 overlay
      try { fs.writeFileSync('/tmp/blcu-last-result.json', JSON.stringify(marker, null, 2), 'utf8'); } catch (e) { /* ignore */ }
      log.info(`结果标记：${marker.status}${marker.orderNo ? '  订单号=' + marker.orderNo : ''}`);
    } catch (e) {
      log.warn(`写结果标记失败（不影响抢场）：${e.message}`);
    }
  };

  try {
    const result = await g.run();
    writeMarker(result, null);
    if (result && result.error) {
      process.exitCode = 1;
      try { await notify(config.pay.notify, `【BLCU 抢场】本轮失败：${result.error}`, log); } catch (e2) { /* ignore */ }
    } else if (result && !result.locked && !cli.flags.has('poll')) {
      process.exitCode = 1;
    }
  } catch (e) {
    log.error(`执行中止：${e.message}`);
    writeMarker(null, e.message);
    if (cli.flags.has('verbose') && e.stack) log.debug(e.stack);
    process.exitCode = 1;
    try { await notify(config.pay.notify, `【BLCU 抢场】执行中止：${e.message}`, log); } catch (e2) { /* ignore */ }
  } finally {
    log.close();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error('未捕获异常：', e);
    process.exit(1);
  });
}

module.exports = {
  Grabber,
  main,
  parseArgs,
  // ★ 导出课表常量：`recon/gen-schedule-cfg.js` 用它生成 config.yaml 的
  //   target.schedule 块。手动誊写一份必然会和这里漂移，所以只留一处定义。
  DEFAULT_SCHEDULE,
  DEFAULT_FREE_OVERRIDE,
  scheduleEnabled,
  safeToMin,
  fmtHM,
  normWeekKey,
  weekdayOfDateStr,
  mergeIntervals,
  subtractIntervals,
};
