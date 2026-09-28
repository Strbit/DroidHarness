// 设备侧 Node 自检：验证这台设备上识别所需的原语是否可用
//
// 这个文件的存在意义是**给出正确诊断**。所以它必须走 lib/spawn-env.mjs ——
// 否则在 DSH 那种带 LD_LIBRARY_PATH 的环境下跑, 它会报"uiautomator FAIL",
// 而真实原因是环境被污染, 不是设备不支持。那正是最误导人的诊断。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import { envForCommand, isSystemBinary } from './lib/spawn-env.mjs';

const results = [];
const rec = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '[ OK ]' : '[FAIL]'} ${name}${detail ? '  ' + detail : ''}`);
};
/** 记录一条"预期如此"的观察 —— 不计入失败 */
const note = (name, detail) => {
  results.push({ name, ok: true, expected: true, detail });
  console.log(`[skip] ${name}${detail ? '  ' + detail : ''}`);
};

// 先如实报告环境, 免得排查时忽略这一层
const polluted = !!process.env.LD_LIBRARY_PATH;
console.log(`node-ok ${process.version} ${process.platform}/${process.arch}`);
console.log(`env LD_LIBRARY_PATH=${polluted ? process.env.LD_LIBRARY_PATH : '(未设置)'}`);
console.log('');

/**
 * 统一入口: 系统二进制走 spawn-env 的 env 分类。
 *
 * 注意 encoding 必须显式给: execFileSync 默认返回 **Buffer**, 不是字符串。
 * 需要二进制的调用(screencap)显式传 encoding:'buffer'。
 */
function runSystem(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    ...opts,
    env: envForCommand(cmd, process.env),
  });
}

// 1. screencap 能否出图
try {
  const out = runSystem('/system/bin/screencap', ['-p'],
    { maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' });
  const isPng = out[0] === 0x89 && out[1] === 0x50;
  rec('screencap', isPng, `bytes=${out.length} png=${isPng}`);
} catch (e) {
  rec('screencap', false, e.message.split('\n')[0]);
}

// 2. /data/local/tmp 可写可读
try {
  const p = '/data/local/tmp/rec-selftest.txt';
  fs.writeFileSync(p, 'hello');
  const back = fs.readFileSync(p, 'utf8');
  fs.unlinkSync(p);
  rec('tmpfile', back === 'hello', `echo=${back}`);
} catch (e) {
  rec('tmpfile', false, e.message.split('\n')[0]);
}

// 3. uiautomator dump —— 这是最容易受环境污染的一步
try {
  runSystem('/system/bin/uiautomator', ['dump', '/data/local/tmp/rec-selftest.xml'],
    { stdio: 'ignore', timeout: 25000 });
  const xml = fs.readFileSync('/data/local/tmp/rec-selftest.xml', 'utf8');
  fs.unlinkSync('/data/local/tmp/rec-selftest.xml');
  const hasHier = xml.includes('<hierarchy');
  rec('uitree', hasHier, `bytes=${xml.length} hasHierarchy=${hasHier}`);
} catch (e) {
  const msg = String(e.message || e).split('\n')[0];
  rec('uitree', false, msg);
  // 给出**正确的**归因, 而不是让人去查设备
  if (/CANNOT LINK|libz\.so/i.test(msg) && polluted) {
    console.log('       ↳ 这是动态链接库问题, 且本进程确实带着 LD_LIBRARY_PATH。');
    console.log('       ↳ 而本脚本已按 spawn-env 剔除该变量 —— 若仍失败, 说明分类规则没覆盖这个命令。');
  } else if (/CANNOT LINK|libz\.so/i.test(msg)) {
    console.log('       ↳ 这是动态链接库问题, 但本进程没带 LD_LIBRARY_PATH —— 可能是设备本身缺库。');
  }
}

// 4. dumpsys display 能否枚举出屏（解析交给 lib/displays.mjs）
try {
  const out = runSystem('/system/bin/dumpsys', ['display'], { maxBuffer: 64 * 1024 * 1024 });
  const { parseDisplays } = await import('./lib/displays.mjs');
  let sf = '';
  try { sf = runSystem('/system/bin/dumpsys', ['SurfaceFlinger', '--display-id']); } catch { /* 可选 */ }
  const parsed = parseDisplays({ dumpsysDisplay: out, surfaceFlinger: sf, power: '' });
  rec('displays', !parsed.error && parsed.displays.length > 0,
    parsed.error ? parsed.error : `${parsed.displays.length} 块屏, sfId=${parsed.displays[0].surfaceFlingerId}`);
} catch (e) {
  rec('displays', false, String(e.message).split('\n')[0]);
}

// 5. OCR（预期没有）
// 用 fs 检查而不是 `which` —— Android 上 /system/bin/which 不保证存在,
// 依赖它会让"命令不存在"和"没装 tesseract"混成同一个结论。
const ocrCandidates = ['/system/bin/tesseract', '/system/xbin/tesseract', '/data/adb/modules/*/system/bin/tesseract'];
const ocrFound = ocrCandidates.some((p) => {
  if (p.includes('*')) return false; // 需要 glob, 这里不展开
  try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; }
});
// 设备侧没有 OCR 是**设计如此**(图片路线交给模型视觉), 不是失败项。
// 所以存在时报告为"发现", 不存在时记为 skip —— 都不计入失败。
if (ocrFound) rec('ocr-tesseract', true, '存在（本机额外装了 OCR，可考虑接进来）');
else note('ocr-tesseract', '不存在 —— 符合设计: 图片路线交给模型视觉');

// 6. 回环网络
await new Promise((resolve) => {
  const s = net.connect({ host: '127.0.0.1', port: 3080 }, () => {
    rec('loopback-3080', true);
    s.end();
    resolve();
  });
  s.on('error', () => { rec('loopback-3080', false, 'DSH 未监听 3080（不影响识别）'); resolve(); });
  setTimeout(resolve, 2000);
});

// 汇总: 以退出码表达结论, 便于脚本化
const failed = results.filter((r) => !r.ok).map((r) => r.name);
console.log('');
console.log(`结果: ${results.length - failed.length}/${results.length} 通过` +
  (failed.length ? `  失败: ${failed.join(', ')}` : ''));
process.exit(failed.includes('uitree') || failed.includes('screencap') ? 1 : 0);
