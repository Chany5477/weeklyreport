/**
 * 单独生成板块轮动数据（最近 8 周行业领涨/领跌）→ data/rotation.json
 * 为什么单独跑：抓 31 个行业要 1~2 分钟，拆出来可以先验证、避免整套流程等太久。
 * 主流程 assets.mjs 会直接读这个缓存；缓存缺失或不是最新一周时它自己会重抓。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { swWeeks } from './sw.mjs';

const ROOT = new URL('..', import.meta.url).pathname;

// 只保留周报截止日之前已收完的周（周五跑时，最后一行就是本周）
let asOf = null;
try {
  const latest = JSON.parse(readFileSync(resolve(ROOT, 'data/latest.json'), 'utf8'));
  asOf = latest?.week?.end || null;
} catch { /* 没有 latest.json 就不过滤 */ }

let weeks = await swWeeks(8);
if (asOf) {
  const kept = weeks.filter(w => w.end <= asOf);
  if (kept.length >= 4) weeks = kept;   // 过滤失败（数据太旧）就保留原样
}
if (!weeks.length) {
  console.error('没取到行业周线数据');
  process.exit(1);
}
writeFileSync(resolve(ROOT, 'data/rotation.json'),
  JSON.stringify({ generatedAt: new Date().toISOString(), asOf, weeks }, null, 1));
console.log(`板块轮动：${weeks.length} 周（截至 ${asOf || weeks[weeks.length - 1].end}）→ data/rotation.json`);
for (const w of weeks) {
  console.log(`  ${w.label}  领涨 ${w.top.map(x => `${x.name} ${x.chg > 0 ? '+' : ''}${x.chg}%`).join('、')}` +
    `  | 领跌 ${w.bottom.map(x => `${x.name} ${x.chg}%`).join('、')}  | 首尾差 ${w.spread}pct`);
}
