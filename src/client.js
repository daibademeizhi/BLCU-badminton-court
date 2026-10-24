'use strict';
/**
 * 本校 体育馆订场系统 API 客户端
 *
 * ── 请求规范（精确复刻前端 b4a5 模块的 myRequest）────────────────────────
 *   URL     : {baseUrl}{prefix}{path}
 *             默认 https://example.invalid/service/appointment/appointment/phone/xxx
 *   Method  : POST
 *   Headers : Content-Type: application/json
 *             token: <JWT>                    （业务接口必需，缺失 403，失效 401）
 *   Body    : {"item":"<大写HEX密文>"}       ← AES(requestBody)
 *
 * ── 响应规范 ────────────────────────────────────────────────────────────
 *   业务成功与否看 HTTP 200 响应体里的 `success` 字段，不看 HTTP 状态码。
 *   {"success":true,  "message":"...", "resultData":{...}}
 *   {"success":false, "message":"...", "resultData":null}
 *   HTTP 401 → token 失效；HTTP 403 → 未携带 token / 无权限
 *
 * ── 调用策略 ────────────────────────────────────────────────────────────
 *   串行节流（最小间隔）+ 网络错误退避重试 + 下单请求全局熔断计数。
 */

const https = require('https');
const { wrap, tryDecryptBody } = require('./crypto');

const NODEID_BADMINTON = '<场馆nodeid>';

class ApiError extends Error {
  constructor(message, status, body, kind) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
    this.kind = kind || 'http'; // http | auth | notFound | business | network
  }
}

/** 业务失败（HTTP 200 + success:false）*/
class BizError extends Error {
  constructor(message, result) {
    super(message);
    this.name = 'BizError';
    this.result = result;
    this.kind = 'business';
  }
}

class ApiClient {
  /**
   * @param {object} opts
   * @param {string} opts.baseUrl
   * @param {string} opts.prefix
   * @param {string} [opts.token]
   * @param {number} [opts.timeout]
   * @param {number} [opts.minInterval]
   * @param {boolean} [opts.verbose]
   */
  constructor(opts = {}) {
    this.baseUrl = String(opts.baseUrl || 'https://example.invalid').replace(/\/+$/, '');
    this.prefix = String(opts.prefix || '/service/appointment/appointment').replace(/\/+$/, '');
    this.token = opts.token || null;
    this.timeout = opts.timeout || 20000;
    this.minInterval = opts.minInterval != null ? opts.minInterval : 120;
    this.verbose = !!opts.verbose;
    this._lastAt = 0;
    this._lastRaw = null;
    /** 下单类请求计数（熔断用）*/
    this.reservationPosts = 0;
    this.maxReservationPosts = opts.maxReservationPosts != null ? opts.maxReservationPosts : 8;
    /** 请求统计 */
    this.stats = { total: 0, ok: 0, bizFail: 0, httpFail: 0, authFail: 0 };
    /** 解析后的 URL 组成部分 */
    const u = new URL(this.baseUrl);
    this._host = u.hostname;
    this._port = u.port || 443;
  }

  setToken(token) {
    this.token = token;
  }

  get lastRaw() {
    return this._lastRaw;
  }

  /** 串行节流 */
  async _throttle() {
    const wait = this._lastAt + this.minInterval - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this._lastAt = Date.now();
  }

  /**
   * 发一次加密请求并解析响应
   * @returns {Promise<any>} 解包后的 resultData
   * @throws {ApiError|BizError}
   */
  async call(path, payload = {}, opts = {}) {
    const json = await this.callRaw(path, payload, opts);
    if (!json.success) throw new BizError(json.message || '业务失败', json);
    return json.resultData;
  }

