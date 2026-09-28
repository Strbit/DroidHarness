#!/system/bin/sh
# 安装 screen-tools 适配器到 DSH 应用树, 并更新 profile 的 patch 配置
set -e

APP=/data/adb/modules/dsh_android/app
DEST="$APP/node_modules/@deepseek-ai/dsh-screen-tools"
PROFILE=/data/adb/dsh/profiles/web

echo "--- 检查应用树可写性 ---"
if [ ! -d "$APP/node_modules/@deepseek-ai" ]; then
    echo "错误: 找不到 $APP/node_modules/@deepseek-ai" >&2
    exit 1
fi

echo "--- 创建目标目录 ---"
mkdir -p "$DEST/lib"

echo "--- 安装插件文件 ---"
cp -f /data/local/tmp/screen-tools.mjs "$DEST/lib/screen-tools.mjs"
cp -f /data/local/tmp/screen-tools-package.json "$DEST/package.json"
chmod 644 "$DEST/lib/screen-tools.mjs" "$DEST/package.json"

echo "--- 更新 profile patch 配置 ---"
cp -f /data/local/tmp/cordis.patch.yml "$PROFILE/cordis.patch.yml"

echo "--- 结果 ---"
find "$DEST" -type f
echo "profile:"
tail -5 "$PROFILE/cordis.patch.yml"

echo "INSTALLED"
