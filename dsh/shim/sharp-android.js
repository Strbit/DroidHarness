/**
 * [Android shim] sharp 的 JS 替身 —— 后端是模块自带的原生工具 imgtool。
 *
 * ── 为什么需要这个文件 ────────────────────────────────────────────────
 *
 * `@deepseek-ai/dsh-attachment-local` 用 `createLazyRequire("sharp")` 加载
 * sharp, 并在三个地方真的用它:
 *
 *   detectImage()      metadata() + raw().toBuffer()   —— 准入时的完整解码证明
 *   normalizeImage()   rotate/toColourspace/resize + jpeg|webp 阶梯
 *   sourcePipeline()   toColourspace + resize(单边) + jpeg|webp 阶梯
 *
 * 而 sharp 0.35.x 的 optionalDependencies 里**没有 android** 平台包
 * (只有 darwin/linux/linuxmusl/freebsd/wasm; `@img/sharp-linux-arm64` 是
 * glibc/ELF 的, 拿来在 bionic 上也起不来)。于是 require("sharp") 抛一个
 * 没有任何上下文的裸 Error, 被上游包成:
 *
 *   "durable image storage rejected" / "Unsupported or malformed image data"
 *
 * —— 症状看起来像图片格式不对, 其实是"这个平台上根本没有 sharp"。
 *
 * 替身的做法: 把上游用到的那一小片 sharp 接口, 翻译成对 `imgtool`
 * (Go 写的纯静态 aarch64 可执行文件, 见 tools/imgtool/main.go) 的一次
 * 子进程调用。**不实现** sharp 的其它能力 (png/tiff/avif 编码、合成、
 * 流式接口……): 用到就明确抛错, 不静默给个错结果。
 *
 * ── 与真 sharp 的三处有意偏差 (都是为了让上游的校验成立, 不是偷懒) ──────
 *
 * 1. hasAlpha 按**像素**而不是按波段报。
 *    Go 生态 (golang.org/x/image) 只有 webp 解码、没有编码。真机 screencap
 *    出来的是 RGBA(colorType 6) 但像素全不透明; 若像 libvips 那样按波段报
 *    hasAlpha=true, 上游 encodingLadder 会去走 webp 阶梯, 而我们编不出 webp。
 *    按像素报 false → 走 JPEG 阶梯, 视觉无损 (全不透明图的 alpha 通道本来
 *    就不携带信息)。真透明图 (存在 alpha<255) 直接报错, 不静默压平。
 *
 * 2. orientation 只在**真有 EXIF Orientation** 时才出现。
 *    上游 carriesRetainedMetadata 把 `orientation !== undefined` 算作"带元
 *    数据", verifyNormalizedImage 又要求归一化产物不带元数据。如果对没有
 *    EXIF 的图凭空给一个 orientation=1, 我们自己产出的 JPEG 也会被判成带
 *    元数据, 归一化永远过不了验证。
 *
 * 3. `.webp()` 明确抛错而不是降级成 JPEG。
 *    上游用 hasAlpha 选 webp/jpeg, 并会在验证阶段检查"输出 alpha 事实与源
 *    一致"。把 webp 悄悄换成 JPEG 会改掉媒体类型语义, 所以宁可报错。
 *
 * 除上述三点外, metadata 的字段名/类型、resize 的 inside+不放大语义、
 * jpeg 质量阶梯、clone 语义都尽量与 sharp 一致。
 *
 * @module
 */
"use strict";

const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

/** 上游两处编码器共用同一个质量阶梯 (index.js 的 IMAGE_ENCODING_QUALITIES)。 */
const DEFAULT_LADDER = [85, 75, 60];

/** 单次调用的输出上限: 归一化会一次返回三档 JPEG, 大图也就几 MB。 */
const MAX_STDOUT = 96 * 1024 * 1024;

/**
 * 找到 imgtool。
 *
 * 顺序: 环境变量 (测试与排障用) → 与本文件同目录 → 包根目录。
 * 打包时二进制就放在 sharp 包的 dist/ 旁边 (见 dsh/tools/build-dsh-tree.mjs),
 * 所以正常情况下第一优先就命中, 不依赖 PATH。
 */
