# 手机端控制层设计（自研路线）

**目标**：DSH 跑在手机里；手机侧的控制层自研，不复用任何第三方实现。
**长期目标**：未来换成自己的 harness——所以控制层**不能绑在 DSH 上**。
**设备**：Redmi K90 Pro Max · HyperOS 3 / Android 16 · KernelSU + LSPosed

> 配套阅读：[android-agent-harness-plan.md](android-agent-harness-plan.md)（设备事实、平台行为、安全设计输入、风险登记册）。

---

## 0. 形态决定

| 项 | 决定 |
|---|---|
| 分发形态 | **KernelSU 模块**（不是 APK，理由见 plan 文档 §2） |
| 运行时来源 | PC 上从 Termux 的 `.deb` 解出 aarch64 Node，打进模块；**手机端不装 Termux** |
| 控制层 | 自研，与 harness 解耦 |
| harness | 现在用 DSH，未来可换 |

**这个形态顺带消掉了一整类问题**：不需要 W^X 绕行、不需要处理 AGP 丢 `.so` 名、不需要把运行时伪装成 `lib*.so`、不需要首启解压几百 MB。

---

## 1. 为什么模块形态比 APK 简单一个量级

把 Node 塞进 **APK** 会遇到的问题，在 **KSU 模块**里大部分根本不存在——因为它们是"APK 沙箱"这个约束的产物，不是 Android 本身的限制。

| APK 沙箱带来的问题 | 根因 | 在 KSU 模块里 |
|---|---|---|
| 官方 Node 不发布 Android 构建 | Node 上游不支持 Android | 仍要解决，但**可以在 PC 上从 Termux 的 `.deb` 解出来**，不用自己编 |
| W^X：`targetSdk>=29` 不能 exec data 目录 | APK 沙箱 | **不存在**。模块脚本本来就从 `/data/adb/modules/` 执行 |
| `patchelf --set-soname` 归一名字 | AGP 会静默丢掉带点的 `.so` 名 | **不存在**，没有 AGP |
| 二进制要伪装成 `lib*.so` | 只有 `nativeLibraryDir` 允许 exec | **不存在** |
| `os.cpus().length` 可能返回 0 | APK 沙箱环境 | 正常 |
| 几百 MB 运行时树打进 `assets/`，首启解压数万文件 | APK 打包方式 | **不存在**，直接落盘 |
| 前台服务保活 | Android 后台限制 | `service.sh` 开机自启，跑在 root |

> **仍然要处理的**：Termux 编出来的二进制有一批写死的 Termux 路径，需要设 `OPENSSL_CONF` / `SHELL` / `TMPDIR` 三个环境变量（plan 文档 §5.1）。这是唯一的残留问题。
>
> **未验证**：DSH 的原生依赖（`koffi` / `node-pty` / `sharp` / `node-addon-*`）在 bionic 上是否都能过。这是探针第一步要测的。

**代价**：模块没有 APK 那种"应用生命周期"，保活要靠模块脚本 + HyperOS 白名单（plan 文档 §3.1）。

---

## 2. 架构决定：控制层不绑 DSH

你说"未来可能会换用自己的 harness"。这一句决定了整个架构。**如果控制层直接写成 DSH 插件，换 harness 就得重写。**

所以分三层：

```
┌──────────────────────────────────────────────────────────┐
│  harness 层（可替换）                                     │
│    DSH（现在）  →  你自己的 harness（以后）                │
│    只写"适配器"：把控制层的 API 翻译成该 harness 的工具定义 │
└───────────────────────────┬──────────────────────────────┘
                            │  稳定 API（进程间）
┌───────────────────────────┴──────────────────────────────┐
│  控制层（你自己的核心资产，不随 harness 变）               │
│    · 能力实现：建屏/截图/注入/读树/起应用/按键             │
│    · 权限边界：哪些操作要 root、哪些不要                   │
│    · 安全模型：谁可以调、怎么鉴权                          │
│    · 观测新鲜度：屏状态、帧时间戳                          │
└───────────────────────────┬──────────────────────────────┘
                            │  平台 API / su
┌───────────────────────────┴──────────────────────────────┐
│  Android 平台                                             │
└──────────────────────────────────────────────────────────┘
```

**判断标准**：控制层里**不允许出现 "dsh" 这个词**。一旦出现，说明耦合了。
适配器应该是薄薄一层——几十行，只做协议翻译。

