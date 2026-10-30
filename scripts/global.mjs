/**
 * 海外与外部环境：美股 / 亚太欧洲股指 / 恐慌指数 / 汇率 / 黄金原油
 * 数据源：新浪历史日K（美股、商品） + iFinD（港股、日经、DAX、费半、VIX、离岸人民币）
 * 为什么两个源：iFinD 取不到标普/道指/商品（各种后缀都报 -4210），新浪的历史日K 是免费且完整的。
 * 输出 data/global.json，由 assets.mjs 读取
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import * as ifind from './ifind.mjs';

const pexec = promisify(execFile);
const ROOT = new URL('..', import.meta.url).pathname;
const TODAY = new Date().toISOString().slice(0, 10);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const SINA_US = [['.INX', '标普500', '股指'], ['.IXIC', '纳斯达克', '股指'], ['.DJI', '道琼斯', '股指']];
const SINA_FU = [['GC', 'COMEX黄金', '商品'], ['OIL', '布伦特原油', '商品']];
const IFD = [
  ['HSI.HK', '恒生指数', '股指'], ['N225.GI', '日经225', '股指'], ['GDAXI.GI', '德国DAX', '股指'],
  ['SOX.GI', '费城半导体', '股指'], ['VIX.GI', 'VIX恐慌指数', '情绪'], ['USDCNH.FX', '离岸人民币', '汇率'],
];

const shift = (d, days) => new Date(new Date(d + 'T00:00:00Z').getTime() + days * 86400e3).toISOString().slice(0, 10);

/** 当前值在序列中的百分位（0=最低，100=最高） */
function pctRank(arr, v) {
  const a = arr.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const below = a.filter(x => x < v).length;
  return Math.round(below / a.length * 100);
}

/** rows: [[date, close]] 升序；算周涨跌（本周 vs 上周同期）与十年分位 */
function metrics(rows, asOf) {
  rows = rows.filter(r => r[0] && Number.isFinite(r[1])).sort((a, b) => a[0].localeCompare(b[0]));
  const cur = rows.filter(r => r[0] <= asOf).pop();
  const prev = rows.filter(r => r[0] <= shift(asOf, -7)).pop();
  if (!cur) return null;
  const chgW = (cur && prev) ? Math.round((cur[1] / prev[1] - 1) * 10000) / 100 : null;
  const win = rows.filter(r => r[0] >= shift(asOf, -3650));
  const pct = win.length > 200 ? pctRank(win.map(r => r[1]), cur[1]) : null;
  // 分位图：近五年周度
  const hist = [];
  for (let i = 0; i < win.length; i += 5) hist.push([win[i][0], Math.round(win[i][1] * 100) / 100]);
  return { close: Math.round(cur[1] * 10000) / 10000, date: cur[0], chgW, pct, hist: hist.slice(-260) };
}

async function curl(url, ref = 'https://finance.sina.com.cn') {
  const { stdout } = await pexec('curl', ['-sS', '-m', '30', '-H', `Referer: ${ref}`, url],
    { maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

/** 新浪日K：返回 var _([...]) */
function parseSinaK(stdout, dateKey = 'd') {
  const m = stdout.match(/var\s+_\((\[[\s\S]*\])\)/);
  if (!m) return [];
  let arr;
  try { arr = JSON.parse(m[1]); } catch { return []; }
  return arr.map(r => [String(r[dateKey] || r.date || '').slice(0, 10), parseFloat(r.c ?? r.close)])
    .filter(r => r[0]);
}

async function fromSina(sym, isFuture) {
  const url = isFuture
    ? `https://stock.finance.sina.com.cn/futures/api/jsonp.php/var%20_/GlobalFuturesService.getGlobalFuturesDailyKLine?symbol=${encodeURIComponent(sym)}`
    : `https://stock.finance.sina.com.cn/usstock/api/jsonp.php/var%20_/US_MinKService.getDailyK?symbol=${encodeURIComponent(sym)}&___qn=3`;
  const rows = parseSinaK(await curl(url));
  return rows.length > 30 ? rows : [];
}

async function fromIfind(code, at) {
  const rows = await ifind.historyQuotes(code, shift(TODAY, -3700), TODAY, 'close', at).catch(() => []);
  return rows.map(r => [String(r.time).slice(0, 10), ifind.num(r.close)]).filter(r => r[0]);
}

/* ---------- 主流程 ---------- */
let asOf = TODAY;
try {
  asOf = JSON.parse(readFileSync(resolve(ROOT, 'data/latest.json'), 'utf8'))?.week?.end || TODAY;
} catch { /* 没有 latest.json 就用今天 */ }

const at = await ifind.accessToken().catch(() => null);
const out = [];

for (const [sym, name, group] of [...SINA_US, ...SINA_FU]) {
  const rows = await fromSina(sym, SINA_FU.some(f => f[0] === sym));
  const m = rows.length ? metrics(rows, asOf) : null;
  out.push({ name, group, src: '新浪财经', ...(m || { close: null, chgW: null, pct: null, hist: [] }) });
  console.log(`  ${name.padEnd(10)} ${m ? `周 ${m.chgW > 0 ? '+' : ''}${m.chgW}%  分位 ${m.pct}%` : '无数据'}`);
  await sleep(150);
}

for (const [code, name, group] of IFD) {
  let rows = [];
  if (at) rows = await fromIfind(code, at);
  const m = rows.length ? metrics(rows, asOf) : null;
  out.push({ name, group, src: rows.length ? 'iFinD' : '未取到', ...(m || { close: null, chgW: null, pct: null, hist: [] }) });
  console.log(`  ${name.padEnd(10)} ${m ? `周 ${m.chgW > 0 ? '+' : ''}${m.chgW}%  分位 ${m.pct}%` : '无数据'}`);
  await sleep(150);
}

writeFileSync(resolve(ROOT, 'data/global.json'),
  JSON.stringify({ generatedAt: new Date().toISOString(), asOf, items: out }, null, 1));
console.log(`海外数据：${out.filter(x => x.chgW != null).length}/${out.length} 个标的 → data/global.json（截至 ${asOf}）`);
