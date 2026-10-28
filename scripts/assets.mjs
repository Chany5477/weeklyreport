/**
 * 扩展板块数据：股债性价比、债市、主要指数估值分位、基金风格
 * 数据源优先级：iFinD（需 refresh_token）→ 腾讯行情免费源 → 无数据（页面标注）
 * 结果写入 data/assets.json，由 build.mjs 渲染
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import * as ifind from './ifind.mjs';

const pexec = promisify(execFile);
const ROOT = ifind.ROOT;
const TODAY = new Date().toISOString().slice(0, 10);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ---------------- 指数清单 ---------------- */
// tx: 腾讯行情代码（免费源兜底）；ifd: iFinD 代码；dj: 蛋卷估值代码
export const INDICES = [
  { key: 'sh',   name: '上证综指', tx: 'sh000001', ifd: '000001.SH', dj: 'SH000001', ask: '000001.SH' },
  { key: 'hs300', name: '沪深300', tx: 'sh000300', ifd: '000300.SH', dj: 'SH000300', ask: '000300.SH' },
  { key: 'zz500', name: '中证500', tx: 'sh000905', ifd: '000905.SH', dj: 'SH000905', ask: '000905.SH' },
  { key: 'zz800', name: '中证800', tx: 'sh000906', ifd: '000906.SH', dj: 'SH000906', ask: '000906.SH' },
  { key: 'zz1000', name: '中证1000', tx: 'sh000852', ifd: '000852.SH', dj: 'SH000852', ask: '000852.SH' },
  { key: 'kc50',  name: '科创50',  tx: 'sh000688', ifd: '000688.SH', dj: 'SH000688', ask: '科创50' },
  { key: 'kcz',   name: '科创综指', tx: 'sh000680', ifd: '000680.SH', dj: 'SH000680', ask: '科创综指' },
  { key: 'cyb',   name: '创业板指', tx: 'sz399006', ifd: '399006.SZ', dj: 'SZ399006', ask: '399006.SZ' },
  { key: 'sz50',  name: '上证50',  tx: 'sh000016', ifd: '000016.SH', dj: 'SH000016', ask: '000016.SH' },
  { key: 'hl',   name: '中证红利', tx: 'sh000922', ifd: '000922.CSI', dj: 'SH000922', ask: '' },
];

// 基金风格代表指数（用户指定走中证指数系列）
export const STYLES = [
  { key: 'bond_pure', name: '纯债',   desc: '债券型基金指数', ifd: 'H11023.CSI', tx: '' },
  { key: 'bond_mix',  name: '混债',   desc: '混合型基金指数', ifd: 'H11022.CSI', tx: '' },
  { key: 'dividend',  name: '红利',   desc: '中证红利',       ifd: '000922.CSI', tx: 'sh000922' },
  { key: 'growth',    name: '成长',   desc: '沪深300成长',    ifd: '000918.CSI', tx: 'sh000918' },
  { key: 'value',     name: '价值',   desc: '沪深300价值',    ifd: '000919.CSI', tx: 'sh000919' },
  { key: 'balanced',  name: '均衡',   desc: '中证800',        ifd: '000906.SH',  tx: 'sh000906' },
  { key: 'quant',     name: '量化',   desc: '中证1000（指增主流基准）', ifd: '000852.SH', tx: 'sh000852' },
  { key: 'active',    name: '主动',   desc: '中证主动偏股基金', ifd: '932055.CSI', tx: '' },
];

// 债市代理标的：iFinD 没有 EDB 权限，拿不到国债收益率本身，
// 但债券 ETF / 国债指数的价格是行情数据（有权限），可以用价格反推债市表现与收益率变化方向。
export const BONDP = [
  { key: 'etf10',  name: '十年国债ETF',   desc: '511260，跟踪中债10年期国债', ifd: '511260.SH', dur: 8.5 },
  { key: 'etf30',  name: '三十年国债ETF', desc: '511090，长端利率风向标',     ifd: '511090.SH', dur: 20 },
  { key: 'etf5',   name: '五年国债ETF',   desc: '511010，中短端',             ifd: '511010.SH', dur: 4.5 },
  { key: 'credit', name: '城投债ETF',     desc: '511220，信用债代表',         ifd: '511220.SH', dur: 3 },
  { key: 'bondIdx', name: '上证国债指数', desc: '000012，交易所国债整体',     ifd: '000012.SH', dur: 0 },
  { key: 'fundIdx', name: '债券型基金指数', desc: 'H11023，公募纯债收益',     ifd: 'H11023.CSI', dur: 0 },
];

