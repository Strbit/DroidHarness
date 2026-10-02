# recognize — 手机内容识别

把**无障碍树**与**屏幕图片识别**两条路线合起来，回答一个问题：**这块屏幕上有什么、在哪、能不能点**。

面向已 root 的 arm64 安卓设备。识别结果供 agent 使用，也可人读。

---

## 为什么是两条路线

两条路各自都有明确的失效场景，而它们的失效场景**不重叠**——这是把它们组合起来的全部理由。

| 路线 | 平台 API | 拿到什么 | 什么时候失效 |
|---|---|---|---|
| **无障碍树** | `uiautomator dump` | 精确文字、`resource-id`、`class`、坐标、可点祖先、滚动/勾选状态 | 引擎自绘界面（Unity/游戏）只有"没用的树"；加固应用可能压制节点 |
| **屏幕图片** | `screencap` + OCR | 真实像素上的一切文字 | 拿不到语义（哪个能点）；图标上的小字易误读 |

合并后每条目标都标注 **`source`**（`tree` / `image` / `both`）和 **`confidence`**：

- 树里带文字标签的节点 → `tree`，0.95
- 图像识别独有的文字 → `image`，0.7
- **两边在同一位置都命中 → `both`，可信度提升** ← 这是组合的实际收益

实测例：`WakeUp课程表` 被标为 `both` 0.99，因为两条路都独立认出了它。

---

## 快速开始

```powershell
cd recognize

# 不连设备也能跑的测试（共 103 项）
node recognize.mjs selftest        # 解析器 + 合并逻辑（11 项）
node test-fields.mjs               # 截断 / 有界化 / 缓存新鲜度契约（22 项）
node test-spawn-env.mjs            # 子进程环境分类（15 项）
node test-screen-image-cache.mjs   # screen_image 缓存链路（6 项）
node test-displays.mjs             # 跨设备屏解析 + 真机 dump 回归（34 项）
node test-uiaction.mjs             # 动作层纯逻辑：服务挂载状态机 + argv 构造（14 项）
node bench-frame-path.mjs          # 帧路径编码代价量化

# 需要设备
node recognize.mjs displays        # 列出所有屏及状态
node recognize.mjs observe         # 一次完整识别（两条路都跑并合并）
node recognize.mjs tree            # 只看无障碍树
node recognize.mjs ocr             # 只看图像识别
node recognize.mjs targets --limit 30   # 只输出可操作目标清单

# 需要设备的测试（无设备时**明确失败**，不会静默通过）
$env:ADB = "D:\platform-tools\adb.exe"
node test-serve.mjs                # PC 侧 CLI 的逐行 JSON 协议（5 项断言）
node test-screen-mcp.mjs --exec $env:ADB shell `
  "export LD_LIBRARY_PATH=/data/adb/modules/dsh_android/usr/lib; exec /data/adb/modules/dsh_android/usr/bin/node /data/adb/dsh/tools/screen-mcp.mjs"
