/**
 * 周度市场回顾数据管道
 * 输出: data/latest.json  (页面只读，不联网)
 *
 * 数据源:
 *  - 指数日线: 腾讯 web.ifzq.gtimg.cn (主) / 东财 push2his (备)
 *  - 行业周线: 申万宏源研究 institute-sw api
 *  - 涨跌家数: 东财 ulist.np (f104/105/106)
 *  - 涨跌停:   东财 push2ex 涨停池/跌停池
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pexec = promisify(execFile);
const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dir, '..');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/* ---------------- 网络层：curl 优先，失败回落 fetch ---------------- */
async function get(url, referer = 'https://finance.sina.com.cn', retry = 2) {
  for (let i = 0; i <= retry; i++) {
    try {
      const { stdout } = await pexec('curl', ['-sS', '--compressed', '-m', '25',
        '-H', `User-Agent: ${UA}`, '-H', `Referer: ${referer}`, url], { maxBuffer: 80 * 1024 * 1024 });
      if (stdout && stdout.trim()) return stdout;
    } catch { /* fallthrough */ }
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, Referer: referer } });
      const t = await r.text();
      if (t && t.trim()) return t;
    } catch { /* fallthrough */ }
    await sleep(600 * (i + 1));
  }
  throw new Error('fetch failed: ' + url.slice(0, 120));
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ---------------- 指数 ---------------- */
const INDICES = [
  { sym: 'sh000001', name: '上证指数', alias: '上证' },
  { sym: 'sh000016', name: '上证50', alias: '上证50' },
  { sym: 'sh000300', name: '沪深300', alias: '沪深300' },
  { sym: 'sh000905', name: '中证500', alias: '中证500' },
  { sym: 'sh000852', name: '中证1000', alias: '中证1000' },
  { sym: 'sh000688', name: '科创50', alias: '科创50' },
  { sym: 'sz399006', name: '创业板指', alias: '创业板指' },
];

async function tencentDay(sym, len = 260) {
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${sym},day,,,${len},qfq`;
  const j = JSON.parse(await get(url));
  const d = j?.data?.[sym];
  const raw = d?.day || d?.qfqday || [];
  // [date, open, close, high, low, volume]
  return raw.map(r => ({
    date: r[0],
    open: +r[1], close: +r[2], high: +r[3], low: +r[4], vol: +r[5],
  }));
}

async function eastDay(secid, len = 260) {
  const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56&klt=101&fqt=1&end=20500101&lmt=${len}`;
  const j = JSON.parse(await get(url, 'https://quote.eastmoney.com/'));
  const ks = j?.data?.klines || [];
  return ks.map(s => {
    const [date, o, c, h, l, v] = s.split(',');
    return { date, open: +o, close: +c, high: +h, low: +l, vol: +v };
  });
}

async function getDaily(sym, secid) {
  try {
    const a = await tencentDay(sym);
    if (a.length > 30) return { rows: a, src: '腾讯行情' };
    throw new Error('short');
  } catch (e) {
    const a = await eastDay(secid);
    if (a.length > 30) return { rows: a, src: '东方财富' };
    throw e;
  }
}

/* ---------------- 申万一级行业 ---------------- */
const SW = [
  ['801010', '农林牧渔'], ['801030', '基础化工'], ['801040', '钢铁'], ['801050', '有色金属'],
  ['801080', '电子'], ['801110', '家用电器'], ['801120', '食品饮料'], ['801130', '纺织服饰'],
  ['801140', '轻工制造'], ['801150', '医药生物'], ['801160', '公用事业'], ['801170', '交通运输'],
  ['801180', '房地产'], ['801200', '商贸零售'], ['801210', '社会服务'], ['801230', '综合'],
  ['801710', '建筑材料'], ['801720', '建筑装饰'], ['801730', '电力设备'], ['801740', '国防军工'],
  ['801750', '计算机'], ['801760', '传媒'], ['801770', '通信'], ['801780', '银行'],
  ['801790', '非银金融'], ['801880', '汽车'], ['801890', '机械设备'], ['801950', '煤炭'],
  ['801960', '石油石化'], ['801970', '环保'], ['801980', '美容护理'],
];