/* iFinD 指标 ID：跑 scripts/ifind-probe.mjs 后按探测结果填 */
const IND_ID = {
  pe: process.env.IFIND_IND_PE || 'ths_pe_ttm_index',
  pb: process.env.IFIND_IND_PB || 'ths_pb_index',
  y10: process.env.IFIND_EDB_Y10 || '',   // 10 年国债收益率
  y1: process.env.IFIND_EDB_Y1 || '',     // 1 年国债收益率
  dr007: process.env.IFIND_EDB_DR007 || '',
  credit: process.env.IFIND_EDB_CREDIT || '', // 5 年 AA+ 中票收益率
};

/* ---------------- 免费源：腾讯日线（分段取，缓存周线） ---------------- */
async function txRange(code, start, end) {
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${code},day,${start},${end},320,qfq`;
  const { stdout } = await pexec('curl', ['-sS', '-m', '25', url], { maxBuffer: 16 * 1024 * 1024 });
  const j = JSON.parse(stdout);
  const d = (j.data || {})[code] || {};
  const arr = d.qfqday || d.day || [];
  return arr.map(r => [r[0], Number(r[2])]).filter(r => Number.isFinite(r[1]));
}

const toWeekly = (daily) => {
  const out = [];
  let key = null;
  for (const [date, v] of daily) {
    const t = new Date(date + 'T00:00:00');
    t.setDate(t.getDate() - ((t.getDay() + 6) % 7));
    const k = t.toISOString().slice(0, 10);
    if (k !== key) { key = k; out.push([date, v]); } else out[out.length - 1] = [date, v];
  }
  return out;
};

/** 取某个代码的周线序列（十年），带本地缓存，每周只增量更新 */
async function weeklySeries(code, ifdCode, years = 10) {
  const dir = resolve(ROOT, 'data/hist');
  mkdirSync(dir, { recursive: true });
  const f = resolve(dir, `${code || ifdCode}.json`);
  let cached = [];
  if (existsSync(f)) {
    try { cached = JSON.parse(readFileSync(f, 'utf8')); } catch { cached = []; }
  }
  const lastDate = cached.length ? cached[cached.length - 1][0] : '';
  const stale = lastDate < TODAY;
  if (cached.length && !stale) return cached;

  let fresh = [];
  if (cached.length) {
    const start = new Date(Date.now() - 90 * 86400e3).toISOString().slice(0, 10);
    if (code) fresh = await txRange(code, start, TODAY).catch(() => []);
  }
  if (!code || !fresh.length) {
    // iFinD 一次取十年
    const at = await ifind.accessToken().catch(() => null);
    if (at && ifdCode) {
      const start = new Date(Date.now() - years * 365 * 86400e3).toISOString().slice(0, 10);
      fresh = (await ifind.historyQuotes(ifdCode, start, TODAY, 'close', at).catch(() => []))
        .map(r => [String(r.time).slice(0, 10), ifind.num(r.close)])
        .filter(r => r[0] && Number.isFinite(r[1]))
        .sort((a, b) => a[0].localeCompare(b[0]));
    }
    if (!fresh.length && code) {
      // 免费源：逐年拼十年
      const y0 = new Date().getFullYear() - years + 1, y1 = new Date().getFullYear();
      for (let y = y0; y <= y1; y++) {
        const part = await txRange(code, `${y}-01-01`, `${y}-12-31`).catch(() => []);
        fresh = fresh.concat(part);
        await sleep(120);
      }
    }
  }
  const merged = new Map(cached.map(r => [r[0], r[1]]));
  for (const [d, v] of fresh) merged.set(d, v);
  const weekly = toWeekly([...merged.entries()].sort((a, b) => a[0].localeCompare(b[0])));
  if (weekly.length) writeFileSync(f, JSON.stringify(weekly));
  return weekly.length ? weekly : cached;
}

/* ---------------- 分位 ---------------- */
function pctRank(hist, val) {
  const arr = hist.filter(v => Number.isFinite(v));
  if (!arr.length || !Number.isFinite(val)) return null;
  const below = arr.filter(v => v < val).length;
  return Math.round((below / arr.length) * 1000) / 10;
}
const chg = (a, b) => (Number.isFinite(a) && Number.isFinite(b) && b) ? Math.round(((a / b - 1) * 100) * 100) / 100 : null;
const last = (s) => (s.length ? s[s.length - 1] : null);
const prev = (s, n = 1) => (s.length > n ? s[s.length - 1 - n] : null);

/* ---------------- iFinD 估值（问财接口） ----------------
 * 说明：账号没有「指数估值」数据包，date_sequence 的 ths_pe_ttm_index 一律返回 null；
 * 但问财（smart_stock_picking）可以回答「沪深300 2017年1月3日至2017年12月29日 市盈率」，
 * 一次返回该区间全部交易日的 PE（约 248 个），所以按年分段就能自己拼出十年 PE 序列并算分位。
 */
const cnDate = (d) => `${+d.slice(0, 4)}年${+d.slice(5, 7)}月${+d.slice(8, 10)}日`;

async function askIndex(at, query) {
  const r = await ifind.call('smart_stock_picking', { searchstring: query, searchtype: 'index' }, at);
  const t = (r.tables || [])[0]?.table || {};
  return t;
}

/** 取一个指数某区间的日频 PE；expect 用来校验问财有没有认错指数 */
async function askPeRange(ask, expect, start, end, at) {
  const t = await askIndex(at, `${ask} ${cnDate(start)}至${cnDate(end)} 市盈率`);
  const codes = t['指数代码'] || [];
  if (expect && codes.length && !String(codes[0]).startsWith(expect)) return [];  // 认错指数就当没数据
  const out = [];
  for (const [k, v] of Object.entries(t)) {
    const m = k.match(/市盈率[^\[]*\[(\d{8})\]/);
    if (!m) continue;
    const val = Array.isArray(v) ? v.find(x => Number.isFinite(Number(x))) : v;
    if (val == null || !Number.isFinite(Number(val))) continue;
    out.push([`${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6, 8)}`, Number(val)]);
  }
  return out.sort((a, b) => a[0].localeCompare(b[0]));
}

/** 取当前 PB（问财只给最新值，不给历史序列） */
async function askPbNow(name, at) {
  const t = await askIndex(at, `${name} 市净率`);
  for (const [k, v] of Object.entries(t)) {
    if (!k.includes('市净率')) continue;
    const val = Array.isArray(v) ? v.find(x => Number.isFinite(Number(x))) : v;
    if (val != null && Number(val) > 0) return Math.round(Number(val) * 1000) / 1000;
  }
  return null;
}

/** 十年日频 PE（带缓存，每周增量） */
async function peSeries(key, ask, expect, at, years = 10) {
  if (!at || !ask) return null;
  const dir = resolve(ROOT, 'data/hist');
  mkdirSync(dir, { recursive: true });
  const f = resolve(dir, `pe-${key}.json`);
  let cached = [];
  if (existsSync(f)) { try { cached = JSON.parse(readFileSync(f, 'utf8')); } catch { cached = []; } }
  const lastDate = cached.length ? cached[cached.length - 1][0] : '';
  if (cached.length && lastDate >= AS_OF) return cached;

  let fresh = [];
  if (cached.length) {
    fresh = await askPeRange(ask, expect, new Date(Date.now() - 120 * 86400e3).toISOString().slice(0, 10), TODAY, at).catch(() => []);
  }
  if (cached.length < 200) {
    // 首次构建：按年分段取十年
    const y1 = new Date().getFullYear();
    for (let y = y1 - years + 1; y <= y1; y++) {
      const part = await askPeRange(ask, expect, `${y}-01-01`, `${y}-12-31`, at).catch(() => []);
      fresh = fresh.concat(part);
      await sleep(200);
    }
  }
  const merged = new Map(cached.map(r => [r[0], r[1]]));
  for (const [d, v] of fresh) merged.set(d, v);
  const all = [...merged.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  if (all.length) writeFileSync(f, JSON.stringify(all));
  return all.length ? all : cached;
}

/** 蛋卷估值兜底：iFinD 指数估值无权限时用它，给当前 PE / PB 与分位 */
async function djValuation(djCode) {
  if (!djCode) return null;
  try {
    const { stdout } = await pexec('curl', ['-sS', '-m', '20', '-H', 'User-Agent: Mozilla/5.0',
      `https://danjuanfunds.com/djapi/index_eva/detail/${djCode}`], { maxBuffer: 4 * 1024 * 1024 });
    const d = JSON.parse(stdout)?.data;
    if (!d || !d.pe) return null;
    return {
      pe: Math.round(d.pe * 100) / 100,
      pb: d.pb ? Math.round(d.pb * 1000) / 1000 : null,
      pePct: d.pe_percentile != null ? Math.round(d.pe_percentile * 1000) / 10 : null,
      pbPct: d.pb_percentile != null ? Math.round(d.pb_percentile * 1000) / 10 : null,
      div: d.yeild != null ? Math.round(d.yeild * 10000) / 100 : null,
      roe: d.roe != null ? Math.round(d.roe * 10000) / 100 : null,
    };
  } catch {
    return null;
  }
}

