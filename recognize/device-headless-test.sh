#!/system/bin/sh
# 在手机上跑一次 headless 任务, 验证 DSH 能否真的用屏幕识别工具
# 用 DSH 自己的公开入口 (dsh --profile headless "task"), 不逆向内部协议
set -u

DSH_HOME=/data/adb/dsh
APP=/data/adb/modules/dsh_android/app
NODE=/data/adb/modules/dsh_android/usr/bin/node
PREFIX=/data/adb/modules/dsh_android/usr
BIN="$APP/node_modules/@deepseek-ai/dsh/lib/bin.js"
PROFILE=screentest
PDIR="$DSH_HOME/profiles/$PROFILE"

# 与 service.sh 完全一致的环境: 缺一个 DSH 就定位不到 home(会把 home 解析成 /.dsh)
export DSH_HOME="$DSH_HOME"
export LD_LIBRARY_PATH="$PREFIX/lib"
export PATH="$PREFIX/bin:/system/bin:/system/xbin"
export HOME=/sdcard/DroidHarness
export TMPDIR="$DSH_HOME/tmp"
export SHELL="$PREFIX/bin/bash"
export OPENSSL_CONF="$DSH_HOME/tmp/openssl.cnf"
export SSL_CERT_DIR=/system/etc/security/cacerts
export NO_COLOR=1
mkdir -p "$DSH_HOME/tmp" 2>/dev/null
: >"$OPENSSL_CONF" 2>/dev/null

echo "=== 环境 ==="
echo "DSH_HOME=$DSH_HOME"
echo "node=$NODE"
echo "bin=$BIN"
echo "TMPDIR=$TMPDIR"
echo ""

echo "=== 步骤 1: 从 headless 模板创建 profile ==="
if [ -d "$PDIR" ]; then
    echo "profile 已存在, 复用"
else
    cd "$APP" || exit 1
    "$NODE" --expose-internals "$BIN" --from-default-profile headless --profile "$PROFILE" --dump-config > /data/local/tmp/st-dump.txt 2>&1
    echo "dump-config 退出码: $?"
    echo "--- dump 输出前 15 行 ---"
    head -15 /data/local/tmp/st-dump.txt
fi
echo ""

echo "=== 步骤 2: profile 目录内容 ==="
ls -la "$PDIR" 2>&1
echo ""

echo "=== 步骤 3: 写入屏幕识别 MCP 配置 ==="
mkdir -p "$PDIR/aac-src"
cat > "$PDIR/aac-src/patch.yml" <<'YAML'
- insert:
    - id: mcp-screen
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: screen
        transport: stdio
        command: /data/adb/dsh/tools/screen-mcp
YAML
echo "已写入 $PDIR/aac-src/patch.yml"
cat "$PDIR/aac-src/patch.yml"
echo ""

echo "=== 步骤 4: 跑一个 headless 任务 ==="
echo "任务: 告诉我屏幕上现在有什么"
cd "$APP" || exit 1
TASK="这是我的安卓手机。请用你的屏幕识别工具看我现在屏幕上显示的是什么，然后直接告诉我你看到了哪些文字和可点击的元素。不要执行任何修改操作。"
"$NODE" --expose-internals "$BIN" --profile "$PROFILE" --patch "$PDIR/aac-src/patch.yml" "$TASK" > /data/local/tmp/st-run.out 2> /data/local/tmp/st-run.err
echo "退出码: $?"
echo ""
echo "=== stdout (最终答案) ==="
cat /data/local/tmp/st-run.out
echo ""
echo "=== stderr (推理流 + 错误, 尾部 60 行) ==="
tail -60 /data/local/tmp/st-run.err
echo ""
echo "=== 是否调用了屏幕工具 (搜 stderr/out) ==="
grep -c "screen_" /data/local/tmp/st-run.err /data/local/tmp/st-run.out 2>/dev/null
grep -o "mcp__screen__[a-z_]*" /data/local/tmp/st-run.err /data/local/tmp/st-run.out 2>/dev/null | sort -u