**传输选什么**：
- 控制层对外只暴露**一种**传输。建议 **Unix domain socket**（放在 `/data/local/tmp/` 或你 app 的私有目录），或 **loopback TCP + token**。
- **永远不要绑 `0.0.0.0`**。这是 plan 文档 §5.1 那条 root shell 的根因。
- 如果用 TCP：绑 `127.0.0.1`，且**必须**带 token（启动时随机生成，写到一个只有 root 能读的文件）。

---

## 3. 能力 → 平台 API 映射

**关键纪律：这张表从 Android 官方文档和 AOSP 行为推导，不要从别人仓库的源码里抄。** 理由见 §8。

| 能力 | 平台 API | 权限要求 | 谁能做 |
|---|---|---|---|
| 建虚拟屏 | `DisplayManager.createVirtualDisplay` | `CAPTURE_VIDEO_OUTPUT`（signature） | **只能 shell(2000) 或 root** |
| 虚拟屏输出面 | `VirtualDisplay.setSurface` + `ImageReader` | 同上 | 同上 |
| 截某块屏 | `screencap -d <SurfaceFlinger 64位 id>` | root/shell | root/shell |
| 注触摸 | `InputManager.injectInputEvent` + `setDisplayId`；或 `input -d <id> tap/swipe` | `INJECT_EVENTS`（signature） | **shell 或 root** |
| 注按键 | `input -d <id> keyevent` | 同上 | shell 或 root |
| 读无障碍树 | `AccessibilityService.getWindowsOnAllDisplays()`（**API 30+**，`getWindows()` 只有默认屏） | 用户手动开无障碍服务 | **必须是 App** |
| 读无障碍树（无 App） | `UiAutomation`（从 `app_process` 里反射构造） | root/shell | root/shell |
| 读无障碍树（最简） | `uiautomator dump` | root/shell | root/shell（**先测这个**） |
| 按名字点击 | `AccessibilityNodeInfo.performAction(ACTION_CLICK)` | 无障碍服务 | App |
| 灌文字 | `AccessibilityNodeInfo.performAction(ACTION_SET_TEXT)` | 无障碍服务 | App |
| 起应用到某屏 | `am start --display <id>` | root/shell | root/shell |
| 列可启动应用 | `PackageManager.queryIntentActivities` + manifest `<queries>` | 无 | 任何进程 |
| 列某 user 装了什么 | `pm list packages --user N` | 跨 user 需 `INTERACT_ACROSS_USERS_FULL`（signature） | root/shell |

**三个由此推导出的架构事实**：

1. **建虚拟屏必须要一个 shell/root 进程。** 普通 App 拿不到 `CAPTURE_VIDEO_OUTPUT`——这就是为什么两个项目都用 `app_process`。你没得绕。
2. **读无障碍树有两条路**：写个 App 用 `AccessibilityService`（干净、稳定，但要建 App 项目），或从 root 进程用 `UiAutomation`（不用 App，但要写 `app_process` + dex）。**先用 `uiautomator dump` 测**——如果它够用，你省掉一整个 App。
3. **注输入只需要 shell/root，不需要 App。** 所以第一阶段可以完全不做 App。

---

## 4. 安全模型

有一类设计错误的后果特别严重，构成是三个决定叠加：**绑 `0.0.0.0` + 无鉴权 + 提供任意命令执行**。**控制层必须从设计上排除这三种可能。**

**硬约束（写进代码注释，别只写在这）**：

1. **绑 `127.0.0.1`**。不给"以后可能需要局域网"留口子。真需要远程，用 `adb forward` 或 SSH 隧道——那是有意为之、有明确边界的。
2. **必须有 token**。启动时 `crypto.randomBytes(32)`，写进 `0700` 的运行时目录；客户端从同一路径读。**不设"方便起见先不加鉴权"的开关。**
3. **不提供任意命令执行**。这是最重要的一条。
   - 想要"读文件"就做 `read_file`，想要"列应用"就做 `list_apps`——**做成有类型的操作**。
   - 一旦你提供一个 `sh -c`，前面两条就白做了：攻击者不需要绕过你的鉴权，他直接调用你的 shell。
   - 如果你确实需要 shell 能力（agent 要跑 `pm`、`settings` 之类），把它做成**受控的、有白名单的**操作，或者干脆接受"agent 的 shell 是 harness 层的能力"（DSH 自带 bash 工具），**不要在你的控制层里再开一个**。