async function ifindBond(at, years = 10) {
  if (!at || !IND_ID.y10) return null;
  const start = new Date(Date.now() - years * 365 * 86400e3).toISOString().slice(0, 10);
  const out = {};
  for (const [k, id] of Object.entries({ y10: IND_ID.y10, y1: IND_ID.y1, dr007: IND_ID.dr007, credit: IND_ID.credit })) {
    if (!id) continue;
    try {
      const rows = await ifind.edb(id, start, TODAY, at);
      const w = toWeekly(rows.map(r => [String(r.time).slice(0, 10), ifind.num(r[id] != null ? r[id] : r.value)])
        .filter(r => r[0] && Number.isFinite(r[1])).sort((a, b) => a[0].localeCompare(b[0])));
      if (w.length) out[k] = w;
    } catch { /* 跳过 */ }
    await sleep(150);
  }
  return Object.keys(out).length ? out : null;
}

/* ---------------- DeepSeek 解读 ---------------- */
const keyFile = resolve(ROOT, 'secrets/deepseek.key');
const DS_KEY = (process.env.DEEPSEEK_API_KEY || (existsSync(keyFile) ? readFileSync(keyFile, 'utf8').trim() : '')).trim();

async function ask(prompt) {
  const body = JSON.stringify({
    model: 'deepseek-chat', messages: [{ role: 'user', content: prompt }],
    temperature: 0.3, response_format: { type: 'json_object' },
  });
  const { stdout } = await pexec('curl', ['-sS', '-m', '120', 'https://api.deepseek.com/chat/completions',
    '-H', 'Content-Type: application/json', '-H', `Authorization: Bearer ${DS_KEY}`, '-d', body], { maxBuffer: 8 * 1024 * 1024 });
  const j = JSON.parse(stdout);
  if (j.error) throw new Error(j.error.message || 'api error');
  const txt = (j?.choices?.[0]?.message?.content || '').replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  return JSON.parse(txt);
}

