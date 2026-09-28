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
  let dumpsysDisplay = '';
  let surfaceFlinger = '';
  let power = '';

  try {
    dumpsysDisplay = (await run('/system/bin/dumpsys', ['display'])).stdout;
  } catch (e) {
    out.error = 'dumpsys display 失败: ' + e.message;
    return out;
  }
  // 这两段拿不到不致命: sfId 可从 uniqueId 前缀推导, 唤醒状态可为 null
  try {
    surfaceFlinger = (await run('/system/bin/dumpsys', ['SurfaceFlinger', '--display-id'])).stdout;
  } catch { /* 忽略 */ }
  try {
    power = (await run('/system/bin/dumpsys', ['power'])).stdout;
  } catch { /* 忽略 */ }

  const parsed = parseDisplays({ dumpsysDisplay, surfaceFlinger, power });
  out.displays = parsed.displays;
  out.wakefulness = parsed.wakefulness;
  out.defaultSurfaceFlingerId = parsed.defaultSurfaceFlingerId;
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
  const d = info.displays.find((x) => x.logicalId === logicalId) || info.displays[0] || null;
  return { ...(d || { logicalId, state: null }), wakefulness: info.wakefulness, all: info.displays };
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
  const remote = path.join(TMP, `sm-${process.pid}-${Date.now().toString(36)}.xml`);
  try {
    await run('/system/bin/uiautomator', ['dump', remote], { timeout: 25000 });
    if (!fs.existsSync(remote)) return { ok: false, error: 'dump-file-missing' };
    const xml = fs.readFileSync(remote, 'utf8');
    if (!xml.includes('<hierarchy')) return { ok: false, error: 'no-hierarchy', raw: xml.slice(0, 300) };
    return { ok: true, xml };
  } catch (e) {
    return { ok: false, error: 'dump-failed', detail: e.message };
  } finally {
    try { fs.unlinkSync(remote); } catch { /* 清理失败不致命 */ }
  }
}

// ── 无障碍树解析 ──────────────────────────────────────────

function decodeEntities(s) {
  if (!s || s.indexOf('&') === -1) return s;
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&');
}

function parseBounds(s) {
  if (!s) return null;
  const m = s.match(/\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);
  if (!m) return null;
  const [x1, y1, x2, y2] = m.slice(1).map(Number);
  return { left: x1, top: y1, right: x2, bottom: y2, width: x2 - x1, height: y2 - y1,
    cx: Math.round((x1 + x2) / 2), cy: Math.round((y1 + y2) / 2) };
}

const BOOL_ATTRS = ['checkable', 'checked', 'clickable', 'enabled', 'focusable',
  'focused', 'scrollable', 'long-clickable', 'password', 'selected'];

function parseUiXml(xml) {
  const bodyMatch = xml.match(/<hierarchy\b[^>]*>([\s\S]*)<\/hierarchy>/);
  const body = bodyMatch ? bodyMatch[1] : xml;
  const rot = xml.match(/<hierarchy[^>]*\brotation="(-?\d+)"/);

  const nodes = [];
  const stack = [];
  const tagRe = /<(\/?)(node|hierarchy)\b([^>]*?)(\/?)>/g;
  let m;
  while ((m = tagRe.exec(body)) !== null) {
    const [, closing, tag, attrStr, selfClose] = m;
    if (tag !== 'node') continue;
    if (closing) { if (stack.length) stack.pop(); continue; }

    const attrs = {};
    const attrRe = /([\w-]+)="([^"]*)"/g;
    let a;
    while ((a = attrRe.exec(attrStr)) !== null) attrs[a[1]] = decodeEntities(a[2]);

    const parent = stack.length ? stack[stack.length - 1] : null;
    if (parent) parent.childCount += 1;

    const ancestorIndices = parent ? parent.clickableAncestors.slice() : [];
    if (parent && parent.node.clickable === true) ancestorIndices.push(parent.nodeIndex);

    const node = {
      index: nodes.length,
      depth: stack.length,
      text: attrs.text || '',
      desc: attrs['content-desc'] || '',
      resourceId: attrs['resource-id'] || '',
      className: attrs.class || '',
      package: attrs.package || '',
      bounds: parseBounds(attrs.bounds),
      childCount: 0,
      childrenIndices: [],
      clickableAncestorIndices: ancestorIndices,
    };
    for (const b of BOOL_ATTRS) {
      node[b.replace(/-(\w)/g, (_, c) => c.toUpperCase())] = attrs[b] === 'true';
    }
    nodes.push(node);
    if (parent) parent.node.childrenIndices.push(node.index);

    if (m[4] !== '/') stack.push({ node, nodeIndex: node.index, childCount: 0, clickableAncestors: ancestorIndices });
  }
  return { rotation: rot ? Number(rot[1]) : null, nodes };
}

