#!/system/bin/sh
# DSH on Android — 共享环境变量
#
# 被 `service.sh`(拉起服务) 和 `bin/dsh`(命令行入口) **共同 source**。
#
# 为什么要抽出来
# --------------
# 这两处必须给出**完全一致**的环境。如果 `dsh plugin --profile web add <pkg>`
# 拿到的 LD_LIBRARY_PATH / GIT_EXEC_PATH / HOME 和服务进程不同, 就会出现
# 「服务里 git submodule 能用, dsh 命令里却报 'not a git command'」这类
# 分裂现象 —— 症状诡异, 而且极难定位, 因为两个进程看起来跑的是同一份代码。
#
# 用法
# ----
#   MODDIR=$(cd "${0%/*}/.." && pwd)     # 或在 service.sh 里 ${0%/*}
#   . "$MODDIR/bin/env.sh"
#
# **调用方必须先设好 MODDIR** —— source 时 `$0` 是外层脚本, 本文件没法可靠地
# 自己算出模块根, 所以不做猜测, 直接要求调用方给。
#
# 不要直接执行本文件 (它是给 `.` / source 用的, 直接跑只会启动一个空 shell)。

: "${MODDIR:?env.sh 需要调用方先设好 MODDIR(模块根路径)}"

# ── 路径 ────────────────────────────────────────────────────
DSH_HOME_DIR=/data/adb/dsh

# **工作区必须是 /data 下的路径, 不能是 /sdcard。**
# Android 的 /sdcard 是 FUSE, **不实现 link(2)**, 而 DSH 的 writeFileAtomic
# 给「创建新文件」走的正是 link()(为了拿 no-replace 语义), 于是 agent 无法新建
# 任何文件, 只能改已存在的。详见 service.sh 顶部那段说明。
WS="$DSH_HOME_DIR/workspace"

PREFIX="$MODDIR/usr"
APP="$MODDIR/app"
BIN="$APP/node_modules/@deepseek-ai/dsh/lib/bin.js"
LOG="$DSH_HOME_DIR/logs/dsh.log"
HOST=127.0.0.1
PORT=3080

export DSH_HOME_DIR DSH_HOME="$DSH_HOME_DIR" WS PREFIX APP BIN LOG HOST PORT

# ── 基础环境 ────────────────────────────────────────────────
# Termux 编出来的二进制有一批写死的 Termux 路径, 这几个少一个都起不来。
#
# TMPDIR 指向私有目录而不是 /data/local/tmp:
#   · /data/local/tmp 是共享目录 (shell 拥有, 很多工具在用), 会话临时文件不该丢里面
#   · 更重要的是: customize.sh 是被 installer.sh source 的, 那里 export TMPDIR
#     会让安装器结尾的 `rm -rf $TMPDIR` 删掉错误的东西 (这个坑真踩了)。
#     这两个脚本都是当子进程跑的, export 不会外泄, 但仍用私有目录保持一致。
export LD_LIBRARY_PATH="$PREFIX/lib"
# $MODDIR/bin 放 dsh / dshctl 两个命令行入口 (见 bin/dsh)。
export PATH="$PREFIX/bin:$MODDIR/bin:/system/bin:/system/xbin"
export HOME="$WS"
export TMPDIR="$DSH_HOME_DIR/tmp"
export SHELL="$PREFIX/bin/bash"
export OPENSSL_CONF="$TMPDIR/openssl.cnf"
export SSL_CERT_DIR=/system/etc/security/cacerts

mkdir -p "$DSH_HOME_DIR/logs" "$WS" "$TMPDIR" 2>/dev/null

# ── 权限: 数据目录只给 root ──────────────────────────────────
#
# /data/adb/dsh 下放的是**凭据和会话状态**, 不是公开数据:
#
#   profiles/          会话 / 账号凭据
#   logs/dsh.log       含启动 token (明文)
#
# 旧版本建出来是 0777 / 0666 —— 也就是**任何 app 都能读**。日志里那个 token
# 等同于一次性登录凭据, 读到就能拿到一个能跑 shell 的 agent 的入口。
#
# umask 077 放在这里(而不是只在 customize.sh 里显式 chmod)是因为:
#   · DSH 运行期会**自己新建** profiles/ 下的文件, 只有 umask 能保证新文件也收紧;
#   · 本文件被 service.sh(source 之外的子进程)和 bin/dsh 使用, umask 不会外泄。
#     ⚠️ 不要把这个 umask 挪进 customize.sh —— 那个脚本是被 installer.sh
#     **source** 的, umask 会留在安装器的 shell 里 (同文件第 6 节警告的 TMPDIR 坑)。
umask 077

# 已经存在的旧权限一并收紧 (覆盖旧版本装的树)
chmod 0700 "$DSH_HOME_DIR" "$DSH_HOME_DIR/logs" "$TMPDIR" "$WS" 2>/dev/null
[ -d "$DSH_HOME_DIR/profiles" ] && chmod 0700 "$DSH_HOME_DIR/profiles" 2>/dev/null
[ -f "$LOG" ] && chmod 0600 "$LOG" 2>/dev/null

# 先确认目录真的存在再写: `: >"$F"` 的重定向错误发生在命令执行**之前**,
# 所以行尾的 2>/dev/null 挡不住它; 而 `:` 是 POSIX 特殊内建命令,
# **重定向失败会直接终止整个 shell** (dash 实测如此, mksh 同属 POSIX 行为)。
# 那会让 service.sh / bin/dsh 静默退出, 症状是"什么都没发生"。
if [ -d "$TMPDIR" ]; then
	: >"$OPENSSL_CONF" 2>/dev/null || true