/* ---------------- 主流程 ---------------- */
const latest = JSON.parse(readFileSync(resolve(ROOT, 'data/latest.json'), 'utf8'));
// 与周报口径一致：所有数据截止到本周最后一个交易日
const AS_OF = latest.week?.end || TODAY;
const cut = (w) => (w || []).filter(x => x[0] <= AS_OF);
const at = await ifind.accessToken().catch(e => { console.log('iFinD 未接入：', e.message.slice(0, 60)); return null; });

console.log(at ? 'iFinD 已接入' : 'iFinD 未接入（用免费源，估值/利率分位可能缺失）');

/* 1、主要指数：价格 + 估值分位 */
const indices = [];
for (const it of INDICES) {
  const w = cut(await weeklySeries(it.tx, it.ifd, 10));
  const cur = last(w), pw = prev(w), pm = prev(w, 4), py = prev(w, 52);
  // 估值：iFinD 问财取十年日频 PE（自己算分位）+ 当前 PB；蛋卷补 PB 分位与兜底
  const peAll = cut((await peSeries(it.key, it.ask, it.ifd.split('.')[0], at, 10)) || []);
  let pe = peAll.length ? Math.round(peAll[peAll.length - 1][1] * 100) / 100 : null;
  let pePct = pe != null ? pctRank(peAll.map(x => x[1]), pe) : null;
  let peHist = peAll.length ? toWeekly(peAll).slice(-260) : null;
  let valSrc = pePct != null ? 'iFinD 问财' : null;
  let pb = await askPbNow(it.name, at).catch(() => null);
  let pbPct = null;
  const dj = await djValuation(it.dj);
  if (dj) {
    if (pePct == null) { pe = dj.pe; pePct = dj.pePct; valSrc = '蛋卷估值'; }
    if (pb == null) pb = dj.pb;
    pbPct = dj.pbPct;
  }
  indices.push({
    ...it,
    close: cur ? cur[1] : null,
    chgW: chg(cur?.[1], pw?.[1]),
    chgM: chg(cur?.[1], pm?.[1]),
    chgY: chg(cur?.[1], py?.[1]),
    pe, pb, pePct, pbPct, valSrc,
    peLen: peAll.length,
    div: null, roe: null,
    // 没有估值数据时用价格分位兜底（口径不同，页面会标注）
    pricePct: pctRank(w.map(x => x[1]), cur ? cur[1] : null),
    peHist,
    priceHist: w.slice(-260),
  });
  await sleep(120);
}

