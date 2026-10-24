'use strict';
/**
 * 支付模块 —— 自动/半自动把抢到的场地付掉
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 前端支付流程（pages/custom/pay/pay，payway="78" 账户卡/校园卡余额）逐字还原
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 阶段 0  进入支付页（siteAppoint.gotoPay 之后）
 *   ① getPaywayList(data)  → paywaylist[]
 *   ② 列表里 payway==="78" 的项执行 getCardPayPrice(item)：
 *        i = {...priceParams}; i.cardtype = item.cardtype;
 *        i.priceType = "2"; i.getCardPrice = true; i.notShowFailDia = true;
 *        POST /phone/getPayPrice  → success 时 item.payprice = resultData, item.isAppoint = true
 *      失败（success=false）则 item.isAppoint = false —— 该项不可选。
 *   ③ 用户点选校园卡那一项：
 *        itemObj(item) → this.baseinfo.accno = item.banknum; this.enterPassword = true;
 *
 * 阶段 1  立即支付 → confirm()
 *    if ("78" == this.payway) { this.isGray = true;
 *        POST /mobile/pay/accountPayOrder  data = this.baseinfo }   // {txamt, orderno, payway, accno, password}
 *
 * 阶段 2  下单链路（同一页的 bookingByTime，payway="78" 时先输密码再下单）
 *    enterSuccess(pwd) → this.baseinfo.password = pwd
 *    confirm() 里 "78" 分支不立即支付，而是往下走到
 *      bookingByTime():  param.payway = "78"; param.accno = baseinfo.accno; param.priceType = ...;
 *                        POST /phone/reservation
 *        成功且 payway 不是 "100"/"27" 且非次卡 → baseinfo.orderno = resultData.orderno; confirm()
 *
 *  ⚠ 因此：下单响应里的 resultData.orderno 是支付的必要输入；accno 来自 getPaywayList。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 本模块的策略
 * ══════════════════════════════════════════════════════════════════════════
 *  1. 先用 getPaywayList 确认服务端此刻是否提供 payway="78"（校园卡余额）。
 *  2. 拿到 accno：优先 config.pay.accno，否则从 getPaywayList 的 "78" 项 banknum 取。
 *  3. 有密码 → accountPayOrder；无密码 → 停下并推送「请手动付」。
 *  4. 一切失败都降级为半自动（notify），绝不重试到锁卡。
 */

const { parseSlot } = require('./config');

/** 账户卡/校园卡余额支付的 payway 编码 */
const PAYWAY_ACCOUNT_CARD = '78';
/** 一卡通支付（开放平台支付）的 payway 编码 —— 见下方 CHANNELS 说明 */
const PAYWAY_YKT = '77';
/** 次卡支付（不花钱，直接扣次）；下单响应为 27/100 时无需再支付 */
const PAYWAY_NO_PAY = ['27', '100'];

/**
 * 能「纯服务端」完成的支付通道，按优先级排列。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 2026-10-10 实测（该账号）getPaywayList 只返回两项：
 *   payway=50  统一支付平台（<你的学校>统一支付平台支付, opencard=1, txcode=yy050）
 *              → POST /mobile/pay/bjyyPayOrder，成功只返回 payurl，前端 location.href 跳转
 *              → 必然要在浏览器/微信里完成，**服务端跑不完**
 *   payway=77  一卡通支付
 *              → POST /mobile/pay/openPlatFormPayOrder，服务端直接扣款，**无需密码、无需跳转**
 *   payway=78  账户卡余额 —— 该账号**未开通**（学校没给这个通道）
 *              → POST /mobile/pay/accountPayOrder，同样全服务端
 *
 * 另：学校 getInfoByType(type="other") 里 checkYktPwd=true，
 *     其语义是「是否【不】校验一卡通支付密码」（前端据此把 checkYktPwd 置 false），
 *     即学校当前配置为**不校验**支付密码，所以 77 不需要密码。
 *
 * 因此自动支付的通道选择是：78（若开通）> 77。两者都是服务端闭环，都不弹二维码。
 * ══════════════════════════════════════════════════════════════════════════
 */
