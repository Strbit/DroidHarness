// displays-probe -- 解析 app_process 探针的 stdout，归一成与文本路径一致的形状
//
// 为什么还要一个"解析层"：探针把 API 的类型化对象转成了 stdout 文本，
// 所以下游仍需从文本里取字段。区别在于**这个文本是我们自己定的协议** ——
// 一行一字段、字段名固定、值是 toString() 的直出，
// 而不是 `dumpsys display` 那种"给人看、随版本变"的转储。
//
// 协议（见 src/Displays.java）：
//     OK|<tool>
//     SOURCE|<DisplayManagerGlobal|DisplayManager>
//     COUNT|<n>
//     DISPLAY|<id>|<k>=<v>|<k>=<v>|...
//     END
// 出错：ERROR|<code>|<detail>
//
// 与 lib/displays.mjs 的**字段对齐**是硬要求：两条路径产出的对象要能互换，
// 否则调用方就得为"这次是 API 还是文本"分叉。对齐关系见 toDisplayRecord()。

/**
 * Android `Display.STATE_*` 常量 —— 从 API 拿的是**数字**，要映射成与
 * dumpsys 路径一致的字符串（那边是 `mState=ON`）。
 * 这是两条路径能互换的关键：dumpsys 给 `ON`，API 给 `2`。
 */
export const DISPLAY_STATE = {
  0: 'UNKNOWN',
  1: 'OFF',
  2: 'ON',
  3: 'DOZE',
  4: 'DOZE_SUSPEND',
  5: 'VR',
  6: 'ON_SUSPEND',
};

/** Android `Display.TYPE_*` 常量 -> 与 dumpsys 路径一致的字符串 */
export const DISPLAY_TYPE = {
  0: 'UNKNOWN',
  1: 'INTERNAL',
  2: 'EXTERNAL',
  3: 'WIFI',
  4: 'OVERLAY',
  5: 'VIRTUAL',
};

/** 把探针输出解析成 { ok, source, count, displays, error } */
export function parseProbeOutput(stdout) {
  const out = { ok: false, source: null, count: null, displays: [], error: null };
  if (!stdout || typeof stdout !== 'string') {
    out.error = '探针没有输出';
    return out;
  }

  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);

  for (const line of lines) {
    const parts = line.split('|');
    const tag = parts[0];

    if (tag === 'ERROR') {
      // 探针自己报告失败 —— 这是**显式**失败，不能当成"设备没有屏"
      out.error = `探针报错 [${parts[1] || 'unknown'}]: ${parts.slice(2).join('|') || '(无详情)'}`;
      out.ok = false;
      continue;
    }
    if (tag === 'OK') { out.ok = true; continue; }
    if (tag === 'SOURCE') { out.source = parts[1] || null; continue; }
    if (tag === 'COUNT') { out.count = Number(parts[1]); continue; }
    if (tag === 'END') { continue; }

    if (tag === 'DISPLAY') {
      const logicalId = Number(parts[1]);
      const fields = {};
      for (const seg of parts.slice(2)) {
        const eq = seg.indexOf('=');
        if (eq < 0) continue;
        fields[seg.slice(0, eq)] = seg.slice(eq + 1);   // 值里可能有 = ，所以只切第一个
      }
      out.displays.push(toDisplayRecord(logicalId, fields));
    }
  }

  if (!out.ok && !out.error) out.error = '探针输出里既没有 OK 也没有 ERROR（协议不符）';
  if (out.ok && out.count !== null && out.count !== out.displays.length) {
    out.error = `探针报 COUNT=${out.count} 但实际给出 ${out.displays.length} 条 DISPLAY —— 输出被截断？`;
    out.ok = false;
  }
  return out;
}

const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v));

/**
 * 探针字段 -> 与 lib/displays.mjs 对齐的记录。
 *
 * 对齐是刻意的：调用方拿到 `state` / `surfaceFlingerId` / `width` / `height` / `density`
 * 时不该关心"这次走的是 API 还是文本"。
 */
export function toDisplayRecord(logicalId, f) {
  const uniqueId = f.uniqueId ?? null;
  return {
    // ── 身份 ──
    logicalId,
    name: f.name ?? null,
    uniqueId,
    // 两条路径都从 uniqueId 去 local: 前缀得到 screencap -d 要的 id
    surfaceFlingerId: uniqueId ? uniqueId.replace(/^local:/, '') : null,
    localId: uniqueId ? uniqueId.replace(/^local:/, '') : null,
    // ── 状态（数字 -> 字符串，与 dumpsys 路径对齐）──
    state: f.state !== undefined ? (DISPLAY_STATE[Number(f.state)] ?? `UNKNOWN_${f.state}`) : null,
    type: f.type !== undefined ? (DISPLAY_TYPE[Number(f.type)] ?? `UNKNOWN_${f.type}`) : null,
    rotation: num(f.rotation),
    // ── 尺寸：logical = 逻辑像素，app = 应用可见像素 ──
    width: num(f.appWidth) ?? num(f.logicalWidth),
    height: num(f.appHeight) ?? num(f.logicalHeight),
    realWidth: num(f.logicalWidth),
    realHeight: num(f.logicalHeight),
    density: num(f.logicalDensityDpi),
    renderFrameRate: num(f.renderFrameRate),
    modeId: num(f.modeId),
    displayGroupId: num(f.displayGroupId),
    flags: f.flags !== undefined ? Number(f.flags) : null,
    // ── 与文本路径的差异要说清 ──
    // cmd display 不提供 hwcDisplay；探针也不提供。两边都是 null，调用方按"未知"处理。
    hwcDisplay: null,
    // 探针按 logicalId 枚举，0 即默认屏（与 cmd display 路径一致）
    isFirst: logicalId === 0,
    source: 'api-probe',
  };
}

/**
 * 选一条可用路径的结果 —— 与 recognize 侧的 `parseDisplaysPreferred` 同构：
 * API 探针优先，拿不到就交给文本路径的回调兜底，**两条都失败就报错不兜底**。
 *
 * @param probeStdout 探针输出（失败时可传空）
 * @param textFallback () => { displays, error } —— 文本路径（cmd display / dumpsys）
 */
export function preferApiOverText(probeStdout, textFallback) {
  const probe = parseProbeOutput(probeStdout);
  if (probe.ok && probe.displays.length) {
    return { displays: probe.displays, source: 'api-probe', probeSource: probe.source, error: null };
  }

  const text = typeof textFallback === 'function' ? textFallback() : null;
  if (text && text.displays && text.displays.length) {
    return {
      displays: text.displays,
      source: text.source ?? 'text',
      probeSource: null,
      // 把探针失败的原因保留下来（降级了但要说清为什么）
      error: null,
      probeError: probe.error,
    };
  }

  const reasons = [probe.error ? `API 探针: ${probe.error}` : 'API 探针: 没有可用输出',
    text && text.error ? `文本路径: ${text.error}` : '文本路径: 也没有可用输出'];
  return { displays: [], source: null, probeSource: null, error: reasons.join('；') };
}
