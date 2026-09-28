// cmd-display -- 解析 `cmd display get-displays`
//
// 为什么改用这个命令（而不是继续加宽 `dumpsys display` 的正则）
// ------------------------------------------------------------
// 同一个事实，两条命令的输出规模差三个数量级（实测 OnePlus PLK110 / Android 16）：
//
//   cmd display get-displays   2 行     5.3 KB
//   dumpsys display            985 行   125 KB
//
// `dumpsys display` 是个**给人看的、不定形的转储**：同一个字段有多种拼法、
// `mState=` 在同一份输出里出现两次（一次是屏状态、一次是 AUTO_BRIGHTNESS_DISABLED）、
// 裸 `state=` 有 101 处历史噪声。为了从里面挖出事实，之前写了一套"切段 + 锚定"的
// 启发式，而它已经判错过两次。
//
// `cmd display get-displays` 是**给机器看的**：每块屏一条记录，字段是
// `key value` 形式，直接可解析。所以它作为**主路径**，`dumpsys display` 降为兜底。
//
// 实测形态（两台设备一致，见 recognize/fixtures/）：
//
//   Displays:
//   Display id 0: DisplayInfo{"内置屏幕", displayId 0, displayGroupId 0, FLAG_...,
//     real 1272 x 2772, ..., mode 5, renderFrameRate 165.0, ...,
//     rotation 0, state ON, committedState ON, type INTERNAL,
//     uniqueId "local:4630946903293830803", app 1272 x 2772,
//     density 476 (455.0535 x 448.46368) dpi, layerStack 0, ...}
//
// 关键：`uniqueId "local:<id>"` 里的 `<id>` **就是 screencap -d 要的 sfId**，
// 一步到位，不需要再去 SurfaceFlinger 里对。
//
// 注意 `uniqueId` 的引号形态在三条命令里各不相同（实测）：
//   cmd display:          uniqueId "local:..."     无等号
//   DisplayDeviceInfo:    uniqueId="local:..."     双引号
//   mViewports:           uniqueId='local:...'     单引号
// 所以正则必须同时容忍这三种。这里只处理本命令的形态，但把它们记下来。

/** 从 cmd display 输出里取每块屏的一条记录 */
export function parseCmdDisplays(text) {
  if (!text) return [];
  const out = [];

  // 每块屏以 `Display id N:` 开头（可能带缩进）
  const re = /^\s*Display id (\d+):\s*(.*)$/gm;
  let m;
  while ((m = re.exec(text)) !== null) {
    const logicalId = Number(m[1]);
    const body = m[2];

    // state ON / committedState ON —— 必须锚定字段名，裸 state= 会撞 committedState
    const state = (body.match(/(?:^|[\s,])state\s+([A-Z_]+)/) || [])[1] ?? null;
    const committedState = (body.match(/committedState\s+([A-Z_]+)/) || [])[1] ?? null;

    const uniqueId = (body.match(/uniqueId\s+"([^"]+)"/) || [])[1]
      ?? (body.match(/uniqueId\s*=\s*"([^"]+)"/) || [])[1] ?? null;

    // real W x H（物理）；app W x H（逻辑，受 density/size override 影响）
    //
    // ⚠️ 必须用「逗号 / 行首 + 字段名」锚定，不能用裸 \b：
    //    同一行里有 `largest app 2772 x 2772` 和 `smallest app 1272 x 1272`，
    //    裸 `\bapp` 会命中它们（实测踩到：解析出 width=2772 height=2772）。
    const real = body.match(/(?:^|,\s*)real\s+(\d+)\s*x\s+(\d+)/);
    const app = body.match(/(?:^|,\s*)app\s+(\d+)\s*x\s+(\d+)/);

    // density 476 (455.05 x 448.46) dpi —— 取前面的整数，那是逻辑密度
    const density = (body.match(/\bdensity\s+(\d+)/) || [])[1] ?? null;
    const renderFrameRate = (body.match(/renderFrameRate\s+([\d.]+)/) || [])[1] ?? null;
    const refreshRateOverride = (body.match(/refreshRateOverride\s+([\d.]+)/) || [])[1] ?? null;
    const rotation = (body.match(/\brotation\s+(-?\d+)/) || [])[1] ?? null;
    const type = (body.match(/(?:^|[\s,])type\s+([A-Z_]+)/) || [])[1] ?? null;
    const mode = (body.match(/(?:^|[\s,])mode\s+(\d+)/) || [])[1] ?? null;
    const layerStack = (body.match(/layerStack\s+(-?\d+)/) || [])[1] ?? null;
    const name = (body.match(/DisplayInfo\s*\{\s*"([^"]*)"/) || [])[1] ?? null;

    out.push({
      order: out.length,
      logicalId,
      name,
      // uniqueId 去 local: 前缀 = screencap -d 的 sfId
      surfaceFlingerId: uniqueId ? uniqueId.replace(/^local:/, '') : null,
      localId: uniqueId ? uniqueId.replace(/^local:/, '') : null,
      uniqueId,
      state,
      committedState,
      // real = 物理像素；app = 逻辑像素（override 后）
      realWidth: real ? Number(real[1]) : null,
      realHeight: real ? Number(real[2]) : null,
      width: (app ?? real) ? Number((app ?? real)[1]) : null,
      height: (app ?? real) ? Number((app ?? real)[2]) : null,
      density: density ? Number(density) : null,
      renderFrameRate: renderFrameRate ? Number(renderFrameRate) : null,
      refreshRateOverride: refreshRateOverride ? Number(refreshRateOverride) : null,
      rotation: rotation !== null ? Number(rotation) : null,
      type,
      modeId: mode ? Number(mode) : null,
      layerStack: layerStack !== null ? Number(layerStack) : null,
      // cmd display 不提供 isFirst；逻辑 id 0 即默认屏
      isFirst: logicalId === 0,
      source: 'cmd-display',
    });
  }

  return out;
}

/**
 * 统一入口：优先 `cmd display get-displays`，失败或解析不出则退回 `dumpsys display`。
 *
 * 返回 { displays, source, error }：
 *   source = 'cmd-display' | 'dumpsys' | null
 *   error  = 两条路都拿不到时的原因（**不兜底**，交给调用方报错）
 */
export function parseDisplaysPreferred({ cmdDisplay, dumpsysDisplay, surfaceFlinger, power }, fallbackParser) {
  // 1. 主路径
  if (cmdDisplay) {
    const viaCmd = parseCmdDisplays(cmdDisplay);
    if (viaCmd.length) {
      return {
        displays: viaCmd,
        source: 'cmd-display',
        wakefulness: (power || '').match(/^\s*mWakefulness=(\w+)/m)?.[1] ?? null,
        defaultSurfaceFlingerId: (viaCmd.find((d) => d.isFirst) || viaCmd[0]).surfaceFlingerId,
        error: null,
      };
    }
  }

  // 2. 兜底：dumpsys display
  if (fallbackParser) {
    const r = fallbackParser({ dumpsysDisplay, surfaceFlinger, power });
    if (r && r.displays && r.displays.length) {
      return { ...r, source: 'dumpsys' };
    }
    if (r && r.error) {
      return {
        displays: [], source: null, wakefulness: r.wakefulness ?? null,
        defaultSurfaceFlingerId: null,
        error: `cmd display get-displays 与 dumpsys display 都解析不出屏。` +
          `dumpsys 路径的原因: ${r.error}`,
      };
    }
  }

  return {
    displays: [], source: null, wakefulness: null, defaultSurfaceFlingerId: null,
    error: 'cmd display get-displays 无输出，且没有可用的兜底解析器',
  };
}