fi

# ── git ─────────────────────────────────────────────────────
#
# git 的 ELF 里**编译进了** Termux 前缀的 exec-path, 于是所有**脚本型子命令**
# 全都找不到, 而且报的是**误导性**的错误:
#
#     $ git submodule
#     git: 'submodule' is not a git command. See 'git --help'.
#
# 这会把人带偏到「git 装得不全」—— 而 `git-submodule` 明明就在模块里、
# shebang 也已经修成 `#!/system/bin/sh`。真正的原因是: **git 压根不去模块目录找,
# 它只查 exec-path**, 而 exec-path 是编译进二进制的:
#
#     $ git --exec-path
#     /data/data/com.termux/files/usr/libexec/git-core      ← 这个目录不存在
#
# 这个 bug 和「脚本 shebang 写死 Termux 路径」是**两个独立问题**, 但症状叠在
# `git submodule` 这一个命令上 —— 修掉 shebang 不会让症状消失, 极易误判成没修好。
#
# 受影响: git submodule / mergetool / subtree / filter-branch / request-pull /
#         instaweb / quiltimport / merge-octopus ... 以及它们间接调用的 git-sh-setup。
# 不受影响: builtin 子命令 (add / commit / status ...), 那些编译在二进制里。
#
# 用环境变量覆盖 (git 官方支持的方式)。**不要改二进制**: 里面那条 Termux 路径
# 48 字节, 而模块路径 49 字节, 原地打补丁会溢出。
#
# 模板目录同理, 也是 Termux 路径; 不设的话 `git init` 装不出 hook 样本(实测装 0 个)。
export GIT_EXEC_PATH="$PREFIX/libexec/git-core"
export GIT_TEMPLATE_DIR="$PREFIX/share/git-core/templates"
export NO_COLOR=1

# ── 包管理器 (pnpm) ─────────────────────────────────────────
#
# DSH 的插件管理器把参数原样转发给 pnpm 执行。pnpm 在 Android 上有三个坑,
# **真正的修复不在这里**, 而在 `usr/bin/pnpm` 那层启动器
# (由 probe/tools/fetch-runtime.mjs 的 wrapPnpm() 在构建期生成)。这里只补一句
# PNPM_HOME, 并说清楚为什么其它变量都没用。
#
# 1. **store 操作锁目录取自 $HOME/.cache, 且要求它是「当前用户拥有的真实目录」。**
#    ⚠️ 这一条的**前提已经变了**: 工作区从 /sdcard/DroidHarness 挪到
#    /data/adb/dsh/workspace 之后, HOME 是 root 属主、且在 ext4 上, 所以 pnpm 的
#    锁目录检查自然通过。但这条曾经真实发生过, 而且**如果用户把工作区选回 /sdcard
#    就会再次踩到** —— 当时的报错是:
#        ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK
#          lock directory must be a real directory owned by the current user
#    手机端 agent 实测: npm_config_cache_dir / npm_config_store_dir /
#    npm_config_state_dir / XDG_CACHE_HOME / --cache-dir / --config.cacheDir /
#    --store-dir **全都挪不动它** —— pnpm 根本不读那几个变量。
#    **唯一有效的是给它一个单独的 HOME**, 所以 usr/bin/pnpm 仍然是个启动器:
#        export HOME="$DSH_HOME_DIR"; exec .../pnpm-bin "$@"
#    这样只改 pnpm 子进程的 HOME, DSH 自己的 HOME 不动 (GUI 的工作区选择器从它起步)。
#    留着它当作**兜底**: 不管工作区被选到哪, pnpm 的 store 都稳在 /data。
#
# 2. **store 必须和 profile 目录 (/data/adb/dsh/profiles/*) 在同一个真实文件系统上。**
#    它靠硬链接把 store 里的文件链进 node_modules, 跨文件系统会报
#    "Cross-device link not permitted"。而 /sdcard 是 FUSE, **不支持硬链接**。
#    启动器把 HOME 指到 /data/adb/dsh, store 落在 $PNPM_HOME/store, 这条就解决了。
#
# 3. **只对 JS 版 pnpm 成立**: 它的 bin/pnpm.mjs shebang 是 `#!/usr/bin/env node`,
#    而 Android 没有 /usr/bin/env, 必须包一层启动器显式用 node 拉起。
#    本模块的 pnpm 是 **NDK 编的 Android ELF**, 不读 shebang, **不受这条影响**。
#
# 注意: 下面那三个 npm_config_* 对 pnpm 是 **no-op** (实测 `pnpm config get
# store-dir` 返回 undefined)。留着是因为 **npm** 会读它们 (npm 的变量约定),
# 但不要以为它们在修 pnpm 的问题。
export PNPM_HOME="$DSH_HOME_DIR/pnpm-home"
export npm_config_store_dir="$DSH_HOME_DIR/.pnpm-store"
export npm_config_cache_dir="$DSH_HOME_DIR/.pnpm-cache"
export npm_config_state_dir="$DSH_HOME_DIR/.pnpm-state"
mkdir -p "$PNPM_HOME" "$npm_config_store_dir" "$npm_config_cache_dir" "$npm_config_state_dir" 2>/dev/null
