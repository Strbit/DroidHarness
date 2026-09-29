#!/usr/bin/env node
/**
 * register-screen-mcp.mjs — 把屏幕识别的 MCP 条目**自己**接进 DSH
 *
 * 为什么要它存在
 * --------------
 * 屏幕识别的服务本体装在 /data/adb/dsh/tools/，但要让模型真的拿到那 4 个
 * mcp__screen__* 工具，还得往 DSH 的 patch 层里加一条 insert。以前这一步是
 * 「装机日志打印模板，你自己并进去」—— 等于把成本推回给用户: 他得认识 YAML、
 * 知道 $DSH_HOME/cordis.patch.yml 在哪、还得赌自己没写坏缩进。一个号称安装即用
 * 的模块不该有这种步骤。本脚本让模块自己完成它，**并且不碰用户别的任何字节**。
 *
 * 落点为什么是 $DSH_HOME/cordis.patch.yml（home 层），不是 profiles/<p>/
 * --------------------------------------------------------------------
 * dsh-app-boot 的 readProfilePatches 依次读: bundle 层（根为空）→
 * profiles/<p>/cordis.patch.yml → **$DSH_HOME/cordis.patch.yml** → --patch 覆盖层。
 * home 层**确实**进到合成后的树里（实测 --dump-config 里出现我们那条 insert）。
 * 选它的三个理由:
 *   · profiles/<p>/cordis.yml 装载时会被 DSH **自己改写**，不是能长期共存的落点；
 *     而 home 层没有任何 DSH 写入者（只有 initProfile 会在**profile 层**文件缺失时
 *     建一个空的），我们写的内容不会跟谁打架。
 *   · service.sh（web）和 bin/dsh（命令行）共用 bin/env.sh，同一份 home 层对两个
 *     入口都生效。写 profile 层只覆盖一个入口，症状是「web 有工具、命令行没有」。
 *   · home 层在 profile 层**之后**读，也就是比用户给单个 profile 写的 patch 晚 ——
 *     配合 prepend（见下）用户的否决行仍然压得住我们。
 *
 * 为什么是纯文本手术，不解析也不回写 YAML
 * ----------------------------------------
 * 用真解析器"读进来改一改再写出去"看着最正规，实测两条路都堵:
 *   · DSH 自己用 **js-yaml** 解析 patch（index.js:3561
 *     `yaml.load(content, {schema: userPatchesSchema})`），而 js-yaml 的**默认
 *     schema 拒绝 `!!js`**（`unknown tag`）—— 那是 DSH 明确支持的用户写法。
 *     拿它读写会在用户写过 `!!js` 的文件上直接失败。
 *   · 任何解析器的**回写**都会重排用户的整个文件: 注释位置、引号风格、锚点、
 *     折叠标量全变。一次重装就把人手工排版的文件洗成机器格式，还顺手丢注释。
 *     那不是"格式不好看"，是**破坏用户数据**。
 * 所以本脚本只做**标记块之间的文本替换**: 标记外的字节原样保留，我们的条目用
 * 内置的字面文本（不走 include 间接引用 —— 实测 patch 层里 include 被**静默忽略**:
 * 三种写法 exit 都是 0 而条目数 0，也就是说它会给你一个"看起来装好了"的哑配置）。
 *
 * 校验用模块自带的 `yaml` 包（只读，绝不回写）
 * --------------------------------------------
 * 写完必须自检 —— 一次坏写的代价不是"这个功能没生效"，而是**整个 DSH 起不来**
 * （home 层解析失败是 throw，service.sh 有 5 次/10 秒的启动熔断，熔断后连模块自启
 * 都停了）。这个险不能赌。用 `yaml` 包**只解析**，实测性质正好:
 *   · 对 `!!js` 宽容（errors=0）→ 不会误杀合法的用户写法;
 *   · 抓得到真坏文件（`config: [1,` → errors=1）;
 *   · DSH 的两条硬规则（顶层必须是数组、每项必须是映射）在这里显式复核。
 * 自检不过就不写（exit 2）: 宁可不登记，也不能给一个砖头。
 *
 * 三条形状规则全是用真 DSH 实测出来的（不是想出来的）
 * ---------------------------------------------------
 *  1. **prepend**: 块放在文件开头（若有 `---` 则紧随其后）。patch 按序应用、后写
 *     覆盖先写，且**没有去重**。块在前，用户想关掉就在后面加
 *     `- id: mcp-screen` / `disabled: true` —— 实测否决真的落到我们那行上
 *     （dump 里该行带上 `disabled: true`）。块在后则用户的条目在我们**前面**，
 *     形状和优先级都不对。
 *  2. **占位符 `[]` 必须被替换掉，不能与块共存**: 块 + 残留 `[]` 实测
 *     `exit=1 failed to parse`（flow 序列夹在 block 序列之后不是合法顶层）。
 *     而 `[]` 正是 DSH 建 patch 文件时的模板初值 —— 不处理就等于第一次装机就砖。
 *  3. **移除后必须留 `[]`，不能只剩注释**: 只剩注释的 patch 文件实测
 *     `exit=1 must be a top-level YAML array of loader patch entries`。卸载要卸得
 *     干净，又不能把 DSH 一起送走。
 *
 * 另外两条防呆
 * ------------
 *   · 用户已经有 `serverName: screen` 的条目（手工加过）就不再插: patch 层不去重，
 *     插两份 = 两个同名 MCP 子进程，而 DSH 一声不吭（实测 行数=2 / exit=0 / 无警告）。
 *   · 读不准就不动: 多个 `---`（多文档）、原文件本来就解析不过的，一律不写。
 *     "不写"的后果只是少 4 个工具，"写坏"的后果是整个模块起不来。
 *
 * 用法
 * ----
 *   register-screen-mcp.mjs [--home <DSH_HOME>] [--modules <node_modules>]
 *                           [--patch-src <cordis.patch.example.yml>]
 *                           [--remove] [--dry-run] [--no-validate] [--print-block]
 *
 * 退出码 0 成功（含无变化）/ 2 拒绝写入 / 3 用法错
 * stdout 末行是机器可读的 `STATUS: <词>`，给 customize.sh 和测试断言用；诊断走 stderr。
 * `--print-block` 是例外: 它只把托管块本身打到 stdout（一个字都不多），给打包时
 * 第 4 道门核对"这个脚本实际会写什么"用。
 *
 * ⚠ 别指望那个 shebang。Android 上没有 `/usr/bin/env`，直接 exec 得到的是
 *   `No such file or directory` 而不是任何有用的信息 —— 一律显式
 *   `node <本文件>`（customize.sh 第 7 节的 run_node、uninstall.sh 都是这么做的）。
 *   留着它是给 PC 侧方便，不是设备侧的可执行入口。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ── 托管块的内容 ────────────────────────────────────────────
// 标记行是我们自己的协议，写死在这里。
const MARK_BEGIN = '# >>> dsh-screen-mcp (managed by dsh_android module) >>>';
const MARK_END = '# <<< dsh-screen-mcp <<<';
const BEGIN_RE = /^# >>> dsh-screen-mcp\b/;
const END_RE = /^# <<< dsh-screen-mcp\b/;
// 条目本体**不写死**在这里。
// 第二份副本必然会和第一份漂移: recognize/cordis.patch.yml 改了 command 路径而
// 这里没跟上，结果是装机日志一片 [ OK ] 而设备上那条 patch 指向一个不存在的
// 文件 —— MCP 子进程起不来，DSH 主服务照常健康（本项目最擅长生产这类失败）。
// 所以块的内容由 --patch-src 那份文件**现场推导**，全仓库只有那一处是真源。

function log(s) {
  process.stdout.write(s + '\n');
}
// 诊断走 **stderr**: --print-block 要把 stdout 当字节直接比对（打包时第 4 道门），
// 一句"自检不可用"混进 stdout 就会让一个本来正确的块比对失败 —— 而那种失败
// 看起来像"内容漂移"，把人往完全错误的方向带。
function warn(msg) {
  process.stderr.write('  [register] ' + msg + '\n');
}
function finish(status, code) {
  log('STATUS: ' + status);
  process.exit(code);
}

// ── 参数 ────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const FLAGS = new Set(['--remove', '--dry-run', '--no-validate', '--print-block']);
const VALUED = new Set(['--home', '--modules', '--patch-src']);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (FLAGS.has(a)) continue;
  if (VALUED.has(a)) {
    if (!argv[i + 1]) finish('USAGE: 缺 ' + a + ' 的值', 3);
    i++;
    continue;
  }
  log('用法: register-screen-mcp.mjs [--home <DSH_HOME>] [--modules <node_modules>]');
  log('      [--patch-src <cordis.patch.example.yml>] [--remove] [--dry-run] [--no-validate]');
  log('未知参数: ' + a);
  finish('USAGE', 3);
}
const REMOVE = argv.includes('--remove');
const DRY = argv.includes('--dry-run');
const NO_VALIDATE = argv.includes('--no-validate');
function flagVal(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

const HOME = flagVal('--home') ?? process.env.DSH_HOME ?? '/data/adb/dsh';
const FILE = path.join(HOME, 'cordis.patch.yml');
// 装机态: 脚本在 $MODDIR/bin/，运行时树在 $MODDIR/app/，模板在 $MODDIR/tools/。
const MODULES = flagVal('--modules') ?? path.resolve(HERE, '..', 'app', 'node_modules');
const PATCH_SRC = flagVal('--patch-src') ?? path.resolve(HERE, '..', 'tools', 'cordis.patch.example.yml');

/** 托管块 = 标记 + 条目原文。entry 自带结尾换行，所以块结尾没有换行。 */
function blockOf(entry) {
  return MARK_BEGIN + '\n' + entry + MARK_END;
}

