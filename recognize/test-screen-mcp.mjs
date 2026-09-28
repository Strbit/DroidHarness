// test-screen-mcp -- MCP 协议端到端测试（带断言）
//
// 这个文件是**唯一能覆盖端到端路径**的测试, 也就是唯一能拦住
// "子进程环境被污染导致 uiautomator 起不来" 那类问题的测试。
//
// 它的前一版是"假绿"的: 打印了期望值但没有任何断言、不设 exitCode,
// 于是子进程压根没接上也能报通过。这里补上真断言 —— 见 PR #11 的审阅意见。
//
// 用法:
//   node test-screen-mcp.mjs                         本地: 用当前 node 跑 screen-mcp.mjs
//   node test-screen-mcp.mjs --exec <cmd> <a1> <a2>  自定义启动命令(如经 adb 跑设备侧)
//
// 退出码: 0 = 全部通过, 1 = 有失败
import { spawn } from 'node:child_process';

const argv = process.argv.slice(2);
let child;
let launchDesc;
if (argv[0] === '--exec') {
  const cmd = argv[1];
  const cmdArgs = argv.slice(2);
  launchDesc = `${cmd} ${cmdArgs.join(' ')}`;
  child = spawn(cmd, cmdArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
} else {
  const target = argv[0] || 'screen-mcp.mjs';
  const nodeBin = argv[1] || process.execPath;
  launchDesc = `${nodeBin} ${target}`;
  child = spawn(nodeBin, [target], { stdio: ['pipe', 'pipe', 'pipe'] });
}

console.log(`启动: ${launchDesc}`);

// 期望答复的 id。1=initialize 2=tools/list 3=list_displays
// 4=screen_targets(默认屏) 5=screen_image 6=screen_targets(非默认屏, 应明确报错)
const WANT_IDS = [1, 2, 3, 4, 5, 6];

let buf = '';
const responses = [];
child.stdout.on('data', (d) => {
  buf += d.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try { responses.push(JSON.parse(line)); }
    catch { responses.push({ _bad: line.slice(0, 200) }); }
  }
});
child.stderr.on('data', (d) => process.stderr.write('[mcp] ' + d.toString('utf8')));

const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');

send({ jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
send({ jsonrpc: '2.0', method: 'notifications/initialized' });

setTimeout(() => send({ jsonrpc: '2.0', id: 2, method: 'tools/list' }), 500);
setTimeout(() => send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_displays', arguments: {} } }), 1200);
setTimeout(() => send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'screen_targets', arguments: {} } }), 3500);
setTimeout(() => send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'screen_image', arguments: {} } }), 12000);
// 非默认屏的树必须明确报错，而不是悄悄返回主屏的树
setTimeout(() => send({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'screen_targets', arguments: { displayId: 2 } } }), 20000);
setTimeout(() => { try { child.kill(); } catch { /* 已退出 */ } report(); }, 32000);

let done = false;
child.on('exit', () => setTimeout(report, 200));
// 子进程起不来时也要以非 0 退出（否则 CI 会以为通过）
child.on('error', (e) => {
  console.log(`FAIL —— 子进程启动失败: ${e.message}`);
  process.exitCode = 1;
});