4. **校验调用方**。Unix socket 用文件权限；TCP 除了 token 还要看 `RemoteAddr` 是不是回环。
5. **不缓存帧而不标注新鲜度**。缓存画面能省掉重复编码的开销（`screencap` 的 PNG 编码在设备上可能要 1 秒以上），但代价是"熄屏或画面静止时读到旧帧且不报错"。**观察结果必须带 `displayState` 和帧时间戳**，让调用方自己判断能不能信。

---

## 5. 工具契约（草案）

命名前缀你自己定，别用别人的 `lw_` / `mobile_`。下面用 `dev_` 占位。

**设计原则**（每一条都对应一个已确认的失败模式）：

| 原则 | 对应谁的坑 |
|---|---|
| **每个动作显式带 `displayId`**，没有"当前屏"这种隐式状态 | 用户的屏和模型的屏必须分开；隐式状态会让人和 agent 抢屏 |
| **观察结果带 `displayState`（`on`/`dozing`/`off`）与帧时间戳** | 熄屏静默失败 / 缓存旧帧 |
| **按键传名字不传编号** | 编号不认识就是另一个键（5 是打电话，26 是电源键） |
| **长按时长是参数，且有具名档位**，上限硬性截断 | 8 秒的电源键在很多机器上是硬重启 |
| **坐标只在"某块屏的坐标系"里成立**，返回时带上屏尺寸 | 虚拟屏被 resize 后旧坐标全部失效 |
| **文字注入报告走了哪条路**（无障碍 `ACTION_SET_TEXT` vs 按键兜底） | 两条路的字符集能力完全不同（兜底只有 ASCII） |
| **错误是类型化的**，不是字符串 | `no_focused_input` / `ambiguous_target` / `not_editable` / `inject_rejected` 要能被程序区分 |
| **歧义时不动作，返回候选** | 猜一个点下去比不点更糟 |
| **所有平台路径运行时推导**，不硬编码 | 写死的路径 / 组件名 / 库名换一台设备就失效，而且往往静默失效 |

**最小工具集**（第一阶段够用）：

```
dev_display_list()                      → 有哪些屏，各自尺寸/dpi/state
dev_screenshot(displayId)               → PNG + 帧时间戳 + displayState
dev_tap(displayId, x, y, hold?)         → 点 / 长按
dev_swipe(displayId, from, to, ms)      → 滑动
dev_key(displayId, name)                → 按键（名字）
dev_type(displayId, text, target?)      → 灌字，报告 via: field|keys
dev_ui(displayId)                       → 结构化节点树（含可点祖先、坐标）
dev_launch(displayId, pkg)              → 起应用到某屏
dev_apps()                              → 可启动应用列表
```

**第二阶段**（等主屏争抢真的成为问题再加）：

```
dev_screen_create(width, height, dpi)   → 建虚拟屏，返回 displayId
dev_screen_resize(displayId, w, h, dpi)
dev_screen_release(displayId)
```

**刻意不做的**：
- ❌ `dev_shell` —— 见 §4.3
- ❌ `dev_notify` / `dev_question` —— 那是交互 UX，不属于控制层
- ❌ 任何"胶囊""灵动岛"式的 OEM 特性——它们在 HyperOS 上没有对应物（plan 文档 §4.8.1）

---

## 6. 分阶段路线

### 阶段 1：DSH 进手机（先做，与控制层无关）

**目标**：手机上跑起 DSH，能用，能持久。

1. 装 Termux（**从 F-Droid 或 GitHub Releases，不要用 Play 版**——Play 版已废弃且行为不同）。
2. `termux-setup-storage` 拿到 `/sdcard` 访问。
3. `pkg update && pkg install nodejs-lts git ripgrep`。
   - 先 `node -v` 确认版本满足 DSH 要求。
4. 装 DSH，跑 `dsh web`。**这一步就是 DSH 六个原生依赖缺口的实测**——看有没有 `koffi` / `node-pty` / `sharp` 相关的加载失败。
5. **PC 怎么连上手机的 3080**：
   ```
   adb forward tcp:3080 tcp:3080
   ```
   然后 PC 浏览器开 `http://127.0.0.1:3080`。
   > 这样**不需要**给 DSH 开 `--allow-lan`（上游可能没有这个旗标，那是别人 fork 加的）。而且**全程不出网**，比开局域网安全。
6. 保活：Termux 的前台通知 + HyperOS 白名单（plan 文档 §4.1 五条全做）。
7. 工作区放 `/sdcard/DSH/`，这样文件管理器翻得到。