```

> `test-displays.mjs` 会读 `fixtures/` 里的**真机 dump**。缺文件时**判 fail**（不是跳过）——
> 因为那条测试的作用就是"夹具偏离现实时被发现"，跳过就等于没守。
> 夹具入库时 `.gitattributes` 会把 CRLF 转成 LF，这一点已实测两种行尾解析结果一致。

### 参数

| 参数 | 说明 |
|---|---|
| `--display <id>` | 目标屏，默认 `0` |
| `--adb <path>` | adb 路径；默认自动查找（PATH → 常见位置），也可用环境变量 `ADB` |
| `--serial <s>` | 多设备时指定 |
| `--root` | 用 `su` 执行设备侧命令 |
| `--json` | 输出 JSON |
| `--json-file <path>` | 把完整 JSON 写入文件 |
| `--limit <n>` | 控制台最多显示多少条目标 |
| `--section <tree\|both\|image>` | 只看某一来源的目标 |
| `--out <dir>` | 截图保存目录 |

> **Windows 控制台中文乱码**：默认代码页是 GBK，Node 输出的 UTF-8 会被破坏。
> 先执行 `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8`，
> 或直接用 `--json-file` 落盘（文件一定是干净的 UTF-8）。

---

## 输出结构

`observe` 返回（`--json`）：

```jsonc
{
  "schema": "recognize/observe@1",
  "at": "2026-09-26T10:33:43.759Z",
  "displayState": "ON",          // 结果可不可信的前提
  "wakefulness": "Awake",
  "display": { "width": 1272, "height": 2772, "density": 560, ... },
  "warnings": [],                // 熄屏等静默失败会在这里说明
  "errors": [],
  "tree": { "ok": true, "nodeCount": 68, "usefulness": { "useful": true, ... } },
  "ocr":  { "ok": true, "engine": "zh-Hans-CN", "lines": [...] },
  "targets": [
    {
      "source": "both",          // tree | image | both
      "label": "WakeUp课程表",
      "bounds": { "cx": 491, "cy": 1671, ... },
      "center": { "x": 491, "y": 1671 },
      "clickable": true,
      "viaAncestor": null,       // 走可点祖先时这里说明是哪个节点
      "confidence": 0.99
    }
  ],
  "freshness": {
    "screenOn": true,
    "treeCapturedAt": 1758882823759,
    "imageCapturedAt": 1758882823900
  }
}
```

---

## 四个硬性设计约束

这四条都对应一个**已确认的静默失败**（记录于 `docs/android-agent-harness-plan.md` §5.2），不是防御性编程。

### 1. 观察结果必须带屏状态与帧时间戳

**熄屏是静默失败**：熄屏时 `screencap` 交的还是**最后一帧**（读到的是一个已经不在的界面），而注入的触摸**唤不醒屏**（点进空气里），**两个都不报错**。

实测复现：熄屏时截屏得到纯黑图（20 KB），开屏后同一命令得到真实画面（1.38 MB）——**两次命令都成功返回**。

所以：`displayState` 与 `freshness` 是结果的一部分，调用方据此判断能不能信。

### 2. 判据是"有无值得动手的节点"，不是"树是否为空"

引擎自绘的界面不是空树，而是**"没用的树"**（可能只有一个全屏 `SurfaceView`）。`isUsefulTree()` 检查的是可操作/带标签节点的数量。

### 3. 探测失败就报错，不用默认值兜底

设计纪律 `docs/mobile-control-layer-design.md` §7：写死的分辨率/DPI 会**静默错坐标**，比直接报错危险得多。所以屏尺寸、DPI、路径全部运行时推导。

### 4. 缓存帧必须标注新鲜度（`lib/fields.mjs` 的 `FrameCache`）

`screencap -p` 的 PNG 编码在设备上是主要开销（本机量化见下），所以缓存**值得做**。但缓存帧**伪装成新帧**比读到旧帧本身更危险 —— 调用方会拿一个过期的坐标去点击。

所以 `FrameCache` 的契约是硬的：

| 保证 | 做法 |
|---|---|
| 默认不复用 | `maxAgeMs = 0` 时每次都真采集（最保守的默认） |
| 复用必须如实上报 | 返回 `fromCache: true` 与 `cacheAgeMs` |
| **时间戳不撒谎** | 复用时 `frameTimestamp` 是该帧**真实**的采集时刻，不是 `Date.now()` |
| 不同屏绝不混用 | 缓存键含 `displayId` + `surfaceFlingerId`；主屏/副屏坐标系不同，混用会静默错坐标 |
| 过期即重采 | 超过 `maxAgeMs` 自动重新采集 |
| 可先问再用 | `peek()` 让调用方先拿到年龄再决定 |

`screen_image` 工具对模型暴露 `maxFrameAgeMs`（默认 0），并在帧超过 1 秒未更新时给出明确警告。元数据也走 MCP 的 `structuredContent.frame`，调用方不必解析文本。

#### PNG 编码代价（本机量化，仅量级）

用 1272×2772（13.5 MiB 原始像素）的模拟界面测 zlib deflate —— PNG 的核心开销：

```
level 1:    21 ms   0.7 MiB (5%)
level 6:    87 ms   0.3 MiB (2%)
level 9:   546 ms   0.2 MiB (2%)
```

**26 倍的时间换 3 倍的体积**。这解释了为什么缓存有意义。

> ⚠️ 这是**本机 CPU** 的数字，不是手机的。Android 的 `screencap` 用 skia 而非 zlib，绝对值可能差很多。
> 换传输格式（如 JPEG）需要先知道设备上 `screencap -p` 的真实耗时与 `screencap` 无参数输出的原始格式 ——
> **这些数字没有设备取不到**，所以没有据此做优化（不拿假设做优化）。

---

## 长字段必须 head + tail 截断

无障碍节点的 `text` / `content-desc` **没有长度上限** —— 一个聊天界面的 `content-desc` 可能上万字符。

只保头会**静默切掉关键信息**：URL 的查询参数（`?orderId=...`）、订单号、文件扩展名都在尾部。

所以 `truncateField()` 保头 + 保尾，并**报出省略量**（`…[省略 N 字符]…`），让调用方知道损失了多少，而不是以为看到了全部。

适用范围：无障碍节点摘要（300 + 160）、合并后的目标 `label`/`text`/`desc`、`uiautomator` 的原始报错、OCR 的 `stderr`。数组同理（`boundArray` 保头 + 保尾，报出 `omitted`）。

---

## 可点祖先：为什么必须有

无障碍树里真正的点击目标**常常是父节点**：一个 `TextView` 自己 `clickable=false`，但它的父 `FrameLayout` `clickable=true`。只收集 `clickable=true` 的节点会漏掉大量可点目标。

实测例（桌面文件夹）：

```
FrameLayout  clickable=true   标签="文件夹：钦天监"   <- 真正该点的
  ImageView  clickable=false
  TextView   clickable=false  标签="钦天监"           <- 有文字但点不动
