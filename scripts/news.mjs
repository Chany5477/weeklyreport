/**
 * 财经常用快讯抓取 + 事件筛选
 * 输出：
 *   data/news/<date>.json   当日候选快讯（带打分，便于人工复核）
 *   data/news.json          { "YYYY-MM-DD": [ {time, phase, tag, text, src, url, score} ] }
 *
 * 只用公开快讯接口，不做任何推断；每条事件都保留原文标题与链接，可逐条核对。
 * 可选：设置 DEEPSEEK_API_KEY 后，用大模型把同一天的候选压缩成一句话（仍强制带原文依据）。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pexec = promisify(execFile);
const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dir, '..');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function get(url, referer) {
  for (let i = 0; i < 3; i++) {
    try {
      const { stdout } = await pexec('curl', ['-sS', '--compressed', '-m', '25',
        '-H', `User-Agent: ${UA}`, '-H', `Referer: ${referer}`, url], { maxBuffer: 80 * 1024 * 1024 });
      if (stdout && stdout.trim().startsWith('{')) return stdout;
    } catch { /* retry */ }
    await sleep(500 * (i + 1));
  }
  throw new Error('fetch failed: ' + url.slice(0, 100));
}

/* ---------------- 本周区间 ---------------- */
const latest = JSON.parse(readFileSync(resolve(ROOT, 'data/latest.json'), 'utf8'));
const weekStart = latest.week.start;   // 周一
const weekEnd = latest.week.end;       // 周五
const tradingDays = latest.days.map(d => d.date);

/* ---------------- 抓东财 7x24 快讯 ---------------- */
async function fetchFlash() {
  const out = [];
  let sortEnd = '';
  const stopBefore = new Date(weekStart + 'T00:00:00');
  stopBefore.setDate(stopBefore.getDate() - 1); // 多抓一天，覆盖周一盘前的隔夜消息
  for (let p = 0; p < 80; p++) {
    const url = 'https://np-weblist.eastmoney.com/comm/web/getFastNewsList' +
      `?client=web&biz=web_724&fastColumn=102&sortEnd=${sortEnd}&pageSize=200&req_trace=1`;
    let j;
    try { j = JSON.parse(await get(url, 'https://kuaixun.eastmoney.com/')); } catch { break; }
    const list = j?.data?.fastNewsList || [];
    if (!list.length) break;
    for (const it of list) {
      const time = it.showTime || '';
      if (!time) continue;
      out.push({
        time,
        title: (it.title || '').trim(),
        summary: (it.summary || '').trim(),
        code: it.code,
        stocks: it.stockList || [],
        hot: it.titleColor ? 2 : 0,   // 东财编辑标红 ≈ 当天被重点推送
      });
    }
    const oldest = out[out.length - 1].time;
    if (new Date(oldest.replace(' ', 'T')) < stopBefore) break;
    sortEnd = j.data.sortEnd;
    if (!sortEnd) break;
    await sleep(180);
  }
  return out;
}