**验收**：PC 浏览器能操作手机上的 DSH；锁屏 30 分钟后仍在线。

### 阶段 2：控制层 MVP（只做非虚拟屏能力）

**目标**：不建虚拟屏、不写 App，用最少的代码让 agent 能操作手机。

- 全部通过 `su -c` 调平台命令：`input -d`、`screencap -d`、`am start --display`、`settings`、`pm`、`dumpsys`。
- 读树先试 `su -c uiautomator dump`。**这是整个阶段最值得先花 10 分钟验证的事**——它决定你要不要写 App 或 `app_process` helper。
- 传输：Unix socket 或 loopback TCP + token（§2）。
- 适配器：一个 DSH 插件，把 `dev_*` 翻译成工具定义。

**验收**：让 agent 完成一个 20 步任务（例如"打开设置 → 逐层进入某子页面 → 截图 → 返回"）。

### 阶段 3：虚拟屏（当主屏争抢成为真问题时）

- 写一个小的 `app_process` helper（Java/Kotlin → dex），只负责 `createVirtualDisplay` + 输出面。
- **BOOTCLASSPATH 从环境继承，不要硬编码**（别人的教训）。
- 屏的名字自己定，但**别让代码依赖某个字符串**——把名字存在状态文件里，按 id 引用。

### 阶段 4：按需补 App

只有在下面任一成立时才建 Android 项目：
- `uiautomator dump` 不够用，而你又不想写 `UiAutomation` 的反射代码；
- 你需要在 HyperOS 上更稳的无障碍绑定；
- 你想要更好的常驻/通知体验。

### 阶段 5：换 harness

写一个新的适配器（几十行），控制层**一行不动**。如果做不到"一行不动"，说明 §2 的边界没守好。

---

## 7. 设计纪律：从平台文档出发

**规则：每个设计选择都要能说清它的平台依据，而不是"某个实现是这么做的"。**

收益有两个：代码更可移植（平台行为是稳定的，某个实现的现状不是），以及不会连带继承别人的问题。

**要特别警惕的一类写法**：把"在某一台设备上试出来的值"固化进代码。

| 症状 | 后果 |
|---|---|
| 写死的库名 / jar 名 | 换一台设备就加载失败 |
| 写死的组件名（假设机器上恰好装了某个 app） | 换一台设备就静默失效 |
| 写死的绝对路径（开发机上的目录） | 换一台设备就找不到 |
| 探测失败就用默认值（固定分辨率 / DPI） | **静默错坐标**，比直接报错危险得多 |
| 按包名做系统 UI 过滤（只覆盖自己机器的 OEM） | 换一台设备就漏过滤 |
| 缓存数据不标注新鲜度 | 读到旧数据且不报错 |

**对应的做法**：运行时推导、运行时发现、失败就报错、按语义判断而不是按名字。

**可以正当参考的**（是知识，不是代码）：
- 哪些 Android 权限是 signature 级的、哪些操作必须 shell/root（plan 文档 §5）
- HyperOS / 小米特有的行为（plan 文档 §3）
- 熄屏静默失败、截图双预算、触摸要排队这类平台行为（plan 文档 §5）

**不要做的**：为了"看看怎么做"去读某个具体实现再照着写——会写出一个换皮的版本，而且继承它的问题。真读了，就隔一段时间从平台文档重新设计。

---

## 8. 待定

1. **传输**：Unix socket 还是 loopback TCP + token？（建议前者，如果 Termux 与 helper 的 uid 关系允许）
2. **读树路线**：`uiautomator dump` 够不够？——**这个先测，它决定后面要不要建 App**
3. **控制层用什么语言写**：Shell + Node（跟 DSH 同栈，最少摩擦）还是 Java/Kotlin（如果要做 helper）
4. **虚拟屏到底要不要**：如果 agent 主要在后台跑、你自己不常用这台手机，可能不需要
5. **要不要 Shizuku**：你有 KernelSU root，**不需要**。Shizuku 的存在意义是"不想 root"，你已经在 root 了，用 `su` 更直接、少一层依赖。

---

## 附：文档分工

| 文档 | 放什么 |
|---|---|
| 本文 | 控制层的形态决定、分层架构、接口契约、分阶段路线、设计纪律 |
| [android-agent-harness-plan.md](android-agent-harness-plan.md) | 设备事实、平台行为与坑清单、安全设计输入、风险登记册、待真机验证清单 |
| [../probe/README.md](../probe/README.md) | 地基验证模块的使用方法与判读表 |
