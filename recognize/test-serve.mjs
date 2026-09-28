// test-serve -- PC 侧 CLI 的逐行 JSON 协议测试（带断言）
//
// 这个文件是**唯一覆盖 PC 侧 CLI 的测试**，也就是唯一能拦住
// "跨设备修复只落在设备侧、PC 侧静默返回 0 块屏"（PR #11 第三轮 B1）的那道门。
//
// 它原来是"假绿"的：只 console.log，0 处断言、0 处 throw、0 处退出码 ——
// 于是真机上它把 B1 的证据打在屏幕上，然后判定"通过"：
//     #2 op=displays (397 ms)   0 个屏, 唤醒=Awake
//     #4 op=targets            屏状态=null
//     exit code = 0
//
// README 第 8 条经验"测试没有断言 = 假绿"就是这个 PR 自己的教训，
// test-screen-mcp.mjs 已经改对了，这个文件漏了。现在补上。
//
// 需要设备（它通过 adb 驱动设备）。没设备时**明确失败**并说明原因，
// 而不是静默通过 —— 否则 CI 上会一直绿灯。
//
// 用法: node test-serve.mjs
// 退出码: 0 = 全通过, 1 = 有失败
import { spawn } from 'node:child_process';

const TIMEOUT_MS = Number(process.env.SERVE_TEST_TIMEOUT_MS || 60000);

