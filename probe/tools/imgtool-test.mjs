#!/usr/bin/env node
/**
 * imgtool-test.mjs — 证明"设备上的 screen_image 归一化链路"在 PC 上真的能跑通。
 *
 * 背景（这条链路为什么需要一个替身）
 * ----------------------------------
 * Android 上没有 sharp：sharp 0.35.x 的平台包只有 darwin/linux/linuxmusl/
 * freebsd/wasm，`@img/sharp-linux-arm64` 是 glibc/ELF 的，在 bionic 上起不来。
 * 于是 `@deepseek-ai/dsh-attachment-local` 里那句
 * `createLazyRequire("sharp")` 会抛一个没有上下文的裸 Error，被上游包装成
 * "durable image storage rejected" —— 症状像"图不对"，实际是"平台上没有 sharp"。
 *
 * 替身方案 = dsh/shim/sharp-android.js（JS） + tools/imgtool/main.go（纯 Go 静态
 * aarch64 可执行文件）。这个测试就是那份契约的证据：
 *
 *   A 组  Go 工具本身：协议、头部事实（depth/space/像素级 alpha/EXIF orientation）
 *   B 组  **真·attachment-local**（模块应用树里那份）跑完整链路：
 *         准入 → 归一化 → 落盘 → 读回 → 请求图变体
 *         —— 走的是上游自己的 prepareImageFile/commitPreparedImageFile/
 *         readImageFile/readRequestImageFile，不是我们手抄的流程。
 *
 * 覆盖范围要诚实
 * --------------
 *   · 这里跑的是 **Windows 版 imgtool.exe**（同一份 Go 源码交叉编译而来）。
 *     "同一份源码"不等于"同一份二进制"：真机验证仍然必须做（aarch64 + bionic
 *     + KernelSU 的权限/路径）。
 *   · 真机 screencap 出来的 PNG 是 1200x2608 RGBA + iCCP + sBIT，这里按同样的
 *     结构造样本（见 makeShot），但**不是**真机原文件。
 *   · 依赖模块应用树（dsh/module/app/，由 build-dsh-tree.mjs 生成）。树不在时
 *     B 组整个跳过并显式标注 SKIP —— 不让"没跑"伪装成"通过"。
 *
 * 用法: node probe/tools/imgtool-test.mjs
 *       先跑 node dsh/tools/build-imgtool.mjs 生成 .build/imgtool/imgtool.exe
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const APP = path.join(ROOT, 'dsh', 'module', 'app');
const SHIM = path.join(ROOT, 'dsh', 'shim', 'sharp-android.js');
const BUILT = path.join(ROOT, '.build', 'imgtool');
const WORK = path.join(ROOT, '.build', 'imgtool-test');

let pass = 0;
let fail = 0;
let skip = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  [OK]   ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  [FAIL] ${name}${detail ? `\n           ${String(detail).split('\n').slice(0, 5).join('\n           ')}` : ''}`);
  }
}
function skipped(name, why) {
  skip++;
  console.log(`  [SKIP] ${name} — ${why}`);
}

// ── imgtool 可执行文件 ────────────────────────────────────────
function findTool() {
  const cands = [
    process.env.DSH_IMGTOOL,
    path.join(BUILT, 'imgtool.exe'),
    path.join(ROOT, 'tools', 'imgtool', 'imgtool.exe'),
    path.join(BUILT, 'imgtool'),
    path.join(ROOT, 'tools', 'imgtool', 'imgtool'),
  ].filter(Boolean);
  for (const c of cands) if (fs.existsSync(c)) return c;
  return null;
}
const TOOL = findTool();
if (!TOOL) {
  console.error('找不到 imgtool 可执行文件。先跑: node dsh/tools/build-imgtool.mjs');
  process.exit(2);
}
console.log(`imgtool: ${path.relative(ROOT, TOOL)}`);
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });

/** 调一次 imgtool。@returns {{ok:boolean, result?:any, error?:string, raw?:Buffer}} */
function invoke(op, payload, wantBinary = false) {
  const r = spawnSync(TOOL, [], {
    input: JSON.stringify({ op, ...payload }),
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.error) throw r.error;
  const out = r.stdout;
  if (!wantBinary) {
    const text = out.toString('utf8');
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`imgtool ${op} 输出不可解析 (exit ${r.status}): ${text.slice(0, 200)} / ${r.stderr.toString().slice(0, 200)}`);
    }
  }
  const nl = out.indexOf(0x0a);
  const head = JSON.parse(out.subarray(0, nl).toString('utf8'));
  return { ...head, raw: out.subarray(nl + 1) };
}
const b64 = (buf) => Buffer.from(buf).toString('base64');