// 取日线，周涨跌/每日异动都由日线推导，口径一致
async function getSW() {
  const out = [];
  for (const [code, name] of SW) {
    const url = `https://www.swsresearch.com/institute-sw/api/index_publish/trend/?swindexcode=${code}&period=DAY`;
    try {
      const arr = JSON.parse(await get(url, 'https://www.swsresearch.com/'))?.data || [];
      const rows = arr.slice(-40).map(r => ({
        date: String(r.bargaindate).slice(0, 10),
        close: +r.closeindex,
        chg: +r.markup,          // 申万自带的当日涨跌幅
        amt: +r.bargainsum,
      })).filter(r => r.date && isFinite(r.close));
      if (rows.length < 12) throw new Error('empty');
      const last = rows[rows.length - 1];
      out.push({ code, name, date: last.date, close: last.close, amt: last.amt, rows });
    } catch {
      out.push({ code, name, chg: null, date: null, rows: [] });
    }
    await sleep(200);
  }
  return out;
}

/* ---------------- 宽度 ---------------- */
async function getBreadth() {
  const url = 'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&secids=1.000001,0.399001&fields=f12,f14,f104,f105,f106';
  const j = JSON.parse(await get(url, 'https://quote.eastmoney.com/'));
  const rows = j?.data?.diff || [];
  const sum = (k) => rows.reduce((a, b) => a + (b[k] || 0), 0);
  return { up: sum('f104'), down: sum('f105'), flat: sum('f106') };
}

async function getLimitPool(kind, date) {
  const pool = kind === 'zt' ? 'getTopicZTPool' : 'getTopicDTPool';
  const sort = kind === 'zt' ? 'fbt%3Aasc' : 'fund%3Aasc';
  const url = `https://push2ex.eastmoney.com/${pool}?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=300&sort=${sort}&date=${date}`;
  const j = JSON.parse(await get(url, 'https://quote.eastmoney.com/'));
  const d = j?.data;
  return { count: d?.tc ?? 0, list: (d?.pool || []).map(p => ({ name: p.n, chg: p.zdp, lbc: p.lbc })) };
}

/* ---------------- 指标 ---------------- */
const pct = (a, b) => (b ? (a / b - 1) * 100 : 0);
const ma = (arr, n) => (arr.length < n ? null : arr.slice(-n).reduce((a, b) => a + b, 0) / n);
const r2 = (v, n = 2) => (v == null || !isFinite(v) ? null : +v.toFixed(n));

/**
 * 周报只认"已经收完的周"：
 * - 周五 15:00（北京）之后 → 本周已收完，用最新交易日
 * - 其余任何时刻（周一至周四、周五盘中、周末）→ 回退到最近一个已收完的周五
 * 这样周五定时任务跑之前，页面始终显示上一周的完整周报，不会冒出半周数据。
 */
function closedWeekAnchor(rows) {
  const bj = new Date(Date.now() + 8 * 3600e3);      // 北京时间（注意：它的 getUTC* 读出来就是北京时间）
  const todayBJ = bj.toISOString().slice(0, 10);
  const dow = (bj.getUTCDay() + 6) % 7;              // 0=周一 … 4=周五
  const mins = bj.getUTCHours() * 60 + bj.getUTCMinutes();
  if (dow === 4 && mins >= 15 * 60 + 35) return rows.length - 1;   // 周五 15:35（定时任务时点）之后才算本周收完
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].date === todayBJ) continue;          // 今天还没收完，跳过
    const d = new Date(rows[i].date + 'T00:00:00Z');
    if ((d.getUTCDay() + 6) % 7 === 4) return i;     // 最近一个已收完的周五
  }
  return rows.length - 1;
}

function weekOf(rows, anchorIdx) {
  // 从 anchor 往前找到本周第一个交易日（同一 ISO 周）
  const anchor = rows[anchorIdx];
  const d = new Date(anchor.date + 'T00:00:00');
  const dow = (d.getDay() + 6) % 7; // 周一=0
  const start = anchorIdx - dow;
  return rows.slice(Math.max(0, start), anchorIdx + 1);
}

// 连涨/连跌周：按自然周的最后一个收盘价比较，而不是日线
function weeklyStreak(rows) {
  const weekClose = [];
  let key = null;
  for (const r of rows) {
    const d = new Date(r.date + 'T00:00:00');
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // 回退到本周一
    const k = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
    if (k !== key) { key = k; weekClose.push(r.close); }
    else weekClose[weekClose.length - 1] = r.close;
  }
  let s = 0;
  for (let i = weekClose.length - 1; i > 0; i--) {
    const up = weekClose[i] > weekClose[i - 1];
    if (s === 0) s = up ? 1 : -1;
    else if ((s > 0 && up) || (s < 0 && !up)) s += up ? 1 : -1;
    else break;
  }
  return s;
}