const CHANNELS = [
  {
    payway: PAYWAY_ACCOUNT_CARD,
    name: '账户卡余额',
    needsAccno: true,
    needsPassword: true, // 78 一定走密码键盘（前端 "78"==payway → enterPassword=true）
    call: (client, a) => client.accountPayOrder(a),
  },
  {
    payway: PAYWAY_YKT,
    name: '一卡通支付',
    needsAccno: false,
    needsPassword: false, // checkYktPwd=true → 不校验密码
    call: (client, a) => client.openPlatFormPayOrder(a),
  },
];

/** 从 getPaywayList 的返回项里挑出可自动支付的通道（按 CHANNELS 顺序优先）*/
function pickAutoChannel(items) {
  for (const spec of CHANNELS) {
    const it = (items || []).find((x) => x && String(x.payway) === spec.payway);
    if (it && !isMethodDisabled(it)) {
      return { ...spec, item: it };
    }
  }
  return null;
}

/** 支付项是否被服务端标记为不可用 */
function isMethodDisabled(it) {
  if (!it) return true;
  if (it.isAppoint === false) return true;
  if (it.status != null && String(it.status) !== '1') return true;
  return false;
}

function describePayway(it) {
  return `${it.payway}(${it.payname || it.paywayname || it.remark || ''})`;
}

/**
 * 该通道在本校配置下是否真的需要支付密码。
 *
 * 学校配置来自 `POST /phone/getInfoByType {type:"other"}` 里的 `checkYktPwd`：
 *   - 前端逻辑（pages-custom-pay-pay，getYktPayInfo）：
 *       `code=="checkYktPwd" && value=="true"` → `this.checkYktPwd = false`
 *   - 即 **checkYktPwd=true 表示「不校验一卡通支付密码」**（这是个反向命名）。
 * 78（账户卡余额）必须走密码键盘，一定有密码。
 */
function channelNeedsPassword(spec, cfg = {}) {
  if (spec.payway === PAYWAY_ACCOUNT_CARD) return true;
  // 77：默认按「学校不校验」处理；仅当配置里显式声明需要时才要求密码
  if (cfg.pay && cfg.pay.yktPasswordRequired === true) return true;
  return false;
}

/** 从任意对象里挑出「像校园卡账号」的字段（getPaywayList.banknum / 订单里的 accno 等） */
const ACCNO_KEYS = ['banknum', 'accno', 'bankNo', 'cardNo', 'cardno', 'account'];