const child = spawn(process.execPath, ['recognize.mjs', 'serve'], {
  cwd: import.meta.dirname,
  env: { ...process.env, ADB: process.env.ADB || 'D:\\platform-tools\\adb.exe' },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let buf = '';
const responses = [];
child.stdout.on('data', (d) => {
  buf += d.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try { responses.push(JSON.parse(line)); } catch { responses.push({ _parseError: line.slice(0, 200) }); }
  }
});
child.stderr.on('data', (d) => process.stderr.write('[svc] ' + d.toString('utf8')));

const send = (obj) => child.stdin.write(JSON.stringify(obj) + '\n');

// 期望的答复 id（shutdown 也应有答复，然后进程退出）
const WANT = [1, 2, 3, 4, 5];
const seq = [
  { id: 1, op: 'ping' },
  { id: 2, op: 'displays' },
  { id: 3, op: 'tree' },
  { id: 4, op: 'targets', displayId: 0 },
  { id: 5, op: 'shutdown' },
];

let idx = 0;
const next = () => {
  if (idx >= seq.length) return;
  send(seq[idx++]);
  setTimeout(next, 6000);
};
next();

const hardStop = setTimeout(() => { try { child.kill(); } catch { /* 已退出 */ } report(); }, TIMEOUT_MS);
child.on('exit', () => { clearTimeout(hardStop); setTimeout(report, 300); });
child.on('error', (e) => {
  console.log(`FAIL —— 无法启动 recognize.mjs serve: ${e.message}`);
  process.exitCode = 1;
});

let reported = false;
function report() {
  if (reported) return;
  reported = true;

  const failures = [];
  const notes = [];
  const byId = new Map();
  for (const r of responses) {
    if (r._parseError) { failures.push(`收到无法解析的行: ${r._parseError}`); continue; }
    if (r.type === 'ready') continue;
    if (r.id !== undefined && r.id !== null) byId.set(r.id, r);
  }

  console.log('');
  console.log('═══ 逐条断言 ═══');

  // ── 三态完备：每个 byId.get(n) 都必须"收到 -> 判定 -> pass 或 fail" ──
  const missing = WANT.filter((id) => !byId.has(id));
  if (missing.length) {
    failures.push(`缺少答复 id: ${missing.join(', ')}（收到 [${[...byId.keys()].sort((a, b) => a - b).join(', ')}]）` +
      ' —— 服务没起来，或没接上 stdin/stdout');
  }

  // #1 ping
  const r1 = byId.get(1);
  if (r1) {
    if (!r1.ok) failures.push(`#1 ping 返回失败: ${r1.error}`);
    else notes.push(`#1 ping ok, pid=${r1.result?.pid}`);
  }

  // #2 displays —— 这条正是 B1 的防线：真机必须有 >=1 块屏，且 state 是合法枚举
  const r2 = byId.get(2);
  if (r2) {
    if (!r2.ok) {
      failures.push(`#2 displays 失败: ${r2.error} ${r2.detail || ''}`);
    } else {
      const res = r2.result || {};
      const list = res.displays || [];
      if (list.length === 0) {
        // B1 的症状就是这个：解析不出屏 → 空数组 → 上层拿到 displayState=null
        failures.push(`#2 displays 返回 0 块屏 —— 屏解析路径没生效（PC 侧 B1 的典型症状）`);
      } else {
        notes.push(`#2 displays ok: ${list.length} 块屏, 唤醒=${res.wakefulness}`);
        for (const d of list) {
          if (!d.surfaceFlingerId) failures.push(`#2 屏 ${d.logicalId} 缺 surfaceFlingerId`);
          if (!['ON', 'OFF', 'DOZE', 'DOZE_SUSPEND'].includes(d.state)) {
            failures.push(`#2 屏 ${d.logicalId} 的 state 不是合法枚举: ${JSON.stringify(d.state)}`);
          }
        }
        // 至少一块屏的 state 必须解析出来（null 说明锚点没对上）
        if (list.every((d) => d.state === null)) {
          failures.push('#2 所有屏的 state 都是 null —— 屏状态锚点没生效（裸 state= 会抓到历史噪声）');
        }
      }
    }
  }

  // #3 tree —— 允许 ok=false（熄屏/自绘界面是合法结果），但必须**明确**给出原因
  const r3 = byId.get(3);
  if (r3) {
    if (!r3.ok) {
      // 协议层失败（op 本身出错）才算失败；result.ok=false 是可接受的业务结果
      failures.push(`#3 tree 协议层失败: ${r3.error} ${r3.detail || ''}`);
    } else {
      const res = r3.result || {};
      if (res.ok === false) {
        if (!res.error) failures.push('#3 tree 业务失败但没给 error 字段（必须说明原因）');
        else notes.push(`#3 tree 明确报失败: ${res.error}（属可接受结果）`);
      } else {
        if (!Number.isInteger(res.nodeCount)) failures.push('#3 tree 缺少 nodeCount');
        else if (res.nodeCount === 0) failures.push('#3 tree nodeCount=0 —— 解析出空树');
        else notes.push(`#3 tree ok: ${res.nodeCount} 节点, targets=${res.targets?.length}, useful=${res.usefulness?.useful}`);
        // 中文不能被破坏（stdout 编码问题会让它变成乱码）
        const cn = (res.labelled || []).filter((n) => /[\u4e00-\u9fa5]/.test(n.text || n.desc || ''));
        if ((res.labelled || []).length > 0 && cn.length === 0) {
          failures.push('#3 tree 有标签节点但一个中文都没有 —— 编码可能被破坏');
        } else if (cn.length) {
          notes.push(`#3 中文标签 ${cn.length} 个（编码正常）`);
        }
      }
    }
  }

  // #4 targets —— 这条守着 B1 的第二个症状：displayState=null
  const r4 = byId.get(4);
  if (r4) {
    if (!r4.ok) {
      failures.push(`#4 targets 失败: ${r4.error} ${r4.detail || ''}`);
    } else {
      const res = r4.result || {};
      // 核心断言：屏状态必须解析出来。null 意味着屏解析没生效（B1 症状）
      if (res.displayState === undefined || res.displayState === null) {
        failures.push(`#4 targets 的 displayState=${JSON.stringify(res.displayState)} —— ` +
          '屏状态没解析出来，调用方无法判断坐标是否可信（B1 的典型症状）');
      } else if (!['ON', 'OFF', 'DOZE', 'DOZE_SUSPEND'].includes(res.displayState)) {
        failures.push(`#4 targets 的 displayState 不是合法枚举: ${JSON.stringify(res.displayState)}`);
      } else {
        notes.push(`#4 targets ok: ${res.targets?.length} -> 去重 ${res.deduped?.length}, 屏状态=${res.displayState}`);
      }
      // 去重必须真的工作：toTargets 缺 center 时会静默跳过全部去重。
      //
      // 断言必须精确 —— 第一版写的是"原始数和去重数相同就失败"，实测**误报**了：
      // 真机上 25 个目标的中心点最小间距远超 8px 容差，**一对重叠都没有**，
      // 于是 25 -> 25 是正确的。所以改为：**只在真有重叠却没合并时失败**。
      if (Array.isArray(res.targets) && Array.isArray(res.deduped)) {
        const tol = 8;  // 与 dedupeTargets 的最小容差一致
        let overlapping = 0;
        for (let i = 0; i < res.targets.length; i++) {
          for (let j = i + 1; j < res.targets.length; j++) {
            const a = res.targets[i].center, b = res.targets[j].center;
            if (!a || !b) continue;
            if (Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol) overlapping++;
          }
        }
        if (overlapping > 0 && res.deduped.length === res.targets.length) {
          failures.push(`#4 有 ${overlapping} 对重叠目标（中心点相距 <=${tol}px）却没被合并 —— ` +
            '去重失效：toTargets 缺 center 字段时会静默跳过全部去重');
        } else if (overlapping > 0) {
          notes.push(`#4 去重生效: ${overlapping} 对重叠 -> 合并 ${res.targets.length - res.deduped.length} 个`);
        } else {
          notes.push(`#4 本次无重叠目标（${res.targets.length} 个），去重无事可做属正常`);
        }
        // 独立检查：center 字段必须存在，否则去重永远无输入
        const noCenter = res.targets.filter((t) => !t.center).length;
        if (res.targets.length > 0 && noCenter === res.targets.length) {
          failures.push(`#4 全部 ${noCenter} 个目标都没有 center —— 去重的输入缺失`);
        }
      }
    }
  }

  // #5 shutdown
  const r5 = byId.get(5);
  if (r5 && !r5.ok) failures.push(`#5 shutdown 失败: ${r5.error}`);

  // ── 汇总 ──
  console.log('');
  for (const n of notes) console.log(`  ✓ ${n}`);
  console.log('');
  if (failures.length) {
    console.log(`FAIL —— ${failures.length} 项失败:`);
    for (const f of failures) console.log(`  ✗ ${f}`);
    console.log('');
    console.log('提示: 本测试**需要设备**（通过 adb 驱动）。无设备时应当失败而不是跳过。');
    process.exitCode = 1;
  } else {
    console.log(`OK —— ${byId.size}/${WANT.length} 项答复, 全部断言通过`);
    process.exitCode = 0;
  }
}
