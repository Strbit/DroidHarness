#!/system/bin/sh
# DSH Android Runtime Probe — 安装时验证
#
# 这个脚本在 KSU/Magisk 安装模块时运行, 目的只有一个:
# 在真机上回答"模块能不能 exec 自带二进制, bionic Node 能不能起来".
# 它不启动 DSH, 也不改系统设置.

SKIPUNZIP=0

WORK=/data/local/tmp/dsh-probe
PREFIX="$MODPATH/usr"

ui_print " "
ui_print "*********************************************"
ui_print " DSH Android Runtime Probe  v0.1.0"
ui_print "*********************************************"
ui_print " "
ui_print "- 模块暂存目录: $MODPATH"
ui_print "- Node 运行时:  $PREFIX"
ui_print "- 架构:         $ARCH (API $API)"
ui_print " "

if [ ! -f "$PREFIX/bin/node" ]; then
	ui_print "! 找不到 $PREFIX/bin/node"
	ui_print "! 先跑 tools/fetch-runtime.mjs 把 Termux 的 Node 解进 module/usr/, 再打包安装."
	abort "! 运行时缺失, 探针无法运行"
fi

# ─────────────────────────────────────────────────────────────
# 重建符号链接
#
# PC 上建不了符号链接 (非管理员), 而且把它们物化成副本会让 zip 里塞进几十 MB
# 重复内容 —— 实测 libicudata.so / .so.78 / .so.78.3 是三个 33 MB 的同一份文件.
# 所以 fetch-runtime.mjs 只记了一份清单 (usr/.dsh-symlinks), 这里真正建出来.
# ─────────────────────────────────────────────────────────────
TAB=$(printf '\t')

relink() {
	_p="$1"
	_m="$_p/.dsh-symlinks"
	[ -f "$_m" ] || return 0
	_ok=0
	_bad=0
	while IFS="$TAB" read -r _rel _target; do
		[ -z "$_rel" ] && continue
		case "$_rel" in \#*) continue ;; esac
		_dst="$_p/$_rel"
		mkdir -p "${_dst%/*}" 2>/dev/null
		rm -f "$_dst" 2>/dev/null
		if ln -sfn "$_target" "$_dst" 2>/dev/null; then
			_ok=$((_ok + 1))
		else
			_bad=$((_bad + 1))
		fi
	done <"$_m"
	ui_print "  relink: 建了 $_ok 条, 失败 $_bad 条 ($_p)"
	return 0
}

ui_print "--- 重建符号链接 ---"
relink "$PREFIX"
ui_print " "

# ─────────────────────────────────────────────────────────────
# 环境变量: Termux 编出来的二进制有一批写死的 Termux 路径,
# OPENSSL_CONF / SHELL / TMPDIR 三个少一个都起不来 (实测).
#
# ⚠️ 但 TMPDIR 绝不能指向 /data/local/tmp:
#   本脚本是被 installer.sh **source** 的 (. $MODPATH/customize.sh), 不是子进程,
#   所以这里 export 的变量会留在**安装器自己的 shell** 里. 而安装器在结尾
#   (以及 abort 时) 会执行 `rm -rf $TMPDIR` —— 指向 /data/local/tmp 就等于
#   让安装器把整个目录连根删掉. (dsh 模块真踩了这个坑.)
#   这里指向模块目录内的私有子目录: 就算被删, 删的也是我们自己那个.
# ─────────────────────────────────────────────────────────────
mkdir -p "$MODPATH/.tmp" 2>/dev/null

