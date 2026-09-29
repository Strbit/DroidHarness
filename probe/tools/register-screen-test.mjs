#!/usr/bin/env node
/**
 * register-screen-test.mjs — 装机即用自动登记的**行为**测试
 *
 * 跑法: node probe/tools/register-screen-test.mjs
 *
 * 为什么单开一个测试而不是塞进 customize-deploy-test
 * --------------------------------------------------
 * 那两个测试查的是"文件在不在、字节对不对"。这个查的是**装上以后 DSH 到底看不
 * 看得到屏幕工具** —— 而这正是这次改动承诺的唯一一件事。它必须拿真 DSH 断言:
 * 解析规则里有任何一条我猜错了（[] 能不能共存、--- 放前放后、纯注释行不行），
 * 只有 `--dump-config` 的退出码会告诉我。自己写个小 YAML 解析器来"验证"是自欺。
 *
 * 每条断言都跑真 bin.js (`--profile web --dump-config`)，对端是模块里那份 node。
 * 本机 Windows 上跑的 node 与设备上的是同一份 bin.js（打包时原样带上），所以
 * "退出码 + 我们那条 insert 在不在"这两个判据是可信的；**不**验证 MCP 子进程真能
 * 起来（那要在 Android 上跑 uiautomator，见 README 的设备侧清单）。
 *
 * 为什么所有 fixture 用 writeFileSync 而不是 shell here-doc
 * --------------------------------------------------------
 * 上一轮实测里我有四条结论是假的 —— PowerShell 拼字符串时吞掉了换行，于是
 * `# <<< 标记 <<<` 和用户条目黏在同一行、被注释整行吃掉，DSH 照样 exit=0，
 * 我读成了"否决生效"。测试数据必须逐字节自己说了算，不能让 shell 的引号规则
 * 参与。这里每个 fixture 都是一个显式数组 join('\n')。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const MODULE = path.join(ROOT, 'dsh', 'module');
const SCRIPT = path.join(MODULE, 'bin', 'register-screen-mcp.mjs');
const BIN_JS = path.join(MODULE, 'app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const NODE = process.execPath;

const MARK_BEGIN = '# >>> dsh-screen-mcp (managed by dsh_android module) >>>';
const MARK_END = '# <<< dsh-screen-mcp <<<';
const BLOCK = [
  MARK_BEGIN,
  '- insert:',
  '    - id: mcp-screen',
  "      name: '@deepseek-ai/dsh-mcp-client'",
  '      config:',
  '        serverName: screen',
  '        transport: stdio',
  '        command: /data/adb/dsh/tools/screen-mcp',
  MARK_END,
];

let pass = 0;
const fails = [];
function ok(cond, msg, detail) {
  if (cond) {
    pass++;
    console.log('  ✓ ' + msg);
  } else {
    fails.push(msg + (detail ? '\n      ' + String(detail).split('\n').join('\n      ') : ''));
    console.log('  ✗ ' + msg);
    if (detail) console.log('      ' + String(detail).split('\n').join('\n      '));
  }
}

if (!fs.existsSync(SCRIPT)) {
  console.error('[致命] 没有 ' + path.relative(ROOT, SCRIPT));
  process.exit(1);
}
if (!fs.existsSync(BIN_JS)) {
  console.error('[致命] 找不到用来断言的真 DSH: ' + path.relative(ROOT, BIN_JS));
  console.error('       这个测试的意义就是拿真 DSH 验，不能用假的替代。');
  process.exit(1);
}

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-reg-'));
function homeFor(name) {
  const dir = path.join(sandbox, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function reg(home, ...extra) {
  const r = spawnSync(NODE, [SCRIPT, '--home', home, '--modules', path.join(MODULE, 'app', 'node_modules'), ...extra], {
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: home },
  });
  const out = (r.stdout ?? '') + (r.stderr ?? '');
  const m = out.match(/STATUS: (\S+)/);
  return { status: m ? m[1] : '(无)', code: r.status, out };
}
/** 真 DSH: 这份 patch 文件能不能启动，我们的 insert 在不在树里。 */
function dsh(home) {
  const r = spawnSync(NODE, ['--expose-internals', BIN_JS, '--profile', 'web', '--dump-config'], {
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: home, HOME: home },
    cwd: home,
  });
  const out = (r.stdout ?? '') + (r.stderr ?? '');
  return {
    code: r.status,
    // 只数**我们那条** insert 的行 (id: mcp-screen), 不用宽匹配的 disabled ——
    // 整个配置树里本来就有几十行 disabled, 数它等于没数。
    screenRows: (out.match(/^\s*-?\s*id: mcp-screen/gm) ?? []).length,
    // 否决必须落在**我们这一行**上，不是碰巧后面某处有别人的 disabled: ——
    // dump 里合并后的行是 `- id: mcp-screen` 后紧跟同缩进的 `disabled: true`。
    // 所以从 id 行往下取到"缩进 ≤ id 行且不是空行"为止，这段里出现
    // disabled: true 才算否决生效。
    vetoed: (() => {
      const lines = out.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/^(\s*)-?\s*id: mcp-screen\s*$/);
        if (!m) continue;
        const indent = m[1].length;
        for (let j = i + 1; j < lines.length; j++) {
          const l = lines[j];
          if (l.trim() === '') continue;
          const li = l.match(/^\s*/)[0].length;
          if (li <= indent && !l.startsWith(' '.repeat(indent) + '-')) break; // 下一个同级/父级条目
          if (/^\s*disabled:\s*true\s*$/.test(l)) return true;
        }
      }
      return false;
    })(),
    err: out.split('\n').filter((l) => /Error:/.test(l))[0] ?? '',
    out,
  };
}
function writePatch(home, lines) {
  fs.writeFileSync(path.join(home, 'cordis.patch.yml'), lines.join('\n') + '\n');
}
function readPatch(home) {
  return fs.readFileSync(path.join(home, 'cordis.patch.yml'), 'utf8');
}

