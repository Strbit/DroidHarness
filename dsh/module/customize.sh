#!/system/bin/sh
# DSH on Android — 安装时布署
#
# 这个脚本做三件事: 把运行时接上, 把符号链接建出来, 冒烟测试一次.
# 它不启动 DSH —— 那是 service.sh 的活.

SKIPUNZIP=0

# DSH_HOME 放在模块目录之外, 这样重装模块不会丢掉配置与凭据
DSH_HOME_DIR=/data/adb/dsh
# 工作区放在共享存储, 文件管理器能翻到
WS=/sdcard/DroidHarness
PREFIX="$MODPATH/usr"
APP="$MODPATH/app"
TAB=$(printf '\t')

ui_print " "
ui_print "*********************************************"
ui_print " DSH on Android  v0.1.0"
ui_print "*********************************************"
ui_print " "
ui_print "- 模块目录: $MODPATH"
ui_print "- 运行时:   $PREFIX"
ui_print "- 应用:     $APP"
ui_print "- DSH_HOME: $DSH_HOME_DIR"
ui_print "- 工作区:   $WS"
ui_print " "

# ─────────────────────────────────────────────────────────────
# 1. 运行时 (只查存在性, 不查执行位)
#
# 用 -f 而不是 -x: KernelSU/Magisk 解压模块时不保留 zip 里的 Unix 权限位,
# 所以此刻 usr/bin/node 还没有执行位, 用 -x 会误判成"缺失".
# 权限在第 5 步统一设置, 必须早于任何执行尝试.
# ─────────────────────────────────────────────────────────────
if [ ! -f "$PREFIX/bin/node" ]; then
	ui_print "! 找不到 $PREFIX/bin/node"
	ui_print "! 先跑: node probe/tools/fetch-runtime.mjs --out dsh/module"
	abort "! 运行时缺失"
fi
ui_print "--- 运行时 ---"
for b in node bash rg; do
	if [ -f "$PREFIX/bin/$b" ]; then
		ui_print "  [ OK ] usr/bin/$b"
	else
		ui_print "  [WARN] usr/bin/$b 缺失"
	fi
done

# ─────────────────────────────────────────────────────────────
# 2. 重建符号链接
#
# Termux 的 .so 是 libfoo.so -> libfoo.so.78.3 三连. 构建期在 PC 上不建链接
# (建不了, 而且物化成副本会塞进几十 MB 重复内容), 只记了一份清单, 这里真正建出来.
# ─────────────────────────────────────────────────────────────
ui_print " "
ui_print "--- 重建符号链接 ---"
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
	ui_print "  建了 $_ok 条, 失败 $_bad 条"
	return 0
}
relink "$PREFIX"

# ─────────────────────────────────────────────────────────────
# 3. 应用树与 shim
# ─────────────────────────────────────────────────────────────
DSH_BIN="$APP/node_modules/@deepseek-ai/dsh/lib/bin.js"
SHIM="$APP/node_modules/node-addon-require-builtin/lib/index.js"

ui_print " "
ui_print "--- 应用树 ---"
if [ ! -f "$DSH_BIN" ]; then
	ui_print "! 找不到 $DSH_BIN"
	ui_print "! 先跑: node dsh/tools/build-dsh-tree.mjs"
	abort "! 应用树缺失"
fi
ui_print "  [ OK ] DSH 入口在位"

if [ -f "$SHIM" ] && grep -q "JS shim" "$SHIM" 2>/dev/null; then
	ui_print "  [ OK ] node-addon-require-builtin 已被 JS 替身顶替"
else
	ui_print "  [FAIL] shim 未生效 —— dsh-app-boot 会在启动时抛错"
	ui_print "         检查 dsh/tools/build-dsh-tree.mjs 是否跑过"
fi

# ─────────────────────────────────────────────────────────────
# 4. 目录
# ─────────────────────────────────────────────────────────────
ui_print " "
ui_print "--- 目录 ---"
mkdir -p "$DSH_HOME_DIR" 2>/dev/null && ui_print "  [ OK ] $DSH_HOME_DIR"
mkdir -p "$WS" 2>/dev/null && ui_print "  [ OK ] $WS"
mkdir -p "$DSH_HOME_DIR/logs" 2>/dev/null

