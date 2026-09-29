#!/usr/bin/env node
/**
 * test-ui-lock.mjs — 证明那把单飞锁真的"单飞"
 *
 * 为什么这个测试存在 (而不是只在真机上跑一次)
 * -------------------------------------------
 * 真机测出来的事实是: 并发的第二个 `uiautomator dump` 会被框架 **SIGKILL**
 * 且不生成文件（见 lib/ui-lock.mjs 顶部）。锁要是写错——比如错误传播时把链
 * 卡死、或者 `tail` 更新时机不对导致两个任务同时跑——症状就是"偶尔读不到树"，
 * 而那正是我们刚花了一整轮去排查的形状。这种 bug 必须在没有设备的机器上也能拦住。
 *
 * 每个断言都要求**可观察的证据**(峰值并发数、完成顺序)，不接受"没报错就算过"。
 *
 * 用法: node recognize/test-ui-lock.mjs
 */
import { createSerialLock } from './lib/ui-lock.mjs';

let pass = 0;
let fail = 0;
const fails = [];
function ok(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    fails.push(name);
    console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('[1] 并发峰值必须是 1');
{
  const lock = createSerialLock();
  let active = 0;
  let peak = 0;
  const jobs = Array.from({ length: 8 }, (_, i) =>
    lock.run(async () => {
      active++;
      if (active > peak) peak = active;
      await sleep(5 + (i % 3));
      active--;
      return i;
    }),
  );
  const rs = await Promise.all(jobs);
  ok('8 个任务同时提交, 峰值并发 = 1', peak === 1, `实际峰值 ${peak}`);
  ok('8 个任务全部拿到自己的返回值', rs.join(',') === '0,1,2,3,4,5,6,7', rs.join(','));
  ok('锁自己的 stats.peak 也记的是 1', lock.stats().peak === 1, JSON.stringify(lock.stats()));
  ok('跑完后队列清空', lock.stats().queued === 0, JSON.stringify(lock.stats()));
}

console.log('');
console.log('[2] 严格按提交顺序 (FIFO)');
{
  const lock = createSerialLock();
  const done = [];
  // 故意让先提交的任务慢、后提交的快: 若不串行, 顺序会变成 3,2,1
  const p = [50, 10, 10].map((ms, i) => lock.run(async () => { await sleep(ms); done.push(i); }));
  await Promise.all(p);
  ok('慢任务在前也不会被后来者插队', done.join(',') === '0,1,2', done.join(','));
}

console.log('');
console.log('[3] 任务抛错不能把后面的永久卡死');
{
  const lock = createSerialLock();
  let e = null;
  await lock.run(async () => { throw new Error('boom'); }).catch((x) => { e = x; });
  ok('错误原样传给调用方', !!e && e.message === 'boom', String(e && e.message));
  const after = await Promise.race([
    lock.run(async () => 'still runs'),
    sleep(500).then(() => 'TIMEOUT'),
  ]);
  ok('抛错之后锁仍然可用 (没死锁)', after === 'still runs', after);
}

console.log('');
console.log('[4] 连续抛错也不污染链');
{
  const lock = createSerialLock();
  let thrown = 0;
  for (let i = 0; i < 3; i++) await lock.run(async () => { throw new Error('x' + i); }).catch(() => thrown++);
  ok('3 次抛错都被计数到', thrown === 3, `实际 ${thrown}`);
  const v = await Promise.race([lock.run(async () => 42), sleep(500).then(() => 'TIMEOUT')]);
  ok('之后仍能正常执行', v === 42, String(v));
}

console.log('');
console.log('[5] 等待者不会提前起跑');
{
  const lock = createSerialLock();
  const started = [];
  const t0 = Date.now();
  const first = lock.run(async () => { started.push(['a', Date.now() - t0]); await sleep(60); });
  const second = lock.run(async () => { started.push(['b', Date.now() - t0]); });
  await Promise.all([first, second]);
  const b = started.find((x) => x[0] === 'b');
  ok('第二个任务的开始时间 >= 第一个的结束 (不是并发)', !!b && b[1] >= 55, JSON.stringify(started));
}

console.log('');
console.log('='.repeat(52));
console.log(`  ${pass} 通过 / ${fail} 失败`);
if (fails.length) console.log('  失败项:\n    - ' + fails.join('\n    - '));
process.exitCode = fail > 0 ? 1 : 0;