```

`toTargets()` 会为每个节点解析出最近的可点祖先，并在结果的 `viaAncestor` 里说明。两条都保留，因为坐标不同时它们是**不同的可点目标**。

---

## 设备侧文件策略

`uiautomator dump` **必须写一个设备文件**才能产出 XML —— 实测 `/dev/tty`、`/proc/self/fd/1`、`-`、`/dev/stdout` 四种 stdout 方式**全部拿不到内容**。

本模块的做法：写 `/data/local/tmp` → `cat` 读回 PC → **立即 `rm` 删除**。

- 只碰 `/data/local/tmp`，**不碰用户存储 `/sdcard`**
- 文件名带 pid 与随机串，避免并发冲突
- `finally` 块保证异常路径也会清理
- `Device.removeDeviceFile()` 硬性拒绝删除 `/data/local/tmp` 之外的任何路径

---

## OCR 后端

用 **Windows 内置 OCR**（`Windows.Media.Ocr`）：无需联网、无需安装、已带简体中文语言包。

`lib/ocr-windows.ps1` **刻意写成纯 ASCII**。原因：`.gitattributes` 的 `* text=auto eol=lf` 会在 checkout 时剥离 UTF-8 BOM，而 Windows PowerShell 5.1 会把无 BOM 的 UTF-8 当 ANSI 读，中文字符串字面量被拆坏后产生莫名其妙的 `Unexpected token` 解析错误。保持 ASCII 就完全绕开了 BOM 这个问题。中文文档放在这里。

换用其他后端（tesseract / 云端 OCR）只需替换 `lib/observe.mjs` 的 `ocrImage()`。

---

## 目录结构

```
recognize/
├── recognize.mjs                 CLI 入口（PC 侧驱动）
├── screen-mcp.mjs                设备侧 MCP 服务（手机本地跑）
├── lib/
│   ├── device.mjs                设备访问层（adb 定位、root 探测、临时文件生命周期）
│   ├── uitree.mjs                uiautomator XML 解析 + 可点祖先 + 有用性判定
│   ├── observe.mjs               识别引擎（屏状态/截屏/树/OCR/合并）
│   ├── fields.mjs                字段有界化（head+tail 截断）+ 帧缓存（新鲜度契约）
│   ├── spawn-env.mjs             子进程环境分类（系统二进制剔除 LD_LIBRARY_PATH）
│   ├── cmd-display.mjs           屏解析主路径（cmd display get-displays）+ 统一入口
│   ├── displays.mjs              屏解析兜底路径（dumpsys display）
│   └── ocr-windows.ps1           Windows OCR 后端（纯 ASCII）
├── fixtures/                     真机原始 dump（测试用，缺文件即 fail）
│   ├── oneplus-cmd-display-get-displays.txt   主路径样本
│   ├── oneplus-dumpsys-display.txt            兜底路径样本（985 行）
│   ├── oneplus-sf-display-id.txt
│   └── oneplus-dumpsys-power.txt
├── launcher.sh                   设备侧启动脚本（POSIX sh，探测模块提供的 node 运行时）
├── cordis.patch.yml              接入 DSH 的 patch 配置（必须用 - insert: 包裹）
├── test-displays.mjs             单元测试：跨设备屏解析（34 项，含真机 dump 回归）
├── test-fixtures-displays.mjs    手写夹具（注明每个样本的来源；真机 dump 在 fixtures/）
├── test-fields.mjs               单元测试：截断 / 有界化 / 缓存契约（22 项）
├── test-spawn-env.mjs            单元测试：子进程环境分类（15 项，拦住 LD_LIBRARY_PATH 污染）
├── test-screen-image-cache.mjs   单元测试：screen_image 缓存链路（6 项）
├── test-uiaction.mjs             单元测试：动作层纯逻辑（14 项：服务挂载状态机 + argv 构造）
├── test-serve.mjs                PC 侧 CLI 的逐行 JSON 协议（**需要设备**，5 项断言）
├── test-screen-mcp.mjs           端到端：MCP 协议（**需要设备**，7 项断言）
├── uiaction/
│   └── DshActionMain.java        动作注入的 Java 源码（dex 真源；build-uiaction.mjs 编译）
├── device-selftest.mjs           设备侧自检（走 spawn-env，含归因）
├── bench-frame-path.mjs          帧路径性能量化
└── README.md
```

---

## 动作层：从「看见」到「点下去」（screen_tap / screen_swipe / screen_key / screen_text）

`screen-mcp` 不再只做观察。动作层四件套（以 `mcp__screen__screen_*` 暴露）：

| 工具 | 通道 | 说明 |
|---|---|---|
| `screen_tap` / `screen_swipe` / `screen_key` | `/system/bin/input` | 物理触摸/按键注入。`displayId` 非 0 走 `input -d <id>`（虚拟副屏实测可用） |
| `screen_text` | 无障碍 `ACTION_SET_TEXT`（dex） | **任意 Unicode 含中文/emoji**。静默写入不弹键盘、不经剪贴板，写后读回校验（`before_text`/`verified_text`） |

### 为什么文字注入必须是 Java dex

文字注入唯一的确定性通道是无障碍 `ACTION_SET_TEXT`：`CharSequence` 原生携带
UTF-8，Node 没有、`input text` 只收 ASCII（HyperOS 实测 CJK 触发
`InputShellCommand.sendText` NPE）、uiautomator shell 命令没有该动作。
承体是 `uiaction/DshActionMain.java` 编出的 dex（约 11 KiB），由
`dsh/tools/build-uiaction.mjs` 用 Android SDK（javac + d8）编译，随模块
tools/ 布署到 `/data/adb/dsh/tools/dsh-action.dex`。一次动作一个进程
（app_process + exit），不与 `uiautomator dump` 抢 UiAutomation 单会话。

### 微信的关键事实：树只认真实无障碍服务

真机实测（小米 25102RKBEC / Android 16 / HyperOS）：微信只在**有真实
AccessibilityService 绑定时**才交出无障碍树 —— `UiAutomation` 不算
（`registerUiTestAutomationService` 不进 `mEnabledServices`）。所以
`screen_text` 动作前会自动把系统预装的 SelectToSpeak（免安装任何 APK）
追加进 `enabled_accessibility_services`，动作后按原值还原：

- 写前读原值，只追加自己；原值已含该服务则**完全不动**（别人的配置）
- marker 文件（`/data/local/tmp/dsh-a11y-attached.json`）记录"挂之前是什么"，
  kill -9 留下的脏状态由下次动作前的 reconcile 按记录还原
- 挂载期间部分 App 可能出现"无障碍"提示横幅，属预期

副作用红利：挂载期间同屏的 `screen_tree` / `screen_targets` 也能读到微信的树
（实测 app_nodes 0 → 19）。

### 无 fallback 纪律

`screen_text` 是单通道：一次 `ACTION_SET_TEXT`、一次读回、一个结论。
写失败带证据报错（`no_focused_input` 带 `focus_hint`、`inject_rejected`、
`verify_mismatch` 带 before/after），**绝不**退化为"点中心再粘贴"——
任何 fallback 都会把"定位错了"放大成"乱点 + 剪贴板被清"。

---

## 虚拟副屏：让自动化不打扰用户（screen_vd_start / screen_vd_stop / screen_vd_handoff / screen_vd_shot / screen_app）

目标不是"主屏 vs 副屏"，而是**前台 vs 后台**：用户在主屏看小说/打游戏，
agent 在副屏干活（发消息、点外卖），**用户的前台一下都不该变**。

### 机制（真机实测，这是全部的关键）

副屏用旗标 `1545 | 16384 | 65536` 创建，其中两个是核心：

```
16384  VIRTUAL_DISPLAY_FLAG_OWN_FOCUS                 副屏有自己的焦点
65536  VIRTUAL_DISPLAY_FLAG_STEAL_TOP_FOCUS_DISABLED  不抢物理屏的顶层焦点
```

于是两块屏**各有各的 `mCurrentFocus`**。实测：主屏在看 piliplus、副屏跑着设置时

```
mCurrentFocus=... com.android.settings/MiuiSettings     ← 副屏的焦点
mCurrentFocus=... com.example.piliplus/.MainActivity     ← 主屏的焦点，没动
```

物理屏的前台从头到尾没被碰过。**这是副屏存在的全部意义**，不是"换个地方看画面"。

### App 怎么上副屏：`screen_app`

`am start -f 0x18000000 --display N`（`NEW_TASK | MULTIPLE_TASK`）。
即使该 App 已在主屏运行（微信这类 singleTask），也会在副屏**新建一个独立 task**，
主屏那份原样不动 —— 副屏上是同一账号/同一进程的另一个任务窗口，**不是分身用户**。

**两条实测踩过的反例，别用：**

| 写法 | 后果 |
|---|---|
| `am start --display N`（不带 MULTIPLE_TASK） | singleTask 应用会把 intent 交给主屏既有实例，**把用户正在看的 App 拉到前台**，而且没上副屏 |
| `cmd activity display move-stack` | "迁移"语义，立刻抢走前台；副屏销毁时 task reparent 回来会**再抢一次** |

`screen_app` 省略 `activity` 时会先 `cmd package resolve-activity --brief <pkg>`
解析启动 Activity —— `am start -n` 只接受 `包/Activity` 全称，给裸包名会报
`Bad component name`（实测）。命令发出后还会**复核** task 真的落在目标屏
（命令返回 0 而实际没动的情况实测存在）。

### 三种收尾，由调用方按意图选

| 意图 | 工具 | 主屏前台 |
|---|---|---|
| 让用户**接手**（AI 停在支付界面，用户来付款） | `screen_vd_handoff` | 搬到主屏并置顶 —— 此时接管前台是**期望行为** |
| 内容**不要了**（流程走错，重来） | `screen_vd_stop` | 全程不变 |
| 还要**接着用**（AI 还没干完） | 什么都不做，副屏常驻 | 全程不变 |

`screen_vd_handoff` 是 `move-stack <taskId> 0`：reparent **不重建 Activity**，
所以界面停在原处（支付页还是支付页）。实测交接前后是同一个 `taskId`、同一个
`topActivity`。

### 销毁副屏为什么必须先清栈

`screen_vd_stop`（以及 `VdMain.cleanup()`）的顺序是
**先 `am stack remove` 清掉副屏上的 RootTask，再 release 副屏**。

直接 release 时 WM 会把 task reparent 回 display 0 **且置顶**
（AOSP 的 `moveRootTaskToDisplay` 固定 `onTop=true`），用户正在用的 App 被顶掉。
实测：用户在看 piliplus、副屏跑着设置，直接释放 → 前台立刻变成设置。
清栈后再释放 → 前台逐字未变。

### 跨屏承载的前置条件：LSPosed hook

AOSP 默认拒绝把 App 放到非默认屏（`START_TASK_FROM_DISPLAY` 是 signature 权限，
root 也拿不到）。所以需要 `recognize/uiaction/hook/DshHookEntry.java` 在
system_server 里放开几处判定。它是**本仓库最危险的一段代码**，因此有四道闸：

1. **只改返回类型严格为 `boolean` 的重载** —— 用反射枚举同名方法逐个判定，
   非 boolean 的一律跳过并记日志。无差别 `hookAllMethods` 会把所有重载一并
   强制返回 `Boolean.TRUE`，只要有一个签名不匹配就会在**调用点**崩溃 →
   system_server 崩溃循环 → 只能进 recovery。**这是真踩过的事故。**
2. **全程 try/catch，任何异常只记日志**：最坏结果是"这个钩子没装上"，不是开机崩。
3. **启用标记 `/data/system/dsh-vd-hook.on`**：安装器创建；数据被清 → 标记消失
   → 模块**彻底惰性**。（路径必须在 system_server 读得到的地方 —— 放
   `/data/adb/dsh/` 会因 `/data/adb` 是 0700 而永远读不到，实测踩过。）
4. **启动失败自愈**：连续多次启动都活不过 120s 就自动停用自己，并留下
   `/data/system/dsh-vd-hook-fails` 计数。活过 120s 则计数清零。

临时关掉：`setprop persist.dsh.vd.hook 0`（下次注入生效），或删掉启用标记。

### 已知边界（诚实记下来）

- **守护进程被 SIGKILL 时来不及清理**：app_process 在 SIGTERM 下也不会跑 JVM
  关闭钩子（ART 没装信号处理器，进程被直接终止），所以"先清栈"只能覆盖
  stdin EOF / `quit` / 正常退出三条路。猝死时副屏的 task 会掉回主屏抢前台
  （实测 `kill -9` 后前台变成设置）。**JS 侧有兜底**：
  `vdStart` 记录用户当时的前台 App，子进程**意外**退出时核对并把它拉回来
  （`vdStop` 的正常路径会标记 `expected`，不触发兜底）。JS 侧兜底需要 MCP
  进程活着 —— 这是当前设计的边界。
- 3 个 hook 目标类在 MIUI/HyperOS 上被精简（`DisplayManager#canHostTasks`、
  `DisplayContent#canHostTasksLocked`、`LogicalDisplay`），打 MISS 继续；
  实测 11 个重载命中即够用。