# ─────────────────────────────────────────────────────────────
# 5. 权限
#
# 必须早于任何执行尝试. KernelSU/Magisk 解压模块时不保留 zip 里的 Unix 权限位,
# 所以此刻 usr/bin/node 还没有执行位 —— 先设权限, 再跑冒烟测试.
#
# 注意: 绝对不要对 $MODPATH 做 set_perm_recursive —— app/ 有两万五千多个文件,
# 而 set_perm 是逐个 shell 调用, 会慢到不可接受.
# ─────────────────────────────────────────────────────────────
ui_print " "
ui_print "--- 权限 ---"
# usr/ 只有一百多个文件, 递归没问题
set_perm_recursive "$PREFIX" 0 0 0755 0755
# app/ 两万多个文件, 用一条 chmod -R 解决 (只起一个进程).
# 这里直接给 0755 而不是 a+rX: 解压出来的权限位不可靠, 而 X 依赖"本来就有执行位".
# 给 JS 文件多一个执行位无害 —— 模块目录本来就只有 root 能进.
chmod -R 0755 "$MODPATH/app" 2>/dev/null
set_perm "$MODPATH/bin/dshctl" 0 0 0755 2>/dev/null
set_perm "$MODPATH/service.sh" 0 0 0755 2>/dev/null
set_perm "$MODPATH/module.prop" 0 0 0644 2>/dev/null
ui_print "  usr/ 递归设置; app/ 用 chmod -R 一次搞定"

# 复核一次. 如果 node 仍不可执行, 后面必然失败, 不如在这里就说清楚.
if [ -x "$PREFIX/bin/node" ]; then
	ui_print "  [ OK ] usr/bin/node 现在可执行"
else
	ui_print "  [FAIL] usr/bin/node 仍不可执行 —— 权限设置没生效"
	abort "! 权限设置失败"
fi

# ─────────────────────────────────────────────────────────────
# 6. 冒烟测试
#
# ⚠️⚠️ 这个脚本是被 installer.sh **source** 进去的, 不是当子进程跑的:
#
#     [ -f $MODPATH/customize.sh ] && . $MODPATH/customize.sh
#
#   所以这里 export 的变量会留在**安装器自己的 shell** 里. 而安装器在结尾
#   (以及 abort 时) 会做:
#
#     rm -rf $TMPDIR
#
#   一旦这里 export TMPDIR=/data/local/tmp, 那一句就变成 rm -rf /data/local/tmp
#   —— 把整个目录连根删掉. **这个坑真的踩了**, 代价是用户 /data/local/tmp 里的东西全没.
#
#   所以下面一律用 `env VAR=... 命令` 的形式: 只对那一条命令生效, 不污染安装器的 shell.
#   同理**不要 export PATH / LD_LIBRARY_PATH** —— 安装器后面还要用 unzip / find / set_perm.
# ─────────────────────────────────────────────────────────────
ui_print " "
ui_print "--- 冒烟测试 ---"

# 自己的临时目录, 完全不碰 /data/local/tmp
DSH_TMP="$DSH_HOME_DIR/tmp"
mkdir -p "$DSH_TMP" 2>/dev/null
OPENSSL_CONF_FILE="$DSH_TMP/openssl.cnf"
: >"$OPENSSL_CONF_FILE" 2>/dev/null

# 只对单条命令生效的环境. 不用 export.
run_node() {
	env \
		PATH="$PREFIX/bin:/system/bin:/system/xbin" \
		LD_LIBRARY_PATH="$PREFIX/lib" \
		HOME="$DSH_HOME_DIR" \
		TMPDIR="$DSH_TMP" \
		SHELL="$PREFIX/bin/bash" \
		OPENSSL_CONF="$OPENSSL_CONF_FILE" \
		SSL_CERT_DIR=/system/etc/security/cacerts \
		"$PREFIX/bin/node" "$@"
}

NODE_VER=$(run_node -v 2>&1)
ui_print "  node -v          -> $NODE_VER"

SMOKE=$(cd "$APP" && run_node --expose-internals -e '
const a = require("node-addon-require-builtin");
const m = a.requireBuiltin("internal/modules/esm/loader");
console.log("shim-ok", typeof m, typeof m.getOrInitializeCascadedLoader);
' 2>&1)
ui_print "  shim 取 internal -> $SMOKE"

case "$SMOKE" in
	shim-ok*object*function*) ui_print "  [ OK ] 启动路径前提全部满足" ;;
	*) ui_print "  [FAIL] 见上面输出" ;;
esac

# 收尾: 确认没有污染安装器的 TMPDIR (那会害安装器删错目录)
ui_print "  (安装器 TMPDIR = ${TMPDIR:-未设} —— 不应是 /data/local/tmp)"

ui_print " "
ui_print "*********************************************"
ui_print " 安装完成. 重启后 service.sh 会拉起 DSH."
ui_print " 日志: $DSH_HOME_DIR/logs/dsh.log"
ui_print " 控制: dshctl start|stop|status|log"
ui_print " 访问: PC 上 adb forward tcp:3080 tcp:3080"
ui_print "       然后浏览器开 http://127.0.0.1:3080"
ui_print "*********************************************"
ui_print " "
