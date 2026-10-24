'use strict';
/**
 * 日志：同时输出到控制台与 logs/run-YYYYMMDD-HHMMSS.log，便于事后复盘 08:00 那一刻发生了什么。
 */

const fs = require('fs');
const path = require('path');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

class Logger {
  constructor(opts = {}) {
    this.level = LEVELS[opts.level || 'info'] || 20;
    this.verbose = !!opts.verbose;
    this.lines = [];
    this.stream = null;
    if (opts.dir) {
      fs.mkdirSync(opts.dir, { recursive: true });
      const stamp = stampName();
      this.file = path.join(opts.dir, `run-${stamp}.log`);
      this.stream = fs.createWriteStream(this.file, { flags: 'a' });
    }
  }

  _write(level, args) {
    if (LEVELS[level] < this.level) return;
    if (level === 'debug' && !this.verbose) return;
    const ts = nowStamp();
    const msg = args
      .map((a) => (typeof a === 'string' ? a : safeJson(a)))
      .join(' ');
    const line = `[${ts}] ${level.toUpperCase().padEnd(5)} ${msg}`;
    this.lines.push(line);
    const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
    out.write(line + '\n');
    if (this.stream) this.stream.write(line + '\n');
  }

  debug(...a) { this._write('debug', a); }
  info(...a) { this._write('info', a); }
  warn(...a) { this._write('warn', a); }
  error(...a) { this._write('error', a); }

  section(title) {
    const bar = '─'.repeat(Math.max(8, 68 - title.length));
    this.info(`\n${title} ${bar}`);
  }

  close() {
    if (this.stream) { try { this.stream.end(); } catch (e) { /* ignore */ } }
  }
}

function pad(n, w = 2) { return String(n).padStart(w, '0'); }

function nowStamp() {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function stampName() {
  const d = new Date();
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function safeJson(v) {
  try { return JSON.stringify(v); } catch (e) { return String(v); }
}

module.exports = { Logger };
