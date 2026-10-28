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
  { key: 'sh',   name: '上证综指', tx: 'sh000001', ifd: '000001.SH', dj: 'SH000001' },
  { key: 'hs300', name: '沪深300', tx: 'sh000300', ifd: '000300.SH', dj: 'SH000300' },
  { key: 'zz500', name: '中证500', tx: 'sh000905', ifd: '000905.SH', dj: 'SH000905' },
  { key: 'zz800', name: '中证800', tx: 'sh000906', ifd: '000906.SH', dj: 'SH000906' },
  { key: 'zz1000', name: '中证1000', tx: 'sh000852', ifd: '000852.SH', dj: 'SH000852' },
  { key: 'kc50',  name: '科创50',  tx: 'sh000688', ifd: '000688.SH', dj: 'SH000688' },
  { key: 'kcz',   name: '科创综指', tx: 'sh000680', ifd: '000680.SH', dj: 'SH000680' },
  { key: 'cyb',   name: '创业板指', tx: 'sz399006', ifd: '399006.SZ', dj: 'SZ399006' },
  { key: 'sz50',  name: '上证50',  tx: 'sh000016', ifd: '000016.SH', dj: 'SH000016' },
  { key: 'hl',   name: '中证红利', tx: 'sh000922', ifd: '000922.CSI', dj: 'SH000922' },
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

/* ---------------- iFinD 估值 / 利率 ---------------- */
async function ifindValuation(code, at, years = 10) {
  if (!at) return null;
  const start = new Date(Date.now() - years * 365 * 86400e3).toISOString().slice(0, 10);
  const out = {};
  for (const [k, ind] of [['pe', IND_ID.pe], ['pb', IND_ID.pb]]) {
    if (!ind) continue;
    try {
      const rows = await ifind.dateSerial(code, [{ indicator: ind, indiparams: [''] }], start, TODAY, at);
      const w = toWeekly(rows.map(r => [String(r.time).slice(0, 10), ifind.num(r[ind])])
        .filter(r => r[0] && Number.isFinite(r[1])).sort((a, b) => a[0].localeCompare(b[0])));
      if (w.length) out[k] = w;
    } catch { /* 指标 ID 不对就跳过，页面标注无数据 */ }
    await sleep(150);
  }
  return Object.keys(out).length ? out : null;
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
  let val = await ifindValuation(it.ifd, at, 10);
  let pe = val?.pe ? last(val.pe)[1] : null;
  let pb = val?.pb ? last(val.pb)[1] : null;
  let pePct = val?.pe ? pctRank(val.pe.map(x => x[1]), pe) : null;
  let pbPct = val?.pb ? pctRank(val.pb.map(x => x[1]), pb) : null;
  let valSrc = pePct != null ? 'iFinD' : null;
  if (pePct == null) {
    const dj = await djValuation(it.dj);
    if (dj) { pe = dj.pe; pb = dj.pb; pePct = dj.pePct; pbPct = dj.pbPct; valSrc = '蛋卷估值'; }
  }
  indices.push({
    ...it,
    close: cur ? cur[1] : null,
    chgW: chg(cur?.[1], pw?.[1]),
    chgM: chg(cur?.[1], pm?.[1]),
    chgY: chg(cur?.[1], py?.[1]),
    pe, pb, pePct, pbPct, valSrc,
    div: null, roe: null,
    // 没有估值数据时用价格分位兜底（口径不同，页面会标注）
    pricePct: pctRank(w.map(x => x[1]), cur ? cur[1] : null),
    peHist: val?.pe ? val.pe.slice(-260) : null,
    priceHist: w.slice(-260),
  });
  await sleep(120);
}

/* 2、股债性价比：ERP = 1/PE(沪深300) − 10Y 国债收益率 */
const bond = await ifindBond(at, 10);
const hs = indices.find(i => i.key === 'hs300');
let erp = null;
if (bond?.y10 && hs?.pe) {
  const y = cut(bond.y10); const peSeries = cut((await ifindValuation('000300.SH', at, 10))?.pe);
  if (peSeries) {
    const yMap = new Map(y);
    const pairs = peSeries.map(([d, pe]) => [d, (1 / pe) * 100 - (yMap.get(d) ?? last(y)[1])])
      .filter(p => Number.isFinite(p[1]));
    const curV = (1 / hs.pe) * 100 - last(y)[1];
    erp = {
      pe: Math.round(hs.pe * 100) / 100,
      y10: last(y)[1],
      value: Math.round(curV * 100) / 100,
      pct: pctRank(pairs.map(p => p[1]), curV),
      hist: pairs.slice(-260),
    };
  }
}

/* 2.5、没有国债收益率时，至少把盈利收益率摆出来 */
if (!erp && hs && hs.pe) {
  erp = { partial: true, pe: hs.pe, ey: Math.round((100 / hs.pe) * 100) / 100, pePct: hs.pePct, peSrc: hs.valSrc };
}

/* 3、债市 */
let bondOut = null;
if (bond) {
  const pick = (k) => {
    const s = cut(bond[k]);
    if (!s) return null;
    const c = last(s)[1], p = prev(s)?.[1];
    return { v: c, chgW: p != null ? Math.round((c - p) * 100) / 100 : null, pct: pctRank(s.map(x => x[1]), c), hist: s.slice(-260) };
  };
  const y10 = pick('y10'), y1 = pick('y1'), dr = pick('dr007'), cr = pick('credit');
  bondOut = {
    y10, y1, dr007: dr, credit: cr,
    term: (y10 && y1) ? Math.round((y10.v - y1.v) * 100) / 100 : null,
    spread: (cr && y10) ? Math.round((cr.v - y10.v) * 100) / 100 : null,
  };
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
  indices: indices.map(i => ({ name: i.name, chgW: i.chgW, pe: i.pe, pePct: i.pePct, pbPct: i.pbPct })),
  styles: styles.map(s => ({ name: s.name, chgW: s.chgW, chgM: s.chgM, chgY: s.chgY })),
});

let comment = { by: '规则' };
if (DS_KEY) {
  const prompt = [
    '你是券商策略分析师。下面是 A 股当周的客观数据（JSON），请据此输出解读。',
    facts,
    '',
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
    bond: bondOut ? 'iFinD' : '未接入（iFinD 无 EDB/债券权限或本月额度用尽）',
  },
  erp, bond: bondOut, indices, styles, comment,
};
writeFileSync(resolve(ROOT, 'data/assets.json'), JSON.stringify(out, null, 1));
console.log('assets 完成：指数', indices.length, '｜风格', styles.length,
  '｜ERP', erp ? `${erp.value}% (${erp.pct}%分位)` : '无',
  '｜债市', bondOut ? '有' : '无', '｜解读', comment.by);
