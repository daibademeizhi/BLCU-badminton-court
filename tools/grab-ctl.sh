#!/bin/sh
# /root/blcu/grab-ctl.sh — 远端自助控制台（一条 ssh 命令就能用，不用进交互式 shell）
#
#   登录路由器后直接跑：
#     sh /root/blcu/grab-ctl.sh            # 看状态（默认）
#     sh /root/blcu/grab-ctl.sh on         # 打开定时自动抢场
#     sh /root/blcu/grab-ctl.sh off        # 关闭定时自动抢场（推荐保持关闭）
#     sh /root/blcu/grab-ctl.sh go         # 立刻手动抢一次（T+2 = 最新放出的那天）
#     sh /root/blcu/grab-ctl.sh dry        # 只看会抢哪一场，不下单
#     sh /root/blcu/grab-ctl.sh go 1       # 抢 T+1（明天）
#     sh /root/blcu/grab-ctl.sh go --window 18:00-20:00
#                                          # ★ 只用这个时间段抢（严格模式，不兜底）
#     sh /root/blcu/grab-ctl.sh dry --window 18-20
#                                          # ★ 先预演这个时间段（18-20 是简写）
#     sh /root/blcu/grab-ctl.sh result     # 看上一次的结果
#     sh /root/blcu/grab-ctl.sh log        # 看最近一次运行日志的末尾
#
#   ★ 这就是「开关」：on/off 控制定时任务；go 是你亲手按下的一次性扳机。
#   ★ 参数是「透传」的：go/dry 后面除了可以跟天数（1/2），也可以跟 --window/--slots，
#     原样交给 go.sh → src/grab.js。多条参数用空格分隔即可。
set -u
cd /root/blcu || exit 1
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
CMD="${1:-status}"
shift 2>/dev/null || true

