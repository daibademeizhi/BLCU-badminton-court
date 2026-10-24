'use strict';
/**
 * 一次性实战入口：给定时运行 + 事后可复盘用。
 *
 *   node src/once.js [grab.js 的参数...]
 *
 * 做的事：
 *   1. 把「本次启动」的时间与命令行写进 logs/once-YYYYMMDD-HHMMSS.log
 *   2. 以子进程方式跑 src/grab.js（参数原样透传），其 stdout/stderr 直接重定向到该日志文件
 *   3. 跑完把日志尾部回显（方便手动运行时看结果），退出码原样返回
 *      （0=抢到/演练完成，1=失败，2=鉴权等配置问题）
 *
 * 为什么不用管道的 stdio：
 *   本机若在受限沙箱下运行，spawn(..., {stdio:['ignore','pipe','pipe']}) 会因无法创建
 *   命名管道而报 EPERM。改成「把日志文件的 fd 直接交给子进程」在受限与正常环境下都成立，
 *   而且计划任务场景本来也不需要实时控制台输出。
 *
 * 为什么不用 .cmd 拼时间戳：
 *   中文系统 %date% 含「周六」，会把文件名与 for 解析搞坏（实测生成 once--.log）。
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const logDir = path.join(root, 'logs');
fs.mkdirSync(logDir, { recursive: true });

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const args = process.argv.slice(2);
const logPath = path.join(logDir, `once-${stamp()}.log`);

function append(line) { fs.appendFileSync(logPath, line + '\n'); }
function say(line) { process.stdout.write(line + '\n'); }

append(`=== 本校 抢场（一次性入口）${new Date().toISOString()} ===`);
append(`工作目录：${root}`);
append(`命令：node src/grab.js ${args.join(' ')}`);
append(`日志：${logPath}`);
append('');
say(`=== 本校 抢场（一次性入口）===`);
say(`命令：node src/grab.js ${args.join(' ')}`);
say(`日志：${logPath}`);

const fd = fs.openSync(logPath, 'a');
let child;
try {
  child = spawn(process.execPath, [path.join('src', 'grab.js'), ...args], {
    cwd: root,
    windowsHide: true,
    stdio: ['ignore', fd, fd],
  });
} catch (e) {
  fs.closeSync(fd);
  append(`启动 grab.js 失败：${e.message}`);
  say(`启动 grab.js 失败：${e.message}`);
  process.exit(1);
}

function tail(n = 25) {
  try {
    const txt = fs.readFileSync(logPath, 'utf8').split(/\r?\n/);
    return txt.slice(Math.max(0, txt.length - n)).filter((l) => l.length);
  } catch (e) { return []; }
}

child.on('error', (e) => {
  try { fs.closeSync(fd); } catch (e2) { /* ignore */ }
  append(`子进程错误：${e.message}`);
  say(`子进程错误：${e.message}`);
  process.exitCode = 1;
});

child.on('close', (code) => {
  try { fs.closeSync(fd); } catch (e) { /* ignore */ }
  append('');
  append(`=== grab.js 退出码 ${code} · ${new Date().toISOString()} ===`);
  say('');
  say('---------------- 日志尾部 ----------------');
  for (const l of tail(25)) say(l);
  say(`=== grab.js 退出码 ${code} ===`);
  process.exitCode = code == null ? 1 : code;
});
