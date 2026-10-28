/**
 * iFinD 探测脚本：拿到 refresh_token 后跑一次，确认
 *  1) 账号能否取到 access_token
 *  2) 各指数的代码后缀对不对
 *  3) PE / PB / 国债收益率 / DR007 用哪个指标 ID
 * 用法：node scripts/ifind-probe.mjs        （把输出整段发给我，我据此修正 scripts/assets.mjs）
 */
import { accessToken, refreshToken, call, toRows, historyQuotes, dateSerial, edb } from './ifind.mjs';

const END = new Date().toISOString().slice(0, 10);
const START = '2026-09-01';
const rt = refreshToken();

if (!rt) {
  console.log('没有配置 refresh_token。先把它写进 secrets/ifind.token，或设置环境变量 IFIND_REFRESH_TOKEN。');
  console.log('获取方式：打开 https://quantapi.51ifind.com/gwstatic/static/ds_web/super-command-web/index.html');
  console.log('用 iFinD 账号登录 → 账号详情 → 复制 refresh_token（eyJ 开头）。');
  process.exit(0);
}

const at = await accessToken();
console.log('access_token 获取成功，长度', at.length, '\n');

/* 1、代码后缀探测 */
const codes = [
  '000001.SH', '000300.SH', '000905.SH', '000906.SH', '000852.SH',
  '000680.SH', '000688.SH', '000016.SH', '000922.SH', '399006.SZ',
  '932055.CSI', '932055.SH', '930950.CSI', 'H11023.CSI', 'H11022.CSI', 'H11020.CSI',
];
console.log('=== 1、历史行情（收盘价）代码测试 ===');
for (const c of codes) {
  try {
    const rows = await historyQuotes(c, START, END, 'close', at);
    const last = rows.filter(r => r.close != null).pop();
    console.log(`${c.padEnd(12)} OK   行数 ${String(rows.length).padStart(3)}  末值 ${last ? last.time + ' ' + last.close : '无'}`);
  } catch (e) {
    console.log(`${c.padEnd(12)} 失败 ${e.message.slice(0, 60)}`);
  }
}

/* 2、估值指标 ID 探测 */
const peCand = ['ths_pe_ttm_index', 'ths_pe_ttm_stock', 'ths_pe_index', 'ths_pe_ttm', 'ths_pe'];
const pbCand = ['ths_pb_index', 'ths_pb_stock', 'ths_pb_mrq', 'ths_pb', 'ths_pb_lf'];
console.log('\n=== 2、估值指标 ID 测试（000300.SH）===');
for (const ind of [...peCand, ...pbCand]) {
  try {
    const rows = await dateSerial('000300.SH', [{ indicator: ind, indiparams: [''] }], START, END, at);
    const keys = rows.length ? Object.keys(rows[0]).filter(k => !['code', 'time'].includes(k)) : [];
    const last = rows[rows.length - 1];
    console.log(`${ind.padEnd(20)} OK   字段 ${keys.join(',') || '无'}  末值 ${last ? last.time + ' ' + (last[keys[0]] ?? '') : '无'}`);
  } catch (e) {
    console.log(`${ind.padEnd(20)} 失败 ${e.message.slice(0, 50)}`);
  }
}

/* 3、利率 / 资金面：EDB 指标 ID 探测 */
const edbCand = [
  ['G009035746', '示例ID（文档里的）'],
  ['G0000027', '中债国债到期收益率10年?'],
  ['G0000026', '中债国债到期收益率1年?'],
  ['G0000095', 'DR007?'],
  ['G0000091', 'R007?'],
];
console.log('\n=== 3、EDB 利率指标测试 ===');
for (const [id, note] of edbCand) {
  try {
    const rows = await edb(id, START, END, at);
    const last = rows[rows.length - 1];
    console.log(`${id.padEnd(14)} OK   ${rows.length} 行  末值 ${last ? JSON.stringify(last).slice(0, 90) : '无'}   # ${note}`);
  } catch (e) {
    console.log(`${id.padEnd(14)} 失败 ${e.message.slice(0, 50)}   # ${note}`);
  }
}

console.log('\n=== 4、接口连通性原始返回（edb_service 空参数）===');
try {
  const r = await call('edb_service', { indicators: 'G009035746', startdate: START, enddate: END }, at);
  console.log(JSON.stringify(r).slice(0, 400));
} catch (e) {
  console.log('失败', e.message.slice(0, 80));
}