---

## 与触控的关系

观察层（screen_tree / screen_targets / screen_image）负责给出"点哪里"，
动作层（screen_tap / screen_swipe / screen_key / screen_text）负责"点下去 /
写进去"。两者在同一个 MCP 服务里，`targets` 里每个可点目标都带 `center`，
可直接喂给 `screen_tap`。

---

## 两种运行形态

同一个识别服务有两种跑法，代码同一份。

### 形态一：PC 侧驱动（`recognize.mjs`，本目录的 CLI）

识别逻辑在 PC 上跑，通过 adb 读写设备。适合**开发调试**与**手机上还没有 harness** 的场合。

```powershell
node recognize.mjs observe
```

### 形态二：设备侧 MCP 服务（`screen-mcp.mjs`，手机本地跑）

识别逻辑跑在**手机自己的 Node 运行时**上，不依赖 adb、不依赖 PC。
以标准 MCP over stdio 暴露，任何 harness 都能接。这是在手机上让 agent"看见屏幕"的正式形态。

已部署到设备：

```
/data/adb/dsh/tools/screen-mcp        启动脚本（POSIX sh，运行时推导模块路径）
/data/adb/dsh/tools/screen-mcp.mjs    MCP 服务本体
```

接入 DSH：在 profile 的 `cordis.patch.yml` 加一条。**必须是 `- insert:` 包裹的插入条目**，
直接写 `- id:` 不会生效（这点踩过，见下）：

