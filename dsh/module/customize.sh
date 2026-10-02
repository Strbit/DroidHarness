#!/system/bin/sh
# DSH on Android — 安装时布署
#
# 这个脚本做三件事: 把运行时接上, 把符号链接建出来, 冒烟测试一次.
# 它不启动 DSH —— 那是 service.sh 的活.

SKIPUNZIP=0

# DSH_HOME 放在模块目录之外, 这样重装模块不会丢掉配置与凭据
DSH_HOME_DIR=/data/adb/dsh
# 工作区放在 /data 下, **不是 /sdcard** —— /sdcard 是 FUSE, 不实现 link(2),
# 而 DSH 的 writeFileAtomic 用 link() 创建新文件, 会导致 agent 建不了任何文件。
# 详见 service.sh 顶部的说明。
WS="$DSH_HOME_DIR/workspace"
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
#
# 为什么要**两趟 + 建完复核**: 清单里的目标可能是**另一条链接** (链式:
#   libncursesw.so -> libncursesw.so.6 -> libncursesw.so.6.5), 单趟顺序建,
# 建到中间那条时它还是悬空的. 而 `ln -sfn` 对不存在的目标**照样返回成功**,
# 所以"建链失败"计数抓不到任何问题 —— 真正的症状要到后面 chown -R 撞上来才
# 暴露. 这次真实装机日志里就是这么一句:
#
#   chown: /data/adb/modules_update/dsh_android/usr/libexec/git-core/git-cvsserver:
#          No such file or directory
#
# chown 默认**跟随**符号链接, 目标不在就是 ENOENT. 那条 chown 报错本身无害
# (下面第 1 趟会先删掉断链), 但它是"清单里有一条永远不可能成立的链接"的信号,
# 不报出来的话就永远没人去查. 所以这里显式分三类统计并打出来.
# ─────────────────────────────────────────────────────────────
ui_print " "
ui_print "--- 重建符号链接 ---"
relink() {
	_p="$1"
	_m="$_p/.dsh-symlinks"
	[ -f "$_m" ] || return 0

	# 第 1 趟: 全部建出来, 并记下每条的路径, 供第 2 趟判定
	_n=0
	while IFS="$TAB" read -r _rel _target; do
		[ -z "$_rel" ] && continue
		case "$_rel" in \#*) continue ;; esac
		_dst="$_p/$_rel"
		mkdir -p "${_dst%/*}" 2>/dev/null
		# 先 rm 再 ln: 不用 ln -sf 是因为目标已存在且是**目录**时, -f 会把链接
		# 建到目录**里面**去, 那就静默建错位置了.
		rm -f "$_dst" 2>/dev/null
		ln -sfn "$_target" "$_dst" 2>/dev/null
		_n=$((_n + 1))
	done <"$_m"

	# 第 2 趟: 逐条核 `ln -sfn` 会不会骗人 —— 它不要求目标存在.
	# 判据是 `[ -e ]` (跟随链接), 不是 `[ -L ]` (只看是不是链接): 只有前者能区分
	# "建出来了"和"建出来了但指向空处".
	_dead=0
	while IFS="$TAB" read -r _rel _target; do
		[ -z "$_rel" ] && continue
		case "$_rel" in \#*) continue ;; esac
		if [ ! -e "$_p/$_rel" ]; then
			if [ "$_dead" -eq 0 ]; then
				ui_print "  [WARN] 以下链接的目标不存在 (断链, 已删除):"
			fi
			_dead=$((_dead + 1))
			# 断链留着只会让 chown/chmod 每次装机都报一行 ENOENT, 把真正该看的
			# 警告淹掉; 而且它本来就用不了. 删掉, 并把名字报出来让人去查清单.
			ui_print "         $_rel -> $_target"
			rm -f "$_p/$_rel" 2>/dev/null
		fi
	done <"$_m"

	ui_print "  清单 $_n 条; 建链后仍断的 $_dead 条已删除 (链式的在第 1 趟末尾即已闭合)"
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

# ripgrep 垫片 (B2)。@vscode/ripgrep 按 platform-arch 找平台包, 而 npm 上没有
# android-arm64 的 —— 没有这个垫片, agent 的 grep / glob 两个核心工具全部不可用,
# 而且服务本身健康、日志干净, 只有调用时才报一句语义模糊的
# "ripgrep launch failed"。
RG_STUB="$APP/node_modules/@vscode/ripgrep-android-arm64"
if [ -f "$RG_STUB/package.json" ] && [ -f "$RG_STUB/bin/rg" ] && [ -f "$RG_STUB/libexec/rg.real" ]; then
	ui_print "  [ OK ] ripgrep 垫片在位 (grep / glob 可用)"
else
	ui_print "  [FAIL] 缺 @vscode/ripgrep-android-arm64 垫片 —— agent 的 grep / glob 会不可用"
	ui_print "         检查 dsh/tools/build-dsh-tree.mjs 是否跑过"
fi

# sharp 替身 + imgtool。sharp 没有 android 平台包, 不换入口的话
# @deepseek-ai/dsh-attachment-local 里每次图片准入都抛 "sharp is not installed",
# 被上游包成 "durable image storage rejected" —— 症状像"图片格式不对", 实际是
# "这个平台上根本没有 sharp"。屏幕识别 (screen_image) 和图片附件都走这条路。
# grep 认的是替身文件里的标记串, 不是文件名: 入口被换回去了要能看出来。
SHARP_DIR="$APP/node_modules/sharp"
SHARP_MAIN="$SHARP_DIR/dist/index.cjs"
if [ -f "$SHARP_MAIN" ] && grep -q "sharp shim (Android)" "$SHARP_MAIN" 2>/dev/null && [ -f "$SHARP_DIR/dist/imgtool" ]; then
	ui_print "  [ OK ] 图像编码替身在位 (screen_image / 图片附件可用)"
else
	ui_print "  [FAIL] sharp 替身或 imgtool 缺失 —— 图片准入会整条失败"
	ui_print "         先跑: node dsh/tools/build-imgtool.mjs && node dsh/tools/build-dsh-tree.mjs"
fi

# KernelSU 的 WebUI 入口. 官方要求: webroot/ 下**必须**有 index.html, 否则
# Manager 根本不显示「WebUI」按钮 —— 也就是说缺文件的表现不是报错, 而是
# "按钮压根没出现", 很容易让人以为模块坏了。装机时就报出来。
if [ -f "$MODPATH/webroot/index.html" ]; then
	ui_print "  [ OK ] WebUI 在位 (webroot/index.html)"
else
	ui_print "  [WARN] 没有 webroot/index.html —— Manager 不会显示「WebUI」入口"
fi

# 屏幕识别 MCP (设备的"眼睛")。这里用 -f 而不是 -x: 此刻 KernelSU 还没保留
# zip 里的权限位, -x 必然为假, 会把一份完好的包报成缺文件。
# 缺了不 abort —— 它不是 DSH 跑起来的必要条件, 报出来让人决定。
SM_TOOLS_SRC="$MODPATH/tools"
SM_TOOLS_DST="$DSH_HOME_DIR/tools"
HAS_SCREEN_MCP=0
if [ -f "$SM_TOOLS_SRC/screen-mcp" ] && [ -f "$SM_TOOLS_SRC/screen-mcp.mjs" ]; then
	HAS_SCREEN_MCP=1
	SM_N=$(find "$SM_TOOLS_SRC" -type f 2>/dev/null | wc -l | tr -d ' \n')
	ui_print "  [ OK ] 屏幕识别在位 (tools/, ${SM_N:-?} 个文件)"
else
	ui_print "  [WARN] 没有 tools/screen-mcp —— 模型看不见屏幕 (mcp__screen__* 不可用)"
	ui_print "         先跑: node dsh/tools/stage-tools.mjs"
fi

# Xposed hook (虚拟副屏跨屏承载的**前置条件**)。
# 为什么必须有它: AOSP 默认拒绝把 App 放到虚拟屏 —— SafeActivityOptions 的
# START_TASK_FROM_DISPLAY 是 signature 权限(root 也拿不到, 实测 "Permission
# Denial ... uid=0 with launchDisplayId=N"), WM 的 canHostTasks 系列也一律返回
# 假。真机实测: 没有 hook 时 `cmd activity display move-stack` 报
# "Unknown displayId=N"。装上并注册作用域后, 微信能被 move-stack 移到副屏。
#
# 作用域必须含 **system**(= system_server), 只有 android 时 hook 不会加载 ——
# 这是本项目实测踩过的坑(LSPosed 的 android 与 system 是两个不同作用域)。
HOOK_APK="$MODPATH/apk/dsh-hook.apk"
if [ -f "$HOOK_APK" ]; then
	ui_print "  [ OK ] 跨屏 hook APK 在位 (apk/dsh-hook.apk)"
else
	ui_print "  [WARN] 没有 apk/dsh-hook.apk —— App 无法移到虚拟副屏"
	ui_print "         先跑: node dsh/tools/build-uiaction.mjs && node dsh/tools/build-hook-apk.mjs"
fi

# ─────────────────────────────────────────────────────────────
# 4. 目录
# ─────────────────────────────────────────────────────────────
ui_print " "
ui_print "--- 目录 ---"
mkdir -p "$DSH_HOME_DIR" 2>/dev/null && ui_print "  [ OK ] $DSH_HOME_DIR"
mkdir -p "$WS" 2>/dev/null && ui_print "  [ OK ] $WS"
mkdir -p "$DSH_HOME_DIR/logs" 2>/dev/null

# ── 数据目录权限: 这里放的是凭据, 不是公开数据 ────────────────
#
#   /data/adb/dsh/profiles/     会话 / 账号凭据
#   /data/adb/dsh/logs/dsh.log  含启动 token (明文)
#
# 旧版本建出来是 0777 / 0666 —— 也就是**任何 app 都能读**。日志里那个 token
# 等同于一次性登录凭据: 读到它就能拿到一个能跑 shell 的 agent 的入口。
#
# 这里**故意不用 umask**: 本脚本是被 installer.sh **source** 的 (见下面第 6 节的
# 警告), umask 会留在安装器自己的 shell 里, 影响它后续的 unzip / find / set_perm。
# 显式 chmod 没有这个副作用。
#
# 运行期新文件的权限由 bin/env.sh 里的 umask 077 保证 (DSH 会自己新建 profiles/)。
#
# 但 umask 只管得到**新建**的东西。旧版本在 umask 0000 下建出来的那批宽权限是
# **存量**, 得递归清一遍。实测 (这台设备, 4031 个条目 / 96M):
#
#   · 整树 `chmod -R u+rwX,go-rwx` 耗时 **69ms** —— 安装路径上没代价。
#     不用 `find -exec chmod`: 那是**每文件一次 fork**, 这里就是 4031 次。
#   · 符号模式的大写 `X` 只对目录或**本来就有执行位**的文件加 x, 所以
#     profiles/*/node_modules/.bin 里真需要执行位的脚本不会被抹掉。
#   · toybox `chmod -R` **不跟符号链接** —— 实测放一个 -> /etc/hosts 的链接进树里,
#     跑完 /etc/hosts 的权限没变, 不会顺着链接跑出去改系统文件。
#   · 收紧后 pnpm 照常工作: store 文件变 600, 但 `dsh plugin --profile web list`
#     仍 exit=0 (store 与 node_modules 是硬链接同 inode, 改权限不影响链接关系)。
chmod 0700 "$DSH_HOME_DIR" "$DSH_HOME_DIR/logs" "$WS" 2>/dev/null
[ -d "$DSH_HOME_DIR/tmp" ] && chmod 0700 "$DSH_HOME_DIR/tmp" 2>/dev/null
[ -d "$DSH_HOME_DIR/profiles" ] && chmod 0700 "$DSH_HOME_DIR/profiles" 2>/dev/null
# 日志可能已经存在 (从旧版本升上来的), 一并收紧
[ -f "$DSH_HOME_DIR/logs/dsh.log" ] && chmod 0600 "$DSH_HOME_DIR/logs/dsh.log" 2>/dev/null
# 整树存量 (升级时会碰到; 全新安装时这棵树基本是空的)
if [ -d "$DSH_HOME_DIR" ]; then
	chmod -R u+rwX,go-rwx "$DSH_HOME_DIR" 2>/dev/null
fi
# 复核: 还剩几个组/其他可写的条目 (正常应为 0)。不静默, 让安装日志自己说话。
_loose=$(find "$DSH_HOME_DIR" -perm -0022 2>/dev/null | wc -l | tr -d ' \n')
ui_print "  数据目录 0700; 日志 0600; 整树已递归收紧 (旧版本是 0777 / 0666)"
if [ "${_loose:-0}" != "0" ]; then
	ui_print "  [WARN] 仍有 $_loose 个条目是组/其他可写"
fi

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
# bin/ 只有四个文件 (dsh / dshctl / env.sh / register-screen-mcp.mjs)，递归一次
# 比四条 set_perm 快也清楚。
#   dsh      —— 文档里 `dsh plugin --profile web add <pkg>` 用的入口 (B1 修复)
#   dshctl   —— 启停控制
#   env.sh   —— 两者共用的环境变量 (只被 source, 但给执行位无害)
#   register-screen-mcp.mjs —— 第 7 节接屏幕识别用 (只被 node 显式调用)
set_perm_recursive "$MODPATH/bin" 0 0 0755 0755
set_perm "$MODPATH/service.sh" 0 0 0755 2>/dev/null
# action.sh 是 KernelSU「执行」按钮的入口: ksud 直接 exec_script 它.
# 没有执行位时按钮只会静默失败, 而失败点离代码很远, 很难归因.
set_perm "$MODPATH/action.sh" 0 0 0755 2>/dev/null
set_perm "$MODPATH/module.prop" 0 0 0644 2>/dev/null

# ─────────────────────────────────────────────────────────────
# 5.5 布署屏幕识别到 $DSH_HOME_DIR/tools
#
# 为什么要拷出去，不直接跑模块目录里的那份
# ------------------------------------------
# launcher.sh 用 `SERVER_DIR=${0%/*}` 推导服务本体的位置，要求启动器和
# screen-mcp.mjs **同目录**；而 cordis.patch.yml 里的 `command:` 是一个写死的
# 绝对路径。两边都指向 /data/adb/dsh/tools/，所以文件必须在那儿。
# 放在模块目录之外还有一层好处：那是 DSH_HOME，升级模块不会覆盖用户
# 在这套识别链路上的任何改动。
#
# 为什么先 rm -rf 再逐文件 cp，而不是直接覆盖
# --------------------------------------------
# 只覆盖会留下**上一版已删除的模块**：比如 lib/foo.mjs 在新版里被移除，
# 旧副本还躺在设备上是惰性的（没人 import 它），但会让人以为设备上还有它，
# 排查时按着那份不存在于新包的文件找 —— 白绕一圈。全清重建让设备侧和
# 模块侧严格一致。
# 这里 rm -rf 一个变量拼出来的路径，风险是真实存在的（本文件第 6 节就记着
# 一次 `rm -rf $TMPDIR` 删掉整个 /data/local/tmp 的事故），所以上面加了
# **路径前缀断言**：DSH_HOME_DIR 必须还是那个硬编码值，才允许动手。
if [ "$HAS_SCREEN_MCP" = "1" ]; then
	case "$SM_TOOLS_DST" in
	/data/adb/dsh/tools) ;;
	*)
		ui_print "  [FAIL] tools 目标路径异常: $SM_TOOLS_DST (期望 /data/adb/dsh/tools)"
		ui_print "         跳过布署 —— 不在一个没把握的路径上执行 rm -rf"
		HAS_SCREEN_MCP=0
		;;
	esac
