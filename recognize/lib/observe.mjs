// observe -- 识别引擎核心
//
// 两条识别路线:
//   1. 无障碍树 (uiautomator dump)  -> 精确文字 / 资源 id / 坐标 / 可点祖先
//   2. 屏幕图片 (screencap) + OCR   -> 自绘界面 / 加固应用 / 图上的文字
//
// 两条路互补, 所以要合并输出并标注每个目标"来自哪条路、可信度多少"。
//
// 硬性设计约束(逐条对应一个已确认的失败模式, 见 docs/android-agent-harness-plan.md §5.2):
//   · 熄屏是静默失败: screencap 交最后一帧, 注入触摸唤不醒屏, 两个都不报错
//     -> 所有观察结果必须带 displayState
//   · 引擎自绘界面不是空树而是"没用的树" -> 判据是"有无值得动手的节点"
//   · 不缓存帧而不标注新鲜度 -> 复用缓存时如实报出该帧真实的采集时刻
//   · 无界字段会静默截断关键信息 -> 长字段一律 head+tail 截断并报出省略量

import fs from 'node:fs';
import path from 'node:path';
import { Device, DEVICE_TMP, pcTmpDir, shQuote } from './device.mjs';
import { parseUiXml, isUsefulTree, toTargets, labelOf } from './uitree.mjs';
import { FrameCache, truncateField, boundArray, boundValue } from './fields.mjs';

export { FrameCache, truncateField, boundArray, boundValue };

// ── 屏状态 ────────────────────────────────────────────────
// 运行时发现, 不硬编码。解析 dumpsys display 里 DisplayDeviceInfo 的 state。
export async function getDisplays(device) {
  const out = await device.shell('dumpsys display');
  const displays = [];

  // 每个 "Display N [id=...,stack=...]" 段落里带 state=ON/OFF/DOZE
  const sectionRe = /Display (\d+) \[id=([^,\]]+),stack=(-?\d+)\][\s\S]*?(?=\n\s*Display \d+ \[id=|$)/g;
  let m;
  while ((m = sectionRe.exec(out)) !== null) {
    const [, logicalId, surfaceId, stack] = m;
    const seg = m[0];
    const stateMatch = seg.match(/\bstate=([A-Z_]+)/);
    const isFirst = /isFirst=true/.test(seg);
    const sizeMatch = seg.match(/(\d+) x (\d+), modeId/);
    const densityMatch = seg.match(/\bdensity (\d+)/);
    const fpsMatch = seg.match(/renderFrameRate ([\d.]+)/);
    displays.push({
      logicalId: Number(logicalId),
      surfaceFlingerId: surfaceId,          // 无符号 64 位, 保持字符串
      stack: Number(stack),
      isFirst,
      state: stateMatch ? stateMatch[1] : null,  // ON / OFF / DOZE / DOZE_SUSPEND
      width: sizeMatch ? Number(sizeMatch[1]) : null,
      height: sizeMatch ? Number(sizeMatch[2]) : null,
      density: densityMatch ? Number(densityMatch[1]) : null,
      renderFrameRate: fpsMatch ? Number(fpsMatch[1]) : null,
    });
  }

  // 唤醒状态作为佐证(两条来源不一致时是重要信号)
  let wakefulness = null;
  try {
    const p = await device.shell('dumpsys power');
    const wm = p.match(/mWakefulness=(\w+)/);
    if (wm) wakefulness = wm[1];
  } catch { /* 拿不到不致命 */ }

  // wm size / density 给的是逻辑尺寸(可能被 override)
  let wmSize = null, wmDensity = null, wmOverride = null;
  try {
    const wsz = await device.shell('wm size');
    const om = wsz.match(/Override size:\s*(\d+)x(\d+)/);
    const pm = wsz.match(/Physical size:\s*(\d+)x(\d+)/);
    wmOverride = om ? { width: Number(om[1]), height: Number(om[2]) } : null;
    wmSize = pm ? { width: Number(pm[1]), height: Number(pm[2]) } : null;
  } catch { }
  try {
    const wd = await device.shell('wm density');
    const od = wd.match(/Override density:\s*(\d+)/);
    const pd = wd.match(/Physical density:\s*(\d+)/);
    wmDensity = { physical: pd ? Number(pd[1]) : null, override: od ? Number(od[1]) : null };
  } catch { }

  return { displays, wakefulness, wmSize, wmOverride, wmDensity };
}

