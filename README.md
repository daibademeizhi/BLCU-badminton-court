# 校园羽毛球场自动抢场（电脑直跑版）

> 零依赖的 Node.js 小工具：07:45 自动就位，08:00 放场那一刻冲刺下单，抢到后提醒你去付款。
> 电脑上双击就能用；也可以拷到软路由上 24 小时常开（见「软路由部署」）。

## 它能干什么

- **看余场**：`node src/avail.js --rel 2` 打印后天每个时段、每片场地的剩余。
- **定时抢**：按你排好的优先级（先 16:00-18:00，再 17:00-19:00……）在 08:00 抢 T+2 的场地。
- **马上抢**：菜单里挑一个时段，当场下单。
- **自动支付（可选）**：默认抢到后提醒你手动付；也可以让它走平台闭环通道直接扣款。
- **留痕**：每次运行写日志，结果写 `data/last-result.json`（订单号、金额、是否已付）。

## 工作原理

平台每天 **08:00 放出 T+2**（两天后）的场地，好时段放出来一两秒就没了。脚本只做三件事：

1. **提前就位**（07:45）：换发 token、算目标日期、读时段优先级，然后盯住放场表；
2. **卡点冲刺**：08:00 前 5 秒进入快通道，复查节奏收到 250ms；服务端一放场立刻冲刺（250ms 一轮），命中即停；
3. **收尾**：锁场 → 支付（或提醒）→ 写结果标记。没抢到会写明原因（余场为 0 / 被占 / 风控拒绝 / 支付失败）。

全程带重试、token 自愈和熔断，且绝不抢没被要求的目标日期。细节见 [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md)。

## 使用方法

按顺序做。每一步都写了「你应该看到什么」，对不上就先看文末「常见问题」。

### 第 1 步：装 Node.js

去 <https://nodejs.org> 下 LTS 版（18 或 20 都行），一路「下一步」装完。
打开命令行验证：

```bat
node -v
```

**应该看到** `v18.x.x` 或 `v20.x.x` 这样的版本号。报「不是内部或外部命令」= 没装好或没重开命令行。

### 第 2 步：进到项目目录

把项目解压/克隆到一个固定位置（例如 `D:\grab`）。在资源管理器里打开这个文件夹，**在地址栏直接输入 `cmd` 回车**，就会在当前目录打开命令行。

**应该看到** 提示符是 `D:\grab>`，`dir` 能列出 `src`、`qiangchang.bat`、`config.example.yaml`。
后面所有命令都要在这个目录里执行。

### 第 3 步：生成配置文件

```bat
copy config.example.yaml config.yaml
```

`config.example.yaml` 是模板，**不要改它**；`config.yaml` 才是你要编辑的那份（它已经在 `.gitignore` 里，不会被提交）。

### 第 4 步：在 config.yaml 里填学号

用记事本打开 `config.yaml`，只改这一处：

```yaml
auth:
  usercode: "202300000"   # ← 换成你自己的学号/工号
  allowRenew: true        # 保持 true：脚本靠它自动换发 token
  token: ""               # 留空即可，第一次运行会自动填上
```

- **必填只有学号**。不需要密码、不需要抓包、不需要扫码：token 换发接口只认学号。
- 可选：`target.hourPriority`（想抢的时段，按优先级从上到下），`pay.mode`（默认 `semi` = 抢到后提醒你手动付；改 `auto` 才自动扣款）。
- 其余字段先别动，默认值就是能跑的状态。

### 第 5 步：自检（不联网、不下单）

```bat
node src/selftest.js --offline
```

**应该看到** 最后一行 `结果：88 项通过，0 项失败`。有失败项就先别往下走。

### 第 6 步：看看后天还剩什么（只读，绝不下单）

```bat
node src/avail.js --rel 2
```

**应该看到** 一张表：`周三 2026-11-04` 之类，下面每个时段后面跟着「还剩几片 / 哪片场地」。
这一步同时验证了 token、网络和场馆 id 三者都对。

### 第 7 步：演练一次（不产生订单）

```bat
node src/grab.js --rel 2 --dry-run --no-wait
```