console.log('register-screen-mcp 行为测试 (每条都过真 DSH)');
console.log('='.repeat(60));

// ── 1. 全新安装：文件不存在 ──────────────────────────────────
console.log('\n[1] 全新: $DSH_HOME/cordis.patch.yml 不存在');
{
  const h = homeFor('fresh');
  const a = reg(h);
  ok(a.status === 'REGISTERED' && a.code === 0, '首次登记 REGISTERED', a.out);
  const d = dsh(h);
  ok(d.code === 0, '真 DSH 启动 exit=0', d.err);
  ok(d.screenRows === 1, 'dump 里正好 1 行 mcp-screen', '行数=' + d.screenRows + ' ' + d.err);
  const b = reg(h);
  ok(b.status === 'UNCHANGED', '再跑一次 UNCHANGED (幂等)', b.out);
  // 幂等的硬判据是**字节不变**, 不是"状态词好看": 重写会动用户正在看的文件。
  const bytes1 = readPatch(h);
  reg(h);
  ok(readPatch(h) === bytes1, '第三次跑之后字节完全相同', '内容变了');
  const d2 = dsh(h);
  ok(d2.code === 0 && d2.screenRows === 1, '跑三次后仍是 1 行 / exit=0', '行数=' + d2.screenRows);
}

// ── 2. DSH 模板初值 [] ───────────────────────────────────────
console.log('\n[2] 用户文件是 DSH 建出来的模板初值 []');
{
  const h = homeFor('placeholder');
  writePatch(h, ['[]']);
  let d = dsh(h);
  ok(d.code === 0 && d.screenRows === 0, '登记前: exit=0 且没有我们的行', 'rows=' + d.screenRows);
  const a = reg(h);
  ok(a.status === 'REGISTERED', '登记 REGISTERED', a.out);
  d = dsh(h);
  // 这条是**关键门**: [] 与块共存实测 exit=1 (flow 序列夹在 block 序列后面
  // 不是合法顶层)。不替换掉 [] 就是第一次装机把 DSH 砖掉。
  ok(d.code === 0, '登记后真 DSH 仍 exit=0 ([] 必须被替换掉)', d.err);
  ok(d.screenRows === 1, '我们的行在树里', '行数=' + d.screenRows);
  ok(!/^\[\]\s*$/m.test(readPatch(h)), '写出的文件里没有游离的 []', readPatch(h));
}

