#!/system/bin/sh
# action.sh — KernelSU 模块页那个「执行」按钮的入口
#
# 这个按钮是这个模块里唯一能做到「一屏之内开/关 DSH」的东西:
#   - 它不需要 adb、不需要 Termux、不需要 PC;
#   - 它可以钉到桌面快捷方式 (Manager 里长按模块 → 执行 → 加到桌面),
#     于是桌面上就有一个物理意义上的开关;
#   - 实测耗时: stop 方向约 3 秒, start 方向约 10~15 秒 (等 node 起 + HTTP 能应答).
#     注意 start 的等待对象是 **HTTP 应答**, 不是"端口打开": 实测冷启动 +11s
#     端口已监听但路由还没注册完, 那一刻请求 `/` 拿到的是 404.
#     WebView 冷启动还要另加 1~2 秒, 所以「随手一按」这件事放按钮,
#     菜单放 WebUI, 各走各的强项.
#
# ── 调用方式 (决定了下面两条写法) ────────────────────────────
# ksud 的 run_action() 做的是:
#
#     exec_script("/data/adb/modules/<id>/action.sh", wait = true)
#       → busybox sh <脚本路径>, current_dir = 模块根, wait 直到退出
#
#   1) **它不 source bin/env.sh**, 也几乎不给 PATH 加模块目录: 我们继承到的是
#      系统环境 + /data/adb/ksu/bin. 这是好事 —— LD_LIBRARY_PATH 那个双向绑定
#      (node 要它、app_process/uiautomator 被它打死, 见 recognize/lib/spawn-env.mjs)
#      在这里根本不成立, 所以**绝对不要**在这里 source env.sh 把它请进来.
#      下面只把系统的 /system/bin /system/xbin 排在最前, 不插 /data/adb 的东西.
#   2) 它把 $0 设成脚本自身路径, 所以用 ${0%/*} 推模块根是可靠的, 不依赖 cwd
#      (cwd 恰好也是模块根, 但那是实现细节, 不该拿来做正确性依据).
#
# ── 关于 envs ────────────────────────────────────────────────
# get_common_script_envs() 会塞 KSU=true / KSU_MODULE=<id> / KSU_VER 等.
# 这里不读它们 —— 参数化的一律从 $0 推, 免得 Manager 版本换了行为就变.
#
# ── 清屏协议 ─────────────────────────────────────────────────
# Manager 把按钮的标准输出**逐块**流式显示在全屏文本页上 (root shell, 无超时).
# 它认这个转义序列: 某个块以 \033[H\033[J 开头时, 用该块去掉前缀后的内容
# **替换**整页, 而不是追加. 于是同一个按钮可以先流式显示"拉起中…",
# 结束时换成一张干净的状态卡, 而不是越来越长的日志堆.
# 下面 emit_clear() 单独一次 printf 发这个序列, 前后各留一次 write 边界,
# 降低它被和上一行合进同一个块的概率; 末尾那次 sleep 1 就是为这个边界.
# 老版本 Manager 不认它时, 页面只是变成"追加显示", 信息不丢 —— 降级可接受.
#
# ── 一条已知限制 (别把它当成恢复入口) ────────────────────────
# 模块处于 disabled / 有 update / 有 remove 待处理时, Manager 点按钮根本不会
# 执行这个脚本 (它弹个提示就走). 所以 DSH 起不来时, 按钮救不了你, 得先去
# 模块列表把状态恢复正常. 恢复入口该放在 WebUI 或 adb 里, 不放这儿.

MODDIR=$(cd "${0%/*}" && pwd)
DSHCTL="$MODDIR/bin/dshctl"
PORT=3080

# 只用 Android 自带的 toybox, 不碰模块里任何二进制.
PATH=/system/bin:/system/xbin${PATH:+:$PATH}
export PATH

emit_clear() {
	printf '\033[H\033[J'
}