const labelOf = (n) => (n.text || '').trim() || (n.desc || '').trim() || '';

/**
 * 可操作目标清单。
 * 关键: 真正的点击目标常常是父节点。TextView 自己 clickable=false,
 * 但父 FrameLayout clickable=true。只收 clickable=true 会漏掉大量目标。
 */
function toTargets(parsed, { includeDisabled = false } = {}) {
  const out = [];
  for (const n of parsed.nodes) {
    const ancIdx = n.clickableAncestorIndices;
    const ancestor = ancIdx.length ? parsed.nodes[ancIdx[ancIdx.length - 1]] : null;
    const selfActionable = n.clickable || n.longClickable;
    const viaAncestor = !selfActionable && !!(ancestor && ancestor.clickable);
    if (!selfActionable && !viaAncestor) continue;
    if (!includeDisabled && n.enabled === false) continue;

    const targetNode = selfActionable ? n : ancestor;
    out.push({
      label: labelOf(n) || (ancestor ? labelOf(ancestor) : ''),
      text: n.text,
      desc: n.desc,
      resourceId: n.resourceId,
      className: n.className,
      package: n.package,
      bounds: n.bounds,
      center: n.bounds ? { x: n.bounds.cx, y: n.bounds.cy } : null,
      clickable: n.clickable,
      longClickable: n.longClickable,
      scrollable: n.scrollable,
      checkable: n.checkable,
      checked: n.checked,
      enabled: n.enabled,
      clickTarget: targetNode === n ? null : {
        center: targetNode.bounds ? { x: targetNode.bounds.cx, y: targetNode.bounds.cy } : null,
        className: targetNode.className,
        resourceId: targetNode.resourceId,
        label: labelOf(targetNode),
      },
      confidence: labelOf(n) ? 0.95 : 0.6,
    });
  }
  return out;
}

/** 合并同一目标的重叠条目(父容器+图标+文字通常三层指向同一处) */
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

/**
 * 树"有没有值得动手的节点"。
 * 引擎自绘界面不是空树, 而是只有一个全屏 SurfaceView 的"没用的树"。
 */
function usefulness(parsed) {
  const labelled = parsed.nodes.filter((n) => labelOf(n));
  const actionable = parsed.nodes.filter((n) =>
    n.clickable || n.longClickable || n.scrollable || n.checkable);
  return {
    useful: actionable.length > 0 && labelled.length > 0,
    totalNodes: parsed.nodes.length,
    labelledCount: labelled.length,
    actionableCount: actionable.length,
    reason: (actionable.length > 0 && labelled.length > 0) ? null
      : parsed.nodes.length <= 2
        ? `只有 ${parsed.nodes.length} 个节点, 疑似自绘界面或抓取失败`
        : `${parsed.nodes.length} 个节点但缺可操作项或有标签项, 疑似自绘界面`,
  };
}

// ── 工具定义 ──────────────────────────────────────────────

