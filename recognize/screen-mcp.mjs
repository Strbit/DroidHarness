#!/usr/bin/env node
// screen-mcp -- 设备侧屏幕识别 MCP 服务
//
// 定位: 跑在手机上的"眼睛"。用 Android 平台原语实现, 不依赖 adb、不依赖 PC。
//
// 两条识别路线(互补, 失效场景不重叠):
//   1. 无障碍树  uiautomator dump  -> 精确文字 / resource-id / 坐标 / 可点祖先
//   2. 屏幕图片  screencap -p      -> 真实像素, 交给视觉模型理解语义与布局
//
// 为什么设备侧不做 OCR: 手机上没有 tesseract 也没有 ML Kit 的文本识别入口(已实测)。
// 而且让视觉模型直接看图比 OCR 更强 —— 它能理解布局、图标含义和"这块区域是干什么的",
// OCR 只能给出文字。所以图片路线的输出就是图片本身, 由模型去读。
//
// 设计纪律(逐条对应一个已确认的失败模式):
//   · 熄屏是静默失败: 熄屏时 screencap 交最后一帧且不报错 -> 结果必须带 displayState
//   · 引擎自绘界面不是空树而是"没用的树" -> 判据是"有无值得动手的节点"
//   · 探测失败就报错, 不用默认值兜底(静默错坐标比报错危险)
//   · 不绑任何 harness: 走标准 MCP, 换 harness 时这个文件一行不改
//
// 传输: stdio, JSON-RPC 2.0, 每行一个消息。

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FrameCache, truncateField, boundArray } from './lib/fields.mjs';
import { runCommand } from './lib/spawn-env.mjs';
import { parseDisplays } from './lib/displays.mjs';
import { parseDisplaysPreferred } from './lib/cmd-display.mjs';
import { parseUiXml, labelOf, toTargets, isUsefulTree } from './lib/uitree.mjs';
import { uiLock } from './lib/ui-lock.mjs';
import { physicalInput, injectText, vdStart, vdStop, vdShot, vdGet, fetchTree, launchOnDisplay, findTasks, vdHandoff, topPackageOnDisplay } from './lib/uiaction.mjs';

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07'];
const LATEST = PROTOCOL_VERSIONS[0];
const SERVER_INFO = { name: 'screen-recognize', version: '0.1.0' };

// 设备侧临时目录: 系统为可写且不在用户存储里的位置
const TMP = '/data/local/tmp';

const log = (s) => process.stderr.write('[screen-mcp] ' + s + '\n');
const rpcOut = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

// ── 平台原语 ──────────────────────────────────────────────

/**
 * 执行子进程。
 *
 * **环境按命令类别区分**(这是阻断级修复, 见 lib/spawn-env.mjs 的详细说明):
 * 本进程由 harness 经 stdio spawn, 继承了 DSH 服务导出的
 * `LD_LIBRARY_PATH=<模块>/usr/lib`。该路径下是 Termux 编译的库, 系统二进制
 * (尤其 `uiautomator`, 它经 `app_process` 起 ART)加载它们会 fatal:
 *   CANNOT LINK EXECUTABLE "app_process": cannot find "libz.so" from verneed[1]
 * 而 node 自身又**需要**这个变量。一个变量两向绑定, 所以只能按子进程区分 ——
 * 系统二进制剔除, node 保留。
 *
 * 参数始终走 argv 数组(不拼 shell 字符串), 这挡住了来自 tool call 参数的注入。
 */
function run(cmd, args, opts = {}) {
  return runCommand(cmd, args, { ...opts, spawnImpl: execFile });
}

/**
 * 屏列表: 跨设备解析, 运行时推导不硬编码。
 *
 * 解析逻辑在 lib/displays.mjs —— 那是本轮修跨设备缺陷的地方, 有独立测试。
 * 这里只负责取原始文本。
 *
 * 为什么改成这样: 旧实现只看 `Display 0 [id=local:...,stack=0],isFirst=true,...`,
 * 而该形态在 Xiaomi 25102RKBEC / Android 16 上**一次都不存在**
 * (grep 命中 0), 于是整个工具失效。现在只认两台真机都稳定的形态:
 *   · DisplayDeviceInfo{...}  每块屏的尺寸/密度/唯一 id
 *   · mState=                 真实屏状态（**不是**裸 state=, 那个有 100+ 条历史噪声）
 *   · mViewports              逻辑 displayId ↔ uniqueId 映射
 *   · SurfaceFlinger --display-id   sfId 列表
 */
async function listDisplays() {
  const out = { displays: [], wakefulness: null, error: null };

  // 主路径：`cmd display get-displays`（机器可读，2 行）
  let cmdDisplay = '';
  try {
    cmdDisplay = (await run('/system/bin/cmd', ['display', 'get-displays'])).stdout;
  } catch { /* 老版本可能没有这个子命令, 走兜底 */ }

  // 兜底路径：`dumpsys display`（人类可读转储，1000+ 行）
  let dumpsysDisplay = '';
  let surfaceFlinger = '';
  let power = '';
  try {
    dumpsysDisplay = (await run('/system/bin/dumpsys', ['display'])).stdout;
  } catch (e) {
    if (!cmdDisplay) {
      out.error = 'dumpsys display 失败，且 cmd display 无输出: ' + e.message;
      return out;
    }
  }
  // 这两段拿不到不致命: sfId 可从 uniqueId 前缀推导, 唤醒状态可为 null
  try {
    surfaceFlinger = (await run('/system/bin/dumpsys', ['SurfaceFlinger', '--display-id'])).stdout;
  } catch { /* 忽略 */ }
  try {
    power = (await run('/system/bin/dumpsys', ['power'])).stdout;
  } catch { /* 忽略 */ }

  // 统一入口 —— **不要再直接调 parseDisplays**。
  // 这条与 B1 是同构的错误，只是方向相反：B1 是 PC 侧直连旧解析、
  // 这里是设备侧直连兜底解析。两边都必须走同一个入口，
  // 否则"收敛到单一路径"就只是换了个人重复同一个失误。
  const parsed = parseDisplaysPreferred(
    { cmdDisplay, dumpsysDisplay, surfaceFlinger, power },
    parseDisplays,
  );
  out.displays = parsed.displays;
  out.wakefulness = parsed.wakefulness;
  out.defaultSurfaceFlingerId = parsed.defaultSurfaceFlingerId;
  out.source = parsed.source;
  out.error = parsed.error;

  // wm size / wm density 补充: 这是**逻辑**尺寸与密度覆盖, 与物理值可能不同
  // (实测 OnePlus: 物理 560dpi, 覆盖 476)
  try {
    const wsz = (await run('/system/bin/wm', ['size'])).stdout;
    const om = wsz.match(/Override size:\s*(\d+)x(\d+)/);
    const pm = wsz.match(/Physical size:\s*(\d+)x(\d+)/);
    out.wmOverride = om ? { width: Number(om[1]), height: Number(om[2]) } : null;
    out.wmSize = pm ? { width: Number(pm[1]), height: Number(pm[2]) } : null;
  } catch { /* 忽略 */ }
  try {
    const wd = (await run('/system/bin/wm', ['density'])).stdout;
    const od = wd.match(/Override density:\s*(\d+)/);
    const pd = wd.match(/Physical density:\s*(\d+)/);
    out.wmDensity = { physical: pd ? Number(pd[1]) : null, override: od ? Number(od[1]) : null };
  } catch { /* 忽略 */ }

  return out;
}

/** 指定逻辑屏的屏状态(供各工具做新鲜度标注) */
async function displayState(logicalId = 0) {
  const info = await listDisplays();
  // 与 observe.mjs 同一条纪律（第三轮 B1/B4）：**找不到请求的屏就如实说，不拿第 0 块顶替**。
  // 旧代码是 `... || info.displays[0] || null` —— 请求副屏时会拿主屏的状态当副屏上报，
  // 于是"这块屏的内容可不可信"这个判断建立在错误的屏上。
  const d = info.displays.find((x) => x.logicalId === logicalId) ?? null;
  // 也不再往每个 payload 里塞 `all: info.displays`：
  // 那是把完整屏列表重复进每一次 screen_tree / screen_targets 的返回，
  // 而需要屏列表的调用方本就有 list_displays 可用（第三轮 B4 指出的体积问题之一）。
  return {
    ...(d || { logicalId, state: null, missing: true }),
    wakefulness: info.wakefulness,
    displaySource: info.source ?? null,
    requestedLogicalId: logicalId,
    availableLogicalIds: info.displays.map((x) => x.logicalId),
  };
}

// ── 帧缓存 ────────────────────────────────────────────────
// 这是一个长驻进程(MCP stdio), 所以缓存跨调用有效 —— 模型在连续几步里
// 反复看图时, 复用能省掉 screencap 的 PNG 编码开销(设备上可能超过 1 秒)。
//
// 两条硬要求:
//   · 缓存键必须含 displayId。主屏和副屏坐标系完全不同, 混用会静默错坐标。
//   · 复用必须如实报出该帧的**真实**采集时刻, 并明确标注 fromCache。
//     缓存帧伪装成新帧, 比读到旧帧本身更危险。
const frameCache = new FrameCache();

/** 默认允许复用多久以内的帧。0 = 每次重新采集(最保守)。 */
const DEFAULT_MAX_FRAME_AGE_MS = 0;

