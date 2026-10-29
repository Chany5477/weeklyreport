/**
 * 板块轮动数据源：申万一级行业周线
 * 接口：申万宏源研究所 institute-sw（返回全部历史，period=WEEK 即周线）
 * 说明：iFinD 取不到申万行业指数（801010.* 各种后缀都报 -4210），所以用官网接口。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pexec = promisify(execFile);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export const SW_LIST = [
  ['801010', '农林牧渔'], ['801030', '基础化工'], ['801040', '钢铁'], ['801050', '有色金属'],
  ['801080', '电子'], ['801110', '家用电器'], ['801120', '食品饮料'], ['801130', '纺织服饰'],
  ['801140', '轻工制造'], ['801150', '医药生物'], ['801160', '公用事业'], ['801170', '交通运输'],
  ['801180', '房地产'], ['801200', '商贸零售'], ['801210', '社会服务'], ['801230', '综合'],
  ['801710', '建筑材料'], ['801720', '建筑装饰'], ['801730', '电力设备'], ['801740', '国防军工'],
  ['801750', '计算机'], ['801760', '传媒'], ['801770', '通信'], ['801780', '银行'],
  ['801790', '非银金融'], ['801880', '汽车'], ['801890', '机械设备'], ['801950', '煤炭'],
  ['801960', '石油石化'], ['801970', '环保'], ['801980', '美容护理'],
];

const md = (d) => `${+d.slice(5, 7)}/${+d.slice(8, 10)}`;
const nextDay = (d) => new Date(new Date(d + 'T00:00:00Z').getTime() + 86400e3).toISOString().slice(0, 10);

async function fetchOne(code, name, n, tries = 2) {
  for (let t = 0; t < tries; t++) {
    try {
      const { stdout } = await pexec('curl', [
        '-sS', '-m', '30', '--compressed',
        '-A', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
        '-H', 'Referer: https://www.swsresearch.com/',
        `https://www.swsresearch.com/institute-sw/api/index_publish/trend/?swindexcode=${code}&period=WEEK`,
      ], { maxBuffer: 8 * 1024 * 1024 });
      const arr = JSON.parse(stdout)?.data || [];
      const rows = arr.map(r => [String(r.bargaindate).slice(0, 10), +r.closeindex])
        .filter(r => r[0] && Number.isFinite(r[1]));
      if (rows.length < n + 1) throw new Error('short');
      return { name, map: new Map(rows) };
    } catch {
      if (t === tries - 1) return { name, map: new Map() };
      await sleep(500);
    }
  }
  return { name, map: new Map() };
}

/** 最近 n 周，每周的领涨 / 领跌前三 */
export async function swWeeks(n = 8, conc = 3) {
  const series = [];
  for (let i = 0; i < SW_LIST.length; i += conc) {
    const batch = SW_LIST.slice(i, i + conc);
    series.push(...await Promise.all(batch.map(([c, nm]) => fetchOne(c, nm, n))));
  }
  const ref = series.reduce((a, b) => (b.map.size > a.map.size ? b : a), series[0]);
  if (!ref || ref.map.size < n + 1) throw new Error(`申万周线数据不足（${ref?.map.size || 0} 周）`);
  const dates = [...ref.map.keys()].sort().slice(-(n + 1));

  const weeks = [];
  for (let i = 1; i < dates.length; i++) {
    const d0 = dates[i - 1], d1 = dates[i];
    const list = [];
    for (const s of series) {
      const a = s.map.get(d0), b = s.map.get(d1);
      if (!Number.isFinite(a) || !Number.isFinite(b) || !a) continue;
      list.push({ name: s.name, chg: Math.round((b / a - 1) * 10000) / 100 });
    }
    if (list.length < 20) continue;
    list.sort((x, y) => y.chg - x.chg);
    weeks.push({
      label: `${md(nextDay(d0))}–${md(d1)}`,
      start: nextDay(d0), end: d1,
      top: list.slice(0, 3).map(x => ({ name: x.name, chg: x.chg })),
      bottom: list.slice(-3).reverse().map(x => ({ name: x.name, chg: x.chg })),
      spread: Math.round((list[0].chg - list[list.length - 1].chg) * 10) / 10,
      n: list.length,
    });
  }
  return weeks;
}
