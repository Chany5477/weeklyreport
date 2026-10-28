import * as F from './ifind.mjs';
const at = await F.accessToken();
const END = '2026-10-28', START = '2026-09-20';

console.log('=== 中证指数代码后缀 ===');
for (const c of ['000922.CSI', '000918.CSI', '000919.CSI', 'H11021.CSI', '930950.CSI']) {
  try {
    const r = await F.historyQuotes(c, START, END, 'close', at);
    const l = r.filter(x => x.close != null).pop();
    console.log(c.padEnd(12), 'OK', l ? l.time + ' ' + l.close : '无值');
  } catch (e) { console.log(c.padEnd(12), '失败', e.message.slice(0, 50)); }
}

console.log('\n=== PE / PB 实际数值 ===');
for (const ind of ['ths_pe_ttm_index', 'ths_pb_index']) {
  try {
    const r = await F.dateSerial('000300.SH', [{ indicator: ind, indiparams: [''] }], START, END, at);
    console.log(ind, JSON.stringify(r.slice(-2)));
  } catch (e) { console.log(ind, '失败', e.message.slice(0, 60)); }
}

console.log('\n=== 国债期货代码 ===');
for (const c of ['T.CFE', 'T00.CFE', 'T8888.CFE', 'T2612.CFE']) {
  try {
    const r = await F.historyQuotes(c, START, END, 'close', at);
    const l = r.filter(x => x.close != null).pop();
    console.log(c.padEnd(12), 'OK', l ? l.time + ' ' + l.close : '无值');
  } catch (e) { console.log(c.padEnd(12), '失败', e.message.slice(0, 50)); }
}

console.log('\n=== 现券收益率指标（basic_data_service）===');
for (const code of ['260011.IB', '019988.SH', '1001.CB']) {
  for (const ind of ['ths_yield_bond', 'ths_bond_yield', 'ths_ytm_bond', 'ths_close_yield_bond']) {
    try {
      const r = await F.call('basic_data_service', { codes: code, indipara: [{ indicator: ind, indiparams: [''] }] }, at);
      const t = (r.tables || [])[0]?.table || {};
      console.log(code.padEnd(11), ind.padEnd(20), JSON.stringify(t).slice(0, 120));
    } catch (e) {
      console.log(code.padEnd(11), ind.padEnd(20), '失败', e.message.slice(0, 40));
    }
  }
}
