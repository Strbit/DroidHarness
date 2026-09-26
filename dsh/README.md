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
├── usr/                      运行时 (aarch64 Node 26.4.0 + bash + ripgrep + 依赖库)
└── app/                      DSH 应用树 (513 个包)
    └── node_modules/
        ├── @deepseek-ai/dsh/lib/bin.js     入口
        ├── @koromix/koffi-android-arm64/   原生模块的平台预编译包
        └── node-addon-require-builtin/     ← 已被 JS 替身顶替, 见下
```

体积：`usr/` 约 104 MiB，`app/` 约 225 MiB（25,715 个文件）。**打包后 zip 约 101 MiB**（构建耗时约 5 分钟，主要是压那两万多个文件）。

---

## 构建

```powershell
cd D:\projects\DroidHarness

# 1. 取运行时 (aarch64 Node + bash + ripgrep)
node probe\tools\fetch-runtime.mjs --out dsh\module

# 2. 装 DSH 应用树并打补丁
node dsh\tools\build-dsh-tree.mjs

# 3. 打包
powershell -ExecutionPolicy Bypass -File probe\tools\build-module.ps1 -ModuleDir dsh\module
```

产物在 `dsh\dist\`。第 2 步会跑一次**实测校验**，确认 shim 真的能用。

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

## 两个关键决定（都踩过）

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

- **首次安装较慢**：25,871 个文件要解压。安装脚本**故意不对 `app/` 做 `set_perm_recursive`**（那是逐个 shell 调用，会慢到不可接受），改用一条 `chmod -R 0755`。
- **没有裁剪**：`app/` 里约 **113 MiB** 是运行时不用的 —— source map 44 MiB、`.d.ts` 类型声明 33 MiB、Windows 调试符号 20 MiB、Markdown 与测试目录 16 MiB。为了先拿到可用产物没有裁。裁的话必须按**引用扫描**来，不能按目录名猜：koffi 的 `src/` 和 `yaml/dist/doc/` 都是"名字像文档、其实是运行时代码"的例子。
- **`node-pty` 没有原生模块**：安装脚本被跳过（它在 HOST 上跑，而包是给 TARGET 的），所以持久终端不可用。DSH 设计上容忍。
- **`sharp` 没有 android 变体**：图片处理可能不可用。
- **构建产物不进 git**：`dsh/module/{app,usr}/` 由上面两条命令重建。

## 已实测

在测试机（Redmi K90 Pro Max · HyperOS 3 / Android 16 · KernelSU）上：

```
模块目录 exec: OK   (u:r:ksu:s0 + SELinux enforcing)
Node 26.4.0 / ABI 147 / platform=android / arch=arm64
spawn / TLS / 系统 CA 库  全过
shim 实测通过: shim-ok object function
dsh web 已拉起, 监听 127.0.0.1:3080, Web GUI 可正常访问
```

## 与 `probe/` 的关系

`probe/` 是**地基验证模块**，它回答了"KernelSU 模块里能不能跑 bionic Node"这个问题：

```
模块目录 exec: OK (u:r:ksu:s0 + enforcing)
Node 26.4.0 / ABI 147 / platform=android / arch=arm64
spawn / TLS / CA 全过
```

结论通过后才有这个正式模块。`probe/` 保留着，以后排查平台问题还能用。

平台事实、平台行为与坑清单、安全设计输入、风险登记册的完整记录见 [`../docs/android-agent-harness-plan.md`](../docs/android-agent-harness-plan.md)。
