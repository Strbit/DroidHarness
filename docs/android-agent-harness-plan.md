# Android Agent Harness — 平台笔记与设计输入

本文件只记录**设备事实、平台行为与设计约束**，不引用任何第三方实现。

- **目标设备**：Redmi K90 Pro Max · HyperOS 3 / Android 16 · KernelSU + LSPosed
- **文档性质**：平台事实 + 设计输入 + 风险登记册。所有"未验证"项均显式标注。
- **配套**：[mobile-control-layer-design.md](mobile-control-layer-design.md)（控制层设计）

---

## 1. 目标设备

| 项 | 值 | 对方案的意义 |
|---|---|---|
| 型号 | Redmi K90 Pro Max | 小米系 → 第 3 章全部适用 |
| SoC | Qualcomm SM8850-AC Snapdragon 8 Elite Gen 5 (3nm) | Hexagon NPU 是新一代；若日后做端侧 OCR，需较新的 QAIRT/QNN SDK 支持 |
| 系统 | **Android 16 + HyperOS 3** | Android 版本满足要求；HyperOS 是需要适配的变量 |
| 屏幕 | 6.9" 1200×2608 @ ~416 ppi，120Hz LTPO AMOLED | 虚拟屏需自适应；打孔镜像需核对 |
| 内存 | 12/16 GB | 充裕 |
| Root | KernelSU | 特权通道的基础 |
| Hook 框架 | LSPosed | 部分能力依赖 |
| ABI | arm64-v8a | 决定原生模块的平台包选择 |

---

## 2. 形态选择：KernelSU 模块 vs APK

结论：**用 KernelSU 模块**。这不是风格偏好，而是 APK 路线的一多半工作量在模块里根本不存在。

| APK 必须处理的 | KSU 模块 |
|---|---|
| **W^X**：`targetSdk >= 29` 的 app 不能 exec 自己 data 目录里的文件（`app_data_file` 上 `execute_no_trans` 被移除）→ 二进制必须伪装成 `lib*.so` 塞进 `jniLibs/`，靠 `nativeLibraryDir` 拿 exec 权限 | **不适用**。模块脚本本来就从 `/data/adb/modules/` 执行 |
| **AGP 会静默丢掉带点的 `.so` 名**（`libz.so.1` / `libcrypto.so.3` 这类进不了 APK）→ 必须用 `patchelf --set-soname` + `--replace-needed` 把整套名字归一 | **没有 AGP**，文件原样放盘上，原名可用 |
| 几百 MB 的运行时树打进 `assets/`，首启解压数万个文件（且一进后台就被系统冻住，解压跟着停） | 直接落盘，无解压 |
| 要写 Kotlin + Compose 界面 | 不需要，界面就是 harness 自己的 Web GUI |
| 前台服务保活 | `service.sh` 开机自启，跑在 root |
| 应用沙箱限制（包可见性、后台启动限制、FGS 类型强制） | 模块脚本在 app 沙箱之外，这些基本不适用 |

**平台依据**：`/data/adb/modules/` 下的文件由 root 域的模块脚本执行，这是 KSU/Magisk 模块的既有行为——模块里放二进制并执行是常规做法，不需要任何 W^X 绕行技巧。

> **注意**：这条优势只对"模块脚本 + root 进程"成立。如果哪天要在模块里再起一个**普通 app**，那个 app 仍然受 APK 的全部限制。

---

## 3. HyperOS 平台事实

### 3.1 后台保活（最可能踩的坑）

HyperOS 对后台的限制以激进著称。需要手工设置的项：

| # | 设置路径 | 目标 |
|---|---|---|
| 1 | 设置 → 电池 → 应用省电 / 电池优化 | 相关应用设为**「无限制」** |
| 2 | 设置 → 应用 → 权限 → 自启动 | **开启** |
| 3 | 最近任务 → 长按应用卡片 → 锁定 | 防止被一键清理 |
| 4 | 设置 → 通知 → 应用通知 | 允许（前台服务通知被屏蔽可能连带影响存活） |
| 5 | 设置 → 应用 → 后台弹出界面 | 若涉及浮层/前台 Activity，需放行 |

**未验证**：HyperOS 3 是否有针对 `app_process` / native 守护进程的额外限制。

### 3.2 安装 APK（`adb install` 被拦）