/**
 * 截屏。
 * 平台事实(实测于 Android 16): screencap 用法是 [-ahp] [-d display-id] [FILENAME]。
 *   · `-d` 收的是 SurfaceFlinger 的 display id(不是逻辑 displayId); 不给则用默认屏
 *   · 不接受 `--display` (会 unrecognized option)
 *   · `-a` 抓取所有活动屏并加数字后缀
 */
async function screencap(surfaceFlingerId, { maxAgeMs = DEFAULT_MAX_FRAME_AGE_MS, cacheKey = null } = {}) {
  const capture = async () => {
    const args = [];
    if (surfaceFlingerId !== undefined && surfaceFlingerId !== null) args.push('-d', String(surfaceFlingerId));
    args.push('-p');
    const t0 = Date.now();
    const { stdout } = await run('/system/bin/screencap', args, { encoding: 'buffer', timeout: 30000 });
    const buf = stdout;
    const isPng = buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
    let width = null, height = null;
    if (isPng && buf.length > 24) { width = buf.readUInt32BE(16); height = buf.readUInt32BE(20); }
    return { buf, isPng, width, height, bytes: buf.length, sfId: surfaceFlingerId ?? null, captureMs: Date.now() - t0 };
  };

  const key = cacheKey ?? `sf:${surfaceFlingerId ?? 'default'}`;
  return frameCache.get(key, capture, { maxAgeMs });
}

/**
 * 无障碍树: dump 到 /data/local/tmp, 读回, 立即删除。
 *
 * 平台限制(实测): `uiautomator dump --display <id>` 会被**静默忽略** ——
 * 传一个不存在的 display id (999) 依然成功并输出默认屏的树。
 * 所以 shell 侧**拿不到非默认屏的无障碍树**。要读虚拟副屏必须由 App 内的
 * AccessibilityService.getWindowsOnAllDisplays() 来做。
 * 这里选择明确报错, 而不是悄悄返回主屏的树(那会导致静默错坐标)。
 */
async function uiTreeDump(logicalId = 0) {
  if (logicalId !== 0) {
    return {
      ok: false, error: 'tree-needs-app',
      detail: `uiautomator dump 只作用于默认屏(displayId 0)：--display 参数会被静默忽略（实测传不存在的 id 仍成功）。` +
        `逻辑屏 ${logicalId} 的无障碍树需要 App 内用 AccessibilityService.getWindowsOnAllDisplays() 获取。` +
        `该屏仍可用 screen_image 截图。`,
    };
  }
  // 串行化后再进 dump。为什么必须串行: 见 lib/ui-lock.mjs 顶部那三条真机实测
  // —— 并发的第二个 uiautomator 不是拿到错误码, 而是被框架 **SIGKILL**，
  // 且不生成文件；而"一轮里多个 tool call 并发"正是 MCP 客户端的默认形状。
  return uiLock.run(dumpUiTree);
}

const DUMP_TRIES = 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 把多行/超长的一段输出压成一行可放进错误信息的文本。 */
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);

/**
 * 真的跑一次 uiautomator dump (已在 uiLock 里, 进程内不会并发)。
 *
 * 重试的理由: 锁只能保证**本进程**不并发。设备上还可能有别人占着 UiAutomation —
 * PC 侧一条 adb 上的 `uiautomator`、另一个 screen-mcp 实例(比如命令行和 web
 * 各起过一个)、或某个无障碍/自动化 App。那些情况是**暂时**的, 退避重试能过
 * (实测: 占用中被 Kill, 释放后立刻成功)。
 *
 * 每次尝试都把退出码/信号/stderr 记进 notes。旧版丢掉这些信息, 只剩
 * `dump-file-missing` 一个词, 排查只能靠猜 —— 这一轮就猜错了三次。
 */
async function dumpUiTree() {
  const startedAt = Date.now();
  const notes = [];
  for (let attempt = 1; attempt <= DUMP_TRIES; attempt++) {
    const remote = path.join(TMP, `sm-${process.pid}-${Date.now().toString(36)}-${attempt}.xml`);
    try {
      const { stderr } = await run('/system/bin/uiautomator', ['dump', remote], { timeout: 25000 });
      if (fs.existsSync(remote)) {
        const xml = fs.readFileSync(remote, 'utf8');
        if (xml.includes('<hierarchy')) {
          // `at` = 树被取下来的时刻（不是返回的时刻）。
          // 调用方据此判断"这个界面信息有多旧" —— uiautomator dump 实测约 2 秒，
          // 而 MCP 是长驻进程，模型可能把几十秒前的树当作当前界面（第三轮 B4）。
          return { ok: true, xml, at: Date.now(), dumpMs: Date.now() - startedAt, tries: attempt };
        }
        notes.push(`#${attempt} 文件在但没有 <hierarchy> (${xml.length} B): ${oneLine(xml)}`);
      } else {
        // 命令"正常结束"却没有文件 —— 实测这是被 SIGKILL 之后留下的形状。
        notes.push(`#${attempt} 退出正常但没生成文件${stderr ? `; stderr: ${oneLine(stderr)}` : ''}`);
      }
    } catch (e) {
      notes.push(
        `#${attempt} exit=${e.code ?? '无'}${e.signal ? ` 信号=${e.signal}` : ''}${e.killed ? '(被杀)' : ''}` +
        `: ${oneLine(e.message)}${e.stderr ? `; stderr: ${oneLine(e.stderr)}` : ''}`,
      );
    } finally {
      try { fs.unlinkSync(remote); } catch { /* 清理失败不致命 */ }
    }
    if (attempt < DUMP_TRIES) await sleep(300 * attempt);
  }
  return {
    ok: false,
    error: 'dump-failed',
    detail:
      `${DUMP_TRIES} 次都没能读到无障碍树:\n    ` + notes.join('\n    ') +
      `\n  uiautomator 是**单会话**资源: 并发调用、或别的 UiAutomation 在场时, ` +
      `输的那个会被 SIGKILL(不报错、不生成文件)。本服务内已串行化, 所以剩下的冲突来自进程外` +
      ` —— 另一个 screen-mcp 实例(命令行与 web 各起过一个?)、PC 侧 adb 上的 uiautomator、` +
      `或设备上的无障碍/自动化 App。`,
    at: Date.now(),
  };
}

// ── payload 体积控制（第三轮 B4）───────────────────────────
//
// 背景：设备侧 import 了 truncateField / boundArray 但**全文 0 处调用**，
// 于是 screen_tree 一次返回 49,932 字符（实测真机），其中：
//   · `screen` 里嵌了一个 `all`（重复整份屏列表）—— 已随 displayState 修掉
//   · 每个节点的 text/desc/resourceId 无界输出（content-desc 平台侧没有长度上限）
//   · 356 个节点全给，其中 118 个既没文字又不能点，是纯噪声
//
// 这里做三件事：字符串有界、数组有界并报出省略量、给出默认摘要。
// 注意**不隐藏事实**：省略了多少、跳过了多少，都明确写在返回里。

/**
 * 节点文本字段的截断预算。
 * `content-desc` 在平台侧**没有长度上限** —— 一个聊天界面的 desc 可能上万字符，
 * 所以保头 + 保尾（尾部的 URL 查询参数、订单号才是关键标识）。
 */
const NODE_FIELD = { headChars: 300, tailChars: 160 };

/** 把一行节点/目标压成紧凑文本（省掉 JSON 的引号和重复键名） */
function compactLine(o) {  const label = truncateField(o.label || o.text || o.desc || '', { headChars: 60, tailChars: 20 });
  const c = o.center || (o.bounds ? { x: o.bounds.cx, y: o.bounds.cy } : null);
  const pos = c && Number.isFinite(c.x) && Number.isFinite(c.y) ? `${c.x},${c.y}` : '?';
  const flags = [
    o.clickable ? 'C' : '',          // clickable
    o.longClickable ? 'L' : '',      // long-clickable
    o.scrollable ? 'S' : '',         // scrollable
    o.checkable ? 'K' : '',          // checkable
    o.enabled === false ? 'D' : '',  // disabled
  ].filter(Boolean).join('') || '-';
  const id = o.resourceId ? truncateField(o.resourceId, { headChars: 60, tailChars: 10 }) : '';
  return `  ${String(label || '(无标签)').padEnd(44)} ${pos.padStart(11)}  ${flags.padEnd(4)} ${id}`;
}

/** 摘要模式：一行一个节点，带省略量说明。比 JSON 小一个数量级。 */
function compactSummary(header, rows, { headLimit, tailLimit }) {
  const b = boundArray(rows, { headLimit, tailLimit });
  const lines = b.items.map(compactLine);
  if (b.omitted > 0) lines.push(`  ... [省略 ${b.omitted} 项] ...`);
  return `${header}\n${lines.join('\n')}`;
}

// ── 无障碍树解析（统一在 lib/uitree.mjs）─────────────────
//
// 为什么不再内联一份（PR #11 第三轮 B3）:
// 之前本文件自带了 decodeEntities / parseBounds / parseUiXml / labelOf /
// toTargets / usefulness 一整套，与 lib/uitree.mjs 约 200 行平行实现，
// 而两边的**判据已经分叉** —— 同一个"可滚动但无文字的列表页":
//   库 isUsefulTree  -> useful = true
//   内联 usefulness  -> useful = false（它额外要求 labelled > 0）
// 于是 82 项测试全在测**没被使用**的那份（库），而模型真正用的是内联这份。
// 现在统一用库版本：它语义更丰富（viaAncestor 带 resourceId/bounds/label、
// 以及 clickTarget 指出的"真正该点的框"），而且有测试覆盖。