/* 2、股债性价比：ERP = 1/PE(沪深300) − 10Y 国债收益率 */
let bond = await ifindBond(at, 10);
const hs = indices.find(i => i.key === 'hs300');
let erp = null;
const hsPe = cut((await peSeries('hs300', '000300.SH', '000300', at, 10)) || []);
if (bond?.y10 && hs?.pe) {
  // 国债收益率：有历史就用历史（严格口径）；只有当前值（人工填）就用它代入整段历史，页面上标为近似
  const yArr = Array.isArray(bond.y10) ? cut(bond.y10) : [];
  const yNow = yArr.length ? yArr[yArr.length - 1][1] : bond.y10.v;
  const yMap = new Map(yArr);
  const approx = !yArr.length;
  const pairs = hsPe.map(([d, pe]) => [d, (1 / pe) * 100 - (yMap.get(d) ?? yNow)])
    .filter(p => Number.isFinite(p[1]));
  const curV = (1 / hs.pe) * 100 - yNow;
  erp = {
    pe: Math.round(hs.pe * 100) / 100,
    y10: yNow,
    value: Math.round(curV * 100) / 100,
    pct: pctRank(pairs.map(p => p[1]), curV),
    hist: pairs.slice(-520),
    approx,
  };
}

/* 2.5、没有国债收益率时，先摆"盈利收益率"这一半（十年曲线照画，分位基于 PE） */
if (!erp && hs && hs.pe) {
  const eyHist = toWeekly(hsPe).map(([d, pe]) => [d, Math.round((100 / pe) * 100) / 100]);
  erp = {
    partial: true,
    pe: hs.pe,
    ey: Math.round((100 / hs.pe) * 100) / 100,
    pePct: hs.pePct,
    peSrc: hs.valSrc,
    eyPct: pctRank(eyHist.map(x => x[1]), Math.round((100 / hs.pe) * 100) / 100),
    hist: eyHist.slice(-260),
  };
}

/* 3、债市：iFinD 无 EDB 权限时的兜底 —— data/bond-manual.json 人工填（从 iFinD 终端抄） */
const manualBond = existsSync(resolve(ROOT, 'data/bond-manual.json'))
  ? JSON.parse(readFileSync(resolve(ROOT, 'data/bond-manual.json'), 'utf8')) : null;
if (!bond && manualBond) {
  // 支持两种写法：数字（只给水平值）或 {v, chgW}（顺带给当日变动，单位 bp）
  const one = (v) => (v == null ? null
    : (typeof v === 'object'
      ? { v: v.v, chgW: v.chgW ?? null, pct: v.pct ?? null, hist: v.hist ?? null }
      : { v, chgW: null, pct: null, hist: null }));
  bond = {};
  if (manualBond.y10 != null) bond.y10 = { ...one(manualBond.y10), manual: true };
  if (manualBond.y1 != null) bond.y1 = one(manualBond.y1);
  if (manualBond.y5 != null) bond.y5 = one(manualBond.y5);
  if (manualBond.dr001 != null) bond.dr001 = one(manualBond.dr001);
  if (manualBond.dr007 != null) bond.dr007 = one(manualBond.dr007);
  if (manualBond.credit != null) bond.credit = one(manualBond.credit);
  if (Object.keys(bond).length) console.log('债市：用 data/bond-manual.json 的人工数据');
}