// ── 3. 带注释的模板 (DSH initProfile 建的就是这个形状) ───────
console.log('\n[3] 用户文件是带注释头的模板');
{
  const h = homeFor('templated');
  writePatch(h, ['# 你的 patch 层', '# 说明', '', '[]']);
  const before = readPatch(h);
  const a = reg(h);
  ok(a.status === 'REGISTERED', 'REGISTERED', a.out);
  const d = dsh(h);
  ok(d.code === 0 && d.screenRows === 1, 'exit=0 且有我们的行', d.err || 'rows=' + d.screenRows);
  const after = readPatch(h);
  ok(after.includes('# 你的 patch 层') && after.includes('# 说明'), '用户的注释还在');
  ok(after.indexOf('# 你的 patch 层') < after.indexOf(MARK_BEGIN), '块 prepend 在用户内容之前');
  ok(!/^\[\]/m.test(after), '[] 被替换 (不是共存)', after);
  ok(before.split('\n')[0] === after.split('\n').find((l) => l.startsWith('# 你的')), '第一行原样');
}

// ── 4. 用户已有自己的条目 ───────────────────────────────────
console.log('\n[4] 用户已经在写自己的 patch');
{
  const h = homeFor('userrows');
  writePatch(h, ['# 我自己的东西', '- name: \'@deepseek-ai/dsh-noop\'', '  config:', '    foo: bar']);
  const before = readPatch(h);
  const a = reg(h);
  ok(a.status === 'REGISTERED', 'REGISTERED', a.out);
  const d = dsh(h);
  ok(d.code === 0, 'exit=0', d.err);
  ok(d.screenRows === 1, '我们的行在', 'rows=' + d.screenRows);
  const after = readPatch(h);
  ok(after.includes('    foo: bar'), '用户条目的内容一字未改');
  ok(after.includes("# 我自己的东西"), '用户的注释一字未改');
  ok(after.indexOf(MARK_BEGIN) < after.indexOf('- name:'), '块仍然在最前 (prepend)');
  // 标记外的字节必须**完全**是原来的字节。这是"不破坏用户数据"唯一的硬判据。
  const outside = after.split('\n').filter((l) => !BLOCK.includes(l)).join('\n').replace(/\n+$/, '');
  ok(outside.replace(/^\n+/, '') === before.trim(), '标记外逐字节等于原文件', outside + '\n--- vs ---\n' + before);
}

// ── 5. 用户的否决权 (这是 prepend 的全部理由) ────────────────
console.log('\n[5] 用户想关掉屏幕工具');
{
  const h = homeFor('veto');
  writePatch(h, ['[]']);
  reg(h);
  // 用户在块**之后**追加否决行 —— 块在前所以它压得住 (patch 后写覆盖先写)。
  const p = path.join(h, 'cordis.patch.yml');
  fs.appendFileSync(p, "- id: mcp-screen\n  disabled: true\n");
  const d = dsh(h);
  ok(d.code === 0, '否决后仍 exit=0', d.err);
  ok(d.vetoed, 'disabled: true 真的落到我们那行上 (用户的开关有效)', d.out.split('\n').filter((l) => /mcp-screen/.test(l)).join(' | '));
  // 重装模块: 块被刷成最新, 但**不能**把用户的否决行吃掉。
  const before = fs.readFileSync(p, 'utf8');
  const a = reg(h);
  ok(['UNCHANGED', 'REPLACED'].includes(a.status), '重装返回 UNCHANGED/REPLACED 而不是重写全文件', a.out);
  const after = fs.readFileSync(p, 'utf8');
  ok(after.includes('  disabled: true'), '重装之后用户的否决行还在', after);
  // 否决行不能被复制成两份: 数一下块外那条 id 的出现次数, 只应有我们块里那 1 处
  // 加上用户手写的那 1 处 = 2, 而不是 3。
  ok((after.match(/- id: mcp-screen/g) ?? []).length === 2, '否决行没被复制成两份 (块内 1 + 用户 1)', after);
  ok(dsh(h).vetoed, '再跑真 DSH: 用户仍然是关掉的');
}

