/**
 * 指数 PE / PB 取数探测（第三轮）
 * 目标：找到这个账号能真正取到指数估值的接口/指标 ID
 */
import * as F from './ifind.mjs';
const at = await F.accessToken();
const S = '2026-10-20', E = '2026-10-28';
const t = async (label, fn) => {
  try { console.log(label.padEnd(34), JSON.stringify(await fn()).slice(0, 150)); }
  catch (e) { console.log(label.padEnd(34), '失败', e.message.slice(0, 55)); }
};

console.log('=== A、实时行情接口带估值字段 ===');
for (const ind of ['pe', 'pb', 'peTtm', 'pbMrq', 'pe_ttm', 'pb_lf', 'latest,pe,pb']) {
  await t('real_time ' + ind, () => F.call('real_time_quotation', { codes: '000300.SH', indicators: ind }, at)
    .then(r => (r.tables || []).map(x => ({ c: x.thscode, t: x.table }))));
}

console.log('\n=== B、历史行情接口带估值字段 ===');
for (const ind of ['pe', 'pb', 'close,pe,pb', 'pe_ttm']) {
  await t('history ' + ind, () => F.historyQuotes('000300.SH', S, E, ind, at).then(r => r.slice(-1)));
}

console.log('\n=== C、date_sequence 更多指标 ID ===');
const ids = ['ths_pe_ttm_index', 'ths_pe_index', 'ths_pe_ttm', 'ths_pe', 'ths_pb_index', 'ths_pb_stock',
  'ths_val_pe_ttm_index', 'ths_index_pe_ttm', 'ths_pe_ttm_idx', 'ths_est_pe_ttm',
  'ths_pe_deducted_ttm_index', 'ths_pb_mrq_index', 'ths_pe_ttm_stock', 'ths_pb_ttm_index'];
for (const ind of ids) {
  await t('ds ' + ind, () => F.dateSerial('000300.SH', [{ indicator: ind, indiparams: [''] }], S, E, at)
    .then(r => r.slice(-1).map(x => [x.time, x[ind]])));
}

console.log('\n=== D、basic_data_service 带日期参数 ===');
for (const ind of ['ths_pe_ttm_index', 'ths_pb_index', 'ths_pe_ttm']) {
  await t('basic ' + ind, () => F.call('basic_data_service',
    { codes: '000300.SH', indipara: [{ indicator: ind, indiparams: ['2026-10-27'] }] }, at)
    .then(r => (r.tables || []).map(x => x.table)));
}

console.log('\n=== E、上证综指 / 中证800 / 科创综指（用同一个 ID 试）===');
for (const c of ['000001.SH', '000906.SH', '000680.SH']) {
  await t('ds ' + c, () => F.dateSerial(c, [{ indicator: 'ths_pe_ttm_index', indiparams: [''] }], S, E, at)
    .then(r => r.slice(-1)));
}

console.log('\n=== F、专题报表（data_pool）权限 ===');
await t('data_pool 成分', () => F.call('data_pool',
  { reportname: 'p00311', functionpara: { date: '2026-10-27', blockname: '000300' }, outputpara: 'p00311_f001,p00311_f002' }, at)
  .then(r => JSON.stringify(r).slice(0, 150)));

console.log('\n=== G、高频/快照接口（看权限边界）===');
await t('snap_shot', () => F.call('snap_shot', { codes: '000300.SH', indicators: 'latest', starttime: '2026-10-27 09:30:00', endtime: '2026-10-27 15:00:00' }, at)
  .then(r => JSON.stringify(r).slice(0, 120)));
