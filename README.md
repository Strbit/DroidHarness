# DroidHarness

面向**已 root 安卓手机**的 AI agent harness。

手机侧控制层自研，**不复用任何第三方控制实现**；形态是 **KernelSU 模块**（不是 APK，也不是 Termux）；控制层与 harness 解耦，未来可以把 DSH 换成自己的 harness 而控制层一行不动。

- **目标设备**：Redmi K90 Pro Max · HyperOS 3 / Android 16 · KernelSU + LSPosed
- **长期目标**：DSH 跑在手机本地 → 逐步换成自己的 harness
- **当前状态**：地基探针就绪，待真机验证；控制层未开始

---

## 目录

```
docs/     设计与参考文档（选型、踩坑、控制层设计）
probe/    当前工作：KernelSU 最小验证模块
```

## 进度

| 阶段 | 状态 | 在哪 |
|---|---|---|
| 平台调研与踩坑整理（设备事实、平台行为、安全设计输入） | ✅ 完成 | [docs/android-agent-harness-plan.md](docs/android-agent-harness-plan.md) |
| 自研控制层设计（分层、能力→平台 API 映射、安全模型、工具契约） | ✅ 完成 | [docs/mobile-control-layer-design.md](docs/mobile-control-layer-design.md) |
| **地基验证：Node 能不能在 KSU 模块里跑起来** | 🔄 **探针就绪，待刷机** | [probe/](probe/) |
| 控制层实现 | ⬜ 未开始 | — |
| 换用自己的 harness | ⬜ 未开始 | — |

## 快速开始

```powershell
cd probe

# 1. 在 PC 上把 aarch64 Node 运行时解出来（不需要手机装 Termux）
node tools\fetch-runtime.mjs --with-koffi

# 2. 打包成可刷入 KernelSU 的模块 zip
powershell -ExecutionPolicy Bypass -File tools\build-module.ps1
```

产物在 `probe\dist\`。刷入后安装日志里就会跑完探针；重启后再看一次开机路径：

```sh
adb shell cat /data/local/tmp/dsh-probe/boot-probe.log
```

判据表见 [probe/README.md](probe/README.md) 的「怎么看结果」。

---

## 为什么是 KernelSU 模块，不是 APK

APK 路线要处理的一多半痛苦，在模块里根本不存在：

| APK 必须处理的 | KSU 模块 |
|---|---|
| **W^X**：`targetSdk>=29` 不能 exec data 目录的文件 → 二进制得伪装成 `lib*.so` 塞 `jniLibs/` | **不适用**，模块脚本本来就从 `/data/adb/modules/` 执行 |
| **AGP 静默丢掉带点的 `.so` 名** → 必须 `patchelf --set-soname` 全量归一 | **没有 AGP**，文件原样放盘上 |
| 281 MB host 树打进 assets，首启解压 3 万个文件 | 直接落盘 |
| 要写 Kotlin + Compose 界面 | 不需要，界面是 harness 自己的 Web GUI |
| 前台服务保活 | `service.sh` 开机自启，跑在 root |

**平台依据**：`/data/adb/modules/` 下的文件由 root 域的模块脚本执行，这是 KSU/Magisk 模块的既有行为——模块里放二进制并执行是常规做法，不需要任何 W^X 绕行技巧。

## 两条硬性设计约束

1. **控制层里不允许出现 "dsh" 这个词。** 一旦出现，说明耦合了。换 harness = 写个新适配器，控制层一行不动。
2. **任何本地服务只绑 `127.0.0.1`，且必须带 token。** 这类设计有一个已知的致命组合：绑 `0.0.0.0` + 无鉴权 + 提供任意命令执行端点，三者叠加等于把设备 root 权限挂在网络上。更隐蔽的是第二条路径——若端点不校验请求类型、而响应又带通配 CORS 头，**手机上浏览器打开的任意网页**也能造成命令执行，且这条路不受防火墙限制。这类缺陷必须从设计上排除，不是"以后加固"。

细节见 [docs/android-agent-harness-plan.md](docs/android-agent-harness-plan.md) §4。

## 为什么不依赖 Termux

手机端从头到尾不需要装 Termux。Node 运行时在 PC 上从 Termux 的 `.deb` 解出来、打进模块：

```
Termux nodejs 26.4.0-1  →  usr/bin/node  49,715,528 bytes  ELF64 AArch64 ✓
依赖闭包 10 个包 / 23.4 MiB
裁剪 + 符号链接清单后  →  module/ 99.4 MiB  →  可刷 zip 34.8 MiB
```

Termux 只被当作**包来源**用，不是运行时依赖。

---

## 原创性说明

本项目代码全部自研，不含第三方实现。

调研阶段参考过同类方案的公开资料，但**设计从 Android 平台文档与真机实测出发**。这样做的理由不只是保持原创——平台行为应该由平台文档和实测确定，而不是由某个实现的现状反推。

对应的做法：所有平台路径在运行时推导；探测失败时**报错**，不使用默认值兜底。详见 [docs/mobile-control-layer-design.md](docs/mobile-control-layer-design.md)。
