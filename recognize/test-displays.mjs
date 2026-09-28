// displays 解析器自检 —— 跨设备兼容性
//
// 这个测试的核心价值: 覆盖**已知的真实形态差异**, 而不是我编的样本。
// 每条夹具都注明来源, 见 test-fixtures-displays.mjs。
//
// 它要拦住的是 PR #11 第二轮那个跨设备缺陷:
// 原实现只看 OnePlus 专属的 `Display N [id=...]` 形态, Xiaomi 上 grep 命中 0 次,
// 于是 list_displays 整条工具失效。
import fs from 'node:fs';
import {
  parseDisplays, parseDisplayDevices, parseSurfaceFlingerIds,
  parseViewports, parseWakefulness, mergeDisplaySources,
} from './lib/displays.mjs';
import { parseCmdDisplays, parseDisplaysPreferred } from './lib/cmd-display.mjs';
import { ONEPLUS, XIAOMI, VIRTUAL_DISPLAY, MALFORMED, ALL } from './test-fixtures-displays.mjs';

let pass = 0, fail = 0;
const tests = [];
let group = null;
const g = (n) => { group = n; };
const t = (name, fn) => tests.push({ name, fn, group });
const eq = (a, b, m) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${m || ''}: 期望 ${JSON.stringify(b)}, 得到 ${JSON.stringify(a)}`);
  }
};
const ok = (c, m) => { if (!c) throw new Error(m || '断言失败'); };

/** 夹具的 dumpsysDisplay 需要带上 mViewports 行（真实 dump 里它在文件上方） */
function withViewports(fx) {
  if (!fx.viewportsLine) return fx.dumpsysDisplay;
  return fx.dumpsysDisplay + '\n' + fx.viewportsLine + '\n';
}
const parseFixture = (fx) => parseDisplays({
  dumpsysDisplay: withViewports(fx),
  surfaceFlinger: fx.surfaceFlinger,
  power: fx.power,
});

g('逐样本：每台真机都要解析出屏');

for (const fx of ALL) {
  if (fx.expect.errorIsNotNull) continue;
  t(`${fx.name}: 解析出 ${fx.expect.count} 块屏`, () => {
    const r = parseFixture(fx);
    eq(r.error, null, '不该报错');
    eq(r.displays.length, fx.expect.count, '屏数');
  });
}

t('OnePlus PLK110: 关键字段全对', () => {
  const r = parseFixture(ONEPLUS);
  const d = r.displays[0];
  eq(d.width, ONEPLUS.expect.firstWidth);
  eq(d.height, ONEPLUS.expect.firstHeight);
  eq(d.logicalId, ONEPLUS.expect.firstLogicalId);
  eq(d.surfaceFlingerId, ONEPLUS.expect.defaultSurfaceFlingerId);
  eq(d.state, ONEPLUS.expect.firstNativeState);
  eq(r.wakefulness, ONEPLUS.expect.wakefulness);
  eq(r.defaultSurfaceFlingerId, ONEPLUS.expect.defaultSurfaceFlingerId);
  ok(d.isFirst, '应标为默认屏');
});

t('Xiaomi 25102RKBEC: 关键字段全对（这正是上一版失效的设备）', () => {
  const r = parseFixture(XIAOMI);
  eq(r.error, null, '不该报错 —— 上一版在这里报"解析不出任何屏"');
  const d = r.displays[0];
  eq(d.width, XIAOMI.expect.firstWidth);
  eq(d.height, XIAOMI.expect.firstHeight);
  eq(d.logicalId, XIAOMI.expect.firstLogicalId);
  eq(d.surfaceFlingerId, XIAOMI.expect.defaultSurfaceFlingerId);
  eq(d.state, XIAOMI.expect.firstNativeState);
  eq(r.wakefulness, XIAOMI.expect.wakefulness);
});

t('Xiaomi 上不含 OnePlus 专属形态，但解析照常工作', () => {
  // 审阅原文: grep -c 'Display [0-9]* \[id=' = 0
  const hits = (XIAOMI.dumpsysDisplay.match(/Display [0-9]+ \[id=/g) || []).length;
  eq(hits, 0, '夹具里本就不该有这种行');
  const r = parseFixture(XIAOMI);
  ok(r.displays.length > 0, '即便如此也要能解析出屏 —— 这就是本次修复的核心');
});

g('多屏与虚拟副屏');

t('能枚举出虚拟副屏，且 logicalId/sfId 都对', () => {
  const r = parseFixture(VIRTUAL_DISPLAY);
  eq(r.displays.length, 2);
  const virt = r.displays.find((d) => d.logicalId === VIRTUAL_DISPLAY.expect.virtualLogicalId);
  ok(virt, '应能按 logicalId 找到副屏');
  eq(virt.surfaceFlingerId, VIRTUAL_DISPLAY.expect.virtualSfId);
  eq(virt.width, VIRTUAL_DISPLAY.expect.virtualWidth);
  eq(virt.type, 'VIRTUAL');
  ok(!virt.isFirst, '副屏不该被当成默认屏');
});

t('默认屏仍是主屏（不是副屏）', () => {
  const r = parseFixture(VIRTUAL_DISPLAY);
  eq(r.defaultSurfaceFlingerId, VIRTUAL_DISPLAY.expect.defaultSurfaceFlingerId);
  const first = r.displays.find((d) => d.isFirst);
  eq(first.logicalId, 0);
});

g('裸 state= 污染：必须锚定 mState=');

t('历史 BrightnessEvent 里的 state=OFF/DOZE/ON 不污染真实状态', () => {
  const r = parseFixture(VIRTUAL_DISPLAY);
  for (const d of r.displays) {
    eq(d.state, 'ON', `${d.name} 的真实状态应是 ON；被历史行污染会变成 OFF/DOZE`);
  }
});

t('夹具里确实存在裸 state= 噪声（证明这条测试有意义）', () => {
  const noise = (VIRTUAL_DISPLAY.dumpsysDisplay.match(/\bstate=[A-Z_]+/g) || []);
  // 3 条历史 + 2 条 DisplayDeviceInfo 内的 state=（后者也不是 mState）
  ok(noise.length >= 3, `应有裸 state= 噪声，实际 ${noise.length} 条`);
  const mstate = (VIRTUAL_DISPLAY.dumpsysDisplay.match(/mState=/g) || []);
  eq(mstate.length, 2, 'mState= 应只有每块屏一条');
});

t('解析器不用裸 state= 兜底（mState 缺失时宁可为 null）', () => {
  const noMstate = `Display Devices: size=1
  DisplayDeviceInfo{"内置屏幕": uniqueId="local:111", 1080 x 2400, modeId 1, renderFrameRate 60.0, density 420, touch INTERNAL, rotation 0, type INTERNAL, state ON, committedState ON}