```yaml
- insert:
    - id: mcp-screen
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: screen
        transport: stdio
        command: /data/adb/dsh/tools/screen-mcp
```

工具随即以 `mcp__screen__<name>` 出现。

> **分层与中立性的准确说法**（先前这里写过"不出现任何 harness 名字"，过头了）：
>
> - **识别内核中立**：`screen-mcp.mjs`、`lib/uitree.mjs`、`lib/observe.mjs`、`lib/fields.mjs`、
>   `lib/spawn-env.mjs`、`lib/device.mjs` 都不依赖任何 harness —— 它们只调 Android 平台原语。
> - **部署适配器层明确绑定**：`launcher.sh` 要找 dsh_android 模块提供的 node 运行时，
>   `cordis.patch.yml` 是 DSH 的配置格式。这一层就是用来绑的，不假装中立。
>
> 换 harness 时改的是适配器层，识别内核一行不动。

### 设备侧平台事实（Android 16 / arm64）

| 事实 | 值 |
|---|---|
| `screencap` 用法 | `[-ahp] [-d display-id] [FILENAME]`；`-d` 收 SurfaceFlinger id；**不接受 `--display`** |
| 稳定锚点 | `cmd display get-displays`（机器可读，2 行）；`DisplayDeviceInfo{...}` 段作为 dumpsys 兜底 |
| **屏状态** | 必须锚定 `mState=`。裸 `state=` 在 OnePlus 上命中 **101 次**，绝大多数是 `BrightnessEvent` 历史行（含状态迁移记录）→ 会静默抓到历史值 |
| 逻辑 id ↔ uniqueId | `mViewports=[DisplayViewport{... displayId=0, uniqueId='local:...'}]`（两台都有） |
| `uiautomator dump --display` | **被静默忽略** —— 传不存在的 id 也成功并输出主屏的树 |
| 由此的结论 | 主屏：树 + 图都可用；虚拟副屏：**只有图**，树需要 App 内 `AccessibilityService` |
| 设备侧 OCR | 无 tesseract、无 ML Kit 入口 → 图片路线交给模型视觉，不在本地做 OCR |

#### 跨设备适配：先换命令，再谈"多收几台样本"

这是 PR #11 第二轮的核心缺陷。**原实现只看 OnePlus 专属的这一种形态**：

```
Display 0 [id=local:4630...,stack=0],isFirst=true,activeMode=5,state=ON,...
```

它在 Xiaomi 25102RKBEC / Android 16 上 `grep -c` 命中 **0 次** → `list_displays` 整条工具失效。

现在改用的稳定形态（见 [`lib/displays.mjs`](lib/displays.mjs) 与 [`lib/cmd-display.mjs`](lib/cmd-display.mjs)，34 项测试）：

| 形态 | 来源 | 用途 |
|---|---|---|
| `DisplayDeviceInfo{...}` | 两台都有 | 尺寸 / 密度 / 唯一 id / 类型 |
| `mState=` | 两台都有 | 真实屏状态（**不**用裸 `state=`） |
| `mViewports` | 两台都有 | 逻辑 `displayId` ↔ `uniqueId` 映射 |
| `dumpsys SurfaceFlinger --display-id` | 两台都有 | sfId 列表（`screencap -d` 要的） |

`surfaceFlingerId` 直接从 `uniqueId` 去 `local:` 前缀推导 —— 两台实测一致（`local:4630946903293830803` / `local:4630946964337362323`）。

**拿不到 `mViewports` 的机型**：`logicalId` 为 `null`（不编一个数），`list_displays` 打印 `displayId ?` 并提示用 `sfId` 指定屏。

> **段边界的坑**：`dumpsys` 的顶层分组是**顶格行**，其后紧跟一条纯分隔线。最初把那条分隔线当成段尾，于是段内一行都没读到 —— 而测试没发现，**因为夹具里没放那条线**。现在夹具已对齐真机，并加了一条**直接喂真机 dump 文件**的回归测试，夹具再偏离现实也会被发现。

---

## 已实测 / 未实测

**已实测**：

**设备 A：OnePlus PLK110 · Android 16 · KernelSU v3.3.0**（`u:r:ksu:s0` + Enforcing）

```
PC 形态
  displays   : 正确报出 1272x2772 @560dpi(覆盖 476)、165fps、屏状态 ON
  selftest   : 11/11 通过（解析器 + 合并逻辑）
  observe    : 树 68 节点 / 图像 27 行 → 合并 79 → 去重 57，总耗时 4.3 秒
  可点祖先   : 生效（FrameLayout 作为可点目标，TextView 也可用）
  树+图印证  : 生效（WakeUp课程表 → both 0.99）
  熄屏检测   : 生效（纯黑 20 KB vs 正常画面 1.38 MB）

设备形态（手机本地 Node v26.4.0）
  spawn-screencap : 1,378,566 B, PNG 校验通过
  uitree          : 25,303 B, hasHierarchy=true
  MCP 协议        : initialize 2025-11-25 / tools/list 8 工具 / tools/call 全部正确
  多屏            : list_displays 正确报出主屏；非默认屏请求树 → 明确报错 tree-needs-app
  接入 DSH        : 日志确认「[screen-mcp] 客户端已初始化」，进程树显示 DSH 拉起 MCP 子进程
```

**设备 B：Xiaomi 25102RKBEC · Android 16**（由 @Strbit 端到端复跑，暴露了 `LD_LIBRARY_PATH` 那个坑）

