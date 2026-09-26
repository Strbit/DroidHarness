/**
 * @deepseek-ai/node-addon-system/flock 的纯 JS 替身 —— 供 Android 使用.
 *
 * ⚠️ 这是一个**语义降级**, 不是等价替代. 读之前先读"为什么可以接受".
 *
 * 为什么原包在 Android 上用不了
 * ----------------------------
 * 原包是 Node-API 原生模块, optionalDependencies 里只有四个平台包:
 *
 *   darwin-arm64 / darwin-x64 / linux-x64 / linux-arm64
 *
 * **没有 android.** 而且 lib/flock.js 第一句就按平台拒绝:
 *
 *   if (platform !== 'linux' && platform !== 'darwin') throw ...
 *
 * 于是 Android 上任何一次会话写入都会失败 —— 表现为
 * "本轮运行失败: flock is not supported on android-arm64".
 *
 * (注意: 即使把 platform 骗成 'linux' 也不行 —— 它还会按
 *  `report.header.glibcVersionRuntime` 在 glibc/musl 之间选, 而 Android 用的是
 *  bionic, 两者都不是. 而 linux-arm64 那个预编译包是 glibc 的, 加载不了.)
 *
 * 这个锁是干什么的
 * --------------
 * `dsh-session-persistence-jsonl` 的 SessionWriteLease 用它给单个会话的
 * `session.lock` 上一个非阻塞 `flock(2)`, 目的是**跨进程**的写所有权互斥:
 * 两个 DSH 进程同时写同一个会话日志会撕裂它.
 *
 * 锁在持有者的 fd 关闭时由内核释放 (进程崩溃也一样), 所以不会有死锁残留.
 * 读者/搜索/删目录都不碰这个锁.
 *
 * 为什么可以接受 (这不是偷懒)
 * ------------------------
 * **上游自己对单进程部署就是这么做的.** 该文件自己的注释原文:
 *
 *   "The browser worker stubs the native flock entry to immediate success:
 *    it is single-process, so the in-process write claim already excludes
 *    every writer."
 *
 * 我们的部署同样是单进程:
 *   · service.sh 是唯一的拉起入口, 带 pidfile 检查, 拒绝启动第二个实例
 *   · 同一个进程内的写互斥由 SessionWriteLease 自己的 held/released 状态保证,
 *     与 flock 无关
 *
 * 所以这里丢掉的能力**只有** "两个 DSH 进程之间的互斥". 我们的监督脚本已经
 * 从源头上排除了那种情况.
 *
 * 什么时候这个假设会破
 * ------------------
 *   · 你手动再跑一个 `dsh web` 而监督进程也在跑, 且两者指向同一个 DSH_HOME
 *   · 你把 service.sh 的 pidfile 检查去掉
 * 那时就可能出现会话日志撕裂. 真需要跨进程锁的话, 正确做法是用 Android NDK
 * 把本包自带的 `src/flock.c` 编成 android-arm64 的 `.node` (源码是随包发的),
 * 而不是继续用这个替身.
 *
 * 装到哪
 * ------
 * 覆盖 `node_modules/@deepseek-ai/node-addon-system/lib/flock.js`.
 * 由 `dsh/tools/build-dsh-tree.mjs` 在构建期完成, 手机端不做任何改动.
 *
 * 注意: 原包 package.json 里 `"type": "module"`, 所以这个文件必须是 ESM.
 */

/** 标明这是替身, 便于日志与自检区分. */
export const FLOCK_IMPLEMENTATION = 'js-shim-single-process';

/**
 * 空实现: 立即成功.
 *
 * 保留与原实现一致的**签名与错误面** —— 成功时 resolve(undefined),
 * 失败时 reject. 只是这里永远不会因争用而失败 (没有争用可言).
 *
 * 原实现会校验 fd 并可能抛 EBADF 之类; 这里做一个轻量校验, 免得把调用方的
 * 真 bug (传了 undefined) 静默吞掉.
 *
 * @param fd - 调用方持有的、已打开的 session.lock 文件描述符.
 * @returns 立即 resolve 的 promise.
 */
export async function tryLockExclusive(fd) {
	if (!Number.isInteger(fd) || fd < 0) {
		throw Object.assign(new Error(`EBADF: flock failed (fd=${String(fd)})`), {
			code: 'EBADF',
			errno: -9,
			syscall: 'flock',
		});
	}
	// 单进程部署: 进程内的写 claim 已经互斥, 无需内核锁.
	return;
}

export default { tryLockExclusive, FLOCK_IMPLEMENTATION };
