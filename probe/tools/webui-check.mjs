// 用法: node probe/tools/webui-check.mjs   (在仓库根目录跑)
// WebUI 本地校验: 全程 UTF-8, 不经过 PowerShell 的 Get-Content (它会按 GBK 读)
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const FILE = 'dsh/module/webroot/index.html';
const buf = fs.readFileSync(FILE);
const html = buf.toString('utf8');

console.log('==== 编码与结构 ====');
console.log('  UTF-8 往返一致:', Buffer.from(html, 'utf8').equals(buf));
console.log('  含 BOM:', buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf);
console.log('  字节:', buf.length, ' 行数:', html.split('\n').length);

const scriptCount = (html.match(/<script/g) || []).length;
const closeCount = (html.match(/<\/script>/g) || []).length;
console.log('  <script>:', scriptCount, ' </script>:', closeCount);
console.log('  <style>:', (html.match(/<style/g) || []).length, ' </style>:', (html.match(/<\/style>/g) || []).length);

console.log('\n==== 外部资源引用 (离线可用性) ====');
// 先剥掉 HTML 注释: 注释里用文字举例说明"不要引 CDN" 不该被算成真引用。
const htmlNoComments = html.replace(/<!--[\s\S]*?-->/g, '');
const urls = htmlNoComments.match(/https?:\/\/[^"'\s)<]+/g) || [];
if (urls.length === 0) console.log('  无');
for (const u of urls) console.log('  ' + u);
const links = htmlNoComments.match(/<(?:link|img|script)[^>]*\b(?:src|href)=["']([^"']+)["']/g) || [];
console.log('  资源标签:', links.length === 0 ? '无' : links.join(' | '));

console.log('\n==== JS 语法 ====');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { console.log('  找不到 <script> 块'); process.exit(1); }
const js = m[1];
const tmp = path.join(process.env.TEMP, 'webui-extracted.js');
fs.writeFileSync(tmp, js, 'utf8');
try {
  execFileSync(process.execPath, ['--check', tmp], { stdio: 'inherit' });
  console.log('  [OK] 语法通过 (' + js.length + ' 字节)');
} catch {
  console.log('  [FAIL] 语法错误');
  process.exitCode = 1;
}
fs.unlinkSync(tmp);

console.log('\n==== 安全检查: 命令是否都是静态字面量 ====');
// 列出所有实际发给 ksu 的调用
const calls = [...js.matchAll(/ksu\.\w+\(([^)]*)\)/g)].map(x => x[1].trim());
for (const c of calls) console.log('  ksu 调用参数: ' + c);
// 危险模式: 把 DOM 值拼进命令
// 注意 (我自己踩过): `CTL\s*\+\s*(?!['"])` 是**错的** —— \s* 会回溯到零个空格,
// 然后在空格字符上通过 lookahead (空格不是引号), 于是把 `CTL + ' status'` 这种
// 完全安全的写法全判成危险。正确写法是显式取"+ 之后第一个非空白字符"再比。
const dangerPatterns = [
  [/\bCTL\s*\+\s*(?!['"])\S/, 'CTL 与非常量拼接'],
  [/\+[^'"]*\.value/, '把输入框 value 拼进命令'],
  [/innerHTML/, 'innerHTML (XSS 面)'],
  [/localStorage/, 'localStorage (随 Manager 卸载丢失)'],
  [/eval\(|new Function/, 'eval / new Function'],
];
let danger = 0;
for (const [re, label] of dangerPatterns) {
  if (re.test(js)) { console.log('  [WARN] ' + label); danger++; }
}
console.log(danger === 0 ? '  未发现危险模式' : '  发现 ' + danger + ' 处');

console.log('\n==== 协议实现核对 (对照 WebViewInterface.kt) ====');
const checks = [
  [/ksu\.exec\(\s*cmd\s*,\s*'\{[^}]*\}'\s*,\s*name\s*\)/, 'exec 传了 options JSON + 回调名'],
  [/window\[name\]\s*=\s*function\s*\(errno,\s*stdout,\s*stderr\)/, 'exec 回调签名 (errno,stdout,stderr)'],
  [/ksu\.spawn\(\s*command\s*,\s*JSON\.stringify\(args\)\s*,\s*'\{[^}]*\}'\s*,\s*name\s*\)/, 'spawn 传 args JSON + options + 回调名'],
  [/\bemit\s*:\s*function\s*\(ev,\s*data\)/, '子管道有 emit (stdout/stderr)'],
  [/proc\.stdout\.on\('data'/, 'proc.stdout.on("data")'],
  [/proc\.on\('exit'/, 'proc.on("exit")'],
];
for (const [re, label] of checks) {
  console.log('  [' + (re.test(js) ? 'OK' : '!!') + '] ' + label);
}