// ── 截屏 ──────────────────────────────────────────────────
// 注意: 绝不能用 PowerShell 的 > 重定向取二进制(会当文本处理, 破坏数据)。
// 这里走 exec-out + Buffer, 是唯一可靠的方式。
//
// displayFlingerId: screencap 的 -d 收的是 SurfaceFlinger id(不是逻辑 displayId),
// 省略则截默认屏。平台事实见 README「设备侧平台事实」。
export async function screenshot(device, {
  savePath, surfaceFlingerId, cache = null, cacheKey = null, maxAgeMs = 0,
} = {}) {
  const capture = async () => {
    const t0 = Date.now();
    const args = [];
    if (surfaceFlingerId !== undefined && surfaceFlingerId !== null) args.push('-d', String(surfaceFlingerId));
    args.push('-p');
    const buf = await device.execOut(['screencap', ...args]);
    const elapsed = Date.now() - t0;

    // PNG 头校验 —— 不做这一步就会把损坏数据当图片用
    const isPng = buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
    let width = null, height = null;
    if (isPng && buf.length > 24) {
      width = buf.readUInt32BE(16);
      height = buf.readUInt32BE(20);
    }

    const file = savePath || path.join(pcTmpDir(), `screen-${Date.now()}.png`);
    fs.writeFileSync(file, buf);

    return {
      file,
      buf,
      bytes: buf.length,
      width, height,
      isPng,
      captureMs: elapsed,
      surfaceFlingerId: surfaceFlingerId ?? null,
    };
  };

  // 走缓存时由 FrameCache 决定复用还是重新采集
  const shot = cache
    ? await cache.get(cacheKey ?? String(surfaceFlingerId ?? 'default'), capture, { maxAgeMs })
    : { ...(await capture()), fromCache: false, cacheAgeMs: 0, frameTimestamp: Date.now() };

  // 复用缓存时文件可能是上一轮写的; 内容没变, 路径仍有效
  return {
    file: shot.file,
    bytes: shot.bytes,
    width: shot.width,
    height: shot.height,
    isPng: shot.isPng,
    captureMs: shot.captureMs,
    frameTimestamp: shot.frameTimestamp,   // 这一帧**真实**的采集时刻(复用时不等于 now)
    fromCache: shot.fromCache,
    cacheAgeMs: shot.cacheAgeMs,
    surfaceFlingerId: shot.surfaceFlingerId ?? null,
  };
}

// ── 无障碍树 ──────────────────────────────────────────────
// uiautomator dump 只能写文件(实测不支持 stdout, /dev/tty、/proc/self/fd/1、
// '-'、/dev/stdout 四种都拿不到内容)。所以: 写 /data/local/tmp -> cat 读回
// -> 立即 rm。全程 2 秒左右, 不在用户存储留任何痕迹。
export async function uiTree(device, { asRoot = false, keepFile = false, rawCap = 3000 } = {}) {
  const remote = device.deviceTempPath('ui');
  const t0 = Date.now();
  try {
    await device.shell(`uiautomator dump ${shQuote(remote)}`, { asRoot });
    const xml = await device.shell(`cat ${shQuote(remote)}`, { asRoot });
    const elapsed = Date.now() - t0;

    if (!xml || !xml.includes('<hierarchy')) {
      return {
        ok: false,
        error: 'dump-no-xml',
        // head+tail: dump 的报错常在尾部, 只保头会丢掉原因
        raw: xml ? truncateField(xml, { headChars: rawCap, tailChars: 400 }) : null,
        elapsedMs: elapsed,
      };
    }

    const parsed = parseUiXml(xml);
    const usefulness = isUsefulTree(parsed);
    return {
      ok: true,
      xml,
      xmlBytes: Buffer.byteLength(xml, 'utf8'),
      rotation: parsed.rotation,
      nodes: parsed.nodes,
      targets: toTargets(parsed),
      nodeCount: parsed.nodes.length,
      usefulness,
      elapsedMs: elapsed,
    };
  } finally {
    if (!keepFile) {
      await device.removeDeviceFile(remote);
    }
  }
}