// ── 样本图构造（纯 Node，不引第三方依赖）───────────────────────
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, body) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length, 0);
  const t = Buffer.from(type, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, body])), 0);
  return Buffer.concat([len, t, body, crc]);
}
const ICCP = chunk('iCCP', Buffer.concat([
  Buffer.from('ICC profile\0', 'latin1'),
  Buffer.from([0]),
  zlib.deflateSync(Buffer.alloc(299, 7)), // 299B ≈ 真机 screencap 的 iCCP 体量
]));
const SBIT = chunk('sBIT', Buffer.from([8, 8, 8, 8]));

/** 组一张 PNG。rows: (x,y,out,offset) 写像素。 */
function makePNG({ width, height, colorType, bitDepth = 8, rows, extraChunks = [] }) {
  const chans = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  const bytesPerSample = bitDepth === 16 ? 2 : 1;
  const stride = 1 + width * chans * bytesPerSample;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter: None
    rows(y, raw, y * stride + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    ...extraChunks,
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 真机 screencap 的结构：RGBA(全不透明) + iCCP + sBIT。 */
function makeShot(width, height, extraChunks = [ICCP, SBIT]) {
  return makePNG({
    width,
    height,
    colorType: 6,
    extraChunks,
    rows: (y, raw, off) => {
      for (let x = 0; x < width; x++) {
        const i = off + x * 4;
        raw[i] = (x * 255) / width; // 平滑渐变: 会让 PNG 压得很小, 但 JPEG 尺寸真实
        raw[i + 1] = (y * 255) / height;
        raw[i + 2] = (((x >> 5) ^ (y >> 5)) & 1) === 0 ? 32 : 200;
        raw[i + 3] = 255;
      }
      // 几块实心矩形, 让画面不是纯渐变（更接近真实截图的 DCT 代价）
      for (let x = 0; x < width; x++) {
        if (y % 97 < 24 && x % 131 < 60) {
          const i = off + x * 4;
          raw[i] = 240;
          raw[i + 1] = 240;
          raw[i + 2] = 240;
        }
      }
    },
  });
}

/** 带真实透明的 RGBA PNG（左上角一块 alpha=0）。 */
function makeTransparentPNG(w = 32, h = 32, extraChunks = []) {
  return makePNG({
    width: w,
    height: h,
    colorType: 6,
    extraChunks,
    rows: (y, raw, off) => {
      for (let x = 0; x < w; x++) {
        const i = off + x * 4;
        raw[i] = 10;
        raw[i + 1] = 200;
        raw[i + 2] = 30;
        raw[i + 3] = x < w / 2 && y < h / 2 ? 0 : 255;
      }
    },
  });
}

/** 灰度 PNG：libvips 会报 space=b-w, 所以不该被"直接放行"。 */
function makeGrayPNG(w = 24, h = 16) {
  return makePNG({
    width: w,
    height: h,
    colorType: 0,
    rows: (y, raw, off) => {
      for (let x = 0; x < w; x++) raw[off + x] = (x * 8 + y * 3) & 0xff;
    },
  });
}

/** 16bit RGB PNG：depth 必须是 ushort, 否则 16bit 会被当成已归一化直接放行。 */
function make16BitPNG(w = 24, h = 16) {
  return makePNG({
    width: w,
    height: h,
    colorType: 2,
    bitDepth: 16,
    rows: (y, raw, off) => {
      for (let x = 0; x < w; x++) {
        const i = off + x * 6;
        raw.writeUInt16BE((x * 2571) & 0xffff, i);
        raw.writeUInt16BE((y * 4113) & 0xffff, i + 2);
        raw.writeUInt16BE(0x8000, i + 4);
      }
    },
  });
}

/** 在 JPEG 的 SOI 之后插入一个只带 Orientation 的 APP1/EXIF 段。 */
function jpegWithOrientation(jpeg, orientation) {
  const tiff = Buffer.alloc(8 + 2 + 12 + 4);
  tiff.write('II', 0, 'latin1');
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4); // IFD0 偏移
  tiff.writeUInt16LE(1, 8); // 一个条目
  tiff.writeUInt16LE(0x0112, 10); // Orientation
  tiff.writeUInt16LE(3, 12); // SHORT
  tiff.writeUInt32LE(1, 14);
  tiff.writeUInt16LE(orientation, 18);
  tiff.writeUInt16LE(0, 20); // 下一个 IFD = 无
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const seg = Buffer.alloc(4);
  seg[0] = 0xff;
  seg[1] = 0xe1;
  seg.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), seg, body, jpeg.subarray(2)]);
}

