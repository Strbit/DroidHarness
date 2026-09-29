#!/usr/bin/env node
/**
 * verify-zip.mjs — 核验**已经打出来的 zip**，而不是工作树。
 *
 * 为什么要单独一个脚本（而不是信 stage-tools / pack-module 的结论）
 * ------------------------------------------------------------------
 * stage-tools 证明的是"暂存目录对"，pack-module 证明的是"打包过程没报错"。
 * 两个都绿，zip 里仍然可能是另一回事: 模式位写错、条目漏了、customize.sh 是旧的。
 * 上一轮就吃过这个亏 —— 核验脚本只找 `SM_TOOLS_DST`，而这个名字在**被淘汰的
 * 那一版**里也存在，于是它证明了"有布署段"却没证明"是我刚改的那版"。
 * 所以这里查的是**版本区分性标记**: 只有最新实现里才有的字符串，外加淘汰写法的
 * 反向断言。
 *
 * 最有分量的一条在最后: 把 zip 里的 register-screen-mcp.mjs 和那份模板**解出来**
 * 真跑一遍 `--print-block`。这验的是"用户手上这个包会不会自己接进去"，
 * 不是"仓库里的代码会不会"。整个改动的目标就是安装即用，那就用包本身来证。
 *
 * 用法: node probe/tools/verify-zip.mjs [--zip <path>]
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const j = (...p) => path.join(...p).replace(/\\/g, '/');

// zip 名字从 module.prop 推，不写死版本 —— 写死 v0.1.0 之后版本一涨，
// 这个脚本会去核验一个**旧包**并且全绿。
const prop = fs.readFileSync(j(ROOT, 'dsh', 'module', 'module.prop'), 'utf8');
const id = /^\s*id\s*=\s*(\S+)/m.exec(prop)?.[1];
const ver = /^\s*version\s*=\s*(\S+)/m.exec(prop)?.[1];
const argv = process.argv.slice(2);
const zipArg = argv.includes('--zip') ? argv[argv.indexOf('--zip') + 1] : null;
const ZIP = zipArg ?? j(ROOT, 'dsh', 'dist', `${id}-v${ver}.zip`);
if (!fs.existsSync(ZIP)) {
  console.error(`[致命] 找不到 zip: ${ZIP}\n  先打包: node probe/tools/pack-module.mjs --module dsh/module --out dsh/dist`);
  process.exit(1);
}
const buf = fs.readFileSync(ZIP);

let pass = 0;
let fail = 0;
const fails = [];
function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  [OK]   ${name}`);
  } else {
    fail++;
    fails.push(name);
    console.log(`  [FAIL] ${name}${detail ? `\n           ${String(detail).split('\n').slice(0, 6).join('\n           ')}` : ''}`);
  }
}

// ─────────────────────────── zip 解析 ───────────────────────────
let eocd = -1;
for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
  if (buf.readUInt32LE(i) === 0x06054b50) {
    eocd = i;
    break;
  }
}
if (eocd < 0) throw new Error('找不到 EOCD —— 这个 zip 是坏的');
const count = buf.readUInt16LE(eocd + 10);
const cdOff = buf.readUInt32LE(eocd + 16);
let p = cdOff;
const entries = [];
for (let n = 0; n < count; n++) {
  if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`中央目录第 ${n} 项签名不对`);
  const method = buf.readUInt16LE(p + 10);
  const crc = buf.readUInt32LE(p + 16);
  const csize = buf.readUInt32LE(p + 20);
  const usize = buf.readUInt32LE(p + 24);
  const nameLen = buf.readUInt16LE(p + 28);
  const extraLen = buf.readUInt16LE(p + 30);
  const cmtLen = buf.readUInt16LE(p + 32);
  // 外部属性是 4 字节，Unix 模式在高 16 位。写成 readUInt16LE(p+38) >> 16 的话
  // 一个 16 位数右移 16 位恒为 0 —— 所有条目都"mode=00"，执行位检查就成了废检查。
  const mode = (buf.readUInt32LE(p + 38) >>> 16) & 0o7777;
  const lho = buf.readUInt32LE(p + 42);
  const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
  entries.push({ name, method, crc, csize, usize, mode, lho });
  p += 46 + nameLen + extraLen + cmtLen;
}
function readData(e) {
  const nl = buf.readUInt16LE(e.lho + 26);
  const el = buf.readUInt16LE(e.lho + 28);
  const start = e.lho + 30 + nl + el;
  const raw = buf.subarray(start, start + e.csize);
  return e.method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw);
}
function crc32(b) {
  let c = ~0;
  for (let i = 0; i < b.length; i++) {
    c ^= b[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
const find = (name) => entries.find((e) => e.name === name);
const text = (name) => {
  const e = find(name);
  return e ? readData(e).toString('utf8') : null;
};

console.log(`核验: ${path.relative(ROOT, ZIP)}  (${(buf.length / 1048576).toFixed(1)} MiB, ${count} 条目)`);

// ─────────────────── 1. 模块自己的文件必须在包里 ───────────────────
console.log('');
console.log('=== 1. 关键条目齐全 ===');
const REQUIRED = [
  'module.prop', 'customize.sh', 'service.sh', 'action.sh',
  // uninstall.sh: 缺它 = 卸载后 home 层里永久留着一条指向已删文件的 patch 条目。
  'uninstall.sh',
  'bin/dsh', 'bin/dshctl', 'bin/env.sh',
  // 自动接入的脚本本体。缺它 = §7 只能报 [WARN]，模型静静少 4 个工具。
  'bin/register-screen-mcp.mjs',
  'webroot/index.html', 'usr/bin/node',
  'tools/screen-mcp', 'tools/screen-mcp.mjs',
  'tools/lib/uitree.mjs', 'tools/lib/fields.mjs', 'tools/lib/spawn-env.mjs',
  'tools/lib/displays.mjs', 'tools/lib/cmd-display.mjs',
  // 托管块的真源。缺它 = 脚本推导不出条目 = 不会接入。
  'tools/cordis.patch.example.yml',
];
for (const name of REQUIRED) {
  const e = find(name);
  check(`${name.padEnd(34)} 在包里${e ? ` (${e.usize} B)` : ''}`, !!e);
}

// ─────────────────── 2. 模式位（KernelSU 不保留 zip 之外的权限） ───────────────────
console.log('');
console.log('=== 2. 执行位 ===');
const NEED_X = [
  'customize.sh', 'service.sh', 'action.sh', 'uninstall.sh',
  'bin/dsh', 'bin/dshctl', 'bin/env.sh', 'tools/screen-mcp', 'usr/bin/node',
];
for (const name of NEED_X) {
  const e = find(name);
  if (!e) continue;
  check(`${name.padEnd(34)} mode=0${e.mode.toString(8)} 有执行位`, (e.mode & 0o111) !== 0, '装机会 chmod 兜底，但不该把正确性押在安装器上');
}
for (const name of ['module.prop', 'tools/cordis.patch.example.yml']) {
  const e = find(name);
  if (!e) continue;
  check(`${name.padEnd(34)} 不该有执行位`, (e.mode & 0o111) === 0, `实际 mode=0${e.mode.toString(8)}`);
}

// ─────────────────── 3. 字节与磁盘一致 + 无 CR ───────────────────
console.log('');
console.log('=== 3. zip 内容 == 磁盘内容，且全 LF ===');
const CR_BANNED = [
  'customize.sh', 'service.sh', 'action.sh', 'uninstall.sh', 'module.prop',
  'bin/dsh', 'bin/dshctl', 'bin/env.sh', 'bin/register-screen-mcp.mjs',
  'tools/screen-mcp', 'tools/cordis.patch.example.yml', 'tools/screen-mcp.mjs',
  'tools/lib/uitree.mjs', 'tools/lib/fields.mjs', 'tools/lib/spawn-env.mjs',
  'tools/lib/displays.mjs', 'tools/lib/cmd-display.mjs',
];
for (const name of CR_BANNED) {
  const e = find(name);
  if (!e) continue;
  const inZip = readData(e);
  let nCR = 0;
  for (const b of inZip) if (b === 0x0d) nCR++;
  const diskAbs = path.join(ROOT, 'dsh', 'module', ...name.split('/'));
  const same = fs.existsSync(diskAbs) && fs.readFileSync(diskAbs).equals(inZip);
  const crcOk = crc32(inZip) === e.crc;
  const sizeOk = inZip.length === e.usize;
  check(`${name.padEnd(34)} LF/与磁盘同/CRC/长度`, nCR === 0 && same && crcOk && sizeOk,
    `CR=${nCR} 与磁盘同=${same} CRC=${crcOk} 长度=${sizeOk}`);
}

// ─────────────────── 4. customize.sh 是**最新那一版** ───────────────────
console.log('');
console.log('=== 4. customize.sh 版本区分性标记 ===');
const custTxt = text('customize.sh') ?? '';
const MARKERS = [
  // §5.5 布署段
  ['§5.5 find 驱动逐文件拷贝', 'find "$SM_TOOLS_SRC" -type f'],
  ['§5.5 相对路径提取', '_rel=${_sf#"$SM_TOOLS_SRC/"}'],
  ['§5.5 路径前缀断言', '/data/adb/dsh/tools) ;;'],
  // §7 接入段 —— 这个改动新增的，缺它说明 zip 是"还得手工并 YAML"那一版
  ['§7 调用登记脚本', 'run_node "$REG_BIN"'],
  ['§7 显式传 home 层', '--home "$DSH_HOME_DIR"'],
  ['§7 显式传条目真源', '--patch-src "$MODPATH/tools/cordis.patch.example.yml"'],
  ['§7 抠 STATUS', "sed -n 's/^STATUS: //p'"],
  ['§7 认 UNCHANGED (重装不改字节)', 'UNCHANGED)'],
  ['§7 认 SKIPPED-DUPE (不插第二份)', 'SKIPPED-DUPE)'],
  ['§7 认 REPLACED (升级换条目)', 'REPLACED)'],
  ['§7 失败只 WARN 不 abort', '[WARN] 没接进去'],
];
for (const [label, s] of MARKERS) check(label, custTxt.includes(s), 'zip 里找不到 —— 打包用的是旧 customize.sh');

console.log('');
console.log('=== 5. 被淘汰的写法不许回到包里 (反向断言) ===');
// "可抄的命令"那一套是被**明确否决**的设计: 号称安装即用的模块不该要求用户改 YAML。
// 不写反向断言的话，下一个改动很容易把它"顺手改回去"而所有正向断言照样绿。
const GONE = [
  ['把模板手工并进 profile 那句指引', '仍需**手工**并入'],
  ['装机日志给"可抄的命令"接入 patch', '可抄的命令'],
  ['print copyable commands 的设计残留', '接入 DSH 还需给 profile 打 patch'],
  ['dir/. 那种 cp 写法', 'cp -af "$SM_TOOLS_SRC/."'],
];
for (const [label, s] of GONE) check(label + ' 已消失', !custTxt.includes(s), `zip 里还有 "${s}"`);

// uninstall.sh 也得是接线正确的那版
const uninstTxt = text('uninstall.sh') ?? '';
console.log('');
console.log('=== 6. uninstall.sh 接线 ===');
for (const [label, s] of [
  ['调用登记脚本', 'register-screen-mcp.mjs'],
  ['传 --remove', '--remove'],
  ['传 home 层路径', '--home "$DSH_HOME_DIR"'],
  ['node 缺失时不阻塞卸载', 'usr/bin/node 不可执行'],
]) check(`${label}`, uninstTxt.includes(s), 'zip 里的 uninstall.sh 里没有它');
check('uninstall.sh 不含 CR', !readData(find('uninstall.sh')).includes(0x0d));

// ─────────────────── 7. 包自己能不能完成接入 ───────────────────
// 全脚本最有分量的一条: 把**zip 里的那份脚本和那份模板**解出来真跑一遍。
// 前面几条查的都是字符串在不在；这里查的是"用户手上这个包装上会不会自己接进去"。
console.log('');
console.log('=== 7. 从包里解出脚本，真跑一遍它会写什么 ===');
const TMP = j(ROOT, '.build', 'verify-zip-extract');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(j(TMP, 'bin'), { recursive: true });
fs.mkdirSync(j(TMP, 'tools'), { recursive: true });
{
  fs.writeFileSync(j(TMP, 'bin', 'register-screen-mcp.mjs'), readData(find('bin/register-screen-mcp.mjs')));
  fs.writeFileSync(j(TMP, 'tools', 'cordis.patch.example.yml'), readData(find('tools/cordis.patch.example.yml')));
  const modulesAbs = j(ROOT, 'dsh', 'module', 'app', 'node_modules');
  const args = [j(TMP, 'bin', 'register-screen-mcp.mjs'), '--print-block'];
  if (fs.existsSync(modulesAbs)) args.push('--modules', modulesAbs);
  const r = spawnSync(process.execPath, args, { encoding: 'utf8' });
  // 注意**不传 --patch-src**: 让它用脚本自己算出来的默认路径
  // ($脚本所在目录/../tools/cordis.patch.example.yml)。这一跑同时验了
  // 装机态的目录布局假设 —— 模块里 bin/ 和 tools/ 确实是兄弟目录。
  check('包里的脚本能推导出托管块 (exit 0)', r.status === 0, `exit=${r.status} ${(r.stderr ?? '').split('\n')[0]}`);
  const block = (r.stdout ?? '').replace(/\r\n/g, '\n');
  check('  首行是 begin 标记', /^# >>> dsh-screen-mcp\b/m.test(block.split('\n')[0]), block.split('\n')[0]);
  check('  末行是 end 标记', /^# <<< dsh-screen-mcp\b/.test(block.trimEnd().split('\n').pop() ?? ''), block.split('\n').slice(-2).join(' / '));
  check('  含 serverName: screen', /serverName:\s*screen/.test(block));
  // ⚠ 必须带 m: 少了它 `$` 锚的是**整个字符串**的末尾，而 command 行后面还有
  // 结束标记那一行 —— 断言会永远失败，看起来像"包里内容不对"，其实是正则写错。
  check('  command 指向 /data/adb/dsh/tools/screen-mcp', /^\s*command:\s*\/data\/adb\/dsh\/tools\/screen-mcp\s*$/m.test(block), block.split('\n').filter((l) => l.includes('command')).join(' / '));
  const cmds = [...block.matchAll(/^\s*command:/gm)];
  check('  只有 1 条 command', cmds.length === 1, `${cmds.length} 条`);
  // 与 recognize/ 那份真源推导出的块必须一致 —— 包里这份不是二手抄本。
  const r2 = spawnSync(process.execPath, [
    j(ROOT, 'dsh', 'module', 'bin', 'register-screen-mcp.mjs'), '--print-block',
    '--patch-src', j(ROOT, 'recognize', 'cordis.patch.yml'),
    ...(fs.existsSync(modulesAbs) ? ['--modules', modulesAbs] : []),
  ], { encoding: 'utf8' });
  check('  与 recognize/ 源推导结果逐字节相同', r2.status === 0 && (r2.stdout ?? '').replace(/\r\n/g, '\n') === block,
    `源 exit=${r2.status}`);

  // 再真装一次到临时 home，验"写出来的文件 DSH 认"。这里不重做 register-screen-test
  // 的 74 项断言，只确认**包里这一版**在干净 home 上产出 REGISTERED 且块在文件里。
  const home = j(TMP, 'home');
  const r3 = spawnSync(process.execPath, [
    j(TMP, 'bin', 'register-screen-mcp.mjs'), '--home', home,
    ...(fs.existsSync(modulesAbs) ? ['--modules', modulesAbs] : []),
  ], { encoding: 'utf8' });
  const homeFile = j(TMP, 'home', 'cordis.patch.yml');
  check('  干净 home 上真登记成功 (STATUS: REGISTERED)', /STATUS: REGISTERED/.test((r3.stdout ?? '') + (r3.stderr ?? '')), (r3.stdout + r3.stderr).slice(-200));
  check('  落盘的文件带块', fs.existsSync(homeFile) && fs.readFileSync(homeFile, 'utf8').includes('# >>> dsh-screen-mcp'));
  const r4 = spawnSync(process.execPath, [
    j(TMP, 'bin', 'register-screen-mcp.mjs'), '--home', home, '--remove',
    ...(fs.existsSync(modulesAbs) ? ['--modules', modulesAbs] : []),
  ], { encoding: 'utf8' });
  check('  --remove 能摘掉 (STATUS: REMOVED)', /STATUS: REMOVED/.test((r4.stdout ?? '') + (r4.stderr ?? '')), (r4.stdout + r4.stderr).slice(-200));
  check('  摘完留的是 []（不是空文件/纯注释 = DSH 拒绝启动）', fs.readFileSync(homeFile, 'utf8').trim() === '[]', JSON.stringify(fs.readFileSync(homeFile, 'utf8')));
}
fs.rmSync(TMP, { recursive: true, force: true });

console.log('');
console.log('='.repeat(56));
console.log(`  汇总: ${pass} 通过 / ${fail} 失败`);
if (fails.length) console.log(`  失败项:\n    - ${fails.join('\n    - ')}`);
console.log('');
console.log('  ⚠ 仍未覆盖: 真机上 KernelSU 是否确实按 zip 的模式位解包（本脚本查的是');
console.log('    zip 里写的位），以及 DSH 能不能把 MCP 子进程拉起来列出 4 个工具。');
process.exitCode = fail > 0 ? 1 : 0;