/** 把 isUsefulTree 的产出适配成本文件原 usefulness 的字段名（reason 语义一致） */
function usefulness(parsed) {
  const u = isUsefulTree(parsed);
  return {
    useful: u.useful,
    totalNodes: u.totalNodes,
    labelledCount: u.labelledCount,
    actionableCount: u.actionableCount,
    reason: u.reason,
  };
}

// ── 目标去重（库中没有，保留在此）──────────────────────────
// 依赖 toTargets 产出的 center —— 那是去重契约，见 lib/uitree.mjs 的注释。

function dedupe(targets) {
  const kept = [];
  for (const t of targets) {
    if (!t.center) { kept.push(t); continue; }
    const dup = kept.find((k) => {
      if (!k.center) return false;
      const dx = Math.abs(k.center.x - t.center.x);
      const dy = Math.abs(k.center.y - t.center.y);
      const sk = Math.min(k.bounds?.width || 0, k.bounds?.height || 0);
      const st = Math.min(t.bounds?.width || 0, t.bounds?.height || 0);
      const tol = Math.max(8, Math.min(sk, st) * 0.5);
      return dx <= tol && dy <= tol;
    });
    if (!dup) { kept.push(t); continue; }
    const score = (x) => (x.clickable === true ? 4 : 0) + Math.min(3, (x.label || '').length / 8);
    if (score(t) > score(dup)) kept[kept.indexOf(dup)] = t;
  }
  return kept;
}


// ── 工具定义 ──────────────────────────────────────────────

/**
 * 每个工具描述都会追加这段（R-5 / R-4）。
 *
 * 起因是真机实测：模型有 root + bash + node，工具一旦不好用，它会**自己造轮子** ——
 *   · 轮 7-8：screen_targets 返回 `Error: [object Object]`，它改用
 *     `uiautomator dump` + awk 自己解析，产出了坐标清单（还发现了 11 个零尺寸伪目标）
 *   · 轮 9：screen_image 的图被 harness 拒收，它**自己写了两个 Node 脚本**，
 *     用 zlib.inflateSync 解 PNG + 逐行反滤波，数出了颜色直方图
 *   · 轮 4：全程没用我们的工具，直接用 `dumpsys activity`
 *
 * 危险之处在于**结果通常是对的** —— 从用户视角看不出工具挂了，
 * 而代价是慢（轮 9 花了 29 秒写脚本）和不可靠（轮 8 它自己承认"第一次坐标全错"）。
 * 所以这里明确要求：工具报错就把原始错误报出来，别默默绕过。
 */
const HONESTY_NOTE =
  '\n\n⚠ **若本工具返回错误，请把原始错误原文报给用户并停止**，不要自己用 bash / ' +
  '`uiautomator dump` / `screencap` 等命令重新实现一遍同样的功能。' +
  '原因：你绕过工具产出正确结果时，用户完全看不出工具已经坏了 —— ' +
  '而这类绕过更慢、更容易出错（实测有一次自己解析 XML 时下标写错，坐标全错）。' +
  '把错误暴露出来，问题才能被修掉。';