function analyzeIndex(rows) {
  const last = rows[rows.length - 1];
  const week = weekOf(rows, rows.length - 1);
  const prevIdx = rows.length - 1 - week.length;
  const prevClose = rows[prevIdx]?.close ?? rows[0].close;
  const closes = rows.map(r => r.close);
  const vols = rows.map(r => r.vol);

  // 上周同日序列（用于量能对比）
  const prevWeek = rows.slice(Math.max(0, prevIdx - week.length + 1), prevIdx + 1);

  const daily = week.map((r, i) => {
    const base = i === 0 ? prevClose : week[i - 1].close;
    const gi = rows.findIndex(x => x.date === r.date);
    const vma = ma(rows.slice(Math.max(0, gi - 20), gi).map(x => x.vol), Math.min(20, gi));
    return {
      date: r.date,
      close: r.close,
      chg: r2(pct(r.close, base)),
      amp: r2((r.high - r.low) / base * 100),
      vol: r.vol,
      vr: vma ? r2(r.vol / vma) : null,
    };
  });

  const wVol = week.reduce((a, b) => a + b.vol, 0);
  const pVol = prevWeek.length ? prevWeek.reduce((a, b) => a + b.vol, 0) : null;

  // 当日相对 20 日均量
  const vol20 = ma(vols.slice(0, -1), 20);

  // 连涨/连跌周（周线口径）
  const streak = weeklyStreak(rows);

  // 20 日年化波动率
  const rets = [];
  for (let i = Math.max(1, rows.length - 20); i < rows.length; i++) rets.push(Math.log(rows[i].close / rows[i - 1].close));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length);
  const vol20d = sd * Math.sqrt(244) * 100;

  const ytdRows = rows.slice(-250);
  const yearHigh = Math.max(...ytdRows.map(r => r.high));
  const yearLow = Math.min(...ytdRows.map(r => r.low));

  return {
    name: null,
    lastDate: last.date,
    close: last.close,
    weekChg: r2(pct(last.close, prevClose)),
    weekHigh: Math.max(...week.map(r => r.high)),
    weekLow: Math.min(...week.map(r => r.low)),
    weekAmp: r2((Math.max(...week.map(r => r.high)) - Math.min(...week.map(r => r.low))) / prevClose * 100),
    daily,
    volRatio: pVol ? r2(wVol / pVol) : null,   // 本周/上周 成交量倍数
    volVsMa20: vol20 ? r2(last.vol / vol20) : null,
    ma20: r2(ma(closes, 20)), ma60: r2(ma(closes, 60)), ma120: r2(ma(closes, 120)),
    vsMa20: r2(pct(last.close, ma(closes, 20))),
    vsMa60: r2(pct(last.close, ma(closes, 60))),
    streak,
    vol20d: r2(vol20d),
    yearHigh, yearLow,
    drawdown: r2(pct(last.close, Math.max(...ytdRows.map(r => r.close)))),
  };
}

