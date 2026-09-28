// uitree -- uiautomator dump 的 XML 解析
//
// 为什么不用一个 XML 库: uiautomator 的输出格式极其固定(单一层级 + 属性),
// 而设备侧 Node 环境里少一个依赖就少一份风险。这个解析器只认它自己的方言。
//
// 关键能力: 给每个节点找"可点祖先"。
// 依据: 无障碍树里真正的点击目标常常是父节点 —— 一个 TextView 本身
// clickable=false, 但它的父 LinearLayout clickable=true。只收集
// clickable=true 的节点会漏掉大量可点目标, 这是 R5(加固应用树为空)
// 之外最常见的一类误判。

/** 解析 HTML 实体(只需处理 uiautomator 会产出的那几个) */
function decodeEntities(s) {
  if (!s || s.indexOf('&') === -1) return s;
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&');
}

/** 解析 bounds="[x1,y1][x2,y2]" */
export function parseBounds(s) {
  if (!s) return null;
  const m = s.match(/\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);
  if (!m) return null;
  const [x1, y1, x2, y2] = m.slice(1).map(Number);
  return {
    left: x1, top: y1, right: x2, bottom: y2,
    width: x2 - x1, height: y2 - y1,
    cx: Math.round((x1 + x2) / 2),
    cy: Math.round((y1 + y2) / 2),
  };
}

const BOOL_ATTRS = ['checkable', 'checked', 'clickable', 'enabled', 'focusable',
  'focused', 'scrollable', 'long-clickable', 'password', 'selected'];

/**
 * 解析 uiautomator dump 的 XML。
 * 返回一个"扁平但有结构"的节点数组, 每个节点带:
 *   path / depth / index / text / desc / resourceId / class / package /
 *   bounds / 各布尔属性 / childrenIndices / clickableAncestorIndices
 */
export function parseUiXml(xml) {
  const hierarchyMatch = xml.match(/<hierarchy\b[^>]*>([\s\S]*)<\/hierarchy>/);
  const body = hierarchyMatch ? hierarchyMatch[1] : xml;
  const rotationMatch = xml.match(/<hierarchy[^>]*\brotation="(-?\d+)"/);
  const rotation = rotationMatch ? Number(rotationMatch[1]) : null;

  const nodes = [];
  // 解析栈: 每项是 { nodeIndex, childCounter }
  const stack = [];

  const tagRe = /<(\/?)(node|hierarchy)\b([^>]*?)(\/?)>/g;
  let m;
  while ((m = tagRe.exec(body)) !== null) {
    const [, closing, tag, attrStr] = m;
    if (tag !== 'node') continue;

    if (closing) {
      if (stack.length) stack.pop();
      continue;
    }

    const attrs = {};
    const attrRe = /([\w-]+)="([^"]*)"/g;
    let a;
    while ((a = attrRe.exec(attrStr)) !== null) {
      attrs[a[1]] = decodeEntities(a[2]);
    }

    const parent = stack.length ? stack[stack.length - 1] : null;
    if (parent) {
      parent.childCount += 1;
    }

    // 可点祖先链 = 父节点的可点祖先链, 若父节点本身可点则再加上父节点
    const ancestorIndices = parent ? parent.clickableAncestors.slice() : [];
    if (parent && parent.node.clickable === true) {
      ancestorIndices.push(parent.nodeIndex);
    }

    const nodeIndex = nodes.length;
    const node = {
      index: nodeIndex,
      path: parent ? `${parent.node.path}/${parent.childCount - 1}` : '0',
      depth: stack.length,
      text: attrs.text || '',
      desc: attrs['content-desc'] || '',
      resourceId: attrs['resource-id'] || '',
      className: attrs.class || '',
      package: attrs.package || '',
      hint: attrs.hint || '',
      bounds: parseBounds(attrs.bounds),
      boundsRaw: attrs.bounds || null,
      childCount: 0,
      childrenIndices: [],
      clickableAncestorIndices: ancestorIndices,
      drawOrder: attrs['drawing-order'] !== undefined ? Number(attrs['drawing-order']) : null,
    };
    for (const b of BOOL_ATTRS) {
      node[camel(b)] = attrs[b] === 'true';
    }
    // 短横线属性名在 camel() 里被处理成 longClickable
    node.longClickable = attrs['long-clickable'] === 'true';

    nodes.push(node);
    if (parent) parent.node.childrenIndices.push(nodeIndex);

    const selfClosing = attrStr.trimEnd().endsWith('/') || m[4] === '/';
    if (!selfClosing) {
      stack.push({ node, nodeIndex, childCount: 0, clickableAncestors: ancestorIndices });
    }
  }

  return { rotation, nodes };
}

