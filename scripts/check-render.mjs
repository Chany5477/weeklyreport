// 用最小 DOM 桩验证页面脚本可正常渲染（无浏览器环境下的逻辑自检）
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(resolve(ROOT, 'dist/index.html'), 'utf8');

const dataMatch = html.match(/<script id="DATA" type="application\/json">([\s\S]*?)<\/script>/);
const codeMatch = html.match(/<script>\n([\s\S]*?)<\/script>/);
if (!dataMatch || !codeMatch) throw new Error('script block not found');

const store = {};
const el = (id) => (store[id] ??= { id, innerHTML: '', style: {}, textContent: id === 'DATA' ? dataMatch[1] : '' });
const document = {
  getElementById: (id) => el(id),
};
const ctx = { document, console, Date, Math, JSON, parseInt, parseFloat, isNaN };
vm.createContext(ctx);
vm.runInContext(codeMatch[1], ctx);

const ids = ['status', 'days', 'conclusion', 'idxChart', 'idxTable', 'indBars', 'techAlert', 'techGrid', 'outlook', 'foot'];
let bad = 0;
for (const id of ids) {
  const v = store[id]?.innerHTML ?? '';
  if (!v.trim()) { console.log('EMPTY:', id); bad++; }
  else if (/undefined|NaN|\[object/.test(v)) { console.log('SUSPECT:', id, v.match(/.{0,40}(undefined|NaN|\[object).{0,40}/)[0]); bad++; }
}
console.log(bad === 0 ? 'RENDER OK — 所有区块已生成且无 undefined/NaN' : `RENDER ISSUES: ${bad}`);
console.log('title:', (html.match(/<h1>(.*?)<\/h1>/) || [])[1]);

if (process.argv.includes('dump')) {
  const strip = (s) => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  for (const id of ['status', 'days', 'conclusion', 'techAlert', 'outlook', 'foot']) {
    console.log('\n[' + id + '] ' + strip(store[id].innerHTML));
  }
}
