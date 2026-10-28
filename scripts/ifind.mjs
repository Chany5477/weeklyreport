/**
 * 同花顺 iFinD HTTP API 客户端
 * 协议：refresh_token（长期）→ access_token（7 天）→ POST /api/v1/<接口名>
 * 没有配置 refresh_token 时所有函数返回 null，由调用方降级到免费源。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const pexec = promisify(execFile);
export const ROOT = resolve(new URL('.', import.meta.url).pathname, '..');
const BASE = 'https://quantapi.51ifind.com/api/v1';
const CACHE = resolve(ROOT, '.cache');

export function refreshToken() {
  const f = resolve(ROOT, 'secrets/ifind.token');
  const v = process.env.IFIND_REFRESH_TOKEN || (existsSync(f) ? readFileSync(f, 'utf8').trim() : '');
  return String(v).trim();
}

async function http(path, headers, body) {
  const args = ['-sS', '-m', '60', `${BASE}/${path}`];
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  if (body !== undefined) args.push('-d', JSON.stringify(body));
  const { stdout } = await pexec('curl', args, { maxBuffer: 32 * 1024 * 1024 });
  try {
    return JSON.parse(stdout);
  } catch {
    return { errorcode: -1, errmsg: '返回不是 JSON：' + String(stdout).slice(0, 160) };
  }
}

/** 取当期有效的 access_token，本地缓存 6 天（云端每次新容器，缓存基本用不上） */
export async function accessToken({ force = false } = {}) {
  const rt = refreshToken();
  if (!rt) return null;
  const cf = resolve(CACHE, 'ifind_access.json');
  if (!force && existsSync(cf)) {
    try {
      const c = JSON.parse(readFileSync(cf, 'utf8'));
      if (c.at && Date.now() - c.ts < 6 * 86400 * 1000) return c.at;
    } catch { /* 缓存坏了就重新取 */ }
  }
  const r = await http('get_access_token', { 'Content-Type': 'application/json', refresh_token: rt });
  const at = r?.data?.access_token;
  if (!at) throw new Error('取 access_token 失败：' + (r?.errmsg || r?.errorcode || JSON.stringify(r).slice(0, 120)));
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(cf, JSON.stringify({ at, ts: Date.now() }));
  return at;
}

/** 调一次取数接口；遇到设备/IP 超限时强制刷新 token 再试一次 */
export async function call(endpoint, payload, token) {
  const h = { 'Content-Type': 'application/json' };
  if (token) h.access_token = token;
  let r = await http(endpoint, h, payload);
  const msg = String(r?.errmsg || '');
  if (r?.errorcode && /设备|Device|IP|limit/i.test(msg)) {
    const at = await accessToken({ force: true });
    r = await http(endpoint, { ...h, access_token: at }, payload);
  }
  if (r?.errorcode) throw new Error(`${endpoint} 失败 ${r.errorcode}：${r.errmsg || ''}`.slice(0, 160));
  return r;
}

/** tables → 行数组：{ code, time, ...字段 } */
export function toRows(data) {
  const rows = [];
  for (const t of data?.tables || []) {
    const code = t.thscode || t.code || '';
    const times = Array.isArray(t.time) ? t.time : [];
    const table = t.table || {};
    let n = times.length;
    for (const v of Object.values(table)) if (Array.isArray(v)) n = Math.max(n, v.length);
    for (let i = 0; i < n; i++) {
      const row = { code, time: times[i] || '' };
      for (const [k, v] of Object.entries(table)) row[k] = Array.isArray(v) ? v[i] : v;
      rows.push(row);
    }
  }
  return rows;
}

const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[%,]/g, ''));
  return Number.isFinite(n) ? n : null;
};

/* ---------------- 三类取数封装 ---------------- */

/** 历史行情：日频 OHLC，indicators 用 open,high,low,close,volume */
export async function historyQuotes(codes, start, end, indicators = 'close', token) {
  const r = await call('cmd_history_quotation', {
    codes, indicators, startdate: start, enddate: end, functionpara: { Fill: 'Blank' },
  }, token);
  return toRows(r);
}

/** 日期序列：可带指标的区间数据，如 PE / PB / 收益率 */
export async function dateSerial(codes, indipara, start, end, token) {
  const r = await call('date_sequence', {
    codes, startdate: start, enddate: end, functionpara: { Fill: 'Blank' }, indipara,
  }, token);
  return toRows(r);
}

/** 经济数据库 EDB：宏观/利率序列 */
export async function edb(indicator, start, end, token) {
  const r = await call('edb_service', { indicators: indicator, startdate: start, enddate: end }, token);
  return toRows(r);
}

export { num };