function resolveBinary() {
	const override = process.env.DSH_IMGTOOL;
	if (override) {
		if (!fs.existsSync(override)) throw new Error(`DSH_IMGTOOL 指向的文件不存在: ${override}`);
		return override;
	}
	const candidates = [
		path.join(__dirname, "imgtool"), // 打包后: <sharp>/dist/imgtool
		path.join(__dirname, "..", "imgtool"), // <sharp>/imgtool
		path.join(__dirname, "..", "libexec", "imgtool"),
	];
	for (const c of candidates) if (fs.existsSync(c)) return c;
	throw new Error(
		`sharp shim (Android): 找不到 imgtool。找过: ${candidates.join(", ")}。` +
			` 先跑 node dsh/tools/build-dsh-tree.mjs 把二进制拷进应用树。`,
	);
}

/**
 * 调用 imgtool 一次。
 * @param op 操作名 (detect / raw / normalize)。
 * @param payload 请求体 (data 为 base64)。
 * @param wantBinary true 时按"JSON 行 + 二进制体"解析 (raw 操作用)。
 */
function invoke(op, payload, wantBinary = false) {
	const bin = resolveBinary();
	return new Promise((resolve, reject) => {
		const child = spawn(bin, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
		const out = [];
		const err = [];
		let outLen = 0;
		child.stdout.on("data", (d) => {
			outLen += d.length;
			if (outLen > MAX_STDOUT) {
				child.kill();
				reject(new Error(`sharp shim: imgtool 输出超过 ${MAX_STDOUT} 字节, 已中止`));
				return;
			}
			out.push(d);
		});
		child.stderr.on("data", (d) => err.push(d));
		child.on("error", (e) => reject(new Error(`sharp shim: 无法启动 imgtool (${bin}): ${e.message}`)));
		child.on("close", (code) => {
			const buf = Buffer.concat(out);
			const errText = Buffer.concat(err).toString("utf8").trim();
			const parse = (text) => {
				let parsed;
				try {
					parsed = JSON.parse(text);
				} catch {
					throw new Error(
						`sharp shim: imgtool ${op} 返回了无法解析的输出 (exit ${code}): ` +
							`${text.slice(0, 200)}${errText ? ` / stderr: ${errText.slice(0, 200)}` : ""}`,
					);
				}
				if (!parsed.ok) throw new Error(`sharp shim: imgtool ${op} 失败: ${parsed.error}`);
				return parsed.result;
			};
			try {
				if (!wantBinary) {
					resolve(parse(buf.toString("utf8")));
					return;
				}
				// "JSON 行 + 二进制体": 头一行是 JSON, 其后紧跟像素字节。
				const nl = buf.indexOf(0x0a);
				if (nl < 0) {
					resolve({ head: parse(buf.toString("utf8")), body: Buffer.alloc(0) });
					return;
				}
				const head = parse(buf.subarray(0, nl).toString("utf8"));
				resolve({ head, body: buf.subarray(nl + 1) });
			} catch (e) {
				reject(e);
			}
		});
		// 上游可能在大图上被取消; EPIPE 不该变成未捕获异常。
		child.stdin.on("error", () => {});
		child.stdin.end(JSON.stringify({ op, ...payload }));
	});
}

/**
 * 把 imgtool 的事实翻译成 sharp metadata 的形状。
 *
 * 关键点: "带不带元数据"这件事不在这里下结论 —— 这里只把 imgtool 认出来的
 * 字段名摆到 metadata 上, 由上游自己的 carriesRetainedMetadata 去判定。
 * 规则只有一份, 不会两边漂移。
 */
function toSharpMetadata(facts) {
	const md = {
		format: facts.format,
		width: facts.width,
		height: facts.height,
		space: facts.space,
		channels: facts.channels,
		depth: facts.depth,
		hasAlpha: facts.hasAlpha,
	};
	// sharp: pages 只在多帧时才有意义, 单帧给 1 (上游用 (pages ?? 1) > 1)。
	md.pages = facts.pages || 1;
	// orientation: 只在真有 EXIF 时出现 (见文件头偏差 2)。
	if (facts.orientation) md.orientation = facts.orientation;
	for (const field of facts.retained || []) {
		// 上游只判"存在", 不读内容 (index.js:141)。给一个类型正确的占位:
		// 其它字段 sharp 给的是 Buffer。内容为空是有意的 —— 我们不搬运可能
		// 上百 KB 的 ICC/EXIF, 而它们马上就会被归一化丢掉。
		switch (field) {
			case "icc":
			case "exif":
			case "xmp":
			case "iptc":
				md[field] = Buffer.alloc(0);
				break;
			case "hasProfile":
				md.hasProfile = true;
				break;
			case "tifftagPhotoshop":
				md.tifftagPhotoshop = 0;
				break;
			case "comments":
				md.comments = [];
				break;
		}
	}
	return md;
}

/** 一条 sharp 管线 (只实现上游用到的那部分)。 */
class Pipeline {
	constructor(input, shared) {
		this._input = input;
		this._shared = shared;
		// cache 必须在构造时就是稳定引用, 否则 clone() 时它还是 null, 三个 clone
		// 会各自建 Map —— 质量阶梯就会被解码三遍 (这正是要避免的)。
		if (!this._shared.cache) this._shared.cache = new Map();
		this._encoder = null;
	}

	/** @returns {Promise<object>} sharp 形状的 metadata。 */
	async metadata() {
		if (!this._shared.meta) {
			this._shared.meta = invoke("detect", { data: this._input.toString("base64") }).then(toSharpMetadata);
		}
		return this._shared.meta;
	}

	/** EXIF 自动摆正 (无参形式)。 */
	rotate() {
		this._shared.rotate = true;
		return this;
	}

	/** 色彩空间。归一化链路本来就只产出 sRGB, 这里只接受 srgb。 */
	toColourspace(space) {
		const s = String(space).toLowerCase();
		if (s !== "srgb" && s !== "rgb") {
			throw new Error(`sharp shim: toColourspace("${space}") 未实现 (只支持 srgb)`);
		}
		return this;
	}

	/** 等比缩到框内; width/height 任一可为 0 (该边不限)。 */
	resize(opts) {
		const o = opts || {};
		if (o.fit !== undefined && o.fit !== "inside") {
			throw new Error(`sharp shim: resize({fit:"${o.fit}"}) 未实现 (只支持 inside)`);
		}
		if (o.withoutEnlargement === false) {
			throw new Error("sharp shim: resize({withoutEnlargement:false}) 未实现");
		}
		const width = Number(o.width) > 0 ? Math.round(Number(o.width)) : 0;
		const height = Number(o.height) > 0 ? Math.round(Number(o.height)) : 0;
		if (width === 0 && height === 0) throw new Error("sharp shim: resize() 至少要给一边尺寸");
		this._shared.resize = { width, height };
		return this;
	}

	/** 复制当前管线状态; 编码结果的缓存跨 clone 共享 (阶梯三档只跑一次)。 */
	clone() {
		const copy = new Pipeline(this._input, {
			rotate: this._shared.rotate,
			resize: this._shared.resize ? { ...this._shared.resize } : null,
			meta: this._shared.meta, // metadata 结果可安全复用
			cache: this._shared.cache, // ← 同一份编码缓存
		});
		copy._encoder = this._encoder;
		return copy;
	}

	jpeg(opts) {
		this._encoder = { format: "jpeg", quality: clampQuality(opts && opts.quality, 80) };
		return this;
	}

	webp() {
		// 见文件头偏差 3: 不静默降级。
		throw new Error(
			"sharp shim: 本构建没有 webp 编码器 (Go 生态只有 webp 解码)。" +
				"带真实透明的输入无法归一化; 不透明图不会走到这里 (hasAlpha 按像素报 false)。",
		);
	}

	/** raw 像素。上游只在 detectImage 里用它做"能完整解码"的证明 (index.js:195)。 */
	raw() {
		const self = this;
		return {
			async toBuffer() {
				if (self._shared.rotate || self._shared.resize) {
					throw new Error("sharp shim: 管线操作之后的 raw() 未实现 (上游只用无操作的 raw)");
				}
				const { body } = await invoke("raw", { data: self._input.toString("base64") }, true);
				return Buffer.from(body); // 复制一份, 不保留整块 stdout 的引用
			},
		};
	}

	/** 编码。@returns {Promise<Buffer|{data:Buffer,info:object}>} */
	async toBuffer(opts) {
		const enc = this._encoder;
		if (!enc) throw new Error("sharp shim: toBuffer() 之前没有选编码器 (jpeg/webp)");
		if (enc.format !== "jpeg") throw new Error(`sharp shim: 不支持编码成 ${enc.format}`);
		const quality = enc.quality;
		const encodings = await this._encodeShared([quality]);
		const hit = encodings.get(quality);
		if (!hit) throw new Error(`sharp shim: imgtool 没有返回 quality=${quality} 的结果`);
		const data = Buffer.from(hit.data, "base64");
		if (opts && opts.resolveWithObject) {
			return {
				data,
				info: { format: "jpeg", width: hit.width, height: hit.height, size: data.length, channels: 3 },
			};
		}
		return data;
	}

	/**
	 * 跑一次归一化, 把整条质量阶梯都算出来。
	 *
	 * 上游的 ladder 是 "clone() 三次, 每次改 quality" —— 如果照字面实现, 同一张图
	 * 会被解码+缩放三遍。这里按 (rotate,resize) 缓存: 第一次请求就把默认阶梯
	 * [85,75,60] 一起算完 (imgtool 一次调用里算三档, 只解码一次), 后两个 clone
	 * 直接命中缓存。请求了阶梯外的质量才额外再跑一次。
	 */
	async _encodeShared(qualities) {
		const shared = this._shared;
		const key = `${shared.rotate ? "rot" : "nor"}|${shared.resize ? `${shared.resize.width}x${shared.resize.height}` : "orig"}`;
		let entry = shared.cache.get(key);
		if (!entry) {
			entry = { encodings: new Map(), pending: null, requested: new Set() };
			shared.cache.set(key, entry);
		}
		const missing = qualities.filter((q) => !entry.encodings.has(q) && !entry.requested.has(q));
		const wantLadder = entry.encodings.size === 0 && entry.requested.size === 0;
		for (const q of qualities) entry.requested.add(q);
		if (missing.length > 0 || wantLadder) {
			if (!entry.pending) {
				const ladder = [...new Set([...DEFAULT_LADDER, ...entry.requested])].sort((a, b) => b - a);
				entry.pending = invoke("normalize", {
					data: this._input.toString("base64"),
					width: shared.resize ? shared.resize.width : 0,
					height: shared.resize ? shared.resize.height : 0,
					qualities: ladder,
					rotate: shared.rotate === true,
				})
					.then((result) => {
						for (const e of result.encodings) entry.encodings.set(e.quality, e);
						return entry.encodings;
					})
					.finally(() => {
						entry.pending = null;
					});
			}
			await entry.pending;
		}
		return entry.encodings;
	}
}

function clampQuality(value, fallback) {
	const n = Number(value);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(100, Math.max(1, Math.round(n)));
}

/**
 * sharp(data, options) —— 与 sharp 一样, 默认导出就是工厂函数本身。
 * options 里的 failOn / limitInputPixels 被忽略: imgtool 任何情况下都是
 * 严格解码 + 不限制输入像素 (limitInputPixels 的职责由上游的 maxPixels 承担)。
 */
function sharp(input, _options) {
	if (input === undefined || input === null) {
		throw new Error("sharp shim: 需要图像字节 (只支持 sharp(buffer) 这种一次性用法)");
	}
	let buf;
	if (Buffer.isBuffer(input)) buf = input;
	else if (input instanceof Uint8Array) buf = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
	else if (ArrayBuffer.isView(input)) buf = Buffer.from(input.buffer);
	else throw new Error("sharp shim: 只支持 Buffer/Uint8Array 输入 (不支持文件路径/流)");
	// 复制一份: 上游可能复用同一块内存, 而我们是异步子进程调用, 不能悬空引用。
	return new Pipeline(Buffer.from(buf), { rotate: false, resize: null, meta: null, cache: new Map() });
}

module.exports = sharp;
module.exports.default = sharp;
module.exports.sharp = sharp;
// 真 sharp 会暴露 versions; 有些调用方会探测它来判断 sharp 是否可用。
module.exports.versions = { shim: "imgtool", vips: "none" };
