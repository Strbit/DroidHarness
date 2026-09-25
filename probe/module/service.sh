#!/system/bin/sh
# DSH Android Runtime Probe — 开机验证
#
# customize.sh 证明的是"安装时能 exec"; 这里证明的是"开机时能 exec".
# 后者才是 DSH 真正依赖的路径 —— 模块的 service.sh 就是这样把 dsh web 拉起来的.

MODDIR=${0%/*}
WORK=/data/local/tmp/dsh-probe
LOG="$WORK/boot-probe.log"
PREFIX="$MODDIR/usr"

# 等系统真正起来. 太早的话 ART / 动态链接器可能还没就绪.
i=0
while [ "$(getprop sys.boot_completed)" != "1" ] && [ $i -lt 180 ]; do
	sleep 1
	i=$((i + 1))
done
sleep 5

mkdir -p "$WORK/tmp" 2>/dev/null

{
	echo "=========================================="
	echo "DSH Android Runtime Probe — 开机验证"
	echo "时间:   $(date)"
	echo "模块:   $MODDIR"
	echo "内核:   $(uname -r)"
	echo "上下文: $(cat /proc/self/attr/current 2>/dev/null | tr -d '\0')"
	echo "uid:    $(id -u 2>/dev/null)"
	echo "=========================================="
	echo ""

	export PREFIX="$PREFIX"
	export LD_LIBRARY_PATH="$PREFIX/lib"
	export PATH="$PREFIX/bin:/system/bin:/system/xbin"
	export HOME="$WORK"
	export TMPDIR="$WORK/tmp"
	if [ -x "$PREFIX/bin/bash" ]; then
		export SHELL="$PREFIX/bin/bash"
	else
		export SHELL=/system/bin/sh
	fi
	export OPENSSL_CONF="$WORK/openssl.cnf"
	: >"$OPENSSL_CONF"
	export SSL_CERT_DIR=/system/etc/security/cacerts
	export NO_COLOR=1

	echo "--- 开机时从模块目录 exec ---"
	"$PREFIX/bin/node" -e 'console.log("boot-modpath-ok " + process.version + " " + process.platform + "/" + process.arch)' 2>&1
	echo "退出码: $?"
	echo ""

	if [ -f "$MODDIR/probe/probe.mjs" ]; then
		echo "--- 完整探针 (--expose-internals) ---"
		"$PREFIX/bin/node" --expose-internals "$MODDIR/probe/probe.mjs" 2>&1
		echo ""
		echo "--- 完整探针 (无旗标) ---"
		"$PREFIX/bin/node" "$MODDIR/probe/probe.mjs" 2>&1
	fi

	echo ""
	echo "=========================================="
	echo "开机验证结束"
	echo "=========================================="
} >"$LOG" 2>&1

# 让文件管理器 / adb 都能读到
chmod 0644 "$LOG" 2>/dev/null