fi
if [ "$HAS_SCREEN_MCP" = "1" ]; then
	ui_print " "
	ui_print "--- 屏幕识别 ---"
	# 只 rm 不先 mkdir: 上一版这里 mkdir -p 紧跟 rm -rf, 等于先建再拆, 白做一次,
	# 而且读起来像"有意保留目录" —— 会让人以为 rm 之后目录还在。
	rm -rf "$SM_TOOLS_DST" 2>/dev/null
	mkdir -p "$SM_TOOLS_DST" 2>/dev/null
	# 为什么是 find 驱动逐文件 cp，而不是 `cp -a "$SM_TOOLS_SRC/." "$SM_TOOLS_DST/"`
	# ---------------------------------------------------------------------------
	# `dir/.` 这种"只拷内容、不拷目录本身"的写法 GNU cp 有保证，Android 的
	# toybox cp **不保证**。一旦它把 tools/ 当成一个目录整个放进去，结果就是
	# $DST/tools/screen-mcp，而 patch 里写死的是 $DST/screen-mcp —— 症状又变回
	# "MCP 子进程起不来，主服务照常健康"那种最难归因的失败。
	# 逐文件 cp 只用最朴素的 `cp 源 目标`，各实现行为一致。
	#
	# 顺带保持**自动**: stage-tools 以后多加一个 lib 不必回来改这里
	# (写死文件名清单的话，漏一条 = 设备上静默缺那个文件)。
	#
	# 每个文件一次 mkdir + cp: 这里总共 8 个文件。第 5 节那条 `find -exec chmod`
	# 4031 次 fork 的教训是针对两万条目的 app/，个位数条目无所谓。
	find "$SM_TOOLS_SRC" -type f 2>/dev/null | while read -r _sf; do
		_rel=${_sf#"$SM_TOOLS_SRC/"}
		[ -n "$_rel" ] && [ "$_rel" != "$_sf" ] || continue
		case "$_rel" in
		*/*) mkdir -p "$SM_TOOLS_DST/${_rel%/*}" 2>/dev/null ;;
		esac
		cp -f "$_sf" "$SM_TOOLS_DST/$_rel" 2>/dev/null
	done
	# 权限: 启动器是被 exec 的，必须自己带执行位 —— KernelSU 解压时不保留 zip 里的
	# 模式位，这里的 cp 也没带 -p，所以必须显式设。
	# 沿用第 5 节对 app/ 的同一条取舍: 单条 chmod -R 0755，一个进程搞定；给 .mjs
	# 多一个执行位无害，因为父目录 $DSH_HOME_DIR 是 0700、只有 root 进得来。
	# (不写 `find -exec chmod`: 那才是本文件反复告诫的每文件一次 fork。)
	chmod -R 0755 "$SM_TOOLS_DST" 2>/dev/null

	# 复核。这里用 -x 是有意义的 —— 权限刚设完，和第 1 节存在性检查用 -f 不矛盾。
	#
	# 数量比对而不是写死文件名清单: 写死的话，stage-tools 新增一个 lib 而这里
	# 没跟上时，装机日志会是一片 [ OK ] 而设备上真缺那个文件 —— 又是"绿灯掩盖"。
	# 比对 源文件数 vs 落地文件数 才守得住"源里每个文件都装上了"这条不变式。
	SM_DST_N=$(find "$SM_TOOLS_DST" -type f 2>/dev/null | wc -l | tr -d ' \n')
	SM_OK=1
	if [ "${SM_DST_N:-0}" != "${SM_N:-0}" ]; then
		ui_print "  [FAIL] 布署后只有 ${SM_DST_N:-0} 个文件，模块里是 ${SM_N:-0} 个 —— cp 有失败"
		SM_OK=0
	fi
	[ -f "$SM_TOOLS_DST/screen-mcp.mjs" ] || { ui_print "  [FAIL] 缺 screen-mcp.mjs"; SM_OK=0; }
	if [ -x "$SM_TOOLS_DST/screen-mcp" ]; then
		ui_print "  [ OK ] $SM_TOOLS_DST/screen-mcp 可执行"
	else
		ui_print "  [FAIL] screen-mcp 没有执行位 —— MCP 子进程起不来"
		SM_OK=0
	fi
	if [ "$SM_OK" = "1" ]; then
		ui_print "  [ OK ] 屏幕识别已布署 ($SM_DST_N 个文件 -> $SM_TOOLS_DST)"
	else
		ui_print "  [WARN] 屏幕识别布署不完整 —— 第 7 节会跳过接入, 上面的 mcp__screen__* 工具会缺失"
	fi
fi
# ── webroot/ 故意**不在这里出现** ────────────────────────────
# 官方文档明说: 安装模块时 KernelSU 自己会给 webroot/ 设权限和 SELinux 上下文,
# "如果你不知道自己在做什么, 不要自己设置这个目录的权限"。
# WebView 读不到文件时症状会是"WebUI 打开是白屏", 而归因会跑到"页面写错了"上,
# 所以这里留字说明: webroot 的权限**不属于本脚本的职责**, 别顺手加 chmod -R。
ui_print "  usr/ 递归设置; app/ 用 chmod -R 一次搞定; bin/ 三个入口"
ui_print "  webroot/ 不动 (权限与 SELinux 上下文由 KernelSU 安装时设置)"

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

# ─────────────────────────────────────────────────────────────
# 7. 把屏幕识别**接进** DSH (安装即用)
#
# 为什么必须有这一节
# ------------------
# 第 5.5 节把服务本体放到 /data/adb/dsh/tools/ 了，但 DSH 并不会因此就"看见"它：
# 模型要拿到那 4 个 mcp__screen__* 工具，得有一条 patch 把 MCP 适配器插进插件树。
# 以前这一步是装机日志里一句"你自己并进 cordis.patch.yml"。那是把成本推回给用户:
# 他得认识 YAML、知道文件在哪、还得赌自己没写坏缩进 —— 号称安装即用的模块不该
# 有这种步骤。现在由模块自己做。
#
# 为什么落点是 home 层 $DSH_HOME/cordis.patch.yml，不是 profiles/<p>/
# -------------------------------------------------------------------
# readProfilePatches 依次读 bundle 层 → profiles/<p>/cordis.patch.yml →
# **$DSH_HOME/cordis.patch.yml** → --patch。home 层会进到合成后的树里（实测
# --dump-config 有我们那条 insert），而且它对 **web 和命令行两个入口都生效**:
# service.sh 和 bin/dsh 共用 bin/env.sh。写 profile 层只覆盖一个入口，症状会是
# "浏览器里有工具、命令行没有"。
# 另一层原因: profiles/<p>/cordis.yml 装载时会被 DSH 自己改写，不是能长期共存
# 的落点；home 层没有任何 DSH 写入者，我们写的内容不会跟谁抢。
#
# 为什么这节放在第 6 节**之后**
# ----------------------------
# 它要用 run_node（node 可执行性也是第 6 节刚刚冒烟验证过的）。放前面就得把
# 那套 env 再抄一遍 —— 两份 env 迟早漂移，漂移的代价是装机时能跑、开机时崩。
#
# 为什么绝不 abort
# ---------------
# 接不进去 = 少 4 个工具，DSH 本身照常可用；abort = 整个模块装不上。
# 所以这里只报 [WARN]。而 register-screen-mcp.mjs 内部相反 —— 它自检不过就
# **一个字都不写**（宁可不登记）：写坏 home 层的代价是 DSH 起不来，而
# service.sh 有 5 次/10 秒的启动熔断，熔断后模块自启也没了。
# ─────────────────────────────────────────────────────────────
if [ "$HAS_SCREEN_MCP" = "1" ] && [ "$SM_OK" = "1" ]; then
	ui_print " "
	ui_print "--- 接入 DSH (屏幕识别) ---"
	REG_BIN="$MODPATH/bin/register-screen-mcp.mjs"
	if [ -f "$REG_BIN" ]; then
		# --home 显式传，不依赖环境变量: 安装器的 shell 里 DSH_HOME 未必存在
		# (那是 env.sh 运行期才 export 的)，静默 fallback 会把 patch 写到别处。
		# --modules 指到模块自带的 app/node_modules: 脚本要用它做写入前自检。
		# --patch-src 也显式传: 托管块的**内容**来自这份模板（脚本里不留副本，
		# 副本会漂移）。它本来默认就解析到 $MODPATH/tools/ 这一份，写出来是为了
		# 让"装机日志里的 [ OK ] 是从哪条条目来的"在本文件里就能一眼看到。
		REG_OUT=$(cd "$APP" && run_node "$REG_BIN" --home "$DSH_HOME_DIR" --modules "$APP/node_modules" --patch-src "$MODPATH/tools/cordis.patch.example.yml" 2>&1)
		REG_STATUS=$(printf '%s\n' "$REG_OUT" | sed -n 's/^STATUS: //p' | tail -n 1)
		case "$REG_STATUS" in
		REGISTERED) ui_print "  [ OK ] 已登记到 $DSH_HOME_DIR/cordis.patch.yml" ;;
		UNCHANGED) ui_print "  [ OK ] 早已登记且是最新条目 —— 未改动任何字节" ;;
		REPLACED) ui_print "  [ OK ] 条目已过期，原地刷新（模块升级改了路径）" ;;
		SKIPPED-DUPE) ui_print "  [ OK ] 你已手工加过 screen 这个 server —— 不插第二份" ;;
		*)
			ui_print "  [WARN] 没接进去 (status=${REG_STATUS:-无}) —— 4 个 mcp__screen__* 暂不可用"
			# 把脚本原话打出来: 它拒绝写入总是有具体理由（文件读不准 / 自检不过），
			# 只报"失败了"会让人去查错方向。
			printf '%s\n' "$REG_OUT" | while IFS= read -r _l; do
				ui_print "         $_l"
			done
			;;
		esac
	else
		ui_print "  [WARN] 没有 bin/register-screen-mcp.mjs —— 屏幕识别不会自动接入"
		ui_print "         这个文件必须由仓库里的 dsh/module/bin/ 带上，缺它是打包问题"
	fi
fi

# ─────────────────────────────────────────────────────────────
# 8. 虚拟副屏跨屏 hook: 装 APK + 注册 LSPosed 作用域
#
# 为什么必须自动注册, 不能"让用户去 LSPosed 里手动勾一下"
# ------------------------------------------------------
# 这是**安装即用**的硬要求: 手勾作用域是"安装后还得改配置", 与本项目的
# 底线冲突。LSPosed 的模块与作用域都在一个 sqlite 库里, 可以直接写:
#   /data/adb/lspd/config/modules_config.db
#     modules(module_pkg_name, apk_path)             — 登记模块
#     modules_state(module_pkg_name, user_id, enabled) — 启用
#     scope(module_pkg_name, app_pkg_name, user_id)  — 作用域
#
# ⚠ 作用域必须同时写 **android** 和 **system**
#   LSPosed 里 "android"(安卓系统) 与 "system"(系统框架) 是两个不同的作用域。
#   只勾 android 时 hook **不会加载** —— 真机实测: 模块日志里一行都没有; 补上
#   system 后立刻出现 "[DshHook] loaded in system_server"。
#
# 写库工具: 模块自带 bin/sqlite3(与 agent-mobile-use 同一份, MIT/公有域)。
# 它是"静默"版本 —— SELECT 不回显结果, 但 INSERT/DELETE 正常工作(已交叉验证:
# 写入后由 Termux sqlite3 读出)。
#
# LSPosed 装在别的路径 / 没装: 全部只报 [WARN], 绝不 abort 装机。
# 装完需要**重启**才生效(hook 在 system_server 启动时注入), 结尾会提示。
# ─────────────────────────────────────────────────────────────
ui_print " "
ui_print "--- 虚拟副屏跨屏 hook ---"
HOOK_PKG="com.dsh.hook"
# 本段自带 HOOK_APK 定义: 上面第 6 节虽已定义过一次, 但 customize-deploy-test
# 抽取"§7 接入段"时边界到 `# ── 结尾提示:`(即**连同 §8 一起**), 那个片段里
# 没有第 6 节 → set -u 下引用未定义变量会直接崩, 安装器跟着中断。
# 自带一份既让本段自洽, 也让门禁能真正跑到 §8。
HOOK_APK="$MODPATH/apk/dsh-hook.apk"
LSP_DB="/data/adb/lspd/config/modules_config.db"
SQLITE_BIN="$MODPATH/bin/sqlite3"

if [ ! -f "$HOOK_APK" ]; then
	ui_print "  [WARN] 跳过 —— 没有 hook APK, App 无法移到虚拟副屏"
elif [ ! -d /data/adb/lspd ]; then
	ui_print "  [WARN] 没检测到 LSPosed (/data/adb/lspd 不存在)"
	ui_print "         副屏本身可用(screen_vd_start/screen_vd_shot); 但 App 上不去副屏"
	ui_print "         需要 LSPosed + Zygisk 环境(模块不主动装它们, 那会改动系统)"
elif [ ! -f "$SQLITE_BIN" ]; then
	ui_print "  [WARN] 没有 bin/sqlite3 —— 无法自动注册作用域"
	ui_print "         先跑: node dsh/tools/build-uiaction.mjs 之外还要带上 sqlite3"
else
	# 8.1 装 APK
	INSTALL_OUT=$(pm install -r -t "$HOOK_APK" 2>&1)
	case "$INSTALL_OUT" in
	*Success*) ui_print "  [ OK ] hook APK 已安装 ($HOOK_PKG)" ;;
	*) ui_print "  [WARN] hook APK 安装失败: $(printf '%s' "$INSTALL_OUT" | head -n 1)" ;;
	esac

	# 8.2 注册作用域(仅在装成功时)
	APK_PATH=$(pm path "$HOOK_PKG" 2>/dev/null | head -n 1 | cut -d':' -f2)
	if [ -n "$APK_PATH" ]; then
		chmod 755 "$SQLITE_BIN" 2>/dev/null
		# bin/sqlite3 用的是 Termux 那一份(真 sqlite3, 3.53.x)。
		# 它动态链接 libz.so.1 —— 必须带上模块自己的 usr/lib(那里有
		# libz.so.1 -> libz.so.1.3.2 的软链, 由本脚本前面的"重建符号链接"
		# 那步建出来)。不带 LD_LIBRARY_PATH 会 CANNOT LINK 而静默失败,
		# 症状是"模块装了但作用域没注册"。
		# 相比作者随包的那份 shim(只吃单条语句、SELECT 不回显), 真 sqlite3
		# 能回读校验 —— 下面第 8.4 步就靠它。
		sql_run() { LD_LIBRARY_PATH="$MODPATH/usr/lib" "$SQLITE_BIN" "$@"; }
		sql_run "$LSP_DB" "INSERT OR REPLACE INTO modules (module_pkg_name, apk_path) VALUES ('$HOOK_PKG', '$APK_PATH');" 2>/dev/null
		sql_run "$LSP_DB" "INSERT OR REPLACE INTO modules_state (module_pkg_name, user_id, enabled) VALUES ('$HOOK_PKG', 0, 1);" 2>/dev/null
		# 两个作用域都要: android(system_server 进程) 与 system(系统框架)。
		# 缺 system 的表现是"模块装了、启用了、但一行日志都没有" —— 极难归因。
		sql_run "$LSP_DB" "INSERT OR REPLACE INTO scope (module_pkg_name, app_pkg_name, user_id) VALUES ('$HOOK_PKG', 'android', 0);" 2>/dev/null
		sql_run "$LSP_DB" "INSERT OR REPLACE INTO scope (module_pkg_name, app_pkg_name, user_id) VALUES ('$HOOK_PKG', 'system', 0);" 2>/dev/null

		# 8.4 回读校验(真 sqlite3 能回显, shim 不能):
		# 只报 OK 而不核对, 就分不清"写进去了"和"静默失败" —— 而作用域没写进去
		# 的后果是副屏上不了 App, 且**没有任何报错**。
		CHECK=$(sql_run "$LSP_DB" \
			"SELECT (SELECT count(*) FROM modules WHERE module_pkg_name='$HOOK_PKG') \
			      || '/' || (SELECT count(*) FROM modules_state WHERE module_pkg_name='$HOOK_PKG' AND enabled=1) \
			      || '/' || (SELECT count(*) FROM scope WHERE module_pkg_name='$HOOK_PKG');" 2>/dev/null | tr -d '\r')
		case "$CHECK" in
		1/1/2) ui_print "  [ OK ] LSPosed 作用域已注册 (android + system, 回读校验 1/1/2)" ;;
		"")    ui_print "  [WARN] 作用域写库后回读为空 —— sqlite3 可能跑不起来(LD_LIBRARY_PATH 不对?)" ;;
		*)     ui_print "  [WARN] 作用域回读异常($CHECK, 期望 1/1/2) —— 可能只写进去一部分" ;;
		esac

		# 8.3 安全启用标记 —— hook 只在存在这个文件时才生效。
		#
		# 为什么要它(这是"必须格式化 /data 才救回来"那次事故的整改):
		#   在 system_server 里 hook 出问题会让系统起不来, 而那时用户**没法**
		#   去 LSPosed 里关模块(系统都进不去)。有了标记文件:
		#     · 数据被清 / 手动删除标记 → 模块**彻底惰性**, 不可能再拖垮开机
		#     · 想临时关掉: 删这个文件, 或 setprop persist.dsh.vd.hook 0
		#   hook 端另有三道自保: 只改"返回 boolean"的方法(不会误改别的重载)、
		#   全程吞异常、连续 3 次启动失败自动停用自己。
		#
		# ⚠ 路径必须是 /data/system, 不能放 /data/adb/dsh ——
		#   /data/adb 是 drwx------(700, 仅 root), hook 跑在 system_server
		#   (uid 1000) 里读不到它, File.exists() 会当成"不存在"(实测踩过:
		#   标记建了, 日志仍报 inert)。/data/system 是 system_server 自己的
		#   地盘, 一定能读, 且 factory reset 会清掉它。
		MARKER="/data/system/dsh-vd-hook.on"
		if : > "$MARKER" 2>/dev/null; then
			ui_print "  [ OK ] 安全启用标记已创建 ($MARKER)"
		else
			ui_print "  [WARN] 建不了启用标记 —— hook 将保持惰性(App 上不了副屏)"
		fi
		rm -f /data/system/dsh-vd-hook-fails 2>/dev/null  # 清掉历史失败计数

		ui_print "         ⚠ 需重启一次才生效 —— hook 在 system_server 启动时注入"
		ui_print "  [救急] 万一开机异常: 删掉 $MARKER 即可让 hook 失效"
	else
		ui_print "  [WARN] 装完拿不到 APK 路径, 作用域未注册"
	fi
fi

# ── 结尾提示: 这里印的每一条命令都必须是**能直接抄着跑**的 ──────────
#
# 为什么全用绝对路径: 实测 `su -c` 起来的 shell **PATH 是空的**
# (adb shell 里 `su -c 'echo $PATH'` -> 空串), 而本模块没有 system/ 目录,
# 也就不会被 magic mount 挂进 /system/bin。所以之前那句"dsh 已在 PATH 上"
# 是假的 —— `su -c 'command -v dsh'` 直接报找不到。同理裸写 `dshctl url`
# 也抄不通。激活后的固定路径就是 /data/adb/modules/<id>/bin/。
# MODID 由安装器注入; 万一没有, 兜底用 module.prop 里那个固定的 id。
CTL="/data/adb/modules/${MODID:-dsh_android}/bin/dshctl"
DSHBIN="/data/adb/modules/${MODID:-dsh_android}/bin/dsh"
ui_print " "
ui_print "*********************************************"
ui_print " 安装完成. 重启后 service.sh 会拉起 DSH."
ui_print " 日志: $DSH_HOME_DIR/logs/dsh.log"
ui_print " 控制: su -c '$CTL start|stop|status|log|token|url'"
ui_print " 命令行: su -c '$DSHBIN plugin --profile web list'"
# 别写"浏览器开 http://127.0.0.1:3080" 就完事: 不带 token 直接开只会得到一个 401,
# 然后人就以为没装好。入口给成 url —— 它打出的就是能直接用的整条链接。
ui_print " 访问: 手机上 su -c '$CTL url'  取带 token 的完整链接"
ui_print "       PC 上再加一步 adb forward tcp:3080 tcp:3080"
ui_print "*********************************************"
ui_print " "
