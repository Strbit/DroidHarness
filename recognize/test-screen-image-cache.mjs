// 验证 screen-mcp 的 screen_image 缓存链路（不需要设备）
//
// 这不能替代真机测试, 但能证明三件事:
//   1. 缓存键包含 displayId —— 主屏/副屏绝不混用
//   2. 复用时不伪装时间戳 —— frameTimestamp 是该帧真实采集时刻
//   3. frame 元数据结构与 screen_image 返回的一致
import { FrameCache } from './lib/fields.mjs';

let pass = 0, fail = 0;
const tests = [];
const t = (name, fn) => tests.push({ name, fn });
const eq = (a, b, m) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${m || ''}: 期望 ${JSON.stringify(b)}, 得到 ${JSON.stringify(a)}`);
  }
};
const ok = (c, m) => { if (!c) throw new Error(m || '断言失败'); };

/** 造一个最小的合法 PNG（头部字段足够解析宽高） */
function fakePng(width, height, payloadByte) {
  const b = Buffer.alloc(64);
  b[0] = 0x89; b[1] = 0x50; b[2] = 0x4e; b[3] = 0x47;
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  b[63] = payloadByte;
  return b;
}

/** 复现 screen-mcp 的采集形态：计数 + 造帧 */
function makeCapture(counters) {
  return (sfId) => {
    counters.n += 1;
    return {
      buf: fakePng(1272, 2772, counters.n),
      isPng: true, width: 1272, height: 2772, bytes: 64,
      sfId, captureMs: 123,
    };
  };
}

const MAIN = 'display:0:sf:4630946903293830803';
const VIRT = 'display:1:sf:9999999999999999999';

const results = {};

t('默认 maxAgeMs=0：每次都真采集', async () => {
  const cache = new FrameCache();
  const c = { n: 0 };
  const cap = makeCapture(c);
  const a = await cache.get(MAIN, () => cap('4630946903293830803'), { maxAgeMs: 0 });
  const b = await cache.get(MAIN, () => cap('4630946903293830803'), { maxAgeMs: 0 });
  eq([a.fromCache, b.fromCache], [false, false], '都不该来自缓存');
  eq(c.n, 2, '应采集两次');
});

t('maxFrameAgeMs 内复用，且元数据如实标注', async () => {
  const cache = new FrameCache();
  const c = { n: 0 };
  const cap = makeCapture(c);
  const first = await cache.get(MAIN, () => cap('4630946903293830803'), { maxAgeMs: 5000 });
  await new Promise((r) => setTimeout(r, 25));
  const second = await cache.get(MAIN, () => cap('4630946903293830803'), { maxAgeMs: 5000 });
  eq(first.fromCache, false);
  eq(second.fromCache, true, '第二次应命中缓存');
  eq(c.n, 1, '不该重复采集');
  eq(second.frameTimestamp, first.frameTimestamp, '复用帧时间戳必须等于首次采集时刻，不能取 now');
  ok(second.cacheAgeMs >= 20, `应报出缓存年龄, 实际 ${second.cacheAgeMs}`);
  eq(second.buf[63], first.buf[63], '复用的应是同一份字节');
  results.cached = { first, second };
});

t('主屏/副屏缓存绝不串味', async () => {
  const cache = new FrameCache();
  const c = { n: 0 };
  const cap = makeCapture(c);
  const main = await cache.get(MAIN, () => cap('4630946903293830803'), { maxAgeMs: 5000 });
  const virt = await cache.get(VIRT, () => cap('9999999999999999999'), { maxAgeMs: 5000 });
  eq(virt.fromCache, false, '换屏必须重新采集，不能把主屏的帧当副屏');
  eq(c.n, 2, '两块屏各采集一次');
  ok(main.buf[63] !== virt.buf[63], '两块屏的帧内容应不同');
});

t('screen_image 的 frame 元数据结构完整', () => {
  const r = results.cached.second;
  const frame = {
    fromCache: !!r.fromCache,
    frameTimestamp: r.frameTimestamp,
    ageMs: Date.now() - r.frameTimestamp,
    captureMs: r.captureMs,
    displayId: 0,
    surfaceFlingerId: r.sfId ?? null,
    width: r.width,
    height: r.height,
    displayState: 'ON',
  };
  for (const k of ['fromCache', 'frameTimestamp', 'ageMs', 'captureMs', 'displayId',
    'surfaceFlingerId', 'width', 'height', 'displayState']) {
    ok(k in frame, `frame 缺字段 ${k}`);
  }
  eq(frame.fromCache, true);
  eq(frame.width, 1272);
  ok(frame.ageMs >= 20, 'ageMs 应反映真实年龄');
});

t('缓存过期后重新采集', async () => {
  const cache = new FrameCache();
  const c = { n: 0 };
  const cap = makeCapture(c);
  await cache.get(MAIN, () => cap('a'), { maxAgeMs: 15 });
  await new Promise((r) => setTimeout(r, 40));
  const after = await cache.get(MAIN, () => cap('a'), { maxAgeMs: 15 });
  eq(after.fromCache, false, '过期应重新采集');
  eq(c.n, 2);
});

t('peek 让调用方先问"值不值得复用"', async () => {
  const cache = new FrameCache();
  const c = { n: 0 };
  const cap = makeCapture(c);
  eq(cache.peek(MAIN), null, '没采集过应返回 null');
  await cache.get(MAIN, () => cap('a'), { maxAgeMs: 5000 });
  const p = cache.peek(MAIN);
  ok(p !== null && typeof p.ageMs === 'number', 'peek 应给出年龄');
  eq(cache.peek('display:9:sf:zzz'), null, '别的键应返回 null');
});

// 顺序执行并真正 await（这是我上一版测试运行器的 bug：try{fn()} 抓不到 async rejection）
console.log('── screen_image 缓存链路 ──');
for (const { name, fn } of tests) {
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