// 已知可用的 1x1 GIF89a（palette index 0 = 透明）。两个帧拼起来就是动图。
const GIF_1X1 = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
function gifVariant({ frames = 1, transparent = true }) {
  const head = GIF_1X1.subarray(0, 19); // 签名 + LSD + GCT
  const block = Buffer.from(GIF_1X1.subarray(19, 41)); // GCE + 描述符 + LZW 数据
  if (!transparent) block[3] = 0x00; // GCE flags: 去掉"透明色"位
  return Buffer.concat([head, ...Array.from({ length: frames }, () => block), Buffer.from([0x3b])]);
}

// ═══════════════════════════════════════════════════════════
// A 组: Go 工具的事实
// ═══════════════════════════════════════════════════════════
console.log('\n== A 组: imgtool 协议与头部事实 ==');

const shot = makeShot(1200, 2608);
fs.writeFileSync(path.join(WORK, 'shot.png'), shot);
console.log(`  样本 screen.png: ${(shot.length / 1024).toFixed(0)} KiB (1200x2608 RGBA + iCCP + sBIT)`);

const t0 = Date.now();
const shotDetect = invoke('detect', { data: b64(shot) });
const decodeMs = Date.now() - t0;
check('A1 detect 成功且报 format=png', shotDetect.ok && shotDetect.result.format === 'png', JSON.stringify(shotDetect).slice(0, 200));
check('A2 尺寸 1200x2608', shotDetect.result?.width === 1200 && shotDetect.result?.height === 2608, JSON.stringify(shotDetect.result));
check('A3 depth=uchar / space=srgb', shotDetect.result?.depth === 'uchar' && shotDetect.result?.space === 'srgb', JSON.stringify(shotDetect.result));
check(
  'A4 hasAlpha 按像素诚实: RGBA 波段但全不透明 → false（否则会去走没有编码器的 webp 阶梯）',
  shotDetect.result?.hasAlpha === false,
  JSON.stringify(shotDetect.result),
);
check('A5 iCCP 被识别成 icc/hasProfile（归一化绕不过去的原因）', ['icc', 'hasProfile'].every((f) => shotDetect.result?.retained?.includes(f)), JSON.stringify(shotDetect.result?.retained));
check('A6 单帧: pages=1 animated=false', shotDetect.result?.pages === 1 && shotDetect.result?.animated === false);
check('A7 无 EXIF 的图绝不上报 orientation（否则自己的 JPEG 输出会被判成"带元数据"）', shotDetect.result?.orientation === 0, String(shotDetect.result?.orientation));
console.log(`  (1200x2608 PNG 全量解码 ${decodeMs}ms —— 真机同口径下会慢数倍, 记着这个数)`);

const shotNoMeta = makeShot(64, 48, []);
const noMetaDetect = invoke('detect', { data: b64(shotNoMeta) });
check('A8 干净 RGB(A) PNG: retained 为空（该放行的必须放行）', Array.isArray(noMetaDetect.result?.retained) && noMetaDetect.result.retained.length === 0, JSON.stringify(noMetaDetect.result?.retained));