// ── 6. 用户手工加过 screen → 不插第二份 ─────────────────────
console.log('\n[6] 用户已手工加过 serverName: screen');
{
  const h = homeFor('dupe');
  writePatch(h, [
    '- insert:',
    '    - id: mcp-screen',
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        serverName: screen',
    '        transport: stdio',
    '        command: /data/adb/dsh/tools/screen-mcp',
  ]);
  const a = reg(h);
  ok(a.status === 'SKIPPED-DUPE', 'SKIPPED-DUPE (不去重=不插两份)', a.out);
  const d = dsh(h);
  ok(d.code === 0 && d.screenRows === 1, 'exit=0 且只有 1 行 (没有第二个子进程)', 'rows=' + d.screenRows);
}

// ── 7. 卸载 ─────────────────────────────────────────────────
console.log('\n[7] 卸载 (移除托管块)');
{
  // 7a: 卸载后只剩注释 → 必须留 []，否则 DSH 拒绝启动 (实测 exit=1)。
  const h = homeFor('uninstall-comments');
  writePatch(h, BLOCK);
  ok(reg(h).status === 'UNCHANGED', '已登记的块识别为 UNCHANGED');
  const a = reg(h, '--remove');
  ok(a.status === 'REMOVED', 'REMOVED', a.out);
  let d = dsh(h);
  ok(d.code === 0, '卸载后真 DSH **仍能启动** (不能只剩注释)', d.err);
  ok(d.screenRows === 0, '我们的行没了');
  ok(readPatch(h).trim() === '[]', '文件是 [] (卸载后唯一既干净又能启动的形态)', readPatch(h));
  const b = reg(h, '--remove');
  ok(['NOBLOCK', 'ABSENT'].includes(b.status), '重复卸载 NOBLOCK/ABSENT', b.out);

  // 7b: 用户注释 + 我们的块 → 注释必须留住, 块整段消失。
  const h2 = homeFor('uninstall-keep');
  writePatch(h2, ['# 我的头注释', '', ...BLOCK, '', "# 我的尾注", '- name: \'@deepseek-ai/dsh-noop\'']);
  ok(reg(h2).status === 'UNCHANGED', '带前后文的块识别为 UNCHANGED');
  reg(h2, '--remove');
  const t = readPatch(h2);
  ok(t.includes('# 我的头注释') && t.includes('# 我的尾注'), '块外的用户注释都还在');
  ok(t.includes('- name:') && t.includes('dsh-noop'), '块外的用户条目还在');
  ok(!t.includes('dsh-screen-mcp'), '托管块 (含标记) 整段消失');
  d = dsh(h2);
  ok(d.code === 0, '带用户内容卸载后仍 exit=0', d.err);

  // 7c: 从没登记过 → 一个字都不改
  const h3 = homeFor('uninstall-none');
  writePatch(h3, ['[]']);
  const r3 = reg(h3, '--remove');
  ok(r3.status === 'NOBLOCK' && readPatch(h3) === '[]\n', '没登记过时 NOBLOCK 且字节不动', r3.out + ' | ' + JSON.stringify(readPatch(h3)));
}

// ── 8. 模块升级改了条目 → 块内刷新, 块外不动 ────────────────
console.log('\n[8] 新版模块改了 command 路径');
{
  const h = homeFor('upgrade');
  writePatch(h, ['# 用户注释', ...BLOCK.map((l) => l.replace('/data/adb/dsh/tools/screen-mcp', '/data/adb/dsh/tools/OLD-screen-mcp'))]);
  const a = reg(h);
  ok(a.status === 'REPLACED', '过期块 REPLACED', a.out);
  const t = readPatch(h);
  ok(t.includes('command: /data/adb/dsh/tools/screen-mcp'), '块内刷新成最新条目');
  ok(t.includes('# 用户注释'), '用户注释没被重排');
  const d = dsh(h);
  ok(d.code === 0 && d.screenRows === 1, '刷新后 exit=0 / 1 行', d.err || 'rows=' + d.screenRows);
  ok(t.indexOf(MARK_BEGIN) > t.indexOf('# 用户注释'), '位置保持: 仍在用户注释之后 (不跳到文件末尾)');
}