let bondOut = null;
if (bond) {
  const pick = (k) => {
    // 人工填的是 {v, chgW, pct}，接口取的是 [[日期, 值]]，两种都兼容
    if (bond[k] && !Array.isArray(bond[k])) {
      const b = bond[k];
      return { v: b.v, chgW: b.chgW ?? null, pct: b.pct ?? null, hist: b.hist ?? null, manual: !!b.manual };
    }
    const s = cut(bond[k]);
    if (!s || !s.length) return null;
    const c = last(s)[1], p = prev(s)?.[1];
    return { v: c, chgW: p != null ? Math.round((c - p) * 100) / 100 : null, pct: pctRank(s.map(x => x[1]), c), hist: s.slice(-260) };
  };
  const y10 = pick('y10'), y1 = pick('y1'), dr = pick('dr007') || pick('dr001'), cr = pick('credit'), y5 = pick('y5');
  const cMeta = manualBond?.credit && typeof manualBond.credit === 'object' ? manualBond.credit : {};
  const sTerm = cMeta.term || '5Y';
  bondOut = {
    y10, y1, y5, dr007: dr, credit: cr,
    drLabel: manualBond?.dr007 != null ? 'DR007' : (manualBond?.dr001 != null ? 'DR001' : 'DR007'),
    drChg: (manualBond?.dr007 && typeof manualBond.dr007 === 'object' && manualBond.dr007.chgW != null) ? '较前一日' : '周变化',
    term: (y10 && y1) ? Math.round((y10.v - y1.v) * 100) / 100 : null,
    // 信用利差用同期限国债对照（5Y 中票 − 5Y 国债），缺失时退回 10Y 并在标签里注明
    spread: cr ? Math.round((cr.v - (y5?.v ?? y10?.v)) * 100) / 100 : null,
    spreadLabel: cr ? `${cMeta.rating || 'AA+'} ${sTerm} 中票 − ${y5 ? sTerm + ' 国债' : '10Y 国债'}` : null,
    creditMeta: cr ? { rating: cMeta.rating || 'AA+', term: sTerm, v: cr.v, chgW: cr.chgW ?? null } : null,
  };
}

/* 3.5、债市代理标的：债券 ETF / 国债指数的价格（有权限，可自动更新） */
const bondProxy = [];
for (const b of BONDP) {
  const w = cut(await weeklySeries('', b.ifd, 10));
  const cur = last(w), pw = prev(w), pm = prev(w, 4), py = prev(w, 52);
  if (!cur) continue;
  bondProxy.push({
    ...b,
    close: cur[1],
    chgW: chg(cur[1], pw?.[1]),
    chgM: chg(cur[1], pm?.[1]),
    chgY: chg(cur[1], py?.[1]),
    pct: pctRank(w.map(x => x[1]), cur[1]),   // 价格十年分位：越高说明债券越贵、收益率越低
    hist: w.slice(-260),
  });
  await sleep(120);
}

/* 3.6、用十年国债 ETF 的价格推算收益率变化（bp）：Δy ≈ −Δ价格% ÷ 久期 */
let bondDelta = null;
const proxy10 = bondProxy.find(b => b.key === 'etf10');
if (proxy10) {
  const w = cut(await weeklySeries('', proxy10.ifd, 10));
  const compute = (nWeeks) => {
    const c = last(w)?.[1], p = prev(w, nWeeks)?.[1];
    if (!Number.isFinite(c) || !Number.isFinite(p)) return null;
    return Math.round(((c / p - 1) * -100 / proxy10.dur) * 100 * 100) / 100; // 正=收益率上行(bp)
  };
  bondDelta = { w: compute(1), m: compute(4), y: compute(52), dur: proxy10.dur, name: proxy10.name };
}

