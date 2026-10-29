# 校园羽毛球场自动抢场（电脑直跑版）

> 零依赖的 Node.js 小工具：07:45 自动就位，08:00 放场那一刻冲刺下单，抢到后自动支付。
> 电脑上双击就能用；也可以拷到软路由上常开运行（见「软路由部署」）。

## 它能干什么

- **看余场**：`node src/avail.js --rel 2` 打印后天每个时段、每片场地的剩余。
- **定时抢**：按你排好的优先级（先 16:00-18:00，再 17:00-19:00……）在 08:00 抢 T+2 的场地。
- **马上抢**：菜单里挑一个时段，当场下单。
- **自动支付**：走一卡通服务端闭环通道，不跳浏览器。
- **留痕**：每次运行写日志，结果写 `logs/last-result.json`（订单号、金额、是否已付）。

## 工作原理

平台每天 **08:00 放出 T+2**（两天后）的场地，黄金时段放出来一两秒就没了。脚本只做三件事：

1. **提前就位**：07:45 启动，登录态、目标日期、时段优先级全部准备好，然后盯住放场表；
2. **卡点冲刺**：逼近 08:00 时复查节奏收到 500ms→250ms，服务端一放场立刻转入冲刺（250ms 一轮），命中即停；
3. **收尾**：锁场 → 自动支付 → 写结果标记。没抢到会写明原因（余场为 0 / 被占 / 网关拒绝 / 支付失败）。

全程带重试、鉴权自愈和熔断，且绝不抢没被要求的目标日期。细节见 [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md)。

## 使用方法

1. 装 [Node.js](https://nodejs.org/) 18+，`node -v` 能看到版本即可。
2. 复制配置并填好：

   ```bat
   copy config.example.yaml config.yaml
   ```

   要填：`baseUrl`、`venue.nodeid`、学号（`auth.usercode` / `user.usercode`）、平台密码、一卡通卡号/卡密码。token 可以先留空，程序会自己换发。
3. 自检（不联网、不下单）：`node src/selftest.js --offline`，应显示「88 项通过」。
4. 只读探测：`node src/login.js` 扫码登录，再 `node src/avail.js --rel 2`；能看到余场就说明整条链通了。
5. 演练一遍：`node src/grab.js --rel 2 --dry-run`（只查询、不提交）。
6. 日常使用双击 **`qiangchang.bat`**：

   ```
   [1] 优先级设置    先抢哪两小时、后抢哪两小时
   [2] 定时抢设置    每天 07:45 抢哪些时段
   [3] 马上抢 / 帮买  挑一个时段当场拿下
   ```

7. 让电脑每天自动跑 —— 菜单只记「抢哪些时段」，**不会自己在后台跑**，要装计划任务：

   ```bat
   powershell -ExecutionPolicy Bypass -File deploy\schedule.ps1 -Action InstallDaily -Time 07:45
   ```

   其他动作：`-Action InstallOnce`（只跑一次）、`-Action Status`（装没装 / 上次结果）、`-Action Remove`（删掉 = 关闭）。
   任务开了「睡眠唤醒」和「错过补跑」，但**关机、断电、没登录**时没人替它跑。

## 软路由部署（可选）

路由 24 小时在线，比电脑可靠，代价是要自己补 token 续期。

1. **准备**：路由能跑 Node ≥16（`node -v` 验证）；把 `src/`、`tools/state.js`、填好的 `config.yaml` 拷到 `/root/blcu/`。
2. **先手动跑通**：`cd /root/blcu && node src/avail.js --rel 2` 能读到余场。
3. **加定时任务**（`crontab -e`）：

   ```
   45 7 * * * cd /root/blcu && node src/grab.js --rel 2 >> logs/cron.log 2>&1
   30 8 * * * cd /root/blcu && node src/grab.js --rel 2 >> logs/rescue.log 2>&1
   ```

   `--rel 2` 自动算「今天+2 天」，不用每天改日期。
4. **token**：平台 token 寿命约 40 分钟，续期要点页面，路由上没有浏览器。最省事的做法是在电脑上 `node src/login.js` 扫码拿到新 token，写进路由的 `config.yaml`；要长期无人值守，得自己写续期脚本。
5. **开关**：crontab 里那两行注释掉即关闭、取消注释即开启。上线前先跑一次 `--dry-run`，确认路径、日志目录和权限都对。
6. 本仓库不含路由端的保活/校时/兜底脚本；那一套（`keep-token.sh`、`clock-fix.sh`、`rescue-grab.sh`、`toggle.sh`）在根目录的完整版仓库里。

## 边界与合规

个人自用：单账号、每天最多一单；不压接口、不绕风控；失败会明确告诉你原因。请遵守学校的场馆预约规则，账号风险自负。

## 许可

[MIT](LICENSE) © 2026 daibadmeizhi
