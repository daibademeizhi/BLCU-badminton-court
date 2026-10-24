# 这份代码是怎么写出来的

> 一份写给自己学习用的「复盘笔记」。
> 它不教你怎么用这个工具（那是 [README.md](../README.md) 的事），
> 而是讲**每一块代码为什么长成现在这样**：当时遇到什么问题、试了哪条路、
> 为什么最后选了这一条、以及哪些地方是被现实打过脸之后才改的。
>
> 阅读前提：会一点 JavaScript（`async/await`、`Promise`、`class`），
> 知道 HTTP 请求和 JSON 是什么。不需要会 Node.js 框架 —— 这个项目
> **一个第三方依赖都没有**，`package.json` 里的 `dependencies` 是空的。

> 小提示：这份笔记写的是**最初那套实现**，文中会出现「软路由」「`run-grab.sh`」
> 这类字眼 —— 那是同源代码的另一种部署方式（见 README 第七节）。电脑直跑版里
> 对应关系是：`run-grab.sh` ↔ `src/once.js` + Windows 计划任务，`router/state.js` ↔ `tools/state.js`，
> 其余 `src/` 代码两边完全一致。

---

## 目录

1. [先想清楚：这东西的本质是什么](#1-先想清楚这东西的本质是什么)
2. [一切的起点：为什么必须用 Node.js 手写](#2-一切的起点为什么必须用-nodejs-手写)
3. [第一层：把「网络请求」这件事包起来](#3-第一层把网络请求这件事包起来)
4. [第二层：零依赖解析 YAML](#4-第二层零依赖解析-yaml)
5. [第三层：不信任本机时钟](#5-第三层不信任本机时钟)
6. [第四层：把「想抢什么」翻译成候选方案](#6-第四层把想抢什么翻译成候选方案)
7. [第五层：08:00 那一刻发生了什么](#7-第五层0800-那一刻发生了什么)
8. [第六层：支付是另一条独立的链路](#8-第六层支付是另一条独立的链路)
9. [横切关注点：日志、通知、结果文件](#9-横切关注点日志通知结果文件)
10. [怎么确认它真的没坏：自检与门禁测试](#10-怎么确认它真的没坏自检与门禁测试)
11. [打了七次的补丁：每一轮线上事故教了我们什么](#11-打了七次的补丁每一轮线上事故教了我们什么)
12. [跨平台：为什么脚本比代码更难写](#12-跨平台为什么脚本比代码更难写)
13. [如果让我重写一遍](#13-如果让我重写一遍)

---

## 1. 先想清楚：这东西的本质是什么

抛开「抢羽毛球场」这个外壳，它的本质是：

> **在一个不确定的时刻（学校什么时候放场不知道），
> 用尽可能小的延迟，去争取一份有限的资源（场地），
> 然后在资源过期前（支付窗口只有几分钟）把它锁定。**

这句话拆开来，就是整个项目的技术路线：

| 需求 | 技术上的含义 | 落到哪个文件 |
| --- | --- | --- |
| 不知道放场时刻 | 得有一个「提前盯着，一有变化立刻动手」的循环 | `src/grab.js` 的 `warmup()` / `waitForRelease()` |
| 延迟要小 | 轮询间隔要能压到 100ms 级，且不能每次都重新建连接 | `src/client.js` 的连接复用、`burstPollMs` |
| 资源有限 | 有并发时会有竞争，失败要能区分「再来一次就行」和「今天没戏了」 | `src/grab.js` 的 `_submitOne()` |
| 过期前锁定 | 抢到之后还得**付钱**，而这是另一条业务链路 | `src/pay.js` |
| 不确定性 | 电脑时间、网络抖动、服务端时间都可能不准 | `src/util.js` 的 `ServerClock` |

**设计上的第一个决定：宁可多写代码，不要多装依赖。**
原因很实际 —— 这东西最终要跑在一个 128MB 内存的软路由上（见第 12 节），
`npm install` 在那里既慢又容易失败，而任何第三方包都会带来
「它更新了 / 它不支持这个 Node 版本 / 它的传递依赖有洞」的长期维护成本。
所以整个项目从头到尾只用了 Node 内置的
`fs` / `path` / `os` / `https` / `http` / `url` / `crypto` / `child_process` / `assert`。

---

## 2. 一切的起点：为什么必须用 Node.js 手写

这件事其实有好几条明显更省事的路，但每条都被现实否掉了。

**路线 A：浏览器里跑个油猴脚本，定时点按钮。**
最省事，但有几个死结：

- 浏览器标签页会被系统挂起（省电策略），定时器不准；
- 抢到之后要**付款**，而支付接口需要一个有效的登录态 —— 那是微信服务号里的会话，
  浏览器脚本拿不到；
- 最关键的：**「放场」这件事发生在服务端，页面上的按钮亮不亮，
  取决于你刷新时那一刻服务端返回的数据**。要把它压到几百毫秒级，
  就得直接打接口，而不是等页面渲染。

**路线 B：Python + requests。**
技术上完全可行，但要在软路由上装 Python 环境，体积和难度都比 Node 大一截。
而且这个项目的核心逻辑（并发提交、精确到毫秒的等待）用 Node 的事件循环写更顺手。

**路线 C：电脑上挂着不关机。**
早期确实这么干过（Windows 计划任务，见 `deploy/schedule.ps1`），
但电脑会睡眠、会重启、会被系统更新打断。
最后的选择是**两条腿走路**：电脑上一个「手动扳机」，
软路由上一个 7×24 常驻的定时任务。

**结论**：用 Node.js 直接调 HTTP 接口，是唯一能同时满足
「延迟足够低」「能携带支付所需登录态」「能在小设备上跑」的方案。

于是第一步就是：**把登录态搞清楚。**

> ### 插叙：一个必须写在最前面的安全隐患
>
> 逆向过程中发现，这个平台的登录接口
> `POST /phone/login/idSerialLogin`
> **只凭学号就能换发一枚新的 token** —— 不需要密码、不需要短信验证码、
> 不需要微信授权。
>
> 这是平台的鉴权缺陷，不是我们的功劳。但它带来一个直接的道德和法律边界：
> **这个东西只允许用来抢你自己的场地。**
>
> 代码里因此加了两道闸门（`src/login.js:211` 的 `ensureToken()`）：
>
> 1. `auth.allowRenew` 默认是 **false**，也就是默认根本不允许程序自己去换 token；
> 2. 即使打开了，换发回来的 token 里解出的学号如果和配置里的
>    `auth.usercode` 不一致，立刻抛错中止 —— 防止「配错了学号，
>    结果一直在给别人的账号发请求」。
>
> 写工具的时候顺手把边界写进代码里，比写在 README 里有用得多 ——
> README 没人读，代码会拦住你。

---

## 3. 第一层：把「网络请求」这件事包起来

### 3.1 为什么要有 `ApiClient`

如果直接用 `https.request`，每个调接口的地方都得写一遍：
拼 URL、序列化 body、设 header、处理超时、解析 JSON、
处理 gzip、处理各种业务错误…… 这些是纯粹的重复劳动，
而且任何一处写错都会变成难以定位的偶发 bug。

所以 `src/client.js:48` 定义了 `ApiClient`，把所有接口
都收敛成「一个方法 + 一组参数」：

```js
// src/client.js
class ApiClient {
  constructor(opts = {}) { /* baseUrl / prefix / token / 超时 / 限速 */ }
  async call(path, payload = {}, opts = {}) { /* 业务调用：只关心 resultData */ }
  async callRaw(path, payload = {}, opts = {}) { /* 要原始响应体时用 */ }
  _once(path, payload, useAuth) { /* 真正发一次 HTTP（Promise 化的 https.request） */ }

  // 然后每个业务接口就是一个薄薄的方法
  getAppointmentTimeSlot(selecttime, nodeid, opts) { /* ... */ }
  async reservation(p) { /* ... */ }
  async payOrder(p) { /* ... */ }
  // ...
}
```

**这里有个值得学的设计：`call` 和 `callRaw` 分开。**

一开始只有 `call()`，它把服务端返回的 `{ success, message, resultData }`
里的人话部分剥出来给业务代码用。后来支付调试时踩了坑
（见第 11 节「支付为什么只报『支付请求失败』」），
发现**必须看到完整原始响应体**才能定位问题，
于是加了 `callRaw()`，并把最后一次的原始响应存进 `this.lastRaw`，
出问题时能被诊断代码捞出来。

> **经验**：抽象层要留一个「逃生舱口」。
> 只给业务代码看加工过的数据是对的，
> 但一定要有一条路径能拿到未经加工的原件，否则排查线上问题时会瞎。

### 3.2 错误分类：这不是洁癖，是刚需

`src/client.js:28` 附近定义了两个错误类型：

```js
class ApiError extends Error { constructor(message, status, body, kind) { /* HTTP 层 */ } }
class BizError extends Error { constructor(message, result) { /* 业务层：success=false */ } }
```

为什么要分开？因为**上层要做的决定完全不同**：

| 错误类型 | 含义 | 上层该做什么 |
| --- | --- | --- |
| `ApiError` + `kind='network'` | 断网 / 超时 | 重试，这是暂时的 |
| `ApiError` + `status=403` | token 过期 | 去续期（`_healAuth()`），然后再试 |
| `ApiError` + `status=500` | 服务端炸了 | 重试，但别把预算烧光 |
| `BizError` + 「每天最多选择预约 1 个不同场地」 | 规则不允许 | **立刻收手**，重试一万次也没用 |

如果全揉成一个 `Error`，上层就只能靠正则去猜错误消息，
代码会迅速变成一团乱麻。

### 3.3 限速与熔断：`src/client.js` 里两个不起眼但救命的变量

```js
async _throttle() { /* 两次请求之间至少间隔 minIntervalMs */ }

async reservation(p) {
  if (this.reservationPosts >= this.maxReservationPosts) {
    throw new ApiError(`已达下单请求熔断上限（${this.maxReservationPosts} 次），本次运行不再提交预约`);
  }
  this.reservationPosts++;
  // ...真正发请求
}
```

`reservationPosts` 只有在**真正把下单请求发出去**时才 `++`。
这个细节很重要：它统计的是「我给服务端造成了几次写入压力」，
而不是「我尝试了几次」。任何试图通过重试来绕开它的写法都违反了这个语义。

> **经验**：熔断计数要计在「有副作用的那一次调用」上，
> 而不是「业务函数被调用的次数」。否则日志重试、
> 参数校验失败这些无害路径会把预算吃光。

---

## 4. 第二层：零依赖解析 YAML

配置用 YAML 写（人能读、能写注释），但 Node 标准库里没有 YAML 解析器。

三个选择：
1. 装 `js-yaml`（一个依赖）；
2. 用 JSON 当配置格式（能读，但不能写注释，而这份配置的注释是它最有价值的部分）；
3. 自己写一个**够用的** YAML 子集解析器。

选了 3。`src/config.js` 里大约 160 行代码干这件事：

```js
function stripComment(line) { /* 去掉 # 注释，但要小心引号里的 # */ }
function parseScalar(raw) { /* "true"/"123"/'"字符串"'/[1,2] → 真正的 JS 值 */ }
function tokenize(text) { /* 文本 → 按缩进分层的行数组 */ }
function parseBlock(lines, pos, indent) { /* 递归下降：按缩进建对象/数组 */ }
function parseYaml(text) { /* 入口 */ }
function loadYamlFile(file) { /* 读文件 + 解析；如果装了 js-yaml 就优先用它 */ }
```

关键点：

- **只支持这个项目用到的子集**：嵌套映射、数组、标量、行内数组 `[a, b]`、
  `#` 注释、单双引号字符串。不支持锚点、多行字符串、复杂键 ——
  因为配置文件里不需要，而支持它们会让代码量翻几倍。
- **`loadYamlFile()` 会先试着 `require('js-yaml')`**，
  有就用它（更严格），没有就用自己的解析器。
  这样「零依赖」是默认体验，但高级用户装了 js-yaml 也不会被拦。
- **配置合并**：`deepMerge(base, over)` 让「默认值写在代码里、
  用户只覆盖关心的字段」成立。`src/config.js:326` 的 `loadConfig()`
  会先铺一份内置默认值，再把 YAML 叠上去。

> **经验**：自己写解析器的前提是**明确知道自己不支持什么**，
> 并且把这句话写进注释里。含糊其辞的「简易解析器」是最容易埋雷的东西。

---

## 5. 第三层：不信任本机时钟

这是整个项目里**最容易被忽略、但一旦错了就全盘皆输**的一环。

抢场这件事的全部逻辑都建立在「现在几点」上：
08:00 开闸，那么程序必须在 07:59:59.8 左右开始冲刺。
如果本机时钟快了 30 秒，冲刺开始的时候场地还没放出来，
等场地放出来时程序已经跑完一轮在睡觉了；
如果慢了 30 秒，那从第一毫秒就输在起跑线上。

而现实是：笔记本休眠后时钟会飘、软路由上根本没有 RTC 电池、
时区设置还可能搞错（很多路由器的默认时区不是 UTC+8）。

**所以做法是：完全不信任本机时钟，改用服务端时间。**

`src/util.js:109` 的 `ServerClock` 只有三个要点：

```js
class ServerClock {
  calibrate(serverTime, t0, t1) {
    const parsed = this._parse(serverTime);
    const localMid = (t0 + t1) / 2;      // ① 用请求往返的中点，抵消一半网络延迟
    const offset = parsed - localMid;
    this.samples.push({ offset, rtt: t1 - t0 });
    this.samples.sort((a, b) => a.rtt - b.rtt);  // ② 只信 RTT 最小的那次采样
    if (this.samples.length > 5) this.samples.length = 5;
    this.offset = this.samples[0].offset;        // ③ 抖动大的采样直接扔掉
  }
  now() { return Date.now() + this.offset; }     // 之后的「现在」都用这个
}
```

三个设计点，每个都有理由：

1. **取往返中点**：请求去和回各花一半时间，用中点估算可以把误差减半。
2. **多次采样取 RTT 最小**：网络抖动大的那次，offset 一定不准。
   宁可多测几次，只信最干净的那次。
3. **之后所有时间判断都走 `clock.now()`**：一旦有人不小心写了 `Date.now()`，
   就等于绕过了校准。所以代码里对 `Date.now()` 的使用是刻意的、可数的。

### 5.1 一个被时区坑过的函数

`src/util.js:67` 的 `parseServerTs()` 里藏着一个注释：

```js
/**
 * ★ 把服务端时间戳（如 "2026-10-10 16:09:54"）当**服务器本地时间**解析。
 *
 * 关键：不能用 Date.parse("2026-10-10 16:09:54") —— 那会按**本机时区**解释。
 * 若机器时区不是 Asia/Shanghai，算出的 offset 会整体偏几个小时，
 * 于是「08:00 放场」会被算错。
 */
const SERVER_TZ_OFFSET_MIN = 8 * 60;
```

这是真踩过的坑：把电脑时区改成别的值之后，
程序算出来的 offset 一下子偏了 8 小时，所有时间判断全错。
修法是不用 `Date.parse`，而是自己用 `Date.UTC(...)` 拼，
再减去硬编码的服务端时区偏移。

> **经验**：「时间」是最容易产生隐蔽 bug 的领域。
> 一旦涉及第二个时钟（服务器、数据库、另一台机器），
> 就必须明确「谁的时间是权威的」，并且**只在一处**做转换。

---

## 6. 第四层：把「想抢什么」翻译成候选方案

### 6.1 问题：用户想要的是「晚上六点以后，最好是 2 小时连场」

但接口能提交的是「某一天 + 某个时段 + 某一片场地」这么一个三元组。
中间的落差由 `src/target.js` 填。

```
服务端网格（原始）          解析             筛选/排序          组合
┌──────────────────┐   ┌──────────────┐   ┌──────────┐   ┌──────────────┐
│ 场地1 08:00 可订   │   │ slots[]      │   │ rankSlots│   │ targets[]    │
│ 场地1 09:00 可订   │──▶│ courts[]     │──▶│ 偏好命中  │──▶│ 候选提交方案  │
│ 场地2 18:00 已满   │   │ slotCourtMap │   │ 课表避让  │   │ + 优先级      │
│ ...              │   └──────────────┘   └──────────┘   └──────────────┘
└──────────────────┘
```

对应到代码：

```js
// src/target.js
function parseNodeAppointGrid(raw, opts = {}) { /* 原始 JSON → {slots, courts, slotCourtMap} */ }
function extractCourts(nodeAppointData)          { /* 抽出场地列表 */ }
function rankSlots(slotValues, target)           { /* 按时段偏好打分排序 */ }
function findContiguousCombos(ranked, target, needLen, maxSlots) { /* 找「连着的 N 个时段」 */ }
function buildTargetsFromGrid(p)                 { /* 上面几步串起来，产出候选方案 */ }
```

### 6.2 为什么要有「课表避让」这层

原始需求是「不要和我上课的时间冲突」。
最直接的实现是：把上课时间写成黑名单，命中的时段直接删掉。

但现实是：**课程时间偶尔会调**，而且有些课「能翘」、有些「不能翘」。
所以最终实现是**分级**的，而不是一刀切：

```js
// src/grab.js
function scheduleEnabled(cfg) { /* 课表避让总开关 */ }
function subtractIntervals(aStart, aEnd, blocks) { /* 从一个区间里挖掉若干黑名单区间 */ }
```

命中课表的候选**不会被删掉**，而是被**降到列表末尾**。
好处是：万一那天课调了、场地又特别紧张，
程序仍然会把「虽然跟课冲突但至少能抢到」的选项试一遍，
而不是空手而归。

> **经验**：把用户的「不要 X」硬实现成「删掉 X」，
> 往往会在极端情况下让他一无所获。
> 降级 + 排序通常比硬过滤更符合真实意图。

### 6.3 候选方案为什么必须排序

因为 08:00 那一刻的提交机会是**有限**的（熔断上限默认 6~8 次）。
候选方案如果没排序，就等于随机撒网。
`buildTargets()` 产出的列表是**严格按优先级**排的：

1. 命中显式偏好（周几 + 钟点）的，排在前面；
2. 其中「时长最长」「场地最连续」的再往前；
3. 撞课的沉到底部；
4. 同一时段的多片场地视为**等价**，不重复占额度（这一条是后来补的，见第 11 节）。

### 6.4 「临时只要某个时段」：一个入口、两处开关

用户的原始需求只是「偏好 18:00-20:00」，所以最开始时段选择只有一个入口：
`config.yaml` 的 `target.hourPriority`。
但用着用着就会想要「今天就想 20:00-22:00，别的时候不要」——
改配置文件太笨重（改完还得改回来），于是加了命令行：

```bash
node src/grab.js --rel 2 --window 20:00-22:00
```

看起来只是「把偏好换个地方写」，实际上**必须同时动两个地方**，否则会产生一个很危险的错误行为：

```js
// src/grab.js  buildTargets()
const strictWindow = !!(this.opts && this.opts.windows && this.opts.windows.length);
//                    ↑ 开关一：把你给的几段当成唯一的优先级
const fallbackRange = strictWindow ? null : this._fallbackRange(g.dateFields, day);
//                    ↑ 开关二：把「偏好落空就兜底到当天任意空档」关掉
```

第二个开关才是关键。原来的设计里，`hourPriority` 只是**排序偏好**，
后面永远跟着一个「实在不行，当天任何空档都可以」的兜底档（就是 6.3 里说的「不是硬墙」）。
这个兜底在「你想早点抢到、时段无所谓」时是善意，
但在「我今天必须 20:00 之后」时就是灾难 —— 程序会愉快地给你订早上 08:00 的场，
然后你可能到付完钱才发现。

> **经验**：**「偏好」和「约束」是两个东西，不要用同一个字段表达。**
> 如果用户显式说了「只要这一段」，那就必须把兜底也一起关掉；
> 只改排序、不关兜底，是这类需求最容易漏的一半。

顺带解决第二个问题：**最少订几小时。**

平台的计价单位是「小时（时段）」，一张单要求至少 `minSlots` 个连续时段
（配置默认 2，也就是 2 小时）。你要是给一个 2 小时的窗口 `18:00-20:00`，没问题；
但给 `18:00-19:00` 就永远凑不满 2 个时段 —— 程序会一轮轮找到候选、又在一张单里装不下，
表现成「有候选却永远下不了单」。

所以窗口其实同时决定了 `minSlots`：

```js
// src/config.js  applyWindowOverrides()
const shortestHours = Math.min(...wins.map((w) => (w.to - w.from) / 60));
let minSlots = Math.max(1, Math.min(cfg.target.minSlots || 1, maxSlots, Math.floor(shortestHours)));
```

窗口多长，就按多长算（但不超过 `maxSlots`，默认 2）。
`--slots N` 是给这个自动值再加一道人工上限，并且**装不进窗口就直接报错退出**（退出码 2），
而不是悄悄忽略 —— 静默忽略用户参数是比报错更糟的选择。

还有一个实现细节值得抄走：**这些覆盖只发生在内存里**。
`applyWindowOverrides(config, cli.opts)` 直接改传进去的对象，从不写回 `config.yaml`。
否则你临时试一次 `--window`，第二天定时任务就会莫名其妙只抢那一段，
而你已经忘了这件事。

```js
// src/config.js
function parseWindowSpec(spec) { /* 返回 {from,to,raw} 或 null；绝不抛异常 */ }
function applyWindowOverrides(cfg, opts) { /* 返回 {windows,minSlots,strict} 或 null */ }
```

解析失败返回 `null`（而不是抛异常）是为了让「写错了」和「没写」在调用点能区分开：
`grab.js` 里写错就 `console.error` + `exit 2`，没写就照旧走配置里的偏好。

---

### 6.5 优先级 vs 约束：`--priority` 和 `--window` 只差一个单词，行为差一整晚

`config.yaml` 里的 `target.hourPriority` 是**偏好**：按顺序试，全都没场时**允许**退到当天其它空档
（`src/target.js` 里那个 `fallbackRange`）。但用户有时要的是**约束**：「我今晚只能 18:00-20:00，
别的时段抢到了我也去不了。」这两种需求不能用同一个参数表达，所以命令行上是两个：

| 参数 | 语义 | 兜底 |
| --- | --- | --- |
| `--priority 16:00-18:00,17:00-19:00` | 偏好：按顺序试 | **保留**（都不行就抢别的） |
| `--window 18:00-20:00` | 约束：只在这段里 | **关闭**（`fallbackRange = null`） |

实现上只有一行是真正的开关（`src/grab.js` 的 `buildTargets()`）：

```js
const strictWindow = !!(this.opts && this.opts.windows && this.opts.windows.length);
const fallbackRange = strictWindow ? null : this._fallbackRange(g.dateFields, day);
```

两个都给时 `--window` 赢（约束覆盖偏好）—— 先试 `applyWindowOverrides()`，它返回 `null` 才轮到
`applyPriorityOverrides()`。这两个函数都**只改内存里的 config，绝不写回 `config.yaml`**：
「今晚临时改主意」不该留下持久副作用。

### 6.6 ★ 「排序」不是「过滤」：一个让 `--court` 静默失效的坑

请求是「我点名要 1 号场地」。第一版实现是：

```js
config.target.courtPriority = [String(cli.opts.court)];
config.target.sameCourt = true;
```

看起来对，实际上**完全没用**，因为 `courtPriority` 在 `src/target.js` 里只参与**排序**：
它把点名的场地排到前面，但候选里仍然有别的场地 —— 一旦前面几个方案都失败，它就会「帮你买另一片」。
线上实测（`buy.sh --court <1 号场地>`）打印的是「匹配出 4 个候选方案」并列出场地 1/3/4。

真正的过滤只有一处：

```js
// src/target.js（buildTargetsFromGrid）
const onlyId = onlyCourt == null ? '' : String(onlyCourt);
const courts = onlyId ? courtsIn.filter((c) => String(c && c.id) === onlyId) : courtsIn;
```

而且修完 `target.js` 还不够：`buildTargets()` 读的是 `this.opts.court`，所以 `main()` 构造 Grabber 时
**必须把 `court` 放进 opts**，只设 `config.target.courtPriority` 是白费力气：

```js
// src/grab.js（main）
windows: winInfo ? winInfo.windows : null,
court: cli.opts.court ? String(cli.opts.court) : null,   // ← 少了这行，过滤永远不生效
```

> 可迁移的经验：**任何「用户显式指定了某个东西」的需求，都要问一句「我这个赋值是过滤还是排序？」**
> 排序的意思永远是「更喜欢它」，不是「只要它」。这类 bug 不会崩，只会安静地做错事。
### 6.7 把用户偏好存在哪：`data/` 而不是回写 `config.yaml`

「明天有课，想改抢场顺序」这种需求，最自然的实现是改 `config.yaml`。我们**故意不这么做**，
而是存到 `data/priority.txt`（一行一段，顺序即优先级）和 `data/timed.txt`
（第一行 `priority` 或 `window 18:00-20:00`），理由有三个：

1. **`config.yaml` 是带大段注释的手写文件**，用程序回写会把注释和顺序搞乱（或者直接写坏，那一晚会抢不到）；
2. 偏好是**用户状态**，配置是**部署状态**，两者变了以后该由谁负责恢复是不同的；
3. 一个「一行一段」的纯文本，出问题时光看 `cat` 就能知道现状，也能用 `vi` 手改。

对应代码在 `tools/state.js`（只读写这两个 txt，命令有 `show / prio-set / prio-reorder / prio-clear /
timed-set / timed-clear`），而计划任务每天 07:45 拉起的 `src/once.js` 负责把它翻译成命令行参数：

```js
// once.js 读 data/timed.txt 的第一行
if (/^priority/.test(mode)) args.push('--priority', prio);   // 偏好：都抢不到还能抢别的
if (/^window /.test(mode))  args.push('--window', window);   // 约束：只抢这一段
```

> 结论：**配置管「程序怎么跑」，data/ 管「用户这次想要什么」。** 混在一起，就是给未来的自己挖坑。
## 7. 第五层：08:00 那一刻发生了什么

`src/grab.js` 是整个项目的主干（1800 多行），但它的骨架其实很简单：

```
main()                                   ← 解析命令行、加载配置、建 Grabber、run()
  └─ Grabber.run()
       ├─ ensureAuth()                   ← 确认 token 有效，必要时续期
       ├─ loadCourts()                   ← 拉一次场地列表
       ├─ buildTargets()                 ← 生成候选方案
       ├─ waitForRelease()               ← 等到「放场时刻」
       │    └─ _idleWaitForRelease()     ←   还没放场时的「候场」循环
       └─ burst()                        ← 放场后的「冲刺」循环
            └─ tryOne(t, round)
                 └─ _submitOne(part, round)   ← 真正提交一次
                      └─ _lockOrder(order)    ← 成功后把订单号记下来
                      └─ settle()             ← 交给 AutoPay 付款
```

### 7.1 为什么要分成「候场」和「冲刺」两段

因为它们的目标完全相反：

| 阶段 | 目标 | 间隔 | 代价 |
| --- | --- | --- | --- |
| 候场（`_idleWaitForRelease`） | 别浪费请求，安静地等 | `idlePollMs` 默认 15 秒 | 发现放场最多晚 15 秒 |
| 冲刺（`burst`） | 抢在所有人前面 | `burstPollMs` 默认 120 毫秒 | 一次运行几百次请求 |

如果全程用 120ms 轮询，任务会像一个 DDoS 工具，
而且大概率在你还没到 08:00 的时候就被服务端限流了。
如果全程 15 秒，那开场那一刻你什么都抢不到。

**所以真正的技术活是：怎么准确知道「现在该从候场切到冲刺了」。**

这里的判断逻辑在 `_gateOpen()` / `_gateReason()` / `_gateClosedReason()`
（`src/grab.js:466` 起）和 `_resolveReleaseAt()`（`:552`）。
它综合了三条线索：

1. **时间线索**：配置里有个 `fallbackTriggerTime`（默认 `08:00:00`），
   这是「学校通常几点放场」的经验值；
2. **数据线索**：网格接口里如果**目标日期出现了新的可订时段**，
   说明已经放场了 —— 这比时间更权威；
3. **提前量**：`leadMs`（默认 1200ms）让程序比整点稍早一点进入冲刺状态，
   把网络往返的时间算进去。

> **经验**：**不要只依赖一个信号源**。
> 时间信号可能因为时钟/时区/学校临时改点而失效，
> 数据信号可能因为接口缓存而迟到。
> 两个信号「或」起来，再把提前量显式做成参数，系统就稳得多。

### 7.2 冲刺循环里那些看起来啰嗦的判断

`burst()`（`src/grab.js:1242`）里有这么几处，每一处都对应一次真实事故：

```js
// ① 熔断额度到顶 → 立刻结束，不要空转
if (this._breakerTripped) {
  this.log.warn('下单熔断额度已到顶，且本轮没有抢到任何场地 → 结束冲刺（不再空转）');
  return false;
}

// ② 服务端明确拒绝（比如「每天最多 1 个场地」）→ 本轮不可能再成
if (this._permanentReject) {
  this.log.warn(`服务端明确拒绝（${this._permanentReject}）→ 本轮不可能再成，结束冲刺（不再空转）`);
  return false;
}

// ③ 预演模式：现在没空位就立刻收手，不要等到 1500 轮跑完
if (this.opts.dryRun) {
  this.log.info('预演模式：当前没有匹配到任何候选方案 → 立即收手（预演不等待空位）');
  return false;
}

// ④ 同一时段已经试过一片场地了，就别再试第二片
const sig = mine.join('+');
if (sig && trySig.has(sig)) {
  this.log.info(`  跳过：${sig} 这一轮已经试过了（同一时段的另一片场地不再重复提交）`);
  continue;
}
```

第 ④ 条特别值得说：候选表里「13:00-14:00 × 6 片场地」是 6 条**等价**候选。
最早的时候程序会老老实实把 6 条都提交一遍 ——
**一次抢场就烧掉 6 次下单配额**，而且 6 次里 5 次注定被服务端拒绝。
这就是为什么后来加了「每轮的 `trySig` 集合」。

> **经验**：**「等价候选」和「不同候选」必须分开对待。**
> 幂等去重（同一件事只做一次）和重试（同一件事可以再试）是两回事，
> 混淆它们会同时浪费配额和掩盖真实失败。

### 7.2.1 「不许空转」要写在每一段循环里，不是只写在冲刺里

上面 ①②③ 三条闸门都在 `burst()` 里，因为那里是请求最密集的地方。
但线上还发生过一次更隐蔽的卡死：**预演根本不进 `burst()`**。

`waitForRelease()` 的逻辑是「目标日期的场还没放出来 → 每 15 秒复查一次，直到放场」。
这在真跑时完全正确（你要等 08:00 才能抢），
可在预演时就是灾难：你在晚上 8 点跑 `--dry-run --window 18:00-20:00`，
目标日期（T+2）还没放场，于是程序安静地每 15 秒问一次服务器，
**一路等到第二天早上 8 点**。菜单上看起来就是「卡住不动」。

```js
// src/grab.js  waitForRelease()
if (this.opts.now || this.opts.poll) return;
if (this.opts.dryRun) {
  this.log.info('预演模式：目标日期现在还不能下单（多半是还没到放场时刻）→ 立即收手，不等待放场');
  return;
}
```

> **经验**：**给「长时间循环」写退出条件时，要问自己「这个循环在每种模式下的终止条件分别是什么」。**
> 真跑的终止条件很明确（抢到 / 时间到 / 被拒）；
> 预演的终止条件是「我现在就能给你一个结论」——
> 因为它只是演示，没有任何理由等到明天。

这条修复在门禁测试里对应一个专门的场景（`tools/gate-integration.js` 的场景 L）：
断言 `waitForRelease()` 在预演 + 未放场时**两秒内返回**，并且日志里出现这句话。
这类「不许挂住」的断言最好带**时间上限**，
否则测试本身会跟着一起挂住 —— 那就等于没有测试。

### 7.2.2 「帮买」模式：用户在看着，就别等

自动抢场的世界观是「现在没有？那就等到放场，一直等到能下单为止」—— 所以 `waitForRelease()` 会
每 15 秒复查一次，直到第二天早上。这在无人值守时是对的。

但「用户在菜单里挑了一场、按下确认」不是无人值守：**那一刻不能下单，就该立刻如实失败**，
否则用户看到的就是「按了个按钮，然后卡死一晚上」。所以有 `--no-wait`：

```js
// src/grab.js（waitForRelease）
if (this.opts.noWait) {
  this.log.info('帮买模式（--no-wait）：不等放场，现在就直接冲刺一次');
  return;
}
```

冲刺循环里也要同步放开「现在不能下单」那道闸门，否则它会在 `burst()` 里继续空转：

```js
if ((this.opts.now || this.opts.noWait) && !this._targetReady) {
  this.log.info('目标日期现在不能下单，本次不等（--now / --no-wait）');
  return false;
}
```

> 同一个函数，两种等待语义。**判断标准不是「这段代码原来怎么写」，而是「这次是谁在等结果」**：
> 没有人在看 → 等；有人在看 → 马上给结论。这就是为什么它必须是一个显式开关（`--no-wait`），
> 而不是靠猜。
### 7.3 `sleep` 的写法

```js
// src/util.js
function sleep(ms) { return new Promise((r) => setTimeout(r, Math.max(0, ms))); }
```

一行代码，但 `Math.max(0, ms)` 是必要的：
如果某次计算出的等待时间是负数（时钟回拨、校准修正），
`setTimeout` 传负数会按 0 处理（其实也能跑），
但**日志里会出现莫名其妙的负数**，看日志的人会怀疑人生。

---

## 8. 第六层：支付是另一条独立的链路

抢到了 ≠ 拿到场地。**下单接口只是创建了订单，订单有个支付窗口（实测约 5 分钟），
超时就作废。** 所以 `src/pay.js` 是整个项目里唯一「有副作用、
涉及钱」的部分，也是被改得最多的地方。

### 8.1 为什么支付单独一个模块、单独一套状态机

`AutoPay` 类（`src/pay.js:144`）有两个入口：

```js
async settle(locked, ctx)   { /* 完整跑一遍：选通道 → 下单支付 → 判定结果 */ }
async prepare(locked, ctx)  { /* 只做准备：查可用通道、查价格、判断需不需要密码 */ }
```

`settle()` 的骨架：

```
1. 查支付通道列表（getPaywayList）
2. pickAutoChannel() 选一条能自动走的通道
   └─ 需要卡密码的通道（channelNeedsPassword）会被跳过，除非配置里给了密码
3. 提交支付（openPlatFormPayOrder）
4. 判定结果：
   - success=true           → 成功，记下 payway / txamt / ordermo
   - 明确失败（密码错误等）  → 不重试，直接失败
   - 含糊失败（"支付请求失败"）→ ★ 重试一次（间隔 3 秒）
5. 无论成功失败，都把完整诊断信息（URL / 请求体 / 原始响应 / 每次尝试耗时）
   一起返回，写进结果标记
```

### 8.2 「只对无副作用错误重试」这条规则怎么落地

支付这件事不能无脑重试：**如果第一笔其实已经扣款成功了，
只是响应丢了，那么重试会造成二次扣款。**

所以重试条件被写得很保守（`src/pay.js` 的 `settle()`）：

```js
const retryable = attempt < MAX_ATTEMPTS &&
  !/密码|锁定|次数|余额|已支付|已失效|过期/.test(String(m));
```

意思是：只有当失败消息**不含**这些关键词时，才允许再试一次。
「卡密码错误」「余额不足」「订单已失效」这类都是**确定性失败**，重试毫无意义；
而「支付请求失败」这种含糊的兜底文案，才值得再试一次。

### 8.3 一个反直觉的实测结论

支付一直报含糊的 `{"success":false,"message":"支付请求失败","resultData":null}`，
查了很久才确认：**真正原因是我卡里没钱了。**

服务端把「余额不足」这种具体原因，兜底成了一句笼统的「支付请求失败」，
而且响应体里只有三个字段（`success` / `message` / `resultData`），
连个错误码都不给。前端 JS 里全量搜索也找不到这个字符串 ——
说明它是服务端内部抛出来的。

**这件事教会我的**：

- 排错时**先看原始响应体**，不要只看被抽象层加工过的 message
  （这就是后来加 `callRaw()` 和 `diag` 的原因）；
- 一个「重试之后结果完全一样」的失败，几乎可以断定是**确定性原因**，
  继续加大重试力度是浪费；
- 有些问题**只能靠人肉验证**：最一锤定音的检查就是「自己手动付一单试试」。

### 8.4 为什么要把诊断信息留在结果文件里

```js
// src/pay.js 的 settle() 返回结构（简化）
{ ok: false,
  diag: { url, payload, raw, attempts: [{ ms, raw }] } }
```

`src/grab.js` 的 `writeMarker()` 会把 `payDiag` 一起写进
`data/last-result.json`，`report()` 还会把它再打到日志尾部。

理由：支付失败时，**人是要睡觉的**。
第二天早上你看到的是一个已经结束的进程，
唯一能告诉你「昨晚到底发生了什么」的，
就是那个结果文件和日志。所以关键证据必须在**失败的那一刻**就落盘，
而不是等你事后去复现（复现时订单早就过期了）。

---

## 9. 横切关注点：日志、通知、结果文件

### 9.1 日志：为什么要自己写一个 `Logger`

`src/log.js` 只有 70 行：

```js
class Logger {
  constructor(opts = {}) { /* 同时输出到控制台和 logs/run-YYYYMMDD-HHMMSS.log */ }
  _write(level, args) { /* 加时间戳与级别前缀 */ }
  debug / info / warn / error(...)
  section(title) { /* 分隔线，让长日志里有可读的段落 */ }
}
```

不用 `console.log` 的原因：

- 需要**同时**写文件和控制台（`once.js` 会用子进程跑，`stdio` 得处理）；
- 需要一个「这次运行的日志文件路径」，好在结束时打印出来；
- `section()` 这种纯人读的分隔，能让 2000 行日志变得可扫。

> **经验**：日志不是「出了事再打开」，而是**给未来的自己写的报告**。
> 每一行都要能回答「谁、什么时候、为什么这样做」。

### 9.2 通知：为什么默认是关的

`src/notify.js` 实现了一个极简的 webhook POST。
配置里 `pay.notify.webhookUrl` 默认是**空字符串**（= 不通知）。

原因：这个通知的**唯一价值场景**是「抢到了但付款没成功」，
这时候它必须能把人从睡梦里叫醒（微信 / 钉钉 / Bark 之类的推送）。
普通的成功提示反而是噪音。既然默认没有配置推送通道，
那就干脆默认关闭，而不是发一封没人看的邮件。

### 9.3 结果文件：一个刻意设计成「机器可读 + 人可读」的产物

`src/grab.js:1835` 附近的 `writeMarker()` 会写两份：

```js
const TMP_DIR = process.env.TMPDIR || process.env.TEMP || '/tmp';
// data/last-result.json  ← 项目的正式产物（软路由上的脚本会读它）
// TMP_DIR/blcu-last-result.json ← 固定路径的副本，方便别的脚本不用去找路径
```

标记文件里除了订单号、场地、时段、金额，
还有几条**面向人**的注释，比如：

```js
// ★ orders[i].court 存的是**场地名**（给人看的），场地 id 在 courtId。
//   这里顺带也写一份 courtName，免得看标记文件的人/脚本按字面意思去取错字段。
```

这条注释的来历很实在：曾经有脚本把「场地名」当参数传给了支付接口，
结果服务端报 `can not cast to long, value : 羽毛球场地1`。

> **经验**：**同名不同义的字段是 bug 的温床。**
> 既然不能改字段名（改了会破坏兼容），那就**在这个字段旁边写清楚它是什么**，
> 并且把两种含义都用明确的键名各存一份。

另外还有一个容易被忽略的设计：**预演（`--dry-run`）不写这个文件**。

```js
// writeMarker() 开头
if (marker.dryRun) {
  log.info('（dry-run，不覆盖 data/last-result.json）');
  return;
}
```

因为曾经发生过：下午想试试链路通不通，跑了一次预演，
结果把**早上真实抢到的那条 `SUCCESS` 记录冲掉了**，
第二天看历史记录时一脸茫然。

判断「这次是不是预演」的代码也改过一次：

```js
// 早期（有 bug）：满场没抢到时 orders 是空数组 → 算出来 false → 照样覆盖
const anyDry = orders.length > 0 && realOrders.length === 0;

// 现在：
const anyDry = !!(g.opts && g.opts.dryRun) || (orders.length > 0 && realOrders.length === 0);
```

> **经验**：**「因为没数据所以判断不出来」的情况，必须显式当成一种情况处理。**
> `orders.length > 0 &&` 这种前置条件，会在最需要它生效的时候（什么都抢到）失效。

---

## 10. 怎么确认它真的没坏：自检与门禁测试

这个项目没有「单元测试框架」，但有两层自检，
加起来 1000 多行，`npm` 脚本里就能跑：

```bash
node src/selftest.js --offline     # 离线自检：不联网，验证纯函数与协议编解码
node src/selftest.js               # 联网自检：真的去调一次接口，验证账号和契约
node tools/gate-integration.js     # 门禁集成：注入假客户端，跑完整的抢场状态机
```

### 10.1 `src/selftest.js`：用 `assert` 硬堆

里面全都是这种测试：

```js
assert.strictEqual(parseSlot('08:00-09:00').startMin, 8 * 60);
assert.strictEqual(fmtServerDate(t), '2026-10-12');
```

为什么不上 `jest` / `mocha`：因为整个项目的卖点之一是
「**装上 Node 就能跑，不需要 `npm install`**」。
引入测试框架就破坏了这一点。而 Node 内置的 `assert` 已经够用了 ——
一个 assert 抛出异常，脚本退出码就是 1，CI 也认。

### 10.2 `tools/gate-integration.js`：把「抢场」整条状态机跑一遍

这个更有意思。它构造一个**假的 `ApiClient`**（记录所有调用、返回可控的数据），
注入给 `Grabber`，然后跑真实的 `burst()` 逻辑，断言：

- 到底提交了几次下单请求（`counter.reservations`）；
- 网格接口被查了几次（`counter.gridCalls`）；
- 熔断被触发后有没有停下来；
- 永久性拒绝有没有被正确识别；
- 预演模式在满场时有没有立刻收手。

比如「场景 J」：

```js
// 满场网格 + dryRun → 必须立刻返回 false，只查一次网格，一次都不提交
assert.strictEqual(ok, false);
assert.strictEqual(counter.gridCalls, 1);
assert.strictEqual(counter.reservations, 0);
assert.ok(lines.some((l) => l.includes('预演不等待空位')));
```

### 10.3 更重要的一步：**注入验证**（证明测试真的在测东西）

写完测试有个经典的自我欺骗：**测试通过了，但它其实什么都没测**
（比如断言条件写反了，或者被测代码根本没走到）。

所以改完关键逻辑之后，会做一次「注入验证」：

1. 用脚本**临时把补丁摘掉**（把源码改回打补丁之前的样子）；
2. 跑测试，**期望它失败**（如果还是全绿，说明测试是假的）；
3. 把源码还原，再跑一次，**期望它全绿**。

这一步抓到过真问题：有一次摘掉补丁后测试仍然通过，
说明那条断言根本覆盖不到改动的分支。

> **经验**：**「测试通过」不是证据，「摘掉代码后测试失败」才是证据。**
> 这就是变异测试（mutation testing）的核心思想，
> 手动做一个最小版本，成本很低，收益极大。

---

## 11. 打了七次的补丁：每一轮线上事故教了我们什么

这一节是全篇最有价值的部分 —— 因为这些教训**不是想出来的，是被打出来的**。

### 事故一：跑到天亮还在空转（约 12 分钟 × 5 次）

**现象**：某天手动跑了一次，12 分钟里日志刷了 161 条
`提交异常：已达下单请求熔断上限（6 次），本次运行不再提交预约`，
进程还得手工 kill。

**根因**：熔断是**抛异常**实现的，而当时的冲刺循环对「抛异常」的处理是
「记一笔日志，继续下一轮」。于是：
预算烧光 → 每轮都抛熔断异常 → 每轮都记一笔 → 睡 120ms → 再来一次……
默认 `maxRounds = 1500`，一轮 120ms，理论上能空转 3 分钟；
配置里覆盖成 1500 之后，实际能转十几分钟。

**修法**：给 `Grabber` 加一个 `_breakerTripped` 标志，
在 `_submitOne()` 的 catch 里识别「熔断上限」这几个字，
内层循环开头 `if (this._breakerTripped) break;`，
外层在 sleep 之前 `return false`。

> **教训**：**「可恢复错误」和「不可恢复错误」必须显式区分。**
> 把「预算烧光」当成「这次运气不好，下轮再来」，
> 结果就是拿不到结果的无限循环。
> 判断标准：**如果重试的前提条件已经不存在了，就不该重试。**

### 事故二：一次抢场提交 36 次

**现象**：日志显示 `reservations=36`，而熔断上限只有 6~8。

**根因**：候选表里「13:00-14:00 × 6 片场地」是 6 条候选，
程序挨个提交；4 轮下来就是 24~36 次。

**修法**：每轮维护一个 `trySig` 集合，
把「时段组合」当签名；同一轮里同一个签名只提交一次。

> **教训**：**先做去重，再做重试。**
> 一个稳定的「同一件事」标识（这里是 `mine.join('+')`），
> 能让「等价候选」自动坍缩成一个。

### 事故三：预演把真实结果文件冲掉了

**现象**：下午跑了一次 `--dry-run`，早上那条
「抢到 130xxx，支付成功」的记录变成了 `FAILED`。

**根因**：`writeMarker()` 无条件写文件，
而「预演」和「真跑」走的是同一个写入路径。

**修法**（三层，缺一不可）：

1. `writeMarker()` 开头判断 `marker.dryRun` 直接 return；
2. 外层脚本（软路由的 `go.sh`）在预演前**备份**结果文件，
   跑完还原 —— 双保险；
3. 加一个 `tools/rebuild-marker.js`，
   万一标记被冲了，可以用订单号回服务端查权威数据重建。

> **教训**：**「只读操作」在实现上很容易变成写操作。**
> 预演模式的正确语义是「除了日志，什么都不留下」。

### 事故四：SSH 断开后进程还在跑

**现象**：`ps` 里发现两条
`node src/grab.js --rel 1 --dry-run`，
各烧了 257 分钟 CPU。

**根因**：SSH 断开**不会杀掉远端进程**，
而预演模式当时会在满场时一直等到 `maxRounds` 跑完。

**修法**：预演模式在「当前没有任何候选」时立刻收手：

```js
if (this.opts.dryRun) {
  this.log.info('预演模式：当前没有匹配到任何候选方案 → 立即收手（预演不等待空位）');
  return false;
}
```

外加一个 `deploy/kill-strays.sh` 用来清场。

> **教训**：**远程执行要对「我没有在看着它」这件事负责。**
> 任何可能长跑的循环，都要有一个「不值得再等」的出口。

### 事故五：生成了带个人信息的开源版本

**现象**：为开源版写的构建脚本 `tools/make-release.js`，
生成出来的 `src/grab.js` 语法直接崩：`SyntaxError: Unexpected identifier 'fs'`。
而且文件体积从 91329 字节涨到 91618 字节，
第 1800 行附近**凭空多出一整份文件头部**。

**根因**（这个坑非常隐蔽）：

```js
// 替换串里出现了 $' 这两个字符
text.replace(/const TMP_DIR = '\/tmp';/g,
  "const TMP_DIR = process.env.TMPDIR || process.env.TEMP || '/tmp';");
```

JavaScript 的 `String.prototype.replace` 在**替换串**里认三种特殊模式：

| 写法 | 含义 |
| --- | --- |
| `$&` | 匹配到的内容本身 |
| `` $` `` | 匹配点**之前**的全文 |
| `$'` | 匹配点**之后**的全文 |
| `$1` | 第 1 个捕获组 |

而上面的替换串里恰好有 `'/tmp'` —— 其中的 `$'` 被解释成
「把匹配点之后的全文插进来」，于是整个文件尾部被复制粘贴进头部。

**修法**：彻底放弃「替换串」形式，改用 `indexOf` + `slice` 手工拼接：

```js
function replaceAllLiteral(text, find, repl) {
  if (!find) return { text, n: 0 };
  let n = 0, out = '', i = 0;
  for (;;) {
    const at = text.indexOf(find, i);
    if (at < 0) break;
    out += text.slice(i, at) + repl;
    i = at + find.length;
    n++;
  }
  return { text: out + text.slice(i), n };
}
```

正则那一路也统一改成函数形式 `out.replace(re, () => repl)` ——
**函数返回值不会被当成替换模式解析**。

> **教训**：**任何「文本生成文本」的代码，都必须假设自己会被 `$` 咬一口。**
> 顺便：这个项目后来给产物加了一道「用 `vm.Script` 解析一遍」的语法自检，
> 正是它第一时间抓住了这个 bug。

### 事故六：菜单一按就「卡死」（其实是两个 bug 叠在一起）

**现象**：新加的菜单项「预演一个时间段」按下去之后，控制台十几分钟不返回，
看着像死循环。最后只能人工杀进程。

**真因一：`Read-Host` 在输入流结束（EOF）时返回 `$null`。**

```powershell
$raw = (Read-Host $T.winAsk).Trim()
```

非交互运行（`cmd /c "qiangchang.bat < input.txt"`、CI、管道）时，输入读完就是 `$null`，
对 `$null` 调 `.Trim()` 抛异常；而菜单是 `while` 循环，
异常被 PowerShell 吞掉后立刻又读一次 —— 于是**每轮打一遍报错，无限刷屏**。
一屏一屏地滚，人眼看起来就是「卡住了」。

**修法**：所有读输入的地方统一走一个小函数，把「读不到」当正常情况处理：

```powershell
function Read-Line([string]$Prompt) {
  $line = Read-Host $Prompt
  if ($null -eq $line) { $script:Eof = $true; return $null }
  return $line
}
```

主循环里 `if ($null -eq $line) { Write-Host $T.eofBye; break }`。

**真因二：预演会挂进「候场」循环**（见 7.2.1 节）。
两个 bug 叠在一起，才造成「看起来彻底卡死」：一个是假的卡住（刷屏），一个是真的卡住（等到明天）。

> **教训**：**交互式脚本必须能在「没有人」的情况下正常收场。**
> 只要有 `Read-Host` / `input()` / `scanf`，就要问：输入读完了会怎样？
> 报错刷屏和死等，是同一类问题的两种表现：**没有终止条件**。

---

### 事故七：测试脚本自己把源码改坏了（而且还改错了一行）

「注入验证」是这套代码里最有效的防线，但它本身也会出事 —— 而且是**在没人看的时候**安静地把源码改坏。

第一版脚本长这样：

```js
try {
  fs.writeFileSync(file, broken);   // 故意改坏，看测试会不会变红
  const rc = runGate();
  if (rc === 0) { console.error('测试没变红'); process.exit(1); }
} finally {
  fs.writeFileSync(file, original); // 还原
}
```

问题在 **`process.exit()` 会跳过 `finally`**：一旦「测试没变红」这个分支真的发生，进程立刻退出，
还原代码那一行**永远不执行** —— 磁盘上留下的是被故意改坏的源码。当天两次、两个文件（`src/grab.js`
少了 `court:` 那一行、`src/target.js` 被换成只排序不过滤），线上都跟着退化，而且**测试是绿的**。

第二层坑在修复时：为了还原 `src/target.js`，我用「行首前缀」定位那一行：

```js
const i = lines.findIndex((l) => l.startsWith('  const courts = '));
```

同一个文件里 `parseNodeAppointGrid()` 里也有一行 `  const courts = [];`，**它排在前面**，
于是改错了函数。正确做法是先定位函数再在函数体内找：

```js
const at = lines.findIndex((l) => l.startsWith('function buildTargetsFromGrid('));
const i = lines.findIndex((l, k) => k > at && l.startsWith('  const courts = onlyId'));
```

最终形态（`tools/verify-court-patch.js`）：`GOOD` 一行、`BAD` 一行，先在函数体内定位 `GOOD`，
跑门禁应为 0；换成 `BAD`，门禁必须非 0；`finally` 还原并**打印字节数比对**；
而且**全程不用 `process.exit()`**，只用 `process.exitCode = ok ? 0 : 1`。

> 三条可迁移的经验：
> ① **`process.exit()` 不是「提前返回」**，它连 `finally` 和未 flush 的写操作一起跳过；
> ② **「按前缀找行」在同一个文件里找第二次就会找错**，先定位作用域再定位行；
> ③ 凡是要**改真实源码**的测试工具，收尾一定要有一句「内容与我改之前逐字节一致」的自证。
## 12. 跨平台：为什么脚本比代码更难写

代码部分其实是跨平台的（Node 屏蔽了大部分差异），
真正难的是**周边脚本**。踩过的坑按痛苦程度排序：

### 12.1 中文 `.bat` 的编码地狱

Windows 的 `cmd.exe` 解析 `.bat` 时用的是**系统 ANSI 代码页（中文系统上是 GBK）**，
不是 UTF-8。所以：

- 一个 UTF-8 保存的 `.bat`，里面的中文会被当成乱码字节当命令执行，
  报 `'今天' is not recognized as an internal or external command`；
- 更隐蔽的：某些字节组合会让 `cmd` **丢掉换行符**，
  于是两行命令粘成一行，出现 `'HOICE"=="3" goto doGo'` 这种
  「半个变量名被当命令」的诡异报错。

**最终方案：三层拆分，让 `cmd.exe` 永远只解析纯 ASCII。**

| 文件 | 编码 | 职责 |
| --- | --- | --- |
| `qiangchang.bat` | 纯 ASCII + CRLF | 只做三件事：切目录、找 PowerShell、调用 ps1 |
| `qiangchang-menu.ps1` | UTF-8 **带 BOM** + CRLF | 真正的菜单界面（中文在这里） |
| `qiangchang-menu.text.json` | UTF-8 无 BOM | 所有中文文案（改文案不用碰代码） |

> 为什么 `.ps1` **必须带 BOM**？
> 因为 Windows PowerShell 5.1 读**没有 BOM** 的 `.ps1` 时会按 ANSI 解码，
> 里面的中文全会乱掉并且直接语法报错。
> 这条规则和 `.bat` 的规则**正好相反**，非常反直觉。

而且这些文件**不能用普通的文本编辑器工具改**，
所有中文文案都集中在一个生成器里（`tools/build-menu.js`），
由它负责 CRLF 和 BOM，改文案 = 改生成器 + 重跑。

### 12.2 临时目录

```js
// 软路由（Linux）上可以写死：
fs.writeFileSync('/tmp/blcu-last-result.json', ...);

// 跨平台写法：
const TMP_DIR = process.env.TMPDIR || process.env.TEMP || '/tmp';
fs.writeFileSync(TMP_DIR + '/blcu-last-result.json', ...);
```

Windows 上没有 `/tmp`。这个改动看起来微不足道，
但它就是「电脑直跑版」能不能跑起来的门槛之一。

### 12.3 定时任务的两种世界观

| | Linux（软路由） | Windows |
| --- | --- | --- |
| 工具 | `crontab` | 任务计划程序 |
| 开关 | 注释/取消注释两行 | `Register-ScheduledTask` / `Unregister` |
| 省电 | 不需要考虑 | 必须设 `WakeToRun`，否则电脑睡眠时任务不会跑 |
| 错过补跑 | 不会 | `StartWhenAvailable` 可以 |

`deploy/schedule.ps1` 里值得注意的两点：

```powershell
$settings.WakeToRun = $true                       # 让电脑从睡眠里醒过来
$settings.StartWhenAvailable = $true              # 错过了就补跑
```

用 `New-ScheduledTaskAction/-Trigger/-SettingsSet` + `Register-ScheduledTask`
而不是 `schtasks /TR "..."`，是因为**命令行引号转义在大路径下极其难写对**，
而 cmdlet 收的是参数数组，不用拼字符串。

### 12.4 远程执行的三条铁律

在软路由上跑脚本，靠的是 `ssh`。踩出来的三条规则：

1. **`ssh` 断开不会杀掉远端进程** —— 要么用 `nohup`/`setsid` 明确后台化，
   要么保证脚本会在有限时间内自己结束；
2. **`$?` 会被中间命令冲掉** —— 要判断上一条命令的退出码，
   必须马上存进变量：`RC=$?`，然后再判断 `if [ "$RC" = "3" ]`；
3. **时间计算不要用 shell** —— 跨时区的日期加减在 `date` 上到处是坑，
   把它交给 Node 的三行代码，反而更清楚：

```js
const today = new Date(Date.now() + 8 * 3600 * 1000);
const rel = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + REL));
const target = rel.toISOString().slice(0, 10);
```

（注意这里 `+8h` 之后再取 `getUTC*`，
是在「把北京时间当作世界的 UTC」来做日期加减 —— 对日期级别的运算足够，
且不受本机时区影响。）

---

## 13. 如果让我重写一遍

如果现在从零开始，这几件事我会换做法：

1. **一开始就把「结果文件」设计成有版本的 JSON**
   （加个 `schema: 1` 字段）。现在外部脚本读它靠的是约定，
   以后加字段就得小心不破坏别人。

2. **时间和日期处理单独抽一个模块，并且只允许它碰 `Date`。**
   现在 `util.js` 已经是这个角色，但早期散落在各处的
   `Date.now()` / `new Date()` 是后来才清理干净的。

3. **「预演」和「真跑」从入口就分成两条函数路径，而不是靠 `opts.dryRun` 分支。**
   分支写法很容易漏掉一处（结果文件被覆盖就是这么发生的），
   而两条独立路径不会。

4. **日志一开始就带上「请求序号」。**
   现在排查支付问题时，是靠在 `diag` 里额外塞 `attempts` 数组来还原顺序的。

5. **不要写 `tools/` 下那一百多个一次性脚本。**
   它们在当时非常有用（每一次接口探测都靠它们），
   但事后积累成一堆互不相关、没人敢删的文件。
   正确做法是每次探测完就把结论写进
   `tools/*-FINDINGS.md`，然后删掉脚本。

而且有一条**没变**的：**先想清楚「谁的时间是权威的」，
再写第一行代码。** 这个项目里 80% 的诡异 bug，
追到最后都跟时间有关。

---

## 附：按阅读顺序推荐的文件

如果你想顺着代码读一遍，建议这个顺序（由浅入深）：

| 顺序 | 文件 | 看什么 |
| --- | --- | --- |
| 1 | `src/util.js` | 时间处理的全部约定（最重要） |
| 2 | `src/config.js` | 配置怎么解析、默认值在哪 |
| 3 | `src/log.js` | 日志格式 |
| 4 | `src/client.js` | HTTP 封装、错误分类、限速与熔断 |
| 5 | `src/target.js` | 「想抢什么」→「候选方案」的翻译 |
| 6 | `src/login.js` | 登录态怎么来的（含两道安全闸门） |
| 7 | `src/pay.js` | 支付状态机（唯一涉及钱的模块） |
| 8 | `src/grab.js` | 主干：候场 → 冲刺 → 锁场 → 支付 |
| 9 | `tools/gate-integration.js` | 用假客户端把上面整条链路测一遍 |
| 10 | `src/selftest.js` | 纯函数与协议编解码的离线自检 |
