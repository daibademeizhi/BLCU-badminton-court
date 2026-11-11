#!/usr/bin/env node
/**
 * build-menu.js —— 生成电脑端的交互菜单（分页面版）
 *
 * 为什么要用脚本生成，而不是直接手写这几个文件：
 *   1. qiangchang.bat 必须是纯 ASCII（cmd.exe 按 GBK 解析，中文 .bat 会散架）；
 *   2. qiangchang-menu.ps1 里的中文必须让 PowerShell 按 UTF-8 读，
 *      所以它要带 UTF-8 BOM —— Windows PowerShell 5.1 没 BOM 就会按 GBK 读，中文全乱；
 *   3. 文案集中在 qiangchang-menu.text.json，手改一次就可能编错码，交给生成器最稳。
 *
 * 产物（都在仓库根目录）：
 *   qiangchang.bat              纯 ASCII 启动器，双击它
 *   qiangchang-menu.ps1         UTF-8(BOM) + CRLF 的真正菜单
 *   qiangchang-menu.text.json   全部中文文案
 *
 * 这一版改成了「分页面」：
 *   [1] 优先级设置   设「先抢哪两小时、后抢哪两小时」，随时改顺序
 *   [2] 定时抢设置   每天 07:45 用「按优先级」还是「只抢某个时段」
 *   [3] 马上抢/帮买  看三天还剩哪些场 → 挑一个 → 直接拿下
 *   [4] 状态与开关   看开关/上次结果，并在这里关掉或打开（原来两个页面合并）
 * 预演从菜单里去掉了（命令行 `--dry-run` 仍然保留，给自己验证用）。
 *
 * 用法：node recon/build-menu.js [--out=pc-version] [--tool-dir=tools]
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const BAT = [
  '@echo off',
  'rem ==========================================================================',
  'rem  qiangchang.bat -- double click me',
  'rem',
  'rem  This file is deliberately PURE ASCII. It only starts the PowerShell menu',
  'rem  sitting next to it (qiangchang-menu.ps1). All Chinese text lives in that',
  'rem  .ps1 file, which PowerShell reads as UTF-8 (it carries a BOM), so cmd.exe',
  'rem  never has to parse a single non-ASCII byte.',
  'rem',
  'rem  That is exactly what broke the earlier version: a Chinese .bat gets',
  'rem  decoded as GBK by cmd.exe, the bytes shift, and half the lines turn into',
  'rem  "not recognized as an internal or external command".',
  'rem',
  'rem  Double clicking only SHOWS A MENU. It books nothing by itself.',
  'rem ==========================================================================',
  'setlocal',
  'cd /d "%~dp0"',
  'where pwsh >nul 2>nul && (set "PS=pwsh") || (set "PS=powershell")',
  '%PS% -NoProfile -ExecutionPolicy Bypass -File "%~dp0qiangchang-menu.ps1"',
  'endlocal',
  ''
].join('\r\n');

// 中文界面文案：全部集中在这里
const T = {
  title: '   羽毛球场抢场 · 控制台',
  prompt: '  请输入序号再回车',
  eofBye: '  输入已经读完（非交互运行），先退出了。',
  badChoice: '  [!] 没看懂这个序号，请输入 0-5。',
  bye: '  再见。',
  backToMenu: '按回车回去',
  opDone: '  操作结束（退出码 ',
  opDoneOk: '）。',
  opDoneBad: '）—— 非 0 说明没成功，上面写着原因。',
  sshMissing: '  [x] 这台电脑上找不到 ssh.exe（Windows 10 1809 以后自带，或者装个 OpenSSH 客户端）。',
  keyMissingA: '  [x] 找不到私钥：',
  keyMissingB: '      没有它就连不上软路由。私钥路径见菜单脚本顶部，或同目录的 menu.local.json。',
  noNodeA: '  [!] 没找到 node.exe。这个菜单只是给软路由发指令，本机不一定要 node，',
  noNodeB: '      但如果你想在电脑上直接跑抢场，就得先装 Node.js 18 以上。',

  // ── 主页 ──
  p1: '    [1] 开抢          选「默认优先级」或「这一次的特殊优先级」，选完立刻生效',
  p2: '    [2] 关掉自动抢场   明早不再自己跑（抢到一次也会自动关）',
  p3: '    [3] 现在马上抢     看三天还剩哪些场，挑一个直接拿下（真下单 + 自动付款）',
  p4: '    [4] 改默认优先级   先抢哪两小时、后抢哪两小时（明天有课就改一下顺序）',
  p5: '    [5] 状态与日志     开关、上次结果、今天的抢场日志',
  m0: '    [0] 退出',
  noteA: '  说明：开抢之后，每天早上 07:45 自动抢「三天后的场地」，08:05 再补一枪；',
  noteB: '        抢到一次就自动关掉，不会无限下单。菜单本身不会下单，除非你点了 [3]。',

  // ── 主页状态块（2026-11-11 改版：不用再进子页面猜「到底开没开」）──
  homeTitle: '  ── 现在到底抢不抢 ──',
  homeSwitch: '  自动抢场     ：',
  homeOn: '开（明早 07:45 会自动跑）',
  homeOff: '关（明早不会自己跑）',
  homeMode: '  优先级来源   ：',
  homeModeDefault: '默认（每天都一样）',
  homeModeOnce: '这一次的特殊优先级',
  homeTarget: '  要抢哪天的场 ：',
  homePlan1: '  明早节奏     ：',
  homePlanMid: ' 主任务，',
  homePlan2: ' 兜底（抢到一次就自动关）',
  homePlanOff: '  明早节奏     ：关着呢，不会跑',
  homePriority: '  抢的时段顺序 ：',
  homePriorityNone: '（用 config.yaml 里的偏好）',
  homeLast: '  上次结果     ：',
  homeLastNone: '（还没有记录）',
  homeLastOld: '  ← 旧记录，不是这次要抢的日期',
  homeOffline: '  [!] 连不上软路由 / 读不到状态 —— 先确认路由器开着、密钥没问题。',
  homeArmTitle: '  ── 开抢：用哪套优先级 ──',
  homeArmDefault: '    [1] 用默认优先级（每天都一样）',
  homeArmOnce: '    [2] 这一次用特殊优先级（输一行，比如 16-18,17-19）',
  homeOnceAsk: '  这一次按什么顺序抢？（逗号分隔，例如 16-18,17-19；直接回车 = 取消）',
  homeArmed: '  ✓ 已开抢。',
  homeDisarmed: '  ✓ 已关掉自动抢场 —— 明早 07:45 不会自己跑。',

  // ── 优先级页 ──
  prTitle: '优先级设置',
  prCur: '  现在的顺序（越靠前越优先）：',
  prEmpty: '  还没有单独设置过 —— 现在用的是 config.yaml 里的偏好。',
  prNote: '  按「抢的顺序」填，用逗号分隔。例如：16:00-18:00,17:00-19:00,15:00-17:00',
  prAsk: '  重新输入（例：16-18,17-19,15-17；直接回车 = 不改）',
  prReAsk: '  输入新的顺序编号（例：2,1,3；直接回车 = 不改）',
  pr1: '    [1] 重新输入一组时间段（整体替换）',
  pr2: '    [2] 只调整顺序（用上面的编号）',
  pr3: '    [3] 清空（回到 config.yaml 里的偏好）',
  pr0: '    [0] 返回',
  prSaved: '  ✓ 已保存。定时抢场时就会按这个顺序试。',
  prCleared: '  ✓ 已清空。',
  prNoData: '  [x] 读不到软路由上的偏好设置（ssh 通了吗？）',
  prBadNum: '  [!] 编号必须是 1 到 N 之间、且不重复、一个都不能少。',
  prLen: '  现有 ',

  // ── 定时抢页 ──
  tmTitle: '定时抢设置',
  tmCurPriority: '  当前模式：按优先级顺序试（都抢不到时，才允许抢当天其它空档）',
  tmCurWindow: '  当前模式：只抢这一段 —— ',
  tmCurConfig: '  当前模式：用 config.yaml 里的偏好（没有单独设置）',
  tmPrio: '  优先级：',
  tmNoPrio: '  优先级：还没设置（先在 [1] 里设一组）',
  tmHint1: '  ★ 这个设置只管「抢哪些时段」；能不能每天 07:45 自动跑，看上面那行开关。',
  tmHint2: '  ★ 「只抢某一段」是严格模式：那一段没空场地就收手，不会偷偷去抢别的时间。',
  tm1: '    [1] 按优先级顺序试（推荐：抢不到优先的，还能抢别的）',
  tm2: '    [2] 只抢指定的一段（严格：其它时间一律不要）',
  tm0: '    [0] 返回',
  tmAskWin: '  只抢哪一段？（例：18:00-20:00，也能写 18-20；直接回车 = 不改）',
  tmSaved: '  ✓ 已保存。',

  // ── 开关状态（页面 2 与页面 4 共用这几句）──
  //    2026-10-24 加：原来「设了时段」和「打开开关」是两件事，而页面 2 存完只说
  //    「已保存，明天 07:45 就按这个来」——开关关着也这么说，于是连着一周以为设好了、
  //    实际 07:45 根本没启动。现在两页都显示开关真状态，页面 2 存完还会问要不要打开。
  swOn: '  ✓ 自动抢场：开（每天 07:45 会自动跑一次）',
  swOff: '  ⚠ 自动抢场：关 —— 07:45 不会跑；现在设的时段暂时不生效',
  swUnknown: '  ? 读不到开关状态（ssh 可能没连上软路由）',
  tmAlsoOn: '  ⚠ 但自动抢场是关着的 —— 光设「抢哪些时段」不会让它跑起来。',
  tmAskOn: '  现在顺手打开吗？（输入 y 打开；直接回车 = 先不开）',
  tmTurnedOn: '  ✓ 已打开。明天 07:45 会自动跑一次。',
  tmSkipOn: '  没打开：07:45 仍然不会跑，这里的设置等你打开开关后才生效。',
  tmOnFailA: '  [x] 打开失败（退出码 ',
  tmOnFailB: '）—— 多半是 ssh 没连上软路由；开关状态没变。',

  // ── 状态页 ──
  stTitle: '状态与开关',
  stPrefs: '  ---- 抢场偏好 ----',
  st1: '    [1] 关掉定时抢场（以后只有你手动点才下单）',
  st2: '    [2] 打开定时抢场（每天 07:45 自动抢一次）',
  st0: '    [0] 返回',
  stOffDone: '  ✓ 已关掉。要抢的时候再来 [3]。',
  stOnDone: '  ✓ 已打开。每天 07:45 会自动跑一次。',
  // 2026-10-24 加：原来 on/off 只在退出码 0 时说话，失败时一个字都不打印 ——
  // 菜单看起来「按了没反应」，很容易被当成「已经开好了」。
  stNoStatus: '  [x] 这次没取到软路由的状态（ssh 非 0 退出）—— 下面的信息可能不完整，别照它下结论。',
  stOpFailA: '  [x] 没成功（退出码 ',
  stOpFailB: '）—— 开关状态没变，别以为已经改了。',

  // ── 马上抢 / 帮买 ──
  byTitle: '马上抢 / 帮买',
  byLoading: '  正在向软路由查询这三天还剩哪些场 …',
  byNoData: '  [x] 查不到场地信息（ssh 通不通？token 过期了？）',
  byPickDay: '  这三天的情况（选一天看他具体还剩哪些时段）：',
  bySlotsUnit: ' 个时段有空',
  byFull: '已满 / 还没放场',
  byBack: '返回',
  bySlotsTitle: '  选一个时段（这一单就买这一个小时）：',
  byCourtsUnit: ' 片',
  byBackDay: '换一天',
  byCourtAsk: '  指定哪片场地？（回车 = 哪片都行）',
  byCourtAny: '哪片都行',
  byCourtPrompt: '  输入场地编号再回车',
  byConfirmTitle: '确认帮买（会真实下单并自动扣款）',
  byCdDate: '日期：',
  byCdSlot: '时段：',
  byCdCourt: '场地：',
  byCdPay: '  价格以服务端返回为准；付款方式沿用 config.yaml 的 pay.mode。',
  byOk: '  ✓ 抢到了，付款结果看上面的日志。',
  byAlready: '  ⇒ 这一天已经订到了，平台不允许同一天再订一个场地。',
  byFailed: '  —— 没成功，原因看上面的日志。',
  byBackPage: '  （这一天没有可选时段）',

  // ── 通用确认 ──
  goAsk: '  确认就输入 YES 再回车（其它任何输入都取消）',
  goCancelled: '  已取消，什么都没做。',
  winAsk: '  从几点到几点？（例：18:00-20:00，也能写 18-20；直接回车 = 取消）',
  winBad: '  [!] 这个时间段看不懂。要写成 18:00-20:00 或 18-20，而且结束时间必须晚于开始。',
  winTitle: '     你选的时段：'
};

const HEAD = `# ==========================================================================
#  qiangchang-menu.ps1 —— 抢场地控制台（分页面版）
#
#  【这个文件是自动生成的，别手改】改文案或逻辑请改 recon/build-menu.js
#  再运行：node recon/build-menu.js
#
#  用法：双击同目录的 qiangchang.bat
#
#  设计要点
#    1. 双击只显示菜单，不会下单；只有 [3] 会真下单，而且还要再输 YES；
#    2. 中文只出现在这个文件里，而且必须带 UTF-8 BOM ——
#       Windows PowerShell 5.1 读没有 BOM 的 .ps1 会按系统 ANSI(GBK) 解，
#       中文全乱、脚本直接语法报错。qiangchang.bat 则保持纯 ASCII。
#    3. 所有「读一行输入」都走 Read-Line：它把 EOF（管道输入用完了）翻译成 $null，
#       由调用方正常收场。踩过的坑：直接 (Read-Host x).Trim() 在 EOF 时抛异常，
#       而菜单是 while 循环，异常被吞掉后立刻再读一次 = 无限刷屏（看着像卡死）。
#    4. 偏好存在软路由的 data/priority.txt 与 data/timed.txt 里（由 state.js 读写），
#       **不碰 config.yaml** —— 用脚本回写满是注释的 YAML，写坏一次就是一整晚抢不到。
# ==========================================================================

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$Root   = Split-Path -Parent $MyInvocation.MyCommand.Path
$TFile  = Join-Path $Root 'qiangchang-menu.text.json'
$Known  = Join-Path $env:LOCALAPPDATA 'dsh-ssh\\known_hosts'
# ── 软路由连接信息（开源版是占位值，请改成你自己的）──────────────────────
#   也可以不改这里，而是在同目录放一个 menu.local.json 覆盖（该文件已被 .gitignore 排除）：
#     { "remote": "root@<路由器IP>", "key": ".ssh\\\\id_ed25519", "ctl": "sh /root/blcu/grab-ctl.sh" }
$LocalFile = Join-Path $Root 'menu.local.json'
$Remote = 'root@<路由器IP>'
$Key    = Join-Path $Root '.ssh\\id_ed25519'
$Ctl    = 'sh /root/blcu/grab-ctl.sh'
if (Test-Path -LiteralPath $LocalFile) {
  try {
    $L = Get-Content -LiteralPath $LocalFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($L.remote) { $Remote = [string]$L.remote }
    if ($L.key)    { $Key    = Join-Path $Root ([string]$L.key) }
    if ($L.ctl)    { $Ctl    = [string]$L.ctl }
  } catch { }
}

$T = $null
if (Test-Path -LiteralPath $TFile) {
  try {
    $T = Get-Content -LiteralPath $TFile -Raw -Encoding UTF8 | ConvertFrom-Json
  } catch { $T = $null }
}
if ($null -eq $T) {
  Write-Host '  [x] 读不到界面文案文件 qiangchang-menu.text.json（或者它不是合法 JSON）。'
  Write-Host '      请先跑一次：node recon/build-menu.js'
  Write-Host ''
  exit 1
}

function Pause-Key {
  Write-Host ''
  Write-Host ('  ' + $T.backToMenu + ' ...') -ForegroundColor DarkGray
  [void](Read-Host)
}

$script:Eof = $false
function Read-Line([string]$Prompt) {
  $v = Read-Host $Prompt
  if ($null -eq $v) { $script:Eof = $true; return $null }
  return $v
}

function Show-Header([string]$Text) {
  Clear-Host
  Write-Host ''
  Write-Host '  ============================================================' -ForegroundColor Cyan
  Write-Host ('  ' + $Text) -ForegroundColor Cyan
  Write-Host '  ============================================================' -ForegroundColor Cyan
  Write-Host ''
}

# 跑一条远端命令，把输出抓回来（不打印）。给需要读 JSON 的页面用。
function Invoke-RouterRaw([string]$Action) {
  if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) {
    Write-Host $T.sshMissing -ForegroundColor Red
    return @{ code = 127; out = @() }
  }
  if (-not (Test-Path -LiteralPath $Key)) {
    Write-Host ($T.keyMissingA + $Key) -ForegroundColor Red
    Write-Host $T.keyMissingB -ForegroundColor DarkGray
    return @{ code = 126; out = @() }
  }
  $lines = & ssh -i $Key -o StrictHostKeyChecking=no -o UserKnownHostsFile=$Known -o LogLevel=ERROR -o ConnectTimeout=20 $Remote "$Ctl $Action" 2>&1 |
    ForEach-Object { [string]$_ }
  $code = $LASTEXITCODE
  if ($null -eq $lines) { $lines = @() }
  return @{ code = $code; out = @($lines) }
}

# 跑一条远端命令并把过程打印出来，返回退出码。
function Invoke-Router([string]$Action) {
  Write-Host ''
  Write-Host '  ------------------------------------------------------------' -ForegroundColor DarkGray
  Write-Host ('  > ' + $Action) -ForegroundColor DarkGray
  Write-Host ''
  $r = Invoke-RouterRaw $Action
  foreach ($l in $r.out) { Write-Host ('  ' + $l) }
  Write-Host ''
  Write-Host '  ------------------------------------------------------------' -ForegroundColor DarkGray
  if ($r.code -eq 0) {
    Write-Host ($T.opDone + $r.code + $T.opDoneOk) -ForegroundColor Green
  } else {
    Write-Host ($T.opDone + $r.code + $T.opDoneBad) -ForegroundColor Yellow
  }
  return $r.code
}

# 跑一条会输出 JSON 的远端命令（state.js / avail.js），解析里面的 JSON。
#   ★ 不能用「找一行以 { 开头就 ConvertFrom-Json」：avail.js 输出的是带缩进的
#     多行 JSON，单行永远解析失败（2026-10-19 实测：菜单报「查不到场地信息」，
#     而远端命令其实完全正常）。这里把整个输出拼成一串，再取第一个 { 到最后一个 }。
function Invoke-State([string]$Action) {
  $r = Invoke-RouterRaw $Action
  $all = ($r.out -join ' ')
  $i = $all.IndexOf('{')
  $j = $all.LastIndexOf('}')
  if ($i -ge 0 -and $j -gt $i) {
    $json = $all.Substring($i, $j - $i + 1)
    try { return ($json | ConvertFrom-Json) } catch { return $null }
  }
  return $null
}

# 读一个时间段，返回规范化的 HH:MM-HH:MM；空输入返回空串（= 取消）。
#   本机先校验一遍，保证进 ssh 命令行的一定是「数字:数字-数字:数字」这种干净形式。
function Read-Window {
  while ($true) {
    Write-Host ''
    $line = Read-Line $T.winAsk
    if ($null -eq $line) { return '' }
    $raw = $line.Trim()
    if ($raw -eq '') { return '' }
    $m = [regex]::Match($raw, '^\\s*(\\d{1,2})(?::(\\d{2}))?\\s*[-~—–－至到]\\s*(\\d{1,2})(?::(\\d{2}))?\\s*$')
    if ($m.Success) {
      $h1 = [int]$m.Groups[1].Value
      $n1 = 0
      if ($m.Groups[2].Success) { $n1 = [int]$m.Groups[2].Value }
      $h2 = [int]$m.Groups[3].Value
      $n2 = 0
      if ($m.Groups[4].Success) { $n2 = [int]$m.Groups[4].Value }
      if ($h1 -le 23 -and $h2 -le 24 -and $n1 -le 59 -and $n2 -le 59) {
        $from = $h1 * 60 + $n1
        $to = $h2 * 60 + $n2
        if ($to -gt $from) {
          return ('{0:D2}:{1:D2}-{2:D2}:{3:D2}' -f $h1, $n1, $h2, $n2)
        }
      }
    }
    Write-Host $T.winBad -ForegroundColor Yellow
  }
}

function Confirm-Yes([string]$Title, [string[]]$Lines) {
  Write-Host ''
  Write-Host '  ============================================================' -ForegroundColor Red
  Write-Host ('  ' + $Title) -ForegroundColor Red
  Write-Host '  ============================================================' -ForegroundColor Red
  foreach ($l in $Lines) { Write-Host $l }
  Write-Host ''
  $ans = Read-Host $T.goAsk
  if ($ans -ceq 'YES') { return $true }
  Write-Host ''
  Write-Host $T.goCancelled -ForegroundColor Green
  Start-Sleep -Seconds 2
  return $false
}

# ── 开关（crontab 里 07:45 那两行）的读与问 ─────────────────────────────
#   为什么单独做一个 onoff 子命令：status 打回来的是一屏中文，解析中文最容易碎
#   （换个措辞菜单就瞎了）。onoff 只回一行 on / off，判读永远稳。
function Get-Switch {
  $r = Invoke-RouterRaw 'onoff'
  foreach ($l in $r.out) {
    $v = ([string]$l).Trim().ToLower()
    if ($v -eq 'on' -or $v -eq 'off') { return $v }
  }
  return ''
}

function Show-Switch($sw) {
  if ($sw -eq 'on') { Write-Host $T.swOn -ForegroundColor Green }
  elseif ($sw -eq 'off') { Write-Host $T.swOff -ForegroundColor Yellow }
  else { Write-Host $T.swUnknown -ForegroundColor Red }
}

# 存完「抢哪些时段」之后调用：开关关着就地问一句要不要打开。
#   ★ 这就是这一个月两次没抢到的根：设置只写 data/timed.txt，不碰 crontab，
#     所以「已保存」并不等于「明天会跑」。把它接成一步，人就不会忘。
function Offer-SwitchOn {
  $sw = Get-Switch
  if ($sw -eq 'on') { Write-Host $T.swOn -ForegroundColor Green; return }
  if ($sw -eq '') { Write-Host $T.swUnknown -ForegroundColor Red; return }
  Write-Host ''
  Write-Host $T.tmAlsoOn -ForegroundColor Yellow
  $a = Read-Line $T.tmAskOn
  if ($null -eq $a) { return }
  if ($a.Trim().ToLower() -ne 'y') {
    Write-Host $T.tmSkipOn -ForegroundColor DarkGray
    return
  }
  $code = Invoke-Router 'on'
  if ($code -eq 0) { Write-Host $T.tmTurnedOn -ForegroundColor Green }
  else { Write-Host ($T.tmOnFailA + $code + $T.tmOnFailB) -ForegroundColor Red }
}

# ══════════════════════ 页面 1：优先级设置 ══════════════════════
function Show-PriorityList($st) {
  $list = @($st.priority)
  if ($list.Count -eq 0) {
    Write-Host $T.prEmpty -ForegroundColor Yellow
    return
  }
  Write-Host $T.prCur -ForegroundColor Green
  for ($i = 0; $i -lt $list.Count; $i++) {
    Write-Host ('     ' + ($i + 1) + '. ' + $list[$i]) -ForegroundColor Cyan
  }
}

function Page-Priority {
  $quitPage = $false
  while (-not $quitPage) {
    $st = Invoke-State 'prio show'
    Show-Header $T.prTitle
    if ($null -eq $st) {
      Write-Host $T.prNoData -ForegroundColor Red
      Pause-Key
      return
    }
    if (-not $st.ok) { Write-Host ('  [!] ' + $st.error) -ForegroundColor Yellow }
    Show-PriorityList $st
    Write-Host ''
    Write-Host $T.prNote -ForegroundColor DarkGray
    Write-Host ''
    Write-Host $T.pr1
    Write-Host $T.pr2
    Write-Host $T.pr3
    Write-Host $T.pr0
    Write-Host ''
    $line = Read-Line $T.prompt
    if ($null -eq $line) { return }
    $c = $line.Trim()
    if ($c -eq '0') { $quitPage = $true }
    elseif ($c -eq '1') {
      $ans = Read-Line $T.prAsk
      if ($null -eq $ans) { return }
      $txt = $ans.Trim()
      if ($txt -ne '') {
        $r = Invoke-State ('prio set "' + $txt + '"')
        if ($null -eq $r) {
          Write-Host $T.prNoData -ForegroundColor Red
        } elseif ($r.ok) {
          Write-Host $T.prSaved -ForegroundColor Green
        } else {
          Write-Host ('  [!] ' + $r.error) -ForegroundColor Yellow
        }
      }
      Pause-Key
    }
    elseif ($c -eq '2') {
      $list = @($st.priority)
      if ($list.Count -lt 2) {
        Write-Host ('  [!] 现在只有 ' + $list.Count + ' 段，没什么可调的。') -ForegroundColor Yellow
        Start-Sleep -Seconds 1
        continue
      }
      $ans = Read-Line $T.prReAsk
      if ($null -eq $ans) { return }
      $txt = $ans.Trim()
      if ($txt -ne '') {
        $r = Invoke-State ('prio reorder "' + $txt + '"')
        if ($null -eq $r) {
          Write-Host $T.prNoData -ForegroundColor Red
        } elseif ($r.ok) {
          Write-Host $T.prSaved -ForegroundColor Green
        } else {
          Write-Host ('  [!] ' + $r.error) -ForegroundColor Yellow
        }
      }
      Pause-Key
    }
    elseif ($c -eq '3') {
      $r = Invoke-State 'prio clear'
      if ($null -ne $r -and $r.ok) { Write-Host $T.prCleared -ForegroundColor Green }
      Pause-Key
    }
    else {
      Write-Host $T.badChoice -ForegroundColor Yellow
      Start-Sleep -Seconds 1
    }
  }
}

# ══════════════════════ 页面 2：定时抢设置 ══════════════════════
function Page-Timed {
  $quitPage = $false
  while (-not $quitPage) {
    $st = Invoke-State 'prio show'
    Show-Header $T.tmTitle
    # 开关真状态放在最上面：它决定「下面这个设置明天到底会不会生效」。
    #   放在下面（原稿）不行——ssh 不通时 $st 为 null 会提前 return，这行就看不见了。
    Show-Switch (Get-Switch)
    Write-Host ''
    if ($null -eq $st) {
      Write-Host $T.prNoData -ForegroundColor Red
      Pause-Key
      return
    }
    $mode = [string]$st.timed.mode
    if ($mode -eq 'window') {
      Write-Host ($T.tmCurWindow + [string]$st.timed.window) -ForegroundColor Cyan
    } elseif ($mode -eq 'priority') {
      Write-Host $T.tmCurPriority -ForegroundColor Cyan
    } else {
      Write-Host $T.tmCurConfig -ForegroundColor Cyan
    }
    $list = @($st.priority)
    if ($list.Count -gt 0) {
      Write-Host ($T.tmPrio + ($list -join ' > ')) -ForegroundColor DarkGray
    } else {
      Write-Host $T.tmNoPrio -ForegroundColor DarkGray
    }
    Write-Host $T.tmHint1 -ForegroundColor DarkGray
    Write-Host $T.tmHint2 -ForegroundColor DarkGray
    Write-Host ''
    Write-Host $T.tm1
    Write-Host $T.tm2
    Write-Host $T.tm0
    Write-Host ''
    $line = Read-Line $T.prompt
    if ($null -eq $line) { return }
    $c = $line.Trim()
    if ($c -eq '0') { $quitPage = $true }
    elseif ($c -eq '1') {
      $r = Invoke-State 'timed priority'
      if ($null -ne $r -and $r.ok) {
        Write-Host $T.tmSaved -ForegroundColor Green
        Offer-SwitchOn
      }
      Pause-Key
    }
    elseif ($c -eq '2') {
      $win = Read-Window
      if ($win -eq '') { continue }
      Write-Host ($T.winTitle + $win) -ForegroundColor Cyan
      $r = Invoke-State ('timed window ' + $win)
      if ($null -ne $r -and $r.ok) {
        Write-Host $T.tmSaved -ForegroundColor Green
        Offer-SwitchOn
      }
      Pause-Key
    }
    else {
      Write-Host $T.badChoice -ForegroundColor Yellow
      Start-Sleep -Seconds 1
    }
  }
}

# ══════════════════════ 页面 3：状态与开关 ══════════════════════
function Page-Status {
  $quitPage = $false
  while (-not $quitPage) {
    Show-Header $T.stTitle
    Show-Switch (Get-Switch)
    Write-Host ''
    $r = Invoke-RouterRaw 'status'
    if ($r.code -ne 0) { Write-Host $T.stNoStatus -ForegroundColor Red }
    foreach ($l in $r.out) { Write-Host ('  ' + $l) }
    $st = Invoke-State 'prio show'
    if ($null -ne $st) {
      Write-Host ''
      Write-Host $T.stPrefs -ForegroundColor DarkGray
      $list = @($st.priority)
      if ($list.Count -gt 0) {
        Write-Host ($T.tmPrio + ($list -join ' > ')) -ForegroundColor Cyan
      } else {
        Write-Host $T.tmNoPrio -ForegroundColor DarkGray
      }
      $mode = [string]$st.timed.mode
      if ($mode -eq 'window') {
        Write-Host ($T.tmCurWindow + [string]$st.timed.window) -ForegroundColor Cyan
      } elseif ($mode -eq 'priority') {
        Write-Host $T.tmCurPriority -ForegroundColor Cyan
      } else {
        Write-Host $T.tmCurConfig -ForegroundColor DarkGray
      }
    }
    Write-Host ''
    Write-Host $T.st1
    Write-Host $T.st2
    Write-Host $T.st0
    Write-Host ''
    $line = Read-Line $T.prompt
    if ($null -eq $line) { return }
    $c = $line.Trim()
    if ($c -eq '0') { $quitPage = $true }
    elseif ($c -eq '1') {
      $code = Invoke-Router 'off'
      if ($code -eq 0) { Write-Host $T.stOffDone -ForegroundColor Green }
      else { Write-Host ($T.stOpFailA + $code + $T.stOpFailB) -ForegroundColor Red }
      Pause-Key
    }
    elseif ($c -eq '2') {
      $code = Invoke-Router 'on'
      if ($code -eq 0) { Write-Host $T.stOnDone -ForegroundColor Green }
      else { Write-Host ($T.stOpFailA + $code + $T.stOpFailB) -ForegroundColor Red }
      Pause-Key
    }
    else {
      Write-Host $T.badChoice -ForegroundColor Yellow
      Start-Sleep -Seconds 1
    }
  }
}

# ══════════════════════ 页面 4：马上抢 / 帮买 ══════════════════════
function Show-Days($days) {
  for ($i = 0; $i -lt $days.Count; $i++) {
    $d = $days[$i]
    $tag = $T.byFull
    if ($d.ok -and [int]$d.openSlots -gt 0) {
      $tag = ([string]$d.openSlots + $T.bySlotsUnit)
    }
    Write-Host ('    [' + ($i + 1) + '] ' + [string]$d.date + '  ' + [string]$d.weekday + '   ' + $tag)
  }
  Write-Host ('    [0] ' + $T.byBack)
}

function Page-Buy {
  Show-Header $T.byTitle
  Write-Host $T.byLoading -ForegroundColor DarkGray
  $data = Invoke-State 'avail --days 3 --json'
  if ($null -eq $data -or -not $data.ok) {
    Write-Host $T.byNoData -ForegroundColor Red
    Pause-Key
    return
  }
  $days = @($data.days)
  $quitPage = $false
  while (-not $quitPage) {
    Show-Header $T.byTitle
    Write-Host $T.byPickDay
    Write-Host ''
    Show-Days $days
    Write-Host ''
    $line = Read-Line $T.prompt
    if ($null -eq $line) { return }
    $c = $line.Trim()
    if ($c -eq '0') { return }
    $idx = 0
    if (-not [int]::TryParse($c, [ref]$idx)) {
      Write-Host $T.badChoice -ForegroundColor Yellow
      Start-Sleep -Seconds 1
      continue
    }
    if ($idx -lt 1 -or $idx -gt $days.Count) {
      Write-Host $T.badChoice -ForegroundColor Yellow
      Start-Sleep -Seconds 1
      continue
    }
    $d = $days[$idx - 1]
    $slots = @($d.slots)
    if (-not $d.ok -or $slots.Count -eq 0) {
      Write-Host ''
      Write-Host ([string]$d.date + '：' + [string]$d.message) -ForegroundColor Yellow
      Write-Host $T.byBackPage -ForegroundColor DarkGray
      Pause-Key
      continue
    }
    # ── 选时段 ──
    Show-Header ($T.byTitle + '  ·  ' + [string]$d.date + ' ' + [string]$d.weekday)
    Write-Host $T.bySlotsTitle
    Write-Host ''
    for ($j = 0; $j -lt $slots.Count; $j++) {
      $s = $slots[$j]
      $cs = @($s.courts)
      $names = ($cs | ForEach-Object { [string]$_.name }) -join '、'
      Write-Host ('    [' + ($j + 1) + '] ' + [string]$s.time + '   ' + [string]$s.count + $T.byCourtsUnit + '  ' + $names)
    }
    Write-Host ('    [0] ' + $T.byBackDay)
    Write-Host ''
    $line2 = Read-Line $T.prompt
    if ($null -eq $line2) { return }
    if ($line2.Trim() -eq '0') { continue }
    $k = 0
    if (-not [int]::TryParse($line2.Trim(), [ref]$k)) {
      Write-Host $T.badChoice -ForegroundColor Yellow
      Start-Sleep -Seconds 1
      continue
    }
    if ($k -lt 1 -or $k -gt $slots.Count) {
      Write-Host $T.badChoice -ForegroundColor Yellow
      Start-Sleep -Seconds 1
      continue
    }
    $slot = $slots[$k - 1]
    $cs = @($slot.courts)
    # ── 选场地（只有一片就不问）──
    $courtId = ''
    if ($cs.Count -eq 1) {
      $courtId = [string]$cs[0].id
    } elseif ($cs.Count -gt 1) {
      Write-Host ''
      Write-Host $T.byCourtAsk
      Write-Host ''
      for ($m = 0; $m -lt $cs.Count; $m++) {
        Write-Host ('    [' + ($m + 1) + '] ' + [string]$cs[$m].name)
      }
      Write-Host ('    [0] ' + $T.byCourtAny)
      $line3 = Read-Line $T.byCourtPrompt
      if ($null -eq $line3) { return }
      $t3 = $line3.Trim()
      if ($t3 -ne '' -and $t3 -ne '0') {
        $n = 0
        if ([int]::TryParse($t3, [ref]$n)) {
          if ($n -ge 1 -and $n -le $cs.Count) { $courtId = [string]$cs[$n - 1].id }
        }
      }
    }
    # ── 确认 + 下单 ──
    $lines = @(
      ('     ' + $T.byCdDate + [string]$d.date + '  ' + [string]$d.weekday),
      ('     ' + $T.byCdSlot + [string]$slot.time)
    )
    if ($courtId -ne '') {
      $picked = ''
      foreach ($x in $cs) { if ([string]$x.id -eq $courtId) { $picked = [string]$x.name } }
      if ($picked -eq '') { $picked = $courtId }
      $lines += ('     ' + $T.byCdCourt + $picked)
    }
    $lines += ('     ' + $T.byCdPay)
    if (-not (Confirm-Yes $T.byConfirmTitle $lines)) { continue }
    $act = 'buy --date ' + [string]$d.date + ' --window ' + [string]$slot.time
    if ($courtId -ne '') { $act = $act + ' --court ' + $courtId }
    $rc = Invoke-Router $act
    if ($rc -eq 0) { Write-Host $T.byOk -ForegroundColor Green }
    elseif ($rc -eq 3) { Write-Host $T.byAlready -ForegroundColor Yellow }
    else { Write-Host $T.byFailed -ForegroundColor Yellow }
    Pause-Key
    return
  }
}

# ══════════════════════ 主循环 ══════════════════════
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host ''
  Write-Host $T.noNodeA -ForegroundColor Yellow
  Write-Host $T.noNodeB -ForegroundColor Yellow
  Pause-Key
}

# ── 主页：直接显示「开没开、抢哪天、抢哪几段、上次怎样」──────────────────
#    2026-11-11 改版：以前开没开要进 [4] 才看得到，用户连着几天以为设好了、
#    其实开关是关的。现在主页一次性摊开，开抢只要 [1]。
function Show-Home($p) {
  Write-Host ''
  Write-Host $T.homeTitle -ForegroundColor Cyan
  if ($null -eq $p -or -not $p.ok) {
    Write-Host $T.homeOffline -ForegroundColor Red
    return
  }
  $swOn = ([string]$p.switch -eq 'on')
  if ($swOn) {
    Write-Host ($T.homeSwitch + $T.homeOn) -ForegroundColor Green
  } else {
    Write-Host ($T.homeSwitch + $T.homeOff) -ForegroundColor DarkGray
  }
  if ([string]$p.mode -eq 'once') {
    Write-Host ($T.homeMode + $T.homeModeOnce) -ForegroundColor Yellow
  } else {
    Write-Host ($T.homeMode + $T.homeModeDefault)
  }
  Write-Host ($T.homeTarget + [string]$p.target + '（' + [string]$p.weekday + '）')
  if ($swOn) {
    Write-Host ($T.homePlan1 + [string]$p.runAt + $T.homePlanMid + [string]$p.rescueAt + $T.homePlan2) -ForegroundColor DarkGray
  } else {
    Write-Host $T.homePlanOff -ForegroundColor DarkGray
  }
  $pl = @($p.priority)
  if ($pl.Count -gt 0 -and [string]$pl[0] -ne '') {
    Write-Host ($T.homePriority + ($pl -join '  →  '))
  } else {
    Write-Host ($T.homePriority + $T.homePriorityNone) -ForegroundColor DarkGray
  }
  $last = $p.last
  if ($null -ne $last -and [string]$last.status -ne '') {
    $lt = [string]$last.status + ' · ' + [string]$last.targetDate
    $sl = @($last.slots)
    if ($sl.Count -gt 0 -and [string]$sl[0] -ne '') { $lt = $lt + ' · ' + ($sl -join '、') }
    if ([string]$last.orderNo -ne '') { $lt = $lt + ' · 订单 ' + [string]$last.orderNo }
    if ([string]$last.targetDate -ne [string]$p.target) { $lt = $lt + $T.homeLastOld }
    Write-Host ($T.homeLast + $lt)
  } else {
    Write-Host ($T.homeLast + $T.homeLastNone) -ForegroundColor DarkGray
  }
}

function Get-Plan {
  try { return (Invoke-State 'plan') } catch { return $null }
}

function Do-ArmDefault {
  $r = Invoke-RouterRaw 'arm default'
  if ($r.code -ne 0) {
    Write-Host $T.homeOffline -ForegroundColor Red
    return
  }
  Write-Host ''
  Write-Host $T.homeArmed -ForegroundColor Green
}

function Do-ArmOnce {
  $line = Read-Line $T.homeOnceAsk
  if ($null -eq $line) { return }
  $line = $line.Trim()
  if ($line -eq '') { return }
  $r = Invoke-RouterRaw ('arm once "' + $line + '"')
  if ($r.code -ne 0) {
    Write-Host ($r.out -join ' ') -ForegroundColor Red
    return
  }
  Write-Host ''
  Write-Host ($T.homeArmed + '这一次按：' + $line) -ForegroundColor Green
}

$quit = $false
while (-not $quit) {
  Show-Header $T.title
  Show-Home (Get-Plan)
  Write-Host ''
  Write-Host $T.p1
  Write-Host $T.p2
  Write-Host $T.p3 -ForegroundColor Yellow
  Write-Host $T.p4
  Write-Host $T.p5
  Write-Host $T.m0
  Write-Host ''
  Write-Host $T.noteA -ForegroundColor DarkGray
  Write-Host $T.noteB -ForegroundColor DarkGray
  Write-Host ''
  $line = Read-Line $T.prompt
  if ($null -eq $line) {
    Write-Host ''
    Write-Host $T.eofBye -ForegroundColor DarkGray
    break
  }
  $c = $line.Trim()
  if ($c -eq '1') {
    Write-Host ''
    Write-Host $T.homeArmTitle -ForegroundColor Cyan
    Write-Host $T.homeArmDefault
    Write-Host $T.homeArmOnce
    Write-Host $T.m0
    $a = Read-Line $T.prompt
    if ($null -ne $a) {
      $a = $a.Trim()
      if ($a -eq '1') { Do-ArmDefault }
      elseif ($a -eq '2') { Do-ArmOnce }
    }
    Pause-Key
  }
  elseif ($c -eq '2') {
    $r = Invoke-RouterRaw 'disarm'
    Write-Host ''
    if ($r.code -eq 0) {
      Write-Host $T.homeDisarmed -ForegroundColor Green
    } else {
      Write-Host $T.homeOffline -ForegroundColor Red
    }
    Pause-Key
  }
  elseif ($c -eq '3') { Page-Buy }
  elseif ($c -eq '4') { Page-Priority }
  elseif ($c -eq '5') { Page-Status }
  elseif ($c -eq '0') { $quit = $true }
  else {
    Write-Host $T.badChoice -ForegroundColor Yellow
    Start-Sleep -Seconds 1
  }
}

Write-Host ''
Write-Host $T.bye -ForegroundColor Cyan
`;

function writeCrlf(file, text, bom) {
  const body = text.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
  const buf = bom
    ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body, 'utf8')])
    : Buffer.from(body, 'utf8');
  fs.writeFileSync(file, buf);
  return buf.length;
}

// 输出目录：默认仓库根目录（软路由版自己用）；
//   node recon/build-menu.js --out=pc-version   → 给开源版生成一份
// 工具目录名：主项目叫 recon/，开源版叫 tools/（由 make-release.js 传进来），
//   只影响「生成的文件里怎么指路」，不影响这个脚本自己的位置。
const OUT_ARG = process.argv.find((a) => a.startsWith('--out='));
const OUT_DIR = OUT_ARG ? path.resolve(ROOT, OUT_ARG.slice('--out='.length)) : ROOT;
const TOOL_ARG = process.argv.find((a) => a.startsWith('--tool-dir='));
const TOOL_DIR = TOOL_ARG ? TOOL_ARG.slice('--tool-dir='.length).replace(/\/+$/, '') : 'recon';
if (OUT_DIR !== ROOT) fs.mkdirSync(OUT_DIR, { recursive: true });
const head = TOOL_DIR === 'recon' ? HEAD : HEAD.split('recon/build-menu.js').join(TOOL_DIR + '/build-menu.js');

const batPath = path.join(OUT_DIR, 'qiangchang.bat');
const ps1Path = path.join(OUT_DIR, 'qiangchang-menu.ps1');
const txtPath = path.join(OUT_DIR, 'qiangchang-menu.text.json');

const nBat = writeCrlf(batPath, BAT, false);
const nTxt = writeCrlf(txtPath, JSON.stringify(T, null, 2) + '\n', false);
const nPs1 = writeCrlf(ps1Path, head, true);

console.log('已生成：');
console.log('  qiangchang.bat               ' + nBat + ' 字节（纯 ASCII，无 BOM）');
console.log('  qiangchang-menu.text.json    ' + nTxt + ' 字节（UTF-8，无 BOM）');
console.log('  qiangchang-menu.ps1          ' + nPs1 + ' 字节（UTF-8 带 BOM，CRLF）');

// 自检：bat 必须全是 ASCII
const batBuf = fs.readFileSync(batPath);
const badByte = batBuf.findIndex((b) => b > 0x7f);
if (badByte >= 0) {
  console.error('!! qiangchang.bat 第 ' + badByte + ' 字节不是 ASCII，cmd.exe 会解析出错');
  process.exit(1);
}
console.log('自检通过：qiangchang.bat 全 ASCII；ps1 首字节 BOM = ' +
  (fs.readFileSync(ps1Path)[0] === 0xef ? '有' : '无'));

// 自检：ps1 里的正则必须带着反斜杠活下来。
//   ★ 这里踩过一次：HEAD 是 JS 模板字符串，`\s` / `\d` 不是合法转义，
//     会被 JS 直接吃掉反斜杠，写出来的 ps1 变成 '^s*(d{1,2})' ——
//     于是「18-20」这种最正常的输入也被判成看不懂。必须在源里写 `\\s` / `\\d`。
const ps1Text = fs.readFileSync(ps1Path, 'utf8');
const needBackslash = ['\\d{1,2}', '\\s*$'];
for (const frag of needBackslash) {
  if (!ps1Text.includes(frag)) {
    console.error('!! qiangchang-menu.ps1 里丢了正则片段「' + frag + '」——' +
      '八成是模板字符串把 \\ 吃掉了（要写成 \\\\）');
    process.exit(1);
  }
}
if (/'[^']*\bs\{1,2\}\b[^']*'|\(d\{2\}\)|\[1-9\]d\?/.test(ps1Text)) {
  console.error('!! qiangchang-menu.ps1 里出现了被吃掉反斜杠的正则（形如 s* / d{2}）');
  process.exit(1);
}

// 自检：文案文件必须能被 JS 正确解析（它是 JSON，中文不能是乱码）
try {
  const back = JSON.parse(fs.readFileSync(txtPath, 'utf8'));
  if (!back.title || !back.prTitle || !back.byTitle) throw new Error('缺关键文案');
} catch (e) {
  console.error('!! qiangchang-menu.text.json 坏了：' + e.message);
  process.exit(1);
}
console.log('自检通过：文案 JSON 可解析，中文键齐全。');