if [ ! -f "$DSHCTL" ]; then
	# 模块内容被裁剪过 / 装坏了. 这种情况必须说清楚是哪条路径缺失,
	# 否则用户只会看到一个"什么都没发生"的按钮.
	echo "action.sh: 找不到 $DSHCTL"
	echo "action.sh: 模块文件不完整, 请在 KernelSU 里重装本模块"
	exit 1
fi

# 状态判据一律问 dshctl, 不在这里复制识别串:
# `dshctl running` 只用退出码表态, 于是 '@deepseek-ai/dsh/lib/bin.js'
# 这个串整个模块只有 bin/dshctl 一处. 之前我在按钮里抄了一份, 那正是
# 两套实现各自漂移的开始 (改 dshctl 的人不会想到来改这里).
if sh "$DSHCTL" running; then
	WAS_RUNNING=1
	echo "DSH 开关: 正在运行 → 本次执行 stop (约 3 秒)"
	echo ""
else
	WAS_RUNNING=0
	echo "DSH 开关: 未运行 → 本次执行 start (约 10~15 秒, 等到 HTTP 能应答为止)"
	echo ""
fi

# 过程不捕获, 直接流式给页面: 等待期间用户能看到"拉起中…"/"停止中…",
# 而不是对着一个空白页猜它死了没死.
# 退出码单独留一份 ($? 不消费 stdout, 流式不受影响), 末尾要用.
sh "$DSHCTL" toggle
TOGGLE_RC=$?

# 给上面那批 write 一个落盘的边界, 再清屏换状态卡 (见文件头「清屏协议」).
sleep 1
emit_clear

echo "──── DSH 开关 ────"
echo "本次操作: $([ "$WAS_RUNNING" = 1 ] && echo stop || echo start)"
echo ""
sh "$DSHCTL" status
echo ""
echo "──────────────────"
if [ "$WAS_RUNNING" = 1 ]; then
	# 关掉了就别再给链接: 那时候 3080 上没人听, 点了只得到一个"无法连接"。
	echo "已关闭。想再用: 再按一次这个按钮。"
else
	echo "手机上直接开:  http://127.0.0.1:$PORT"
	echo "  (要先取 token:  su -c 'dshctl url'  会打印一条带 token 的完整链接)"
	echo "  日志里的 token 已掩码, 只有 dshctl url / dshctl token 给出真值。"
	echo "从 PC 开:      adb forward tcp:$PORT tcp:$PORT"
	echo "               然后浏览器访问上面那条链接"
fi
echo ""
echo "开机仍会自动拉起 (service.sh). 想连开机一起停:"
echo "  在 KernelSU 模块列表里禁用本模块即可."

# 退出码会被 Manager 用来决定成功/失败提示 (钉到桌面时尤其明显),
# 所以切完必须实测一次目标状态, 不能假定 dshctl 一定成功.
# ⚠️ 判据同样只能问 dshctl running: 这里一旦写成 pgrep -f "$某变量",
#    而那个变量没定义, 就退化成 pgrep -f '' —— 空模式匹配所有进程,
#    stop 之后必然"仍然匹配", 于是按钮把每一次成功关闭都报成失败.
#
# TOGGLE_RC 必须一起判: "进程起来了但 HTTP 25 秒没就绪" 这一档里
# dshctl start 已按失败退出 (exit 1), 而 running 却是真 —— 只看状态复检
# 会把这次失败报成成功, 按钮弹个绿色提示, 用户点开页面吃 404.
if [ "$WAS_RUNNING" = 1 ]; then
	if sh "$DSHCTL" running; then
		echo ""
		echo "!! 执行后进程仍在, 切换失败 —— 上面 status 里有 pid"
		exit 1
	fi
elif ! sh "$DSHCTL" running; then
	echo ""
	echo "!! 执行后仍没起来, 切换失败 —— 试试 dshctl log 40"
	exit 1
fi

if [ "$TOGGLE_RC" -ne 0 ]; then
	echo ""
	echo "!! dshctl 以 exit=$TOGGLE_RC 结束: 状态可能不完整, 以 status 那行为准"
	exit "$TOGGLE_RC"
fi

exit 0