```
带 DSH 服务的 LD_LIBRARY_PATH  -> uiautomator dump exit=1, 文件 0 B（树路线全灭）
剔除该变量后                    -> uiautomator dump exit=0, 19774 B / xml 22585 B
node 自身仍健康                 -> v26.4.0
screencap 不受影响              -> 562471 / 563077 B（带与不带都能出图）
```

**动作层在设备 B 上的实测（2026-10）**：

```
微信树屏蔽机理    : 未挂服务 -> MCP screen_tree 报 "1 节点 / 不可用: tree-empty"
                    挂系统预装 SelectToSpeak -> "112 节点, 15 有文字, 20 可操作 —— 可用"
                    （同一界面、同一工具, 唯一变量是服务绑定；内容可读:
                      "我是刘思宇" / "我通过了你的朋友验证请求" 等微信聊天文字）
ACTION_SET_TEXT   : 经 MCP 链路 tools/call screen_text 注入微信 EditText
                    (com.tencent.mm:id/bkk, 戴荣辉聊天页):
                      注入 {"ok":true,"mode":"action_set_text","cost_ms":212,
                            "before_text":"","verified_text":"国庆快乐"}
                      清空 {"ok":true,"before_text":"国庆快乐","verified_text":""}
                    读回来自节点 refresh() 后 getText(), 不是回显输入；
                    清空那次的 before_text 恰是上一次写入的内容 —— 交叉证明。
子屏可达性        : input -d 3 tap/keyevent 真实落地（打开群资料页并返回）
虚拟副屏创建      : app_process + VirtualDisplayConfig 反射成功（1200x2608@480, trusted）
screencap 副屏    : `screencap -d 3` 报 Display Id not valid —— 副屏截图需 ImageReader
                    路径（未做，属虚拟副屏工程的范畴）
```

**两个只有真机链路才会暴露的缺陷（都已修 + 已加回归门）**：

```
1. spawn-env.mjs 默认 spawnImpl 为 null
   观察工具全都显式传了 execFile，所以这个坑被掩盖；动作层起先没传,
   真机 screen_text 直接 "spawn is not a function"。
   → runCommand 默认 execFile；test-uiaction 加一条"不传 spawnImpl 也能跑"的
     回归断言（反向验证过: 改回旧写法该断言精确变红）。

2. app_process 没有主 Looper（logcat 铁证）
   FATAL EXCEPTION: UiAutomation
     NullPointerException: Looper.mQueue on a null object reference
       at android.os.Handler.<init>(Handler.java:272)
   症状是 shell 只打印 "Killed"、stderr 全空 —— screen_text 报 "Command failed"
   而没有任何线索。
   → main() 开头 if (Looper.getMainLooper() == null) Looper.prepareMainLooper();
   → 同时让 injectText 在失败时把动作进程的 stdout/stderr 带进错误信息
     （这次绕远路的直接原因就是那两行是空的）。
```

单元测试（本机，无需设备）—— 共 103 项
  recognize.mjs selftest  : 11/11 通过（解析器 + 合并逻辑）
  test-fields             : 22/22 通过（head+tail 截断 / 数组有界化 / 缓存新鲜度契约）
  test-spawn-env          : 15/15 通过（子进程环境分类 —— 拦住上面设备 B 那个坑）
  test-screen-image-cache : 6/6 通过（screen_image 缓存链路 / 主副屏不串味）
  test-displays           : 34/34 通过（跨设备屏解析 —— 主路径 cmd display，dumpsys 兜底，
                            含一条直接喂真机 dump 文件的回归）
  test-uiaction           : 14/14 通过（动作层：服务挂载状态机 / argv 构造 / dex 落点 /
                             runCommand 默认实现 —— 最后一条拦的是真机抓到的 spawn bug）
  test-screen-mcp         : 端到端 MCP 协议，带断言（已实测"该失败时 exit=1"）
  bench-frame-path        : zlib 量化（level 1 = 21 ms, level 9 = 546 ms, 体积几乎一样）

设备侧自检（device-selftest.mjs，在 OnePlus 上实跑）
  6/6 通过：screencap / tmpfile / uitree / displays / ocr(符合设计) / loopback
```

**未实测**：

- **Redmi K90 Pro Max / HyperOS 3（`25102RKBEC` / Android 16）——
  只跑到「暴露问题」，没跑到「确认稳定」。**
  @Strbit 用它做端到端复核，暴露了 `LD_LIBRARY_PATH` 与 `list_displays` 两个跨设备缺陷
  （这两条的修复都因此而来），也确认了修复后 `screen_targets` 可用；
  但那条 `DisplayDeviceInfo` 稳定形态**我方没有该机的原始 dump 可核**，
  所以它不算"已验证的第二样本"，只算"已确认能暴露缺陷的设备"。
  仓库 `fixtures/` 里留档的仍是 OnePlus 的 dump。
- 加固应用、游戏等"没用的树"场景
- 虚拟副屏的实际截图（设备上无副屏可测）
- 视觉模型读截图的端到端效果（需要模型侧实际调用一次）
- OCR 对图标小字的准确率（PC 侧会误读成 `0@0`、`00` 之类噪声）
- **帧缓存的真机收益**：设备上 `screencap -p` 的真实耗时（本机只有 zlib 量级，不是手机数字）
- **JPEG 替代 PNG 的可行性**：需要先知道 `screencap` 无参数输出的原始格式 —— 没设备取不到
- **第三台设备的形态**：稳定形态目前**只有 OnePlus 一份经我方核实的原始 dump**。
  遇到别的厂商 ROM 时 `lib/displays.mjs` 的 `findSegment` / `parseDisplayDevices`
  是唯一需要看的地方；解析不出来时会**明确报错**并说明期望的形态，不会兜底。
- **副屏的无障碍树**：`uiautomator dump --display` 被平台静默忽略，
  所以副屏**只有截图、没有树**。这是正则解决不了的，需要 App 内的
  `AccessibilityService.getWindowsOnAllDisplays()`（见下面「架构方向」）。

---

## 架构方向：从「解析文本」转向「调 API」（已做最小验证，未落地）

这一节记录一个**方向性判断**与它的实测依据，供后续决定。**当前代码没有走这条路。**

### 为什么现在这套脆弱

这个模块真正脆的地方**只有"屏枚举"一处**：`screencap` / `uiautomator` 是平台二进制、
CLI 稳定，像素路线本身通用；树路线的失效来自 App 加固/自绘（与机型无关）。
唯一"必须从文本里挖事实"的就是屏列表 / 逻辑 id ↔ sfId ↔ uniqueId / 屏状态。

而文本这条路**无法靠加机型收敛**。实测到的形态方差：

```
同一个 uniqueId 字段，三种拼法:
  cmd display:        uniqueId "local:4630946964337362323"   无等号
  DisplayDeviceInfo:  uniqueId="local:4630946964337362323"   双引号
  mViewports:         uniqueId='local:4630946964337362323'   单引号
