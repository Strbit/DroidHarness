# android-probe — 用 `app_process` 调 Android API 的小探针

**替代方案**：把"从文本转储里挖事实"换成"调 AOSP API 拿类型化对象"。

当前只有一个探针：**屏枚举**（`Displays`）。这是识别模块唯一真正脆的地方 ——
`screencap` / `uiautomator` 是平台二进制、CLI 稳定，像素路线本身通用。

---

## 为什么值得换

### 文本那条路无法靠"多收集几台设备"收敛

实测到的形态方差（同一台设备）：

```
同一个 uniqueId 字段，三处三种拼法:
  cmd display:        uniqueId "local:4630946964337362323"   无等号
  DisplayDeviceInfo:  uniqueId="local:4630946964337362323"   双引号
  mViewports:         uniqueId='local:4630946964337362323'   单引号

同一个 mState= 锚点在同一份输出里出现两次:
  一次是屏状态、一次是 AUTO_BRIGHTNESS_DISABLED
裸 state= 有 101 处历史噪声（BrightnessEvent）
```

这些已经咬过两次（`mState` 锚点、`DisplayDeviceInfo` 段边界）。整栋楼压在一个"切段 + 锚定"的启发式上。

### API 路线的通用性是**免费**的

`uiautomator` 自己就是活证据（见 `/system/bin/uiautomator`）：

```sh
CLASSPATH=/system/framework/uiautomator.jar
exec app_process /system/bin com.android.commands.uiautomator.Launcher
```

它**不带 App、不用 root、跨所有机型可用**，因为它走 `UiAutomation` API 而不是解析文本。
本探针用的是**完全相同的机制**，只是换成调 `DisplayManager`。

### 它还能解决一个正则**永远**解决不了的问题（未做，见下）

```
uiautomator dump --display 2   →  被 Android 静默忽略，永远返回主屏的树
```

实测确认（传不存在的 id 999 都成功）。所以**副屏只有图、没有树**。
而 API 路线能解：`AccessibilityService.getWindowsOnAllDisplays()`（API 30+）。

---

## 实测输出（OnePlus PLK110 / Android 16 / KernelSU）

```
$ adb shell su -c 'CLASSPATH=/data/adb/dsh/tools/probe/classes.dex app_process /system/bin Displays'
OK|list-displays
SOURCE|DisplayManagerGlobal
COUNT|1
DISPLAY|0|name=内置屏幕|uniqueId=local:4630946903293830803|type=1|state=4|
        rotation=0|modeId=3|renderFrameRate=90.0|logicalWidth=1272|logicalHeight=2772|
        appWidth=1272|appHeight=2772|logicalDensityDpi=476|flags=16515|
        displayGroupId=0|displayId=0
END
```

`state=4` 是 `Display.STATE_DOZE_SUSPEND`，`type=1` 是 `Display.TYPE_INTERNAL` ——
**都是类型化常量的直出，没有正则**。

---

## 用法

### 构建

```sh
node android-probe/tools/build-probe.mjs
node android-probe/tools/build-probe.mjs --sdk <dir> --out <dir> --min-api 30
```

需要 JDK（`JAVA_HOME` 或 PATH 里的 `javac`）与 Android SDK
（`ANDROID_SDK_ROOT` / `ANDROID_HOME` / `--sdk`，需含 `platforms/android-*/android.jar`
与 `build-tools/*/d8`）。脚本自己找、自己校验，找不到会明确说是缺什么。

**构建脚本里带一次写盘探测**：javac 写不出去时报的是
`error while writing X.class` —— 看起来像编译错误，实际是环境权限问题。
脚本先探一次，失败时直接说"目录不可写 + 用 `--out` 换位置"。

### 部署与运行

```sh
adb push android-probe/dist/classes.dex /data/local/tmp/probe.dex
adb shell su -c 'mkdir -p /data/adb/dsh/tools/probe && \
  cp /data/local/tmp/probe.dex /data/adb/dsh/tools/probe/classes.dex && \
  chmod 644 /data/adb/dsh/tools/probe/classes.dex'
adb shell su -c 'CLASSPATH=/data/adb/dsh/tools/probe/classes.dex app_process /system/bin Displays'
```

### 解析输出

`lib/displays-probe.mjs` 把 stdout 归一成与文本路径**字段一致**的记录：

```js
import { preferApiOverText } from './lib/displays-probe.mjs';

const r = preferApiOverText(probeStdout, () => textPathResult());
// r.source = 'api-probe' | 'cmd-display' | 'dumpsys'
// r.displays[0].state           -> 'ON'（数字 2 已映射成与 dumpsys 一致的字符串）
// r.displays[0].surfaceFlingerId -> '4630946903293830803'
```