// ── 9. 读不准就坚决不写 ─────────────────────────────────────
console.log('\n[9] 负例: 不敢改写的文件');
{
  const cases = [
    ['多文档', ['# a', '---', '[]', '---', '- name: x']],
    ['原文件就坏', ['- name: x', '  config: [1,']],
  ];
  for (const [name, lines] of cases) {
    const h = homeFor('bad-' + name);
    writePatch(h, lines);
    const before = readPatch(h);
    const a = reg(h);
    ok(a.status === 'REFUSED', `${name}: 拒绝写入`, a.out);
    ok(readPatch(h) === before, `${name}: 文件字节一字未动`);
  }
  // --dry-run 不许碰盘
  const h = homeFor('dryrun');
  writePatch(h, ['[]']);
  const before = readPatch(h);
  const a = reg(h, '--dry-run');
  ok(a.code === 0 && readPatch(h) === before, '--dry-run 输出计划但不动文件', a.out);
  // 无 --home 时按 env 走 (service.sh / bin/dsh 都 export DSH_HOME)
  const h2 = homeFor('envhome');
  const r = spawnSync(NODE, [SCRIPT, '--modules', path.join(MODULE, 'app', 'node_modules')], {
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: h2 },
    cwd: h2,
  });
  ok(/STATUS: REGISTERED/.test((r.stdout ?? '') + (r.stderr ?? '')) && fs.existsSync(path.join(h2, 'cordis.patch.yml')), '只靠 DSH_HOME 环境变量也能工作');
}

// ── 10. 行尾: 设备上不能有 CR ───────────────────────────────
console.log('\n[10] 写出的字节必须是 LF');
{
  const h = homeFor('crlf');
  writePatch(h, ['# hdr', '[]']);
  reg(h);
  const buf = fs.readFileSync(path.join(h, 'cordis.patch.yml'));
  ok(!buf.includes(0x0d), '登记后文件里没有 CR (Android sh/YAML 都会受影响)');
  reg(h, '--remove');
  ok(!fs.readFileSync(path.join(h, 'cordis.patch.yml')).includes(0x0d), '卸载后也没有 CR');
}

// ── 11. 残壳该救, 读不懂的该拒 ──────────────────────────────
console.log('\n[11] 空壳要救活, 读不懂的绝不猜');
{
  // 0 字节: DSH 自己也拒绝 (toJS()=null → must be a top-level array)。我们
  // prepend 的块正好补上那个数组 —— 这种"坏了但能救"的壳该救, 不该拒。
  const h = homeFor('zero-byte');
  fs.writeFileSync(path.join(h, 'cordis.patch.yml'), '');
  const a = reg(h);
  ok(a.status === 'REGISTERED', '0 字节空文件也能登记 (块自己就是那个数组)', a.out);
  ok(!readPatch(h).startsWith('\n'), '不会写成以空行开头', JSON.stringify(readPatch(h).slice(0, 20)));
  const d = dsh(h);
  ok(d.code === 0 && d.screenRows === 1, '0 字节救活后 exit=0 / 1 行', d.err || 'rows=' + d.screenRows);

  // 只有注释: 同样是 DSH 拒绝的壳 (实测种子 exit=1),  prepend 后应变成能启动。
  const h2 = homeFor('comments-only');
  writePatch(h2, ['# 只有注释']);
  const a2 = reg(h2);
  ok(a2.status === 'REGISTERED', '纯注释文件也能登记', a2.out);
  const d2 = dsh(h2);
  ok(d2.code === 0 && d2.screenRows === 1, '纯注释救活后 exit=0 (种子本来是砖)', d2.err || 'rows=' + d2.screenRows);
  ok(readPatch(h2).includes('# 只有注释'), '用户的注释留着');

  // 两个 [] 占位符: 我们**没法**救 (块与 [] 共存实测 exit=1, 两种顺序都砖),
  // 而删掉哪一个都是猜用户意思 → 拒, 且字节不动。
  const h3 = homeFor('two-placeholders');
  writePatch(h3, ['# 头', '[]', '', '[]']);
  const b3 = readPatch(h3);
  const a3 = reg(h3);
  ok(a3.status === 'REFUSED' && readPatch(h3) === b3, '两个 [] (多顶层序列): 拒绝且字节不动', a3.out);

  // 真条目后面跟着游离 []: DSH 自己也解析不过, 且 [] 是用户的什么意图读不准 → 拒。
  const h4 = homeFor('row-plus-stray');
  writePatch(h4, ["- name: '@deepseek-ai/dsh-noop'", '[]']);
  const b4 = readPatch(h4);
  const a4 = reg(h4);
  ok(a4.status === 'REFUSED' && readPatch(h4) === b4, '条目+游离 []: 拒绝且字节不动', a4.out);
}