const TOOLS = [
  {
    name: 'list_displays',
    description:
      '列出设备上的所有屏：逻辑 displayId、SurfaceFlinger id、尺寸、DPI、刷新率与**屏状态**（ON/OFF/DOZE）。\n\n' +
      '先用这个确定要观察哪块屏，再把它作为 displayId 传给其他工具。\n' +
      '带 isFirst 的那块是默认屏（主屏）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
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
        displayId: { type: 'number', description: '逻辑 displayId 或 SurfaceFlinger id，省略则用默认屏' },
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

// ── 工具实现 ──────────────────────────────────────────────

async function toolsCall(name, args) {
  switch (name) {
    case 'list_displays': {
      const info = await listDisplays();
      if (info.error) return { isError: true, text: info.error };
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
        return '  ' + parts.join('  ');
      }).join('\n');
      const warn = info.displays.some((d) => d.logicalId === null || d.logicalId === undefined)
        ? '\n⚠ 本机未提供 mViewports 映射，logicalId 显示为 ? —— 用 sfId 指定屏（screen_image 接受）'
        : '';
      return {
        text: `唤醒状态: ${info.wakefulness ?? '未知'}\n共 ${info.displays.length} 块屏:\n${lines}${warn}\n\n` +
          JSON.stringify(info, null, 2),
      };
    }

    case 'screen_tree': {
      const disp = await displayState(args?.displayId ?? 0);
      const dump = await uiTreeDump(args?.displayId ?? 0);
      if (!dump.ok) return { isError: true, text: `无障碍树读取失败: ${dump.error}\n${dump.detail || ''}` };
      const parsed = parseUiXml(dump.xml);
      const u = usefulness(parsed);
      const labelled = parsed.nodes.filter((n) => labelOf(n)).map((n) => ({
        text: n.text, desc: n.desc, resourceId: n.resourceId, className: n.className,
        package: n.package, bounds: n.bounds, clickable: n.clickable,
        enabled: n.enabled, depth: n.depth,
      }));
      const payload = {
        displayState: disp.state, wakefulness: disp.wakefulness, screen: disp,
        rotation: parsed.rotation, nodeCount: parsed.nodes.length,
        usefulness: u, labelledNodes: labelled,
      };
      return {
        text: (disp.state !== 'ON'
          ? `⚠ 屏幕状态是 ${disp.state}，read 到的内容可能已过期。\n`
          : '') +
          `无障碍树: ${parsed.nodes.length} 节点, ${u.labelledCount} 有文字, ${u.actionableCount} 可操作` +
          (u.useful ? ' —— 可用\n' : ` —— 不可用: ${u.reason}\n`) +
          JSON.stringify(payload, null, 2),
      };
    }

    case 'screen_targets': {
      const disp = await displayState(args?.displayId ?? 0);
      const dump = await uiTreeDump(args?.displayId ?? 0);
      if (!dump.ok) return { isError: true, text: `无障碍树读取失败: ${dump.error}\n${dump.detail || ''}` };
      const parsed = parseUiXml(dump.xml);
      const u = usefulness(parsed);
      const targets = dedupe(toTargets(parsed, { includeDisabled: !!args?.includeDisabled }));
      const payload = {
        displayState: disp.state, wakefulness: disp.wakefulness, screen: disp,
        usefulness: u, targetCount: targets.length, targets,
      };
      let text = '';
      if (disp.state !== 'ON') text += `⚠ 屏幕状态是 ${disp.state}，坐标可能对应已过期的界面。\n`;
      if (!u.useful) text += `⚠ 无障碍树不可用: ${u.reason}。改用 screen_image 看图。\n`;
      text += `可点击目标 ${targets.length} 个:\n` + JSON.stringify(payload, null, 2);
      return { text };
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
        rpcOut({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
        return;
      case 'tools/call': {
        const name = params?.name;
        const args = params?.arguments || {};
        log(`tools/call ${name}`);
        try {
          const r = await toolsCall(name, args);
          rpcOut({ jsonrpc: '2.0', id, result: toolResultToMcp(r) });
        } catch (e) {
          rpcOut({ jsonrpc: '2.0', id, result: {
            content: [{ type: 'text', text: '工具执行失败: ' + (e.message || String(e)) }],
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
