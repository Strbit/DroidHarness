// test-uiaction -- 动作层纯逻辑测试（不碰设备）
//
// 测什么: 服务列表的合并/摘除/判定(marker 自愈的状态机基础)、physicalInput 的
// argv 构造(注入面: 参数必须走 argv, 不拼 shell 字符串)、dex 缺失时的报错形状。
// 不测什么: 真机上的 a11y 挂载/注入 —— 那由 device-selftest 在设备上验。
//
// 用法: node test-uiaction.mjs   (在 recognize/ 下)
import assert from 'node:assert/strict';
import { physicalInput, _a11yList, _vdGeom, DEX_PATH } from './lib/uiaction.mjs';
import fs from 'node:fs';

let passed = 0;
const t = (name, fn) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
};

console.log('uiaction 纯逻辑测试');

// ── 服务列表操作 ────────────────────────────────────────────
const { hasService, mergeService, removeService } = _a11yList;

t('hasService: 空值不含任何服务', () => {
  assert.equal(hasService('', 'x/y'), false);
  assert.equal(hasService(null, 'x/y'), false);
});

t('hasService: 冒号列表精确匹配(不是子串)', () => {
  const list = 'a/b.C:d/e.F';
  assert.equal(hasService(list, 'a/b.C'), true);
  assert.equal(hasService(list, 'd/e.F'), true);
  // 子串不算 —— 'a/b' 是 'a/b.C' 的一部分但不是列表项
  assert.equal(hasService(list, 'a/b'), false);
  assert.equal(hasService(list, 'b.C'), false);
});

t('mergeService: 空原值 → 只有新服务', () => {
  assert.equal(mergeService('', 'x/y'), 'x/y');
  assert.equal(mergeService(null, 'x/y'), 'x/y');
});

t('mergeService: 有原值 → 冒号追加', () => {
  assert.equal(mergeService('a/b', 'x/y'), 'a/b:x/y');
});

t('removeService: 摘掉目标保留其余(顺序不变)', () => {
  assert.equal(removeService('a/b:x/y:c/d', 'x/y'), 'a/b:c/d');
  assert.equal(removeService('x/y', 'x/y'), '');
  assert.equal(removeService('a/b', 'x/y'), 'a/b');
  // 空白容忍: settings 值里可能有空格
  assert.equal(removeService('a/b : x/y', 'x/y'), 'a/b');
});

t('merge→remove 往返: 原值无损还原', () => {
  const orig = 'user/svc.A:user/svc.B';
  const merged = mergeService(orig, 'ours/x');
  assert.equal(removeService(merged, 'ours/x'), orig);
});

// ── physicalInput argv 构造 ────────────────────────────────
// 直接观察它 spawn 的命令: 注入 run 的假 spawnImpl。

function captureSpawn() {
  const calls = [];
  const fake = (cmd, args, opts, cb) => {
    calls.push({ cmd, args, env: opts?.env });
    cb(null, '', '');
  };
  return { calls, fake };
}

t('physicalInput tap: displayId 0 不加 -d, 坐标走 argv', async () => {
  const { calls, fake } = captureSpawn();
  const r = await physicalInput('tap', { x: 100, y: 200, displayId: 0 }, { spawnImpl: fake });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, '/system/bin/input');
  assert.deepEqual(calls[0].args, ['tap', '100', '200']);
  assert.equal(r.ok, true);
});

t('physicalInput tap: displayId 3 加 -d 3', async () => {
  const { calls, fake } = captureSpawn();
  await physicalInput('tap', { x: 5, y: 6, displayId: 3 }, { spawnImpl: fake });
  assert.deepEqual(calls[0].args, ['-d', '3', 'tap', '5', '6']);
});

t('physicalInput swipe: 带 durationMs', async () => {
  const { calls, fake } = captureSpawn();
  await physicalInput('swipe', { x1: 1, y1: 2, x2: 3, y2: 4, durationMs: 600, displayId: 0 }, { spawnImpl: fake });
  assert.deepEqual(calls[0].args, ['swipe', '1', '2', '3', '4', '600']);
});

t('physicalInput swipe: 不带 durationMs 时省略第五参', async () => {
  const { calls, fake } = captureSpawn();
  await physicalInput('swipe', { x1: 1, y1: 2, x2: 3, y2: 4, displayId: 0 }, { spawnImpl: fake });
  assert.deepEqual(calls[0].args, ['swipe', '1', '2', '3', '4']);
});

t('physicalInput key: keycode 走 argv', async () => {
  const { calls, fake } = captureSpawn();
  await physicalInput('key', { keycode: 4, displayId: 0 }, { spawnImpl: fake });
  assert.deepEqual(calls[0].args, ['keyevent', '4']);
});

