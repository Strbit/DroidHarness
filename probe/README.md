# DSH Android Runtime Probe

在真机上回答一个问题：**DSH 能不能在这台手机上跑起来**。

它**不启动 DSH**，只测 DSH 依赖的那些底层能力。目的是把"能不能跑"这件事和"写控制层"解耦——先用最小代价把地基验证掉，再动手写工具。

- 适用范围：已 root 的 **arm64-v8a** 安卓设备（KernelSU / Magisk / APatch）
- 测试环境：Redmi K90 Pro Max · HyperOS 3 / Android 16 · KernelSU（目前只在这一台上验过）
- 形态：**KernelSU 模块**（不是 APK，也不是 Termux）
- 手机端**不需要装 Termux**：Node 运行时在 PC 上从 Termux 的 `.deb` 解出来，打进模块里

---

## 为什么是模块，不是 APK

| APK 必须处理的 | KSU 模块 |
|---|---|
| **W^X**：`targetSdk>=29` 不能 exec data 目录的文件 → 二进制得伪装成 `lib*.so` 塞 `jniLibs/` | **不适用**，模块脚本本来就从 `/data/adb/modules/` 执行 |
| **AGP 静默丢掉带点的 `.so` 名** → 必须 `patchelf --set-soname` 全量归一 | **没有 AGP**，文件原样放盘上 |
| 281 MB host 树打进 assets，首启解压 3 万个文件 | 直接落盘 |
| 要写 Kotlin + Compose 界面 | 不需要，界面是 DSH 自己的 Web GUI |
| 前台服务保活 | `service.sh` 开机自启，跑在 root |

**平台依据**：`/data/adb/modules/` 下的文件由 root 域的模块脚本执行，这是 KSU/Magisk 模块的既有行为——模块里放二进制并执行是常规做法。

---

## 三步跑完

### 1. 在 PC 上取运行时

```powershell
cd dsh-android-probe
node tools\fetch-runtime.mjs --list          # 先看会下载什么
node tools\fetch-runtime.mjs --with-koffi    # 真下载 + 解包到 module\usr\
```

它做的事：取 Termux 的 `Packages` 索引 → 递归解析 `nodejs` / `bash` / `ripgrep` 的依赖闭包 → 下载 `.deb` → 解析 `ar` → 解 `data.tar.xz` → 自己解内层 tar。

**不需要 `ar` / `tar` / `zstd`** —— `ar` 解析和 tar 解包都是脚本自己实现的（原因见下）。
**但 xz 需要外部帮忙**：Termux 的 `.deb` 实测用的是 `data.tar.xz`，而 Node 的 `zlib` 没有 xz。脚本按顺序找：

1. `XZ_BIN` 环境变量指向的 xz 可执行文件
2. `PATH` 里的 `xz`
3. **Python 3**（用它标准库里的 `lzma`）—— Windows 上最可能现成的东西

### 为什么不调用系统 tar

Windows 上的 `tar` 有三个坑，全都实测踩到了：

| 坑 | 现象 |
|---|---|
| GNU tar 把 `C:\...` 的冒号当远程主机 | `tar: Cannot connect to C: resolve failed` |
| Git 自带的 MSYS tar 二次转义参数里的反斜杠 | `tar: C\:\\Users\\...: Cannot open` |
| 非管理员建不了符号链接 | 大量 `Cannot create symlink` |

tar 格式本身很简单（512 字节头 + 数据块，八进制长度），所以脚本**自己解**，一次消掉三个坑，而且符号链接能明确退化成"拷一份目标"。

### 实测结果（PC 侧已验证）

```
Termux nodejs  26.4.0-1  →  usr/bin/node   49,715,528 bytes  ELF64 AArch64 ✓
Termux bash     5.3.20   →  usr/bin/bash      880,416 bytes  ELF64 AArch64 ✓
Termux ripgrep 15.2.0    →  usr/bin/rg      4,868,920 bytes  ELF64 AArch64 ✓
依赖闭包 17 个包 / 27.8 MiB  →  usr/lib 下 24 个共享库
裁剪开发文件 (include / man / doc / pkgconfig / cmake)   省下 17.0 MiB
符号链接改为清单 (18 条)                                  省下约 88 MiB 重复内容
module/ 最终约 106 MiB   →   打包后 zip 38.9 MiB (219 条目)
```