/**
 * 从 recognize 那份真源里取出 screen 条目的**原文**。
 *
 * 为什么现场推导而不是在这里抄一份: 抄一份 = 两份真相。改了源没改这里，装机
 * 日志照样 [ OK ]，设备上那条 patch 却指向旧路径 —— MCP 子进程起不来而 DSH
 * 主服务照常健康，正是本项目反复生产的那种"绿灯掩盖"的失败。
 *
 * 取的是**文本**不是解析后的对象: 解析再序列化会把条目的注释、引号风格改掉
 * （见文件头"为什么是纯文本手术"）。这里只按顶层 `- ` 的列切出行范围。
 *
 * 失败一律返回 null 并由调用方 REFUSED: 读不准就不写，永远比写错好。
 */
function deriveEntry(text) {
  const src = text.replace(/\r\n/g, '\n');
  const lines = src.split('\n');
  // 顶层序列项的起始行: 第 0 列的 `- `（缩进的一律不算，那是上一项的内容）。
  const starts = [];
  for (let i = 0; i < lines.length; i++) if (/^-(\s|$)/.test(lines[i])) starts.push(i);
  if (starts.length === 0) return null;

  let pick = -1;
  if (Y) {
    // 用解析结果定位"哪一项是 screen"，而不是靠肉眼扫字符串 —— 条目里
    // serverName 的写法可以有引号/缩进变化，解析后判最稳。
    let js;
    try {
      js = Y.parseDocument(src).toJS();
    } catch {
      js = null;
    }
    if (Array.isArray(js)) {
      for (let k = 0; k < js.length; k++) {
        const rows = js[k] && Array.isArray(js[k].insert) ? js[k].insert : [js[k]];
        const hit = rows.some((r) => r && ((r.config && String(r.config.serverName) === 'screen') || String(r.serverName) === 'screen'));
        if (hit) { pick = k; break; }
      }
      // 解析出的项数必须和按行切的项数一致，否则我们的行切分不可信（多文档、
      // flow 风格 `- {…}` 之类），这种情况直接放弃。
      if (pick >= 0 && js.length !== starts.length) return null;
    }
  }
  if (pick < 0) {
    // 没有解析器（--no-validate / 找不到 yaml）: 退回文本判据。
    for (let k = 0; k < starts.length; k++) {
      const end = k + 1 < starts.length ? starts[k + 1] : lines.length;
      const span = lines.slice(starts[k], end).join('\n');
      if (/^\s*serverName:\s*screen\b/m.test(span)) { pick = k; break; }
    }
  }
  if (pick < 0 || pick >= starts.length) return null;

  const end = pick + 1 < starts.length ? starts[pick + 1] : lines.length;
  const span = lines.slice(starts[pick], end);
  // 丢掉条目后面挂着的空行与注释: 那些是给"下一个条目"或写给人看的，
  // 不是 screen 条目本身，塞进托管块会让我们多背一份不属于我们的内容。
  while (span.length > 0 && (span[span.length - 1].trim() === '' || span[span.length - 1].trim().startsWith('#'))) span.pop();
  if (span.length === 0) return null;
  const entry = span.join('\n') + '\n';
  // 兜底自检: 截出来的这段必须自己就是一个合法的 patch 条目，并且真的是 screen。
  if (checkText(entry) !== '') return null;
  if (!/^\s*serverName:\s*screen\b/m.test(entry) && !entry.includes('serverName: screen')) return null;
  return entry;
}