setup_env() {
	_probe_prefix="$1"
	export PREFIX="$_probe_prefix"
	export LD_LIBRARY_PATH="$_probe_prefix/lib"
	export PATH="$_probe_prefix/bin:/system/bin:/system/xbin"
	export HOME="$WORK"
	export TMPDIR="$MODPATH/.tmp"
	if [ -x "$_probe_prefix/bin/bash" ]; then
		export SHELL="$_probe_prefix/bin/bash"
	else
		export SHELL=/system/bin/sh
	fi
	# 必须指向一个"存在的普通文件", 空文件即可. 不设或指向不存在的路径,
	# Termux 版 Node 会在 bootstrap 阶段静默 exit 13 且什么都不打印.
	export OPENSSL_CONF="$MODPATH/.tmp/openssl.cnf"
	: >"$OPENSSL_CONF"
	# 让 OpenSSL 用安卓系统证书库, 而不是写死的 Termux 路径.
	export SSL_CERT_DIR=/system/etc/security/cacerts
	export NO_COLOR=1
}

ui_print "--- 环境 ---"
setup_env "$PREFIX"
ui_print "  LD_LIBRARY_PATH = $LD_LIBRARY_PATH"
ui_print "  OPENSSL_CONF    = $OPENSSL_CONF"
ui_print "  TMPDIR          = $TMPDIR"
ui_print "  SHELL           = $SHELL"
ui_print " "

# ─────────────────────────────────────────────────────────────
# 权限 —— 必须早于任何执行尝试
#
# KernelSU/Magisk 解压模块时不保留 zip 里的 Unix 权限位, 所以此刻
# usr/bin/node 还没有执行位. 不先设权限, 下面两个 exec 测试会全部假失败;
# 而脚本末尾原本还会再设一次, 于是重启后一切正常 —— 你只会看到一份误导的
# 安装日志, 以为"SELinux 不让 exec", 其实是权限位还没设.
# ─────────────────────────────────────────────────────────────
ui_print "--- 权限 (测试前) ---"
set_perm_recursive "$MODPATH" 0 0 0755 0644
# usr/ 里既有可执行文件也有库, 统一 0755 最省事 —— 库多一个执行位无害,
# 而漏掉某个 bin/libexec 里的可执行文件会很难查.
set_perm_recursive "$MODPATH/usr" 0 0 0755 0755
if [ -x "$PREFIX/bin/node" ]; then
	ui_print "  [ OK ] usr/bin/node 可执行"
else
	ui_print "  [FAIL] usr/bin/node 仍不可执行"
	abort "! 权限设置失败, 后面的测试没有意义"
fi
ui_print " "

# ─────────────────────────────────────────────────────────────
# 测试 A: 能否从模块目录直接 exec
# ─────────────────────────────────────────────────────────────
ui_print "=== 测试 A: 从模块目录 exec ==="
NODE_A_OUT=$("$PREFIX/bin/node" -e 'console.log("A-ok " + process.version + " " + process.platform + "/" + process.arch)' 2>&1)
NODE_A_RC=$?
if [ $NODE_A_RC -eq 0 ]; then
	ui_print "[ OK ] 模块目录 exec 成功"
	ui_print "       $NODE_A_OUT"
	ui_print "       -> 正式模块可以把运行时留在 /data/adb/modules/ 里, 不用搬"
else
	ui_print "[FAIL] 模块目录 exec 失败 (退出码 $NODE_A_RC)"
	ui_print "       $NODE_A_OUT"
	ui_print "       -> 这通常不是 Node 的问题, 而是 SELinux 不让该 domain exec 这个路径."
	ui_print "       -> 看下面的测试 B 是否可行, 以及用 dmesg 找 avc denied"
fi
ui_print " "

# ─────────────────────────────────────────────────────────────
# 测试 B: 搬到 /data/local/tmp 再 exec
# /data/local/tmp 是已知允许任意 domain exec 的位置, 作为退路.
# ─────────────────────────────────────────────────────────────
ui_print "=== 测试 B: 从 /data/local/tmp exec ==="
if [ -x "$WORK/usr/bin/node" ]; then
	ui_print "  已存在上一轮的副本, 跳过拷贝"
else
	ui_print "  正在拷贝运行时到 $WORK/usr (约 110 MB, 请稍等)..."
	rm -rf "$WORK/usr"
	mkdir -p "$WORK"
	cp -a "$PREFIX" "$WORK/usr" 2>/dev/null
	# cp -a 应当保留符号链接; 万一没保留, 这里按清单补一遍
	relink "$WORK/usr"
