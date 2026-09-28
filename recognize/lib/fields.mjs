// fields -- 字段有界化 + 帧缓存
//
// 两件事都来自一个共同的教训: **无界的东西会在远端炸掉**, 而且往往不报错。
//
// 1. 截断要保尾, 不能只保头。
//    无障碍节点的 text / content-desc 没有长度上限, 一个聊天界面的
//    content-desc 可能上万字符。只保头会静默切掉 URL 的查询参数
//    (如 `?orderId=...`), 而尾部往往正是身份信息所在。
//
// 2. 缓存帧必须标注新鲜度。
//    screencap 的 PNG 编码在设备上可能要 1 秒以上, 缓存能省掉重复开销,
//    但代价是"熄屏或画面静止时读到旧帧且不报错"(见
//    docs/android-agent-harness-plan.md §5.2)。所以缓存帧必须带上
//    采集时刻与是否来自缓存, 让调用方自己判断能不能信。

/** 单个无障碍字段的默认上限（字符）。 */
export const DEFAULT_FIELD_HEAD = 300;
/** 保尾长度（字符）。 */
export const DEFAULT_FIELD_TAIL = 160;

/**
 * head + tail 有界截断。
 *
 * 为什么不只保头: 长文本的尾部常含关键标识 —— URL 查询参数、订单号、
 * 错误码、文件扩展名。截掉尾部等于把可用信息变成误导信息。
 *
 * 保留的 `omittedChars` 让调用方知道损失了多少, 而不是以为看到了全部。
 *
 * @param value 任意值（非字符串会被 String() 化）
 * @param headChars 头部保留字符数
 * @param tailChars 尾部保留字符数
 * @returns 原值（够短时）或带省略标记的截断值
 */
export function truncateField(value, { headChars = DEFAULT_FIELD_HEAD, tailChars = DEFAULT_FIELD_TAIL } = {}) {
  if (value === null || value === undefined) return value;
  const s = typeof value === 'string' ? value : String(value);
  const budget = headChars + tailChars;
  if (s.length <= budget) return s;
  const omitted = s.length - budget;
  return `${s.slice(0, headChars)}…[省略 ${omitted} 字符]…${s.slice(s.length - tailChars)}`;
}

/**
 * 数组有界化: 保头 + 保尾, 中间省略。
 *
 * 为什么也保尾: 列表尾部的元素往往包含"最新"或"总计"这类信息
 * (日志尾、消息末条)。只保头会让调用方以为列表就到那里为止。
 *
 * 返回 { items, omitted } —— omitted 必须回传给调用方, 不能静默丢。
 */
export function boundArray(arr, { headLimit = 200, tailLimit = 50 } = {}) {
  if (!Array.isArray(arr)) return { items: [], omitted: 0 };
  const budget = headLimit + tailLimit;
  if (arr.length <= budget) return { items: arr, omitted: 0 };
  return {
    items: [...arr.slice(0, headLimit), ...arr.slice(arr.length - tailLimit)],
    omitted: arr.length - budget,
  };
}

/**
 * 深度有界化: 递归截断对象/数组里的所有字符串字段。
 *
 * 用于结果回传前的最后一道关。emitted 字段名以 `_` 开头时跳过
 * (内部的 _treeTargets 之类不对外)。
 */
export function boundValue(value, opts = {}, depth = 0) {
  const { maxDepth = 8, skipKeys = [] } = opts;
  if (depth > maxDepth) return '[深度截断]';
  if (typeof value === 'string') return truncateField(value, opts);
  if (Array.isArray(value)) {
    const { items, omitted } = boundArray(value, opts);
    const mapped = items.map((v) => boundValue(v, opts, depth + 1));
    if (omitted > 0) mapped.push(`…[省略 ${omitted} 项]…`);
    return mapped;
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k.startsWith('_') || skipKeys.includes(k)) continue;
      out[k] = boundValue(v, opts, depth + 1);
    }
    return out;
  }
  return value;
}

// ── 帧缓存 ────────────────────────────────────────────────
/**
 * screencap 帧缓存。
 *
 * 每次调用都新建实例 —— 模块级全局缓存会被多会话串味(不同设备/不同 displayId
 * 的帧互相覆盖), 那是比"慢"严重得多的 bug。
 *
 * 缓存只按 (displayId) 建键。**不同 displayId 的帧绝不混用**: 主屏和副屏的
 * 坐标系完全不同, 混用会导致静默错坐标。
 */
export class FrameCache {
  constructor() {
    this.last = null;   // { displayId, buf, meta }
  }

  /**
   * 取一帧。
   *
   * @param displayKey 缓存的键(通常是 displayId 的字符串形式)
   * @param capture 实际采集函数, 返回 { buf, ...meta }
   * @param opts.maxAgeMs 允许复用多久以内的帧; 0 = 不复用(总是重新采集)
   * @returns { ...meta, fromCache, cacheAgeMs, frameTimestamp }
   */
  async get(displayKey, capture, { maxAgeMs = 0 } = {}) {
    const now = Date.now();

    if (maxAgeMs > 0 && this.last && this.last.displayId === displayKey) {
      const age = now - this.last.capturedAt;
      if (age <= maxAgeMs) {
        return {
          ...this.last.meta,
          fromCache: true,
          cacheAgeMs: age,
          // 关键: 即使复用, 也如实报出这一帧真实的采集时刻, 不是"现在"
          frameTimestamp: this.last.capturedAt,
        };
      }
    }

    const captured = await capture();
    const capturedAt = Date.now();
    this.last = { displayId: displayKey, capturedAt, meta: captured };

    return {
      ...captured,
      fromCache: false,
      cacheAgeMs: 0,
      frameTimestamp: capturedAt,
    };
  }

  clear() { this.last = null; }

  /** 供调用方判断"要不要重新采集" */
  peek(displayKey) {
    if (!this.last || this.last.displayId !== displayKey) return null;
    return { displayId: this.last.displayId, capturedAt: this.last.capturedAt, ageMs: Date.now() - this.last.capturedAt };
  }
}