const TOOLS = [
  {
    name: 'list_displays',
    description:
      '列出设备上的所有屏：逻辑 displayId、SurfaceFlinger id、尺寸、DPI、刷新率与**屏状态**（ON/OFF/DOZE）。\n\n' +
      '先用这个确定要观察哪块屏，再把它作为 displayId 传给其他工具。\n' +
      '带 isFirst 的那块是默认屏（主屏）。',
    inputSchema: {
      type: 'object',
      properties: {
        detail: {
          type: 'boolean',
          description:
            '是否附带面板能力细节：HDR 类型 / 峰值亮度 / 色彩模式 / 亮度范围 / 物理像素 / ' +
            '安装朝向。默认 false（只有 displayId / 尺寸 / 密度 / 刷新率 / 状态 / sfId）。' +
            '需要这些细节时传 true，不必自己去跑 dumpsys display。',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'screen_tree',
    description:
      '读取当前屏幕的**无障碍树**：每个控件的精确文字、resource-id、类名、像素坐标，' +
      '并标注它是否可点击、以及"可点祖先"（真正的点击目标常常是父容器而非文字节点）。\n\n' +
      '适用：常规 App 界面。返回结构化数据，适合按名字/id 精确定位目标。\n' +
      '不适用：游戏或引擎自绘界面（会返回"没用的树"，此时改用 screen_image）。\n\n' +
      '**只能读默认屏（displayId 0）**。这是平台限制：`uiautomator dump` 会静默忽略 ' +
      '`--display` 参数（传不存在的 id 也照样成功并输出主屏的树），所以非默认屏的树 ' +
      '需要 App 内的 AccessibilityService 才能拿到。传非 0 的 displayId 会明确报错，' +
      '而不是悄悄返回主屏的树。\n\n' +
      '结果带 displayState：若屏幕是熄灭的，读到的是过期内容，不可信。',
    inputSchema: {
      type: 'object',
      properties: {
        // M4（同上）：实现读 `args?.displayId`，schema 必须声明它。
        displayId: {
          oneOf: [{ type: 'number' }, { type: 'string' }],
          description: '逻辑 displayId。省略则用默认屏(0)。非 0 会明确报错（平台限制，见工具描述）。',
        },
        includeDisabled: { type: 'boolean', description: '是否包含 enabled=false 的控件，默认 false' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'screen_targets',
    description:
      '当前屏幕上**所有可点击目标的清单**：每个目标的文字标签、中心坐标、可点区域、' +
      '资源 id 与类名。已合并指向同一位置的重叠节点。\n\n' +
      '这是要给"点击某处"用的最短路径 —— 直接取 center 坐标即可。\n' +
      '与 screen_tree 一样只能读默认屏（displayId 0）。\n' +
      '结果带 displayState 与 usefulness：树不可用时该字段会说明原因，此时改用 screen_image。',
    inputSchema: {
      type: 'object',
      properties: {
        // M4: 实现读 `args?.displayId`，但 schema 里原来没有它，且声明
        // additionalProperties:false —— 任何做参数校验的客户端都会被拒。
        // （test-screen-mcp 的 #6 是绕过 schema 直接发 JSON-RPC 才测到 tree-needs-app 的，
        //  也就是说那条断言覆盖了一条**合规客户端走不到**的路径。）
        displayId: {
          oneOf: [{ type: 'number' }, { type: 'string' }],
          description: '逻辑 displayId。省略则用默认屏(0)。',
        },
        includeDisabled: { type: 'boolean', description: '是否包含不可用控件，默认 false' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'screen_image',
    description:
      '截取指定屏幕并**直接返回图片**，由你的视觉能力去读。\n\n' +
      '适用：自绘界面、游戏、图标上的文字、需要理解布局与语义的场合；' +
      '也是无障碍树"没用的树"时的兜底。\n\n' +
      '**两条内部路线，按 displayId 自动选：**\n' +
      '  · 默认屏 / 物理屏 → 系统 `screencap`（走 SurfaceFlinger id），返回 **PNG**\n' +
      '  · 虚拟副屏（displayId 非 0）→ 进程内 ImageReader，返回 **JPEG**\n\n' +
      '⚠ 为什么虚拟副屏不能走 screencap：实测 `screencap -d <副屏逻辑id>` 会报\n' +
      '`Failed to take screenshot. Display Id \'N\' is not valid.` —— 系统截图抓不到\n' +
      '虚拟屏。副屏的帧只能由 screen_vd_start 起的那个守护进程在进程内取。\n\n' +
      '⚠ 传非 0 的 displayId 时，它必须是**本实例启动的那块副屏**；否则明确报错\n' +
      '（不静默改成截主屏 —— 那会让模型拿着主屏的图去点副屏的坐标）。\n\n' +
      '注意返回里的 deviceState 字段：若 displayState 不是 ON，这张图是**最后一帧旧画面**，' +
      '不能反映当前真实界面（熄屏时 screencap 不报错，这是已知的静默失败）。',
    inputSchema: {
      type: 'object',
      properties: {
        // M3: 必须是 string 或 number 二选一，**不能只写 number**。
        // surfaceFlingerId 是 19 位无符号数（例如 4630946964337362323），
        // 按 number 传必然精度丢失（实测 Number() 后往返无损 = false，末几位被抹成 0），
        // 于是字符串比对失配、截断后的 id 被原样交给 screencap -d。
        // 所以主推 string；number 仍然接受（逻辑 displayId 都是小整数）。
        displayId: {
          oneOf: [{ type: 'string' }, { type: 'number' }],
          description:
            '逻辑 displayId（小整数，可用 number）或 SurfaceFlinger id。' +
            '**sfId 是 19 位大整数，必须按字符串传**，否则精度丢失（如 4630946964337362323 ' +
            '变成 4630946964337362000）。省略则用默认屏。',
        },
        maxFrameAgeMs: {
          type: 'number',
          description:
            '允许复用多久以内的帧（毫秒）。0（默认）= 总是重新采集，最保守。' +
            '连续看图时可调大（如 500~2000）省掉 screencap 的编码开销；' +
            '但复用时会如实标注 fromCache 与真实采集时刻，画面可能已变。',
        },
        reason: { type: 'string', description: '调用原因（可选，便于排查）' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'screen_tap',
    description:
      '在指定屏幕坐标处模拟一次**物理点击**（注入触摸事件，等价手指点下去）。\n\n' +
      '坐标从哪来：screen_tree / screen_targets 返回的 center，或 screen_image 里目测。\n' +
      '支持任意屏（displayId 非 0 时走 `input -d <id>`，虚拟副屏实测可用）。\n' +
      '这是动作类工具：它会真的改变设备状态，确认坐标后再调。',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: '像素 X 坐标（屏的逻辑坐标系）' },
        y: { type: 'number', description: '像素 Y 坐标' },
        displayId: {
          oneOf: [{ type: 'number' }, { type: 'string' }],
          description: '逻辑 displayId。省略则用默认屏(0)。',
        },
      },
      required: ['x', 'y'],
      additionalProperties: false,
    },
  },
  {
    name: 'screen_swipe',
    description:
      '从起点坐标**滑动**到终点坐标（可带时长，长按=大 durationMs）。\n\n' +
      '适用：滚动列表、翻页、拖动滑块。支持任意屏。',
    inputSchema: {
      type: 'object',
      properties: {
        x1: { type: 'number', description: '起点 X' },
        y1: { type: 'number', description: '起点 Y' },
        x2: { type: 'number', description: '终点 X' },
        y2: { type: 'number', description: '终点 Y' },
        durationMs: { type: 'number', description: '滑动总时长毫秒。省略用系统默认(~300)。长按/慢拖可传 800~1500' },
        displayId: {
          oneOf: [{ type: 'number' }, { type: 'string' }],
          description: '逻辑 displayId。省略则用默认屏(0)。',
        },
      },
      required: ['x1', 'y1', 'x2', 'y2'],
      additionalProperties: false,
    },
  },
  {
    name: 'screen_key',
    description:
      '发送一个**系统按键**（KEYCODE）。常用：4=返回, 3=主页, 66=回车, 61=Tab, 111=ESC。\n\n' +
      '适用：收起键盘、退出页面、确认输入。支持任意屏。',
    inputSchema: {
      type: 'object',
      properties: {
        keycode: {
          oneOf: [{ type: 'number' }, { type: 'string' }],
          description: 'Android KEYCODE 数字（4=返回, 3=主页, 66=回车）。字符串会转成数字。',
        },
        displayId: {
          oneOf: [{ type: 'number' }, { type: 'string' }],
          description: '逻辑 displayId。省略则用默认屏(0)。',
        },
      },
      required: ['keycode'],
      additionalProperties: false,
    },
  },
  {
    name: 'screen_text',
    description:
      '向**当前聚焦的输入框**注入任意 Unicode 文本（含中文/emoji），支持**替换模式或追加模式**。\n\n' +
      '机制：无障碍 ACTION_SET_TEXT —— 静默写入，不弹软键盘、不经过剪贴板，' +
      '注入后读回校验（返回 before_text / verified_text 供你确认落点）。\n\n' +
      '**先 screen_tap 点击目标输入框取得焦点，再调本工具（不带 text_before 参数）**。\n' +
      'mode: "replace"（默认）清空后写入；"append" 在现有文本后追加（用于不想丢草稿的场景）。\n\n' +
      'displayId: 省略=默认屏。**虚拟副屏上也可以用**（先 screen_vd_start，传它的 displayId），' +
      '但聚焦仍需先用 screen_tap -d <displayId> 点击该屏的输入框。\n' +
      '微信等"只认系统无障碍服务"的 App 由本工具自动挂载并在用完还原（期间屏幕可能出现' +
      '"无障碍"提示，属预期）。写入失败会带 before/after 证据报错，绝不重试到别的控件。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要写入的完整文本（UTF-8，含中文）' },
        mode: {
          type: 'string',
          enum: ['replace', 'append'],
          description: 'replace=替换输入框全部内容（默认）；append=追加到现有内容后（保留草稿）',
        },
        displayId: {
          oneOf: [{ type: 'number' }, { type: 'string' }],
          description: '逻辑 displayId。省略=默认屏(0)。虚拟副屏传 screen_vd_start 返回的 displayId。',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'screen_vd_start',
    description:
      '启动一块**虚拟副屏**（trusted VirtualDisplay，不抢物理屏的前台焦点）。\n\n' +
      '用途：自动化操作在副屏上进行，**不干扰用户正在用的主屏**。副屏上可以启动任意 App、' +
      '读树（screen_tree/displayId）、点击（screen_tap/displayId）、注入文字（screen_text/displayId）、' +
      '截图（screen_vd_shot）。\n\n' +
      '几何参数省略时自动取物理屏的宽高与密度（推荐）；也可以显式指定更小的尺寸（省显存）。\n' +
      '本 MCP 实例同一时间只支持一块副屏；换尺寸先 stop。MCP 服务退出时副屏随之销毁。',
    inputSchema: {
      type: 'object',
      properties: {
        width: { type: 'number', description: '副屏宽（像素）。省略=物理屏宽' },
        height: { type: 'number', description: '副屏高（像素）。省略=物理屏高' },
        dpi: { type: 'number', description: '副屏密度。省略=物理屏密度' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'screen_vd_stop',
    description:
      '**丢弃**虚拟副屏：把它上面的 App 连同当前状态一起清掉，再释放显存。\n\n' +
      '⚠ **副屏上有 App 时本工具默认拒绝执行**（报错说明原因），因为实测：\n' +
      '销毁承载着 App 的副屏，用户**会看到那个 App 在主屏上闪一下**（WM 的跨屏\n' +
      'CLOSE 过渡会把被删 task 的 surface 从副屏尺寸动到主屏尺寸上渲染）。\n' +
      '试过"删栈期间关掉过渡动画"，用户复看**仍然闪**，所以没采用。\n\n' +
      '于是默认行为是：\n' +
      '  · 副屏上有 App → 拒绝，并给出两个正确选择\n' +
      '      要留住状态 → `screen_vd_handoff`（搬回主屏，用户接手）\n' +
      '      确实要丢   → 传 `force: true`（明确接受"会闪一下 + 状态丢失"）\n' +
      '  · 副屏上没有 App（空屏）→ 正常销毁，全程不打扰用户\n\n' +
      '不在跑时幂等返回。\n\n' +
      '**agent 干完活的默认收尾是"什么都不做"**：副屏和 App 都留着，用户前台\n' +
      '一动不动；等用户自己接手（handoff）或明确要求丢弃。',
    inputSchema: {
      type: 'object',
      properties: {
        force: {
          type: 'boolean',
          description: '副屏上有 App 时强制丢弃（调用方明确接受"用户屏幕上会闪一下 + App 状态丢失"）。默认 false',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'screen_vd_handoff',
    description:
      '**交接**：把副屏上的 App 搬回主屏，连它当前的状态一起交给用户接手。\n\n' +
      '典型用法：AI 在副屏把外卖选好、停在支付界面，然后调用本工具 —— **界面原样出现在用户屏幕上**，\n' +
      '用户直接就能付款下单（reparent 不重建 Activity，所以停在原处，不会退回首页）。\n\n' +
      '与 screen_vd_stop 的区别：\n' +
      '  · handoff = 交给用户 → 搬到主屏并置顶（此时接管前台是**期望行为**）\n' +
      '  · stop    = 丢弃     → 清掉副屏内容再释放（全程不碰用户前台）\n\n' +
      '参数 package 省略时，交接副屏上**最顶层**的那个 App。',
    inputSchema: {
      type: 'object',
      properties: {
        package: { type: 'string', description: '要交接的 App 包名。省略=副屏最顶层的 App' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'screen_vd_shot',
    description:
      '截取**虚拟副屏**当前画面（JPEG），由你的视觉能力去读。\n\n' +
      '等价于 `screen_image { displayId: <副屏的 displayId> }` —— 保留它是为了让调用方' +
      '不必记住/回填那个 id（副屏 id 是每次 screen_vd_start 现分配的）。\n' +
      '返回图片 + 副屏几何元数据。这是"虚拟副屏上发生了什么"的直接证据 —— 读树拿不到的' +
      '自绘界面（游戏/WebView 首帧）用这条看。\n\n' +
      '也适合在交接前**确认状态**（比如确认支付界面已就绪再 handoff）。',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'screen_app',
    description:
      '把某个 App 启动到指定的屏上。**它不会碰主屏上已有的实例** —— 这是"自动化不打扰用户"的关键。\n\n' +
      '机制：`am start -f 0x18000000 --display N`（NEW_TASK|MULTIPLE_TASK）。\n' +
      '即使该 App 已在主屏运行（微信这类 singleTask 应用），也会在副屏**新建一个独立 task**，\n' +
      '主屏那份原样不动（实测：全程主屏前台逐字未变）。副屏上跑的是同一账号/同一进程的另一个\n' +
      '任务窗口，不是分身用户。\n\n' +
      '⚠ 反例（都已实测踩过，不要用）：\n' +
      '  · `am start --display N`（不带 MULTIPLE_TASK）→ singleTask 应用会把 intent 交给主屏\n' +
      '    已有实例，**把用户正在看的 App 拉到前台**\n' +
      '  · `cmd activity display move-stack` → "迁移"语义，立刻抢走前台；副屏销毁时还会再抢一次\n\n' +
      '命令后会**复核** task 真的落在目标屏（命令返回 0 但实际没动的情况实测存在）。',
    inputSchema: {
      type: 'object',
      properties: {
        package: { type: 'string', description: 'App 包名，如 com.tencent.mm' },
        activity: { type: 'string', description: '可选：要启动的 Activity 全名。省略则启动 launch activity' },
        displayId: {
          oneOf: [{ type: 'number' }, { type: 'string' }],
          description: '目标逻辑 displayId（副屏用 screen_vd_start 返回的值）。省略=默认屏 0',
        },
        dryRun: { type: 'boolean', description: '只查询不动作：返回该 App 的 task 都在哪些屏。默认 false' },
      },
      required: ['package'],
      additionalProperties: false,
    },
  },
];

/**
 * tools/list 的返回：给每个工具描述追加"错误要如实上报"那一段。
 *
 * 为什么在返回时追加、而不是直接写进 TOOLS 常量里：
 * 4 处描述各贴一遍容易漏、也容易改一处忘三处。集中生成，加新工具自动带上。
 */
function toolsWithHonestyNote() {
  return TOOLS.map((t) => ({ ...t, description: t.description + HONESTY_NOTE }));
}

/**
 * 非默认屏必须是**本实例启动的那块虚拟副屏** —— 否则明确报错。
 *
 * 为什么必须校验(而不是"能读到就给"):
 *   dex 侧的 getWindowsOnAllDisplays 对**不存在的逻辑屏**也返回空树, 于是
 *   `screen_targets {displayId: 2}` 会拿到"0 个目标, 成功" —— 模型据此以为
 *   "那块屏上什么都没有", 是典型的**静默错坐标**。screen_text 一直有这道校验
 *   (打错屏比报错危险得多); screen_tree / screen_targets 在 PR B 里改走 dex
 *   路线后必须同步补上。
 *
 * @returns 出错时返回 {isError:true, text}; 通过时返回 null
 */
function requireOwnVdDisplay(displayId, toolName) {
  const vd = vdGet();
  if (!vd) {
    return {
      isError: true,
      text: `displayId=${displayId} 不是默认屏，而本实例没有运行中的虚拟副屏。` +
        `先 screen_vd_start，再用它返回的 displayId。`,
    };
  }
  if (Number(displayId) !== vd.displayId) {
    return {
      isError: true,
      text: `displayId=${displayId} 与运行中的副屏 (displayId=${vd.displayId}) 不符。` +
        `${toolName} 请传 ${vd.displayId}。`,
    };
  }
  return null;
}

// ── 工具实现 ──────────────────────────────────────────────

async function toolsCall(name, args) {
  switch (name) {
    case 'list_displays': {
      const info = await listDisplays();
      if (info.error) return { isError: true, text: info.error };
      const detail = !!args?.detail;
      const lines = info.displays.map((d) => {
        // logicalId 可能为 null（拿不到 mViewports 映射的机型）—— 如实显示, 别编一个数
        const lid = d.logicalId === null || d.logicalId === undefined ? '?' : d.logicalId;
        const parts = [
          `displayId ${lid}${d.isFirst ? ' (主屏)' : ''}`,
          d.name || '(无名)',
          `${d.width}x${d.height} @${d.density}dpi`,
          d.renderFrameRate ? `${d.renderFrameRate}fps` : null,
          `状态=${d.state ?? '未知'}`,
          `sfId=${d.surfaceFlingerId}`,
          d.type ? `type=${d.type}` : null,
        ].filter(Boolean);
        let out = '  ' + parts.join('  ');
        if (detail) {
          // R-6：面板能力字段一次给全，省得模型自己跑 dumpsys display 挖 20KB。
          const extra = [];
          if (d.realWidth && (d.realWidth !== d.width || d.realHeight !== d.height)) {
            extra.push(`物理=${d.realWidth}x${d.realHeight}`);
          }
          if (d.hdrCapabilities?.supportedTypes?.length) {
            extra.push(`HDR类型=[${d.hdrCapabilities.supportedTypes.join(',')}]` +
              (d.hdrCapabilities.maxLuminance ? ` 峰值亮度=${d.hdrCapabilities.maxLuminance}nits` : ''));
          }
          if (d.supportedColorModes) extra.push(`色彩模式=[${d.supportedColorModes.join(',')}] 当前=${d.colorMode}`);
          if (d.brightness?.maximum !== null && d.brightness?.maximum !== undefined) {
            extra.push(`亮度范围=${d.brightness.minimum}~${d.brightness.maximum}`);
          }
          if (d.refreshRateOverride) extra.push(`刷新率覆盖=${d.refreshRateOverride}`);
          if (d.installOrientation) extra.push(`安装朝向=${d.installOrientation}`);
          if (d.canHostTasks === false) extra.push('不可承载任务');
          if (d.layerStack !== null && d.layerStack !== undefined) extra.push(`layerStack=${d.layerStack}`);
          if (extra.length) out += '\n      ' + extra.join('  ');
        }
        return out;
      }).join('\n');
      const warn = info.displays.some((d) => d.logicalId === null || d.logicalId === undefined)
        ? '\n⚠ 本机未提供 mViewports 映射，logicalId 显示为 ? —— 用 sfId 指定屏（screen_image 接受）'
        : '';
      const hint = detail ? '' : '\n（要面板能力细节——HDR 类型 / 亮度 / 色彩模式 / 物理尺寸——传 detail:true）';
      return {
        text: `唤醒状态: ${info.wakefulness ?? '未知'}\n共 ${info.displays.length} 块屏:\n${lines}${warn}${hint}\n\n` +
          JSON.stringify(info, null, 2),
      };
    }

    case 'screen_tree': {
      const logical = args?.displayId ?? 0;

      // 副屏分支: uiautomator dump 只认主屏(--display 被平台静默忽略, 见
      // uiTreeDump 的注释)。非默认屏走 dex 的 getWindowsOnAllDisplays。
      if (Number(logical) !== 0) {
        const bad = requireOwnVdDisplay(logical, 'screen_tree');
        if (bad) return bad;
        const r = await fetchTree(Number(logical));
        if (!r.ok) {
          return { isError: true, text: `副屏(${logical})无障碍树读取失败: ${r.error}${r.reason ? `\n${r.reason}` : ''}` };
        }
        const nodes = (r.nodes || []).map((n) => ({
          text: n.text, desc: n.desc, resourceId: n.resourceId, className: n.className,
          bounds: n.bounds, clickable: n.clickable, editable: n.editable,
          focused: n.focused, enabled: n.enabled, depth: n.depth,
        }));
        const labelled = nodes.filter((n) => n.text || n.desc || n.resourceId);
        const head = `副屏(${logical})无障碍树: ${r.node_count} 节点, ${labelled.length} 有文字` +
          `（采集于 ${new Date().toISOString()}，走 dex getWindowsOnAllDisplays）`;
        const summary = compactSummary(head, labelled, { headLimit: 120, tailLimit: 30 });
        const bounded = boundArray(nodes, { headLimit: 200, tailLimit: 50 });
        const payload = {
          displayId: r.displayId, capturedAt: Date.now(), costMs: r.cost_ms,
          nodeCount: r.node_count, nodes: bounded.items, nodesOmitted: bounded.omitted,
          source: 'vd-a11y-dex',
        };
        return { text: summary + '\n\n' + JSON.stringify(payload, null, 2) };
      }

      const disp = await displayState(logical);
      const dump = await uiTreeDump(logical);
      if (!dump.ok) return { isError: true, text: `无障碍树读取失败: ${dump.error}\n${dump.detail || ''}` };
      const parsed = parseUiXml(dump.xml);
      const u = usefulness(parsed);
      // 采集时刻：uiautomator dump 实测约 2 秒，而 MCP 是长驻进程 ——
      // 没有这个字段，模型会把几十秒前取到的树当作当前界面（第三轮 B4 的另一半）。
      const capturedAt = dump.at ?? Date.now();
      const labelled = parsed.nodes.filter((n) => labelOf(n)).map((n) => ({
        text: n.text, desc: n.desc, resourceId: n.resourceId, className: n.className,
        package: n.package, bounds: n.bounds, clickable: n.clickable,
        enabled: n.enabled, depth: n.depth,
      }));

      const head =
        `无障碍树: ${parsed.nodes.length} 节点, ${u.labelledCount} 有文字, ${u.actionableCount} 可操作` +
        (u.useful ? ' —— 可用' : ` —— 不可用: ${u.reason}`) + '\n' +
        `采集时刻: ${new Date(capturedAt).toISOString()}（uiautomator dump 耗时约 2 秒，这是取树那一刻）\n`;

      // 默认摘要：一行一个带标签的节点。JSON 只给有标签节点、且字段有界。
      const summary = compactSummary(
        head + `带标签节点 ${labelled.length} 个：`,
        labelled, { headLimit: 120, tailLimit: 30 },
      );

      // 结构化输出：字段一律 head+tail 截断（content-desc 平台侧无长度上限）
      const boundedLabelled = labelled.map((n) => ({
        text: truncateField(n.text, NODE_FIELD),
        desc: truncateField(n.desc, NODE_FIELD),
        resourceId: truncateField(n.resourceId, NODE_FIELD),
        className: n.className,
        package: n.package,
        bounds: n.bounds,
        clickable: n.clickable,
        enabled: n.enabled,
        depth: n.depth,
      }));
      const boundedNodes = boundArray(boundedLabelled, { headLimit: 200, tailLimit: 50 });
      const payload = {
        displayState: disp.state, wakefulness: disp.wakefulness, screen: disp,
        capturedAt, rotation: parsed.rotation, nodeCount: parsed.nodes.length,
        usefulness: u, labelledTotal: labelled.length,
        labelledNodes: boundedNodes.items,
        labelledOmitted: boundedNodes.omitted,
      };

      const stateWarn = disp.state !== 'ON'
        ? `⚠ 屏幕状态是 ${disp.state}，读到的内容可能已过期。\n`
        : (disp.missing ? `⚠ 屏列表里没有 logicalId=${logical}（实际有 ${disp.availableLogicalIds.join(', ')}），屏状态未知。\n` : '');

      return { text: stateWarn + summary + '\n\n' + JSON.stringify(payload, null, 2) };
    }

    case 'screen_targets': {
      const logical = args?.displayId ?? 0;

      // 副屏分支: 与 screen_tree 同源(见那边的注释)。
      // uiautomator dump 只作用于主屏(--display 被平台静默忽略), 非默认屏必须走
      // dex 的 getWindowsOnAllDisplays。此前这里没有这个分支, 副屏上会直接报
      // tree-needs-app —— 目标里"解除非默认屏限制"包含本工具。
      if (Number(logical) !== 0) {
        const bad = requireOwnVdDisplay(logical, 'screen_targets');
        if (bad) return bad;
        const r = await fetchTree(Number(logical));
        if (!r.ok) {
          return { isError: true, text: `副屏(${logical})无障碍树读取失败: ${r.error}${r.reason ? `\n${r.reason}` : ''}` };
        }
        const all = r.nodes || [];
        const interactable = all.filter((n) => (n.clickable || n.editable) &&
          (args?.includeDisabled || n.enabled !== false));
        const targets = interactable.map((n) => {
          const b = n.bounds || { x1: 0, y1: 0, x2: 0, y2: 0 };
          return {
            label: n.text || n.desc || n.resourceId || '',
            text: n.text || '', desc: n.desc || '', resourceId: n.resourceId || '',
            className: n.className || '', package: '',
            bounds: b,
            center: { x: Math.round((b.x1 + b.x2) / 2), y: Math.round((b.y1 + b.y2) / 2) },
            clickable: !!n.clickable, longClickable: false, scrollable: false,
            editable: !!n.editable, enabled: n.enabled !== false,
            confidence: 'high',
          };
        });
        const editableCount = all.filter((n) => n.editable).length;
        const head = `副屏(${logical})可点目标 ${targets.length} 个` +
          `（共 ${all.length} 节点, 其中可输入 ${editableCount} 个）` +
          `（采集于 ${new Date().toISOString()}，走 dex getWindowsOnAllDisplays）`;
        const summary = compactSummary(head, targets, { headLimit: 80, tailLimit: 20 });
        const bounded = boundArray(targets, { headLimit: 200, tailLimit: 50 });
        return {
          text: summary + '\n\n' + JSON.stringify({
            displayId: r.displayId, capturedAt: Date.now(), costMs: r.cost_ms,
            nodeCount: r.node_count, editableCount,
            targets: bounded.items, targetsOmitted: bounded.omitted,
            source: 'vd-a11y-dex',
          }, null, 2),
        };
      }

      const disp = await displayState(logical);
      const dump = await uiTreeDump(logical);
      if (!dump.ok) return { isError: true, text: `无障碍树读取失败: ${dump.error}\n${dump.detail || ''}` };
      const parsed = parseUiXml(dump.xml);
      const u = usefulness(parsed);
      const targets = dedupe(toTargets(parsed, { includeDisabled: !!args?.includeDisabled }));
      // 同 screen_tree：这棵树是什么时候取的。没有它会静默误导。
      const capturedAt = dump.at ?? Date.now();

      let text = '';
      if (disp.state !== 'ON') {
        text += disp.missing
          ? `⚠ 屏列表里没有 logicalId=${logical}（实际有 ${disp.availableLogicalIds.join(', ')}），` +
            `屏状态未知，坐标是否对应当前界面无法判断。\n`
          : `⚠ 屏幕状态是 ${disp.state}，坐标可能对应已过期的界面。\n`;
      }
      if (!u.useful) text += `⚠ 无障碍树不可用: ${u.reason}。改用 screen_image 看图。\n`;

      const head = text +
        `可点击目标 ${targets.length} 个（采集于 ${new Date(capturedAt).toISOString()}）：`;
      // 默认摘要：一行一个目标（坐标 + 标志位 + 资源 id）。比 JSON 小一个数量级。
      const summary = compactSummary(head, targets, { headLimit: 80, tailLimit: 20 });

      // 结构化输出：字段有界 + 数组有界，并报出省略量
      const boundedTargets = targets.map((t) => ({
        label: truncateField(t.label, NODE_FIELD),
        text: truncateField(t.text, NODE_FIELD),
        desc: truncateField(t.desc, NODE_FIELD),
        resourceId: truncateField(t.resourceId, NODE_FIELD),
        className: t.className,
        package: t.package,
        bounds: t.bounds,
        center: t.center,
        clickable: t.clickable,
        longClickable: t.longClickable,
        scrollable: t.scrollable,
        enabled: t.enabled,
        confidence: t.confidence,
        clickTarget: t.clickTarget,
      }));
      const bt = boundArray(boundedTargets, { headLimit: 150, tailLimit: 40 });
      const payload = {
        displayState: disp.state, wakefulness: disp.wakefulness, screen: disp,
        capturedAt, usefulness: u,
        targetCount: targets.length,
        targets: bt.items,
        targetsOmitted: bt.omitted,
      };
      return { text: summary + '\n\n' + JSON.stringify(payload, null, 2) };
    }

    case 'screen_image': {
      const requested0 = args?.displayId;
      // 副屏分支: 系统 screencap **抓不到虚拟屏** —— 实测
      //   screencap -d <副屏逻辑id>  → "Failed to take screenshot. Display Id 'N' is not valid."
      // 副屏画面只能来自 VdMain 进程内的 ImageReader。契约: displayId 非 0 时必须是
      // 本实例启动的那块副屏, 否则明确报错(不静默截主屏 —— 那是"静默错坐标")。
      // 注意输出格式: 这条路是 JPEG(ImageReader → Bitmap.compress),
      // 系统 screencap 那条是 PNG。
      if (requested0 !== undefined && requested0 !== null && Number(requested0) !== 0) {
        const bad = requireOwnVdDisplay(requested0, 'screen_image');
        if (bad) return bad;
        try {
          const { jpeg, displayId, costMs, width, height, fromCache, frameTimestamp } = await vdShot();
          // 对齐主屏分支的可观测性(排查报告 §4.3): 副屏分支原先这些字段一个都没有。
          // 副屏帧是现取的、没有缓存, 所以 fromCache 恒为 false —— 如实报出来。
          const ageMs = Date.now() - (frameTimestamp ?? Date.now());
          let disp = null;
          try { disp = await displayState(displayId); } catch { /* 拿不到就不报状态 */ }
          return {
            text: `屏幕: displayId=${displayId}（虚拟副屏）\n` +
              `状态: ${disp?.state ?? '未知'}\n` +
              `分辨率: ${width}x${height}   大小: ${(jpeg.length / 1024).toFixed(0)} KB\n` +
              `采集: ${fromCache ? `来自缓存(${ageMs} ms 前)` : '刚采集(进程内 ImageReader)'}` +
              `，耗时 ${costMs} ms\n` +
              `格式: JPEG —— 副屏走进程内 ImageReader, 系统 screencap 抓不到虚拟屏。\n` +
              (disp && disp.state !== 'ON'
                ? `⚠ displayState 不是 ON：这张图可能不代表当前界面。\n`
                : '') +
              `\n⚠ 颜色已修（曾因 RGBA/ARGB 通道错位导致红变蓝、暗部发紫）。` +
              `若怀疑复发：往副屏投纯红 (255,0,0) 采一次，采到 (0,0,254) 即为复发。`,
            image: { data: jpeg.toString('base64'), mimeType: 'image/jpeg' },
          };
        } catch (e) {
          return { isError: true, text: `副屏截图失败: ${e.message}` };
        }
      }
      // 支持逻辑 displayId 或 SurfaceFlinger id: 先按逻辑 id 查表, 查不到就当 sfId 直接用
      let sfId = null;
      let logical = null;
      const requested = args?.displayId;
      if (requested !== undefined && requested !== null) {
        const info = await listDisplays();
        const byLogical = info.displays.find((d) => d.logicalId === Number(requested));
        if (byLogical) { sfId = byLogical.surfaceFlingerId; logical = byLogical.logicalId; }
        else {
          const bySf = info.displays.find((d) => String(d.surfaceFlingerId) === String(requested));
          if (bySf) { sfId = bySf.surfaceFlingerId; logical = bySf.logicalId; }
          else sfId = String(requested); // 交给平台判断
        }
      }
      const disp = await displayState(logical ?? 0);
      // maxFrameAgeMs: 0 = 每次重新采集(默认, 最保守)。
      // 模型连续几步反复看图时, 调大它可省掉 screencap 的 PNG 编码开销。
      const maxAgeMs = Math.max(0, Number(args?.maxFrameAgeMs ?? DEFAULT_MAX_FRAME_AGE_MS) || 0);
      const shot = await screencap(sfId, {
        maxAgeMs,
        // 缓存键必须含逻辑屏与 sfId: 不同屏坐标系不同, 混用会静默错坐标
        cacheKey: `display:${logical ?? 'default'}:sf:${sfId ?? 'default'}`,
      });
      if (!shot.isPng) return { isError: true, text: '截图数据损坏(PNG 头校验失败)' };

      const ageMs = Date.now() - shot.frameTimestamp;
      const meta =
        `屏幕: displayId=${logical ?? '默认'}  sfId=${shot.sfId ?? '默认'}  "${disp.name || ''}"\n` +
        `状态: ${disp.state}  (唤醒: ${disp.wakefulness})\n` +
        `分辨率: ${shot.width}x${shot.height}   大小: ${(shot.bytes / 1024).toFixed(0)} KB\n` +
        `采集: ${shot.fromCache ? `来自缓存, 该帧采集于 ${ageMs} ms 前` : `刚采集, 耗时 ${shot.captureMs} ms`}\n` +
        (disp.state !== 'ON'
          ? `⚠ displayState 不是 ON：这张图是最后一帧旧画面，不代表当前界面。\n`
          : '') +
        (shot.fromCache && ageMs > 1000
          ? `⚠ 该帧已 ${ageMs} ms 未更新。画面可能已变，需要最新状态请传 maxFrameAgeMs:0 重新采集。\n`
          : '');
      return {
        text: meta,
        image: { data: shot.buf.toString('base64'), mimeType: 'image/png' },
        // 结构化元数据, 便于调用方程序化判断(不必解析上面的文本)
        frame: {
          fromCache: !!shot.fromCache,
          frameTimestamp: shot.frameTimestamp,
          ageMs,
          captureMs: shot.captureMs,
          displayId: logical ?? null,
          surfaceFlingerId: shot.sfId ?? null,
          width: shot.width,
          height: shot.height,
          displayState: disp.state,
        },
      };
    }

    case 'screen_tap':
    case 'screen_swipe':
    case 'screen_key': {
      const kind = name === 'screen_tap' ? 'tap' : name === 'screen_swipe' ? 'swipe' : 'key';
      const displayId = args?.displayId !== undefined && args?.displayId !== null
        ? Number(args.displayId)
        : 0;
      if (!Number.isFinite(displayId)) return { isError: true, text: `displayId 不是数字: ${args?.displayId}` };
      try {
        let r;
        if (kind === 'tap') {
          const x = Number(args?.x), y = Number(args?.y);
          if (!Number.isFinite(x) || !Number.isFinite(y)) return { isError: true, text: 'x/y 必须是数字' };
          r = await physicalInput('tap', { x, y, displayId });
        } else if (kind === 'swipe') {
          const x1 = Number(args?.x1), y1 = Number(args?.y1), x2 = Number(args?.x2), y2 = Number(args?.y2);
          if (![x1, y1, x2, y2].every(Number.isFinite)) return { isError: true, text: 'x1/y1/x2/y2 必须是数字' };
          r = await physicalInput('swipe', {
            x1, y1, x2, y2, displayId,
            durationMs: args?.durationMs !== undefined ? Number(args.durationMs) : undefined,
          });
        } else {
          const kc = Number(args?.keycode);
          if (!Number.isFinite(kc)) return { isError: true, text: `keycode 不是数字: ${args?.keycode}` };
          r = await physicalInput('key', { keycode: kc, displayId });
        }
        return { text: `${kind} 已发送: ${JSON.stringify(r.args)} (${r.cost_ms} ms, displayId=${displayId})` };
      } catch (e) {
        return { isError: true, text: `input 动作失败: ${e.message}${e.detail ? `\n${e.detail}` : ''}` };
      }
    }

    case 'screen_text': {
      const displayId = args?.displayId !== undefined && args?.displayId !== null ? Number(args.displayId) : 0;
      if (!Number.isFinite(displayId)) return { isError: true, text: `displayId 不是数字: ${args?.displayId}` };
      if (displayId !== 0) {
        // 副屏注入: 必须是**本实例启动的那块** —— 随便填一个 displayId 会把
        // 文字打到别人/系统的屏上, 与"静默错坐标"同罪。
        const vd = vdGet();
        if (!vd) {
          return {
            isError: true,
            text: `displayId=${displayId} 不是默认屏, 而本实例没有运行中的虚拟副屏。` +
              `先 screen_vd_start, 再用返回的 displayId。`,
          };
        }
        if (displayId !== vd.displayId) {
          return {
            isError: true,
            text: `displayId=${displayId} 与运行中的副屏 (displayId=${vd.displayId}) 不符。` +
              `副屏动作请传 ${vd.displayId}。`,
          };
        }
      }
      const text = args?.text;
      if (typeof text !== 'string') return { isError: true, text: 'text 必须是字符串' };
      const mode = args?.mode === 'append' ? 'append' : 'replace';
      const r = await injectText(displayId, text, { mode });
      if (!r.ok) {
        // 业务失败(如 no_focused_input): 带证据报错, 模型能据此决定先点一下再试。
        return { isError: true, text: `screen_text 失败: ${r.error}${r.reason ? `\n${r.reason}` : ''}` +
          (r.focus_hint ? `\nfocus_hint: ${r.focus_hint}` : '') };
      }
      const lines = [
        `已写入${mode === 'append' ? '(追加)' : ''}: displayId=${r.display} mode=${r.mode} 耗时=${r.cost_ms}ms`,
        r.vid ? `控件: ${r.vid} (${r.type || '?'}) @ [${r.bounds || '?'}]` : null,
        `before: ${JSON.stringify(r.before_text ?? null)}`,
        `verified: ${JSON.stringify(r.verified_text ?? null)}`,
      ].filter(Boolean);
      // verify_unavailable / verify_mismatch 如实带出 —— 不悄悄当成功
      if (r.error) lines.push(`⚠ ${r.error}: ${r.reason || ''}`);
      return { text: lines.join('\n') + '\n\n' + JSON.stringify(r, null, 2) };
    }

    case 'screen_vd_start': {
      const width = args?.width != null ? Number(args.width) : null;
      const height = args?.height != null ? Number(args.height) : null;
      const dpi = args?.dpi != null ? Number(args.dpi) : null;
      for (const [k, v] of [['width', width], ['height', height], ['dpi', dpi]]) {
        if (v !== null && !Number.isFinite(v)) return { isError: true, text: `${k} 不是数字: ${v}` };
      }
      try {
        const r = await vdStart(width, height, dpi);
        const lines = r.already
          ? `副屏已在运行 (幂等返回): displayId=${r.displayId}, ${r.width}x${r.height}@${r.dpi}`
          : `副屏已启动: displayId=${r.displayId}, ${r.width}x${r.height}@${r.dpi}`;
        return {
          text: `${lines}\n\n接下来:\n` +
            `  · 把 App 放到副屏: screen_app { package, displayId: ${r.displayId} }\n` +
            `    （即使该 App 已在主屏运行, 也会在副屏新建一个独立 task, 主屏那份不动）\n` +
            `  · 读/点/输入副屏: screen_tree、screen_targets、screen_tap、screen_text 传 displayId=${r.displayId}\n` +
            `  · 看副屏画面: screen_image { displayId: ${r.displayId} } 或 screen_vd_shot\n` +
            `  · 让用户接手: screen_vd_handoff（搬回主屏, 状态不丢）\n\n` +
            `**干完活的默认收尾是"什么都不做"** —— 副屏和 App 都留着, 用户前台一动不动。\n` +
            `只有内容确实不要了才 screen_vd_stop（副屏上有 App 时它默认拒绝, 因为实测会闪）。\n\n` +
            `⚠ 跨屏承载依赖 LSPosed hook 生效; 没有 hook 时 screen_app 会明确报错(不会假装成功)。`,
        };
      } catch (e) {
        return { isError: true, text: `副屏启动失败: ${e.message}` };
      }
    }

    case 'screen_vd_stop': {
      try {
        const before = vdGet();
        const r = await vdStop({ force: !!args?.force });
        if (!r.stopped) {
          if (r.reason === 'occupied') {
            // 默认拒绝销毁有 App 的副屏 —— 这是实测结论(会闪一下), 不是保守。
            return { isError: true, text: r.detail };
          }
          return { text: '没有运行中的副屏（幂等）' };
        }
        const cleared = (r.clearedStacks || []).filter((s) => s.ok).length;
        return {
          text: `副屏已丢弃并释放 (displayId=${r.displayId ?? '?'})\n` +
            `已清掉副屏上的 ${cleared} 个栈 —— 副屏内容不再存在。\n` +
            (r.forced
              ? `⚠ 本次是 force 丢弃：副屏上原有的 App 连状态一起没了，且**用户屏幕上可能闪过一下那个 App**（实测存在）。\n`
              : `用户主屏前台未受影响。\n`) +
            (cleared === 0 && before
              ? '（副屏上本来就没有 App；若有 App 请检查 am stack remove 是否生效）'
              : ''),
        };
      } catch (e) {
        return { isError: true, text: `副屏停止失败: ${e.message}` };
      }
    }

    case 'screen_vd_handoff': {
      const vd = vdGet();
      if (!vd) return { isError: true, text: '副屏未运行。先 screen_vd_start。' };
      let pkg = args?.package;
      if (typeof pkg !== 'string' || !pkg.trim()) {
        try {
          pkg = await topPackageOnDisplay(vd.displayId);
        } catch { pkg = null; }
        if (!pkg) {
          return {
            isError: true,
            text: `副屏(displayId=${vd.displayId}) 上没有可交接的 App —— 先 screen_app 启动一个。`,
          };
        }
      } else {
        pkg = pkg.trim();
      }
      try {
        const r = await vdHandoff(pkg);
        if (!r.ok) {
          return {
            isError: true,
            text: `交接失败 (${r.error}): ${r.detail || r.output || ''}`,
          };
        }
        return {
          text: `已交接: ${pkg} 从副屏(displayId=${r.from}) 搬到主屏 display 0（task #${r.taskId}）\n` +
            `App 状态原样保留（reparent 不重建 Activity）—— 用户现在可以在自己屏幕上直接继续操作。\n` +
            `副屏仍在运行；如果不再需要，用 screen_vd_stop 丢弃。`,
        };
      } catch (e) {
        return { isError: true, text: `交接失败: ${e.message}` };
      }
    }

    case 'screen_vd_shot': {
      if (!vdGet()) {
        return { isError: true, text: '副屏未运行。先 screen_vd_start。' };
      }
      try {
        const { jpeg, displayId, costMs, width, height } = await vdShot();
        return {
          text: `副屏截图: displayId=${displayId}  ${width}x${height}  ${(jpeg.length / 1024).toFixed(0)} KB  (${costMs} ms)`,
          image: { data: jpeg.toString('base64'), mimeType: 'image/jpeg' },
        };
      } catch (e) {
        return { isError: true, text: `副屏截图失败: ${e.message}` };
      }
    }

    case 'screen_app': {
      const pkg = args?.package;
      if (typeof pkg !== 'string' || !pkg.trim()) return { isError: true, text: 'package 必须是非空字符串' };
      const displayId = args?.displayId !== undefined && args?.displayId !== null ? Number(args.displayId) : 0;
      if (!Number.isFinite(displayId)) return { isError: true, text: `displayId 不是数字: ${args?.displayId}` };

      if (args?.dryRun) {
        try {
          const tasks = await findTasks(pkg.trim());
          if (!tasks.length) return { text: `${pkg} 当前没有运行中的 task。` };
          return {
            text: `${pkg} 的 task:\n` + tasks.map((t) =>
              `  task #${t.taskId}  display=${t.displayId}${t.isRoot ? ' (root)' : ''}${t.visible ? ' 可见' : ''}`,
            ).join('\n'),
          };
        } catch (e) {
          return { isError: true, text: `查询 task 失败: ${e.message}` };
        }
      }

      // 目标屏合法性: 非 0 必须是本实例的副屏(与 screen_text 同一条纪律)
      if (displayId !== 0) {
        const vd = vdGet();
        if (!vd) {
          return {
            isError: true,
            text: `displayId=${displayId} 不是默认屏, 而本实例没有运行中的虚拟副屏。先 screen_vd_start。`,
          };
        }
        if (displayId !== vd.displayId) {
          return {
            isError: true,
            text: `displayId=${displayId} 与运行中的副屏 (displayId=${vd.displayId}) 不符。`,
          };
        }
      }

      try {
        const r = await launchOnDisplay(displayId, pkg.trim(), args?.activity || null);
        if (!r.ok) {
          return {
            isError: true,
            text: `${pkg} 移到 display ${displayId} 失败 (${r.method}): ${r.error}\n` +
              (r.detail ? `${r.detail}\n` : '') +
              (r.output ? `原始输出: ${r.output}\n` : '') +
              (r.error === 'move-stack-failed' || r.error === 'am-start-failed'
                ? '\n提示: 跨屏承载需要 LSPosed hook 生效(见模块说明)。缺 hook 时 WM 会拒绝把 task 放到虚拟屏。'
                : ''),
          };
        }
        const how = r.method === 'move-stack' ? `已用 move-stack 搬运 task #${r.taskId}（保留 App 状态）`
          : r.method === 'already-there' ? `已经在 display ${displayId}（task #${r.taskId}）`
          : '已冷启动到目标屏';
        return { text: `${pkg} → display ${displayId}\n${how}\n${r.output || ''}`.trim() };
      } catch (e) {
        return { isError: true, text: `screen_app 失败: ${e.message}` };
      }
    }

    default:
      throw new Error('未知工具: ' + name);
  }
}

// ── JSON-RPC / MCP 主循环 ─────────────────────────────────

function toolResultToMcp(r) {
  if (r.isError) return { content: [{ type: 'text', text: r.text }], isError: true };
  const content = [{ type: 'text', text: r.text }];
  if (r.image) content.push({ type: 'image', data: r.image.data, mimeType: r.image.mimeType });
  const out = { content };
  // MCP 的 structuredContent 让调用方能程序化拿新鲜度元数据, 而不必解析文本
  if (r.frame) out.structuredContent = { frame: r.frame };
  return out;
}

/**
 * 把任意抛出物描述成可读文本（R-3）。
 *
 * 背景：真机上一轮 `screen_targets` 返回过 `Error: [object Object]`（22 字符，无堆栈），
 * 而当前代码里**没有任何一处**会生成那个字符串 —— 说明抛出的是一个**非 Error 对象**
 * （`e.message` 为 undefined，于是走了 `String(e)`）。
 *
 * 那条路径是间歇性的（同一台设备，轮 7 挂、后面几次都正常），我没有能稳定复现的输入。
 * 所以这里**不盲改逻辑**，而是两件事：
 *   1. 把抛出物的真实形状（类型 / 自有键 / message / stack 前几行）打到 stderr，
 *      下次它再犯时能一次定死根因；
 *   2. 让返回给模型的文本不再退化成 `[object Object]` —— 至少说明"抛了个非 Error 对象"
 *      并带上可用的字段，比一个无法诊断的占位符强。
 */
function describeThrown(e, toolName) {
  let detail;
  try {
    const kind = Object.prototype.toString.call(e);           // [object Object] / [object Error]
    const ctor = e && e.constructor ? e.constructor.name : typeof e;
    let keys = [];
    try { keys = e && typeof e === 'object' ? Object.keys(e) : []; } catch { /* ignore */ }
    let json = '';
    try { json = JSON.stringify(e); } catch { json = '(JSON.stringify 失败)'; }
    const stack = e && e.stack ? String(e.stack).split('\n').slice(0, 4).join(' | ') : '(无 stack)';
    const msg = e && e.message !== undefined ? String(e.message) : '(无 message 字段)';
    detail = `类型=${kind} 构造器=${ctor} message=${msg} 自有键=[${keys.join(',')}] ` +
      `JSON=${String(json).slice(0, 300)} stack=${stack}`;
    // 关键：完整打到 stderr，供事后从 dsh.log 定位
    log(`!! ${toolName} 抛出非标准错误 —— ${detail}`);
  } catch (inner) {
    detail = `(连描述都失败了: ${String(inner)})`;
  }
  const human = e instanceof Error
    ? e.message
    : `工具抛出了一个非 Error 对象（${Object.prototype.toString.call(e)}），` +
      `没有 message 字段。诊断信息已写入服务日志（stderr）。`;
  return { human, detail };
}

async function handle(msg) {
  const { id, method, params } = msg;

  // 通知(无 id)不需要回复
  if (id === undefined || id === null) {
    if (method === 'notifications/initialized') log('客户端已初始化');
    return;
  }

  try {
    switch (method) {
      case 'initialize': {
        const asked = params?.protocolVersion;
        const chosen = PROTOCOL_VERSIONS.includes(asked) ? asked : LATEST;
        log(`initialize: 客户端请求 ${asked} -> 使用 ${chosen}`);
        rpcOut({ jsonrpc: '2.0', id, result: {
          protocolVersion: chosen,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
        } });
        return;
      }
      case 'ping':
        rpcOut({ jsonrpc: '2.0', id, result: {} });
        return;
      case 'tools/list':
        rpcOut({ jsonrpc: '2.0', id, result: { tools: toolsWithHonestyNote() } });
        return;
      case 'tools/call': {
        const name = params?.name;
        const args = params?.arguments || {};
        log(`tools/call ${name}`);
        try {
          const r = await toolsCall(name, args);
          rpcOut({ jsonrpc: '2.0', id, result: toolResultToMcp(r) });
        } catch (e) {
          // R-3：不再退化成 "Error: [object Object]"。
          // 非 Error 抛出物会被完整描述并写进日志（见 describeThrown）。
          const { human, detail } = describeThrown(e, name);
          rpcOut({ jsonrpc: '2.0', id, result: {
            content: [{ type: 'text', text: `工具执行失败: ${human}` }],
            // 把机械诊断一并给出（模型能读，也便于用户直接贴回来）
            structuredContent: { toolError: { tool: name, summary: detail } },
            isError: true,
          } });
        }
        return;
      }
      case 'resources/list':
        rpcOut({ jsonrpc: '2.0', id, result: { resources: [] } });
        return;
      case 'prompts/list':
        rpcOut({ jsonrpc: '2.0', id, result: { prompts: [] } });
        return;
      default:
        rpcOut({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } });
    }
  } catch (e) {
    rpcOut({ jsonrpc: '2.0', id, error: { code: -32603, message: String(e.message || e) } });
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); }
    catch { log('忽略无法解析的行: ' + line.slice(0, 120)); continue; }
    handle(msg).catch((e) => log('handle 异常: ' + e.message));
  }
});
process.stdin.on('end', () => { log('stdin 关闭, 退出'); process.exit(0); });

log(`已就绪 (协议 ${LATEST}, ${TOOLS.length} 个工具, node ${process.version})`);
