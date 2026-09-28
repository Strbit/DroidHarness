#!/system/bin/sh
# screen-mcp launcher -- starts the screen recognition MCP server over stdio.
#
# Deliberately POSIX sh only (no bashisms): this may be exec'd by any harness,
# and it must work whatever /system/bin/sh happens to be.
#
# 为什么需要这个启动脚本
# ----------------------
# 识别服务本体 (screen-mcp.mjs) 是 harness 中立的: 放在 /data/adb/dsh/tools/ 下,
# 不用任何模块路径。但它需要一个 **Android aarch64 的 node 运行时**,
# 而那个运行时由 dsh_android 模块提供。
#
# 所以: 服务中立, 启动器负责找到运行时。这一层是唯一绑定模块的部分。
#
# 运行时怎么找
# ------------
# 不写死模块 id: 模块目录名取决于安装时的 module.prop (可能是 dsh_android,
# dsh_android_update, 或 KernelSU 生成的任何变体)。按优先级探测, 每步验证可执行:
#
#   1. MSM_NODE 环境变量 (显式覆盖, 便于调试与换部署)
#   2. 遍历 /data/adb/modules/*/usr/bin/node, 取第一个可执行的
#   3. 固定路径兜底
#
# 前一版这里是死代码: 注释声称 "resolved at runtime, never hardcoded",
# 但 case 只匹配 /data/adb/modules/*/bin/*, 而真实落点是
# /data/adb/dsh/tools/screen-mcp —— 模式永不命中, 永远走硬编码 fallback。
# 结果虽然对(兜底恰好正确), 但注释承诺了一个不存在的机制。
set -u

SERVER_DIR=${0%/*}
SERVER="$SERVER_DIR/screen-mcp.mjs"

find_node() {
    if [ -n "${MSM_NODE:-}" ] && [ -x "$MSM_NODE" ]; then
        printf '%s' "$MSM_NODE"
        return 0
    fi

    for d in /data/adb/modules/*/usr/bin/node; do
        if [ -x "$d" ]; then
            printf '%s' "$d"
            return 0
        fi
    done

    for p in \
        /data/adb/modules/dsh_android/usr/bin/node \
        /data/adb/modules/dsh_android_update/usr/bin/node
    do
        if [ -x "$p" ]; then
            printf '%s' "$p"
            return 0
        fi
    done

    return 1
}

NODE=$(find_node)
if [ -z "${NODE:-}" ]; then
    {
        echo "screen-mcp: 找不到可执行的 node 运行时"
        echo "screen-mcp: 已尝试 MSM_NODE / /data/adb/modules/*/usr/bin/node / 固定路径"
        echo "screen-mcp: dsh_android 模块装了吗? 或用 MSM_NODE 显式指定"
    } >&2
    exit 127
fi

if [ ! -f "$SERVER" ]; then
    echo "screen-mcp: 服务文件不存在: $SERVER" >&2
    exit 127
fi

exec "$NODE" "$SERVER"