/* 3.7、人工基准值：先对齐到周报截止日（用户看到的往往是当天值），填一次即可 */
const baseY = manualBond?.y10, baseD = manualBond?.y10AsOf;
if (baseY != null && proxy10 && (!bondOut?.y10 || bondOut.y10.manual)) {
  let v = baseY, note = '';
  const d0 = baseD || TODAY;
  if (d0 !== AS_OF) {
    const rows = await ifind.historyQuotes(proxy10.ifd, d0 < AS_OF ? d0 : AS_OF, d0 > AS_OF ? d0 : AS_OF,
      'close', at).catch(() => []);
    const px = new Map(rows.map(r => [String(r.time).slice(0, 10), ifind.num(r.close)]));
    const pB = px.get(d0), pA = px.get(AS_OF);
    if (Number.isFinite(pB) && Number.isFinite(pA)) {
      // 价格从 asOf 到 base 变动 → 收益率同向反向变动
      const dyPct = -((pB / pA) - 1) * 100 / proxy10.dur;
      v = baseY + dyPct;
      note = `（基准 ${d0} 为 ${baseY}%，按十年国债ETF 涨跌回推到 ${AS_OF}）`;
    }
  }
  v = Math.round(v * 1000) / 1000;
  bondOut = { ...(bondOut || {}), y10: { v, chgW: bondDelta?.w ?? null, pct: null, hist: null, est: true, base: baseY, baseD: d0 } };
  console.log(`债市：10Y ≈ ${v}% ${note || `（人工基准 ${d0}）`}`);
}

/* 3.8、有了收益率基准，就用 ETF 价格反推十年收益率轨迹，再算真正的 ERP 历史与分位 */
if (bondOut?.y10 && hs?.pe && (!erp || erp.partial || erp.approx)) {
  const yAsOf = bondOut.y10.v;
  const rows = await ifind.historyQuotes(proxy10.ifd, '2016-10-01', TODAY, 'close', at).catch(() => []);
  const px = rows.map(r => [String(r.time).slice(0, 10), ifind.num(r.close)])
    .filter(r => r[0] && Number.isFinite(r[1])).sort((a, b) => a[0].localeCompare(b[0]));
  const anchorP = (px.find(r => r[0] === AS_OF) || px[px.length - 1])?.[1];
  if (anchorP) {
    // y10(t) = y10(asOf) + Δy(asOf→t)，Δy ≈ −Δ价格% ÷ 久期
    let i = 0;
    const yAt = (d) => {
      while (i + 1 < px.length && px[i + 1][0] <= d) i++;
      const p = (px[i] && px[i][0] <= d) ? px[i][1] : anchorP;
      return yAsOf - (p / anchorP - 1) * 100 / proxy10.dur;
    };
    const pairs = hsPe.map(([d, pe]) => [d, Math.round(((100 / pe) - yAt(d)) * 100) / 100])
      .filter(p => Number.isFinite(p[1]));
    const curV = Math.round(((100 / hs.pe) - yAsOf) * 100) / 100;
    erp = {
      pe: Math.round(hs.pe * 100) / 100,
      y10: yAsOf,
      value: curV,
      pct: pctRank(pairs.map(p => p[1]), curV),
      hist: toWeekly(pairs).slice(-520),
      approx: 'etf',   // 历史收益率由 ETF 价格反推
    };
  }
}

/* 4、基金风格 */
const styles = [];
for (const s of STYLES) {
  const w = cut(await weeklySeries(s.tx, s.ifd, 3));
  const cur = last(w), pw = prev(w), pm = prev(w, 4), py = prev(w, 52);
  styles.push({ ...s, close: cur ? cur[1] : null, chgW: chg(cur?.[1], pw?.[1]), chgM: chg(cur?.[1], pm?.[1]), chgY: chg(cur?.[1], py?.[1]) });
  await sleep(120);
}

/* 5、解读（DeepSeek，缺 key 时给规则版） */
const facts = JSON.stringify({
  week: latest.week, index: latest.index, tech: latest.tech,
  erp: erp ? { value: erp.value, pct: erp.pct, pe: erp.pe, y10: erp.y10 } : null,
  bond: bondOut ? { y10: bondOut.y10?.v, y10_pct: bondOut.y10?.pct, term: bondOut.term, dr007: bondOut.dr007?.v, spread: bondOut.spread } : null,
  bondProxy: bondProxy.map(b => ({ name: b.name, chgW: b.chgW, chgM: b.chgM, chgY: b.chgY, pct: b.pct })),
  bondDelta,
  indices: indices.map(i => ({ name: i.name, chgW: i.chgW, pe: i.pe, pePct: i.pePct, pbPct: i.pbPct })),
  styles: styles.map(s => ({ name: s.name, chgW: s.chgW, chgM: s.chgM, chgY: s.chgY })),
});