小米/HyperOS 上 `adb install` 常被"USB 安装"确认框拦住（`INSTALL_FAILED_USER_RESTRICTED`）。**两步缺一不可**：

1. 设置 → 更多设置 → 开发者选项 → **关闭「启用 MIUI 优化」**
2. 手机管家 → 应用管理 → 权限 → 右上角设置图标 → **关闭「USB 安装管理」**

**副作用**：关闭「MIUI 优化」会破坏部分系统集成（例如 HyperOS 跨设备剪贴板）。**日常用机建议调试完重新打开**，或改用下面的兜底。

**兜底方案**（绕过 adb 安装授权交互）：
```sh
adb push app.apk /data/local/tmp/app.apk
adb shell "su -c 'pm install -r /data/local/tmp/app.apk'"
adb shell "su -c 'rm -f /data/local/tmp/app.apk'"
```
root 的 `pm` 绕过 adb 那套授权交互。

### 3.3 LSPosed on HyperOS 3 + Android 16

原版 LSPosed 已停止维护，Android 16 上活跃的是社区维护分支。已知风险信号：

- 有 **HyperOS 2.x 上 LSPosed 崩溃**的报告
- 有 **Android 16 新安全补丁上 LSPosed 崩溃**的报告

**你的设备同时命中两个维度**（HyperOS + 新补丁）。**未验证**：这些报告是否已在最新版修复。

**应对顺序**
1. 确认用的是活跃维护的分支而非已停维护的原版
2. 升级到最新版
3. 若 Hook 起不来，评估哪些能力降级——**不是所有能力都依赖 Hook**

**KernelSU 特有**：KernelSU 里有个「默认卸载模块」（Umount modules by default）开关，开着会让 LSPosed 及其模块失效。**未验证**：你的 KernelSU 版本是否仍默认开启此项。

### 3.4 KernelSU 特有行为

- **对未在名单里的 app 会完全隐藏 `su`**：应用侧查不出有没有 root，只能试，而且**试也不会弹框**；授权只能用户在 KernelSU 管理器里手动给一次。
- 这一点对**模块形态无影响**（模块脚本本来就是 root），只影响"日后想装 APK 类方案"的场景。

### 3.5 应用双开 / XSpace

HyperOS 的「应用双开」= **另一个 Android user**（`user 999`，名字 `XSpace`），**包名 / APK / 启动组件与原版完全一样**，只有 userId 不同。

- 若要操作双开的应用，必须显式指定 `--user 999`
- **模型的 bash 列不出来**：`pm list packages` 不带 `--user` 要跨 user，而 `INTERACT_ACROSS_USERS_FULL` 是 signature 权限；带上 `--user 0` 又只看得见它自己（Android 11+ 包可见性）
- → 应用列表只能从**特权侧**拿（`pm list packages --user N`），或从 app 侧 `queryIntentActivities` + manifest 里的 `<queries>` 声明

### 3.6 屏幕与打孔

- 虚拟屏需要镜像物理屏的**打孔（cutout）**，否则应用布局会错
- 分辨率与 DPI 必须**运行时探测**，不能写死——写错的后果是**所有坐标整体偏移且不报错**
- 探测方式：`wm size` / `wm density`。**未验证**：HyperOS 上这两个命令的输出是否保留英文标签（`Physical size:` / `Physical density:`）。若被本地化或改格式，解析会失败，必须有明确的失败报错而不是兜底默认值

---

## 4. 安全设计输入

### 4.1 必须避免的缺陷类别

在"给 agent 提供设备控制能力"这件事上，有一类设计错误后果特别严重，必须从架构上排除。它的构成是三个决定叠加：

1. **本地服务绑在 `0.0.0.0`**（而不是 `127.0.0.1`）
2. **没有任何鉴权**
3. **提供一个"执行任意命令"的端点**

三者叠加 = 把设备 root 权限挂在网络上。而且还有第二条更隐蔽的路径：

**跨源请求**。如果那个端点不校验请求的 `Content-Type`，而每个响应又都带通配的 CORS 头，那么**手机上浏览器打开的任意网页**都可以向本机回环地址发出一个不触发 CORS 预检的请求并造成命令执行。

→ **这条路不依赖你在什么网络、防火墙怎么配。** iptables 只挡外部来源，挡不住本机回环。

