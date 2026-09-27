# DSH on Android — KernelSU / Magisk 模块

把 DeepSeek Harness 跑在**已 root 的 arm64 安卓设备**上，以 KernelSU / Magisk 模块形态分发。

- **适用范围**：已 root 的 **arm64-v8a** 安卓设备。KernelSU / Magisk / APatch 均可（模块格式与 Magisk 兼容）
- **测试环境**：只在 **Redmi K90 Pro Max · HyperOS 3 / Android 16 · KernelSU** 上验过；其他机型与 ROM 未验证
- **不需要 Termux**：运行时在 PC 上从 Termux 的 `.deb` 解出来，打进模块
- **只绑 `127.0.0.1`**：这不是保守，是设计约束（见下）

## 模块里有什么

```
module/
├── module.prop
├── customize.sh              安装时: 建符号链接 + 冒烟测试
├── service.sh                开机: 拉起 dsh web (带监督与熔断)
├── bin/dshctl                控制脚本 start/stop/status/log/forward
├── usr/                      运行时 (aarch64 Node 26.4.0 + bash + ripgrep + npm + pnpm + 依赖库)
│   └── share/doc/<包名>/copyright        各第三方组件的许可证全文
└── app/                      DSH 应用树 (495 个 npm 包)
    └── node_modules/
        ├── @deepseek-ai/dsh/lib/bin.js     入口
        ├── @koromix/koffi-android-arm64/   原生模块的平台预编译包
        └── node-addon-require-builtin/     ← 已被 JS 替身顶替, 见下
```

**为什么运行时里有 npm 和 pnpm**：DSH 的插件管理器**写死了调用 `pnpm`**（`execa("pnpm", ...)`），
没有它，GUI 的"添加插件"和 `dsh plugin add` 都会失败。

## 许可证