// ── 只读校验器 ──────────────────────────────────────────────
// 注意 require 的是**包目录**而不是 dist/index.js: 那份是 ESM 构建, 用 require
// 拿会撞 ERR_REQUIRE_ESM; 交给 package.json 自己挑 CJS 入口 (实测可解析)。
let Y = null;
if (!NO_VALIDATE) {
  try {
    Y = createRequire(import.meta.url)(path.join(MODULES, 'yaml'));
  } catch (e) {
    warn('自检不可用: 找不到模块自带的 yaml 包 (' + (e.code ?? e.message) + ')');
  }
}

/** DSH 的两条硬规则 + 一次纯解析。返回错误串; 合法返回 ''。 */
function checkText(text) {
  if (!Y) return '';
  let doc;
  try {
    doc = Y.parseDocument(text, { prettyErrors: true });
  } catch (e) {
    return '解析抛错: ' + String(e.message ?? e).split('\n')[0];
  }
  if (doc.errors.length > 0) {
    return '解析有错: ' + doc.errors.map((x) => String(x.message).split('\n')[0]).join(' / ');
  }
  const js = doc.toJS();
  // 只有注释的文件 toJS() 是 null —— DSH 要的是数组, 所以那同样是砖。
  if (!Array.isArray(js)) return '顶层不是 YAML 数组 (DSH 会拒绝启动)';
  for (let i = 0; i < js.length; i++) {
    if (typeof js[i] !== 'object' || js[i] === null) return `顶层第 ${i + 1} 项不是映射`;
  }
  return '';
}