function camel(s) {
  return s.replace(/-(\w)/g, (_, c) => c.toUpperCase());
}

/** 节点可读标签: text 优先, 其次 content-desc */
export function labelOf(node) {
  const t = (node.text || '').trim();
  if (t) return t;
  const d = (node.desc || '').trim();
  if (d) return d;
  return '';
}

/**
 * 判断树"有没有值得动手的节点"。
 *
 * 依据 docs/android-agent-harness-plan.md §5.2:
 *   引擎自绘的界面不是空树而是"没用的树"(可能只有一个全屏 SurfaceView)。
 *   判据应该是"有没有值得动手的节点", 不是"树是否为空"。
 */
export function isUsefulTree(parsed) {
  const actionable = parsed.nodes.filter((n) =>
    (n.clickable || n.longClickable || n.scrollable || n.checkable) ||
    (labelOf(n) && n.depth > 0));
  const withLabel = parsed.nodes.filter((n) => labelOf(n).length > 0);
  return {
    useful: actionable.length > 0,
    totalNodes: parsed.nodes.length,
    actionableCount: actionable.length,
    labelledCount: withLabel.length,
    reason: actionable.length === 0
      ? (parsed.nodes.length <= 2
          ? 'tree-empty: 只有 ' + parsed.nodes.length + ' 个节点, 疑似自绘界面或抓取失败'
          : 'tree-useless: ' + parsed.nodes.length + ' 个节点但无可操作项, 疑似自绘界面')
      : null,
  };
}

/** 扁平节点 → 可操作目标清单(含可点祖先解析) */
export function toTargets(parsed, { includeDisabled = false } = {}) {
  const out = [];
  for (const n of parsed.nodes) {
    const clickableAncestor = n.clickableAncestorIndices.length
      ? parsed.nodes[n.clickableAncestorIndices[n.clickableAncestorIndices.length - 1]]
      : null;
    // 自身可点, 或存在可点祖先, 才算候选目标
    const selfActionable = n.clickable || n.longClickable;
    const viaAncestor = !selfActionable && !!(clickableAncestor && clickableAncestor.clickable);
    if (!selfActionable && !viaAncestor) continue;
    if (!includeDisabled && n.enabled === false) continue;
    const label = labelOf(n) || (clickableAncestor ? labelOf(clickableAncestor) : '');
    out.push({
      text: n.text,
      desc: n.desc,
      label,
      resourceId: n.resourceId,
      className: n.className,
      package: n.package,
      bounds: n.bounds,
      clickable: n.clickable,
      longClickable: n.longClickable,
      scrollable: n.scrollable,
      enabled: n.enabled,
      // 真正该点哪个框: 自身可点就用自己, 否则用可点祖先
      targetNodeIndex: selfActionable ? n.index : clickableAncestor.index,
      viaAncestor: viaAncestor ? {
        nodeIndex: clickableAncestor.index,
        className: clickableAncestor.className,
        resourceId: clickableAncestor.resourceId,
        bounds: clickableAncestor.bounds,
        label: labelOf(clickableAncestor),
      } : null,
    });
  }
  return out;
}