| 文件 | 覆盖 |
|---|---|
| [`../LICENSE`](../LICENSE)（Apache-2.0） | **只覆盖本项目自己写的代码** |
| [`../THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md) | **随包分发的第三方组件** —— 27 个运行时二进制 + 495 个 npm 包 |

运行时里有 **5 个受 GPL / LGPL 约束**（`bash`、`readline`、`git`、`less`、`libiconv`），
分发它们时提供对应源码是**义务**，清单里给了地址。许可证全文随包发在 `usr/share/doc/<包名>/copyright`
（这些文件**不被裁剪** —— 早期版本的裁剪逻辑删了它们，那是错的）。

---

## 构建

```powershell
cd D:\projects\DroidHarness

# 1. 取运行时 (aarch64 Node + bash + ripgrep + npm + pnpm)
node probe\tools\fetch-runtime.mjs --out dsh\module

# 2. 装 DSH 应用树并打补丁 (两个 shim 都会实测校验)
node dsh\tools\build-dsh-tree.mjs

# 3. 打包
node probe\tools\pack-module.mjs --module dsh\module
```

产物在 `dsh\dist\`。

### 为什么打包脚本是 Node 而不是 PowerShell

原来的 `build-module.ps1` 功能是对的，但慢得离谱：**28,074 个条目要 300–360 秒**。时间几乎全花在 PowerShell 的逐文件开销上（对象创建、流开关、.NET 互操作），而不是压缩 —— Deflate 本身能跑 20–50 MB/s，那版只有约 1 MB/s。它还多了一步完全不必要的 staging（用 `Copy-Item` 把 350 MiB 再拷一遍）。

`pack-module.mjs` 不做 staging 拷贝，用 Node 的 zlib（C 实现），异步 `deflateRaw` 走 libuv 线程池拿到并行。实测 **106 MiB / 219 条目 7.1 秒**。

**代价是体积大 5%**：.NET 的 Deflate 用的是 zlib-ng，压缩率确实比标准 zlib 好。实测同一个 `usr/bin/node`：

```
.NET (PowerShell)   15.244 MiB
Node zlib level 9   16.151 MiB
```

我试过 `memLevel:9` / `windowBits:15` / `Z_FILTERED`，**全都更差**（35.34 / 35.13 / 36.45 MiB vs L9 的 35.13）。所以这不是参数没调对，是实现的差别。

**5% 的体积换 15× 的速度是划算的**，而且真正的体积收益在裁剪 app 树（见"已知限制"）。`build-module.ps1` 保留着 —— 需要那 5% 时可以用它。

---

## 安装与使用

**装**：KernelSU 管理器 → 模块 → 从本地安装 → 选 zip。安装日志里会看到冒烟测试结果。

**重启后** `service.sh` 自动拉起。日志：

```sh
adb shell su -c 'cat /data/adb/dsh/logs/dsh.log'
```

**访问**（在 PC 上）：

```powershell
adb forward tcp:3080 tcp:3080
```

然后浏览器打开 `http://127.0.0.1:3080`。

**控制**：

```sh
adb shell su -c 'dshctl status'    # 在跑吗, 监听哪里
adb shell su -c 'dshctl log 60'    # 看日志
adb shell su -c 'dshctl restart'
adb shell su -c 'dshctl stop'
adb shell su -c 'dshctl forward'   # 打印 PC 侧该敲的命令
```

---

## 五个关键决定（都踩过）

### 1. `--ignore-scripts` 是必须的

`npm install` 的安装脚本在 **HOST**（Windows）上跑，但包是给 **TARGET**（android）装的。koffi 的 `install` 脚本会加载平台 `.node`——它拿到的是 android 的，在 Windows 上加载不了——于是回退到**从源码编译**，然后因为没有 CMake 而失败。

跳过脚本即可：平台预编译包已经由 `--os=android --cpu=arm64` 装好了。

> 另一个反例：**绝不能用 `--omit=optional`**。koffi 的平台预编译包正是 `optionalDependencies`，省掉它等于把 koffi 废掉。

### 2. `node-addon-require-builtin` 必须用 JS 替身顶替

原包的 `optionalDependencies` 里只有这些平台：

```
darwin-arm64  darwin-x64  linux-arm64-gnu  linux-x64-gnu
win32-arm64-msvc  win32-x64-msvc  win32-ia32-msvc
```

**没有 android**（`linux-arm64-gnu` 也救不了——Android 用 bionic，不是 glibc）。所以 npm 在 Android 上一个平台包都装不上，`require` 必然抛。

而 DSH 里有两处需要它：

| 位置 | 行为 |
|---|---|
| `cordis-plugin-loader` | 有 `--expose-internals` 分支且整体 try/catch，**本来就不会挂** |
| `dsh-app-boot` | **无保护**的 `createRequire(...)("node-addon-require-builtin")` ← 就是它必须顶替的原因 |

**替身的原理**：这个包唯一的能力是"把 Node 的 internal 模块 require 出来"，而 Node 自己就有这条路——启动时加 `--expose-internals`，`require("internal/...")` 直接可用。所以：

```js
function requireBuiltin(moduleId) { return require(moduleId); }
```

不需要任何原生代码。替身源码在 [`shim/node-addon-require-builtin.js`](shim/node-addon-require-builtin.js)，由 `build-dsh-tree.mjs` 在构建期覆盖到 `app/node_modules/node-addon-require-builtin/lib/index.js`。

**这一步是实测过的**，不是推断：

```
✓ shim 实测通过: shim-ok object function
· 不带旗标时: 需要 Node 以 --expose-internals 启动才能解析 "internal/..."   ← 可读的错误
```

`requireBuiltin("internal/modules/esm/loader")` 返回的对象确实带 `getOrInitializeCascadedLoader` 函数——正是 `dsh-app-boot` 需要的。

### 3. `node-addon-system/flock` 也要替身 —— 但这个是**语义降级**

这个是后来在真机上撞出来的，症状很直接：

```
本轮运行失败: flock is not supported on android-arm64
```

`dsh-session-persistence-jsonl` 的会话写入路径要给 `session.lock` 上一个非阻塞 `flock(2)`，用的是 `@deepseek-ai/node-addon-system` 的原生模块。而它的 `optionalDependencies` 里：

```
darwin-arm64  darwin-x64  linux-x64  linux-arm64
                              ← 没有 android
```

加载器第一句就按平台拒绝：

```js
if (platform !== 'linux' && platform !== 'darwin') throw ...
```

**注意：把 `platform` 骗成 `linux` 也没用** —— 它还会按 `report.header.glibcVersionRuntime` 在 glibc / musl 之间选，而 Android 用的是 bionic，两者都不是。

**这个锁是干什么的**：跨**进程**的会话写所有权互斥。两个 DSH 进程同时写同一个会话日志会撕裂它。锁在持有者的 fd 关闭时由内核释放（进程崩溃也一样），所以不会留死锁。读者不碰它。

**为什么可以降级**：**上游自己对单进程部署就是这么做的**。该文件自己的注释原文：

> The browser worker stubs the native flock entry to immediate success: it is single-process, so the in-process write claim already excludes every writer.

我们的部署同样是单进程 —— `service.sh` 是唯一拉起入口，带 pidfile 检查，拒绝启动第二个实例；进程内的写互斥由 `SessionWriteLease` 自己的状态保证，与 flock 无关。所以丢掉的**只有**"两个 DSH 进程之间的互斥"。

替身源码在 [`shim/node-addon-system-flock.js`](shim/node-addon-system-flock.js)，实测：

```
✓ flock shim 实测通过: flock-shim-ok js-shim-single-process
```

**这个假设什么时候会破**（同样写在 shim 文件顶部）：

- 你手动再跑一个 `dsh web`，而监督进程也在跑，且两者指向同一个 `DSH_HOME`
- 你把 `service.sh` 的 pidfile 检查去掉

那时可能出现会话日志撕裂。**真需要跨进程锁的话，正确做法是用 Android NDK 把本包自带的 `src/flock.c` 编成 android-arm64 的 `.node`**（源码是随包发的），而不是继续用替身。

### 4. 脚本的 shebang 写死了 Termux 路径，必须重写

**这条我一开始漏了，而且漏得很隐蔽：我只验证了 ELF 二进制"能跑"，没验证脚本。**

Termux 的包里，**脚本**文件的 shebang 写死了：

```
#!/data/data/com.termux/files/usr/bin/sh
```

ELF 二进制不读 shebang，所以它们没事；但脚本的表现是「**文件明明在，却报 No such file or directory**」—— `execve` 找不到解释器。

最阴的一例：`git-submodule` / `git-mergetool` 是 git 自带的 shell 脚本，在 `usr/libexec/git-core/` 下。git 找得到它们、但 execve 失败，于是**谎报**成：

```
git: 'submodule' is not a git command. See 'git --help'.
```

**这个错误信息会把排查方向带偏到「git 装得不全」。** 实际影响：`git clone --recurse-submodules`、`git submodule update`、`git mergetool`、`git filter-branch` 全部不可用。而且我加进运行时的 `npm` / `npx` / `wcurl` / `curl-config` **也是加了但不能用** —— 它们的入口 `npm-cli.js` 的 shebang 是 `#!/data/data/com.termux/files/usr/bin/env node`，而 **Android 上没有 `/usr/bin/env`**。

实测共 **70 个**文件，`fetch-runtime.mjs` 的 `rewriteShebangs()` 在构建期重写其中 48 个：

| 原 shebang | 个数 | 重写成 |
|---|---|---|
| `#!…/bin/sh` | 32 | `#!/system/bin/sh` |
| `#!…/bin/env node` | 12 | `#!/data/adb/modules/dsh_android/usr/bin/node` |
| `#!…/bin/env sh` | 2 | `#!/system/bin/sh` |
| `#!…/bin/bash` | 2 | `#!/data/adb/modules/dsh_android/usr/bin/bash` |
| `#!…/bin/env python3` | 14 | **删掉** —— 模块里没有 python |
| `#!…/bin/perl` | 7 | **删掉** —— 没有 perl |
| `#!…/bin/python` | 1 | **删掉** |

两个关键细节：

1. **必须写运行时路径 `/data/adb/modules/<id>/usr/...`，不是 `modules_update/...`** —— 安装期间在 `modules_update`，重启后就不在了。`id` 从 `module.prop` 读，不写死。
2. **只改文本脚本**：先判前两字节是不是 `#!`（ELF 首字节是 `\x7f`，天然排除），而且只换第一行、其余字节原样保留。

**那 22 个没解释器的**（python3 / perl / python）**直接删掉，不是留着改 shebang**：

改了也跑不了（模块里没有那些解释器），而**留着会给出误导性的错误** —— 比如 `git cvsserver` 报的是 `No such file or directory`，看起来像文件缺失，而不是「这个功能不支持」。留着只会浪费排查时间。

**代价（写在这里免得以后忘）**：下面这些功能在模块里彻底不可用 ——

| 功能 | 原因 |
|---|---|
| `node-gyp` 编译原生模块 | 需要 python3（本来在 bionic 上也没有工具链） |
| `git cvsserver` / `cvsexportcommit` / `cvsimport` / `archimport` | 需要 perl |
| `git send-email` | 需要 perl |
| `gitweb` | 需要 perl |
| `git p4` | 需要 python |

**被删的是这 22 个文件本身**，不是整个目录 —— 判断依据仍是「首行的 shebang 指向模块里没有的解释器」，不是目录名。

> 这条是**手机端 agent 实测出来的**，它给出的清单（70 个、按 shebang 分类）和我事后复核的结果完全一致。

---

## 工作区在 `/data/adb/dsh/workspace`，不在 `/sdcard`

**这是必须的，不是偏好。**

Android 的 `/sdcard` 是 **FUSE**，**不实现 `link(2)`**（实测 `ln a b` → `Function not implemented`）。而 DSH 的 `writeFileAtomic` 给「创建新文件」走的正是 `link()`（为了拿 no-replace 语义）：

```js
// @deepseek-ai/dsh-fs-local
if (createIfAbsent !== void 0) try {
    await linkFile(tempPath, absolutePath);      // ← 创建新文件
} catch (error) {
    await throwGuardedCreateFailure(error, ...); // ← 上游没有降级
}
...
else await rename(tempPath, absolutePath);       // ← 覆盖已有文件（FUSE 支持）
```

于是工作区在 `/sdcard` 上时：

```
ENOSYS: function not implemented, link
  '.../.foo.md.<pid>.<uuid>.tmpdir/foo.md.tmp' -> '.../foo.md'
```

**agent 无法新建任何文件，只能改已经存在的。** 而工作区是主路径，所以这会让 harness 基本不可用。

实测对照（同一台设备）：

| 位置 | 文件系统 | `link()` |
|---|---|---|
| `/sdcard/DroidHarness` | `fuse` | ✗ `Function not implemented` |
| `/data/adb/dsh/workspace` | ext4 | ✓ |

**代价**：工作区变成 root-only，普通文件管理器看不到，要用 root 管理器（或 `adb pull`）。

**另外构建期还给 `dsh-fs-local` 打了补丁**（`dsh/tools/build-dsh-tree.mjs` 的 `TEXT_PATCHES`），让它在 `link()` 失败时降级成 `copyFile` + `COPYFILE_EXCL` —— 同样是「目标已存在就 EEXIST」的原子语义，不需要硬链接，**这样即使用户自己把工作区选到 `/sdcard` 也能用**（代价是多一次拷贝）。

> **不能降级成 `rename()`** —— 那会丢掉 no-replace 语义，两个并发创建者会互相覆盖，而调用方的 `throwGuardedCreateFailure` 那套守卫就是为它写的。
>
> 补丁带**锚点校验**：找不到锚点、或锚点不唯一，就直接 die。宁可构建失败，也不要静默失效 —— 那种 bug 只在真机上、只在 agent 想写文件时才暴露。

---

## 插件安装（pnpm）

DSH 的插件管理器**把参数原样转发给 `pnpm` 执行**，所以运行时里必须有 pnpm。本模块带的是 **NDK 编的 Android ELF**（pnpm 12.7.0，46.8 MiB；`ELF 64-bit LSB arm64, dynamic (/system/bin/linker64)` —— 不是 Termux 那个写死路径的构建）。

它在 Android 上有两个坑，`service.sh` 已经处理了第一个：

### 1. store 不能落在 `/sdcard`

pnpm 靠**硬链接**把 store 里的文件链进 `node_modules`。而 `/sdcard` 是 FUSE/sdcardfs，**不支持硬链接** —— 跨文件系统会直接报：

```
Cross-device link not permitted
```

pnpm 的 store 默认在 `$HOME` 下。而本模块的 `HOME` 是工作区 —— 它**曾经**是 `/sdcard/DroidHarness`（FUSE），于是 pnpm 报：

```
ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK
  lock directory must be a real directory owned by the current user
  /sdcard/DroidHarness/.cache/pnpm-store-operation-locks-0
```

**手机端 agent 实测：`npm_config_cache_dir` / `npm_config_store_dir` / `npm_config_state_dir` / `XDG_CACHE_HOME` / `--cache-dir` / `--config.cacheDir` / `--store-dir` 全都挪不动它** —— pnpm 根本不读那几个变量。**唯一有效的是给它一个单独的 `HOME`。**

所以构建期生成了一层启动器：

```
usr/bin/pnpm-bin   ← 原 ELF 改名 (46.8 MiB)
usr/bin/pnpm       ← #!/system/bin/sh
                      export HOME="$DSH_HOME_DIR"
                      exec "${0%/*}/pnpm-bin" "$@"
```

只改 pnpm 子进程的 `HOME`，DSH 自己的 `HOME` 不动（GUI 的工作区选择器从它起步）。这样不管工作区被选到哪，pnpm 的 store 都稳在 `/data`。

> 这个坑是**手机端 agent 实测出来的**，不是我推的。
>
> 另外：`service.sh` 里还留着三行 `npm_config_*`，那对 **pnpm 是 no-op**（留着是因为 **npm** 会读它们）。我一开始以为那三行修好了问题 —— 那是错的。

### 2. JS 版 pnpm 的 shebang（本模块不受影响）

npm 上发布的 pnpm 的 `bin/pnpm.mjs` shebang 是 `#!/usr/bin/env node`，而 **Android 上没有 `/usr/bin/env`**，直接 exec 会失败 —— 必须包一层启动器显式用 node 拉起。

**本模块用的是 NDK 编的 Android ELF（不读 shebang），所以不受这条影响。** 但如果你把 `usr/bin/pnpm` 换成 npm 上的 pnpm JS 包，就要注意。

### 装插件

Web GUI → **设置 → 插件 → 添加插件**，填 npm 包名（如 `dsh-web-mobile`）。装完刷新页面即可（客户端插件走 HMR，不用重启 DSH）。

---

## 为什么只绑 `127.0.0.1`

有一类设计错误的后果特别严重，构成是三个决定叠加：**绑 `0.0.0.0` + 无鉴权 + 提供任意命令执行**。三者叠加等于把设备 root 权限挂在网络上。

而且还有第二条更隐蔽的路径：如果端点不校验请求类型、而响应又带通配 CORS 头，**手机上浏览器打开的任意网页**也能造成命令执行——**这条路不受防火墙限制**（本机回环流量不受 iptables 管）。

DSH 本身就是一个能跑 shell 的 agent，所以这里把第一条钉死：**只绑回环**。要远程访问就走 `adb forward` 或 SSH 隧道——那是有意为之、有明确边界的。

---

## 兼容性

| 项 | 状态 |
|---|---|
| Root 管理器 | **KernelSU 已实测**。Magisk / APatch 应该也能装（模块格式兼容），但**未验证** |
| ABI | **只做了 arm64-v8a**。其他 ABI 需要另配运行时（`fetch-runtime.mjs --arch`） |
| Android 版本 | 只在 **Android 16** 上验过。运行时来自 Termux 的包，理论支持范围跟它一致 |
| ROM | 只在 **HyperOS 3** 上验过。**模块不依赖任何 OEM 特性**；HyperOS / MIUI 特有的注意事项见[平台笔记](../docs/android-agent-harness-plan.md) 第 3 章（如果你的 ROM 不是这一系，那章可以整章跳过） |
| 屏幕 | 不依赖具体分辨率 / DPI（运行时探测） |
| SoC | 不依赖。唯一沾边的是端侧 OCR 的 NPU 支持，而那个功能现在没做 |

## 已知限制

- **首次安装较慢**：14,228 个文件要解压。安装脚本**故意不对 `app/` 做 `set_perm_recursive`**（那是逐个 shell 调用，会慢到不可接受），改用一条 `chmod -R 0755`。
- **`node-pty` 没有原生模块**：安装脚本被跳过（它在 HOST 上跑，而包是给 TARGET 的），所以持久终端不可用。DSH 设计上容忍。
- **`sharp` 没有 android 变体**：图片处理可能不可用。
- **这些功能没有**（构建期已**删掉入口**，不是留着报错 —— 见上文 §4）：`node-gyp` 编译原生模块、`git cvsserver` / `git cvsimport` / `git cvsexportcommit` / `git archimport` / `git send-email` / `git p4` / `gitweb`。原因是模块里没有 python3 / perl。
- **构建产物不进 git**：`dsh/module/{app,usr}/` 由上面两条命令重建。

## 裁剪

`app/` 已经裁过一轮：**224.6 MiB / 25,715 文件 → 111.8 MiB / 12,008 文件**。

裁掉的是运行期用不到的东西：source map 44 MiB、`.d.ts` 类型声明 33 MiB、Windows 调试符号 20 MiB、Markdown 与测试目录 16 MiB。

```sh
node dsh/tools/build-dsh-tree.mjs --skip-install --prune --dry-run   # 先看会删什么
node dsh/tools/build-dsh-tree.mjs --skip-install --prune             # 真删
```

按**引用扫描**判断，不是按目录名猜。这次它拦住了一个真会坏事的删除：`yaml/dist/doc/` 名字像文档，实际是 `Document.js` 这些**运行时代码**。同类教训还有 koffi 的 `src/`。

## 体积

```
usr/   183.9 MiB /  2,216 文件     运行时 (node 47.4 + pnpm 46.8 + libicudata 33.1 + ...)
app/   111.8 MiB / 12,008 文件     DSH 应用树 (已裁剪)
                               ─────────────
       295.7 MiB / 14,228 文件
zip    113.3 MiB                   (Node 打包器, 18.7 秒)
```

**`pnpm` 一个文件就 46.8 MiB** —— 它是静态链接的 Rust 二进制，而且**已经 strip 过**（`.debug_*` 与 `.symtab` 都是 0，`.text` 占 36 MiB），没得压。想再瘦身只有两条路，都要先在真机上验证插件能装上：换成 npm 上的 pnpm JS 包（省约 33 MiB，未验证能否在 bionic 上跑）、或不要 `git`（省约 17 MiB，代价是 `dsh plugin add github:...` 不可用）。

## 已实测

在测试机（REDMI K90 Pro Max · HyperOS 3 / Android 16 · KernelSU）上：

```
模块目录 exec: OK   (u:r:ksu:s0 + SELinux enforcing)
Node 26.4.0 / ABI 147 / platform=android / arch=arm64
spawn / TLS / 系统 CA 库  全过
shim 实测通过: shim-ok object function
dsh web 已拉起, 监听 127.0.0.1:3080, Web GUI 可正常访问
```

**两个 shim 都在真机上验过**（用手机自己的 Node 跑真实 import，不是在 PC 上推断）：

```
$ node --input-type=module -e 'import {tryLockExclusive,FLOCK_IMPLEMENTATION} from "@deepseek-ai/node-addon-system/flock"; ...'
flock-ok js-shim-single-process
```

**配置 API 后对话能正常跑完** —— 2026-09-26 真机确认，修掉了之前那句
`本轮运行失败: flock is not supported on android-arm64`。

### 验证时踩的坑一：`adb shell su` 不一定存在

这台设备上 `su` 不在 `adb shell` 的 PATH 里（KernelSU 默认不往 PATH 放 `su`）：

```
$ adb shell 'su -c id'
/system/bin/sh: su: inaccessible or not found
```

**要在 KernelSU 管理器里给 `com.android.shell`（uid 2000）授权 root，`adb shell su` 才能用。** 在那之前所有 `adb shell "su -c '...'"` 形式的命令都会失败 —— 而失败信息是 "not found"，很容易被误读成"没 root"。

### 验证时踩的坑二：别拿端口号猜服务

PC 的 `127.0.0.1:3080` 是**电脑端自己的 DSH**。手机端要另开一个转发端口（本项目用 `13080`）：

```powershell
adb forward tcp=13080 tcp=3080
adb forward --list          # ← 先看映射表, 别拿返回值猜是谁
```

不带 token 访问会得到 **401**（DSH 的 token 鉴权）—— 那是**转发通了**的证据，不是错误。token 每次重启 DSH 都会变，取 `dshctl log` 里最新那条。

### 验证时踩的坑三：Windows 上带冒号的 deb 文件名

见 `probe/tools/fetch-runtime.mjs` 里 `safeCacheName()` 的注释。Debian 的 epoch 版本号形如 `1:3.6.3`，会原样出现在索引的 `Filename` 里，而 Windows 把 `:` 当 NTFS 备用数据流分隔符 —— 于是 `openssl` 与 `ca-certificates` 被静默跳过，**TLS 彻底坏掉且没有任何报错**。

## 与 `probe/` 的关系

`probe/` 是**地基验证模块**，它回答了"KernelSU 模块里能不能跑 bionic Node"这个问题：

```
模块目录 exec: OK (u:r:ksu:s0 + enforcing)
Node 26.4.0 / ABI 147 / platform=android / arch=arm64
spawn / TLS / CA 全过
```

结论通过后才有这个正式模块。`probe/` 保留着，以后排查平台问题还能用。

平台事实、平台行为与坑清单、安全设计输入、风险登记册的完整记录见 [`../docs/android-agent-harness-plan.md`](../docs/android-agent-harness-plan.md)。
