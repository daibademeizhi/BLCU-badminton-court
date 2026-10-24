# 校园羽毛球场自动抢场（电脑直跑版）

> 一个零依赖的 Node.js 抢场工具：看余场 → 定时 → 08:00 开闸那一秒冲刺下单 → 自动支付。
> 本仓库是**电脑上双击就能用**的版本；另一种「软路由常开」的部署方式见文末架构说明（不含其代码）。

## 为什么会有这个东西

学校场馆每天 **08:00 放出 T+2（两天后）** 的场地预约。羽毛球馆的 16:00-18:00、17:00-19:00 这类黄金时段，放出来 **1~2 秒内就被抢光**——手点浏览器根本来不及。
所以真正要解决的不是「点得快」，而是三件事：

1. **提前就位**：07:45 之前把登录态、目标日期、目标时段全部准备好；
2. **卡点并发**：08:00:00 那一刻，按 120ms 一轮的节奏连续提交，命中即停，不空打；
3. **自动化收尾**：下单成功后立刻走支付（一卡通通道是服务端闭环，不需要跳浏览器），并把结果写成一份机器可读的标记，事后能复盘。

## 一、这个仓库能干什么

| 功能 | 说明 |
| --- | --- |
| 看三天余场 | `node src/avail.js --rel 2` 打印 T+2 每天、每段、每片场地的剩余 |
| 优先级抢场 | 先按 `hourPriority` 列表顺序试；列表里的都抢不到时，才允许按优先级抢当天其它空档 |
| 定时抢 | 07:45 拉起，等 08:00 开闸，`--rel 2` 自动算目标日期 |
| 立即抢 / 帮买 | 菜单里挑一个时段和场地，当场真下单 + 自动付款 |
| 自动支付 | `pay.mode: semi` + `pay.payway: "77"` 走一卡通服务端闭环；失败会明确报错 |
| 结果标记 | `logs/last-result.json` 记录 status / 订单号 / 场地 / 金额 / 是否已付 |
| 离线自检 | `node src/selftest.js --offline` 74 项（解析、滑块识别、网关判定、价格、标记…） |

## 二、60 秒上手

