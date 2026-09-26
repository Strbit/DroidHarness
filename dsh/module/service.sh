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
export DSH_HOME="$DSH_HOME_DIR"
export LD_LIBRARY_PATH="$PREFIX/lib"
export PATH="$PREFIX/bin:/system/bin:/system/xbin"
export HOME="$WS"
export TMPDIR=/data/local/tmp
export SHELL="$PREFIX/bin/bash"
export OPENSSL_CONF=/data/local/tmp/dsh-openssl.cnf
: >"$OPENSSL_CONF" 2>/dev/null
export SSL_CERT_DIR=/system/etc/security/cacerts
export NO_COLOR=1

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