注意 Termux 的 Node 是 **26.4.0**，远高于 DSH 要求的 `>=22.19.0`。

**为什么还要装 bash 和 ripgrep**：安卓自带的是 mksh 而不是 bash，且没有 `rg`，而 harness 的 shell 工具需要 bash、grep / glob 工具需要 `rg`。真机探针显示只装 `nodejs` 时 `SHELL` 会退回 `/system/bin/sh`。

### 要排除 Termux app 专用的包装器

加 bash 后依赖闭包会从 10 个包涨到 **55 个**，因为 `termux-tools` 拉进了 coreutils / curl / findutils / gawk / grep / sed / tar / util-linux。

**但其中 `termux-am` 会往 `$PREFIX/bin/am` 放一个只跟 Termux app 通信的包装器**，而 `$PREFIX/bin` 在 PATH 里靠前 —— 我们的 `am` 调用会打到它而不是 `/system/bin/am`。`termux-exec` 还会改 exec 行为（LD_PRELOAD）。

所以脚本排除了 `termux-am` / `termux-am-socket` / `termux-exec` / `termux-tools`，闭包降到 **17 个包**，且没有 shadow 风险。

### 裁剪 npm 包：按引用扫描，不按目录名猜

曾把 `koffi` 的 `src/` 当成开发目录删掉 —— 而 `koffi/index.cjs` 就是
`module.exports = require("./src/koffi/index.cjs")`，`src/` 是**运行时必需**的。
结果设备上 `require("koffi")` 直接报 `MODULE_NOT_FOUND`。

根因不是"列表里漏了 `src`"，而是**按目录名猜哪些是开发文件**这个做法本身不成立。现在改成**引用扫描**：删之前先扫包里所有 JS，有 `require` / `import` 引用就保留，并在输出里说明原因：

```
裁剪 koffi: 省 531 KiB
  保留 src <- index.cjs  (有代码引用, 删了会坏)
✓ koffi 加载器入口在位 (src/koffi/index.cjs)
```

另外对 koffi 加了显式的加载器入口校验 —— 布局坏了在 PC 上就报出来，不用等真机才发现。

### 符号链接为什么要走清单

Termux 的 `.so` 是典型的 `libfoo.so -> libfoo.so.78.3` 三连。PC 上非管理员建不了符号链接，如果退化成"拷一份目标"，zip 里就会塞进几十 MB 重复内容——实测光 `libicudata` 一个就是 33 MB × 3 = 99 MB。

所以脚本**不物化**它们，只写一份清单 `usr/.dsh-symlinks`（格式：`相对 prefix 的路径<TAB>目标`），由 `customize.sh` 在手机上用 `ln -s` 真正建出来：

```
lib/libicudata.so	libicudata.so.78.3
lib/libicudata.so.78	libicudata.so.78.3
lib/libssl.so	libssl.so.3
...
```

被裁掉的目录里的链接会自动剔除（否则 `relink` 会把删掉的目录又建出来，挂一堆悬空链接）。

> **这是本模块唯一一处"PC 上不完整、必须在手机上补全"的地方。** 如果 `relink` 失败，`usr/bin/node` 会因为找不到 ICU 库而起不来——所以 `customize.sh` 会明确报出建了几条、失败几条。

`--with-koffi` 会顺便从 npm 取 `koffi` + `@koromix/koffi-android-arm64` 放进 `module/node_modules/`，好让探针能真的测一次原生模块加载。**已核实这个 Android 预编译包是真货**：`@koromix/koffi-android-arm64/android_arm64/koffi.node`，1.36 MB。