// ── OCR(图像识别) ─────────────────────────────────────────
export async function ocrImage(pngPath, { lang = 'zh-Hans-CN', scriptPath } = {}) {
  const script = scriptPath || path.join(import.meta.dirname, 'ocr-windows.ps1');
  if (!fs.existsSync(script)) {
    return { ok: false, error: 'ocr-script-missing', script };
  }
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);

  const t0 = Date.now();
  try {
    const { stdout } = await run('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', script, '-ImagePath', pngPath, '-Lang', lang, '-Json',
    ], { maxBuffer: 64 * 1024 * 1024, encoding: 'utf8', windowsHide: true });
    const json = JSON.parse(stdout.trim());
    return {
      ok: true,
      engine: json.engine,
      width: json.width,
      height: json.height,
      lines: json.lines || [],
      words: json.words || [],
      elapsedMs: Date.now() - t0,
    };
  } catch (e) {
    // OCR 的报错尾部常含真正的原因, 只保头会丢掉
    return { ok: false, error: 'ocr-failed',
      detail: truncateField(String(e.stderr || e.message), { headChars: 400, tailChars: 300 }) };
  }
}

// ── 合并两条路线 ──────────────────────────────────────────
/**
 * 把无障碍目标与 OCR 文字行合并成一份"可操作目标清单"。
 *
 * 合并规则(不是简单的拼接, 每条都对应一个实际问题):
 *   · 树里有标签的节点 -> 主力输出, source=tree
 *   · 树里没有、但 OCR 命中的文字 -> 补上, source=image
 *   · 两边都命中同一位置 -> 标注 source=both, 提高可信度
 */
export function mergeObservations({ targets, ocrLines, ocrWords }) {
  const merged = [];

  for (const t of targets) {
    const b = t.bounds;
    const label = (t.label || '').trim();
    const entry = {
      source: 'tree',
      // label/text/desc 全部来自无障碍字段, 无长度上限 -> 逐字段截断
      label: truncateField(label, NODE_FIELD),
      text: truncateField(t.text, NODE_FIELD),
      desc: truncateField(t.desc, NODE_FIELD),
      resourceId: truncateField(t.resourceId, NODE_FIELD),
      className: t.className,
      package: t.package,
      bounds: b,
      center: b ? { x: b.cx, y: b.cy } : null,
      clickable: t.clickable,
      longClickable: t.longClickable,
      scrollable: t.scrollable,
      viaAncestor: t.viaAncestor ? {
        ...t.viaAncestor,
        label: truncateField(t.viaAncestor.label, NODE_FIELD),
        resourceId: truncateField(t.viaAncestor.resourceId, NODE_FIELD),
      } : null,
      confidence: label ? 0.95 : 0.6,   // 有文字标签的显然更可信
    };
    merged.push(entry);
  }

  // OCR: 取行级(比词级更接近"界面上的文字块")
  for (const line of (ocrLines || [])) {
    const text = (line.text || '').trim();
    if (!text) continue;
    const box = { left: line.x, top: line.y, right: line.x + line.w, bottom: line.y + line.h,
      width: line.w, height: line.h, cx: Math.round(line.x + line.w / 2), cy: Math.round(line.y + line.h / 2) };

    // 是否与某个树节点文字重合 -> 提升该节点可信度, 不再重复输出
    const hit = merged.find((e) => e.bounds && overlapRatio(e.bounds, box) > 0.5 &&
      (e.label && (e.label.includes(text) || text.includes(e.label))));
    if (hit) {
      hit.source = 'both';
      hit.confidence = Math.min(0.99, hit.confidence + 0.04);
      continue;
    }

    merged.push({
      source: 'image',
      label: text,
      text,
      desc: '',
      resourceId: '',
      className: '',
      package: '',
      bounds: box,
      center: { x: box.cx, y: box.cy },
      clickable: null,          // 图像识别不知道能不能点
      longClickable: null,
      scrollable: null,
      viaAncestor: null,
      confidence: 0.7,          // 图像识别的文字可能有误读(图标小字)
    });
  }

  return merged;
}

