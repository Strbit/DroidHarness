#!/usr/bin/env node
// recognize -- 手机内容识别 CLI
//
// 两条路线的统一入口:
//   无障碍树(uiautomator dump)  +  屏幕图片(screencap) + OCR
//
// 用法:
//   node recognize.mjs displays                    列出所有屏及状态
//   node recognize.mjs observe   [--json]          一次完整识别(两条路合并)
//   node recognize.mjs tree      [--json]          只看无障碍树
//   node recognize.mjs ocr       [--json]          只看图像识别
//   node recognize.mjs targets   [--json]          只输出可操作目标清单
//   node recognize.mjs selftest                    不连设备也能跑的自检
//
// 公共参数:
//   --display <id>   目标屏(默认 0)
//   --adb <path>     adb 路径(默认自动查找, 也可用环境变量 ADB)
//   --serial <s>     多设备时指定
//   --root           用 su 执行设备侧命令
//   --json           输出 JSON(供程序消费)
//   --out <dir>      截图保存目录

import fs from 'node:fs';
import path from 'node:path';
import { Device, AdbError, pcTmpDir } from './lib/device.mjs';
import { observe, getDisplays, uiTree, screenshot, ocrImage, mergeObservations } from './lib/observe.mjs';
import { parseUiXml, toTargets, isUsefulTree, labelOf } from './lib/uitree.mjs';

// ── 参数解析 ──────────────────────────────────────────────
function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--root') opts.root = true;
    else if (a === '--keep') opts.keep = true;
    else if (a === '--display') opts.display = Number(argv[++i]);
    else if (a === '--adb') opts.adb = argv[++i];
    else if (a === '--serial') opts.serial = argv[++i];
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--lang') opts.lang = argv[++i];
    else if (a === '--limit') opts.limit = Number(argv[++i]);
    else if (a === '--json-file') opts.jsonFile = argv[++i];
    else if (a === '--section') opts.section = argv[++i];
    else if (a === '--max-bytes') opts.maxBytes = Number(argv[++i]);
    else if (a.startsWith('--')) opts[a.slice(2)] = true;
    else opts._.push(a);
  }
  return opts;
}

function jout(obj) { process.stdout.write(JSON.stringify(obj, null, 2) + '\n'); }

function stateIcon(s) {
  return ({ ON: '亮', OFF: '灭', DOZE: '息屏', DOZE_SUSPEND: '深度息屏' })[s] || String(s);
}

// ── 子命令 ────────────────────────────────────────────────
// ── serve 的入参校验辅助（第三轮审阅 M5）─────────────────

/**
 * 把请求里的 displayId 解析成 screencap -d 要的 surfaceFlingerId（M5）。
 *
 * 两条硬要求：
 *   · 找不到那块屏就**返回 null 交给平台判断默认屏**，但如果调用方明确要了
 *     一个不存在的屏，那应该报错而不是静默给默认屏 —— 所以这里区分
 *     "没指定"（undefined/null → null）与"指定了但不存在"（抛错）。
 *   · sfId 必须按**字符串**比较。它是 19 位无符号数（如 4630946964337362323），
 *     走 Number() 会变成 4630946964337362000，比对必然失配（M3 是同一个坑）。
 */
async function resolveSurfaceFlingerId(device, requested) {
  if (requested === undefined || requested === null) return null;
  const info = await getDisplays(device).catch(() => null);
  if (!info || !info.displays?.length) {
    throw new Error(`无法获取屏列表，不能按 displayId=${requested} 定向截图`);
  }
  const want = String(requested);
  const d = info.displays.find((x) => String(x.logicalId) === want)
    || info.displays.find((x) => String(x.surfaceFlingerId) === want);
  if (!d) {
    throw new Error(
      `屏列表里没有 displayId=${requested}（实际有 ${info.displays.map((x) => x.logicalId).join(', ')}）`);
  }
  return d.surfaceFlingerId;
}

/**
 * 约束 PC 侧写盘路径（M5）。
 *
 * 服务通过 stdio 接收外部请求，`savePath` 是请求方可控的。
 * 不校验就等于给对端一个"覆盖本机任意可写文件"的原语。
 * 允许的根目录：`--out` 指定的目录，或进程的临时目录（pcTmpDir）。
 */
