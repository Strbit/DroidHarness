#!/system/bin/sh
# screen-mcp launcher -- starts the screen recognition MCP server over stdio.
#
# Deliberately POSIX sh only (no bashisms): this may be exec'd by any harness,
# and it must work whatever /system/bin/sh happens to be.
#
# The module directory is resolved at runtime, never hardcoded, so this keeps
# working if the module is installed under a different id or path. A literal
# /data/adb/modules/dsh_android is only the last-resort guess.
set -u

MODDIR=/data/adb/modules/dsh_android
if [ -n "${0:-}" ]; then
    case "$0" in
        /data/adb/modules/*/bin/*)
            MODDIR=$(cd "$(dirname "$0")/.." && pwd)
            ;;
    esac
fi

NODE="$MODDIR/usr/bin/node"
SERVER="/data/adb/dsh/tools/screen-mcp.mjs"

if [ ! -x "$NODE" ]; then
    echo "screen-mcp: node runtime not found at $NODE" >&2
    echo "screen-mcp: is the dsh_android module mounted?" >&2
    exit 127
fi

if [ ! -f "$SERVER" ]; then
    echo "screen-mcp: server file not found at $SERVER" >&2
    exit 127
fi

exec "$NODE" "$SERVER"
