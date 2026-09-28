// displays -- 跨设备的屏信息解析
//
// 这个文件的存在理由很具体: PR #11 第二轮的跨设备缺陷 ——
// 原实现只看 `Display 0 [id=local:...,stack=0],isFirst=true,...` 这一种形态,
// 而它在 Xiaomi 25102RKBEC / Android 16 上**一次都不存在**,
// 于是 list_displays 整条工具失效(枚举不出任何屏)。
//
// 所以这里只认**两台真机都稳定出现**的形态, 并明确写出每条的样本来源:
//
//   形态 A  DisplayDeviceInfo{"name": uniqueId="local:...", W x H, modeId N,
//           renderFrameRate F, ... density D, rotation R, touch T, ...}
//           来源: OnePlus PLK110 + Xiaomi 25102RKBEC 都有
//
//   形态 B  mState=ON|OFF|DOZE        (段内字段, 锚定字段名)
//           来源: 两台都有
//
//   形态 C  mViewports=[DisplayViewport{... displayId=0, uniqueId='local:...' ...}]
//           -> 逻辑 displayId ↔ uniqueId 的映射
//           来源: 两台都有
//
//   形态 D  dumpsys SurfaceFlinger --display-id
//           -> `Display <sfId> (HWC display N): port=...`
//           来源: 两台都有; 这是 screencap -d 要的那个 id
//
// 刻意**不用**的形态:
//   · `Display N [id=...,stack=N],isFirst=true,state=X,...`
//     —— OnePlus 专属。Xiaomi 上 grep 命中 0 次。用它就是这次的缺陷来源。
//   · 裸 `state=[A-Z_]+`
//     —— 实测在 OnePlus 上命中 101 次, 其中绝大多数是 BrightnessEvent 历史行
//        (含状态迁移记录)。用它会被历史值污染, 亮屏报 OFF 或反之。
//        必须锚定 `mState=`, 它只出现 1 次。
//   · `lightId=`/`brightness` 等 —— 与屏身份无关。

/** 形态 D: 从 SurfaceFlinger 输出解析出 sfId 列表 */
export function parseSurfaceFlingerIds(text) {
  const ids = [];
  if (!text) return ids;
  const re = /^\s*Display\s+(\d+)\s*\(HWC display (\d+)\)/gm;
  let m;
  while ((m = re.exec(text)) !== null) {
    ids.push({ surfaceFlingerId: m[1], hwcDisplay: Number(m[2]) });
  }
  return ids;
}

/** 形态 C: 逻辑 displayId ↔ uniqueId 映射 */
export function parseViewports(text) {
  const map = new Map(); // uniqueId -> logicalId
  if (!text) return map;
  const re = /DisplayViewport\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const seg = m[1];
    const did = seg.match(/\bdisplayId=(-?\d+)/);
    const uid = seg.match(/\buniqueId='([^']+)'/) || seg.match(/\buniqueId="([^"]+)"/);
    if (did && uid) map.set(uid[1], Number(did[1]));
  }
  return map;
}

/**
 * 形态 A + B: 逐块解析每块屏的 DisplayDeviceInfo 与随后的 mState。
 *
 * 为什么按"块"而不是整篇扫: 状态字段与设备信息可能在不同行/不同顺序,
 * 要把它们关联到"同一块屏"必须限定范围。
 *
 * 段边界怎么定(按真机结构, 见 fixtures/oneplus-dumpsys-display.txt):
 *   dumpsys 的顶层分组是**顶格(缩进 0)的非空行**, 其后紧跟一条纯分隔线:
 *
 *     行 73: Display Devices: size=1        <- 顶格段头
 *     行 74: -----------------------        <- 段头后的分隔线, 不是段尾!
 *     行 75:   DisplayDeviceInfo{...        <- 缩进 2, 段内容
 *
 *   所以: 从段头后找第一个顶格非空行作为段尾。**必须跳过紧跟段头的那条
 *   分隔线** —— 最初实现把它当成段尾, 结果段内一行都没读到(测试没发现,
 *   因为夹具里没放那条线, 又一次夹具偏离了真机)。
 *
 *   段内的嵌套块(如缩进 4 的 `DisplayDeviceConfig:`)不会结束本段,
 *   因为它们不是顶格。
 */
function findSegment(lines, headerRe) {
  let header = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headerRe.test(lines[i])) { header = i; break; }
  }
  if (header < 0) return null;

  // 段尾: 段头之后第一个顶格(缩进 0)的非空行, 且它不是纯分隔线
  let end = lines.length;
  for (let i = header + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;                       // 空行跳过
    if (/^\s*-{5,}\s*$/.test(line)) continue;          // 分隔线跳过(段头后那条)
    const indent = line.length - line.trimStart().length;
    if (indent === 0) { end = i; break; }              // 顶格 -> 新分组
  }
  return { header, bodyStart: header + 1, end };
}