---------------
`;
  const r = parseDisplays({ dumpsysDisplay: noMstate, surfaceFlinger: '', power: '' });
  eq(r.displays.length, 1, '应解析出屏');
  eq(r.displays[0].state, null, 'mState 缺失时必须为 null，不能用 DisplayDeviceInfo 里的 state 冒充');
});

g('解析不出来要报错，不许兜底');

t('无 DisplayDeviceInfo 时返回明确 error 且屏列表为空', () => {
  const r = parseFixture(MALFORMED);
  ok(r.error, '必须给出 error');
  ok(/DisplayDeviceInfo/.test(r.error), 'error 应说明期望的形态，便于排查');
  eq(r.displays.length, 0, '不能兜底编造一块屏');
  eq(r.defaultSurfaceFlingerId, null);
});

t('空输入不炸', () => {
  const r = parseDisplays({ dumpsysDisplay: '', surfaceFlinger: '', power: '' });
  ok(r.error, '空输入应报错');
  eq(r.displays, []);
});

t('缺少 SurfaceFlinger/power 时仍能解析屏（降级而非失败）', () => {
  const r = parseDisplays({ dumpsysDisplay: withViewports(ONEPLUS), surfaceFlinger: '', power: '' });
  eq(r.error, null, '缺这两段不该整体失败');
  eq(r.displays.length, 1);
  ok(r.displays[0].surfaceFlingerId, 'sfId 来自 uniqueId 前缀，不依赖 SurfaceFlinger 段');
  eq(r.wakefulness, null, 'power 缺失时唤醒状态为 null');
});

g('子解析器单测');

t('parseSurfaceFlingerIds: 多屏', () => {
  eq(parseSurfaceFlingerIds(VIRTUAL_DISPLAY.surfaceFlinger),
    [{ surfaceFlingerId: '4630946903293830803', hwcDisplay: 0 },
      { surfaceFlingerId: '9999999999999999999', hwcDisplay: 1 }]);
});

t('parseSurfaceFlingerIds: 空输入返回空数组', () => {
  eq(parseSurfaceFlingerIds(''), []);
  eq(parseSurfaceFlingerIds(null), []);
});

t('parseViewports: uniqueId -> logicalId 映射', () => {
  const m = parseViewports(VIRTUAL_DISPLAY.viewportsLine);
  eq(m.get('local:4630946903293830803'), 0);
  eq(m.get('local:9999999999999999999'), 2);
});

t('parseWakefulness: 锚定 mWakefulness=', () => {
  eq(parseWakefulness('mWakefulness=Dozing\nmWakefulnessChanging=false'), 'Dozing');
  eq(parseWakefulness('mWakefulnessChanging=false'), null, '不该被 Changing 行误导');
  eq(parseWakefulness(''), null);
});

t('parseDisplayDevices: 段外的 DisplayDeviceInfo 不被误收', () => {
  const text = `${ONEPLUS.dumpsysDisplay}