/** 按标记切: { head, block|null, tail }。标记外的一律不动。 */
function splitBlock(text) {
  const lines = text.split('\n');
  let b = -1;
  for (let i = 0; i < lines.length; i++) if (BEGIN_RE.test(lines[i])) { b = i; break; }
  if (b < 0) return { head: text, block: null, tail: '' };
  let e = -1;
  for (let i = lines.length - 1; i > b; i--) if (END_RE.test(lines[i])) { e = i; break; }
  if (e < 0) {
    // 有起无止: 半残的旧块。把标记行到末尾整体当成块重写掉, 比留着安全。
    return { head: lines.slice(0, b).join('\n'), block: lines.slice(b).join('\n'), tail: '' };
  }
  return {
    head: lines.slice(0, b).join('\n'),
    block: lines.slice(b, e + 1).join('\n'),
    tail: lines.slice(e + 1).join('\n'),
  };
}

/** 一段文本的粗形状: 实体内容行数 / `---` 数 / 是否只有 [] 占位符。 */
function shapeOf(text) {
  let docMarker = 0;
  let content = 0;
  let seqPlaceholder = 0;
  for (const l of text.split('\n')) {
    const t = l.trim();
    if (t === '' || t.startsWith('#')) continue;
    if (t === '---') { docMarker++; continue; }
    content++;
    if (t === '[]') seqPlaceholder++;
  }
  return { docMarker, content, seqPlaceholder, onlyPlaceholder: content > 0 && content === seqPlaceholder };
}

/** 块之外的用户内容里, 是否已经有 screen 这个 MCP server。 */
function userHasScreen(text) {
  if (!text || text.trim() === '') return false;
  if (shapeOf(text).content === 0) return false;
  if (Y) {
    try {
      const js = Y.parseDocument(text).toJS();
      if (Array.isArray(js)) {
        const rows = js.flatMap((p) => (p && Array.isArray(p.insert) ? p.insert : [p]));
        return rows.some((r) => r && ((r.config && String(r.config.serverName) === 'screen') || String(r.serverName) === 'screen'));
      }
    } catch {
      /* 解析不了就退回字符串判据 */
    }
  }
  // 保守: 判不准时宁可当成"已有"也不重复插一份 (重复 = 两个静默的子进程)。
  return /^\s*serverName:\s*screen\b/m.test(text) || /^\s*- id:\s*mcp-screen\b/m.test(text);
}

/** 按顺序拼段落, 跳过空段, 段之间补一个换行 —— 避免出现游离的空行首/尾。 */
function joinParts(...segs) {
  const out = [];
  for (const s of segs) {
    if (s === undefined || s === null || s === '') continue;
    const t = String(s).replace(/^\n+|\s+$/g, '');
    if (t === '') continue;
    out.push(t);
  }
  return out.join('\n') + '\n';
}

