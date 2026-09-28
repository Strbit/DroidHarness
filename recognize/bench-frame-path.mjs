// 帧路径性能量化（本机可测的部分）
//
// 背景: screencap 的 -p 会在设备上做 PNG 编码。如果那个编码是主要开销,
// 换更便宜的传输格式才有意义。本脚本量化"编码"这一侧的代价,
// 并说明哪些数字必须真机才能取。
//
// 注意: 本机 CPU 与手机 SoC 不同, 这里给的是**量级**与**相对关系**,
// 不是设备上的绝对值。需要设备的部分在最后列出。
import zlib from 'node:zlib';
import { promisify } from 'node:util';

const deflate = promisify(zlib.deflate);

// 造一屏典型内容: 1272x2772 RGBA = 14.1 MB 原始像素
const W = 1272, H = 2772, BPP = 4;
const raw = Buffer.alloc(W * H * BPP);

// 模拟"界面"而不是纯色: 大块色区 + 细节噪声。纯色会被压缩到极小,
// 不代表真实界面的编码代价。
let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * BPP;
    const inBlock = ((x >> 4) + (y >> 4)) % 3 === 0;
    const v = inBlock ? 200 : 40;
    raw[i] = v; raw[i + 1] = v; raw[i + 2] = v; raw[i + 3] = 255;
    if (rnd() < 0.02) { raw[i] = 255; raw[i + 1] = 255; raw[i + 2] = 255; }
  }
}
console.log('═══ 测试素材 ═══');
console.log(`  原始像素: ${W}x${H}x${BPP} = ${(raw.length / 1024 / 1024).toFixed(1)} MiB`);

/** 用 zlib 模拟 PNG 的 IDAT 压缩（PNG = 滤波 + zlib deflate） */
async function pngLikeEncode(buf, level) {
  const t0 = process.hrtime.bigint();
  const out = await deflate(buf, { level });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { ms, bytes: out.length, level };
}

console.log('\n═══ PNG 路径的压缩代价（zlib deflate，PNG 的核心开销）═══');
for (const level of [1, 6, 9]) {
  const r = await pngLikeEncode(raw, level);
  console.log(`  level ${level}: ${r.ms.toFixed(0).padStart(5)} ms   ${(r.bytes / 1024 / 1024).toFixed(1)} MiB  ` +
    `(${(r.bytes / raw.length * 100).toFixed(0)}%)`);
}

// JPEG 在 Node 里需要外部库。DSH 应用树里有 sharp，但它是 win32-x64 版；
// 设备侧是 android-arm64 且 README 说 sharp 没有 android 变体。
console.log('\n═══ JPEG 路径能否在本机量化 ═══');
let sharpOk = false;
try {
  const sharp = (await import('sharp')).default;
  const t0 = process.hrtime.bigint();
  const out = await sharp(raw, { raw: { width: W, height: H, channels: BPP } }).jpeg({ quality: 85 }).toBuffer();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`  sharp 可用: JPEG q85 = ${ms.toFixed(0)} ms, ${(out.length / 1024).toFixed(0)} KB`);
  sharpOk = true;
} catch (e) {
  console.log(`  sharp 不可用（${e.code || e.message}）`);
}

console.log('\n═══ 结论 ═══');
console.log('  本机可确定的:');
console.log('    · PNG 的核心开销是 deflate 压缩，level 9 比 level 1 慢很多但只小一点');
console.log('    · 这个开销随像素量线性增长，1272x2772 是 14 MiB 原始数据');
console.log('');
console.log('  必须真机才能确定的（没有设备，不做推测）:');
console.log('    · screencap -p 在设备上的实际耗时（Android 用 skia 编码，可能与 zlib 差很多）');
console.log('    · screencap 无参数输出的原始格式与尺寸（是否 RGBA_8888 紧凑帧）');
console.log('    · 设备上 JPEG 编码器的可用性与耗时（Android 有 Bitmap.compress，但 shell 侧够不着）');
console.log('    · 端到端延迟: 采集 + 传输(adb 或本地) + 交给模型的编码');
console.log('');
console.log('  在缺这些数字之前换传输格式 = 用假设做优化。');
console.log('  所以本次只做"缓存 + 新鲜度标注" —— 它不需要任何未验证的假设，');
console.log('  收益（省掉重复采集）是确定的，代价（可能读到旧帧）已被明确标注。');