`--dry-run` = 走到「要下单了」就停；`--no-wait` = 现在就跑，不等到明天 08:00。
**应该看到** 校验 token → 读网格 → 打印候选方案（`[DRY-RUN]` 字样）→ 结束，全程没有新订单。

### 第 8 步：日常使用——双击 `qiangchang.bat`

```
[1] 优先级设置     先抢哪两小时、后抢哪两小时
[2] 定时抢设置     每天 07:45 抢哪些时段
[3] 马上抢 / 帮买   挑一个时段，当场拿下
```

页 2 只记「抢哪些时段」，**它不会让电脑自己在后台跑**——那件事由第 9 步的计划任务负责。

### 第 9 步：让电脑每天早上自动跑

以管理员身份打开命令行，执行：

```bat
powershell -ExecutionPolicy Bypass -File deploy\schedule.ps1 -Action InstallDaily -Time 07:45
```

**应该看到** 提示任务已安装、下次运行时间是明天 07:45。后续可用：

```bat
powershell -ExecutionPolicy Bypass -File deploy\schedule.ps1 -Action Status   :: 装没装、上次结果
powershell -ExecutionPolicy Bypass -File deploy\schedule.ps1 -Action Remove   :: 删掉 = 关闭自动抢
```

任务自带「到点唤醒睡眠中的电脑」和「错过就补跑一次」，但**关机、断电、没登录**时没人替它跑。

## 软路由部署（可选）

路由常年在线，比电脑可靠，配置和电脑上完全一样。

1. **准备**：路由装 Node ≥16（`node -v` 验证）。把 `src/`、`tools/state.js`、填好学号的 `config.yaml` 拷到 `/root/blcu/`，并 `mkdir -p /root/blcu/logs /root/blcu/data`。
2. **token 无需任何维护**：只要 `auth.allowRenew: true` + 学号，`grab.js` 会在 07:45 启动时检查 token 剩余寿命（不足 10 分钟就换发）、候场期间定时续期、遇到 401/403 自动换发一次重试。路由上不需要浏览器、不需要扫码，也不需要额外的保活脚本。
3. **先手动跑通**（OpenWrt 的 node 常在 `/opt/bin/node`，路径以 `which node` 为准）：

   ```sh
   cd /root/blcu && node src/avail.js --rel 2
   cd /root/blcu && node src/grab.js --rel 2 --dry-run --no-wait
   ```

4. **加定时任务**（`crontab -e`）：

   ```
   45 7 * * * cd /root/blcu && node src/grab.js --rel 2 >> logs/cron.log 2>&1
   30 8 * * * cd /root/blcu && node src/grab.js --rel 2 >> logs/rescue.log 2>&1
   ```

   第一行是正点抢；第二行是 08:30 的兜底重试，只在第一轮失手时才有意义（当天已经抢到的话，平台会以「每人每天一次」直接拒绝，不会多占名额）。`--rel 2` 自动算「今天+2 天」，不用每天改日期。
5. **开关**：把这两行注释掉就是关，取消注释就是开。
6. **时钟**：脚本会跟服务端对时，但路由自身时钟最好走 NTP（`ntpd -q -p ntp.aliyun.com`），偏差大到分钟级就可能算错放场时刻。

## 常见问题

- **`node -v` 没反应 / 版本低于 16**：重装 Node，或换 18/20 LTS。
- **`avail.js` 报 token 无效 / 401**：确认 `auth.usercode` 是学号、`allowRenew: true`；再跑 `node src/login.js` 看当前状态，或 `node src/login.js --renew` 强制换发。
- **`avail.js` 说目标日期还没放场**：T+2 的场每天 08:00 才放出，在那之前查不到是正常的。
- **08:00 之后日志里没有「已锁定」**：看 `logs/` 里当天的日志，失败原因（满场 / 被占 / 风控 / 支付失败）都写在里面。
- **菜单里设了时段但第二天没动**：多半是计划任务没装（第 9 步），页 2 只负责「抢哪些时段」。

## 边界与合规

个人自用：单账号、每天最多一单；不压接口、不绕风控；失败会明确写原因。请遵守学校场馆的预约规则，账号风险自负。

## 许可

[MIT](LICENSE) © 2026 daibadmeizhi