/* ---------------- 文案（所有数字均来自数据） ---------------- */
function buildNarrative(ctx) {
  const { sh, idxList, industries, breadth, zt, dt, weekStart, weekEnd } = ctx;
  const lead = [...industries].filter(i => i.chg != null).sort((a, b) => b.chg - a.chg);
  const top3 = lead.slice(0, 3), bot3 = lead.slice(-3).reverse();
  const upCount = idxList.filter(i => i.weekChg > 0).length;
  const biggestDay = [...sh.daily].sort((a, b) => Math.abs(b.chg) - Math.abs(a.chg))[0];
  const bigDayLabel = biggestDay ? ['周一', '周二', '周三', '周四', '周五'][sh.daily.indexOf(biggestDay)] : '';

  const dt2 = (s) => s.slice(5).replace('-', '.');
  const range = `${dt2(weekStart)}–${dt2(weekEnd)}`;

  const title = (() => {
    const c = sh.weekChg;
    const n = sh.daily.length;
    const lastDay = sh.daily[n - 1], prevDay = sh.daily[n - 2];
    const lastLabel = ['周一', '周二', '周三', '周四', '周五'][n - 1];
    // 急跌 + 次日放量长下影反包
    if (prevDay && prevDay.chg <= -1 && lastDay.chg >= 0.3 && lastDay.amp >= 2.2)
      return `${range} 急跌后深V反包`;
    if (biggestDay && Math.abs(biggestDay.chg) >= 1.5 && biggestDay.chg < 0)
      return `${range} ${bigDayLabel}杀跌，全周收低`;
    if (biggestDay && Math.abs(biggestDay.chg) >= 1.5 && biggestDay.chg > 0)
      return `${range} ${lastLabel}放量上攻`;
    const style = c <= -2 ? '单边调整' : c < 0 ? '震荡回落' : c < 2 ? '震荡上行' : '强势反弹';
    return `${range} ${style}`;
  })();

  const oneLiner = `上证指数本周${sh.weekChg >= 0 ? '涨' : '跌'}${Math.abs(sh.weekChg).toFixed(2)}%，` +
    `${idxList.length}个主要指数中${upCount}个上涨；` +
    `行业层面${top3[0].name}领涨（${top3[0].chg > 0 ? '+' : ''}${top3[0].chg.toFixed(2)}%），${bot3[0].name}领跌（${bot3[0].chg.toFixed(2)}%）`;

  const volumeText = sh.volRatio == null ? '' :
    `沪市成交量是上周的 ${sh.volRatio.toFixed(2)} 倍，${sh.volRatio > 1.1 ? '属于放量' : sh.volRatio < 0.9 ? '属于缩量' : '整体量能持平'}` +
    (biggestDay && Math.abs(biggestDay.chg) >= 1.5 ? `；${bigDayLabel}${biggestDay.chg > 0 ? '涨' : '跌'}${Math.abs(biggestDay.chg).toFixed(2)}%，是本周最大单日波动` : '');

  const breadthText = breadth ? `周五全市场${breadth.up}涨${breadth.down}跌，涨停${zt}家、跌停${dt}家` : '';

  // 技术面：只挑最突出的一两件事
  const signals = [];
  if (sh.vsMa60 != null) signals.push({ k: '60日均线', v: `${sh.vsMa60 > 0 ? '站上' : '跌破'} ${Math.abs(sh.vsMa60).toFixed(2)}%`, raw: Math.abs(sh.vsMa60) });
  if (sh.drawdown != null) signals.push({ k: '距年内高点', v: `回撤 ${Math.abs(sh.drawdown).toFixed(1)}%`, raw: Math.abs(sh.drawdown) });
  if (sh.vol20d != null) signals.push({ k: '20日年化波动', v: `${sh.vol20d.toFixed(1)}%`, raw: sh.vol20d / 50 });

  /* -------- 下周展望（只基于本周可验证的数字做条件判断，不编造事件） -------- */
  const outlook = [];
  const nl = (v) => Math.round(v);

  if (sh.ma60) {
    const dist = sh.vsMa60;
    if (dist > 0) {
      outlook.push({
        tone: 'pos', t: '中期趋势未破',
        d: `上证收于 ${nl(sh.close)} 点，仍在 60 日均线（${nl(sh.ma60)}）上方 ${dist.toFixed(2)}%。只要不有效跌破该线，中期结构仍属健康，回调可视作再平衡而非趋势反转。`,
      });
    } else {
      outlook.push({
        tone: 'neg', t: '中期趋势承压',
        d: `上证收于 ${nl(sh.close)} 点，位于 60 日均线（${nl(sh.ma60)}）下方 ${Math.abs(dist).toFixed(2)}%，中期均线转为压力位，反弹到该区域需要放量才能突破。`,
      });
    }
  }
  if (sh.volRatio != null) {
    const v = sh.volRatio;
    outlook.push({
      tone: v >= 1.05 ? 'pos' : v <= 0.9 ? 'neg' : 'neu',
      t: v >= 1.05 ? '量能配合' : v <= 0.9 ? '量能不足' : '量能中性',
      d: `本周沪市成交量是上周的 ${v.toFixed(2)} 倍。${v >= 1.05
        ? '下跌过程中放量，说明筹码在换手，一旦指数止跌，承接力会更快显现。'
        : v <= 0.9 ? '缩量意味着抛压不重但增量资金也没进场，反弹的高度取决于下周能否补量。'
          : '量能基本持平，市场处于存量博弈状态，方向选择仍需要新的增量信息。'}`,
    });
  }
  if (top3[0]) {
    const excess = top3[0].chg - sh.weekChg;
    outlook.push({
      tone: 'neu', t: '主线是否成立',
      d: `${top3[0].name}本周 ${top3[0].chg > 0 ? '+' : ''}${top3[0].chg.toFixed(2)}%，相对上证超额 ${excess.toFixed(2)} 个百分点；${bot3[0].name} ${bot3[0].chg.toFixed(2)}%。${excess > 5
        ? '行业分化极大，说明资金在少数方向抱团，这类结构性行情延续性取决于成交量能否维持。'
        : '行业分化温和，属于普涨普跌格局，跟随指数比选行业更重要。'}`,
    });
  }
  if (sh.vol20d != null && sh.vol20d > 22) {
    outlook.push({
      tone: 'neg', t: '波动仍偏高',
      d: `20 日年化波动率 ${sh.vol20d.toFixed(1)}%，处于偏高水平，单日 2% 以上的波动属于常态，仓位上不宜按低波动环境去满仓。`,
    });
  }

  return { title, oneLiner, volumeText, breadthText, top3, bot3, signals, outlook };
}