Some Later Section:
  DisplayDeviceInfo{"不该被收进来": uniqueId="local:777", 100 x 100, modeId 1, renderFrameRate 60.0}
`;
  const devs = parseDisplayDevices(text);
  eq(devs.length, 1, '只应收到 Display Devices 段内的那一块');
  eq(devs[0].uniqueId, 'local:4630946903293830803');
});

t('localId 从 uniqueId 前缀推导（screencap -d 要的就是它）', () => {
  const r = parseFixture(ONEPLUS);
  eq(r.displays[0].localId, '4630946903293830803');
  eq(r.displays[0].surfaceFlingerId, r.displays[0].localId, 'sfId 与 localId 一致');
});

t('拿不到 viewports 时 isFirst 退回"第一块"并如实标注', () => {
  const r = parseDisplays({ dumpsysDisplay: ONEPLUS.dumpsysDisplay, surfaceFlinger: '', power: '' });
  eq(r.displays.length, 1);
  eq(r.displays[0].logicalId, null, '无 viewports 时 logicalId 为 null');
  ok(r.displays[0].isFirst, '拿不到逻辑 id 时退回第一块');
  eq(r.defaultSurfaceFlingerId, '4630946903293830803');
});

t('mergeDisplaySources: 不修改输入对象', () => {
  const devices = parseDisplayDevices(ONEPLUS.dumpsysDisplay);
  const before = JSON.stringify(devices);
  mergeDisplaySources({ devices, viewports: parseViewports(ONEPLUS.viewportsLine), sfIds: [] });
  eq(JSON.stringify(devices), before, 'merge 不该就地改动 devices');
});

t('夹具字段顺序与真机一致：DisplayDeviceInfo 在 mState 之前', () => {
  // 真机样本: OnePlus 行 75 = DisplayDeviceInfo, 行 95 = mState
  // 如果夹具顺序反了, 测试会"通过"但测的不是真机形态 —— 这本身是个陷阱
  for (const fx of [ONEPLUS, XIAOMI]) {
    const di = fx.dumpsysDisplay.indexOf('DisplayDeviceInfo{');
    const ms = fx.dumpsysDisplay.indexOf('mState=');
    ok(di >= 0 && ms >= 0, `${fx.name} 应同时含两者`);
    ok(di < ms, `${fx.name}: DisplayDeviceInfo(位置 ${di}) 必须在 mState(位置 ${ms}) 之前`);
  }
});

t('mState 在 DisplayDeviceInfo 之前时不猜状态（如实为 null）', () => {
  // 两台真机（OnePlus / Xiaomi）都是 mState 在 DisplayDeviceInfo **之后**。
  // "之前"这个形态**没有观察到**, 所以不为它加投机代码。
  // 这里锁定期望行为: 那种情况下 state 为 null —— 而不是去猜、或退回去抓裸 state=。
  // 好处是失败是**可见的**: 调用方看到 state 为 null 就知道要查, 不会拿到错状态。
  const reversed = `Display Devices: size=1
  mState=DOZE
  DisplayDeviceInfo{"内置屏幕": uniqueId="local:555", 1080 x 2400, modeId 1, renderFrameRate 60.0, density 420, touch INTERNAL, rotation 0, type INTERNAL}