function resolveSavePath(requested, outDir) {
  if (!requested) return undefined;   // 交给 screenshot 用默认临时文件
  const root = path.resolve(outDir || pcTmpDir());
  const target = path.resolve(requested);
  const rel = path.relative(root, target);
  // rel 不含 ".." 且不是绝对路径 => 在 root 之内
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(
      `savePath 必须落在允许目录内。收到 ${target}，允许根目录 ${root}。` +
      `（可用 --out 指定输出目录）`);
  }
  return target;
}

const commands = {
  async displays(dev, opts) {
    const d = await getDisplays(dev);
    if (opts.json) return jout(d);
    console.log(`唤醒状态: ${d.wakefulness}`);
    console.log(`物理尺寸: ${d.wmSize ? d.wmSize.width + 'x' + d.wmSize.height : '未知'}` +
      (d.wmOverride ? `   覆盖尺寸: ${d.wmOverride.width}x${d.wmOverride.height}` : '   无覆盖'));
    console.log(`密度:     物理 ${d.wmDensity?.physical ?? '?'}   覆盖 ${d.wmDensity?.override ?? '无'}`);
    console.log('');
    console.log('屏:');
    for (const s of d.displays) {
      // stack 只有 dumpsys 兜底路径才提供；走 cmd display 主路径时为 null，不显示
      const stack = s.stack === null || s.stack === undefined ? '' : `stack=${s.stack}  `;
      const src = d.source === 'dumpsys' ? '  [dumpsys 兜底]' : '';
      console.log(`  #${s.logicalId}  ${stateIcon(s.state)} (${s.state})  ` +
        `${s.width}x${s.height} @${s.density}dpi  ${s.renderFrameRate}fps  ` +
        `${stack}sfId=${s.surfaceFlingerId}${s.isFirst ? '  [主屏]' : ''}${src}`);
    }
    if (d.source) console.log(`\n  （屏信息来自 ${d.source}${d.source === 'cmd-display' ? '：机器可读，2 行' : '：人类可读转储，兜底路径'}）`);
  },

  async tree(dev, opts) {
    const t = await uiTree(dev, { asRoot: opts.root, keepFile: opts.keep });
    if (opts.json) {
      const out = { ...t };
      delete out.xml;
      // uiTree 已经算好 targets（内部 toTargets(parsed)，传的是解析结果对象）。
      // 这里**不要再调一次 toTargets** —— 旧代码写的是 `toTargets(t.nodes)`，
      // 传进去的是节点数组而不是解析结果对象，于是 toTargets 里 `parsed.nodes`
      // 为 undefined，`for...of undefined` 直接抛 TypeError（PR #11 第三轮 B2）。
      delete out.nodes;
      return jout(out);
    }
    if (!t.ok) {
      console.log(`无障碍树读取失败: ${t.error}`);
      if (t.raw) console.log(`原始输出: ${t.raw}`);
      process.exitCode = 2;
      return;
    }
    const u = t.usefulness;
    console.log(`节点数: ${t.nodeCount}   旋转: ${t.rotation}   XML: ${t.xmlBytes} B   耗时: ${t.elapsedMs} ms`);
    console.log(`可用性: ${u.useful ? '可用' : '不可用'}   ` +
      `有标签 ${u.labelledCount}   可操作 ${u.actionableCount}` +
      (u.reason ? `\n  原因: ${u.reason}` : ''));
    const labelled = t.nodes.filter((n) => labelOf(n));
    if (labelled.length) {
      console.log('\n带文字/描述的节点:');
      for (const n of labelled.slice(0, 60)) {
        const b = n.bounds;
        console.log(`  [${String(b?.cx ?? '?').padStart(5)},${String(b?.cy ?? '?').padStart(5)}] ` +
          `${n.clickable ? '可点' : '    '} ${JSON.stringify(labelOf(n))}` +
          `${n.resourceId ? '  id=' + n.resourceId : ''}`);
      }
      if (labelled.length > 60) console.log(`  ... 另有 ${labelled.length - 60} 个`);
    }
  },

  async ocr(dev, opts) {
    const shot = await screenshot(dev, { savePath: opts.out ? path.join(opts.out, `screen-${Date.now()}.png`) : undefined });
    if (!shot.isPng) {
      console.error('截图数据损坏(PNG 头校验失败)');
      process.exitCode = 3;
      return;
    }
    const ocr = await ocrImage(shot.file, { lang: opts.lang });
    if (opts.json) return jout({ image: shot, ocr });
    console.log(`截图: ${shot.width}x${shot.height}  ${(shot.bytes / 1024).toFixed(0)} KB  ${shot.captureMs} ms  -> ${shot.file}`);
    if (!ocr.ok) {
      console.log(`OCR 失败: ${ocr.error} ${ocr.detail || ''}`);
      process.exitCode = 3;
      return;
    }
    console.log(`OCR: 引擎=${ocr.engine}  ${ocr.lines.length} 行 / ${ocr.words.length} 词  ${ocr.elapsedMs} ms`);
    console.log('');
    for (const l of ocr.lines) {
      console.log(`  [${String(l.x).padStart(5)},${String(l.y).padStart(5)} ${String(l.w).padStart(4)}x${String(l.h).padEnd(4)}]  ${l.text}`);
    }
  },

  async targets(dev, opts) {
    const r = await observe(dev, {
      displayId: opts.display ?? 0, asRoot: opts.root,
      wantImage: true, wantOcr: true, wantTree: true, ocrLang: opts.lang,
    });
    const list = dedupeTargets(r.targets);
    if (opts.json) return jout(list);
    printTargets(list, { limit: opts.limit });
  },

  async observe(dev, opts) {
    const r = await observe(dev, {
      displayId: opts.display ?? 0, asRoot: opts.root,
      wantImage: true, wantOcr: true, wantTree: true, ocrLang: opts.lang,
    });
    if (opts.jsonFile) {
      // 中文输出走控制台会被 Windows 代码页破坏, 落盘则一定是干净的 UTF-8
      fs.writeFileSync(opts.jsonFile, JSON.stringify(r, null, 2), 'utf8');
    }
    if (opts.json) return jout(r);
    printObservation(r, opts);
  },

  // 独立进程服务: 逐行 JSON over stdin/stdout
  //
  // 这是给 harness 用的稳定契约。刻意不绑任何具体 harness ——
  // 现在 DSH 通过一个薄适配器调它, 将来换自研 harness 用同一个协议,
  // 识别层一行不动(设计纪律 docs/mobile-control-layer-design.md §2)。
  //
  // 协议: 每行一个 JSON 请求, 每行一个 JSON 响应。请求:
  //   {"id":1,"op":"ping"}
  //   {"id":2,"op":"displays"}
  //   {"id":3,"op":"tree",   "displayId":0,"root":false}
  //   {"id":4,"op":"ocr",    "displayId":0,"lang":"zh-Hans-CN"}
  //   {"id":5,"op":"observe","displayId":0,"tree":true,"image":true,"ocr":true}
  //   {"id":6,"op":"targets","displayId":0}
  //   {"id":7,"op":"shutdown"}

  async serve(dev, opts) {    const readline = await import('node:readline');
    const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
    const logErr = (s) => process.stderr.write(s + '\n');

    logErr('[serve] 识别服务已就绪, 等待逐行 JSON 请求');
    out({ type: 'ready', schema: 'mobile-recognize/ipc@1', pid: process.pid });

    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let req;
      try {
        req = JSON.parse(trimmed);
      } catch (e) {
        out({ ok: false, error: 'bad-json', detail: String(e.message) });
        continue;
      }

      const id = req.id ?? null;
      const op = req.op || req.cmd;
      const t0 = Date.now();

      try {
        let result;
        switch (op) {
          case 'ping':
            result = { pong: true, pid: process.pid, at: new Date().toISOString() };
            break;
          case 'displays':
            result = await getDisplays(dev);
            break;
          case 'tree': {
            const t = await uiTree(dev, { asRoot: !!req.root, keepFile: false });
            if (t.ok) {
              result = {
                ok: true, rotation: t.rotation, nodeCount: t.nodeCount,
                xmlBytes: t.xmlBytes, usefulness: t.usefulness,
                targets: t.targets, elapsedMs: t.elapsedMs,
                labelled: t.nodes.filter((n) => labelOf(n)).map((n) => ({
                  text: n.text, desc: n.desc, resourceId: n.resourceId,
                  className: n.className, bounds: n.bounds,
                  clickable: n.clickable, depth: n.depth,
                })),
              };
            } else {
              result = { ok: false, error: t.error, raw: t.raw };
            }
            break;
          }
          case 'ocr': {
            // M5（第三轮审阅）: 这里原来写的是
            //     screenshot(dev, { savePath: req.savePath })
            // 两个问题：
            //   1. `displayId` 被**静默忽略** —— 协议文档 :164 写了
            //      {"op":"ocr","displayId":0}，但永远截默认屏。请求副屏时静默给主屏的图。
            //   2. `savePath` 未经任何校验直入 observe.mjs 的 fs.writeFileSync ——
            //      stdio 对端可以指定本机任意可写路径覆盖文件。
            //      对照 lib/device.mjs 的 removeDeviceFile 做了 DEVICE_TMP 前缀校验：
            //      **设备侧有约束，PC 侧反过来没有**。
            const sfId = await resolveSurfaceFlingerId(dev, req.displayId);
            const savePath = resolveSavePath(req.savePath, opts.out);
            const shot = await screenshot(dev, { surfaceFlingerId: sfId, savePath });
            if (!shot.isPng) { result = { ok: false, error: 'png-invalid' }; break; }
            const ocr = await ocrImage(shot.file, { lang: req.lang });
            result = { ok: ocr.ok, image: shot, ocr, displayId: req.displayId ?? 0, surfaceFlingerId: sfId };
            break;
          }
          case 'observe': {
            const r = await observe(dev, {
              displayId: req.displayId ?? 0, asRoot: !!req.root,
              wantTree: req.tree !== false,
              wantImage: req.image !== false,
              wantOcr: req.ocr !== false,
              ocrLang: req.lang,
            });
            result = r;
            break;
          }
          case 'targets': {
            const r = await observe(dev, {
              displayId: req.displayId ?? 0, asRoot: !!req.root,
              wantImage: true, wantOcr: true, wantTree: true, ocrLang: req.lang,
            });
            result = { ok: true, targets: r.targets, deduped: dedupeTargets(r.targets),
              displayState: r.displayState, freshness: r.freshness };
            break;
          }
          case 'shutdown':
            out({ id, ok: true, op, result: { bye: true } });
            rl.close();
            process.exit(0);
            break;
          default:
            out({ id, ok: false, op, error: 'unknown-op',
              detail: `支持: ping/displays/tree/ocr/observe/targets/shutdown` });
            continue;
        }
        out({ id, ok: true, op, ms: Date.now() - t0, result });
      } catch (e) {
        out({ id, ok: false, op, ms: Date.now() - t0, error: 'exception',
          detail: String(e.message || e) });
      }
    }
    logErr('[serve] stdin 关闭, 退出');
  },

  async selftest() {    let pass = 0, fail = 0;
    const t = (name, fn) => {
      try { fn(); console.log(`  [ OK ] ${name}`); pass++; }
      catch (e) { console.log(`  [FAIL] ${name}: ${e.message}`); fail++; }
    };
    const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m || ''} 期望 ${JSON.stringify(b)}, 得到 ${JSON.stringify(a)}`); };

    console.log('uitree 解析器自检');
    t('bounds 解析', () => eq(parseUiXml('<hierarchy><node bounds="[1,2][11,22]"/></hierarchy>').nodes[0].bounds,
      { left: 1, top: 2, right: 11, bottom: 22, width: 10, height: 20, cx: 6, cy: 12 }));

    const xml = `<hierarchy rotation="0">
      <node index="0" text="" class="android.widget.FrameLayout" package="p" clickable="false" enabled="true" bounds="[0,0][100,200]">
        <node index="0" text="设置" class="android.widget.TextView" package="p" clickable="false" enabled="true" bounds="[10,10][90,50]"/>
        <node index="1" text="确定" class="android.widget.Button" package="p" clickable="true" enabled="true" bounds="[10,60][90,100]"/>
        <node index="2" text="禁用" class="android.widget.Button" package="p" clickable="true" enabled="false" bounds="[10,110][90,150]"/>
      </node></hierarchy>`;
    t('节点数与层级', () => {
      const p = parseUiXml(xml);
      eq(p.nodes.length, 4, '节点数');
      eq(p.nodes[1].depth, 1, '子节点 depth');
      eq(p.nodes[0].childrenIndices, [1, 2, 3], 'children');
    });
    t('实体解码', () => eq(parseUiXml('<hierarchy><node text="a&amp;b&lt;c"/></hierarchy>').nodes[0].text, 'a&b<c'));
    t('可点祖先链', () => {
      const p = parseUiXml(xml);
      eq(p.nodes[1].clickableAncestorIndices, [], '父节点不可点时为空');
    });
    t('可点祖先被正确串联', () => {
      const x = '<hierarchy><node clickable="true" bounds="[0,0][10,10]"><node text="子" clickable="false" bounds="[0,0][5,5]"/></node></hierarchy>';
      const p = parseUiXml(x);
      eq(p.nodes[1].clickableAncestorIndices, [0]);
    });
    t('targets 默认排除 disabled', () => {
      const p = parseUiXml(xml);
      const tg = toTargets(p);
      eq(tg.map((x) => x.text), ['确定'], '只剩 enabled 的按钮');
    });
    t('targets 能通过可点祖先找到目标', () => {
      const x2 = '<hierarchy><node clickable="true" bounds="[0,0][100,100]"><node text="子项" clickable="false" enabled="true" bounds="[10,10][90,50]"/></node></hierarchy>';
      const tg = toTargets(parseUiXml(x2));
      eq(tg.length, 1, '子项应作为目标出现');
      eq(tg[0].viaAncestor !== null, true, '应标注走的是可点祖先');
      eq(tg[0].label, '子项');
    });
    t('无用树判定', () => {
      const p = parseUiXml('<hierarchy><node class="android.view.SurfaceView" clickable="false" bounds="[0,0][10,10]"/></hierarchy>');
      eq(isUsefulTree(p).useful, false);
    });
    t('空树判定', () => {
      const p = parseUiXml('<hierarchy></hierarchy>');
      eq(isUsefulTree(p).useful, false);
    });

    console.log('\n合并逻辑自检');
    t('OCR 文字与树节点重合时提升可信度', () => {
      const m = mergeObservations({
        targets: [{ label: '设置', text: '设置', bounds: { left: 10, top: 10, right: 90, bottom: 50, width: 80, height: 40, cx: 50, cy: 30 } }],
        ocrLines: [{ text: '设置', x: 12, y: 12, w: 70, h: 30 }],
      });
      eq(m.length, 1, '不重复输出');
      eq(m[0].source, 'both');
    });
    t('OCR 独有文字被补上', () => {
      const m = mergeObservations({
        targets: [],
        ocrLines: [{ text: '图上的字', x: 5, y: 5, w: 50, h: 20 }],
      });
      eq(m.length, 1);
      eq(m[0].source, 'image');
      eq(m[0].center, { x: 30, y: 15 });
    });

    console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
    if (fail) process.exitCode = 1;
  },
};

// ── 去重 ──────────────────────────────────────────────────
/**
 * 合并指向同一目标的重叠条目。
 *
 * 为什么需要: 一个图标在无障碍树里通常是三层 —— 外层 FrameLayout(可点,
 * 标签="文件夹：X")、中间 ImageView、内层 TextView(标签="X")。它们中心点
 * 几乎重合, 会被当成三个独立目标。不处理的话调用方会以为有三个东西可以点。
 *
 * 规则: 中心点距离小于较小者的短边时视为同一目标; 优先保留可点的、
 * 标签更长的(通常是外层容器, 语义更完整)。
 */
function dedupeTargets(targets) {
  const kept = [];
  for (const t of targets) {
    if (!t.center) { kept.push(t); continue; }
    const dup = kept.find((k) => {
      if (!k.center) return false;
      const dx = Math.abs(k.center.x - t.center.x);
      const dy = Math.abs(k.center.y - t.center.y);
      const shortK = Math.min(k.bounds?.width || 0, k.bounds?.height || 0);
      const shortT = Math.min(t.bounds?.width || 0, t.bounds?.height || 0);
      const tol = Math.max(8, Math.min(shortK, shortT) * 0.5);
      return dx <= tol && dy <= tol;
    });
    if (!dup) { kept.push(t); continue; }

    // 谁更该留下: 可点 > 不可点; 其次标签更长(语义更完整); 再次来源更硬
    const score = (x) =>
      (x.clickable === true ? 4 : 0) +
      (x.source === 'both' ? 2 : x.source === 'tree' ? 1 : 0) +
      Math.min(3, (x.label || '').length / 8);
    if (score(t) > score(dup)) {
      // 保留新的, 但把旧的独有信息(可点祖先)带过来
      t.mergedFrom = [...(dup.mergedFrom || [{ label: dup.label, source: dup.source }]),
        { label: t.label, source: t.source }];
      kept[kept.indexOf(dup)] = t;
    } else {
      dup.mergedFrom = [...(dup.mergedFrom || [{ label: dup.label, source: dup.source }]),
        { label: t.label, source: t.source }];
    }
  }
  return kept;
}

// ── 输出格式 ──────────────────────────────────────────────
function printObservation(r, opts = {}) {
  console.log('═══ 观察结果 ═══');
  console.log(`时刻:        ${r.at}`);
  console.log(`屏状态:      ${r.displayState} (${stateIcon(r.displayState)})   唤醒: ${r.wakefulness}`);
  console.log(`屏:          ${r.display ? `${r.display.width}x${r.display.height} @${r.display.density}dpi` : '未知'}`);
  console.log(`耗时:        ${r.totalMs} ms   树 ${r.freshness.treeCapturedAt ? '已取' : '未取'}   图 ${r.freshness.imageCapturedAt ? '已取' : '未取'}`);

  if (r.warnings.length) {
    console.log('\n⚠ 警告:');
    for (const w of r.warnings) console.log(`  · ${w}`);
  }
  if (r.errors.length) {
    console.log('\n✗ 错误:');
    for (const e of r.errors) console.log(`  · [${e.stage}] ${e.error}${e.detail ? ' — ' + e.detail : ''}`);
  }

  if (r.tree?.ok) {
    const u = r.tree.usefulness;
    console.log(`\n无障碍树: ${r.tree.nodeCount} 节点, ${u.labelledCount} 有标签, ${u.actionableCount} 可操作 ` +
      `-> ${u.useful ? '可用' : '不可用'}`);
    if (u.reason) console.log(`  ${u.reason}`);
  } else if (r.tree) {
    console.log(`\n无障碍树: 失败 (${r.tree.error})`);
  }

  if (r.ocr?.ok) {
    console.log(`图像识别: ${r.ocr.lineCount} 行 / ${r.ocr.wordCount} 词  引擎=${r.ocr.engine}  ${r.ocr.elapsedMs} ms`);
  } else if (r.ocr) {
    console.log(`图像识别: 失败 (${r.ocr.error})`);
  }

  const uniq = dedupeTargets(r.targets);
  console.log(`\n目标: ${r.targets.length} 原始 -> ${uniq.length} 去重后`);
  printTargets(uniq, { limit: opts.limit, section: opts.section });
}

function printTargets(targets, { limit, section } = {}) {
  if (!targets || !targets.length) {
    console.log('  (无可操作目标)');
    return;
  }
  const bySource = { tree: 0, both: 0, image: 0 };
  for (const t of targets) bySource[t.source] = (bySource[t.source] || 0) + 1;

  let list = targets;
  if (section) list = list.filter((t) => t.source === section);

  console.log('标签                      来源    可信度  可点  中心坐标            资源id/类名');
  console.log('─'.repeat(100));
  const shown = limit ? list.slice(0, limit) : list;
  for (const t of shown) {
    const label = (t.label || '(无标签)').slice(0, 22);
    const src = ({ tree: '树', both: '树+图', image: '图' })[t.source] || t.source;
    const c = t.center ? `${String(t.center.x).padStart(5)},${String(t.center.y).padStart(5)}` : '    ?,    ?';
    const clk = t.clickable === true ? '是' : (t.clickable === null ? '?' : '否');
    const extra = t.resourceId || t.className || '';
    console.log(`  ${label.padEnd(22)}  ${src.padEnd(6)}  ${String(t.confidence).padEnd(6)}  ${clk.padEnd(4)}  ${c}   ${extra}`);
  }
  if (limit && list.length > limit) console.log(`  ... 另有 ${list.length - limit} 个 (用 --limit 调整)`);
  console.log('');
  console.log(`按来源: 树 ${bySource.tree}  树+图 ${bySource.both}  图 ${bySource.image}`);
}

// ── main ──────────────────────────────────────────────────
async function main() {
  const argv = process.argv.slice(2);
  const opts = parseArgs(argv);
  const cmd = opts._[0] || 'observe';

  if (!commands[cmd]) {
    console.error(`未知子命令: ${cmd}`);
    console.error('可用: ' + Object.keys(commands).join(', '));
    process.exitCode = 1;
    return;
  }

  // selftest 不需要设备
  if (cmd === 'selftest') {
    await commands.selftest();
    return;
  }

  let dev;
  try {
    dev = new Device({ adbPath: opts.adb, serial: opts.serial });
  } catch (e) {
    if (e instanceof AdbError) {
      console.error(e.message);
      process.exitCode = 4;
      return;
    }
    throw e;
  }

  try {
    await commands[cmd](dev, opts);
  } catch (e) {
    if (e instanceof AdbError) {
      console.error(`adb 错误: ${e.message}`);
      if (e.stderr) console.error(String(e.stderr).slice(0, 500));
      process.exitCode = 4;
    } else {
      console.error(`失败: ${e.stack || e.message}`);
      process.exitCode = 1;
    }
  }
}

main();