/* ---------------- 主流程 ---------------- */
async function main() {
  const checks = [];
  const srcUsed = new Set();

  // 指数：先把日线抓回来，确定"已收完的周"之后再统一分析，保证各指数口径一致
  const idxList = [];
  let shRows = null;
  const rawIdx = [];
  for (const it of INDICES) {
    const secid = it.sym.startsWith('sh') ? '1.' + it.sym.slice(2) : '0.' + it.sym.slice(2);
    const { rows, src } = await getDaily(it.sym, secid);
    srcUsed.add('指数日线/' + src);
    if (it.sym === 'sh000001') shRows = rows;
    rawIdx.push({ it, rows });
  }
  const anchorIdx = closedWeekAnchor(shRows);   // 周五收盘前回退到上一个周五
  for (const { it, rows } of rawIdx) {
    const a = analyzeIndex(rows.slice(0, anchorIdx + 1));
    a.name = it.name; a.sym = it.sym;
    idxList.push(a);
  }
  const sh = idxList[0];

  // 行业
  const industries = await getSW();
  srcUsed.add('申万行业/申万宏源官网');

  // 宽度
  // 涨停/跌停等当日数据也按周报最后那一天取，口径才一致
  const weekRows = weekOf(shRows, anchorIdx);
  const weekStart = weekRows[0].date, weekEnd = weekRows[weekRows.length - 1].date;
  const anchorDate = weekEnd.replace(/-/g, '');
  let breadth = null, zt = 0, dt = 0;
  try { breadth = await getBreadth(); srcUsed.add('涨跌家数/东方财富'); }
  catch { checks.push({ key: '涨跌家数', ok: false, msg: '东财涨跌家数接口无响应' }); }
  try { const z = await getLimitPool('zt', anchorDate); zt = z.count; srcUsed.add('涨停池/东方财富'); }
  catch { checks.push({ key: '涨停家数', ok: false, msg: '涨停池接口无响应' }); }
  try { const d = await getLimitPool('dt', anchorDate); dt = d.count; }
  catch { checks.push({ key: '跌停家数', ok: false, msg: '跌停池接口无响应' }); }

  /* -------- 数据闸门 -------- */

  /* -------- 行业：周涨跌 + 每日异动（统一由日线推导） -------- */
  for (const ind of industries) {
    const rows = ind.rows || [];
    const prev = [...rows].reverse().find(r => r.date < weekStart);
    // 行业接口只给最新数据，回退到历史周时要按 weekEnd 取，不能直接用最新一行
    const last = [...rows].reverse().find(r => r.date <= weekEnd);
    ind.chg = (prev && last) ? r2(pct(last.close, prev.close)) : null;
    ind.date = last ? last.date : null;
  }
  const tradingDates = weekRows.map(r => r.date);
  const dailySectors = {};
  for (const d of tradingDates) {
    const list = industries
      .map(i => ({ name: i.name, chg: (i.rows || []).find(r => r.date === d)?.chg }))
      .filter(x => x.chg != null && isFinite(x.chg) && x.chg !== 0)
      .sort((a, b) => b.chg - a.chg);
    if (list.length < 20) continue;
    dailySectors[d] = {
      top: list.slice(0, 3).map(x => ({ name: x.name, chg: r2(x.chg) })),
      bot: list.slice(-3).reverse().map(x => ({ name: x.name, chg: r2(x.chg) })),
      extreme: r2(Math.max(Math.abs(list[0].chg), Math.abs(list[list.length - 1].chg))),
      breadthUp: list.filter(x => x.chg > 0).length,
    };
  }

  // 1. 是否已经收盘（15:00 之后）
  const now = new Date();
  const closeTime = new Date(weekEnd + 'T15:00:00');
  if (now < closeTime) checks.push({ key: '收盘状态', ok: false, msg: `${weekEnd} 尚未收盘，数据为盘中快照` });

  // 2. 行业齐全且日期对齐
  const okInd = industries.filter(i => i.chg != null);
  if (okInd.length < SW.length) checks.push({ key: '行业覆盖', ok: false, msg: `申万一级行业仅取到 ${okInd.length}/31 个` });
  const misaligned = okInd.filter(i => i.date !== weekEnd);
  if (misaligned.length) checks.push({ key: '行业日期', ok: false, msg: `${misaligned.length} 个行业数据日期不是 ${weekEnd}` });

  // 3. 指数一致性
  const badIdx = idxList.filter(i => !(i.close > 0) || !isFinite(i.weekChg));
  if (badIdx.length) checks.push({ key: '指数完整性', ok: false, msg: `${badIdx.map(i => i.name).join('、')} 数据异常` });

  // 4. 宽度
  if (breadth && (breadth.up + breadth.down + breadth.flat) < 3000) checks.push({ key: '涨跌家数', ok: false, msg: '涨跌家数合计偏少，可能未完整覆盖全市场' });

  // 5. 行业日线覆盖（每日异动板块依赖它）
  const missDay = tradingDates.filter(d => !dailySectors[d]);
  if (missDay.length) checks.push({ key: '行业日线', ok: false, msg: `${missDay.join('、')} 的行业日线不完整` });

  const ok = checks.filter(c => !c.ok).length === 0;

  const ctx = { sh, idxList, industries: okInd, breadth, zt, dt, weekStart, weekEnd };
  const narr = buildNarrative(ctx);

  const out = {
    generatedAt: new Date().toISOString(),
    status: ok ? 'ok' : 'incomplete',
    checks,
    week: { start: weekStart, end: weekEnd, days: sh.daily.length },
    title: narr.title,
    weekLabel: `${weekStart.slice(5).replace('-', '.')}–${weekEnd.slice(5).replace('-', '.')}`,
    oneLiner: narr.oneLiner,
    summary: { volumeText: narr.volumeText, breadthText: narr.breadthText },
    manual: (() => {
      const p = resolve(ROOT, 'data/manual.json');
      if (!existsSync(p)) return { events: [], stored: 0 };
      try {
        const m = JSON.parse(readFileSync(p, 'utf8'));
        const all = Array.isArray(m.events) ? m.events : [];
        // 只保留落在本周区间内的事件，避免上周的旧条目挂到本期
        const ev = all
          .filter(e => e && e.date && e.date >= weekStart && e.date <= weekEnd)
          .sort((a, b) => String(a.date).localeCompare(String(b.date)));
        return { ...m, events: ev, stored: all.length };
      } catch { return { events: [], stored: 0 }; }
    })(),
    outlook: narr.outlook,
    indices: idxList.map(i => ({
      name: i.name, sym: i.sym, close: i.close, chg: i.weekChg,
      amp: i.weekAmp, volRatio: i.volRatio, vsMa20: i.vsMa20, vsMa60: i.vsMa60,
    })),
    days: sh.daily.map(d => ({ ...d, sectors: dailySectors[d.date] || null })),
    industries: okInd.sort((a, b) => b.chg - a.chg).map(i => ({ name: i.name, chg: r2(i.chg), code: i.code })),
    breadth, limit: { up: zt, down: dt },
    tech: {
      ma20: sh.ma20, ma60: sh.ma60, vsMa20: sh.vsMa20, vsMa60: sh.vsMa60,
      drawdown: sh.drawdown, vol20d: sh.vol20d, streak: sh.streak,
      weekHigh: sh.weekHigh, weekLow: sh.weekLow, weekAmp: sh.weekAmp,
    },
    signals: narr.signals,
    sources: [...srcUsed],
  };

  mkdirSync(resolve(ROOT, 'data/history'), { recursive: true });
  writeFileSync(resolve(ROOT, 'data/latest.json'), JSON.stringify(out, null, 2));
  writeFileSync(resolve(ROOT, 'data/history', `weekly-${weekEnd}.json`), JSON.stringify(out, null, 2));

  console.log('status:', out.status);
  console.log('week:', weekStart, '→', weekEnd, `(${sh.daily.length}个交易日)`);
  console.log('title:', out.title);
  console.log('oneLiner:', out.oneLiner);
  console.log('volume:', out.summary.volumeText);
  console.log('breadth:', out.summary.breadthText);
  console.log('indices:', out.indices.map(i => `${i.name} ${i.chg}%`).join(' | '));
  console.log('checks:', JSON.stringify(checks));
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