---------------
`;
  const r = parseDisplays({ dumpsysDisplay: reversed, surfaceFlinger: '', power: '' });
  eq(r.displays.length, 1, '仍应解析出这块屏（降级而非失败）');
  eq(r.displays[0].state, null, '未观察到的顺序不给状态 —— 宁可为 null 也不猜');
});

g('对真机原始 dump 的回归（夹具若偏离现实，这里会失败）');

// 夹具走**仓库内相对路径**，且缺文件时 fail（PR #11 第三轮 M2）：
//   · 旧版硬编码了开发机绝对路径（违反"不硬编码"纪律），而夹具没进仓库 ——
//     于是文件永远不存在、测试永远走 `return` 然后计为 [ OK ]，
//     28 项通过里含一条空跑，而 README 把这条测试写成"夹具再偏离现实也会被发现"的对策。
//   · 现在夹具在 recognize/fixtures/，缺文件就是**真的坏了**，必须报出来。
const FIXTURE_DIR = new URL('./fixtures/', import.meta.url);
const fx = (name) => new URL(name, FIXTURE_DIR);

t('夹具文件都在仓库里（缺了就是坏了，不是"跳过"）', () => {
  const required = [
    'oneplus-cmd-display-get-displays.txt',
    'oneplus-dumpsys-display.txt',
    'oneplus-sf-display-id.txt',
    'oneplus-dumpsys-power.txt',
  ];
  for (const name of required) {
    ok(fs.existsSync(fx(name)), `夹具缺失: recognize/fixtures/${name}`);
  }
  console.log(`      （${required.length} 份真机 dump 均在仓库内）`);
});

t('真机 dump 能解析出屏（dumpsys 兜底路径）', () => {
  const r = parseDisplays({
    dumpsysDisplay: fs.readFileSync(fx('oneplus-dumpsys-display.txt'), 'utf8'),
    surfaceFlinger: fs.readFileSync(fx('oneplus-sf-display-id.txt'), 'utf8'),
    power: fs.readFileSync(fx('oneplus-dumpsys-power.txt'), 'utf8'),
  });
  eq(r.error, null, `真机 dump 应能解析, 实际报错: ${r.error}`);
  ok(r.displays.length >= 1, '至少一块屏');
  const d = r.displays[0];
  eq(d.width, 1272, '真机宽度');
  eq(d.height, 2772, '真机高度');
  eq(d.density, 560, '真机密度');
  ok(d.surfaceFlingerId, 'sfId 应解析出来');
  ok(['ON', 'OFF', 'DOZE', 'DOZE_SUSPEND'].includes(d.state), `状态应是合法枚举, 实际 ${d.state}`);
  // 真机里裸 state= 有 100+ 次命中, mState 只有 1 次 —— 状态必须来自后者
  const rawNoise = (fs.readFileSync(fx('oneplus-dumpsys-display.txt'), 'utf8').match(/\bstate=[A-Z_]+/g) || []).length;
  ok(rawNoise > 50, `真机裸 state= 应有大量噪声, 实际 ${rawNoise} —— 若变少说明该测试的假设失效`);
});

t('真机 dump 能解析出屏（cmd-display 主路径）', () => {
  // 主路径新增（第三轮 B1）：`cmd display get-displays` 是机器可读的，
  // 2 行 vs dumpsys 的 985 行，且全文 `state` 只出现 1 次（dumpsys 有 101 处噪声）。
  const ds = parseCmdDisplays(fs.readFileSync(fx('oneplus-cmd-display-get-displays.txt'), 'utf8'));
  eq(ds.length, 1, '真机应有 1 块屏');
  const d = ds[0];
  eq(d.logicalId, 0);
  eq(d.state, 'ON', 'state 必须来自 state 字段，不能撞 committedState');
  eq(d.committedState, 'ON');
  eq(d.surfaceFlingerId, '4630946903293830803', 'uniqueId 去 local: 前缀 = screencap 要的 sfId');
  eq(d.realWidth, 1272); eq(d.realHeight, 2772);
  eq(d.width, 1272, 'app 宽高（逻辑像素）');
  eq(d.height, 2772, 'app 宽高（逻辑像素）');
  eq(d.type, 'INTERNAL');
  eq(d.name, '内置屏幕');
  eq(d.isFirst, true, 'logicalId=0 即默认屏');
});

t('cmd display 的字段正则不能被同行其他字段撞到', () => {
  // 这个 bug 实测踩到过：裸 `\bapp\s+(\d+)x(\d+)` 会先命中
  // `largest app 2772 x 2772`，于是解析出 width=2772 height=2772（错）。
  // 必须用「逗号/行首 + 字段名」锚定。
  const ds = parseCmdDisplays(fs.readFileSync(fx('oneplus-cmd-display-get-displays.txt'), 'utf8'));
  const d = ds[0];
  ok(d.width !== 2772 || d.height !== 2772,
    `width/height 撞到了 largest app: ${d.width}x${d.height}`);
  eq(d.width, 1272, 'width 应是 app 1272（不是 largest app 2772）');
  // real 同理不能被 largestAppWidth 之类干扰
  eq(d.realWidth, 1272);
});

t('cmd display 主路径与 dumpsys 兜底路径结论一致', () => {
  const viaCmd = parseCmdDisplays(fs.readFileSync(fx('oneplus-cmd-display-get-displays.txt'), 'utf8'))[0];
  const viaDumpsys = parseDisplays({
    dumpsysDisplay: fs.readFileSync(fx('oneplus-dumpsys-display.txt'), 'utf8'),
    surfaceFlinger: fs.readFileSync(fx('oneplus-sf-display-id.txt'), 'utf8'),
    power: fs.readFileSync(fx('oneplus-dumpsys-power.txt'), 'utf8'),
  }).displays[0];
  eq(viaCmd.surfaceFlingerId, viaDumpsys.surfaceFlingerId, 'sfId 两条路必须一致');
  eq(viaCmd.state, viaDumpsys.state, 'state 两条路必须一致');
  eq(viaCmd.logicalId, viaDumpsys.logicalId, 'logicalId 两条路必须一致');
});

t('parseDisplaysPreferred: 主路径失效才退回兜底，两条都失效就报错', () => {
  const cmd = fs.readFileSync(fx('oneplus-cmd-display-get-displays.txt'), 'utf8');
  const dd = fs.readFileSync(fx('oneplus-dumpsys-display.txt'), 'utf8');
  const sf = fs.readFileSync(fx('oneplus-sf-display-id.txt'), 'utf8');
  const pw = fs.readFileSync(fx('oneplus-dumpsys-power.txt'), 'utf8');

  const a = parseDisplaysPreferred({ cmdDisplay: cmd, dumpsysDisplay: dd, surfaceFlinger: sf, power: pw }, parseDisplays);
  eq(a.source, 'cmd-display', '有 cmd 输出时应走主路径');
  eq(a.displays.length, 1);

  const b = parseDisplaysPreferred({ cmdDisplay: '', dumpsysDisplay: dd, surfaceFlinger: sf, power: pw }, parseDisplays);
  eq(b.source, 'dumpsys', 'cmd 空时应退回兜底');
  eq(b.displays.length, 1);

  const c = parseDisplaysPreferred({ cmdDisplay: '', dumpsysDisplay: 'garbage', surfaceFlinger: '', power: '' }, parseDisplays);
  eq(c.displays.length, 0, '两条都失效时不能兜底编造屏');
  ok(c.error, '两条都失效必须有明确 error');
  eq(c.source, null);
});

t('面板能力字段齐全（R-6：模型不必自己去挖 dumpsys）', () => {
  // 起因：真机上模型拿到 list_displays 后**又自己跑了一次 dumpsys display 挖了 20KB**，
  // 因为返回里缺 HDR / 亮度 / 色彩模式 / 物理尺寸。这些字段 cmd display 本来就有。
  const d = parseCmdDisplays(fs.readFileSync(fx('oneplus-cmd-display-get-displays.txt'), 'utf8'))[0];
  eq(d.displayGroupId, 0, 'displayGroupId');
  eq(d.colorMode, 0, 'colorMode');
  eq(d.supportedColorModes, [0, 7, 9], 'supportedColorModes');
  eq(d.isForceSdr, false, 'isForceSdr');
  eq(d.canHostTasks, true, 'canHostTasks');
  // installOrientation 是 ROTATION_0 —— 正则用 [A-Z_]+ 会被截成 "ROTATION_"
  eq(d.installOrientation, 'ROTATION_0', 'installOrientation 必须含数字（[A-Z0-9_]+）');
  ok(d.hdrCapabilities, 'hdrCapabilities 应解析出来');
  eq(d.hdrCapabilities.supportedTypes, [1, 2, 3, 4], 'HDR 类型');
  eq(d.hdrCapabilities.maxLuminance, 2000, '峰值亮度');
  eq(d.brightness.minimum, 0.016, '亮度下限');
  eq(d.brightness.maximum, 1, '亮度上限');
  eq(d.brightness.default, 1823.9003, '默认亮度');
  eq(d.realWidth, 1272, '物理宽');
  eq(d.realHeight, 2772, '物理高');
});

t('每块屏都要解析出 name（不能用永不匹配的正则）', () => {
  // 这个 bug 真踩了: name 正则写成了 /DisplayDeviceInfo\s*\{\s*"([^"]*)"/,
  // 但跑它的作用域里 `DisplayDeviceInfo{` 已被剥掉, 于是恒为 null ——
  // 而当时的测试只断言"解析出几块屏", 没查字段值, 所以漏了过去。
  for (const fx of ALL) {
    if (fx.expect.errorIsNotNull) continue;
    const r = parseFixture(fx);
    for (const d of r.displays) {
      ok(d.name, `${fx.name} 的屏 name 不该为 null, 实际 ${JSON.stringify(d.name)}`);
      eq(typeof d.name, 'string');
      ok(d.name.length > 0, 'name 不该是空串');
    }
  }
});

t('name 取自 raw 开头（raw 已不含 DisplayDeviceInfo{ 前缀）', () => {
  const r = parseFixture(ONEPLUS);
  eq(r.displays[0].name, '内置屏幕');
  const r2 = parseFixture(VIRTUAL_DISPLAY);
  eq(r2.displays.find((d) => d.type === 'VIRTUAL').name, 'AgentVirtualDisplay');
});

t('type 不与 deviceProductInfo 混淆', () => {
  // 行内有 deviceProductInfo DeviceProductInfo{...} 这种词, 用 \b 会误命中
  const text = `Display Devices: size=1
-----------------------
  DisplayDeviceInfo{"内置屏幕": uniqueId="local:1", 1080 x 2400, modeId 1, renderFrameRate 60.0, density 420, deviceProductInfo DeviceProductInfo{name=, manufacturerPnpId=QCM}, touch INTERNAL, rotation 0, type INTERNAL}
---------------
`;
  const r = parseDisplays({ dumpsysDisplay: text, surfaceFlinger: '', power: '' });
  eq(r.displays[0].type, 'INTERNAL', 'type 应为 INTERNAL，不该被 deviceProductInfo 干扰');
});

let lastGroup;
for (const { name, fn, group: grp } of tests) {
  if (grp !== lastGroup) {
    console.log(`${lastGroup === undefined ? '' : '\n'}── ${grp ?? '(未分组)'} ──`);
    lastGroup = grp;
  }
  try {
    await fn();
    console.log(`  [ OK ] ${name}`);
    pass++;
  } catch (e) {
    console.log(`  [FAIL] ${name}: ${e.message}`);
    fail++;
  }
}
console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
if (fail) process.exitCode = 1;