function emit(text, status) {
  const err = checkText(text);
  if (err) {
    warn('写入前自检不过: ' + err + ' —— 保持原文件不动');
    finish('REFUSED', 2);
  }
  if (DRY) {
    log('--- dry-run: ' + FILE + ' ---');
    for (const l of text.split('\n')) log('  | ' + l);
    finish('DRY', 0);
  }
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, text);
  // 回读逐字节核一遍: 半个 YAML 落在盘上比不写糟得多 —— DSH 下次启动会直接撞在
  // 解析错误上, 然后熔断把模块自启一起带走。
  const back = fs.readFileSync(FILE, 'utf8');
  if (back !== text) {
    warn('回读与写入不一致 (磁盘满 / 截断?), 不再修补');
    finish('REFUSED', 2);
  }
  finish(status, 0);
}

// ── 托管块正文: 现场从真源推导 ───────────────────────────────
// ENTRY_TEXT 与原来那份写死的常量**同语义**: 完整的块，结尾不带换行。
//
// ⚠ 只在登记时需要。卸载 (--remove) 绝不能依赖它: 移除托管块只要认标记行，
// 万一模板缺失（打包出岔、tools/ 被人为删过）还去拒绝卸载，那个块就**永远
// 留在用户的 home 层里**了 —— 卸载失败比不登记严重得多。
const PRINT_BLOCK = argv.includes('--print-block');
let ENTRY_TEXT = null;
if (!REMOVE || PRINT_BLOCK) {
  let src = null;
  try {
    src = fs.readFileSync(PATCH_SRC, 'utf8');
  } catch (e) {
    warn('读不到条目真源 ' + PATCH_SRC + ' (' + (e.code ?? e.message) + ')');
  }
  if (src !== null) {
    const entry = deriveEntry(src);
    if (entry !== null) ENTRY_TEXT = blockOf(entry);
  }
  if (ENTRY_TEXT === null) {
    warn('没能从 ' + PATCH_SRC + ' 里确定 screen 那条 insert —— 不写入');
    warn('  (宁可不登记: 抄一份写死在脚本里的副本迟早会和真源漂移)');
    finish('REFUSED', 2);
  }
}

if (PRINT_BLOCK) {
  // 只输出块本身 + 一个结尾换行，stdout 上**不写任何别的东西** —— 打包时
  // dsh/tools/stage-tools.mjs 第 4 道门把这里的 stdout 当字节直接比对。
  // 用进程自己而不是让校验脚本再实现一遍推导: 那样门测的是"我以为脚本会写什么"，
  // 而不是"脚本实际会写什么"，正是本项目反复踩的自证式测试。
  // 失败路径在上面已经 REFUSED exit 2，走不到这里；门只会在 exit 0 时读 stdout。
  process.stdout.write(ENTRY_TEXT + '\n');
  process.exit(0);
}

// ── 现状 ────────────────────────────────────────────────────
let original = null;
if (fs.existsSync(FILE)) {
  try {
    original = fs.readFileSync(FILE, 'utf8');
  } catch (e) {
    warn('读不了 ' + FILE + ': ' + (e.code ?? e.message));
    finish('REFUSED', 2);
  }
}

// ── 卸载 ────────────────────────────────────────────────────
if (REMOVE) {
  if (original === null) finish('ABSENT', 0);
  const { head, block, tail } = splitBlock(original);
  if (block === null) finish('NOBLOCK', 0); // 从没登记过: 一个字都不改
  // 把块整段摘掉, 标记外的字节原样留下; 只压缩因此出现的连续空行
  // (引用**旧数组**判定, 所以连续 3 个空行也只会留 1 个)。
  const parts = (head + '\n' + tail).split('\n');
  const kept = parts.filter((l, i) => !(l.trim() === '' && (i === 0 || parts[i - 1].trim() === '')));
  let joined = kept.join('\n').replace(/\s+$/, '');
  const sh = shapeOf(joined);
  if (sh.content === 0) {
    // 只剩注释 / 全空: 必须写成 [] —— 纯注释文件 DSH 拒绝启动 (实测)。
    joined = (joined.trim() === '' ? '[]' : joined.trim() + '\n[]');
  } else if (sh.onlyPlaceholder) {
    joined = '[]';
  }
  emit(joined + '\n', 'REMOVED');
}

