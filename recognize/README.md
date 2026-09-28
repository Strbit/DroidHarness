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

# 不连设备也能跑的测试
node recognize.mjs selftest        # 解析器 + 合并逻辑（11 项）
node test-fields.mjs               # 截断 / 有界化 / 缓存新鲜度契约（22 项）
node test-screen-image-cache.mjs   # screen_image 缓存链路（6 项）
node bench-frame-path.mjs          # 帧路径编码代价量化

# 需要设备
node recognize.mjs displays        # 列出所有屏及状态
node recognize.mjs observe         # 一次完整识别（两条路都跑并合并）
node recognize.mjs tree            # 只看无障碍树
node recognize.mjs ocr             # 只看图像识别
node recognize.mjs targets --limit 30   # 只输出可操作目标清单
```

> 真机上的 MCP 协议测试（需设备）：
> ```powershell
> $adb = "D:\platform-tools\adb.exe"
> $node = "/data/adb/modules/dsh_android/usr/bin/node"
> node test-screen-mcp.mjs --exec $adb shell "$node /data/adb/dsh/tools/screen-mcp.mjs"
> ```

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
│   └── ocr-windows.ps1           Windows OCR 后端（纯 ASCII）
├── launcher.sh                   设备侧启动脚本（POSIX sh，探测模块提供的 node 运行时）
├── cordis.patch.yml              接入 DSH 的 patch 配置（必须用 - insert: 包裹）
├── test-fields.mjs               单元测试：截断 / 有界化 / 缓存契约
├── test-spawn-env.mjs            单元测试：子进程环境分类（拦住 LD_LIBRARY_PATH 污染）
├── test-screen-image-cache.mjs   单元测试：screen_image 缓存链路
├── test-serve.mjs                测试：PC 侧 CLI 的逐行 JSON 服务协议
├── test-screen-mcp.mjs           端到端：MCP 协议（带断言，可真机跑）
├── device-selftest.mjs           设备侧自检（原语可用性）
├── bench-frame-path.mjs          帧路径性能量化
└── README.md
```

---

## 与触控的关系

本模块**只做观察，不做注入**。按设计文档的分层，`dev_tap` / `dev_swipe` / `dev_key` 属于输入注入，是另一块；识别层负责给出"点哪里"，注入层负责"点下去"。

所以 `targets` 里每个可点目标都带 `center`，可直接喂给注入层。

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

### 设备侧平台事实（实测于 Android 16 / arm64）

| 事实 | 值 |
|---|---|
| `screencap` 用法 | `[-ahp] [-d display-id] [FILENAME]`；`-d` 收 SurfaceFlinger id；**不接受 `--display`** |
| 默认 display id | `4630946903293830803`（64 位，但 < 2^53，JS 数字精度足够） |
| `uiautomator dump --display` | **被静默忽略** —— 传不存在的 id 也成功并输出主屏的树 |
| 由此的结论 | 主屏：树 + 图都可用；虚拟副屏：**只有图**，树需要 App 内 `AccessibilityService` |
| 设备侧 OCR | 无 tesseract、无 ML Kit 入口 → 图片路线交给模型视觉，不在本地做 OCR |

---

## 已实测 / 未实测

**已实测 —— 两台设备**：

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
  MCP 协议        : initialize 2025-11-25 / tools/list 4 工具 / tools/call 全部正确
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

单元测试（本机，无需设备）
  test-fields             : 22/22 通过（head+tail 截断 / 数组有界化 / 缓存新鲜度契约）
  test-spawn-env          : 15/15 通过（子进程环境分类 —— 拦住上面设备 B 那个坑）
  test-screen-image-cache : 6/6 通过（screen_image 缓存链路 / 主副屏不串味）
  test-screen-mcp         : 端到端 MCP 协议，带断言（已实测"该失败时 exit=1"）
  bench-frame-path        : zlib 量化（level 1 = 21 ms, level 9 = 546 ms, 体积几乎一样）
```

**未实测**：

- Redmi K90 Pro Max / HyperOS 3（文档里的另一台目标设备）—— 尚未接入
- 加固应用、游戏等"没用的树"场景
- 虚拟副屏的实际截图（设备上无副屏可测）
- 视觉模型读截图的端到端效果（需要模型侧实际调用一次）
- OCR 对图标小字的准确率（PC 侧会误读成 `0@0`、`00` 之类噪声）
- **帧缓存的真机收益**：设备上 `screencap -p` 的真实耗时（本机只有 zlib 量级，不是手机数字）
- **JPEG 替代 PNG 的可行性**：需要先知道 `screencap` 无参数输出的原始格式 —— 没设备取不到
- **设备 B 上修复后的完整端到端**：`run()` 的环境分类已在本机被 15 项断言覆盖，
  但"在 Xiaomi 上装新模块并跑通四条工具"需要在设备上确认

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

---

## 相关文档

| 文档 | 内容 |
|---|---|
| [`../docs/mobile-control-layer-design.md`](../docs/mobile-control-layer-design.md) | 控制层形态、分层架构、接口契约、设计纪律 |
| [`../docs/android-agent-harness-plan.md`](../docs/android-agent-harness-plan.md) | 设备事实、平台行为与坑清单、风险登记册 |