function pickAccno(obj) {
  if (!obj || typeof obj !== 'object') return '';
  for (const k of ACCNO_KEYS) {
    const v = obj[k];
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

/** 金额格式化：前端到处用 toFixed(2) 的字符串，服务端也吃字符串 */
function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(2) : '0.00';
}

class AutoPay {
  /**
   * @param {object} o
   *   client  ApiClient（已带 token）
   *   cfg     完整配置对象
   *   log     Logger
   *   notify  (text) => Promise
   */
  constructor(o) {
    this.client = o.client;
    this.cfg = o.cfg;
    this.log = o.log;
    this.notify = o.notify || (async () => {});
    /** 服务端本次会话暴露的支付方式列表（getPaywayList 原始返回）*/
    this.paywayList = null;
    /** 已确认可用的校园卡账号 */
    this.accno = String(this.cfg.pay.accno || '').trim();
    /** 幂等锁：避免同一次运行内重复提交支付（对应前端 isGray）*/
    this._locks = new Set();
  }

  // ─────────── 便捷入口 ───────────

  /**
   * 抢到场地后按 pay.mode 结算
   *
   * @param {object} locked  grab.js 的 this.result.locked
   *   需要字段：orderno(court no) / court / courtName / slots / price / resultData / dryRun
   * @param {object} ctx    下单上下文，用于给 getPaywayList 组装参数
   *   { parentNodeId, appointInfo:[{nodeid,time}], appointDetail, slots:[...], date, nodeid }
   * @returns {Promise<{paid:boolean, mode:string, message:string, accno?:string, payway?:string}>}
   */
  async settle(locked, ctx) {
    const mode = String(this.cfg.pay.mode || 'semi').toLowerCase();

    if (!locked || locked.dryRun) {
      return { paid: false, mode, message: 'dry-run / 无锁场记录，跳过支付' };
    }

    // ★ 两个名字都要认：接口字段是 `resultData.orderno`（全小写），但 grab.js 的
    //   锁场记录一度只写 `orderNo`（驼峰）。2026-10-12 的「抢到了却没付成」就是
    //   这里只读小写、那边只写驼峰造成的（场地被锁、支付窗口过了就自动释放）。
    const orderno = locked.orderno || locked.orderNo;
    if (!orderno) {
      this.log.warn('下单响应里没有 orderno，无法继续支付流程');
      await this._askManual(locked, '未取得订单号，请到「我的订单」里继续支付');
      return { paid: false, mode, message: '缺少 orderno' };
    }

    if (mode === 'skip') {
      this.log.info('pay.mode=skip：不做任何支付动作，请自行支付');
      await this._askManual(locked, '脚本按配置不自动支付');
      return { paid: false, mode, message: 'skip' };
    }

    if (mode === 'semi') {
      this.log.info('pay.mode=semi：不自动支付，仅推送付款提醒');
      await this._askManual(locked, '半自动模式：请立即完成支付');
      return { paid: false, mode, message: 'semi' };
    }

    // ── auto ──
    this.log.section('自动支付：服务端闭环通道（78 账户卡余额 / 77 一卡通支付）');
    const prep = await this.prepare(locked, ctx);

    if (!prep.ok) {
      // 原因可能是「本账户没有可自动支付的通道」或「服务端暂不支持」——都不是异常，走人工
      this.log.warn(`自动支付条件不满足：${prep.reason}`);
      await this._askManual(locked, `自动支付未完成（${prep.reason}）`);
      return { paid: false, mode, message: prep.reason };
    }

    const ch = prep.channel || CHANNELS[0];
    const payway = ch.payway;
    const pwd = String(this.cfg.pay.cardPassword || '');

    // 通道需要密码但没有配置 → 不硬试（错一次可能锁卡），直接转人工
    if (ch.needsPassword && !pwd) {
      this.log.warn(`通道 ${payway} 需要支付密码，但未配置 pay.cardPassword → 降级为半自动`);
      await this._askManual(locked, `已备好订单（通道 ${payway}），但未配置卡密码（pay.cardPassword），请手动支付`);
      return { paid: false, mode, message: '缺少 cardPassword', accno: this.accno, payway };
    }

    const lockKey = `pay:${orderno}:${payway}`;
    if (this._locks.has(lockKey)) {
      this.log.warn('该订单已在本进程内提交过支付，跳过重复提交');
      return { paid: false, mode, message: '重复提交已拦截', accno: this.accno, payway };
    }
    this._locks.add(lockKey);

    const amount = prep.amount;
    // ★★ 支付诊断：把服务端的**完整原始返回**留下来。
    //
    //   起因（2026-10-12）：四次真实尝试（129925/129942 × payway 77/50）全部只拿到一句
    //   `{"success":false,"message":"支付请求失败","resultData":null}` —— 这句话在**前端代码里
    //   根本不存在**（全量 grep 过 chunks），说明它是**服务端内部**抛出来的兜底文案。
    //   只凭这一句无法区分「参数问题」和「账号在支付平台侧没开通」，所以下次抢到场地
    //   必须把响应体整个抓下来（`client.lastRaw` 是 client.js 在 _post 里存的原文，
    //   不只是 JSON.parse 之后的那层）存进日志与 last-result.json，供事后定位。
    const diag = { url: '', payload: null, raw: null, attempts: [] };
    try {
      const args = {
        orderno,
        txamt: money(amount),
        payway,
        accno: ch.needsAccno ? this.accno : '',
        password: ch.needsPassword ? pwd : '',
      };
      diag.payload = {
        orderno: args.orderno,
        txamt: args.txamt,
        payway: args.payway,
        accno: args.accno || '(空)',
        password: args.password ? '***' : '(空)',
      };
      const path = payway === PAYWAY_YKT ? '/mobile/pay/openPlatFormPayOrder' : '/mobile/pay/accountPayOrder';
      diag.url = path;
      this.log.info(`提交支付：POST ${path}  orderno=${orderno} txamt=${args.txamt} ` +
        `accno=${args.accno || '(空)'} password=${args.password ? '***' : '(空)'}`);

      // ★ 失败后隔 3 秒再试一次：支付网关偶发瞬时报错与「账号未开通」在
      //   单次响应里长得一模一样，多试一次能排除前者。**只在明确是「支付请求失败」
      //   这类无副作用错误时重试** —— 密码/余额类的错误绝不重试（会锁卡）。
      const MAX_ATTEMPTS = 2;
      let res = null;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const t0 = Date.now();
        res = await ch.call(this.client, args);
        const raw = (this.client && typeof this.client.lastRaw === 'string') ? this.client.lastRaw : null;
        diag.attempts.push({
          attempt,
          ms: Date.now() - t0,
          success: res && res.success === true,
          message: (res && res.message) || null,
          raw,
        });
        if (raw) diag.raw = raw;
        this.log.info(`  支付返回（第 ${attempt}/${MAX_ATTEMPTS} 次，${Date.now() - t0}ms）：` +
          `success=${res && res.success}  message=${(res && res.message) || '(空)'}`);
        this.log.info(`  原始响应体：${raw || '(client 没有留下原文)'}`);
        const okNow = res && res.success === true && String(res.message || '').indexOf('支付成功') >= 0;
        if (okNow) break;
        // 只对「无副作用的通道内部错误」重试；含密码/锁定/次数/余额的一律立即停手
        const m = String((res && res.message) || '');
        const retryable = attempt < MAX_ATTEMPTS && !/密码|锁定|次数|余额|已支付|已失效|过期/.test(m);
        if (!retryable) break;
        this.log.info(`  3 秒后重试一次（先排除网关瞬时报错）…`);
        await new Promise((r) => setTimeout(r, 3000));
      }
      const ok = res && res.success === true && String(res.message || '').indexOf('支付成功') >= 0;
      if (ok) {
        this.log.info(`★ 支付成功：订单 ${orderno}  金额 ${amount}  通道 ${payway}（${ch.name}）`);
        await this.notify(
          `【本校 抢场】已自动支付成功 ✅\n订单号：${orderno}\n金额：${amount} 元\n通道：${payway} ${ch.name}`
        );
        return { paid: true, mode, message: '支付成功', accno: this.accno, payway, diag };
      }

      const msg = (res && res.message) || '未知失败';
      this.log.warn(`自动支付未成功：${msg}（success=${res && res.success}）`);
      // 卡密码错误 / 余额不足 → 绝不再试，立即转人工（继续试会锁卡）
      const hint = /密码|锁定|次数/.test(msg)
        ? '卡密码错误或已锁定，请勿再让脚本重试'
        : payway === PAYWAY_YKT
          ? '一卡通通道被拒（可能需要在刷卡机上确认，或该卡未绑定）——请手动支付'
          : '请手动完成支付';
      await this._askManual(locked, `自动支付失败：${msg}（${hint}）`);
      return { paid: false, mode, message: msg, accno: this.accno, payway, diag };
    } catch (e) {
      this.log.warn(`自动支付异常：${e.message}`);
      await this._askManual(locked, `自动支付异常：${e.message}`);
      return { paid: false, mode, message: e.message, accno: this.accno, payway, diag };
    }
  }

  // ─────────── 阶段 0：查通道、拿 accno、核对金额 ───────────

  /**
   * 复刻进入支付页时的动作：
   *   getPaywayList → 找 "78" → getCardPayPrice 校验该通道能否用于本单
   *
   * @returns {Promise<{ok:boolean, reason:string, amount:number, item?:object}>}
   */
  async prepare(locked, ctx) {
    const amount = Number(locked.price) || 0;

    if (this.cfg.pay.dryRunPay) {
      return { ok: false, reason: 'pay.dryRunPay=true（演练：不提交真实支付）', amount };
    }

    // 1) 支付方式列表
    //    ⚠️ 实测（2026-10-10）：该接口会间歇性 500（服务端「获取抵扣次数信息异常」），
    //    同一 payload 前一分钟成功、后一分钟连续失败 —— 所以这里必须给足重试，
    //    否则抢到场地后会因为一次抖动就错误地降级为「人工付款」。
    let list = null;
    let listReason = '';
    try {
      list = await this.client.getPaywayList(this._buildPaywayQuery(locked, ctx), { retries: 4 });
    } catch (e) {
      listReason = e.message;
    }
    this.paywayList = list;
    const items = Array.isArray(list) ? list : (list && list.content) || [];

    // 1b) 服务端通道列表拿不到时的兜底：config 里显式指定的通道照用不误。
    //     意义在于——2026-10-10 实测 getPaywayList 会整段 500（连空 body 都 500），
    //     而当天抢场依旧发生；若没有这条兜底，抢到场地后会白白降级成人工付款。
    //     该账号实测只有 77 能服务端闭环，所以配置里预置 77 最稳（这条通道不依赖
    //     banknum、不需要密码，跳过 getPaywayList 的唯一损失是无法感知学校新开的通道）。
    if (!items.length) {
      const forced = String(this.cfg.pay.payway || '').trim();
      const spec = forced ? CHANNELS.find((c) => c.payway === forced) : null;
      if (spec) {
        this.log.warn(
          `getPaywayList 不可用（${listReason || '返回为空'}）→ 回退到配置指定的通道 ${spec.payway}（${spec.name}）` +
          '，不因此放弃自动支付'
        );
        this.channel = Object.assign({}, spec, {
          item: {},
          needsPassword: channelNeedsPassword(spec, this.cfg),
        });
        return { ok: true, amount, channel: this.channel, forced: true, methods: [] };
      }
      return {
        ok: false,
        reason: listReason
          ? `getPaywayList 失败：${listReason}`
          : '服务端未返回任何可用支付方式（订单可能已过期/已支付）',
        amount,
      };
    }

    // 选择自动支付通道：78（账户卡余额）优先，其次 77（一卡通支付）
    const channel = pickAutoChannel(items);
    if (!channel) {
      const ways = items.map((it) => describePayway(it)).join('、');
      return {
        ok: false,
        reason:
          '本账户没有无需微信的自动支付通道（payway 78/77）→ 请手动支付；' +
          `服务端提供：${ways}`,
        amount,
        methods: items,
      };
    }
    this.methods = items;
    // needsPassword 是「本校配置下是否真的要密码」，不是通道固有属性：
    //   78 → 一定走密码键盘；77 → 看学校 checkYktPwd 配置（默认不校验）
    channel.needsPassword = channelNeedsPassword(channel, this.cfg);
    this.channel = channel;

    // 77（一卡通）不需要 accno：getPaywayList 的 77 项没有 banknum 字段，前端也只在 78 分支回填
    if (channel.payway === PAYWAY_ACCOUNT_CARD) {
      const fromList = pickAccno(channel.item);
      // ★ 服务端给的 banknum 才是权威；配置值仅在没有 banknum 时兜底
      if (fromList) this.accno = fromList;
      if (!this.accno) {
        return {
          ok: false,
          reason: '拿不到校园卡账号（banknum），请在 config.yaml 的 pay.accno 里手工填一次',
          amount,
        };
      }

      // 该校验收通道对本单是否可用（priceType="2" + getCardPrice=true）
      const quoted = await this._cardQuote(ctx, channel.item);
      if (quoted === null) {
        return { ok: false, reason: '该校园卡通道对本单不可用（getCardPayPrice 返回失败）', amount };
      }
      this.log.info(
        `通道 78 可用：accno=${this.accno}  cardtypename=${channel.item.cardtypename || channel.item.title || '-'}  ` +
        `卡价=${quoted}  应付=${amount}`
      );
      // 卡价与下单金额不一致时给出告警但不阻断：以下单时的 payprice 为准（前端也是以 txamt 支付）
      if (Number(quoted) > 0 && Math.abs(Number(quoted) - amount) > 0.001) {
        this.log.warn(`注意：卡价 ${quoted} 与下单金额 ${amount} 不一致，将按 ${money(amount)} 提交支付`);
      }
      return { ok: true, reason: '', amount, item: channel.item, channel };
    }

    // 通道 77：一卡通支付。学校把 checkYktPwd 配成 true（=「不校验一卡通支付密码」），
    // 故通常无需密码；仍允许配置 cardPassword 作为兜底（若学校改回校验）。
    this.log.info(
      `通道 77 可用（一卡通支付 ${channel.item.payname || ''}）` +
      `${channel.needsPassword ? '，学校要求校验支付密码' : '，学校不校验支付密码'}`
    );
    return { ok: true, reason: '', amount, item: channel.item, channel };
  }

  /** 组装 getPaywayList 的查询参数（对齐 pay 页）*/
  _buildPaywayQuery(locked, ctx = {}) {
    const slots = (ctx.slots || locked.slots || []).slice();
    const appointInfo = ctx.appointInfo
      || slots.map((time) => ({ nodeid: ctx.court || locked.court || '', time }));
    const date = ctx.date || locked.date || '';
    const parentNodeId = ctx.parentNodeId || this.cfg.venue.nodeid;

    const detail = ctx.appointDetail
      || (ctx.court
        ? [{ nodeid: ctx.court, appointDetail: slots.map((timeInfo) => ({ appointDate: date, timeInfo })) }]
        : []);

    return {
      parentNodeId,
      appointInfo,
      appointDetail: detail,
      appointDates: undefined,
      appointDate: date,
      followUser: [],
      booktype: '2',
      wxType: '',
    };
  }

  /**
   * getCardPayPrice 复刻：在 priceParams 基础上加 cardtype / priceType="2" / getCardPrice=true
   * @returns {Promise<number|null>} 卡价；null 表示该通道不可用
   */
  async _cardQuote(ctx, card) {
    const slots = (ctx.slots || []).slice();
    const date = ctx.date || '';
    const nodeid = ctx.nodeid || this.cfg.venue.nodeid;
    const court = ctx.court || '';
    const appointInfo = ctx.appointInfo || slots.map((time) => ({ nodeid: court, time }));

    const params = {
      nodeid,
      reserveTime: slots,
      reserveDate: date,
      accompanyPerson: [],
      reservationPerson: this.cfg.auth.usercode,
      appointmentType: '2',
      appointInfo,
      groupAppoint: false,
      cardtype: card.cardtype,
      priceType: '2',
      getCardPrice: true,
      notShowFailDia: true,
    };
    try {
      const v = await this.client.getPayPrice(params);
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    } catch (e) {
      this.log.debug(`getCardPayPrice 失败：${e.message}`);
      return null;
    }
  }

  // ─────────── 辅助 ───────────

  /** 该订单是否需要真的付钱（次卡/0 元单不用）*/
  static needsPayment(locked) {
    const rd = (locked && locked.resultData) || {};
    const pw = String((locked && locked.payway) || rd.payway || '');
    if (PAYWAY_NO_PAY.indexOf(pw) >= 0) return false;
    const amount = Number(locked && locked.price);
    return !(Number.isFinite(amount) && amount === 0);
  }

  async _askManual(locked, reason) {
    const c = locked || {};
    const text = [
      '【本校 抢场】场地已锁定，请尽快付款',
      `日期：${c.date || ''}`,
      `时段：${(c.slots || []).join(' + ')}`,
      `场地：${c.courtName || c.court || ''}`,
      c.price != null ? `金额：${c.price} 元` : '',
      c.orderno ? `订单号：${c.orderno}` : '',
      `原因：${reason}`,
      '入口：微信 → 体育馆服务号 → 订场 → 我的订单 → 待支付（超时未付场地会自动释放）',
    ].filter(Boolean).join('\n');
    this.log.warn(text.replace(/\n/g, ' | '));
    try {
      await this.notify(text);
    } catch (e) {
      this.log.warn(`推送失败：${e.message}`);
    }
  }
}

module.exports = {
  AutoPay,
  PAYWAY_ACCOUNT_CARD,
  PAYWAY_YKT,
  PAYWAY_NO_PAY,
  CHANNELS,
  pickAutoChannel,
  channelNeedsPassword,
  describePayway,
  pickAccno,
  money,
  parseSlot,
};
