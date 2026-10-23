import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dir, '..');

const data = JSON.parse(readFileSync(resolve(ROOT, 'data/latest.json'), 'utf8'));
const tpl = readFileSync(resolve(ROOT, 'templates/report.html'), 'utf8');

const json = JSON.stringify(data).replace(/</g, '\\u003c');

const html = tpl
  .replaceAll('__WEEKLABEL__', data.weekLabel || '')
  .replaceAll('__TITLE__', data.title || '市场回顾')
  .replaceAll('__ONELINER__', data.oneLiner || '')
  .replaceAll('__DATA__', json);

mkdirSync(resolve(ROOT, 'dist'), { recursive: true });
writeFileSync(resolve(ROOT, 'dist/index.html'), html);
writeFileSync(resolve(ROOT, 'dist/data.json'), JSON.stringify(data, null, 2));

console.log('built dist/index.html', (html.length / 1024).toFixed(1) + 'KB');