**结论：这三个决定中的任何一个单独出现都还好，叠加就是致命的。设计时必须从源头排除。**

### 4.2 三条硬约束

1. **只绑 `127.0.0.1`**。不给"以后可能需要局域网"留口子。真需要远程，用 `adb forward` 或 SSH 隧道——那是有意为之、有明确边界的。
2. **必须有 token**。启动时随机生成，写进 `0700` 的运行时目录；客户端从同一路径读。**不设"方便起见先不加鉴权"的开关。**
3. **不提供任意命令执行端点**。想要"读文件"就做 `read_file`，想要"列应用"就做 `list_apps`——**做成有类型的操作**。一旦提供一个 `sh -c`，前面两条就白做了。

### 4.3 能力分级

给模型的能力要分层，尤其是"能执行命令"这种。

- 起步阶段**先不给**任意 shell 能力
- 需要时再按任务临时开放
- 注意叠加效应：若文件策略是 `danger-full-access` 且审批提示被禁用，**"给模型 shell"就等于没有任何人工闸门**

### 4.4 审计

审批可以按需放宽，但**审计必须照记**。若框架提供审批事件（如 `approval/asked` / `decided`），**不要为了"反正都放行"绕过它**——那样连审计都没了。

注意有些框架的 `ApprovalOutcome` 是**封闭且 fail-closed** 的：answerer 缺失 / 抛异常 / 返回不合规统统变 `unavailable`，而消费者只要不是 `allowed-once` 就拒绝。这种情况下 `danger-full-access` 这个预设名有歧义——它是"没人回答 → 全拒绝"，**不是全放行**。

### 4.5 观察结果必须带新鲜度

**不要缓存画面而不标注新鲜度。** 已知的平台行为（见 §5.2）会让"读到旧帧"变成**静默失败**：截图不报错，但交的是上一帧。

→ 观察结果必须带**屏状态**（`on` / `dozing` / `off`）与**帧时间戳**，让调用方自己判断能不能信。

---

## 5. Android 平台级坑清单

以下都是 Android 平台行为，与具体实现无关。

### 5.1 运行时与二进制

- **W^X**：`targetSdk >= 29` 的 app 不能 exec 自己 data 目录里的文件。APK 路线要把二进制改名成 `lib*.so` 放 `jniLibs/` + `useLegacyPackaging = true`，靠 `nativeLibraryDir` 拿 exec 权限。**模块路线不需要。**
- **KernelSU/Magisk 解压模块时不保留 zip 里的 Unix 权限位。** 两条推论必须同时记住：
  1. 检查二进制"在不在"要用 `-f`，**不要用 `-x`** —— 此刻它还没有执行位；
  2. `set_perm` / `chmod` 必须**早于任何执行尝试**。

  这两条一起踩会得到一个**特别隐蔽**的故障：安装脚本在设权限之前就跑二进制做测试 → 测试全部失败 → 但脚本末尾又设了一次权限 → 重启后一切正常。于是你手上只有一份误导的安装日志，会去怀疑 SELinux、怀疑 exec 被拒，而真实原因只是权限位还没设。**安装脚本里凡是"先测试、后设权限"的顺序都是错的。**
- **AGP 静默丢带点的 `.so` 名**（`libz.so.1` / `libcrypto.so.3` / `libicu*.so.78`）。必须 `patchelf --set-soname` + `--replace-needed` 归一，且 `--set-rpath '$ORIGIN'` 要打在**每一个**对象上（bionic 查的是**加载方自己**的 runpath）。
- **16 KB 页对齐**：搬运现成 ELF 时不用管，`p_align` 已经是 `0x4000`。
- **Termux 编出来的二进制有一批写死的 Termux 路径**（`/data/data/com.termux/files/usr/...`）。以下三个环境变量**少一个都起不来**：

| 变量 | 不设会怎样 |
|---|---|
| `OPENSSL_CONF` | **Node 在 bootstrap 阶段直接 abort，exit 13 且什么都不打印**。指向任意可读的普通文件（空文件就行）即可 |
| `SHELL` | fallback 是不可达的 Termux 路径 |
| `TMPDIR` | V8 的 GC 临时文件落到写死路径上 |