// ── 12. 条目来自真源, 且卸载不依赖它 ────────────────────────
console.log('\n[12] 托管块内容取自 recognize 那份真源 (不是脚本里的抄本)');
{
  // 默认 --patch-src 指向 $MODDIR/tools/cordis.patch.example.yml（装机态那份）。
  // 这里显式指到 recognize/ 的真源，验"改源 = 改块"这条不变式: 脚本里没有第二份副本。
  const h = homeFor('from-source');
  const a = reg(h, '--patch-src', path.join(ROOT, 'recognize', 'cordis.patch.yml'));
  ok(a.status === 'REGISTERED', '从 recognize/cordis.patch.yml 推导出条目并登记', a.out);
  const t = readPatch(h);
  ok(t.includes(MARK_BEGIN) && t.includes(MARK_END), '标记齐全');
  ok(/- insert:\n\s*- id: mcp-screen/.test(t), '条目是 recognize 里那条 insert', t);
  // 关键: 条目正文必须**逐字**来自源文件，而不是脚本里重写过的副本。
  const srcText = fs.readFileSync(path.join(ROOT, 'recognize', 'cordis.patch.yml'), 'utf8');
  const srcEntry = srcText.slice(srcText.indexOf('- insert:')).replace(/\s+$/, '');
  ok(t.includes(srcEntry), '块内条目与源文件逐字节相同', srcEntry);

  // 换一个源: command 路径不同 → 写出的块必须跟着变 (证明没有写死的抄本)。
  const h2 = homeFor('other-source');
  const alt = path.join(h2, 'alt.yml');
  fs.writeFileSync(alt, '- insert:\n    - id: mcp-screen\n      name: x\n      config:\n        serverName: screen\n        command: /somewhere/else\n');
  reg(h2, '--patch-src', alt);
  ok(readPatch(h2).includes('command: /somewhere/else'), '块内容跟随 --patch-src 变化', readPatch(h2));

  // 源里没有 screen 条目 → 不能瞎写
  const h3 = homeFor('no-screen-source');
  const none = path.join(h3, 'none.yml');
  fs.writeFileSync(none, "- insert:\n    - id: other\n      name: x\n      config:\n        serverName: nobody\n");
  fs.writeFileSync(path.join(h3, 'cordis.patch.yml'), '[]\n');
  const a3 = reg(h3, '--patch-src', none);
  ok(a3.status === 'REFUSED' && readPatch(h3) === '[]\n', '源里找不到 screen 条目: 拒绝且字节不动', a3.out);

  // 源文件缺失 → 登记拒绝，但**卸载必须照常工作**: 卸载失败会让托管块永久
  // 赖在用户 home 层里，比不登记严重得多。
  const h4 = homeFor('missing-source');
  writePatch(h4, BLOCK);
  const miss = path.join(h4, 'does-not-exist.yml');
  const a4 = reg(h4, '--patch-src', miss);
  ok(a4.status === 'REFUSED', '模板缺失时不登记', a4.out);
  const r4 = reg(h4, '--patch-src', miss, '--remove');
  ok(r4.status === 'REMOVED' && readPatch(h4).trim() === '[]', '模板缺失时卸载仍然成功', r4.out + ' | ' + JSON.stringify(readPatch(h4)));
  ok(dsh(h4).code === 0, '模板缺失下卸载后 DSH 仍能启动');
}

console.log('\n' + '='.repeat(60));
console.log(`  ${pass} 通过 / ${fails.length} 失败`);
if (fails.length > 0) {
  console.log('\n失败项:');
  for (const f of fails) console.log('  ✗ ' + f);
}
fs.rmSync(sandbox, { recursive: true, force: true });
process.exit(fails.length > 0 ? 1 : 0);
