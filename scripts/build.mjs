import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dir, '..');

const data = JSON.parse(readFileSync(resolve(ROOT, 'data/latest.json'), 'utf8'));
const tpl = readFileSync(resolve(ROOT, 'templates/report.html'), 'utf8');

/* ---------- 把新闻事件并进每一天 ---------- */
const newsPath = resolve(ROOT, 'data/news.json');
const news = existsSync(newsPath) ? JSON.parse(readFileSync(newsPath, 'utf8')) : {};

data.days = data.days.map(d => {
  const n = news[d.date] || { events: [], attribution: '' };
  return {
    ...d,
    attribution: n.attribution || '',
    attributionBy: n.by || '规则',
    events: (n.events || []).slice(0, 3).map(e => ({
      time: e.time, phase: e.phase, tag: e.tag, text: e.text,
      url: e.url, src: e.src, align: e.align || null,
    })),
  };
});

/* ---------- 人工核对过的事件优先显示（manual.json 覆盖同日自动结果） ---------- */
const manualEvents = (data.manual && data.manual.events) || [];
if (manualEvents.length) {
  data.days = data.days.map(d => {
    const mine = manualEvents
      .filter(e => e && e.date === d.date)
      .map(e => ({ time: '', phase: '人工', tag: e.tag || '人工', text: e.text, url: e.src && e.src.startsWith('http') ? e.src : '', src: '人工核对', align: null }));
    return mine.length ? { ...d, events: [...mine, ...(d.events || [])].slice(0, 3) } : d;
  });
}

/* ---------- 本周归因：波动最大的那天 + 只引用高度相关的消息 ---------- */
const worstDay = data.days.slice().sort((a, b) => a.chg - b.chg)[0];
const bestDay = data.days.slice().sort((a, b) => b.chg - a.chg)[0];
const allEvents = data.days.flatMap(d => (d.events || []).map(e => ({ ...e, date: d.date, dayChg: d.chg })));

// 归因门槛：要么与当天异动板块对得上，要么是当日盘前/盘中的宏观类消息；否则宁可不写
const MACRO = ['政策', '货币', '海外', '数据', '制度'];
const cands = ((worstDay && worstDay.events) || [])
  .filter(e => {
    if (e.src === '人工核对') return true;
    if (e.align && Math.abs(e.align.chg) >= 2 && (worstDay.chg < 0 ? e.align.side === 'bot' : e.align.side === 'top')) return true;
    return MACRO.includes(e.tag) && e.phase !== '盘后';
  })
  .sort((a, b) => (b.align ? 1 : 0) - (a.align ? 1 : 0));
const mainEvent = cands[0] || null;

data.attribution = {
  worst: worstDay ? { date: worstDay.date, chg: worstDay.chg, amp: worstDay.amp, vr: worstDay.vr,
    top: worstDay.sectors?.top || [], bot: worstDay.sectors?.bot || [] } : null,
  best: bestDay ? { date: bestDay.date, chg: bestDay.chg } : null,
  mainEvent: mainEvent ? { date: mainEvent.date, time: mainEvent.time, text: mainEvent.text, url: mainEvent.url, tag: mainEvent.tag, align: mainEvent.align, src: mainEvent.src } : null,
  worstAttribution: worstDay ? (worstDay.attribution || '') : '',
  worstAttributionBy: worstDay ? (worstDay.attributionBy || '规则') : '',
  eventCount: allEvents.length,
};

const json = JSON.stringify(data).replace(/</g, '\\u003c');

const html = tpl
  .replaceAll('__WEEKLABEL__', data.weekLabel || '')
  .replaceAll('__TITLE__', data.title || '市场回顾')
  .replaceAll('__ONELINER__', data.oneLiner || '')
  .replaceAll('__DATA__', json);

mkdirSync(resolve(ROOT, 'dist'), { recursive: true });
writeFileSync(resolve(ROOT, 'dist/index.html'), html);
writeFileSync(resolve(ROOT, 'dist/data.json'), JSON.stringify(data, null, 2));
// GitHub Pages 走 main 分支根目录发布，根目录 index.html 同步一份，避免手动复制
writeFileSync(resolve(ROOT, 'index.html'), html);

console.log('built dist/index.html + index.html', (html.length / 1024).toFixed(1) + 'KB',
  `| 事件 ${data.attribution.eventCount} 条`);