t('physicalInput: 坐标是数字字符串(不接受对象/字符串注入)', async () => {
  const { calls, fake } = captureSpawn();
  // Number('100') 的路径与真调用一致; 恶意字符串会被 Number() 变 NaN → 不进 argv
  await physicalInput('tap', { x: Number('100'), y: Number('2;rm -rf /'), displayId: 0 }, { spawnImpl: fake });
  // NaN 不参与 spawn: 实现里 String(NaN)='NaN' 只是无效坐标, 不构成注入
  assert.deepEqual(calls[0].args, ['tap', '100', 'NaN']);
});

// ── dex 缺失报错 ───────────────────────────────────────────
t('DEX_PATH 指向 tools 根(与 lib 同级的 dsh-action.dex)', () => {
  assert.ok(DEX_PATH.endsWith('dsh-action.dex'), DEX_PATH);
  assert.ok(!DEX_PATH.includes('/lib/'), 'dex 不应在 lib/ 下: ' + DEX_PATH);
});

// ── runCommand 默认实现必须能跑（真机 regression）──────────
// 症状: screen-mcp 里所有观察工具都传了 spawnImpl(execFile), 所以"默认 spawnImpl
// 是 null"这个坑一直被掩盖; 动作层(uiaction.mjs)起先没传, 真机 MCP 链路一跑就
// `spawn is not a function`。这条断言让它在 PC 上就能红。
console.log('');
console.log('runCommand 默认实现 (真机 regression 回归)');
const spawnEnv = await import('./lib/spawn-env.mjs');
{
  let ok = false;
  let errMsg = '';
  try {
    const r = await spawnEnv.runCommand(process.execPath, ['-e', 'process.stdout.write("ok")'], { timeout: 15000 });
    ok = String(r.stdout).trim() === 'ok';
    if (!ok) errMsg = 'stdout=' + JSON.stringify(String(r.stdout));
  } catch (e) {
    errMsg = e.message;
  }
  t('不传 spawnImpl 时 runCommand 仍能执行(默认 execFile)', () => {
    assert.ok(ok, errMsg + ' ← 默认实现坏了, 真机上所有子进程调用都会挂');
  });
}

// ══════════════════════════════════════════════════════════════════
// 副屏宽度夹取 (真机 regression)
//
// 症状: 副屏宽度 ≠ 主屏宽度时, **主屏桌面**的大时钟按 (副屏宽/主屏宽) 缩放,
// 且不自愈 —— 用户看到"时钟被切掉一位"(如 18:17 的 7 只剩右半)。
// 实测数据(小米 25102RKBEC / Android 16, 主屏 1200x2608@480):
//     1200x2608@480 → 时钟高 326(正常)   1200x2608@320 → 326(正常, 密度无关)
//     1200x1200@480 → 326(正常, 高度无关)  800x1200@480 → 217(异常)
//     217/326 = 0.666 ≈ 800/1200 ← 只有宽度参与
// 所以 vdStart 必须把 width 夹到主屏宽度, 高度同比缩放。
console.log('');
console.log('副屏几何: 宽度夹取 (真机 regression 回归)');
{
  const g = _vdGeom;

  t('宽度与主屏一致 → 原样不动', () => {
    const r = g.snapWidthToMain(1200, 2608, 1200);
    assert.equal(r.snapped, false);
    assert.equal(r.width, 1200);
    assert.equal(r.height, 2608);
  });

  t('宽度 800 / 主屏 1200 → 夹到 1200, 高度同比放大', () => {
    // 800x1200 → 1200x1800 (ratio 1.5), 保住调用方的宽高比
    const r = g.snapWidthToMain(800, 1200, 1200);
    assert.equal(r.snapped, true);
    assert.equal(r.width, 1200);
    assert.equal(r.height, 1800);
    assert.equal(r.ratio, 1.5);
  });

  t('宽度大于主屏 → 同样夹回来(等比缩小高度)', () => {
    const r = g.snapWidthToMain(2400, 5200, 1200);
    assert.equal(r.snapped, true);
    assert.equal(r.width, 1200);
    assert.equal(r.height, 2600);
    assert.equal(r.ratio, 0.5);
  });

  t('高度取整后不会变成 0(极小值兜底)', () => {
    const r = g.snapWidthToMain(1200_0000, 1, 1200);
    assert.equal(r.width, 1200);
    assert.ok(r.height >= 1, `height=${r.height} 应 >= 1`);
  });

  t('拿不到主屏宽度 → 原样返回, 不瞎猜', () => {
    for (const bad of [null, undefined, NaN, 0, -1]) {
      const r = g.snapWidthToMain(800, 1200, bad);
      assert.equal(r.snapped, false, `mainWidth=${bad} 不该夹取`);
      assert.equal(r.width, 800);
      assert.equal(r.height, 1200);
    }
  });

  t('宽度本身非法 → 不夹(交给调用方的完整性检查报错)', () => {
    const r = g.snapWidthToMain(NaN, 1200, 1200);
    assert.equal(r.snapped, false);
  });
}

console.log('');
if (process.exitCode) {
  console.log(`FAIL —— 有失败项`);
} else {
  console.log(`OK —— ${passed} 项断言通过`);
}