const transparent = makeTransparentPNG();
const transDetect = invoke('detect', { data: b64(transparent) });
check('A9 真透明图: hasAlpha=true（像素级查证）', transDetect.result?.hasAlpha === true, JSON.stringify(transDetect.result));
const transNorm = invoke('normalize', { data: b64(transparent), width: 0, height: 0, qualities: [85] });
check('A10 真透明图 normalize 明确报错, 不静默压平成 JPEG', transNorm.ok === false && /TRANSPARENT|webp/i.test(transNorm.error || ''), JSON.stringify(transNorm).slice(0, 200));

const grayPng = makeGrayPNG();
const grayDetect = invoke('detect', { data: b64(grayPng) });
check('A11 灰度图 space=b-w（与 libvips 一致, 不会被当成已归一化）', grayDetect.result?.space === 'b-w' && grayDetect.result?.channels === 1, JSON.stringify(grayDetect.result));

const png16 = make16BitPNG();
const png16Detect = invoke('detect', { data: b64(png16) });
check('A12 16bit PNG depth=ushort（否则 16bit 会被直接放行）', png16Detect.result?.depth === 'ushort', JSON.stringify(png16Detect.result));

// normalize: 尺寸语义（inside / 单边 / 不放大）+ 阶梯一次算多档
const normT0 = Date.now();
const shotNorm = invoke('normalize', { data: b64(shot), width: 600, height: 1304, qualities: [85, 75, 60], rotate: false });
const normMs = Date.now() - normT0;
check('A13 normalize 一次返回整条阶梯 (3 档)', shotNorm.ok && shotNorm.result.encodings.length === 3, JSON.stringify(shotNorm).slice(0, 200));
check('A14 inside 缩放尺寸正确: 1200x2608 → 600x1304', shotNorm.result?.width === 600 && shotNorm.result?.height === 1304, `${shotNorm.result?.width}x${shotNorm.result?.height}`);
check(
  'A15 阶梯单调: 质量越低字节越少',
  shotNorm.result?.encodings?.[0].bytes > shotNorm.result?.encodings?.[1].bytes && shotNorm.result?.encodings?.[1].bytes > shotNorm.result?.encodings?.[2].bytes,
  JSON.stringify(shotNorm.result?.encodings?.map((e) => [e.quality, e.bytes])),
);
check('A16 产物是 JPEG (SOI FFD8)', Buffer.from(shotNorm.result.encodings[0].data, 'base64').subarray(0, 2).equals(Buffer.from([0xff, 0xd8])));
console.log(`  (600x1304 缩放+三档 JPEG 编码 ${normMs}ms)`);

const single = invoke('normalize', { data: b64(shot), width: 300, height: 0, qualities: [85] });
check('A17 单边 resize({width}) 精确等比: 1200x2608 → 300x652', single.result?.width === 300 && single.result?.height === 652, `${single.result?.width}x${single.result?.height}`);
const enlarge = invoke('normalize', { data: b64(shotNoMeta), width: 4000, height: 4000, qualities: [85] });
check('A18 withoutEnlargement: 64x48 请求放大到 4000 框内 → 尺寸不变', enlarge.result?.width === 64 && enlarge.result?.height === 48, `${enlarge.result?.width}x${enlarge.result?.height}`);

// EXIF orientation: normalize(rotate) 必须真的转
const plainJpeg = invoke('normalize', { data: b64(makeShot(100, 50, [])), width: 0, height: 0, qualities: [90] });
const baseJpeg = Buffer.from(plainJpeg.result.encodings[0].data, 'base64');
const rotJpeg = jpegWithOrientation(baseJpeg, 6);
const rotDetect = invoke('detect', { data: b64(rotJpeg) });
check('A19 EXIF orientation=6 被解出并上报', rotDetect.result?.orientation === 6, JSON.stringify(rotDetect.result));
check('A20 EXIF 存在 → retained 含 exif', rotDetect.result?.retained?.includes('exif'), JSON.stringify(rotDetect.result?.retained));
const rotNorm = invoke('normalize', { data: b64(rotJpeg), width: 0, height: 0, qualities: [90], rotate: true });
check('A21 rotate:true 真的做了旋转 (100x50 → 50x100)', rotNorm.result?.width === 50 && rotNorm.result?.height === 100, `${rotNorm.result?.width}x${rotNorm.result?.height}`);
const noRotNorm = invoke('normalize', { data: b64(rotJpeg), width: 0, height: 0, qualities: [90], rotate: false });
check('A22 rotate:false 不旋转 (request-image 流程不带 .rotate())', noRotNorm.result?.width === 100 && noRotNorm.result?.height === 50, `${noRotNorm.result?.width}x${noRotNorm.result?.height}`);