**字段必须对齐**（`state` / `surfaceFlingerId` / `width` / `height` / `density`），
否则调用方就得为"这次走的是 API 还是文本"分叉。`DISPLAY_STATE` / `DISPLAY_TYPE`
两张映射表就是干这个的，有测试守着。

---

## 输出协议

```
OK|<tool>                                   成功
SOURCE|<DisplayManagerGlobal|DisplayManager>  走的是哪条 API
COUNT|<n>                                   屏数
DISPLAY|<id>|<k>=<v>|<k>=<v>|...            一块屏（值里的 | 已转成 /）
END
ERROR|<code>|<可读说明>                      失败
```

退出码：`0` 成功 / `2` 拿不到 DisplayManager / `3` 枚举失败。

**解析器不把 ERROR 当成"设备没有屏"** —— 那是显式失败，必须带出来。
`COUNT` 与实际条数不符也判失败（可能被截断）。这两条都有测试。

---

## 三条实测得到的硬约束（改之前先看）

1. **必须先 `Looper.prepare()`，再 `ActivityThread.systemMain()`。**
   顺序反了会 `Can't create handler inside thread that has not called Looper.prepare()`
   —— `Handler` 在 `ActivityThread` 的构造函数里就创建了。

2. **`getType()` / `getUniqueId()` 是 @hide**，编译期的 `android.jar` 里没有。
   但它们**运行时就在那儿**，所以反射是这里的正确做法，不是 workaround。

3. **构建期：cwd 别跨盘。** 受控矩阵实测（项目在 D 盘、JDK/SDK 在 C 盘）：

   | 形态 | 结果 |
   |---|---|
   | 绝对 `-d`，cwd 与输出同盘 | OK |
   | 相对 `-d`，cwd = 输出目录 | OK |
   | 绝对 `-d`，cwd = 项目盘 | **OK ← 用这个** |
   | 相对 `-d`，输出目录在项目盘 | FAIL（写不出 .class） |
   | 输出到 `%TEMP%` | FAIL（写不出 .class） |
   | cwd 跨盘 + 绝对 exe 路径 | FAIL `ENOENT`（Windows 跨盘找不到 exe） |

   所以脚本的形态是：**cwd 保持默认，输出目录用绝对路径，并且先探测可写性。**

---

## 边界：这一版**做了什么**、**没做什么**

### 做了（有真机证据）

- 屏枚举走 `DisplayManagerGlobal.getDisplayIds()` + `getDisplayInfo(id)`
- 输出协议 + 解析器 + 17 项断言（含真机夹具回归）
- 构建脚本（自己找 JDK/SDK、写盘探测、给出部署命令）
- 与文本路径的**字段对齐**（`state` 数字 -> 字符串等），以及降级顺序

### 没做（明确列出来，别当成已实现）

| 项 | 状态 |
|---|---|
| **副屏的无障碍树** | ❌ 未做。这是这条路最值钱的地方（`uiautomator --display` 被静默忽略），需要反射构造 `UiAutomation` |
| **虚拟屏枚举验证** | ❌ 未验证。设备上没有副屏可测；`getDisplayIds()` 是否包含虚拟屏**没有实测** |
| **接入 recognize** | ❌ 未接。探针独立可用（手动跑），但 recognize 侧还没调它 —— 那需要 recognize 的代码在这条分支上 |
| **构建链进 CI** | ❌ 未做。构建脚本要求 JDK + Android SDK |
| **dex 的存放** | ❌ 未定。当前构建产物在 `dist/`（gitignore），要么进仓库、要么构建期生成 |
| **@hide API 的版本兼容** | ❌ 未验证。大版本升级可能变（但 `uiautomator` 也这么活了很多年） |

### 为什么先只做屏枚举

因为**这是唯一真正脆的部分**。其余（截屏、无障碍树读取）走平台二进制，CLI 稳定。
把最脆的一块换成 API，收益最大、风险最小。

---

## 夹具规矩

`fixtures/` 里的文件**必须注明来源**（见 `fixtures/README.txt`）：实拍就是实拍，
手写就标手写。之前吃过三次"夹具偷偷偏离真机"的亏（字段顺序、段头分隔线、
多写的 state 字段），所以这条是硬规矩。

当前：
- `oneplus-probe-list-displays.txt` —— **真机实拍**，逐字保存
- `oneplus-probe-error-no-dm.txt` —— **按协议构造**（想抓真实的那种失败时，
  `app_process` 直接进程级 `Aborted` 了，根本没进到 main）

---

## 测试

```sh
cd android-probe && node test-probe.mjs     # 17 项，不需要设备
```
