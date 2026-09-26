'use strict';
/**
 * node-addon-require-builtin 的纯 JS 替身 —— 供 Android 使用.
 *
 * 为什么需要它
 * ------------
 * 原包经 `node-addon-native-custom-loader` 加载平台专用的 .node 文件, 而它的
 * optionalDependencies 里只有这些平台:
 *
 *   darwin-arm64 / darwin-x64 / linux-arm64-gnu / linux-x64-gnu
 *   win32-arm64-msvc / win32-x64-msvc / win32-ia32-msvc
 *
 * 没有 android. 所以 npm 在 Android 上一个平台包都装不上, require 必然抛
 * MODULE_NOT_FOUND. (linux-arm64-gnu 也救不了 —— Android 用 bionic, 不是 glibc.)
 *
 * 为什么能用纯 JS 顶替
 * --------------------
 * 这个包唯一的能力是"把 Node 的 internal 模块 require 出来". 而 Node 自己就有这条路:
 * 启动时加 `--expose-internals`, `require("internal/...")` 直接可用.
 * 所以只要保证进程带那个旗标, 就不需要任何原生代码.
 *
 * DSH 里的两处使用
 * ----------------
 *   cordis-plugin-loader  有 `--expose-internals` 分支且整体 try/catch, 本来就不会挂
 *   dsh-app-boot          无保护的 `createRequire(...)("node-addon-require-builtin")`
 *                         —— 这一处就是必须顶替的原因
 *
 * 装到哪
 * ------
 * 覆盖 `node_modules/node-addon-require-builtin/lib/index.js`.
 * 由 `tools/build-dsh-tree.mjs` 在构建期完成, 手机端不做任何改动.
 */

const REQUIRED_FLAG = '--expose-internals';

function requireBuiltin(moduleId) {
	if (!process.execArgv.includes(REQUIRED_FLAG)) {
		// 宁可在这里给一句能看懂的错, 也不要让它冒成 ERR_UNKNOWN_BUILTIN_MODULE.
		throw new Error(
			'node-addon-require-builtin (JS shim): 需要 Node 以 ' +
				`${REQUIRED_FLAG} 启动才能解析 "${moduleId}". ` +
				'请在启动参数里加上它.'
		);
	}
	return require(moduleId);
}

function isAllowedInternalId(moduleId) {
	return typeof moduleId === 'string' && moduleId.startsWith('internal/');
}

function getBindingInfo() {
	return {
		binding: 'js-shim',
		platform: process.platform,
		arch: process.arch,
		exposeInternals: process.execArgv.includes(REQUIRED_FLAG),
	};
}

module.exports = { requireBuiltin, isAllowedInternalId, getBindingInfo };
module.exports.default = module.exports;