- **`libnode.so -v` 是假阳性冒烟测试**：它不初始化 crypto，能打印版本号，而同一个二进制跑 `-e` 会静默 exit 13。验证运行时**必须**用一个真的求值表达式。
- **`.node` 文件放在 app data 目录里大概率 dlopen 不了**（linker namespace 只认系统库和 APK 自己的 `nativeLibraryDir`）。
- **Go 的 `os/exec` 会对 `Cmd.Env` 去重并保留最后一个同名项**——`append(os.Environ(), "X=...")` 会**覆盖**继承来的值，不是追加。想要"继承优先"必须显式判断。

### 5.2 感知

- **熄屏是静默失败**：熄屏时 `screencap` 交的还是**最后一帧**（读到的是一个已经不在的界面），而注入的触摸**唤不醒屏**（点进空气里），**两个都不报错**。所以观察结果必须带屏状态。
- **截图必须同时按像素和字节两个预算缩**。只按像素缩不够：一整屏游戏画面在较小尺寸下仍可能超过字节预算 → 需要重新编码 → 若设备上没有编码器 → **整个请求变成传输错误，重试耗尽后本轮失败，而那张图留在上下文里，之后每轮都再失败一次**。
- **`getWindows()` 只返回默认屏**，虚拟屏必须用 `getWindowsOnAllDisplays()`（API 30+）。只看前者会误判"读不到虚拟屏"，然后去写贵一个量级的方案。
- **引擎自绘的界面不是空树而是"没用的树"**（可能只有一个全屏 `SurfaceView`）。判据应该是"有没有值得动手的节点"，不是"树是否为空"。
- **加固应用可能压制无障碍节点**，但"绑上一个真实的、能被系统绑定的无障碍服务"往往就能读到。注意：**只设 `accessibility_enabled` 布尔值没用**，必须让服务真正被绑定。
- **`screencap -d` 要 compositor 的 64 位 display id，不是逻辑 displayId**，只能按屏名从 `dumpsys SurfaceFlinger --display-id` 里找；而且它是无符号 64 位，**别进有符号整数**。
- **屏幕尺寸变化后，第一张截图可能是变化前那一帧**。

### 5.3 输入注入

- **触摸要排队**：手比跨进程快，同步注入会让 `move` 超过它所属的 `down` 被平台丢掉。
- **swipe 要分帧**：一批同毫秒的 `move` 在平台看来是"跳"，分帧读输入的应用（Unity 那类）会把"按下又抬起"当成**一次点击**。每一步至少睡一帧（16ms）。
- **按住时长是参数不是布尔**，且要有上限：8 秒的电源键在很多机器上是硬重启，不该有一个 `long` 随手就能碰到。
- **键传名字不传编号**：编号不认识就是**另一个键**（5 是打电话，26 是电源键）。
- **`am` / `input` 以 `com.android.shell` 自居**，app uid 调用一律被拒（`INJECT_EVENTS`）。所以启动应用、按键这类操作必须走特权进程。
- **真手指与注入事件可以区分**：注入的事件**不进 `/dev/input`**（注入口在 input reader 之后）。所以读触摸屏的 evdev 节点就能检测"人是否正在操作"——这是做安全刹车的地基。

### 5.4 系统集成

- **包名要先解析成组件再起**（`cmd package resolve-activity --brief -c LAUNCHER <pkg>` → `am start -n <component>`），因为 `am start -p` 带 `MATCH_DEFAULT_ONLY`，而 Flutter / Unity 的 manifest 不写 `CATEGORY_DEFAULT`。
- **`Settings.Secure` 在特权进程里走不通**（`app_process` 没有 `IApplicationThread`）。正解是 `ProcessBuilder("/system/bin/settings", ...)`。写入必须**读出来改**（设备上还有别人的设置），写完**读回来核对**。
- **侧载安装的应用**（`installerPackageName=null`）在 Android 13 起**不许开无障碍**，那道闸是一个 app op。
- **每次 `adb install -r` 都会把应用踢出 `enabled_accessibility_services`**。
- **`am start` 到非默认屏**要特权；`ActivityOptions.setLaunchDisplayId` 那条路会撞后台启动限制（BAL）。
- **`cmd activity display move-stack` 在新版 AOSP 里倾向被 `move-task` 取代**。**未验证**：HyperOS Android 16 上哪个可用。

### 5.5 文件系统

