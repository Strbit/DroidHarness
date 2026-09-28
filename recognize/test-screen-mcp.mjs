// 测试 screen-mcp 的 MCP 协议实现
//
// 用法:
//   node test-screen-mcp.mjs                         本地: 用当前 node 跑 screen-mcp.mjs
//   node test-screen-mcp.mjs --exec <cmd> <a1> <a2>  自定义启动命令(如经 adb 跑设备侧)
import { spawn } from 'node:child_process';

const argv = process.argv.slice(2);
let child;
if (argv[0] === '--exec') {
  const cmd = argv[1];
  const cmdArgs = argv.slice(2);
  child = spawn(cmd, cmdArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
} else {
  const target = argv[0] || 'screen-mcp.mjs';
  const nodeBin = argv[1] || process.execPath;
  child = spawn(nodeBin, [target], { stdio: ['pipe', 'pipe', 'pipe'] });
}

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

// 1. initialize
send({ jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
send({ jsonrpc: '2.0', method: 'notifications/initialized' });

setTimeout(() => send({ jsonrpc: '2.0', id: 2, method: 'tools/list' }), 500);
setTimeout(() => send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_displays', arguments: {} } }), 1200);
setTimeout(() => send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'screen_targets', arguments: {} } }), 3500);
setTimeout(() => send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'screen_image', arguments: {} } }), 12000);
// 验证非默认屏的树会明确报错(而不是悄悄返回主屏的树)
setTimeout(() => send({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'screen_targets', arguments: { displayId: 2 } } }), 20000);
setTimeout(() => { child.kill(); report(); }, 32000);

let done = false;
child.on('exit', () => setTimeout(report, 200));
function report() {
  if (done) return;
  done = true;
  console.log('');
  console.log('═══ MCP 协议测试结果 ═══');
  for (const r of responses) {
    if (r._bad) { console.log('  [无法解析] ' + r._bad); continue; }
    if (r.error) { console.log(`  #${r.id} 错误: ${r.error.code} ${r.error.message}`); continue; }
    if (r.id === 1) {
      console.log(`  #1 initialize  -> 协议 ${r.result.protocolVersion}, 服务 ${r.result.serverInfo.name}@${r.result.serverInfo.version}`);
    } else if (r.id === 2) {
      console.log(`  #2 tools/list  -> ${r.result.tools.length} 个工具`);
      for (const t of r.result.tools) console.log(`     · ${t.name}`);
    } else if (r.id >= 3) {
      const c = r.result.content || [];
      const kinds = c.map((x) => x.type).join('+');
      const txt = c.find((x) => x.type === 'text')?.text || '';
      console.log(`  #${r.id} tools/call -> isError=${!!r.result.isError}, 内容块=${kinds}`);
      console.log('     ' + txt.slice(0, 420).replace(/\n/g, '\n     '));
      const img = c.find((x) => x.type === 'image');
      if (img) {
        const bytes = Buffer.from(img.data, 'base64').length;
        console.log(`     图片: ${img.mimeType}, ${bytes} B, PNG=${img.data.startsWith('iVBORw0KGgo')}`);
      }
    }
  }
  const ids = responses.filter((r) => r.id).map((r) => r.id).sort();
  console.log('');
  console.log(`答复 id = [${ids.join(', ')}]  (期望 [1,2,3,4,5,6])`);
}
