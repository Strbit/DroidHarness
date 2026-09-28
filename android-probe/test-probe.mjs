// test-probe -- 探针输出解析与路径选择的自检
//
// 夹具用**真机实跑的原样输出**（OnePlus PLK110 / Android 16，见 fixtures/）。
// 不手写夹具 —— 手写的会不知不觉偏离真机形态，这一点在前面已经踩过三次。
import fs from 'node:fs';
import {
  parseProbeOutput, toDisplayRecord, preferApiOverText,
  DISPLAY_STATE, DISPLAY_TYPE,
} from './lib/displays-probe.mjs';

const FX = new URL('./fixtures/', import.meta.url);
const fx = (n) => new URL(n, FX);

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

g('夹具与真机输出');

t('真机探针输出的夹具在仓库里', () => {
  for (const n of ['oneplus-probe-list-displays.txt', 'oneplus-probe-error-no-dm.txt']) {
    ok(fs.existsSync(fx(n)), `夹具缺失: android-probe/fixtures/${n}`);
  }
});

t('解析真机输出：OK / SOURCE / COUNT / DISPLAY / END 都在', () => {
  const r = parseProbeOutput(fs.readFileSync(fx('oneplus-probe-list-displays.txt'), 'utf8'));
  eq(r.ok, true);
  eq(r.error, null);
  eq(r.source, 'DisplayManagerGlobal');
  eq(r.count, 1);
  eq(r.displays.length, 1);
});

t('真机字段逐个核对', () => {
  const d = parseProbeOutput(fs.readFileSync(fx('oneplus-probe-list-displays.txt'), 'utf8')).displays[0];
  eq(d.logicalId, 0);
  eq(d.name, '内置屏幕');
  eq(d.uniqueId, 'local:4630946903293830803');
  eq(d.surfaceFlingerId, '4630946903293830803', 'uniqueId 去 local: 前缀');
  eq(d.width, 1272);
  eq(d.height, 2772);
  eq(d.realWidth, 1272);
  eq(d.realHeight, 2772);
  eq(d.density, 476);
  eq(d.rotation, 0);
  eq(d.displayGroupId, 0);
  eq(d.flags, 16515);
  ok(d.isFirst, 'logicalId=0 即默认屏');
  eq(d.source, 'api-probe');
});

g('数字枚举 -> 字符串（两条路径能互换的关键）');

t('state 数字映射成与 dumpsys 路径一致的字符串', () => {
  // API 给 2，dumpsys 给 ON —— 不对齐的话调用方就得为"走哪条路"分叉
  eq(DISPLAY_STATE[2], 'ON');
  eq(DISPLAY_STATE[1], 'OFF');
  eq(DISPLAY_STATE[3], 'DOZE');
  eq(DISPLAY_STATE[4], 'DOZE_SUSPEND');
});

t('真机的 type=1 映射成 INTERNAL（与 cmd display 路径一致）', () => {
  const d = parseProbeOutput(fs.readFileSync(fx('oneplus-probe-list-displays.txt'), 'utf8')).displays[0];
  eq(d.type, 'INTERNAL');
  eq(DISPLAY_TYPE[1], 'INTERNAL');
  eq(DISPLAY_TYPE[5], 'VIRTUAL', '虚拟屏映射为 VIRTUAL');
});

t('出现未知枚举值时如实标注，不编一个已知值', () => {
  const d = toDisplayRecord(7, { state: '99', type: '42' });
  eq(d.state, 'UNKNOWN_99');
  eq(d.type, 'UNKNOWN_42');
});

t('state 字段缺失时为 null（不是编成 ON）', () => {
  const d = toDisplayRecord(0, { name: 'x' });
  eq(d.state, null);
});

g('协议异常：不许静默当成"设备没有屏"');

t('ERROR 行 -> ok=false 且带出来原因', () => {
  const r = parseProbeOutput(fs.readFileSync(fx('oneplus-probe-error-no-dm.txt'), 'utf8'));
  eq(r.ok, false);
  ok(r.error, '必须有 error');
  ok(/no-display-manager/.test(r.error), `error 应含探针的错误码，实际: ${r.error}`);
  eq(r.displays.length, 0);
});

t('既无 OK 也无 ERROR -> 报协议不符', () => {
  const r = parseProbeOutput('这不是探针的输出\n随便几行\n');
  eq(r.ok, false);
  ok(/协议不符/.test(r.error), `应指出协议不符，实际: ${r.error}`);
});

t('COUNT 与实际条数不符 -> 判失败（输出可能被截断）', () => {
  const r = parseProbeOutput('OK|list-displays\nCOUNT|3\nDISPLAY|0|name=a\nEND\n');
  eq(r.ok, false);
  ok(/COUNT=3.*实际给出 1 条/.test(r.error), `应指出数量不符，实际: ${r.error}`);
});

t('空输入 / null 不炸', () => {
  eq(parseProbeOutput('').ok, false);
  eq(parseProbeOutput(null).ok, false);
  ok(parseProbeOutput(null).error);
});

t('字段值里含 = 时只切第一个（值本身可能有等号）', () => {
  const r = parseProbeOutput('OK|x\nCOUNT|1\nDISPLAY|0|name=a=b=c\nEND\n');
  eq(r.displays[0].name, 'a=b=c');
});

t('字段值里的 | 已在探针侧转成 /，不会再被切开', () => {
  // 探针的 kv() 会把 | 替换成 /，所以到这里 DISPLAY 段只有 3 段
  const r = parseProbeOutput('OK|x\nCOUNT|1\nDISPLAY|0|name=a/b|state=2\nEND\n');
  eq(r.displays[0].name, 'a/b');
  eq(r.displays[0].state, 'ON');
});

g('路径选择：API 优先，降级要说清');

t('API 有结果就用 API', () => {
  const r = preferApiOverText(fs.readFileSync(fx('oneplus-probe-list-displays.txt'), 'utf8'),
    () => { throw new Error('不该走到文本路径'); });
  eq(r.source, 'api-probe');
  eq(r.displays.length, 1);
  eq(r.probeSource, 'DisplayManagerGlobal');
});

t('API 失败时退回文本路径，并保留探针的失败原因', () => {
  const r = preferApiOverText('ERROR|no-display-manager|拿不到 DisplayManager',
    () => ({ displays: [{ logicalId: 0, state: 'ON' }], source: 'cmd-display' }));
  eq(r.source, 'cmd-display');
  eq(r.displays.length, 1);
  ok(r.probeError && /no-display-manager/.test(r.probeError), '应保留探针失败原因');
});

t('两条都失败 -> 明确报错，不兜底成"设备没有屏"', () => {
  const r = preferApiOverText('ERROR|no-display-manager|x',
    () => ({ displays: [], error: 'dumpsys 解析不出屏' }));
  eq(r.displays.length, 0);
  ok(r.error, '必须有 error');
  ok(/no-display-manager/.test(r.error), 'API 的原因要在');
  ok(/dumpsys/.test(r.error), '文本路径的原因也要在');
  eq(r.source, null);
});

t('没有文本兜底回调时也不炸', () => {
  const r = preferApiOverText('ERROR|x|y', null);
  eq(r.displays.length, 0);
  ok(r.error);
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