// raw: 二进制帧 + 像素带宽
const rawShot = invoke('raw', { data: b64(shotNoMeta) }, true);
check('A23 raw 返回真实像素 (64x48, RGBA → 4 波段)', rawShot.ok && rawShot.raw.length === 64 * 48 * 4, `len=${rawShot.raw?.length}`);
check('A24 raw 帧头与体一致', rawShot.result?.bytes === rawShot.raw.length, `${rawShot.result?.bytes} vs ${rawShot.raw.length}`);

// GIF: 帧数（动图判定）
const gifStatic = gifVariant({ frames: 1, transparent: false });
const gifAnim = gifVariant({ frames: 2, transparent: false });
const gifStaticDetect = invoke('detect', { data: b64(gifStatic) });
const gifAnimDetect = invoke('detect', { data: b64(gifAnim) });
check('A25 单帧 GIF: pages=1 animated=false', gifStaticDetect.result?.pages === 1 && gifStaticDetect.result?.animated === false, JSON.stringify(gifStaticDetect.result));
check('A26 双帧 GIF: pages=2 animated=true', gifAnimDetect.result?.pages === 2 && gifAnimDetect.result?.animated === true, JSON.stringify(gifAnimDetect.result));

const corrupt = invoke('detect', { data: b64(shot.subarray(0, 4096)) });
check('A27 截断的 PNG 必须报错（"能解码"这个证明不能放水）', corrupt.ok === false, JSON.stringify(corrupt).slice(0, 160));

// ═══════════════════════════════════════════════════════════
// B 组: 真·attachment-local 端到端
// ═══════════════════════════════════════════════════════════
console.log('\n== B 组: 真实 attachment-local 全链路 ==');

