'use strict';
/**
 * 时间工具
 *
 * 关键设计：全程统一使用「服务器时间线」。
 * 本地时钟可能有偏差，因此不信任 Date.now()，而是先算出与服务器的偏差 offset，
 * 之后所有判断（是否放场、是否到点）都基于 serverNow() = Date.now() + offset。
 * 这样不需要 NTP，也不需要你手动校准电脑时间。
 */

const DAY_MS = 86400000;

/** 本地时间 → "YYYY-MM-DD" */
function fmtDate(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 本地时间 → "HH:MM" */
function fmtTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 本地时间 → "YYYY-MM-DD HH:MM:SS.mmm" */
function fmtFull(ts) {
  const d = new Date(ts);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
  );
}

/** "HH:MM" 或 "HH:MM:SS" → 当天的分钟数 */
function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(hhmm).trim());
  if (!m) throw new Error(`时间格式无法解析: ${hhmm}（应为 HH:MM）`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * 判断 [aStart, aEnd) 是否完全落在 [bStart, bEnd) 之内。
 * 用于「我要 18:00-20:00，这个 19:00-20:00 的场要不要」这类判断。
 */
function contains(outerStart, outerEnd, innerStart, innerEnd) {
  return toMinutes(innerStart) >= toMinutes(outerStart) && toMinutes(innerEnd) <= toMinutes(outerEnd);
}

/** 睡眠（毫秒）*/
function sleep(ms) {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}

/**
 * ★ 把服务端时间戳（如 "2026-10-10 16:09:54"）当**服务器本地时间**解析。
 *
 * 关键：不能用 Date.parse("2026-10-10 16:09:54") —— 那会按**本机时区**解释。
 * 若机器时区不是 Asia/Shanghai，算出的 offset 会整体偏几个小时，
 * 于是「08:00 放场」会被算错。
 * 实测：学校服务器 serverNow 与北京时间一致（UTC+8），故这里按 UTC+8 硬解析。
 */
const SERVER_TZ_OFFSET_MIN = 8 * 60;

function parseServerTs(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  const s = String(v).trim();
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return n < 1e12 ? n * 1000 : n;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?)?/.exec(s);
  if (!m) return null;
  const [, Y, Mo, D, H = '0', Mi = '0', S = '0', Ms = '0'] = m;
  return Date.UTC(+Y, +Mo - 1, +D, +H, +Mi, +S, +Ms.padEnd(3, '0')) - SERVER_TZ_OFFSET_MIN * 60000;
}

/** 服务器时间线：把「服务器时区的墙上时间」格式化成字符串 */
function fmtServer(ts) {
  const d = new Date(ts + SERVER_TZ_OFFSET_MIN * 60000);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
  );
}

/** 服务器时间线 → "YYYY-MM-DD" */
function fmtServerDate(ts) {
  return fmtServer(ts).slice(0, 10);
}

/** "2026-10-12" + "08:00" → 毫秒时间戳（按服务器时区） */
function serverDateTime(dateStr, hhmm) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || '').trim());
  if (!m) return null;
  const t = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || '').trim());
  if (!t) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +t[1], +t[2]) - SERVER_TZ_OFFSET_MIN * 60000;
}

/**
 * 服务器时间线。
 * calibrate() 传入服务器返回的时间，算出偏差；之后 serverNow() 即可当服务器时间用。
 */
class ServerClock {
  constructor() {
    this.offset = 0;
    this.samples = [];
  }

  /**
   * 用一次服务端响应校准。
   * @param {string|number} serverTime 服务端返回的时间（支持 ISO 字符串 / 时间戳）
   * @param {number} t0 发请求前的本地时间
   * @param {number} t1 收到响应后的本地时间
   */
  calibrate(serverTime, t0, t1) {
    const parsed = this._parse(serverTime);
    if (parsed == null) return null;

    // 假设服务端时间对应「请求往返的中点」，可消除一半网络延迟影响
    const localMid = (t0 + t1) / 2;
    const offset = parsed - localMid;
    this.samples.push({ offset, rtt: t1 - t0 });

    // 取 RTT 最小的那次采样，网络抖动影响最小
    this.samples.sort((a, b) => a.rtt - b.rtt);
    if (this.samples.length > 5) this.samples.length = 5;
    this.offset = this.samples[0].offset;
    return this.offset;
  }

  _parse(v) {
    return parseServerTs(v);
  }

  /** 当前服务器时间（毫秒时间戳）*/
  now() {
    return Date.now() + this.offset;
  }

  /** 本地时间（用于日志展示对照）*/
  local() {
    return Date.now();
  }

  get calibrated() {
    return this.samples.length > 0;
  }
}

module.exports = {
  DAY_MS,
  fmtDate,
  fmtTime,
  fmtFull,
  fmtServer,
  fmtServerDate,
  parseServerTs,
  serverDateTime,
  toMinutes,
  contains,
  sleep,
  ServerClock,
};