- **`/sdcard` 是 FUSE**，不是真 POSIX 文件系统：
  - **没有 inotify**，原生 `fs.watch` 不工作（只能降级为轮询）
  - symlink / hardlink 受限，`chmod` 语义不完整，`stat` 里的权限位不可信
  - 随机小 I/O 慢，大量小文件（比如 `node_modules`）会很痛
- **Android 11+ `/sdcard/Android/data/<pkg>/`** 别的 app 与 adb 都访问不到 → 工作区要用顶层目录（如 `/sdcard/<name>/`）。

---

## 6. 风险登记册

| # | 风险 | 概率 | 影响 | 缓解 | 触发信号 |
|---|---|---|---|---|---|
| R1 | HyperOS 3 杀后台，服务失联 | **高** | 高 | §3.1 全套保活设置 | 锁屏 30 分钟后服务无响应 |
| R2 | LSPosed 在 HyperOS 3/A16 崩溃 | 中高 | 高 | 用活跃维护分支的最新版 | Hook 不生效、系统 UI 异常 |
| R3 | 本地服务暴露（绑 0.0.0.0 / 无鉴权 / 命令端点） | 中 | **致命** | §4.1 + §4.2 三条硬约束 | `netstat` 显示 `0.0.0.0` 而非 `127.0.0.1` |
| R4 | 屏幕尺寸/DPI 探测失败后静默用错值 | 中高 | 中高 | 探测失败就**报错**，不要兜底默认值 | 坐标整体偏移、点击错位 |
| R5 | 加固应用树为空 | 中 | 中 | 确保绑定了真实无障碍服务；仍留截图兜底 | 读树返回 0 节点 |
| R6 | 熄屏/画面静止时读到旧帧 | 中高 | 中 | 观察结果带屏状态与帧时间戳 | 截图内容不随时间变化 |
| R7 | 模型拿到命令执行能力后造成破坏 | 低 | **致命** | §4.3 能力分级；先备份 | 出现不可逆的命令 |
| R8 | 模块与 HyperOS OTA 冲突 | 中 | 中 | OTA 前卸载模块 | 系统更新后异常 |
| R9 | 单设备验证，未覆盖的 ROM 差异 | **高** | 中 | 分阶段、留回滚点、准备好自己改 | 遇到未覆盖的场景 |

---

## 7. 待真机验证清单

1. **屏幕尺寸/DPI 探测**：`wm size` / `wm density` 在 HyperOS 上是否保留英文标签（§3.6）
2. **无障碍服务可用性**：设备上是否存在一个能被真实绑定的无障碍服务（§5.2）
3. **LSPosed 分支与版本**：是否命中已知崩溃；补丁级别（§3.3）
4. **KernelSU「默认卸载模块」**：是否默认开启（§3.3）
5. **`cmd activity display move-stack`** 在 HyperOS A16 上是否还存在（§5.4）
6. **HyperOS 是否允许从 root 域 `settings put secure enabled_accessibility_services`**，以及会不会被自动回滚（§5.4）
7. **`dumpsys SurfaceFlinger --display-id` 的输出格式**（§5.2）
8. **`os.cpus().length` 是否为 0**（§5.1）
9. **TLS 与 CA 证书**：设好 `OPENSSL_CONF` 后能否完成握手（§5.1）
10. **`/sdcard` 上轮询的实际开销**（§5.5）

---

## 附录：命令速查

```sh
# 设备信息
adb shell getprop ro.build.version.release
adb shell getprop ro.build.version.security_patch
adb shell getprop ro.mi.os.version.name
adb shell getprop ro.product.cpu.abi
adb shell uname -r

# 屏幕
adb shell wm size
adb shell wm density
adb shell dumpsys SurfaceFlinger --display-id

# 无障碍
adb shell settings get secure enabled_accessibility_services
adb shell settings get secure accessibility_enabled

# 服务暴露面核查
adb shell su -c 'netstat -tlnp'
adb forward tcp:<port> tcp:<port>

# 安装兜底
adb push x.apk /data/local/tmp/x.apk
adb shell "su -c 'pm install -r /data/local/tmp/x.apk'"

# 保活设置原值（改前读、改后写回）
adb shell settings get global stay_on_while_plugged_in

# 跨 user（应用双开）
adb shell pm list users
adb shell pm list packages --user 999
```