1. 装 [Node.js](https://nodejs.org/) 18 或更高（命令行里 `node -v` 能看到版本即可）。
2. 复制配置文件，然后填 **6 个字段**：

   ```bat
   copy config.example.yaml config.yaml
   ```

   | 字段 | 填什么 |
   | --- | --- |
   | `baseUrl` | 学校平台域名 |
   | `venue.nodeid` | 场馆 nodeid（抓包可得） |
   | `auth.usercode` / `user.usercode` | 学号 |
   | `user.password` | 平台密码 |
   | `user.accno` / `user.cardPassword` | 一卡通卡号 / 卡密码（自动支付用） |
   | `auth.token` / `auth.cookie` | 可以用 `node src/login.js` 扫码登录取，也可以留空、由程序自己轮询 |

3. 双击 **`qiangchang.bat`** 打开菜单：

   ```
   [1] 优先级设置    先抢哪两小时、后抢哪两小时
   [2] 定时抢设置    每天 07:45 抢哪些时段（按优先级 / 只抢某一段）
   [3] 马上抢 / 帮买  看三天还剩哪些场，挑一个直接拿下
   ```

4. **先演练一遍**（不真下单）：

   ```bat
   node src/grab.js --dry-run
   ```

## 三、每天自动跑一次（Windows 计划任务）

菜单只管「抢哪些时段」，**不会自己在后台跑**；要让电脑每天 07:45 自动开始，装一个计划任务：

```bat
rem 安装每日任务（默认 07:45，抢 T+2）
powershell -ExecutionPolicy Bypass -File deploy\schedule.ps1 -Action InstallDaily -Time 07:45
```

| 命令 | 作用 |
| --- | --- |
| `-Action InstallDaily` | 建**每日**任务：每天 07:45 执行 `node src\once.js --rel 2` |
| `-Action InstallOnce` | 建**一次性**任务（比如「明天早上帮我抢」） |
| `-Action Status` | 看任务是否存在、上次跑没跑、上次结果码 |
| `-Action Remove` | 删掉任务（= 关掉自动抢场） |

注意事项：

- 任务已开启 `WakeToRun`（睡眠中会唤醒）和 `StartWhenAvailable`（错过会补跑），但**关机/断电/没登录**时没有东西能替它跑；
- 装完先 `-Action Status` 确认，第二天早上看 `logs\` 里有没有当天的 `run-*.log`；
- 「设了时段」和「任务装没装」是两件事——这点和软件设计无关，纯粹是人容易记混，所以菜单页 2 会先把计划任务的真实状态显示出来。

## 四、数据与日志

| 路径 | 内容 | 要不要提交 |
| --- | --- | --- |
| `config.yaml` | 全部凭据（token、cookie、卡号、卡密码） | **绝不提交**（已在 `.gitignore` 里） |
| `logs/run-YYYYMMDD-HHMMSS.log` | 每次抢场的完整过程（开闸前后每秒在干什么） | 不提交 |
| `logs/once-*.log` | 计划任务每次启动的入口记录 | 不提交 |
| `logs/last-result.json` | 上一次真抢的结果标记（dry-run 不覆盖） | 不提交 |
| `data/timed.txt`、`data/priority.txt` | 定时模式 / 优先级列表（菜单写） | 不提交 |

## 五、命令行一览

```bat
node src/avail.js --rel 2          :: 看 T+2 余场
node src/grab.js --rel 2           :: 抢 T+2（定时任务实际调的是 once.js，它会写入口日志）
node src/grab.js --rel 2 --dry-run :: 演练：只发查询，不提交预约
node src/login.js                  :: 扫码登录，把 token/cookie 写回 config.yaml
node src/probe.js                  :: 探查接口（开发用，产出 logs/probe-<时间>.json）
node src/selftest.js --offline     :: 离线自检
node tools/state.js show           :: 看当前定时模式与优先级（菜单也调它）
```

## 六、目录结构

```
qiangchang.bat            双击入口（ASCII，调用 qiangchang-menu.ps1）
qiangchang-menu.ps1       菜单本体（UTF-8 BOM）
qiangchang-menu.text.json 菜单文案
grab-once.cmd             命令行 shim → src\once.js
config.example.yaml       配置模板（复制成 config.yaml 后再填）
deploy\schedule.ps1       Windows 计划任务安装/状态/删除
src\                      login / grab / once / avail / pay / slider / selftest …
tools\state.js            定时模式与优先级的小状态机（菜单调）
tools\build-menu.js       菜单生成器（改完菜单用 node tools/build-menu.js 重新生成）
docs\HOW-IT-WORKS.md      实现细节与踩坑记录
```

## 七、另一种部署形态：软路由版是怎么实现的

同一个 `src/`，换一个「每天一定会醒着」的地方跑，就是软路由版。它不在本仓库里（那样必须连带暴露家庭内网拓扑和路由器脚本），但架构值得说明，因为**抢场成败的一半取决于「07:45 那台机器醒着吗」**。

### 拓扑

```
Windows 主机（偶尔开）            OpenWrt 软路由（24h 在线）           学校平台
   扫码/有头浏览器  ──token──▶   crond 07:45 拉起 src/grab.js  ──HTTP──▶  08:00 开闸抢场
   手动刷新 token                 自动校时 / 保活 / 抢完写结果标记
```

- **Windows 端**负责「需要人盯着浏览器」的事：扫码登录、刷新 token（平台 token 寿命约 40 分钟，且刷新要点页面，无头浏览器在路由上太脆弱）；
- **软路由**负责「一定要准时」的事：它是家里唯一 24 小时通电的设备，cron 比 Windows 计划任务在「睡眠/未登录」下可靠得多，主板上还有 RTC 可以在断网后靠 NTP 校时。

### 路由器上的脚本分工

| 脚本 | 职责 |
| --- | --- |
| `run-grab.sh` | crond 07:45 拉起：算目标日期（T+2）→ `node src/grab.js --rel 2` → 写 `logs/cron-*.log` |
| `keep-token.sh` | 07:00 / 07:30 检查 token 剩余寿命，不够就调刷新接口续上（续不上会报警） |
| `clock-fix.sh` | 07:40 NTP 校时，确保 08:00:00 这个判定点不被时钟漂移带偏（慢 20 分钟 = 直接错过开闸） |
| `clock-safe.sh` | 开机后检测「时钟比真实时间慢很多」时先校时再启动业务，避免带病跑 |
| `toggle.sh on/off` | 开关：把 crontab 里 `45 7 * * * run-grab.sh` 和 `30 8 * * * rescue-grab.sh` 两行注释/取消注释 |
| `grab-ctl.sh` | 菜单从 Windows 侧 SSH 调它：`onoff` / `status` / `buy` / `prio` … |
| `state.js` | 跑在路由上，让 Windows 菜单能远程读写 `data/timed.txt`、`data/priority.txt` |
| `rescue-grab.sh` | 08:30 兜底：早上的抢场如果因为网络原因没成，再试一次（只补一次，不无限重试） |

### 一次完整的时间线

```
07:00  keep-token.sh   → token 剩余 < 3h 就续期
07:30  keep-token.sh   → 再兜一次，确保 08:00 一定有有效 token
07:40  clock-fix.sh    → NTP 校时（此刻偏差必须 < 5s）
07:45  run-grab.sh     → node src/grab.js --rel 2（目标 = 今天+2 天）
07:45~07:59            → 预热/轮询，确认登录态、目标日期可预约
08:00:00.000           → 开闸冲刺：120ms 一轮，命中即停（stopOnFirstHit）
08:00:0x               → 下单 → 支付（payway 77，服务端闭环）→ 写 logs/last-result.json
08:30  rescue-grab.sh  → 若早上没拿到，补跑一次（成功就停）
```

### 三种部署形态对比

| | 本机常开 PC | 软路由（OpenWrt） | 云服务器 |
| --- | --- | --- | --- |
| 07:45 一定醒着 | ✗ 睡眠/关机/未登录就废 | ✓ 24h 在线 | ✓ |
| token 自动刷新 | ✓ 有浏览器 | 需无头浏览器（脆弱） | 需无头浏览器 |
| 功耗 | 高 | 几瓦 | 几瓦 |
| 校园网可达性 | ✓ | ✓（同一出口） | 常被限制 |
| 断网/重启后自动恢复 | 差 | 好（cron + 校时 + 保活） | 好 |

### 一个容易被忽略的坑：设了时段 ≠ 开了开关

软路由版里「定时抢设置」只改 `data/timed.txt`（抢哪些时段），**开关是另一件事**——`toggle.sh on/off` 才改 crontab。设了时段但没开开关，07:45 根本不会启动，日志里一行都不会有。这个坑在真实环境里踩过一次，所以电脑直跑版把提示做进了菜单：页 2 顶部会先显示计划任务的真实状态，保存完还会问一句「要不要现在打开」。

## 八、边界与合规

- 个人自用：单账号、单次运行最多下一单（`safety.maxOrdersPerDay: 1`），不做多账号并发或高频爆破；
- 抢不到时会明确告诉你原因（余场为 0 / 被占用 / 网关拒绝 / 支付失败），不去绕过服务端的任何风控；
- 请遵守所在学校场馆的预约规则；使用导致的账号风险由使用者自负。

## 九、许可

[MIT](LICENSE) © 2026 daibadmeizhi
