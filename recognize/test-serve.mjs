// 测试识别服务的逐行 JSON 协议
// 用 Node 管道通信（避免 PowerShell 管道在嵌套原生 stdio 上的限制）
import { spawn } from 'node:child_process';

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

// 依次发起请求, 留出设备操作时间
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

setTimeout(() => {
  child.kill();
  report();
}, 45000);

child.on('exit', () => setTimeout(report, 300));

let reported = false;
function report() {
  if (reported) return;
  reported = true;
  console.log('═══ 收到的响应 ═══');
  for (const r of responses) {
    if (r._parseError) { console.log('  [解析失败] ' + r._parseError); continue; }
    if (r.type === 'ready') { console.log(`  [ready] schema=${r.schema} pid=${r.pid}`); continue; }
    if (!r.ok) { console.log(`  #${r.id} op=${r.op} 失败: ${r.error} ${r.detail || ''}`); continue; }
    const res = r.result || {};
    let summary = '';
    switch (r.op) {
      case 'ping': summary = `pong pid=${res.pid}`; break;
      case 'displays': summary = `${res.displays?.length} 个屏, 唤醒=${res.wakefulness}`; break;
      case 'tree': summary = res.ok === false
        ? `失败(${res.error})`
        : `${res.nodeCount} 节点, 目标 ${res.targets?.length}, 可用=${res.usefulness?.useful}, 标签 ${res.labelled?.length}`; break;
      case 'targets': summary = `目标 ${res.targets?.length} -> 去重 ${res.deduped?.length}, 屏状态=${res.displayState}`; break;
      case 'shutdown': summary = '已请求退出'; break;
    }
    console.log(`  #${r.id} op=${r.op} (${r.ms} ms)  ${summary}`);
  }
  console.log('');
  console.log(`响应总数 = ${responses.length} (期望 1 ready + 5 答复 = 6)`);

  // 校验中文未被破坏
  const treeResp = responses.find((r) => r.op === 'tree' && r.ok);
  if (treeResp?.result?.labelled) {
    const cn = treeResp.result.labelled.filter((n) => /[\u4e00-\u9fa5]/.test(n.text || n.desc || ''));
    console.log(`中文标签数 = ${cn.length}`);
    if (cn.length) {
      console.log('样例:');
      for (const n of cn.slice(0, 5)) console.log(`  "${n.text || n.desc}"  clickable=${n.clickable}`);
    }
  }
}