  /**
   * 与 call 相同，但返回完整响应体（不抛业务错误），便于调用方自行判断 success。
   */
  async callRaw(path, payload = {}, opts = {}) {
    const retries = opts.retries != null ? opts.retries : 2;
    const useAuth = opts.auth !== false;
    let lastErr = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        await this._throttle();
        const res = await this._once(path, payload, useAuth);
        this.stats.total++;

        if (res.status === 401) {
          this.stats.authFail++;
          throw new ApiError('token 已失效，请重新登录并更新配置中的 auth.token', 401, res.body, 'auth');
        }
        if (res.status === 403) {
          this.stats.authFail++;
          throw new ApiError(
            useAuth ? '403 拒绝访问：token 无效或该账号无预约权限' : '403 拒绝访问：该接口必须携带 token',
            403,
            res.body,
            'auth'
          );
        }
        if (res.status === 404) {
          this.stats.httpFail++;
          throw new ApiError(`404 接口不存在：${path}`, 404, res.body, 'notFound');
        }
        if (res.status !== 200) {
          this.stats.httpFail++;
          throw new ApiError(`HTTP ${res.status}（${path}）`, res.status, res.body, 'http');
        }

        let json = res.json;
        if (json == null) {
          const dec = tryDecryptBody(res.body);
          if (dec) { try { json = JSON.parse(dec); } catch (e) { /* ignore */ } }
        }
        if (json == null) {
          this.stats.httpFail++;
          throw new ApiError(`响应无法解析为 JSON（${path}）：${String(res.body).slice(0, 200)}`, 200, res.body, 'http');
        }

        // ★ 业务失败（HTTP 200 但 success=false）几乎都是确定性拒绝：
        //   「暂未发布预约规则」「该场地已被预订」「超出可预约数量」……
        //   重试既不可能成功，又会在冲刺阶段把请求量放大数倍（实测 90 秒 694 次请求）。
        //   因此 biz 失败不再退避重试，直接返回交调用方决定换方案还是换日期。
        if (json.success) this.stats.ok++;
        else this.stats.bizFail++;
        return json;
      } catch (e) {
        lastErr = e;
        if (e instanceof ApiError && (e.kind === 'auth' || e.kind === 'notFound')) throw e;
        if (attempt < retries) {
          const backoff = 300 * Math.pow(2, attempt) + Math.random() * 150;
          if (this.verbose) console.log(`  [重试 ${attempt + 1}/${retries}] ${e.message} → ${Math.round(backoff)}ms`);
          await new Promise((r) => setTimeout(r, backoff));
        }
      }
    }
    throw lastErr;
  }

  /** 单次 HTTP 往返 */
  _once(path, payload, useAuth) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify(wrap(payload));
      const headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/plain, */*',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
        'Content-Length': Buffer.byteLength(body),
      };
      if (useAuth && this.token) headers.token = this.token;

      const req = https.request(
        {
          host: this._host,
          port: this._port,
          path: this.prefix + path,
          method: 'POST',
          headers,
          timeout: this.timeout,
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            this._lastRaw = raw;
            if (this.verbose) {
              console.log(`  → ${path} HTTP ${res.statusCode} ${String(raw).slice(0, 200)}`);
            }
            let json = null;
            try { json = JSON.parse(raw); } catch (e) { /* 非 JSON */ }
            // 每次响应都把服务器 Date 头喂给 onResponse 钩子。
            // 作用：兜底校准时钟（有些响应体里没有 serverNow），以及在 403/401 时也能确认服务器在线。
            const serverDate = res.headers && res.headers.date;
            if (typeof this.onResponse === 'function') {
              try { this.onResponse({ path, status: res.statusCode, serverDate, json }); } catch (e) { /* 钩子异常不影响主流程 */ }
            }
            resolve({ status: res.statusCode, json, body: raw, serverDate: serverDate || null });
          });
        }
      );
      req.on('timeout', () => req.destroy(new Error(`请求超时（${this.timeout}ms）: ${path}`)));
      req.on('error', (e) => reject(new ApiError(`网络错误（${path}）: ${e.message}`, 0, null, 'network')));
      req.write(body);
      req.end();
    });
  }

  // ─────────────────────── 系统配置 / 验证码 ───────────────────────

  /**
   * 系统配置（type: appoint_function / phone_show / other）。
   *
   * ⚠️ 2026-10 实测：服务端已收紧鉴权，`getInfoByType` **必须带 token**，
   * 否则返回 403「拒绝访问：该接口必须携带 token」。
   * 早期「公共接口免 token」的结论已失效 —— 曾经那次「免 token 成功」的真因是
   * 当时还没收紧，而不是这个接口特殊。
   */
  getConfigData(type) {
    return this.call('/phone/getInfoByType', { type });
  }

  /** 图形验证码 */
  getCaptcha() {
    return this.call('/phone/login/captcha', {}, { auth: false });
  }

  // ─────────────────────── 抢场核心 ───────────────────────

  /**
   * ★ 放场状态 / 可订日期 / 时长限制
   * @param {string} nodeid
   * @returns resultData 字段：
   *   serverToday, serverNow, bookingstarttime, bookingendtime,
   *   maxbooktime, minselectnum, dateList[{date,week,status}],
   *   floorNum, floorHeight,
   *   releaseStatus(OPEN|UPCOMING|CLOSED), releaseOpen, userMessage,
   *   nextReleaseAt, releaseMode, bookingStartDate, bookingEndDate
   */
  getBookingTimeRange(nodeid = NODEID_BADMINTON) {
    return this.call('/phone/getBookingTimeRange', { nodeid });
  }

  /**
   * ★ 某日各场地的时段可用状态
   * @param {string} selecttime  YYYY-MM-DD
   * @param {object} [opts]
   * @returns resultData: [{ value:"18:00-19:00", status:"0|1|2", ... }]
   *   status: "0"=不可选  "1"=可选  "2"=已选中（客户端态，服务端一般不返回）
   */
  getAppointmentTimeSlot(selecttime, nodeid = NODEID_BADMINTON, opts = {}) {
    return this.call('/phone/getAppointmentTimeSlot', {
      nodeid,
      selecttime,
      groupAppoint: !!opts.groupAppoint,
    });
  }

  /**
   * ★ 场地与座位信息
   * @param {object} p {nodeid, appointmentDate, timeList, groupAppoint, bookingstarttime}
   * @returns resultData: { nodeMap, groupSingleMaxTicket, groupShowSelectAll }
   *   nodeMap[楼层] = { nodeListMap: { 场地nodeid: [{id, sitename, coordinate, status, ...}] } }
   */
  getSiteAppointInfo(p) {
    return this.call('/phone/getSiteAppointInfo', {
      nodeid: p.nodeid,
      appointmentDate: p.appointmentDate,
      timeList: p.timeList,
      groupAppoint: !!p.groupAppoint,
      bookingstarttime: p.bookingstarttime || '',
    });
  }

  /**
   * ★★ 整馆「场地 × 时段」网格 —— 抢场的主数据源（2026-10-10 实测确认）
   *
   * 一次请求同时给出：放场规则（releaseStatus/nextReleaseAt/预约窗口）、
   * 单次上限（maxSelect/minSelect）、以及每片场地每个时段的 disabled 状态，
   * 并标明不可订的原因（教学/工会占用、已被订走、教师占用）与订走的人。
   *
   * 相比旧路径（getAppointmentTimeSlot + getSiteAppointInfo）的优势：
   *   ① 少一次请求；② 不会出现「场地清单加载失败 → 退化为不指定场地」；
   *   ③ 能直接算出「哪片场地在 18:00-20:00 完全空着」，不必逐个试。
   *
   * ★ 注意：本方法用 callRaw，返回**完整响应体**（含 success/message/resultData）。
   * 不用 call 是因为「尚未放场」属于正常状态而非异常，调用方必须自己看 message，
   * 且需要从同一个响应里同时取 serverNow（对时）与 resultData（网格）。
   *
   * @param {object} p {parentNodeId, appointDate, nodeid?}
   * @returns {{success:boolean, message:string, resultData:object}} 完整响应体
   *   resultData: {serverNow, bookingStartDate, maxSelect, timeList, nodeTimeList:[{id,nodename,timeList:[{time,type,disabled,msg,limitSummary,bookedPreview}]}], ...}
   */
  getNodeAppointInfoList(p) {
    return this.callRaw('/phone/getNodeAppointInfoList', {
      parentNodeId: p.parentNodeId,
      appointDate: p.appointDate,
    });
  }

  /**
   * ★ 场馆下挂的子节点（= 具体场地清单）
   * @param {string} nodeid 场馆总 nodeid
   * @returns resultData: [{id:"羽毛球场地1的nodeid", value:"羽毛球场地1", selected:true}]
   */
  queryNodeListByParentid(nodeid) {
    return this.call('/phone/queryNodeListByParentid', { nodeid });
  }

  /**
   * ★ 查询价格（下单前必须调用，服务端据此校验金额）
   * @param {object} p {reserveDate, nodeid, appointInfo:[{nodeid,time}], reservationPerson, priceType, appointmentType}
   * @returns resultData: 金额（字符串/数字）
   */
  getPayPrice(p) {
    return this.call('/phone/getPayPrice', {
      reserveDate: p.reserveDate,
      priceType: p.priceType || '3',
      nodeid: p.nodeid,
      appointmentType: p.appointmentType || '2',
      reservationPerson: p.reservationPerson,
      appointInfo: p.appointInfo,
    });
  }

  /** 优惠列表（失败不影响下单）*/
  getAppointDiscountList(p) {
    return this.call('/phone/getAppointDiscountList', p, { retries: 0 });
  }

  /**
   * ★ 提交预约（下单锁场）
   *
   * payload 严格复刻 siteAppoint.gotoPay + pay.bookingByTime：
   *   parentNodeId / nodeid   场馆总 nodeid
   *   reservationPerson       usercode（学工号），不是 token
   *   appointInfo             [{nodeid: 场地id, time: "18:00-19:00"}]
   *   appointDetail           [{nodeid: 场地id, appointDetail:[{appointDate, timeInfo}]}]
   *   priceParams             价格参数块（nodeid/reserveTime/reserveDate/.../appointInfo）
   *   payprice / txamt        总价
   *   booktype                "2"（按时段预约，场所类）
   *   payway                  支付方式（下单时可省，支付时需要）
   *   lastAmount              实付金额
   *   firstApproveUser        审批人（无审批场景可省）
   *   approveAttList          审批附件 CSV（无附件传空串）
   *
   * @returns {{success:boolean, message:string, resultData:any}} 原始响应
   */
  async reservation(p) {
    if (this.reservationPosts >= this.maxReservationPosts) {
      throw new ApiError(
        `已达下单请求熔断上限（${this.maxReservationPosts} 次），本次运行不再提交预约`,
        0, null, 'business'
      );
    }
    this.reservationPosts++;

    const body = Object.assign({}, p);
    if (body.approveAttList === undefined) body.approveAttList = '';

    return this.callRaw('/phone/reservation', body, { retries: 0 });
  }

  /**
   * 待支付订单的支付请求
   * @param {object} p
   *   payway  支付方式编码：
   *     "77" openPlatFormPayOrder    开放平台支付
   *     "78" accountPayOrder         ★ 账户卡（校园卡）支付，最可能脱离微信
   *     "79" slPayOrder              扫码支付（返回 code_url）
   *     "79"? / "99" payOrder        返回 code_url，可生成二维码给对方扫
   *     "22"/"29" dlPayOrder         微信 JSAPI 直连
   *     "10" ldWxJsApiPay            微信 JSAPI
   *   orderno / txamt / payprice / lastAmount / booktype / cardType / accno / password ...
   */
  async payOrder(p) {
    const map = {
      '77': '/mobile/pay/openPlatFormPayOrder',
      '78': '/mobile/pay/accountPayOrder',
      '79': '/mobile/pay/slPayOrder',
      '99': '/mobile/pay/payOrder',
      '22': '/mobile/pay/dlPayOrder',
      '29': '/mobile/pay/dlPayOrder',
      '10': '/mobile/pay/ldWxJsApiPay',
      '50': '/mobile/pay/bjyyPay',
    };
    const path = map[String(p.payway)];
    if (!path) throw new ApiError(`未知支付方式 payway=${p.payway}`, 0, null, 'business');
    return this.callRaw(path, p, { retries: 0 });
  }

  /**
   * 可用支付方式列表。
   *
   * ⚠️ 实测（2026-10-10）：本接口会**间歇性 500**（服务端「获取抵扣次数信息异常」），
   * 同一 payload 可能前一分钟成功、后一分钟连续失败。调用方应显式提高重试次数
   * （`{ retries: 4 }`），支付前的通道探测尤其重要。
   */
  getPaywayList(p, opts) {
    return this.call('/phone/getPaywayList', p, opts);
  }

  /** 订单配置（含支付时限）*/
  getOrderConfig() {
    return this.call('/mobile/pay/getOrderConfig', {});
  }

  /** 押金信息 */
  getDepositInfo(p) {
    return this.call('/phone/getDepositInfo', p);
  }

  /**
   * ⚠️ 已废弃（2026-10-10 实测 404 接口不存在）：`/userAppoint/getUserAppointList` 不在服务端路由表里。
   *    查订单请用 payOrderForPhone()（同样在服务端故障时会 500）。
   *    保留此注释是为了避免以后有人再照旧名去试一遍。
   */

  /** 取消预约 */
  userCancelBooking(p) {
    return this.call('/phone/userCancelBooking', p);
  }

  /** 审批必要性检查 */
  checkApprovalRequired(p) {
    return this.call('/phone/checkApprovalRequired', p);
  }

  // ───────── 支付相关 ─────────

  /**
   * ★ 账户卡（校园卡）余额支付 —— payway "78"
   *
   * 复刻 pages/custom/pay/pay 的 confirm() 分支 "78"：
   *   if (this.isGray) return;                       // 幂等锁，脚本侧用 _payLocks 代替
   *   this.baseinfo.payway = this.payway;
   *   POST /mobile/pay/accountPayOrder  data = this.baseinfo
   *   判定：data.success === true && data.message === "支付成功"
   *
   * baseinfo 原始形态（data() 初始化 + 各步骤回填）：
   *   { txamt, orderno, payway, accno, password }
   *   - txamt    下单/进入支付页时的金额（注意前端多个分支里 txamt 可能是 "15.00" 字符串）
   *   - orderno  ★ /phone/reservation 成功后的 resultData.orderno
   *   - accno    ★ 来自 getPaywayList 里 payway="78" 那一项的 banknum
   *   - password ★ 卡密码键盘输入（明文），字段名就是 password
   *
   * @param {{orderno:string, accno:string, password:string, txamt:number|string,
   *          payway?:string|number}} p
   */
  accountPayOrder(p) {
    return this.payOrder({
      txamt: typeof p.txamt === 'number' ? p.txamt.toFixed(2) : String(p.txamt),
      orderno: p.orderno,
      accno: p.accno,
      password: p.password,
      payway: String(p.payway || '78'),
    });
  }

  /**
   * 复刻 pages/custom/pay/pay 的 confirm() 分支 "77"（一卡通支付 / 开放平台支付）：
   *   if (this.isGray) return;
   *   this.baseinfo.payway = "77";
   *   POST /mobile/pay/openPlatFormPayOrder  data = this.baseinfo
   *   成功：success===true && message==="支付成功" → paySuccess
   *   可重试：message 为 "卡密码错误" / "余额不足" 时 resultData 是 orderno，可换个方式再付
   *
   * ★ 与 78 的区别：77 不需要 accno（getPaywayList 的 77 项本来就没有 banknum 字段，
   *   前端也只在 78 分支里回填 accno）。学校把 checkYktPwd 配成 true
   *   （语义是「是否【不】校验一卡通支付密码」），因此 77 通常无需密码即可提交。
   *
   * @param {{orderno:string, txamt:number|string, payway?:string|number,
   *          accno?:string, password?:string}} p
   */
  openPlatFormPayOrder(p) {
    return this.payOrder({
      txamt: typeof p.txamt === 'number' ? p.txamt.toFixed(2) : String(p.txamt),
      orderno: p.orderno,
      payway: String(p.payway || '77'),
      accno: p.accno == null ? '' : p.accno,
      password: p.password == null ? '' : p.password,
    });
  }

  /** 卡密码校验（仅次卡 useFrequencyCard 流程需要；校园卡余额支付不需要）*/
  checkCipher(p) {
    return this.call('/frequencyCardInfo/checkCipher', p, { retries: 0 });
  }

  /**
   * 我的订单列表（前端 `pages-custom-order-customorder` @40801 / 首页 @17262）。
   *
   * ⚠️ 实测（2026-10-10）：该接口服务端**整段 500**（与 getPaywayList 的「抵扣次数」子服务同时挂），
   *    任何参数组合都是 HTTP 500。所以它**不是脚本链路的依赖**，保留仅为将来能用了再查 orderno。
   *
   * 前端真实参数：`{ pageNumber, pageSize, ordertype, status, onlySelf }`
   *   - 订单页 tab：`status` 为 tab 值，`ordertype: 1`
   *   - 首页「我的预订」：`status: 1`、`ordertype: 0`
   *   - 列表在 `resultData.content`
   */
  payOrderForPhone(p = {}) {
    return this.call('/phone/payOrderForPhone',
      Object.assign({ pageNumber: 1, pageSize: 10, ordertype: 1, status: null }, p), { retries: 0 });
  }

  /** 开卡/充值页的支付方式 */
  getOpenCardPayWayList(p = {}) {
    return this.call('/phone/getOpenCardPayWayList', p);
  }

  /**
   * ★ 我的会员卡/账户列表（含余额）—— 前端 `pages-custom-my-accounts` 的 `/account/getList`。
   *
   * 用途：**抢场之前先看卡里够不够钱**。2026-10-13 查明自动支付一直失败的原因是
   * 「卡里没钱」：服务端把余额不足兜底成 `{"success":false,"message":"支付请求失败"}`
   * （官方前端专门判的是 `"余额不足"` 这个字符串，服务端没吐出来就落到通用失败分支），
   * 而支付窗口只有约 5 分钟 ⇒ 没钱时脚本每早「抢到 → 付不了 → 5 分钟后释放」空转，
   * 白丢一次名额。有了这个接口就能在放场前把「余额不够」喊出来。
   *
   * 返回条目里与余额有关的是 `balance`（账面余额）与 `leavenum`（剩余可用次数/金额口径），
   * 以及 `accno`（★ payway "78" 账户卡支付要用的卡号）、`status`、`acctypename`、`endDate`。
   * 字段名照抄前端 `bank-item` 的 attrs，未做二次解释。
   */
  accountGetList(p = {}) {
    return this.call('/account/getList', p);
  }

  /** 免额时段检查 */
  checkUserAppointFreeHourInfo(p) {
    return this.call('/userAppoint/checkUserAppointFreeHourInfo', p);
  }
}

module.exports = { ApiClient, ApiError, BizError, NODEID_BADMINTON };
