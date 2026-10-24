<#
  schedule.ps1 -- 用 Windows 计划任务实现「到点自动抢场」

  为什么用计划任务而不是软件定时器？
    Windows 任务计划程序能：
      1. 到点把电脑从睡眠里唤醒（WakeToRun）-- 普通定时器做不到；
      2. 错过时间点后补跑（StartWhenAvailable）-- 比如 07:45 时电脑正忙；
      3. 多实例策略（MultipleInstancesPolicy）避免两次任务互相打架。

  用法：
    # 一次性：到点抢一次，跑完任务自己结束（推荐，最省心）
    powershell -ExecutionPolicy Bypass -File deploy\schedule.ps1 -Action InstallOnce

    # 每天：每天固定时间抢一次（不想要了记得 -Action Remove）
    powershell -ExecutionPolicy Bypass -File deploy\schedule.ps1 -Action InstallDaily

    # 看状态 / 删掉
    powershell -ExecutionPolicy Bypass -File deploy\schedule.ps1 -Action Status
    powershell -ExecutionPolicy Bypass -File deploy\schedule.ps1 -Action Remove

  参数：
    -Time       默认 07:45（HH:mm）。请比学校的「放场时间」至少提前 10 分钟。
    -RelDays    抢「今天 + N 天」的场地，默认 2（即三天后的最新场地）。
    -Date       指定日期（YYYY-MM-DD），给了它就忽略 -RelDays。
    -TaskName   任务名，默认 CourtGrab。
    -DryRunOnly 计划任务里跑「预演」，只查不订（先验证链路用）。

  注意：本脚本会自动找 node.exe：优先 PATH，其次项目根目录下的 node.exe，
        最后 C:\node\node.exe。都没有就直接报错。
#>
[CmdletBinding()]
param(
  [ValidateSet('InstallOnce', 'InstallDaily', 'Remove', 'Status')]
  [string]$Action = 'Status',

  [string]$Time = '07:45',
  [string]$TaskName = 'CourtGrab',
  [int]$RelDays = 2,
  [string]$Date = '',
  [switch]$DryRunOnly
)

$ErrorActionPreference = 'Stop'

# 项目根目录 = 本脚本所在目录的上一级
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
if (-not (Test-Path (Join-Path $Root 'src\grab.js'))) {
  throw "找不到 $Root\src\grab.js -- 请把 deploy\schedule.ps1 放在项目目录下的 deploy\ 里。"
}

function Resolve-Node {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  foreach ($p in @((Join-Path $Root 'node.exe'), 'C:\node\node.exe')) {
    if (Test-Path $p) { return $p }
  }
  throw '找不到 node.exe。请先安装 Node.js（>= 18）并确保 node 在 PATH 里。'
}

function Get-Task {
  Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
}

switch ($Action) {
  'Status' {
    $t = Get-Task
    if (-not $t) {
      Write-Host "[$TaskName] 不存在（= 没有开启自动抢场）" -ForegroundColor Yellow
      return
    }
    $info = Get-ScheduledTaskInfo -TaskName $TaskName
    Write-Host "[$TaskName]"
    Write-Host ("  状态        : {0}" -f $t.State)
    Write-Host ("  上次运行    : {0}" -f $info.LastRunTime)
    Write-Host ("  上次结果    : {0}" -f $info.LastTaskResult)
    Write-Host ("  下次运行    : {0}" -f $info.NextRunTime)
    Write-Host ("  执行        : {0} {1}" -f $t.Actions[0].Execute, $t.Actions[0].Arguments)
    return
  }

  'Remove' {
    if (Get-Task) {
      Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
      Write-Host "[$TaskName] 已删除 -- 自动抢场已关闭。" -ForegroundColor Green
    } else {
      Write-Host "[$TaskName] 本来就不存在，什么都没做。" -ForegroundColor Yellow
    }
    return
  }
}

# ---------- 下面都是「安装」路径 ----------

# 1. 起点时间：今天（或指定日期）的这个钟点
if ($Time -notmatch '^\d{1,2}:\d{2}$') { throw "-Time 格式应为 HH:mm，例如 07:45" }
$hh, $mm = $Time.Split(':') | ForEach-Object { [int]$_ }
if ($hh -gt 23 -or $mm -gt 59) { throw "-Time 不是合法时间：$Time" }

if ($Date) {
  $day = [datetime]::ParseExact($Date, 'yyyy-MM-dd', $null)
} else {
  $day = (Get-Date).Date
}
$start = $day.AddHours($hh).AddMinutes($mm)
if ($start -le (Get-Date)) {
  Write-Host "提示：$start 已经过去了，" -NoNewline -ForegroundColor Yellow
  if ($Action -eq 'InstallDaily') {
    Write-Host '每日任务会从明天开始生效。' -ForegroundColor Yellow
  } else {
    $start = $start.AddDays(1)
    Write-Host "一次性任务顺延到 $start。" -ForegroundColor Yellow
  }
}

# 2. 计划任务要执行的命令行
$node = Resolve-Node
$nodeArgs = @((Join-Path $Root 'src\once.js'), '--rel', $RelDays)
if ($Date) { $nodeArgs += @('--date', $Date) }
if ($DryRunOnly) { $nodeArgs += '--dry-run' }
$argLine = ($nodeArgs | ForEach-Object {
    $s = [string]$_
    if ($s -match '\s') { '"' + $s + '"' } else { $s }
  }) -join ' '

# 3. 动作 / 触发器 / 设置
$action = New-ScheduledTaskAction -Execute $node -Argument $argLine -WorkingDirectory $Root

if ($Action -eq 'InstallDaily') {
  $trigger = New-ScheduledTaskTrigger -Daily -At $start
} else {
  $trigger = New-ScheduledTaskTrigger -Once -At $start
}

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Hours 1)
$settings.WakeToRun = $true
$settings.DisallowStartIfOnBatteries = $false

# 4. 注册（同名重复注册 = 覆盖）
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null

$t = Get-Task
Write-Host "[$TaskName] 已创建。" -ForegroundColor Green
Write-Host ("  执行        : {0} {1}" -f $action.Execute, $action.Arguments)
Write-Host ("  首次运行    : {0}" -f $start)
Write-Host ("  唤醒计算机  : {0}" -f $t.Settings.WakeToRun)
Write-Host ("  错过就补跑  : {0}" -f $t.Settings.StartWhenAvailable)
if ($Action -eq 'InstallOnce') {
  Write-Host '  说明：这是一次性任务，跑完就结束，不需要再手动关闭。' -ForegroundColor Cyan
} else {
  Write-Host '  说明：这是每日任务。不想要了执行： powershell -File deploy\schedule.ps1 -Action Remove' -ForegroundColor Cyan
}
