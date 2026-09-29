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
      '**这个工具支持任意屏**（包括虚拟副屏），因为 screencap 走的是 SurfaceFlinger id。' +
      '省略 displayId 时截默认屏。虚拟副屏用 list_displays 查到它的 surfaceFlingerId ' +
      '或逻辑 displayId 后传进来即可。\n\n' +
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