fi

if [ -x "$WORK/usr/bin/node" ]; then
	setup_env "$WORK/usr"
	NODE_B_OUT=$("$WORK/usr/bin/node" -e 'console.log("B-ok " + process.version + " " + process.platform + "/" + process.arch)' 2>&1)
	NODE_B_RC=$?
	if [ $NODE_B_RC -eq 0 ]; then
		ui_print "[ OK ] /data/local/tmp exec 成功"
		ui_print "       $NODE_B_OUT"
	else
		ui_print "[FAIL] /data/local/tmp exec 也失败 (退出码 $NODE_B_RC)"
		ui_print "       $NODE_B_OUT"
		ui_print "       -> 两个位置都失败, 说明问题在运行时本身 (缺库 / 缺依赖), 不是 SELinux."
	fi
else
	ui_print "[FAIL] 拷贝失败, 无法测试"
fi
ui_print " "

# ─────────────────────────────────────────────────────────────
# 完整探针
# ─────────────────────────────────────────────────────────────
PROBE="$MODPATH/probe/probe.mjs"
if [ -f "$WORK/usr/bin/node" ]; then
	PROBE_NODE="$WORK/usr/bin/node"
	setup_env "$WORK/usr"
else
	PROBE_NODE="$PREFIX/bin/node"
	setup_env "$PREFIX"
fi

if [ -f "$PROBE" ]; then
	ui_print "=== 完整探针 ==="
	"$PROBE_NODE" --expose-internals "$PROBE" >"$WORK/probe.log" 2>&1
	PROBE_RC=$?
	if [ $PROBE_RC -ne 0 ]; then
		ui_print "[WARN] 探针退出码 $PROBE_RC (注意: 不带 --expose-internals 会退出, 见下)"
		ui_print "  用不带该旗标的方式重试一次..."
		# 注意: 这里必须用 >> 追加而不是 > 覆盖.
		# 第一遍 (带 --expose-internals) 的输出正是诊断失败原因的关键,
		# 用 > 会把它整体冲掉, 最终日志里只剩重试结果, 原始报错永久丢失.
		{
			echo ""
			echo "=========================================="
			echo "重试: 不带 --expose-internals (第一遍退出码 $PROBE_RC)"
			echo "=========================================="
		} >>"$WORK/probe.log"
		"$PROBE_NODE" "$PROBE" >>"$WORK/probe.log" 2>&1
		PROBE_RC2=$?
		ui_print "  重试退出码 $PROBE_RC2"
	fi
	while IFS= read -r line; do
		ui_print "$line"
	done <"$WORK/probe.log"
	ui_print " "
	ui_print "完整日志: $WORK/probe.log"
else
	ui_print "! 找不到 $PROBE, 跳过完整探针"
fi

# ─────────────────────────────────────────────────────────────
# 收尾
# ─────────────────────────────────────────────────────────────
ui_print " "
ui_print "=== 收尾 ==="
# 权限已经在测试之前设过了 (见上面「权限」那一节).
# 那里设是必须的: KernelSU/Magisk 解压时不保留 zip 的权限位, 不先设的话
# 测试 A / B 会全部假失败 —— 而末尾再设一次又让重启后一切正常,
# 于是你只会看到一份误导的安装日志. 这个坑踩过一次.
ui_print "- 权限已在测试前设置"

# 留一个标记, 供 service.sh 判断是否已做过拷贝
date >"$WORK/installed-at.txt" 2>/dev/null

ui_print " "
ui_print "*********************************************"
ui_print " 安装完成. 重启后 service.sh 会再跑一次探针,"
ui_print " 日志写到 $WORK/boot-probe.log"
ui_print " 判据见 README.md 的「怎么看结果」"
ui_print "*********************************************"
ui_print " "
