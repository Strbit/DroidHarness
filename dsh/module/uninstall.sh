#!/system/bin/sh
# uninstall.sh — 卸载时把屏幕识别的托管块从 DSH 的 home 层里摘掉
#
# 为什么这个文件**必须存在**（不是可选的收尾清洁）
# ------------------------------------------------
# 装机时 customize.sh 第 7 节会往 /data/adb/dsh/cordis.patch.yml 写一段托管块。
# 卸载模块时那个目录**不会被删**（它是 DSH_HOME，故意留在模块目录之外，重装不丢
# 配置），于是块就永久留在 DSH 每次启动都要读的位置上。两种残留都是事故:
#
#   · 块里的 command 指向 /data/adb/dsh/tools/screen-mcp，而模块没了 —— 下次
#     任何 DSH 启动都会去 spawn 一个不存在的程序。它不会炸（MCP 子进程失败是
#     隔离的），但模型会看到 4 个调用必失败的工具，这比"没有工具"难解释得多。
#   · 更糟的是"手删块"这条路: 托管块是文件里唯一的内容，删掉它就只剩注释行，
#     而**只剩注释的 patch 文件 DSH 直接拒绝启动**（实测 exit=1 `must be a
#     top-level YAML array`）。home 层解析失败是 throw，service.sh 有 5 次/10 秒
#     的启动熔断 —— 结果不是"屏幕识别没卸干净"，是整个模块装不上/起不来。
#     所以摘块这件事必须**留下 `[]`**，而这正是 register-screen-mcp.mjs 做的。
#
# 为什么交给 .mjs 而不是在这里用 sed 就地删
# -----------------------------------------
# 一段文本手术要同时守住: 只删标记之间、多块只删一份、删完补 `[]`、删后必须
# 仍能解析。sed 写这些要么靠行号要么靠贪婪区间，任一条用户手改过就出错，
# 而这里的失败模式是**砖**。脚本里那套判据已经有 74 项测试守着（每条都过真 DSH
# 断言），复用它，不在第二个地方重写第二套规则。
#
# 为什么整个脚本一路 `|| true`，最后固定 exit 0
# --------------------------------------------
# KernelSU 在卸载流程里跑这个脚本，非零退出会被 Manager 报成"卸载失败"。而这里
# 任何一步失败的后果都只是 home 层里多留一段注释 —— 远轻于"用户卸不掉模块"。
# 所以：能清就清，清不了就说一句，永远不把卸载本身卡住。
#
# 实测的卸载语义（决定了下面为什么这么写）
# ----------------------------------------
# `ksud module uninstall <id>` **不立刻删模块**，它只在模块目录里放一个 `remove`
# 标记（`ksud module undo-uninstall` 能把这个标记撤掉）。真正的删除和这个脚本的
# 执行发生在**下一次开机**，由 ksud 的启动段做；跑的时候模块目录还在，
# `$0` 就是 `<模块目录>/uninstall.sh`。
#
# 那条时间线有两个直接后果:
#   1. 卸载完立刻去看 cordis.patch.yml 是**不会有任何变化的** —— 要重启才算。
#      别把"没变化"读成"uninstall.sh 没生效"。
#   2. 那是个很早、很空的 shell，PATH 可能是空的（本模块没有 system/ 目录，
#      不会被 magic mount 挂进 /system/bin）。所以**不能用 `env VAR=… 命令`**
#      那种写法 —— 它得先找得到 `env` 这个可执行文件，才谈得上设变量。
#      改成子 shell 里显式赋值 + export: 一个外部命令都不依赖，出了子 shell
#      也不污染外面。

MODDIR=${0%/*}
DSH_HOME_DIR=/data/adb/dsh
REG="$MODDIR/bin/register-screen-mcp.mjs"
NODE="$MODDIR/usr/bin/node"
APP="$MODDIR/app"

# 先给一个能用的 PATH: 后面的 sed / wc 还是要靠它，而启动早期它未必被设过。
PATH="/system/bin:/system/xbin:$MODDIR/usr/bin:$PATH"
export PATH

say() { ui_print "dsh: $1" 2>/dev/null || echo "dsh uninstall: $1"; }

say "清理 DSH 里的屏幕识别登记"

if [ ! -f "$REG" ]; then
	# 模块目录已经被删了一半 / 包本身不完整：没辙，只能说明。
	say "[WARN] 没有 bin/register-screen-mcp.mjs，跳过清理"
	say "       /data/adb/dsh/cordis.patch.yml 里可能仍留有 dsh-screen-mcp 托管块"
	exit 0
fi
if [ ! -x "$NODE" ]; then
	say "[WARN] usr/bin/node 不可执行，跳过清理（同上，残留需手工处理）"
	exit 0
fi

# 和 customize.sh 第 6 节同一组变量，理由也在那边说过一次: Termux 编的二进制
# 少一个就起不来。**不 source bin/env.sh** —— 那个文件会 mkdir / chmod 一批
# 数据目录，卸载阶段不需要这些副作用，而且它要求调用方先设 MODDIR（语义是给
# 运行期入口用的，不是给卸载用的）。
#
# HOME 给模块目录而不是 $DSH_HOME_DIR: 卸载时不该再往凭据目录写任何新东西。
# TMPDIR 只有目录真实存在才用它 —— $DSH_HOME_DIR/tmp 是运行期建的，而这次是
# **开机时的卸载**，那次未必存在；指到一个不存在的目录上，node 的临时写会失败。
if [ -d "$DSH_HOME_DIR/tmp" ]; then
	_TMPDIR="$DSH_HOME_DIR/tmp"
else
	_TMPDIR="$MODDIR"
fi

(
	PATH="$MODDIR/usr/bin:/system/bin:/system/xbin"
	LD_LIBRARY_PATH="$MODDIR/usr/lib"
	HOME="$MODDIR"
	TMPDIR="$_TMPDIR"
	SHELL="$MODDIR/usr/bin/bash"
	OPENSSL_CONF="$_TMPDIR/openssl.cnf"
	SSL_CERT_DIR=/system/etc/security/cacerts
	export PATH LD_LIBRARY_PATH HOME TMPDIR SHELL OPENSSL_CONF SSL_CERT_DIR
	"$NODE" "$REG" --home "$DSH_HOME_DIR" --modules "$APP/node_modules" --remove
) 2>&1 | while IFS= read -r _l; do say "$_l"; done || true

say "完成（DSH 自身的配置与凭据目录未动）"
exit 0
