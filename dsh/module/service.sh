#!/system/bin/sh
# DSH on Android — 开机拉起
#
# 只绑 127.0.0.1. 这不是保守, 是设计约束:
# "绑 0.0.0.0 + 无鉴权 + 提供命令执行端点"这三件事叠加等于把设备 root 挂在网络上,
# 而 DSH 本身就是一个能跑 shell 的 agent. 要远程访问就走 adb forward 或 SSH 隧道 ——
# 那是有意为之、有明确边界的.
#
# 访问方式 (在 PC 上):
#   adb forward tcp:3080 tcp:3080
#   浏览器打开 http://127.0.0.1:3080

MODDIR=${0%/*}

DSH_HOME_DIR=/data/adb/dsh
WS=/sdcard/DroidHarness
PREFIX="$MODDIR/usr"
APP="$MODDIR/app"
BIN="$APP/node_modules/@deepseek-ai/dsh/lib/bin.js"
LOG="$DSH_HOME_DIR/logs/dsh.log"
HOST=127.0.0.1
PORT=3080

# ── 等系统真正起来 ──────────────────────────────────────────
i=0
while [ "$(getprop sys.boot_completed)" != "1" ] && [ $i -lt 180 ]; do
	sleep 1
	i=$((i + 1))
done
sleep 5

mkdir -p "$DSH_HOME_DIR/logs" "$WS" 2>/dev/null

# ── 环境 ────────────────────────────────────────────────────
# Termux 编出来的二进制有一批写死的 Termux 路径, 这三个少一个都起不来.
#
# 注意 TMPDIR 指向私有目录而不是 /data/local/tmp:
#   · /data/local/tmp 是共享目录 (shell 拥有, 很多工具在用), 会话临时文件不该丢里面
#   · 更重要的是: customize.sh 是被 installer.sh source 的, 那里 export TMPDIR
#     会让安装器结尾的 `rm -rf $TMPDIR` 删掉错误的东西 (这个坑真踩了).
#     本脚本是当子进程跑的, export 不会外泄, 但仍然用私有目录保持一致.
export DSH_HOME="$DSH_HOME_DIR"
export LD_LIBRARY_PATH="$PREFIX/lib"
export PATH="$PREFIX/bin:/system/bin:/system/xbin"
export HOME="$WS"
mkdir -p "$DSH_HOME_DIR/tmp" 2>/dev/null
export TMPDIR="$DSH_HOME_DIR/tmp"
export SHELL="$PREFIX/bin/bash"
export OPENSSL_CONF="$DSH_HOME_DIR/tmp/openssl.cnf"
: >"$OPENSSL_CONF" 2>/dev/null
export SSL_CERT_DIR=/system/etc/security/cacerts
export NO_COLOR=1

# ── 包管理器 (pnpm) ─────────────────────────────────────────
#
# DSH 的插件管理器把参数原样转发给 pnpm 执行。pnpm 在 Android 上有三个坑,
# **真正的修复不在本文件里**, 而在 `usr/bin/pnpm` 那层启动器
# (由 probe/tools/fetch-runtime.mjs 的 wrapPnpm() 在构建期生成)。这里只补一句
# PNPM_HOME, 并说清楚为什么其它变量都没用。
#
# 1. **store 操作锁目录取自 $HOME/.cache, 且要求它是「当前用户拥有的真实目录」。**
#    本脚本的 HOME 是 /sdcard/DroidHarness, 它属于 u0_a257:media_rw 而进程是 root,
#    于是 pnpm 直接报:
#        ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK
#          lock directory must be a real directory owned by the current user
#    手机端 agent 实测: npm_config_cache_dir / npm_config_store_dir /
#    npm_config_state_dir / XDG_CACHE_HOME / --cache-dir / --config.cacheDir /
#    --store-dir **全都挪不动它** —— pnpm 根本不读那几个变量。
#    **唯一有效的是给它一个单独的 HOME**, 所以 usr/bin/pnpm 是个启动器:
#        export HOME="$DSH_HOME_DIR"; exec .../pnpm-bin "$@"
#    这样只改 pnpm 子进程的 HOME, DSH 自己的 HOME 不动 (GUI 的工作区选择器从它起步)。
#
# 2. **store 必须和 profile 目录 (/data/adb/dsh/profiles/*) 在同一个真实文件系统上。**
#    它靠硬链接把 store 里的文件链进 node_modules, 跨文件系统会报
#    "Cross-device link not permitted"。而 /sdcard 是 FUSE, **不支持硬链接**。
#    上面把 HOME 指到 /data/adb/dsh 顺带解决了这条 (store 落在 $PNPM_HOME/store)。
#
# 3. **只对 JS 版 pnpm 成立**: 它的 bin/pnpm.mjs shebang 是 `#!/usr/bin/env node`,
#    而 Android 没有 /usr/bin/env, 必须包一层启动器显式用 node 拉起。
#    本模块的 pnpm 是 **NDK 编的 Android ELF**(`ELF 64-bit LSB arm64, dynamic
#    (/system/bin/linker64)`), 不读 shebang, **不受这条影响**。
#
# 注意: 下面那三个 npm_config_* 对 pnpm 是 **no-op** (实测 `pnpm config get
# store-dir` 返回 undefined)。留着是因为 **npm** 会读它们 (npm 的变量约定),
# 但不要以为它们在修 pnpm 的问题。
export PNPM_HOME="$DSH_HOME_DIR/pnpm-home"
export npm_config_store_dir="$DSH_HOME_DIR/.pnpm-store"
export npm_config_cache_dir="$DSH_HOME_DIR/.pnpm-cache"
export npm_config_state_dir="$DSH_HOME_DIR/.pnpm-state"
mkdir -p "$PNPM_HOME" "$npm_config_store_dir" "$npm_config_cache_dir" "$npm_config_state_dir" 2>/dev/null

{
	echo ""
	echo "=========================================="
	echo "[$(date)] service.sh 启动"
	echo "  MODDIR=$MODDIR"
	echo "  DSH_HOME=$DSH_HOME"
	echo "  HOME=$HOME"
	echo "=========================================="
} >>"$LOG" 2>&1

# ── 已经在跑就别重复起 ──────────────────────────────────────
if pgrep -f '@deepseek-ai/dsh/lib/bin.js' >/dev/null 2>&1; then
	echo "[$(date)] 已在运行, 跳过" >>"$LOG"
	exit 0
fi

if [ ! -f "$BIN" ]; then
	echo "[$(date)] 找不到 DSH 入口: $BIN" >>"$LOG"
	exit 1
fi
if [ ! -f "$PREFIX/bin/node" ]; then
	echo "[$(date)] 找不到运行时: $PREFIX/bin/node" >>"$LOG"
	exit 1
fi
if [ ! -x "$PREFIX/bin/node" ]; then
	# customize.sh 会设权限, 正常不会走到这里. 走到这里说明权限丢了,
	# 与其在后面报一个看不懂的错, 不如现在就修 + 记一笔.
	echo "[$(date)] usr/bin/node 没有执行位, 尝试补上" >>"$LOG"
	chmod 0755 "$PREFIX/bin/node" 2>/dev/null
fi

# ── 监督进程 ────────────────────────────────────────────────
# 带一个熔断: 如果连续 5 次启动后 10 秒内就退出, 说明是配置或依赖问题,
# 再重启也只是刷日志, 停下来让人看报错.
(
	fails=0
	while true; do
		start=$(date +%s)
		cd "$WS" || cd /
		"$PREFIX/bin/node" --expose-internals "$BIN" web \
			--host "$HOST" --port "$PORT" --no-open >>"$LOG" 2>&1
		rc=$?
		ran=$(( $(date +%s) - start ))

		if [ $ran -lt 10 ]; then
			fails=$((fails + 1))
		else
			fails=0
		fi

		if [ $fails -ge 5 ]; then
			echo "[$(date)] 连续 5 次启动后立刻退出 (rc=$rc), 停止重启. 看上面的报错." >>"$LOG"
			break
		fi

		echo "[$(date)] dsh 退出 (rc=$rc, 运行 ${ran}s), 5 秒后重启" >>"$LOG"
		sleep 5
	done
) &
echo $! >"$DSH_HOME_DIR/supervisor.pid"

sleep 3
if pgrep -f '@deepseek-ai/dsh/lib/bin.js' >/dev/null 2>&1; then
	echo "[$(date)] 已拉起, 监听 $HOST:$PORT" >>"$LOG"
else
	echo "[$(date)] 拉起后 3 秒内没看到进程, 看上面日志" >>"$LOG"
fi