function overlapRatio(a, b) {
  const ix = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
  const iy = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  const inter = ix * iy;
  if (inter <= 0) return 0;
  const areaA = Math.max(1, a.width * a.height);
  const areaB = Math.max(1, b.width * b.height);
  return inter / Math.min(areaA, areaB);
}

// ── 总入口 ────────────────────────────────────────────────
/** 无障碍节点摘要里, 单个字段的上限。content-desc 无长度上限, 必须截。 */
const NODE_FIELD = { headChars: 300, tailChars: 160 };
/** 摘要里最多列多少个带标签节点。 */
const LABELLED_LIMIT = { headLimit: 200, tailLimit: 50 };

/**
 * 一次完整的识别观察。
 *
 * 返回带新鲜度标注的结果 —— 调用方据此判断"能不能信"。
 *
 * 缓存是**显式**的:
 *   · frameCache 传入才启用; 不传就是每次重新采集
 *   · maxFrameAgeMs > 0 才允许复用
 *   · 复用时会带 fromCache=true 与 cacheAgeMs, 且 frameTimestamp 是该帧
 *     **真实**的采集时刻 —— 不是"现在"。这一点是硬要求: 缓存帧伪装成新帧
 *     比读到旧帧本身更危险。
 */
export async function observe(device, {
  displayId = 0,
  wantImage = true,
  wantOcr = true,
  wantTree = true,
  asRoot = false,
  ocrLang = 'zh-Hans-CN',
  frameCache = null,
  maxFrameAgeMs = 0,
} = {}) {
  const t0 = Date.now();
  const errors = [];

  // 1. 屏状态: 必须在最前面拿, 因为它是"结果可不可信"的前提
  const disp = await getDisplays(device).catch((e) => {
    errors.push({ stage: 'displays', error: String(e.message || e) });
    return null;
  });
  const display = disp?.displays.find((d) => d.logicalId === displayId) || disp?.displays[0] || null;
  const screenOn = display ? display.state === 'ON' : null;

  // 熄屏预警: screencap 会给最后一帧旧画面, 而且不报错
  const warnings = [];
  if (screenOn === false) {
    warnings.push(
      `displayState=${display.state}: 熄屏时 screencap 返回的是最后一帧旧画面且不报错, ` +
      `注入的触摸也唤不醒屏。此时截图内容不可信。`
    );
  }

  const result = {
    schema: 'recognize/observe@1',
    at: new Date().toISOString(),
    displayId,
    displayState: display ? display.state : null,
    wakefulness: disp?.wakefulness ?? null,
    display,
    displays: disp?.displays || [],
    wmSize: disp?.wmSize || null,
    wmOverride: disp?.wmOverride || null,
    wmDensity: disp?.wmDensity || null,
    warnings,
    errors,
    tree: null,
    image: null,
    targets: [],
    freshness: {
      observedAt: Date.now(),
      screenOn,
      // 帧时间戳分别标注: 树和图的采集时刻不同, 不能混为一个
      treeCapturedAt: null,
      imageCapturedAt: null,
      // 这一帧是不是复用来的; 复用时 cacheAgeMs 说明它有多旧
      imageFromCache: false,
      imageCacheAgeMs: 0,
    },
  };

  // 2. 无障碍树
  if (wantTree) {
    try {
      const t = await uiTree(device, { asRoot });
      result.freshness.treeCapturedAt = Date.now();
      if (t.ok) {
        // content-desc 之类字段无长度上限, 必须逐字段截断并报出省略量
        const labelledAll = t.nodes.filter((n) => labelOf(n)).map((n) => ({
          text: truncateField(n.text, NODE_FIELD),
          desc: truncateField(n.desc, NODE_FIELD),
          resourceId: truncateField(n.resourceId, NODE_FIELD),
          className: n.className,
          bounds: n.bounds,
          clickable: n.clickable,
          depth: n.depth,
        }));
        const labelled = boundArray(labelledAll, LABELLED_LIMIT);

        result.tree = {
          ok: true,
          rotation: t.rotation,
          nodeCount: t.nodeCount,
          xmlBytes: t.xmlBytes,
          usefulness: t.usefulness,
          elapsedMs: t.elapsedMs,
          // 节点太多时不塞进结果, 只给标签节点摘要
          labelled: labelled.items,
          labelledTotal: labelledAll.length,
          labelledOmitted: labelled.omitted,
        };
        result._treeTargets = t.targets;
        if (!t.usefulness.useful) {
          warnings.push(
            `无障碍树不可用: ${t.usefulness.reason}。` +
            `此时图像识别是唯一的信息来源。`
          );
        }
      } else {
        result.tree = { ok: false, error: t.error, raw: t.raw, elapsedMs: t.elapsedMs };
        errors.push({ stage: 'uitree', error: t.error });
      }
    } catch (e) {
      errors.push({ stage: 'uitree', error: String(e.message || e) });
    }
  }

  // 3. 屏幕图片 + OCR
  if (wantImage) {
    try {
      // 截图要按 surfaceFlingerId 定向; 缓存键也必须含它, 否则主屏和副屏会串味
      const sfId = display?.surfaceFlingerId ?? null;
      const shot = await screenshot(device, {
        surfaceFlingerId: sfId,
        cache: frameCache,
        cacheKey: `display:${displayId}:sf:${sfId ?? 'default'}`,
        maxAgeMs: maxFrameAgeMs,
      });
      result.freshness.imageCapturedAt = shot.frameTimestamp;
      result.freshness.imageFromCache = shot.fromCache;
      result.freshness.imageCacheAgeMs = shot.cacheAgeMs;
      result.image = {
        file: shot.file,
        bytes: shot.bytes,
        width: shot.width,
        height: shot.height,
        isPng: shot.isPng,
        captureMs: shot.captureMs,
        surfaceFlingerId: shot.surfaceFlingerId,
        fromCache: shot.fromCache,
        cacheAgeMs: shot.cacheAgeMs,
        frameTimestamp: shot.frameTimestamp,
      };
      if (!shot.isPng) {
        errors.push({ stage: 'screenshot', error: 'PNG 头校验失败, 数据可能损坏' });
        result.image = null;
      } else if (!screenOn) {
        // 尺寸虽对但内容是旧帧
        warnings.push('该截图对应的屏是熄灭状态, 内容不可信(见上)。');
      }
      if (shot.fromCache && shot.cacheAgeMs > 0) {
        // 缓存帧不伪装成新帧: 明确告诉调用方它有多旧
        warnings.push(
          `该截图来自缓存, 采集于 ${shot.cacheAgeMs} ms 前` +
          `(frameTimestamp 是该帧真实采集时刻, 不是现在)。`
        );
      }

      if (wantOcr && result.image) {
        const ocr = await ocrImage(shot.file, { lang: ocrLang });
        if (ocr.ok) {
          result.ocr = {
            ok: true, engine: ocr.engine,
            lineCount: ocr.lines.length, wordCount: ocr.words.length,
            lines: ocr.lines,
            elapsedMs: ocr.elapsedMs,
          };
        } else {
          result.ocr = ocr;
          errors.push({ stage: 'ocr', error: ocr.error, detail: ocr.detail });
        }
      }
    } catch (e) {
      errors.push({ stage: 'screenshot', error: String(e.message || e) });
    }
  }

  // 4. 合并
  result.targets = mergeObservations({
    targets: result._treeTargets || [],
    ocrLines: result.ocr?.lines || [],
    ocrWords: result.ocr?.words || [],
  });
  delete result._treeTargets;

  result.totalMs = Date.now() - t0;
  return result;
}