/* ---------------- 关键词打分：只留能解释指数涨跌的消息 ---------------- */
// A 级（8 分）：直接改变流动性的政策 / 外部冲击
// B 级（5 分）：部委表态、关键数据、海外利率、资源价格
// C 级（3 分）：行业价格、订单、产业进展
const TIER_A = [
  { re: /国常会|国务院常务会议|政治局会议|中央经济工作会议|金融委|中央金融工作会议/, tag: '政策', sec: [] },
  { re: /降准|下调存款准备金率|全面降息|下调政策利率|LPR.*(?:下调|降)/, tag: '货币', sec: ['银行', '非银金融', '房地产'] },
  { re: /印花税|汇金|平准基金|国家队.*(?:增持|入场)|暂停IPO|减持新规/, tag: '制度', sec: ['非银金融'] },
  { re: /关税|出口管制|实体清单|反倾销|制裁|断供/, tag: '海外', sec: ['电子', '机械设备', '电力设备'] },
  { re: /美联储.*(?:决议|维持|降息|加息)|鲍威尔.*(?:表示|讲话)|非农.*(?:超预期|不及预期|万人)/, tag: '海外', sec: ['有色金属', '电子'] },
];
const TIER_B = [
  { re: /证监会|金融监管总局|发改委|财政部|工信部|能源局|商务部|住建部|央行|人民银行/, tag: '政策', sec: [] },
  { re: /社融|M2|新增人民币贷款|CPI|PPI|PMI|进出口|出口同比|GDP|社零|工业增加值/, tag: '数据', sec: [] },
  { re: /美债收益率|美元指数|人民币.*(?:升破|跌破|贬值|升值)|中间价/, tag: '汇率', sec: ['银行', '有色金属'] },
  { re: /稀土|原油|黄金|铜价|运价|集运指数/, tag: '周期', sec: ['有色金属', '石油石化', '交通运输'] },
  { re: /人工智能|AI|算力|芯片|半导体|存储|光模块|CPO|英伟达|台积电|华为|国产替代/, tag: '科技', sec: ['电子', '计算机', '通信'] },
  { re: /房地产|楼市|限购|房贷利率|保交楼|城中村改造/, tag: '地产', sec: ['房地产', '建筑材料'] },
];
const TIER_C = [
  { re: /涨价|提价|涨价函|缺货|供不应求|订单|中标|大额合同|扩产/, tag: '产业', sec: [] },
  { re: /机器人|人形机器人|低空经济|商业航天|卫星|量子|核聚变|固态电池|钠电/, tag: '主题', sec: ['机械设备', '国防军工', '电力设备'] },
  { re: /光伏|储能|锂|风电|核电|电网|特高压|新能源车|汽车销量/, tag: '新能源', sec: ['电力设备', '汽车'] },
  { re: /创新药|医保|集采|疫苗|减肥药|CXO/, tag: '医药', sec: ['医药生物'] },
  { re: /白酒|餐饮|旅游|免税|以旧换新|消费券/, tag: '消费', sec: ['食品饮料', '社会服务', '商贸零售'] },
];
// 明显不是"原因"的日常播报/公司琐事
const NOISE = /隔夜逆回购协议|使用规模|国库券|中标利率|投标倍数|Shibor|同业存单|ETF|涨超|跌超|拉升|盘中|收盘|收评|午评|龙虎榜|融资余额|大宗交易|解禁|减持|回购注销|股权激励|聘任|辞职|更名|分红派息|公告[:：]|拟以|签订.*协议/;
// 与 A 股当日涨跌关系很弱：境外小央行、常规行政公示、评论体文章
const WEAK = /印尼|韩国|印度央行|巴西|俄罗斯|土耳其|伊朗|阿根廷|越南|泰国|答记者问|例行新闻发布会|新闻发言人|配额|公示|名单|招标|中标公告|项目投资|拟投资|拷问|热议|展望|点评|解读|观察|盘点|复盘|专访|直播|视频|图解|一图|[？?]/;

function scoreOf(text) {
  let score = 0, tag = null, secs = new Set();
  const hit = (rules, w) => {
    for (const r of rules) {
      if (r.re.test(text)) {
        score += w;
        tag = tag || r.tag;
        r.sec.forEach(s => secs.add(s));
      }
    }
  };
  hit(TIER_A, 8); hit(TIER_B, 5); hit(TIER_C, 3);
  if (NOISE.test(text)) score -= 9;
  if (WEAK.test(text)) score -= 7;
  return { score, tag, secs: [...secs] };
}

/* ---------------- 与当日板块异动对齐 ---------------- */
const daySectors = {};
for (const d of latest.days) if (d.sectors) daySectors[d.date] = d.sectors;

function alignOf(secs, day) {
  const s = daySectors[day];
  if (!s) return null;
  if (secs.length > 2) return null;   // 关键词同时指向多个行业时，不足以判断因果
  for (const side of ['top', 'bot']) {
    for (const x of s[side] || []) {
      if (secs.includes(x.name) && Math.abs(x.chg) >= 2) return { name: x.name, chg: x.chg, side };
    }
  }
  return null;
}

/* ---------------- 分配到交易日 ---------------- */
function phaseOf(t) {
  const hm = t.slice(11, 16);
  if (hm < '09:30') return '盘前';
  if (hm <= '15:00') return '盘中';
  return '盘后';
}
function dayOf(time) {
  const key = time.slice(0, 10);
  return tradingDays.includes(key) ? key : null;
}

/* ---------------- 主流程 ---------------- */
const raw = await fetchFlash();
console.log('快讯抓到', raw.length, '条，最早', raw[raw.length - 1]?.time);