// ── 登记: 文件不存在 ────────────────────────────────────────
if (original === null) {
  emit(ENTRY_TEXT + '\n', 'REGISTERED');
}

const { head, block, tail } = splitBlock(original);

// 现有文件里有**实体内容**却解析不过 → 不写。注意"空文件"和"只有注释"不在
// 这一类: 那两种残壳 DSH 自己也是拒绝的 (实测 toJS()=null → must be a
// top-level YAML array), 而我们 prepend 的块正好提供那个缺失的数组 —— 所以
// 该救, 不该拒。判据是"有内容且读不懂", 不是"现在的文件能启动"。
const shape0 = shapeOf(original);
if (shape0.content > 0) {
  const preErr = checkText(original);
  if (preErr) {
    warn('现有内容本来就无法被 DSH 解析 (' + preErr + ') —— 不改写它');
    finish('REFUSED', 2);
  }
}

// 块本身已是我们最新的内容: 什么都不做。**先判 same 再管块外的重复** ——
// 块外有没有用户的 screen 都不该改这个块 (改了也只是把一个重复换成另一个,
// 而重写会动到用户等着看的那几行字节)。
if (block !== null) {
  if (block.replace(/[ \t]+$/gm, '') === ENTRY_TEXT.replace(/[ \t]+$/gm, '')) finish('UNCHANGED', 0);
  // 模块升级改了条目 → 原地换掉整块, **位置不动** (仍在最前), 标记外一字不改。
  if (userHasScreen(head + '\n' + tail)) {
    warn('块外已有 serverName: screen 的条目 —— 只刷新块本身, 不额外插入');
  }
  // head 为空 (块本来就在文件开头) 时不能留一个游离的换行开头。
  emit(joinParts(head, ENTRY_TEXT, tail), 'REPLACED');
}

// 用户手工加过 screen: 不插第二份 (patch 层不去重, 重复=两个静默子进程)。
if (userHasScreen(original)) {
  warn('文件里已有 serverName: screen 的条目 —— 不重复插入');
  finish('SKIPPED-DUPE', 0);
}

// 有起无止的半残块已被 splitBlock 归到块里, 走不到这里。
// 多个 `---` = 多文档, 形状我们读不准: 不动。
const lines = original.split('\n');
let dashCount = 0;
for (const l of lines) if (l.trim() === '---') dashCount++;
if (dashCount > 1) {
  warn('文件里有 ' + dashCount + ' 个 --- 分隔符 (多文档), 不敢改写');
  finish('REFUSED', 2);
}

// 插入点 = 第一行"实体内容"处; 若那行是 `---`, 插到它**后面** (实测块在
// `---` 之后 exit=0, 在它之前 exit=1: 会把文件变成两个文档)。
let insertAt = lines.findIndex((l) => {
  const t = l.trim();
  return t !== '' && !t.startsWith('#');
});
if (insertAt < 0) insertAt = lines.length; // 只有注释/空行: 追加在末尾
else if (lines[insertAt].trim() === '---') insertAt += 1;

const prefix = lines.slice(0, insertAt);
const suffix = lines.slice(insertAt);
const sh = shapeOf(suffix.join('\n'));
if (sh.onlyPlaceholder) {
  // 只有 [] 模板初值: 用块**替换**它 (共存实测 exit=1)。注释行留着不动。
  const kept = suffix.filter((l) => l.trim() !== '[]');
  suffix.length = 0;
  suffix.push(...kept);
}

const out = [];
// 残壳文件 (0 字节 / 只有注释) 里前缀可能整段是空行: 那没有信息价值, 也不该
// 让我们写的文件以一个空行开头。有真实内容的用户前缀**一字不动**地保留。
for (const l of prefix) {
  if (out.length === 0 && l.trim() === '') continue;
  out.push(l);
}
if (out.length > 0 && out[out.length - 1].trim() !== '' && !out[out.length - 1].trim().startsWith('#')) {
  // 用户的内容紧贴块之前时插一个空行隔开。纯装饰, 且只加在我们块**前面**,
  // 不改用户任何一行。
  out.push('');
}
out.push(ENTRY_TEXT);
const restSuffix = suffix.join('\n').replace(/^\n+/, '');
if (restSuffix.trim() !== '') out.push(restSuffix.replace(/\s+$/, ''));
emit(out.join('\n') + '\n', 'REGISTERED');