let comment = { by: '规则' };
if (DS_KEY) {
  const prompt = [
    '你是券商策略分析师。下面是 A 股当周的客观数据（JSON），请据此输出解读。',
    facts,
    '',
    '债市没有利率水平数据（iFinD 无 EDB 权限），但有债券 ETF / 国债指数的价格涨跌与十年价格分位（分位越高=债券越贵=收益率越低），请据此解读债市，不要编造具体收益率数字。',
    '输出 JSON，字段如下：',
    '{',
    '  "erp": "股债性价比一句话结论（40~70字，必须提到当前值所处的历史分位含义）",',
    '  "bond": "债市解读（50~80字：利率水平、周变化、对股债的影响）",',
    '  "valuation": "主要指数估值一句话（40~70字，指出哪个指数分位最高/最低）",',
    '  "outlook": {"short":"短期1-4周展望（50~80字）","mid":"中期1-2季度展望（50~80字）","long":"长期一年以上展望（50~80字）"},',
    '  "factors": {"short":["因素1","因素2"],"mid":["因素1","因素2"],"long":["因素1","因素2"]},',
    '  "styleFit": [{"style":"纯债|混债|红利|成长|价值|均衡|量化|主动","short":1-5,"mid":1-5,"long":1-5,"reason":"30字内说明适配/不适配的原因"}]',
    '}',
    '',
    '要求：1) 只能依据上面的数据，不得编造数字；2) styleFit 里 1=最不适配、5=最适配，必须有明确理由；',
    '3) 展望要给出方向和条件，不要含糊；4) 只输出 JSON。',
  ].join('\n');
  try {
    comment = { ...(await ask(prompt)), by: 'DeepSeek' };
  } catch (e) {
    console.log('DeepSeek 解读失败：', String(e.message).slice(0, 80));
  }
}
if (comment.by !== 'DeepSeek') {
  comment.erp = erp ? `沪深300 风险溢价 ${erp.value}%，处于十年 ${erp.pct}% 分位，${erp.pct > 70 ? '股票相对债券偏便宜' : erp.pct < 30 ? '债券相对更划算' : '股债性价比处在中性区间'}。` : '本期缺少估值数据，无法计算股债性价比（需 iFinD 接入）。';
  comment.bond = bondOut ? `10 年国债 ${bondOut.y10?.v}%（十年 ${bondOut.y10?.pct}% 分位），周变化 ${bondOut.y10?.chgW}bp，期限利差 ${bondOut.term}%。` : '本期缺少利率数据（需 iFinD 接入）。';
  comment.valuation = indices.some(i => i.pePct != null) ? '估值分位已列出，见下表。' : '本期缺少估值数据（需 iFinD 接入）。';
  comment.outlook = { short: '待生成', mid: '待生成', long: '待生成' };
  comment.factors = { short: [], mid: [], long: [] };
  comment.styleFit = styles.map(s => ({ style: s.name, short: 3, mid: 3, long: 3, reason: '待生成' }));
}

const out = {
  updated: TODAY,
  asOf: AS_OF,
  src: {
    price: 'iFinD 行情' + (at ? '' : '（未接入，用腾讯兜底）'),
    valuation: (indices.find(i => i.valSrc) || {}).valSrc || '未接入',
    bond: (bondOut && bondOut.y10) ? ((bondOut.y10.est ? '基准值+ETF推算' : (manualBond ? '人工补充（data/bond-manual.json）' : 'iFinD'))) : '未接入（iFinD 无 EDB 权限，用债券 ETF 价格代理）',
  },
  erp, bond: bondOut, bondProxy, bondDelta, indices, styles, comment,
};
writeFileSync(resolve(ROOT, 'data/assets.json'), JSON.stringify(out, null, 1));
console.log('assets 完成：指数', indices.length, '｜风格', styles.length,
  '｜ERP', erp ? `${erp.value}% (${erp.pct}%分位)` : '无',
  '｜债市', bondOut ? '有' : '无', '｜解读', comment.by);