export function parseDisplayDevices(text) {
  if (!text) return [];
  const lines = text.split('\n');

  const seg = findSegment(lines, /^\s*Display Devices:\s*size=/);
  if (!seg) return [];

  // 收集段内每块的字段
  const devices = [];
  let cur = null;
  for (let i = seg.bodyStart; i < seg.end; i++) {
    const line = lines[i];
    const devMatch = line.match(/DisplayDeviceInfo\s*\{([\s\S]*)$/);
    if (devMatch) {
      if (cur) devices.push(cur);
      cur = { raw: devMatch[1], state: null };
      continue;
    }
    if (!cur) continue;
    // mState 锚定字段名(不裸配 state=)
    const st = line.match(/^\s*mState=([A-Z_]+)/);
    if (st && cur.state === null) cur.state = st[1];
  }
  if (cur) devices.push(cur);

  return devices.map((d, idx) => {
    const s = d.raw;
    // 注意: `s` 是 devMatch 捕获组的内容, 也就是 `DisplayDeviceInfo{` **之后**的部分。
    // 所以这里的正则都**不能**再带 `DisplayDeviceInfo{` 前缀 ——
    // name 就是 s 的第一个字段(在引号里), 直接锚定开头。
    // (这个 bug 真踩了: 早期写成 /DisplayDeviceInfo\s*\{\s*"([^"]*)"/,
    //  在同一行的另一个作用域里能匹配, 在 s 上永不匹配, 于是 name 恒为 null。)
    const name = (s.match(/^\s*"([^"]*)"/) || [])[1] ?? null;
    const uniqueId = (s.match(/uniqueId\s*=\s*"([^"]+)"/) || [])[1] ?? null;
    const size = s.match(/(\d+)\s*x\s*(\d+)\s*,\s*modeId/);
    const modeId = (s.match(/modeId\s+(\d+)/) || [])[1] ?? null;
    const fps = (s.match(/renderFrameRate\s+([\d.]+)/) || [])[1] ?? null;
    const density = (s.match(/\bdensity\s+(\d+)/) || [])[1] ?? null;
    const rotation = (s.match(/\brotation\s+(-?\d+)/) || [])[1] ?? null;
    const touch = (s.match(/\btouch\s+([A-Z_]+)/) || [])[1] ?? null;
    // type 用 \b 锚定并把前一个字符限成非字母, 避免命中 deviceProductInfo 之类
    const type = (s.match(/[^A-Za-z]type\s+([A-Z_]+)/) || [])[1] ?? null;
    return {
      order: idx,
      name,
      uniqueId,
      // localId: uniqueId 去掉 "local:" 前缀 —— 这就是 SurfaceFlinger/screencap 要的 id
      // 两台设备实测 uniqueId 形如 local:4630946903293830803 / local:4630946964337362323
      localId: uniqueId ? uniqueId.replace(/^local:/, '') : null,
      width: size ? Number(size[1]) : null,
      height: size ? Number(size[2]) : null,
      modeId: modeId ? Number(modeId) : null,
      renderFrameRate: fps ? Number(fps) : null,
      density: density ? Number(density) : null,
      rotation: rotation !== null ? Number(rotation) : null,
      touch,
      type,
      state: d.state,      // 来自 mState=(形态 B)
    };
  });
}

/** 唤醒状态: 只从 dumpsys power 的 mWakefulness= 取(锚定字段名) */
export function parseWakefulness(text) {
  if (!text) return null;
  const m = text.match(/^\s*mWakefulness=(\w+)/m);
  return m ? m[1] : null;
}

/** 形态 D + A + C 合并: 补出 surfaceFlingerId 与 logicalId, 并标出默认屏 */
export function mergeDisplaySources({ devices, viewports, sfIds }) {
  const sfByLocal = new Map();
  for (const s of sfIds || []) sfByLocal.set(String(s.surfaceFlingerId), s);

  const out = devices.map((d) => {
    const logical = (d.uniqueId && viewports && viewports.get(d.uniqueId)) ?? null;
    const sf = d.localId && sfByLocal.has(String(d.localId)) ? sfByLocal.get(String(d.localId)) : null;
    return {
      ...d,
      logicalId: logical,
      surfaceFlingerId: d.localId,   // screencap -d 用这个
      hwcDisplay: sf ? sf.hwcDisplay : null,
      // 只有明确证据才标 isFirst: 逻辑 id 为 0, 或(拿不到逻辑 id 时)第一块
      isFirst: logical !== null ? logical === 0 : d.order === 0,
    };
  });

  // 按 logicalId 排序(logicalId 可能为 null, 排到最后)
  out.sort((a, b) => {
    if (a.logicalId === null && b.logicalId === null) return a.order - b.order;
    if (a.logicalId === null) return 1;
    if (b.logicalId === null) return -1;
    return a.logicalId - b.logicalId;
  });

  // 默认屏: screencap 不带 -d 时用的那块
  const first = out.find((d) => d.isFirst) || out[0] || null;

  return { displays: out, defaultSurfaceFlingerId: first ? first.surfaceFlingerId : null };
}

/**
 * 一次解析完: 输入三段原始文本, 输出结构化屏列表。
 * 解析不出来时如实返回 error, 不用默认值兜底(设计约束 3)。
 */
export function parseDisplays({ dumpsysDisplay, surfaceFlinger, power }) {
  const devices = parseDisplayDevices(dumpsysDisplay || '');
  const viewports = parseViewports(dumpsysDisplay || '');
  const sfIds = parseSurfaceFlingerIds(surfaceFlinger || '');
  const wakefulness = parseWakefulness(power || '');

  if (!devices.length) {
    return {
      displays: [],
      wakefulness,
      defaultSurfaceFlingerId: null,
      error: '未能从 dumpsys display 解析出任何屏 —— 该设备的输出形态可能不在已知样本内' +
        '(已知样本: OnePlus PLK110 / Xiaomi 25102RKBEC, 均含 DisplayDeviceInfo 段)',
    };
  }

  const merged = mergeDisplaySources({ devices, viewports, sfIds });
  return { ...merged, wakefulness, error: null };
}