```

这些差异已经咬过两次（`mState` vs 裸 `state=` 的 101 处噪声、
`DisplayDeviceInfo` 段边界的判错）。**整栋楼压在一个"切段 + 锚定"的启发式上。**

### 更稳的两步（第一步已落地）

**第一步（已做）**：主路径改用 `cmd display get-displays`。它是给机器看的，
每块屏一条记录，字段直接可解析：

```
cmd display get-displays   2 行     5.3 KB
dumpsys display            985 行   125 KB
```

`dumpsys` 降为兜底。解析面小了三个数量级，也不再需要切段。

**第二步（未做，但已实测可行）**：用 `app_process` 调 `DisplayManager`，拿**类型化对象**。

`lib/cmd-display.mjs` 仍然在解析文本 —— 只是文本变简单了。真正通用的是 API。
`uiautomator` 自己就是这条路线的活证据（见 `/system/bin/uiautomator`）：

```sh
CLASSPATH=/system/framework/uiautomator.jar
exec app_process /system/bin com.android.commands.uiautomator.Launcher
```

它**不带 App、不用 root、跨机型可用**，就因为它走 `UiAutomation` API 而不是解析文本。

#### 已实测：最小可行性验证通过

本机（OnePlus PLK110 / Android 16）用 JDK 17 + d8 编了一个 5 KB 的 dex，
在 `app_process` 里跑通 `DisplayManagerGlobal.getDisplayInfo(id)`：

```
DISPLAY|id=0|name=内置屏幕|type=1|uniqueId=local:4630946903293830803|
        state=2|rotation=0|modeId=5|renderFrameRate=165.0|
        logicalWidth=1272|logicalHeight=2772|appWidth=1272|appHeight=2772|
        densityDpi=476|flags=16515|group=0
```

`state=2` 就是 `Display.STATE_ON` —— **没有任何正则**。踩到并修掉的两个坑：

1. **必须先 `Looper.prepare()` 再 `ActivityThread.systemMain()`**
   （反过来报 `Can't create handler inside thread that has not called Looper.prepare()`）
2. `getType()` / `getUniqueId()` 是 **@hide**，编译期 `android.jar` 里没有 → 必须反射

#### 它还能解决一个正则**永远**解决不了的问题

```
uiautomator dump --display 2   →  被 Android 静默忽略，永远返回主屏的树
```

实测确认（传不存在的 id 999 都成功）。所以**副屏只有图、没有树** —— 文本解析无解。
而 API 路线能解：`AccessibilityService.getWindowsOnAllDisplays()`（API 30+）。
设计文档 §3 已写了这个方案。

#### 代价（要诚实说）

| 项 | 说明 |
|---|---|
| 需要 dex 构建链 | javac + d8 + android.jar（本机已具备，CI 要配） |
| 多一个构建产物 | 5 KB dex 要么进仓库、要么构建期生成 |
| 代码从 JS 变 Java | 现在全是 `.mjs`，要加 Java 源与构建脚本 |
| 引用了 @hide API | 大版本升级可能变（但 `uiautomator` 也这么活了很多年） |

#### 落地前还要验证

- 副屏枚举（`getDisplayIds()` 是否含虚拟屏）
- 从 `app_process` 里拿无障碍树（反射构造 `UiAutomation`）—— 这才是副屏树的正解
- 构建链进 CI 的可行性
- dex 拿不到时的回退：仍走 `cmd display` → `dumpsys` 两级文本兜底

---

## 踩过的坑（避免重犯）

1. **`.gitattributes` 的 `text=auto` 会在 checkout 时剥掉 UTF-8 BOM**，而 PowerShell 5.1 把无 BOM 的
   UTF-8 当 ANSI 读，中文脚本会炸出莫名的 `Unexpected token`。→ PowerShell 脚本一律**纯 ASCII**。
2. **`cordis.patch.yml` 的条目必须包在 `- insert:` 里**。直接写 `- id:` 会被静默忽略 ——
   harness 正常启动、日志无报错、插件就是不加载，很难查。
3. **Node 的模块解析按脚本自身位置，不按 cwd**。用 `/data/local/tmp` 下的脚本去 `require` 应用树里的包
   必然 `MODULE_NOT_FOUND`；要么把脚本放进应用树，要么用绝对路径。
4. **别用 PowerShell 的 `>` 抓二进制**（截屏会损坏：magic 变成 `FF FE FD FF`）。用 `exec-out` + Buffer，
   或 `cmd /c "... > file"`。
5. **`uiautomator dump` 只能写文件**，`/dev/tty`、`/proc/self/fd/1`、`-`、`/dev/stdout` 四种 stdout 方式
   全部拿不到内容。且 `uiautomator dump --help` 不支持 help，只会生成 `/sdcard/window_dump.xml`。