case "$CMD" in
  on)   exec sh /root/blcu/toggle.sh on ;;
  off)  exec sh /root/blcu/toggle.sh off ;;
  # ── 一键开抢（2026-11-11 菜单改版用）──────────────────────────────────
  #   arm default            默认优先级 + 打开开关
  #   arm once "16-18,17-19" 只这一次用这组顺序 + 打开开关
  #   两者都输出一行 JSON（state.js plan），菜单直接拿来渲染主页。
  arm)
    SUB="${1:-default}"
    [ $# -gt 0 ] && shift
    case "$SUB" in
      default) node state.js mode-set default >/dev/null || exit 2 ;;
      once)    node state.js mode-set once "$@" >/dev/null || exit 2 ;;
      *)
        echo '{"ok":false,"error":"arm 只认 default / once <优先级>"}'
        exit 2
        ;;
    esac
    sh /root/blcu/toggle.sh on >/dev/null 2>&1
    exec node state.js plan
    ;;
  # ── 订单 / 退订退款（2026-11-11：「帮我加入退款功能」）────────────────
  #   orders                 列出未使用（可退）的订单，输出 JSON
  #   orders --all           连已退款/已使用的也列出来
  #   cancel <bookingno>     预览这条订单（不退）
  #   cancel <bookingno> --yes   真退这一条（一小时）
  #   cancel --orderno 134645 --yes  退这一笔订单下所有未使用时段
  orders)
    node src/refund.js --list --json "$@"
    ;;
  cancel)
    [ $# -gt 0 ] || { echo '{"ok":false,"error":"cancel 需要 bookingno（或 --orderno <订单号> --yes）"}'; exit 2; }
    case "$1" in
      --orderno) node src/refund.js --orderno "$2" --yes --json ;;
      --booking) node src/refund.js --booking "$2" --yes --json ;;
      --yes)     echo '{"ok":false,"error":"cancel 后面要先给 bookingno，例如：cancel 255477 --yes"}'; exit 2 ;;
      *)         node src/refund.js --booking "$1" --json "$@" ;;
    esac
    ;;
  # 关掉自动抢场，并把「这一次」的临时优先级清掉（下次开抢重新选）
  disarm)
    sh /root/blcu/toggle.sh off >/dev/null 2>&1
    node state.js mode-set default >/dev/null 2>&1
    exec node state.js plan
    ;;
  # 主页要显示的一行 JSON：开关 + 目标日期 + 优先级 + 上次结果
  plan)
    # 面板主页：state.js plan 的 JSON + 真实开关状态（单行输出，给电脑端菜单解析）
    # 2026-11-11：这里以前是 `node -e '...' "$X" "$SW"` 传参，单引号里的 \" 被 sh 原样带进
    # JS 源码 → SyntaxError、rc=1，菜单主页于是显示「连不上软路由 / 读不到状态」。
    # 现在把 JSON 从 stdin 喂进去，shell 完全不参与拼引号。
    CRON_BIN="$(command -v crontab || echo /usr/sbin/crontab)"
    SW="off"
    "$CRON_BIN" -l 2>/dev/null | grep -q '^45 7 \* \* \*' && SW="on"
    node state.js plan 2>/dev/null | node -e 'let d="";process.stdin.on("data",c=>{d+=c});process.stdin.on("end",()=>{try{const j=JSON.parse(d);j.switch=process.argv[1];console.log(JSON.stringify(j));}catch(e){console.log(JSON.stringify({ok:false,error:"plan 解析失败"}))}})' "$SW"
    ;;
  onoff)
    # ★ 机器可读的开关状态：**只输出 on 或 off 一行**，给电脑端菜单解析用。
    #   改这个输出格式会连带弄坏 recon/build-menu.js 里的判读，别动。
    CRON_BIN="$(command -v crontab || echo /usr/sbin/crontab)"
    if "$CRON_BIN" -l 2>/dev/null | grep -q '^45 7 \* \* \*'; then
      echo on
    else
      echo off
    fi
    ;;
  status)
    sh /root/blcu/toggle.sh status
    echo
    # ★★ 2026-10-24 加：「今天到底跑没跑」必须是屏幕上的第一段。
    #   踩过的坑：只看 last-result.json 会得出错的结论 —— 它只在**真跑完**时才写，
    #   没启动不写、dry-run 不写、跑挂了也不写，所以它能停在好几天前的成功记录上，
    #   让人误以为「今早跑了但没抢到」。真正能判断跑没跑的硬证据是当天的 logs/cron-*.log。
    TODAY="$(date +%Y%m%d)"
    TODAY_GRAB="$(ls logs/cron-$TODAY-*.log 2>/dev/null | grep -v -- '-keep\.log$' | head -1)"
    echo "── 今天到底跑没跑（$(date '+%Y-%m-%d %H:%M')）──"
    if [ -n "$TODAY_GRAB" ]; then
      echo "  今天的抢场日志：$TODAY_GRAB"
      echo "    首行：$(head -1 "$TODAY_GRAB" 2>/dev/null | cut -c1-110)"
      echo "    末行：$(tail -1 "$TODAY_GRAB" 2>/dev/null | cut -c1-110)"
    else
      echo "  今天的抢场日志：无 → 07:45 那一趟没有启动"
      echo "    （开关 off、或当时路由器没在线、或 crond 没在跑）"
    fi
    LAST_GRAB="$(ls -t logs/cron-*.log 2>/dev/null | grep -v -- '-keep\.log$' | head -1)"
    if [ -n "$LAST_GRAB" ]; then
      echo "  最近一次抢场日志：$LAST_GRAB"
      echo "    时间 $(date -r "$LAST_GRAB" '+%Y-%m-%d %H:%M' 2>/dev/null)   末行：$(tail -1 "$LAST_GRAB" 2>/dev/null | cut -c1-110)"
    else
      echo "  最近一次抢场日志：一份都没有（从没跑过定时任务）"
    fi
    LAST_KEEP="$(ls -t logs/cron-*-keep.log 2>/dev/null | head -1)"
    LAST_CLOCK="$(grep '^=== ' logs/clock.log 2>/dev/null | tail -1 | sed 's/^=== *//; s/ *===$//')"
    KEEP_TXT="无记录"
    [ -n "$LAST_KEEP" ] && KEEP_TXT="$(date -r "$LAST_KEEP" '+%m-%d %H:%M' 2>/dev/null)"
    echo "  最近一次 token 保活：$KEEP_TXT       最近一次时钟校准：${LAST_CLOCK:-无记录}"
    echo "  现在有 grab.js 在跑：$(ps w 2>/dev/null | grep -c '[g]rab\.js') 个       本次开机 cron 派发 run-grab：$(logread 2>/dev/null | grep -c 'run-grab') 次"
    TARGET="$(node -e 'const d=new Date(Date.now()+2*86400000);const p=n=>String(n).padStart(2,"0");console.log(d.getFullYear()+"-"+p(d.getMonth()+1)+"-"+p(d.getDate()))' 2>/dev/null)"
    echo "  明天 07:45 会抢的目标日期（T+2）：${TARGET:-?}   偏好模式：$(head -1 data/timed.txt 2>/dev/null | tr -d '\r' || echo config)"
    echo
    echo "── 上一次**真抢**的结果（data/last-result.json，可能是几天前的，不代表今天）──"
    node -e '
    try {
      const r = JSON.parse(require("fs").readFileSync("data/last-result.json", "utf8"));
      const keep = ["status","targetDate","orderNo","court","slots","totalPrice","paid","payMessage","at"];
      for (const k of keep) if (k in r && r[k] != null) console.log("  " + k + " = " + JSON.stringify(r[k]));
    } catch (e) { console.log("  （读不到：" + e.message + "）"); }
    '
    echo
    echo "常用：sh /root/blcu/grab-ctl.sh go     # 手动抢一次（T+2）"
    echo "      sh /root/blcu/grab-ctl.sh dry    # 先预演看会抢哪一场"
    echo "      sh /root/blcu/grab-ctl.sh dry --window 18:00-20:00   # 预演一个时间段"
    ;;
  go)
    # 兼容旧用法 `go 2`（纯数字 = 天数），其余参数原样透传给 go.sh
    RELARG=""
    if [ $# -gt 0 ]; then
      case "$1" in
        ''|*[!0-9]*) ;;
        *) RELARG="--rel $1"; shift ;;
      esac
    fi
    exec sh /root/blcu/go.sh $RELARG "$@"
    ;;
  dry|test)
    RELARG=""
    if [ $# -gt 0 ]; then
      case "$1" in
        ''|*[!0-9]*) ;;
        *) RELARG="--rel $1"; shift ;;
      esac
    fi
    exec sh /root/blcu/go.sh --dry $RELARG "$@"
    ;;
  wait)
    exec sh /root/blcu/go.sh --wait "$@"
    ;;
  # ── 偏好设置（菜单里的「优先级设置 / 定时抢设置」用的就是这几个）──
  #     state.js 只读写 data/priority.txt 与 data/timed.txt，绝不碰 config.yaml。
  prio|priority)
    SUB="${1:-show}"
    [ $# -gt 0 ] && shift
    case "$SUB" in
      show|status)    exec node state.js show ;;
      set)            exec node state.js prio-set "$@" ;;
      reorder|order)  exec node state.js prio-reorder "$@" ;;
      clear)          exec node state.js prio-clear ;;
      *)
        echo '{"ok":false,"error":"prio 只认 show / set / reorder / clear"}'
        exit 2
        ;;
    esac
    ;;
  timed)
    SUB="${1:-show}"
    [ $# -gt 0 ] && shift
    case "$SUB" in
      show|status) exec node state.js show ;;
      clear)       exec node state.js timed-clear ;;
      priority)    exec node state.js timed-set priority ;;
      window)      exec node state.js timed-set window "$@" ;;
      *)
        echo '{"ok":false,"error":"timed 只认 show / priority / window <时段> / clear"}'
        exit 2
        ;;
    esac
    ;;
  # ── 只读：这三天还剩哪些场（菜单「马上抢」用来渲染列表）──
  avail)
    exec node src/avail.js "$@"
    ;;
  # ── 帮买：指定日期 + 指定时段（+ 可选场地）立刻下一单 ──
  buy)
    exec sh buy.sh "$@"
    ;;
  result)
    node -e '
    try {
      const r = JSON.parse(require("fs").readFileSync("data/last-result.json", "utf8"));
      console.log(JSON.stringify(r, null, 2));
    } catch (e) { console.log("读不到 data/last-result.json：" + e.message); }
    '
    ;;
  log)
    LOG="$(ls -t logs/run-*.log 2>/dev/null | head -1)"
    echo "（$LOG）"
    tail -60 "$LOG" 2>/dev/null
    ;;
  *)
    echo "用法：sh /root/blcu/grab-ctl.sh [status|on|off|onoff|go [N] [选项…]|dry [N] [选项…]|wait|avail|buy|prio|timed|result|log]"
    echo
    echo "  status  看开关状态 + 今天跑没跑 + 上次真抢结果（默认）"
    echo "  onoff   只输出 on / off（给菜单解析用）"
    echo "  off     关闭定时自动抢场（不下单）"
    echo "  on      打开定时自动抢场（每天 07:45 + 08:30 兜底）"
    echo "  go [N]  立刻手动抢一次；N 省略时抢 T+2（最新放出的那天）"
    echo "  dry [N] 同上但只预演，不下单"
    echo "  wait    目标日期还没放出来时，等到放场时刻再抢"
    echo "  avail   只读：这三天还剩哪些场（--days 3 默认 1 天；--json 给菜单用）"
    echo "  buy     帮买：--date 2026-10-20 --window 18:00-19:00 [--court 场地id]"
    echo "  prio    优先级列表：show / set \"16:00-18:00,17:00-19:00\" / reorder \"3,1,2\" / clear"
    echo "  timed   定时抢模式：show / priority / window 18:00-20:00 / clear"
    echo "  result  打印上次结果全文"
    echo "  log     打印最近一次日志末尾"
    echo
    echo "  时段选项（go / dry / wait 后面都能跟）："
    echo "    --window 18:00-20:00   只在这段时间里抢（严格模式，不会兜底到别的时段）"
    echo "    --window 18-20         简写，等价于 18:00-20:00"
    echo "    --window 18:00-20:00,20:00-22:00   多段备选，靠前的先试"
    echo "    --priority 16:00-18:00,17:00-19:00 按顺序试（偏好，都落空仍允许兜底）"
    echo "    --slots 1              这一单最少凑 1 个时段（默认沿用配置）"
    echo
    echo "  例：sh /root/blcu/grab-ctl.sh dry --window 18:00-20:00"
    echo "      sh /root/blcu/grab-ctl.sh go --window 18-20 --slots 2"
    echo "      sh /root/blcu/grab-ctl.sh prio set \"16:00-18:00,17:00-19:00\""
    exit 2
    ;;
esac
