/**
 * 东八区时间工具
 * --------------------------------------------
 * 全系统统一使用 Asia/Shanghai (UTC+8)。
 * 所有日志、飞书通知、Webhook timestamp、回测时间轴均以此为准。
 *
 * 注意：Webhook 中的 timestamp 字段使用东八区"当前 Unix 毫秒时间戳"。
 * Unix 毫秒本身与时区无关（绝对时间），但展示与计算（如日切）以东八区为基准。
 */
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
const customParseFormat = require('dayjs/plugin/customParseFormat');

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);

const TZ = 'Asia/Shanghai';

/** 当前东八区 dayjs 对象 */
function nowCN() {
  return dayjs().tz(TZ);
}

/** 当前 Unix 毫秒（绝对时间） */
function nowMs() {
  return Date.now();
}

/**
 * 将 Unix 毫秒格式化为东八区可读字符串
 * @param {number} ms
 * @param {string} fmt
 */
function formatMs(ms, fmt = 'YYYY-MM-DD HH:mm:ss') {
  return dayjs(ms).tz(TZ).format(fmt);
}

/** 当前东八区时间格式化字符串 */
function formatNow(fmt = 'YYYY-MM-DD HH:mm:ss') {
  return nowCN().format(fmt);
}

/** 将"YYYY-MM-DD"东八区日期字符串转为该日 00:00:00 的 Unix 毫秒 */
function dateStrToMs(dateStr, hms = '00:00:00') {
  return dayjs.tz(`${dateStr} ${hms}`, 'YYYY-MM-DD HH:mm:ss', TZ).valueOf();
}

/** 取某个时间所在东八区"自然日"的 0 点 Unix 毫秒 */
function startOfDayCN(ms = Date.now()) {
  return dayjs(ms).tz(TZ).startOf('day').valueOf();
}

/** 判断两个 Unix 毫秒是否在同一东八区自然日 */
function isSameDayCN(a, b) {
  return startOfDayCN(a) === startOfDayCN(b);
}

/** Unix 毫秒 -> ISO + 东八区偏移 */
function toIsoCN(ms) {
  return dayjs(ms).tz(TZ).format('YYYY-MM-DDTHH:mm:ss+08:00');
}

module.exports = {
  TZ,
  nowCN,
  nowMs,
  formatMs,
  formatNow,
  dateStrToMs,
  startOfDayCN,
  isSameDayCN,
  toIsoCN,
};
