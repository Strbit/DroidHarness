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

# 路径与所有 export 都在 bin/env.sh 里 —— 和 bin/dsh (命令行入口) 共用同一份。
# 见下方 "环境" 一节。

# ── 等系统真正起来 ──────────────────────────────────────────
i=0
while [ "$(getprop sys.boot_completed)" != "1" ] && [ $i -lt 180 ]; do
	sleep 1
	i=$((i + 1))
done
sleep 5

# ── 环境 ────────────────────────────────────────────────────
# 所有 export 都在 bin/env.sh 里, 和 bin/dsh (命令行入口) **共用同一份**。
#
# 为什么必须共用: 如果两处环境不同, 会出现「服务里 git/pnpm 能用, dsh 命令里
# 却不行」这种分裂 —— 两个进程跑的看起来是同一份代码, 极难定位。
#
# 那些坑连同原因都记在 bin/env.sh:
#   · 工作区为什么必须在 /data 而不能是 /sdcard (FUSE 不实现 link(2))
#   · git 的 exec-path 被编译进了 Termux 路径 (脚本型子命令全找不到)
#   · pnpm 为什么要单独一个 HOME (store 锁目录 + 硬链接不能跨文件系统)
#   · TMPDIR 为什么不用 /data/local/tmp
. "$MODDIR/bin/env.sh"

# ── 权限: 收紧整棵树 (开机一次) ─────────────────────────────
#
# env.sh 的 umask 只保证**以后新建**的东西是 root-only; 旧版本在 umask 0000 下
# 留下的那批 0777/0666 得显式清一遍 —— 否则「含启动 token 的文件任何 app 可读」
# 这件事会一直挂着, 而且新装的模块**看不见**(顶层我 chmod 过了)。
#
# 为什么放 service.sh 而不是 env.sh: 整树递归不该每次 `dsh` 命令行调用都跑,
# 而 service.sh 只在开机 / `dshctl start` 时执行。
#
# 为什么是一条 chmod -R 而不是 find -exec chmod: 后者**每个文件起一个进程**,
# 这棵树 4031 个条目就是 4031 次 fork; chmod -R 在单个进程里走目录树。
# 实测整树 **69ms**, 放在开机路径上没有代价。
#
# 用符号模式而不是 0700/0600: 大写 `X` 只对**目录或本来就有执行位的文件**加 x,
# 所以 profiles/*/node_modules/.bin 里那些真需要执行位的脚本不会被抹掉,
# 普通数据文件也不会被误加执行位。
#
# 两个安全前提都是在这台设备上实测过的, 不是假设:
#   · toybox `chmod -R` **不跟符号链接** —— 造一个 -> /etc/hosts 的链接放进去,
#     跑完 /etc/hosts 权限没变。不会顺着链接跑出去改系统文件。
#   · 收紧后 pnpm 照常工作 —— store 文件变 600 但 `dsh plugin --profile web list`
#     仍然 exit=0; store 与 node_modules 之间是硬链接(同 inode, links=3),
#     改权限不影响链接关系。
chmod -R u+rwX,go-rwx "$DSH_HOME_DIR" 2>/dev/null ||
	echo "[$(date)] chmod -R $DSH_HOME_DIR 非 0, 权限可能没全部收紧" >>"$LOG"

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
# 判据问 dshctl, 不在这里再抄一份识别串:
#   · MATCH 只存在 bin/dshctl 一处, 不会出现两边漂移;
#   · dshctl running 用的是括号类 '[@]deepseek-...', 不会把承载本次调用的
#     shell 自己算成一个 DSH 进程 (B8). 这里以前是裸 '@deepseek-...',
#     在 `su -c 'pgrep -af ...'` 这类调用下会自我匹配.
if sh "$MODDIR/bin/dshctl" running; then
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
# 判据同样问 dshctl, 不在这里再抄一份串 (识别串全模块只存在于 bin/dshctl).
# 这条日志只声明"端口在监听" —— 措辞和判据必须对齐: 实测冷启动 +11s 端口已开
# 但路由还没注册完, 那一刻 HTTP 返回 404. "能不能应答"由 dshctl status 用
# curl 单独报, 不在这里冒充.
_i=0
while [ $_i -lt 15 ] && ! netstat -tln 2>/dev/null | grep -q ":$PORT "; do
	sleep 1
	_i=$((_i + 1))
done
if netstat -tln 2>/dev/null | grep -q ":$PORT "; then
	echo "[$(date)] 端口已监听 $HOST:$PORT (等端口 ${_i}s); HTTP 就绪时刻见 dshctl status" >>"$LOG"
elif sh "$MODDIR/bin/dshctl" running; then
	echo "[$(date)] 进程在, 但端口 $PORT 15 秒内没打开, 看上面日志" >>"$LOG"
else
	echo "[$(date)] 拉起后没看到进程, 看上面日志" >>"$LOG"
fi