6. **嵌套引号在 `adb shell` 里极脆弱**（`$VAR` 会被宿主 shell 吃掉，`|` 会被解析）。复杂操作写成脚本文件再推上去执行。
7. **`LD_LIBRARY_PATH` 会按环境打死 `uiautomator` —— 但删不得，因为 node 自己需要它。**
   这是本模块最隐蔽的一个坑，由 @Strbit 在第二台设备（Xiaomi / Android 16）上端到端测出来：

   ```
   DSH 服务导出 LD_LIBRARY_PATH=<模块>/usr/lib（模块自带 node 需要它找 libz 等库）
   screen-mcp 由 harness 经 stdio spawn → 必然继承
   同一台设备, 同一条命令:
     带该变量   -> uiautomator dump  exit=1, 文件大小 0
     不带该变量 -> uiautomator dump  exit=0, 19774 B
   ```

   报错是 `CANNOT LINK EXECUTABLE "app_process": cannot find "libz.so" from verneed[1]` ——
   尽管 `libz.so -> libz.so.1.3.2` 符号链接**明明存在**（机制是 verneed 版本节点校验）。

   **不能全局删**：删掉后 `/usr/bin/node` 报 `library "libz.so.1" not found`。
   一个变量两向绑定 —— **唯一正确的修法是按子进程区分**：系统二进制剔除，node 保留。
   见 `lib/spawn-env.mjs`，有 15 项断言盯着这件事（`test-spawn-env.mjs`）。

   > 另一台设备才能暴露的坑：作者在 OnePlus 上测时该变量恰好不致命，所以没发现。
   > 跨设备验证不是可选项。

8. **测试没有断言 = 假绿**。`test-screen-mcp.mjs` 最初只打印期望值、不设 `process.exitCode`，
   于是子进程压根没起来也报"通过" —— 而它恰好是唯一覆盖端到端路径、唯一能拦住上面第 7 条的测试。
   现在它有真断言，且已实测过"该失败时确实 exit=1"。

9. **测试 runner 必须支持 async**。最初的 runner 是 `try { fn() }`，对 async 测试抓不到 rejection，
   7 个缓存测试的失败被静默吞掉（显示"22 通过"是假的）。现在是顺序 `await` 的 runner。

10. **夹具会不知不觉偏离真机 —— 这是最隐蔽的一类问题。**
    本轮踩了三次，每次都让测试"通过"但测的不是真机形态：

    | 夹具偏离 | 后果 |
    |---|---|
    | `mState` 写在 `DisplayDeviceInfo` **之前** | 真机是之后；解析器只向后读，测不到真问题 |
    | 少写段头后的分隔线 | 真机有；解析器把它当段尾，**段内一行都没读到** |
    | `DisplayDeviceInfo` 块里多写了 `state ON` | 真机那个 `state` 不是状态来源，会诱使写错正则 |

    对策：**加一条直接喂真机 dump 文件的回归测试**（`test-displays.mjs` 末尾那条）。
    喂真机文件就不会被骗。另外每个夹具都注明来源（实机抓取 / 审阅者给的行）。

11. **`execFileSync` 默认返回 Buffer，不是字符串。** `device-selftest.mjs` 里漏了 `encoding: 'utf8'`，
    于是 `dumpsys` 的输出是 Buffer，传给解析器后报 `text.split is not a function` ——
    看着像解析器的错，其实是调用方漏了一个参数。

12. **同一段文本被两个正则处理时，作用域很容易搞混。**
    `parseDisplayDevices` 里 `raw` 是 `DisplayDeviceInfo{` **之后**的内容，
    但 name 正则写成了 `/DisplayDeviceInfo\s*\{\s*"([^"]*)"/` —— 在别处能匹配，在 `raw` 上永不匹配，
    于是 `name` 恒为 `null`。而当时的测试只断言"解析出几块屏"，没查字段值，所以漏了过去。
    → **断言要查字段值，不能只查数量。**

13. **同一个缺陷往往有两份实现，修一份等于没修 —— 而且会以"修复已验证"的形式骗过自己。**
    这个 PR 里同样的事发生了**两次，方向相反**：

    | 轮次 | 修好了 | 漏掉了 | 后果 |
    |---|---|---|---|
    | 第二轮 | 设备侧 `screen-mcp.mjs` 新建 `lib/displays.mjs` | PC 侧 `observe.mjs` 仍是旧解析的副本 | PC 侧 CLI 静默返回 0 块屏 |
    | 第三轮 | PC 侧改走 `parseDisplaysPreferred` | 设备侧 `list_displays` 仍直连 `parseDisplays` | R-6 修完在设备上**没生效**（只走 dumpsys 兜底） |

    第二次尤其值得记：我刚批评完"只落一半"，接着自己又只落了一半。
    → **收敛到单一路径时，要能回答"还有谁在直接调底层解析器"**，
    并且这条要有测试守（`test-displays.mjs` 的"主路径与兜底路径结论一致"就是干这个的）。

14. **工具太能干，会掩盖工具坏了。**
    模型有 root + bash + node，实测它会绕过坏掉的工具自己造轮子：
    轮 7-8 用 `awk` 自己解析 XML 出坐标；轮 9 因为 `screen_image` 的图被 harness 拒收，
    它**自己写了两个 Node 脚本**用 `zlib.inflateSync` 解 PNG + 逐行反滤波，数出了颜色直方图。

    危险在于**结果通常是对的** —— 用户从界面上看不出工具挂了，只感受到慢
    （轮 9 花了 29 秒写脚本）和偶发错误（轮 8 它自己承认"第一次坐标全错"）。
    → 工具描述里必须明确要求"报错就报原文，不要自己重实现"（见 `HONESTY_NOTE`）。

15. **断言写粗了会误报，而误报会让人把正确的行为改坏。**
    `test-serve.mjs` 的去重断言第一版写成"原始数 == 去重数就失败"，真机上立刻报错。
    查证后发现那台设备 25 个目标**一对重叠都没有**（最小间距远超 8px 容差），
    25 → 25 是**正确**的。改成"只在真有重叠却没合并时失败"才对准。
    → 断言的粒度要跟着**被测逻辑的判据**走，不能只看数量的守恒。

---

## 相关文档

| 文档 | 内容 |
|---|---|
| [`../docs/mobile-control-layer-design.md`](../docs/mobile-control-layer-design.md) | 控制层形态、分层架构、接口契约、设计纪律 |
| [`../docs/android-agent-harness-plan.md`](../docs/android-agent-harness-plan.md) | 设备事实、平台行为与坑清单、风险登记册 |
