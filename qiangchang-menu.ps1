# ==========================================================================
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
$Known  = Join-Path $env:LOCALAPPDATA 'dsh-ssh\known_hosts'
# ── 软路由连接信息（开源版是占位值，请改成你自己的）──────────────────────
#   也可以不改这里，而是在同目录放一个 menu.local.json 覆盖（该文件已被 .gitignore 排除）：
#     { "remote": "root@<路由器IP>", "key": ".ssh\\id_ed25519", "ctl": "sh /root/blcu/grab-ctl.sh" }
$LocalFile = Join-Path $Root 'menu.local.json'
$Remote = 'root@<路由器IP>'
$Key    = Join-Path $Root '.ssh\id_ed25519'
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
    $m = [regex]::Match($raw, '^\s*(\d{1,2})(?::(\d{2}))?\s*[-~—–－至到]\s*(\d{1,2})(?::(\d{2}))?\s*$')
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