function report() {
  if (done) return;
  done = true;

  const failures = [];
  const notes = [];
  const byId = new Map();
  for (const r of responses) {
    if (r._bad) { failures.push(`收到无法解析的行: ${r._bad}`); continue; }
    if (r.id !== undefined && r.id !== null) byId.set(r.id, r);
  }

  console.log('');
  console.log('═══ 断言结果 ═══');

  // ── 1. 所有期望的答复都收到 ────────────────────────────
  const missing = WANT_IDS.filter((id) => !byId.has(id));
  if (missing.length) {
    failures.push(`缺少答复 id: ${missing.join(', ')}` +
      `（收到 [${[...byId.keys()].sort((a, b) => a - b).join(', ')}]）` +
      ' —— 子进程没起来或没接上 stdin/stdout');
  }

  // ── 2. initialize ─────────────────────────────────────
  const r1 = byId.get(1);
  if (r1) {
    if (!r1.result) failures.push('#1 initialize 没有 result');
    else {
      if (r1.result.protocolVersion !== '2025-11-25') {
        failures.push(`#1 协议版本应为 2025-11-25，实际 ${r1.result.protocolVersion}`);
      }
      if (!r1.result.serverInfo || !r1.result.serverInfo.name) failures.push('#1 缺少 serverInfo.name');
      if (!r1.result.capabilities || !r1.result.capabilities.tools) failures.push('#1 缺少 tools 能力');
      notes.push(`#1 initialize: 协议 ${r1.result.protocolVersion}, 服务 ${r1.result.serverInfo?.name}@${r1.result.serverInfo?.version}`);
    }
  }

  // ── 3. tools/list 必须列出 4 个工具 ───────────────────
  const EXPECTED_TOOLS = ['list_displays', 'screen_tree', 'screen_targets', 'screen_image'];
  const r2 = byId.get(2);
  if (r2) {
    const names = (r2.result?.tools || []).map((t) => t.name);
    const lack = EXPECTED_TOOLS.filter((n) => !names.includes(n));
    if (lack.length) failures.push(`#2 tools/list 缺少工具: ${lack.join(', ')}（实际 ${names.join(', ')}）`);
    else notes.push(`#2 tools/list: ${names.length} 个工具 ✓ ${names.join(', ')}`);
  }

  // ── 4. 各 tools/call 的诊断输出 ───────────────────────
  for (const id of [3, 4, 5, 6]) {
    const r = byId.get(id);
    if (!r || !r.result) continue;
    const c = r.result.content || [];
    const txt = (c.find((x) => x.type === 'text') || {}).text || '';
    const img = c.find((x) => x.type === 'image');
    console.log(`  #${id} isError=${!!r.result.isError}` +
      (img ? ` 图片=${Buffer.from(img.data, 'base64').length} B` : '') +
      `  文本: ${txt.split('\n')[0].slice(0, 90)}`);
  }

  // ── 5. #3 list_displays 必须报出屏信息 ────────────────
  // 注意形态: 必须**先判 isError**, 不能写成 `if (r3 && !r3.result?.isError) { ... }` ——
  // 那样 isError=true 时整段断言被静默跳过, 照样报"全部通过"。
  // (这正是 @Strbit 在第二轮审阅里指出的: 真机上 #3 恰恰是 isError, 而输出仍报通过。)
  // #4 用的是正确形态, 这里对齐。
  const r3 = byId.get(3);
  if (r3) {
    const txt = (r3.result?.content || []).find((x) => x.type === 'text')?.text || '';
    if (r3.result?.isError) {
      failures.push('#3 list_displays 失败: ' + txt.split('\n')[0].slice(0, 200));
    } else if (!/displayId|surfaceFlingerId/.test(txt)) {
      failures.push('#3 list_displays 输出里没有屏信息');
    } else {
      notes.push('#3 list_displays: 解析出屏信息 ✓');
    }
  }

  // ── 6. #4 screen_targets 必须成功（这是主路线）────────
  // 这一条正是能拦住"LD_LIBRARY_PATH 打死 uiautomator"的那道门：
  // 环境被污染时它会 isError=true 且文本里含 CANNOT LINK。
  const r4 = byId.get(4);
  if (r4) {
    const txt = (r4.result?.content || []).find((x) => x.type === 'text')?.text || '';
    if (r4.result?.isError) {
      failures.push('#4 screen_targets 失败（树路线不通）: ' + txt.split('\n')[0].slice(0, 200));
      if (/CANNOT LINK|libz\.so/i.test(txt)) {
        failures.push('#4 失败原因是动态链接库问题 —— 检查子进程是否继承了 LD_LIBRARY_PATH');
      }
    } else if (!/targetCount|displayState/.test(txt)) {
      failures.push('#4 screen_targets 输出缺少 targetCount/displayState');
    } else {
      notes.push('#4 screen_targets: 树路线可用 ✓');
    }
  }

  // ── 7. #5 screen_image 必须返回 PNG 图片块 ────────────
  const r5 = byId.get(5);
  if (r5) {
    if (r5.result?.isError) failures.push('#5 screen_image 返回错误');
    else {
      const img = (r5.result.content || []).find((x) => x.type === 'image');
      if (!img) failures.push('#5 screen_image 没有返回 image 内容块');
      else if (!String(img.data).startsWith('iVBORw0KGgo')) failures.push('#5 图片不是 PNG（magic 不对）');
      else notes.push(`#5 screen_image: PNG ${Buffer.from(img.data, 'base64').length} B ✓`);
    }
  }

  // ── 8. #6 非默认屏的树必须明确报错 ────────────────────
  // 静默返回主屏的树是本 PR 自己点名要防的"静默错坐标"。
  const r6 = byId.get(6);
  if (r6) {
    if (!r6.result?.isError) {
      failures.push('#6 非默认屏请求树时应当明确报错，实际返回了成功 —— 这会导致静默错坐标');
    } else {
      const txt = (r6.result.content || []).find((x) => x.type === 'text')?.text || '';
      if (!/tree-needs-app|只作用于默认屏/.test(txt)) {
        failures.push('#6 报错信息未说明原因（应含 tree-needs-app）');
      } else {
        notes.push('#6 非默认屏的树: 明确报错 ✓（未静默返回主屏的树）');
      }
    }
  }

  // ── 汇总 ──────────────────────────────────────────────
  console.log('');
  for (const n of notes) console.log(`  ✓ ${n}`);
  console.log('');
  if (failures.length) {
    console.log(`FAIL —— ${failures.length} 项失败:`);
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exitCode = 1;
  } else {
    const got = [...byId.keys()].sort((a, b) => a - b);
    console.log(`OK —— ${got.length}/${WANT_IDS.length} 项答复, 全部断言通过`);
    process.exitCode = 0;
  }
}