const LIB = path.join(APP, 'node_modules', '@deepseek-ai', 'dsh-attachment-local', 'lib', 'index.js');
if (!fs.existsSync(LIB)) {
  skipped('B 组全部', `模块应用树不在 (${path.relative(ROOT, LIB)})；先跑 node dsh/tools/build-dsh-tree.mjs`);
} else {
  // 在 shim 被加载**之前**包住 child_process.spawn —— shim 是在模块加载时
  // 解构出 spawn 的, 之后再包就晚了。用 createRequire 拿到的是 CJS 的 exports
  // 对象(可写); `await import()` 给的是只读的 ESM 命名空间, 赋值会抛
  // "Cannot assign to read only property"。
  const cp = createRequire(import.meta.url)('node:child_process');
  const realSpawn = cp.spawn;
  let spawnCount = 0;
  cp.spawn = (...args) => {
    spawnCount++;
    return realSpawn(...args);
  };

  // 把替身挂到上游解析 "sharp" 的落点上 —— 等价于装机时 build-dsh-tree 把
  // sharp 包的入口换成这个 shim（上游用的是 createRequire, 走同一份 CJS 缓存）。
  const shim = (await import(pathToFileURL(SHIM).href)).default;
  const pkgRequire = createRequire(LIB);
  const sharpResolved = pkgRequire.resolve('sharp');
  pkgRequire.cache[sharpResolved] = {
    id: sharpResolved,
    filename: sharpResolved,
    loaded: true,
    exports: shim,
    children: [],
    paths: [],
  };
  process.env.DSH_IMGTOOL = TOOL;
  console.log(`  shim 已挂到 ${path.relative(ROOT, sharpResolved)}`);

  const A = await import(pathToFileURL(LIB).href);
  const ROOT_STORE = path.join(WORK, 'attachments');
  const CACHE = path.join(WORK, 'cache');
  const limits = {
    maxImageBytes: A.DEFAULT_MAX_IMAGE_BYTES,
    maxImagesPerMessage: A.DEFAULT_MAX_IMAGES_PER_MESSAGE,
    maxMessageImageBytes: 200 * 1024 * 1024,
    maxImagePixels: A.DEFAULT_MAX_IMAGE_PIXELS,
    maxImageDimension: A.DEFAULT_MAX_IMAGE_DIMENSION,
    mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
  };
  const policy = {
    maxPixels: A.DEFAULT_NORMALIZED_IMAGE_MAX_PIXELS,
    maxDimension: A.DEFAULT_NORMALIZED_IMAGE_MAX_DIMENSION,
    maxBytes: A.DEFAULT_NORMALIZED_IMAGE_MAX_BYTES,
  };
  const input = (data, name, mediaType = 'image/png') => ({ data: new Uint8Array(data), mediaType, name });

  // B1 真机 screencap 结构 → 必须能落盘（这条就是"screen_image 不可用"的根因路径）
  let prepared;
  const e2eT0 = Date.now();
  try {
    prepared = await A.prepareImageFile(input(shot, 'shot.png'), limits, policy);
    check('B1 带 iCCP 的 screencap 结构 PNG 完成准入+归一化（不再 "durable image storage rejected"）', true);
  } catch (e) {
    check('B1 带 iCCP 的 screencap 结构 PNG 完成准入+归一化（不再 "durable image storage rejected"）', false, `${e.code || ''} ${e.message}`);
  }
  if (prepared) {
    const e2eMs = Date.now() - e2eT0;
    check('B2 归一化产物是 JPEG (带元数据 → 必须重编码)', prepared.ref.mediaType === 'image/jpeg', prepared.ref.mediaType);
    check('B3 尺寸保留 1200x2608（3.13MP 在 4.19MP 预算内, 不该缩）', prepared.ref.width === 1200 && prepared.ref.height === 2608, `${prepared.ref.width}x${prepared.ref.height}`);
    check('B4 没有 originalDimensions（没发生降采样）', prepared.ref.originalDimensions === undefined, JSON.stringify(prepared.ref.originalDimensions));
    check('B5 产物 ≤ 归一化字节预算 4MiB', prepared.ref.bytes <= policy.maxBytes, String(prepared.ref.bytes));
    check('B6 产物是 JPEG 字节', Buffer.from(prepared.data).subarray(0, 2).equals(Buffer.from([0xff, 0xd8])), Buffer.from(prepared.data).subarray(0, 4).toString('hex'));
    console.log(`  (准入+归一化 ${e2eMs}ms, 产物 ${(prepared.ref.bytes / 1024).toFixed(0)} KiB)`);

    // B7 落盘 + 读回（readImageFile 内部会 probeImage 并与 ref 对账）
    let stored;
    try {
      const ref = await A.commitPreparedImageFile(ROOT_STORE, prepared);
      stored = await A.readImageFile(ROOT_STORE, ref);
      check('B7 落盘 + 读回 + 完整性校验通过', true);
      check('B8 读回的字节与归一化产物逐字节一致', Buffer.from(stored.data).equals(Buffer.from(prepared.data)), `${stored.data.length} vs ${prepared.data.length}`);
    } catch (e) {
      check('B7 落盘 + 读回 + 完整性校验通过', false, `${e.code || ''} ${e.message}`);
    }

    // B9 请求图变体（模型真正拿到的那份）
    if (stored) {
      try {
        const target = { width: 400, height: 400, maxBytes: 200 * 1024 };
        const v1 = await A.readRequestImageFile(CACHE, stored, target);
        check('B9 请求图变体生成并通过 verifyRequestImage 校验', v1.mediaType === 'image/jpeg' && v1.depth === 'uchar' && v1.space === 'srgb', JSON.stringify({ m: v1.mediaType, d: v1.depth, s: v1.space }));
        check('B10 高图按高边缩: 1200x2608 → 高 400 (宽 184)', v1.height === 400 && v1.width === 184, `${v1.width}x${v1.height}`);
        check('B11 变体字节 ≤ maxBytes', v1.bytes <= target.maxBytes, `${v1.bytes} vs ${target.maxBytes}`);
        const v2 = await A.readRequestImageFile(CACHE, stored, target);
        check('B12 第二次请求命中缓存且结果一致', Buffer.from(v2.data).equals(Buffer.from(v1.data)) && String(v2.variantId) === String(v1.variantId));
      } catch (e) {
        check('B9 请求图变体生成并通过 verifyRequestImage 校验', false, `${e.code || ''} ${e.message}`);
      }
    }
  }

  // B13 干净的 PNG 必须原样放行（别把不该动的也重编码）
  try {
    const clean = makeShot(64, 48, []);
    const p = await A.prepareImageFile(input(clean, 'clean.png'), limits, policy);
    check('B13 无元数据的 8bit sRGB PNG 原字节放行（不重编码）', Buffer.from(p.data).equals(clean) && p.ref.mediaType === 'image/png', `${p.ref.mediaType} ${p.ref.bytes} vs ${clean.length}`);
  } catch (e) {
    check('B13 无元数据的 8bit sRGB PNG 原字节放行（不重编码）', false, `${e.code || ''} ${e.message}`);
  }

  // B14 16bit PNG 走归一化而不是放行
  try {
    const p = await A.prepareImageFile(input(png16, 'p16.png'), limits, policy);
    check('B14 16bit PNG 被归一化成 8bit JPEG', p.ref.mediaType === 'image/jpeg', p.ref.mediaType);
  } catch (e) {
    check('B14 16bit PNG 被归一化成 8bit JPEG', false, `${e.code || ''} ${e.message}`);
  }

  // B15 EXIF orientation 的 JPEG: 上游按摆正后的尺寸记账, 产物尺寸必须对上
  try {
    const p = await A.prepareImageFile(input(rotJpeg, 'rot.jpg', 'image/jpeg'), limits, policy);
    check('B15 EXIF orientation=6 的 JPEG: 产物尺寸=摆正后 (50x100)', p.ref.width === 50 && p.ref.height === 100, `${p.ref.width}x${p.ref.height}`);
  } catch (e) {
    check('B15 EXIF orientation=6 的 JPEG: 产物尺寸=摆正后 (50x100)', false, `${e.code || ''} ${e.message}`);
  }

  // B16 透明图分两种情况, 必须区分清楚:
  //   (a) **干净**的透明 PNG → 本来就该原样放行（上游文档明确允许 sRGBA 放行,
  //       alpha 一个字都不动)。这不是"被压平"，是正确行为。
  //   (b) 需要**归一化**的透明图 (这里加 iCCP 逼它重编码) → 本构建没有 webp
  //       编码器, 必须明确失败, 绝不能静默压平成 JPEG。
  try {
    const cleanTransparent = makeTransparentPNG(32, 32, []);
    const p = await A.prepareImageFile(input(cleanTransparent, 'ct.png'), limits, policy);
    check(
      'B16a 干净的透明 PNG 原样放行 (alpha 保留, 不是被压平)',
      Buffer.from(p.data).equals(cleanTransparent) && p.ref.mediaType === 'image/png',
      `${p.ref.mediaType} ${p.ref.bytes} vs ${cleanTransparent.length}`,
    );
  } catch (e) {
    check('B16a 干净的透明 PNG 原样放行 (alpha 保留, 不是被压平)', false, `${e.code || ''} ${e.message}`);
  }
  try {
    const forcedTransparent = makeTransparentPNG(32, 32, [ICCP]);
    await A.prepareImageFile(input(forcedTransparent, 'ft.png'), limits, policy);
    check('B16b 必须重编码的透明图明确失败（不静默压平 alpha）', false, '居然成功了 —— alpha 被压平却没人发现');
  } catch (e) {
    const cause = e.cause?.message || '';
    check(
      'B16b 必须重编码的透明图明确失败（不静默压平 alpha）',
      e.code === 'ATTACHMENT_WRITE_FAILED' && /TRANSPARENT|webp/i.test(cause),
      `${e.code} / cause=${cause.slice(0, 140)}`,
    );
  }

  // B17 不透明 GIF 归一化成 JPEG（首帧）
  try {
    const p = await A.prepareImageFile(input(gifVariant({ frames: 1, transparent: false }), 'a.gif', 'image/gif'), limits, policy);
    check('B17 不透明 GIF → 归一化成 JPEG', p.ref.mediaType === 'image/jpeg', p.ref.mediaType);
  } catch (e) {
    check('B17 不透明 GIF → 归一化成 JPEG', false, `${e.code || ''} ${e.message}`);
  }

  // B18 动图: animated=true 必须被识别（并且不透明动图同样归一化）
  try {
    const p = await A.prepareImageFile(input(gifAnim, 'anim.gif', 'image/gif'), limits, policy);
    check('B18 动图 GIF 走归一化 (animated 被识别, 产出单帧 JPEG)', p.ref.mediaType === 'image/jpeg' && p.ref.width === 1 && p.ref.height === 1, `${p.ref.mediaType} ${p.ref.width}x${p.ref.height}`);
  } catch (e) {
    check('B18 动图 GIF 走归一化 (animated 被识别, 产出单帧 JPEG)', false, `${e.code || ''} ${e.message}`);
  }

  // B19 阶梯真的在挑档: 预算压到 32KiB 时三档都超, 上游的语义是"保留最小的
  //     那一档"(见 normalizeImage 文档: provider 的字节上限在传输那层再管)。
  //     所以这里不能断言 ≤ maxBytes, 要断言"确实落到了比 q85 更小的档"。
  try {
    const tight = { ...policy, maxBytes: 32 * 1024 };
    const p = await A.prepareImageFile(input(shot, 'shot.png'), limits, tight);
    check(
      'B19 预算 32KiB 时阶梯落到更低的档 (而非硬塞 q85)',
      p.ref.mediaType === 'image/jpeg' && prepared && p.ref.bytes < prepared.ref.bytes,
      `${p.ref.bytes} vs q85 的 ${prepared?.ref.bytes}`,
    );
    const stored2 = await A.readImageFile(ROOT_STORE, await A.commitPreparedImageFile(ROOT_STORE, p));
    check('B20 小预算产物同样能通过读回对账', Buffer.from(stored2.data).equals(Buffer.from(p.data)));
  } catch (e) {
    check('B19 预算 32KiB 时阶梯落到更低的档 (而非硬塞 q85)', false, `${e.code || ''} ${e.message}`);
  }

  // B21/B22 调用次数: 质量阶梯必须只解码一次。
  //   干净图         = detect(metadata) + raw(解码证明)             = 2 次, 且**不归一化**
  //   带元数据的图   = 上面 2 次 + normalize(一次算三档) + 产物 verify
  //                    (verifyNormalizedImage → detectImage → metadata+raw = 2 次) = 5 次
  //   阶梯如果是"每档各解码一次", 这里会变成 7 次 —— 这条就是防它退化的哨兵。
  try {
    const clean = makeShot(200, 120, []);
    spawnCount = 0;
    const pClean = await A.prepareImageFile(input(clean, 'c.png'), limits, policy);
    const cleanSpawns = spawnCount;
    check('B21 干净图: 2 次 imgtool 调用且不发生归一化', cleanSpawns === 2 && Buffer.from(pClean.data).equals(clean), `${cleanSpawns} 次, mediaType=${pClean.ref.mediaType}`);

    const dirty = makeShot(200, 120);
    spawnCount = 0;
    const pDirty = await A.prepareImageFile(input(dirty, 'd.png'), limits, policy);
    const dirtySpawns = spawnCount;
    check(
      'B22 带元数据的图: 5 次调用 (源 detect+raw / normalize 一次算三档 / 产物 verify 两次)',
      dirtySpawns === 5 && pDirty.ref.mediaType === 'image/jpeg',
      `${dirtySpawns} 次, mediaType=${pDirty.ref.mediaType}`,
    );
  } catch (e) {
    check('B21 干净图: 2 次 imgtool 调用且不发生归一化', false, String(e.message).slice(0, 160));
  }
}

// ── 汇总 ──────────────────────────────────────────────────
console.log(`\n== 合计: ${pass} 通过 / ${fail} 失败${skip ? ` / ${skip} 跳过` : ''} ==`);
if (failures.length) {
  console.log('失败用例:');
  for (const f of failures) console.log(`  · ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