> **体积提示**：`usr/lib` 里有若干 Termux 内部自指的符号链接（`libcrypto.so -> libcrypto.so.3`、`libicudata.so -> libicudata.so.78` 等）。在 PC 上它们被物化成副本，因此有约 38 MiB 重复。想省这点空间的话，可以把链接清单记下来，让 `customize.sh` 在手机上重建真链接。

### 2. 打包

```powershell
powershell -ExecutionPolicy Bypass -File tools\build-module.ps1
```

产物在 `dist\dsh_android_probe-v0.1.0.zip`。

### 3. 刷入并看日志

KernelSU 管理器 → 模块 → 从本地安装 → 选这个 zip。

**安装过程中探针就会在安装日志里跑完**，结果直接显示。重启后再看一次开机路径：

```sh
adb shell cat /data/local/tmp/dsh-probe/boot-probe.log
```

---

## 怎么看结果

探针每行以 `[ OK ]` / `[FAIL]` / `[WARN]` / `[SKIP]` 开头。**不是所有 FAIL 都是坏消息**——下面逐个说。

### 决定性的几项

| 观测项 | 什么结果算好 | 不达标怎么办 |
|---|---|---|
| **测试 A：从模块目录 exec** | `[ OK ]` | 见下 |
| **`platform`** | `android` | 若不是 `android`，npm 不会去取 `@koromix/koffi-android-arm64`。要手工放平台包，或设 `npm_config_platform=android` / `npm_config_arch=arm64` |
| **`modules (ABI)`** | 记下来 | 这个数字决定以后能装哪些预编译原生模块 |
| **`OPENSSL_CONF`** | 已设且**可读** | 这是 Termux 版 Node 在安卓上最经典的**静默**失败：不设会让 Node 在 bootstrap 阶段 `exit 13` 且什么都不打印 |
| **TLS 握手** | `[ OK ]` | 若报证书错误，试设 `SSL_CERT_DIR=/system/etc/security/cacerts`；若报超时，那是网络问题不是 TLS 问题 |
| **`spawn /system/bin/id`** | `[ OK ]` | 这是 DSH 的 bash 工具的地基。失败的话整个方案要重新想 |
| **`os.cpus().length`** | > 0 | 若为 0，任何按 CPU 数并行的地方都要能容忍 0（APK 沙箱环境出现过返回 0 的情况） |

### 两个 exec 测试的意义

- **A 通过** → 运行时可以留在 `/data/adb/modules/` 里，正式模块就这么放，最省事。
- **A 失败、B 通过** → SELinux 不让模块 domain exec 那个路径。正式模块就把运行时放 `/data/local/tmp/`（或换 SELinux 上下文）。**这是可行的，只是布局不同。**
- **两个都失败** → 问题在运行时本身（缺库/缺依赖），不是 SELinux。看 `ldd` 式的缺失提示，或检查 `lib/` 是否解全。

### 原生模块那一节：预期就有红的

| 模块 | 预期 | 说明 |
|---|---|---|
| `koffi` | **应该 OK**（跑了 `--with-koffi` 的话） | 有官方 `@koromix/koffi-android-arm64`。它是 DSH 在 Linux 上做 `execve` 引导用的 |
| `node-pty` | 大概 `[SKIP]` 或 FAIL | 没有 android 预编译，要 `node-gyp` 现编。DSH 设计上容忍 |
| `sharp` | 大概率 FAIL | 官方没有 android 变体。影响图片处理，不影响核心 |
| `@deepseek-ai/node-addon-system` | FAIL | 这个包**只发源码、不发 `.node`、也没有构建脚本**。DSH 设计上降级（无跨进程排他 + probe unusable） |
| `node-addon-require-builtin` | **大概率 FAIL —— 这是唯一的硬依赖** | 只有 `node-addon-require-builtin-win32-x64-msvc` 子包。见下 |

### 关于 `node-addon-require-builtin`（目前唯一已知的硬依赖）

DSH 里有两处用到它，处理方式**完全不同**：

**`cordis-plugin-loader` —— 有保护**（`lib/index.js:9`）：

