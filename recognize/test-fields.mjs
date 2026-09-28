// C 部分自检: 字段有界化 + 帧缓存
// 纯逻辑, 不依赖设备。
import { truncateField, boundArray, boundValue, FrameCache,
  DEFAULT_FIELD_HEAD, DEFAULT_FIELD_TAIL } from './lib/fields.mjs';

let pass = 0, fail = 0;
// 顺序 await 的 runner: 支持 async 测试, 且失败不会被吞。
// （前一版是同步 runner, async 测试的 rejection 抓不到 —— 这是真实踩过的坑。）
// 分组标记让输出按主题分段，而不是在执行前一次性打印。
const tests = [];
let currentGroup = null;
const g = (name) => { currentGroup = name; };
const t = (name, fn) => tests.push({ name, fn, group: currentGroup });
const eq = (a, b, m) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${m || ''}\n    期望 ${JSON.stringify(b)}\n    得到 ${JSON.stringify(a)}`);
  }
};
const ok = (cond, m) => { if (!cond) throw new Error(m || '断言失败'); };

g('字段截断: head + tail');

t('短字段原样返回', () => {
  eq(truncateField('设置'), '设置');
});

t('null / undefined 原样返回', () => {
  eq(truncateField(null), null);
  eq(truncateField(undefined), undefined);
});

t('空字符串不炸', () => {
  eq(truncateField(''), '');
});

t('超长字段被截断且保头保尾', () => {
  const head = 'H'.repeat(300);
  const mid = 'M'.repeat(5000);
  const tail = 'TAIL-MARKER';
  const out = truncateField(head + mid + tail, { headChars: 300, tailChars: 160 });
  ok(out.startsWith('HHHH'), '应保头');
  ok(out.endsWith(tail), '必须保尾 —— 尾部常含 URL 查询参数/订单号');
  ok(out.includes('省略'), '应报出省略量');
  ok(out.length < 600, `截断后应远小于原长, 实际 ${out.length}`);
});

t('恰好等于预算时不截断', () => {
  const s = 'x'.repeat(300 + 160);
  eq(truncateField(s, { headChars: 300, tailChars: 160 }), s);
});

t('超出预算 1 个字符就截断', () => {
  const s = 'x'.repeat(300 + 160 + 1);
  ok(truncateField(s, { headChars: 300, tailChars: 160 }).includes('省略'), '应截断');
});

t('省略量数字正确', () => {
  const s = 'a'.repeat(1000);
  const out = truncateField(s, { headChars: 300, tailChars: 160 });
  const m = out.match(/省略 (\d+) 字符/);
  ok(m, '应含省略量');
  eq(Number(m[1]), 1000 - 460, '省略量 = 原长 - (head+tail)');
});

t('非字符串输入被 String 化', () => {
  eq(truncateField(12345), '12345');
});

t('URL 尾部参数被保住（这是保尾的真正动机）', () => {
  const url = 'https://example.com/' + 'p'.repeat(2000) + '?orderId=ABC123&sig=xyz';
  const out = truncateField(url, { headChars: 200, tailChars: 120 });
  ok(out.includes('orderId=ABC123'), 'orderId 不能被截掉');
});

g('数组有界化: 保头 + 保尾');

t('短数组不截断', () => {
  eq(boundArray([1, 2, 3], { headLimit: 2, tailLimit: 1 }), { items: [1, 2, 3], omitted: 0 });
});

t('长数组保头保尾并报出省略量', () => {
  const arr = Array.from({ length: 100 }, (_, i) => i);
  const r = boundArray(arr, { headLimit: 3, tailLimit: 2 });
  eq(r.items, [0, 1, 2, 98, 99], '应保头 3 个 + 保尾 2 个');
  eq(r.omitted, 95);
});

t('非数组输入返回空', () => {
  eq(boundArray(null), { items: [], omitted: 0 });
});

g('深度有界化');

t('递归截断嵌套字符串', () => {
  const deep = { a: { b: { c: 'z'.repeat(2000) } } };
  const out = boundValue(deep, { headChars: 100, tailChars: 50 });
  ok(out.a.b.c.includes('省略'), '深层字符串也应被截');
});

t('下划线开头的键被跳过（内部字段不外泄）', () => {
  const out = boundValue({ _internal: 'secret', keep: 'ok' });
  eq(Object.keys(out), ['keep']);
});

t('数组里的省略项附加在末尾', () => {
  const out = boundValue(Array.from({ length: 50 }, (_, i) => i), { headLimit: 2, tailLimit: 2 });
  eq(out.length, 5, '2 + 2 + 1 条省略标记');
  ok(String(out[out.length - 1]).includes('省略'), '末尾应是省略标记');
});

g('帧缓存: 新鲜度契约');

t('maxAgeMs=0 时不复用（最保守的默认）', async () => {
  const c = new FrameCache();
  let n = 0;
  const cap = async () => ({ buf: Buffer.from('x'), tag: ++n });
  const a = await c.get('d0', cap, { maxAgeMs: 0 });
  const b = await c.get('d0', cap, { maxAgeMs: 0 });
  eq([a.fromCache, b.fromCache], [false, false], '两次都应重新采集');
  eq(b.tag, 2, '第二次应真的又采集了');
});

t('maxAgeMs 内复用，且如实报出来自缓存', async () => {
  const c = new FrameCache();
  let n = 0;
  const cap = async () => ({ buf: Buffer.from('x'), tag: ++n });
  const a = await c.get('d0', cap, { maxAgeMs: 10000 });
  const b = await c.get('d0', cap, { maxAgeMs: 10000 });
  eq(a.fromCache, false);
  eq(b.fromCache, true, '第二次应复用');
  eq(b.tag, 1, '不该重新采集');
  ok(b.cacheAgeMs >= 0, '应报出缓存年龄');
});

t('复用时不伪装成新帧 —— frameTimestamp 是真实采集时刻', async () => {
  const c = new FrameCache();
  const cap = async () => ({ buf: Buffer.from('x') });
  const a = await c.get('d0', cap, { maxAgeMs: 10000 });
  await new Promise((r) => setTimeout(r, 30));
  const b = await c.get('d0', cap, { maxAgeMs: 10000 });
  eq(b.frameTimestamp, a.frameTimestamp, '复用帧的时间戳必须与首次一致，不能取 now');
  ok(b.cacheAgeMs >= 25, `缓存年龄应反映真实等待, 实际 ${b.cacheAgeMs}`);
});

t('不同 displayKey 绝不混用（主屏/副屏坐标系不同）', async () => {
  const c = new FrameCache();
  let n = 0;
  const cap = async () => ({ buf: Buffer.from('x'), tag: ++n });
  await c.get('display:0:sf:AAA', cap, { maxAgeMs: 10000 });
  const other = await c.get('display:1:sf:BBB', cap, { maxAgeMs: 10000 });
  eq(other.fromCache, false, '换了屏必须重新采集，不能拿主屏的帧当副屏');
  eq(other.tag, 2);
});

t('超过 maxAgeMs 后不再复用', async () => {
  const c = new FrameCache();
  let n = 0;
  const cap = async () => ({ buf: Buffer.from('x'), tag: ++n });
  await c.get('d0', cap, { maxAgeMs: 10 });
  await new Promise((r) => setTimeout(r, 40));
  const b = await c.get('d0', cap, { maxAgeMs: 10 });
  eq(b.fromCache, false, '过期了应重新采集');
  eq(b.tag, 2);
});

t('clear() 清掉缓存', async () => {
  const c = new FrameCache();
  const cap = async () => ({ buf: Buffer.from('x') });
  await c.get('d0', cap, { maxAgeMs: 10000 });
  c.clear();
  eq(c.peek('d0'), null);
});

t('peek 报出年龄供调用方决策', async () => {
  const c = new FrameCache();
  await c.get('d0', async () => ({ buf: Buffer.from('x') }), { maxAgeMs: 10000 });
  await new Promise((r) => setTimeout(r, 20));
  const p = c.peek('d0');
  ok(p && p.ageMs >= 15, 'peek 应给出真实年龄');
  eq(c.peek('other'), null, '不同键应返回 null');
});

// 顺序 await 执行: 支持 async 测试, 且失败不会被吞。
let lastGroup;
for (const { name, fn, group } of tests) {
  if (group !== lastGroup) {
    console.log(`${lastGroup === undefined ? '' : '\n'}── ${group ?? '(未分组)'} ──`);
    lastGroup = group;
  }
  try {
    await fn();
    console.log(`  [ OK ] ${name}`);
    pass++;
  } catch (e) {
    console.log(`  [FAIL] ${name}: ${e.message}`);
    fail++;
  }
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
if (fail) process.exitCode = 1;