const byDay = {};
for (const it of raw) {
  const day = dayOf(it.time);
  if (!day) continue;
  const text = it.title || it.summary.slice(0, 80);
  if (!text) continue;
  const { score, tag, secs } = scoreOf(text);
  if (score < 6) continue;
  const align = alignOf(secs, day);
  (byDay[day] ||= []).push({
    time: it.time.slice(11, 16),
    phase: phaseOf(it.time),
    tag: tag || '快讯',
    text,
    secs,
    align,
    src: '东方财富',
    url: it.code ? `https://finance.eastmoney.com/a/${it.code}.html` : '',
    score: score + (align ? 4 : 0) + (it.hot || 0),
  });
}

// 同日去重（标题前 14 字相同视为同一条）
const out = {};
mkdirSync(resolve(ROOT, 'data/news'), { recursive: true });
for (const day of tradingDays) {
  const list = (byDay[day] || []).sort((a, b) => b.score - a.score || a.time.localeCompare(b.time));
  const seen = new Set();
  const picked = [];
  for (const e of list) {
    const key = e.text.replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '').slice(0, 14);
    if (seen.has(key)) continue;
    // 同一类话题最多 2 条，避免一天三条都是同一个部委的表态
    if (picked.filter(p => p.tag === e.tag).length >= 2) continue;
    // 同一条消息的不同表述（前 8 字相同）只留一条
    if (picked.some(p => p.text.slice(0, 8) === e.text.slice(0, 8))) continue;
    seen.add(key);
    picked.push(e);
  }
  out[day] = picked;
  writeFileSync(resolve(ROOT, 'data/news', `${day}.json`), JSON.stringify(picked, null, 1));
  console.log(day, '候选', picked.length, '条 →', picked.slice(0, 3).map(e => `${e.time}(${e.score}) ${e.text.slice(0, 30)}`).join(' | '));
}

/* ---------------- 可选：DeepSeek 归纳 ---------------- */
const KEY = process.env.DEEPSEEK_API_KEY;
let usedLLM = false;
if (KEY) {
  for (const day of tradingDays) {
    const cands = (out[day] || []).slice(0, 12);
    if (cands.length < 2) continue;
    const dayRow = latest.days.find(d => d.date === day);
    const prompt = [
      `今天是 ${day}，上证指数当日 ${dayRow ? dayRow.chg : '?'}%。`,
      '下面是当天抓到的财经快讯候选，编号从 0 开始：',
      ...cands.map((c, i) => `${i}. [${c.time} ${c.phase}] ${c.text}`),
      '',
      '请挑出最多 3 条真正能解释当天 A 股涨跌的消息（政策/流动性/海外冲击/产业价格优先，公司经营类靠后）。',
      '要求：1) 只能使用候选里的信息，不得补充任何候选之外的数字或事实；2) 每条压成 20~40 字，写"发生了什么+对市场的影响"；',
      '3) 输出 JSON 数组，元素形如 {"i": 候选编号, "tag": "政策/海外/科技/周期/资金", "text": "..."}；4) 没有合格的就输出 []。',
      '只输出 JSON，不要解释。',
    ].join('\n');
    try {
      const body = JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        response_format: { type: 'json_object' },
      });
      const { stdout } = await pexec('curl', ['-sS', '-m', '60', 'https://api.deepseek.com/chat/completions',
        '-H', 'Content-Type: application/json', '-H', `Authorization: Bearer ${KEY}`, '-d', body], { maxBuffer: 8 * 1024 * 1024 });
      const j = JSON.parse(stdout);
      const txt = j?.choices?.[0]?.message?.content || '';
      const parsed = JSON.parse(txt);
      const arr = Array.isArray(parsed) ? parsed : (parsed.events || []);
      const mapped = arr
        .filter(x => Number.isInteger(x.i) && cands[x.i])
        .map(x => ({ ...cands[x.i], tag: x.tag || cands[x.i].tag, text: String(x.text || cands[x.i].text).slice(0, 60), llm: true }));
      if (mapped.length) { out[day] = mapped; usedLLM = true; }
    } catch (e) {
      console.log(day, 'DeepSeek 归纳失败，用规则结果：', e.message.slice(0, 80));
    }
  }
}

// 最终每天保留 3 条
for (const day of tradingDays) out[day] = (out[day] || []).slice(0, 3);
writeFileSync(resolve(ROOT, 'data/news.json'), JSON.stringify(out, null, 2));
console.log('事件汇总完成', usedLLM ? '(DeepSeek 归纳)' : '(规则筛选)',
  Object.entries(out).map(([k, v]) => `${k.slice(5)}:${v.length}`).join(' '));