```js
function requireInternal(id) {
    const require = createRequire(import.meta.url);
    if (process.execArgv.includes("--expose-internals")) try { return require(id); } catch {}
    try { return require("node-addon-require-builtin").requireBuiltin(id); } catch {}
}
```

两条路都 try/catch，失败返回 `undefined`，调用方走"documented no-internals path"。**所以加 `--expose-internals` 就能绕开。**

**`dsh-app-boot` —— 无保护**（`lib/index.js:1573`，`lib/worker/profile-resolution-bootstrap.js:462`）：

```js
function internalModules() {
    const addon = createRequire(import.meta.url)("node-addon-require-builtin");
    ...
```

**没有 try/catch，也不看 `--expose-internals`。** 在 Android 上这个 `require` 会直接抛。

探针会分别用**带**和**不带** `--expose-internals` 跑两次，对比输出，就是为了确定这一点的实际影响。

> 如果确认它在 `dsh web` 的启动路径上，三个选择：给那个函数加 `--expose-internals` 分支 / 给 Android 编这个 addon / 绕开 profile-resolution 那条路。**这是整个方案里唯一可能需要给 DSH 打补丁的地方。**

---

## 目录结构

```
dsh-android-probe/
├── module/                    # 会被打进 zip 的内容 (module.prop 在根部)
│   ├── module.prop
│   ├── customize.sh           # 安装时跑探针, 结果直接进安装日志
│   ├── service.sh             # 开机再跑一次, 写 boot-probe.log
│   ├── probe/probe.mjs        # 探针本体
│   ├── usr/                   # Node 运行时 (fetch-runtime.mjs 填, 默认不进 git)
│   └── node_modules/          # --with-koffi 填, 让探针能测原生模块
├── tools/
│   ├── fetch-runtime.mjs      # PC 侧: 解 Termux .deb 得到 bionic Node
│   └── build-module.ps1       # PC 侧: 打包
└── README.md
```

## 已知约束

- **PC 侧已实测通过**（索引 URL、依赖解析、`ar` 解析、`data.tar.xz` 解压、aarch64 二进制校验、打包结构），**但手机侧一次都没跑过**——那正是这个模块要去回答的问题。
- **需要 Python 3 或 xz** 来解 `data.tar.xz`。两样都没有时脚本会明确报错并列出三个选项。
- **`--debs` 离线模式**：自己下载 `.deb` 丢进一个目录，脚本只负责解，不联网。
- **`--out` 的语义**是"prefix 的父目录"：剥掉 `data/data/com.termux/files` 之后文件按 `usr/...` 落进去，所以默认传模块根目录，最终得到 `module/usr/bin/node`。
- **剥层数是自动探测的**（扫 tar 头找 `usr` 在第几段，Termux 的答案是 4），不写死。
- **符号链接在 PC 上不建**，只记进 `usr/.dsh-symlinks`（见上）。清单里可能有指向 `/system/bin/sh` 这类系统绝对路径的条目——那些在手机上才是对的，PC 上无法验证。
- **打包脚本必须保持 UTF-8 BOM**。PowerShell 5.1 会把无 BOM 的 UTF-8 当 ANSI 读，中文字符串会被拆坏导致语法错误。别用会剥掉 BOM 的编辑器改它。
- **`module.prop` 里的 `author`** 是占位符 `you`，自己改。
- **探针退出码恒为 0**——它是探针，失败本身就是要观测的结果。

## 下一步（探针之后）

1. 全绿 → 写正式的 DSH 模块：`service.sh` 里 `dsh web` 绑 **127.0.0.1**，PC 侧 `adb forward tcp:3080 tcp:3080`。
2. `node-addon-require-builtin` 是唯一红的 → 给 `dsh-app-boot` 打那一处补丁。
3. 模块目录 exec 失败 → 运行时改放 `/data/local/tmp/`。
4. `sharp` 红 → 接受图片处理不可用，或自己给 Android 编 libvips + sharp。
5. 地基通过后，再开始写自研的手机端控制层（见 [mobile-control-layer-design.md](../docs/mobile-control-layer-design.md)）。
