# 第三方组件与许可证

本模块**随包分发**下列第三方二进制与代码。它们各自归其版权人所有，并适用各自的许可证。

> **`LICENSE`（Apache-2.0）只覆盖本项目自己写的代码** —— `dsh/module/*.sh`、`dsh/tools/`、
> `probe/`、`docs/` 等。下面列出的第三方组件**不适用**该许可。
>
> GitHub 只会按仓库根的 `LICENSE` 显示一个标签，那份标签**不代表**整个仓库。

---

## 一、运行时二进制（来自 Termux）—— 27 个

这些是从 [Termux](https://termux.dev/) 的 APT 仓库取出 `.deb`，再由
[`probe/tools/fetch-runtime.mjs`](probe/tools/fetch-runtime.mjs) 解包重组的。

**每个包的许可证跟随其上游**，依据 [termux-packages/LICENSE.md](https://github.com/termux/termux-packages/blob/master/LICENSE.md)：
*"the scripts and patches to build each package is licensed under the same license as the actual package"*。

### 1.1 需要提供源码的组件（GPL / LGPL）

分发下列二进制时，附许可证与**提供对应源码**是义务。源码地址：

| 组件 | 版本 | 许可证 | 源码 |
|---|---|---|---|
| bash | 5.3.20 | GPL-3.0 | https://ftp.gnu.org/gnu/bash/ |
| readline | 8.3.6 | GPL-3.0 | https://ftp.gnu.org/gnu/readline/ |
| git | 2.55.0 | GPL-2.0 | https://mirrors.kernel.org/pub/software/scm/git/ |
| less | 710 | GPL-3.0, custom (BSD-2 式) | https://www.greenwoodsoftware.com/less/ |
| libiconv | 1.19 | LGPL-2.1, GPL-3.0 | https://ftp.gnu.org/gnu/libiconv/ |

**构建脚本与补丁**（Termux 对上游的修改）在 [termux-packages](https://github.com/termux/termux-packages)
的 `packages/<名称>/` 目录下，同样按上游许可证发布。

如果你需要这些组件的源码副本，请开 issue。

### 1.2 宽松许可组件

| 组件 | 版本 | 许可证 | 上游 |
|---|---|---|---|
| nodejs | 26.4.0-1 | MIT | https://nodejs.org/ |
| npm | 11.20.0 | Artistic-2.0 | https://docs.npmjs.com/cli/ |
| pnpm | 12.7.0 | MIT | https://pnpm.io |
| ripgrep | 15.2.0 | MIT OR Unlicense | https://github.com/BurntSushi/ripgrep |
| openssl | 3.6.3 | Apache-2.0 | https://www.openssl.org/ |
| libicu | 78.3 | Unicode-3.0 (ICU) | https://icu.unicode.org/ |
| libc++ | 30 | NCSA | https://libcxx.llvm.org/ |
| ncurses | 6.6 | MIT (X11) | https://invisible-island.net/ncurses/ |
| zlib | 1.3.2 | Zlib | https://www.zlib.net/ |
| pcre2 | 10.47 | BSD-3-Clause | https://pcre2project.github.io/pcre2/ |
| c-ares | 1.34.8 | MIT | https://c-ares.org/ |
| libffi | 3.8.0 | MIT | https://sourceware.org/libffi/ |
| libsqlite | 3.53.4 | Public Domain | https://www.sqlite.org |
| libcurl | 8.22.0 | curl (MIT 式) | https://curl.se/ |
| libssh2 | 1.11.1-2 | BSD-3-Clause | https://www.libssh2.org |
| libexpat | 2.8.5 | MIT | https://libexpat.github.io/ |
| libnghttp2 | 1.70.0 | MIT | https://nghttp2.org/ |
| libnghttp3 | 1.18.0 | MIT | https://nghttp2.org/nghttp3/ |
| libngtcp2 | 1.25.0 | MIT | https://github.com/ngtcp2/ngtcp2 |
| libandroid-support | 29-1 | Apache-2.0, MIT | https://github.com/termux/libandroid-support |
| ca-certificates | 2026.08.13 | MPL-2.0 | https://curl.se/docs/caextract.html |
| resolv-conf | 1.3 | Public Domain | https://man7.org/linux/man-pages/man5/resolv.conf.5.html |

> 许可证全文随包发在模块的 `usr/share/doc/<包名>/copyright`。
> （这些文件**不被裁剪** —— 早期版本的裁剪逻辑删掉了它们，那是错的，已改回。）

---

## 二、DSH 应用树（npm）—— 495 个包

`dsh/module/app/node_modules/` 下的包。数据从各包自己的 `package.json` 读取。

| 许可证 | 包数 |
|---|---|
| MIT | 409 |
| ISC | 8 |
| Apache-2.0 | 59 |
| BSD | 16 |
| MPL | 1 |
| Unlicense / Public Domain | 1 |
| 其他 | 1 |

### MIT（409）

- `@anthropic-ai/sdk@0.123.0` — MIT
- `@babel/code-frame@7.29.7` — MIT
- `@babel/helper-validator-identifier@7.29.7` — MIT
- `@babel/runtime@7.29.7` — MIT
- `@deepseek-ai/cordis@4.0.4` — MIT
- `@deepseek-ai/cordis-plugin-group@1.0.4` — MIT
- `@deepseek-ai/cordis-plugin-include@1.0.9` — MIT
- `@deepseek-ai/cordis-plugin-loader@1.0.5` — MIT
- `@deepseek-ai/cordis-plugin-timer@1.1.6` — MIT
- `@deepseek-ai/cosmokit@1.8.5` — MIT
- `@deepseek-ai/dsh@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-acp@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-acp-app@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-agent@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-agent-default-model@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-agent-instructions@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-agent-loop@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-agent-preset@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-agent-preset-registry@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-agent-tool-presentation@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-anonymous-user-id@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-api-account-controller@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-api-gateway@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-api-job-controller@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-api-remotes@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-api-session-controller@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-api-settings-controller@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-api-terminal-controller@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-api-workspace-controller@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-api-workspace-files@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-app-boot@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-atomic-write@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-attachment@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-attachment-local@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-authorization@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-base@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-bash-local@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-bash-sandbox@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-brand@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-chunked-list@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-client-connection@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-client-file-upload@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-client-hmr@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-client-locale@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-client-modules@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-client-resources@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-client-shortcuts@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-client-store@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-client-ui-agent-preset@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-client-ui-approval@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-client-ui-attachment@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-client-ui-brand-official@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-client-ui-chat@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-client-ui-commands@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-client-ui-conversation@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-client-ui-cordis@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-client-ui-deliverables@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-client-ui-directory-picker-browse@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-client-ui-directory-picker-native@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-client-ui-goal@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-client-ui-input-trigger@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-client-ui-jobs@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-client-ui-layout@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-client-ui-message-feedback@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-client-ui-model-selection@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-client-ui-open-in-app@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-client-ui-permission-presets@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-client-ui-plan@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-client-ui-plugin-manager@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-client-ui-primitives@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-client-ui-reference@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-client-ui-renderer@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-client-ui-schedule@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-client-ui-session@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-client-ui-settings@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-client-ui-settings-account@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-client-ui-settings-agent-loop@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-client-ui-settings-general@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-client-ui-settings-models@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-client-ui-settings-plugin-inventory@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-client-ui-settings-plugins@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-client-ui-settings-shell@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-client-ui-settings-subagent@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-client-ui-settings-web-search@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-client-ui-shortcuts@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-client-ui-sidebar@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-client-ui-sidebar-browser@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-client-ui-sidebar-documentpreview@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-client-ui-sidebar-files@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-client-ui-sidebar-right@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-client-ui-sidebar-terminal@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-client-ui-skill@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-client-ui-slots@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-client-ui-subagent@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-client-ui-theme@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-client-ui-tool@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-client-ui-trajectory@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-client-ui-user-questions@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-client-ui-workflow-run@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-client-ui-workspace@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-cmdline@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-command-compact@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-command-feedback@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-command-goal@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-commands@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-compaction@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-compaction-basic@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-compaction-image-offload@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-compaction-tool-result-pruner@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-config-editor@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-cordis-client-runner@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-cordis-host-runner@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-credentials@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-credentials-local@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-deepseek-account@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-deepseek-account-platform@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-deepseek-llm-api-extensions@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-deque@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-experimental-agent-team@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-experimental-agent-team-profile@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-experimental-api-speech-to-text@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-experimental-auto-review@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-experimental-client-ui-agent-team@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-experimental-client-ui-voice-input@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-experimental-speech-to-text@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-experimental-speech-to-text-sensevoice@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-experimental-tool-agent-team@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-experimental-voice-input-bundle@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-file-reference@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-file-reference-local@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-fs@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-fs-local@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-fs-observation-policy@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-fs-sandbox@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-goal@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-goal-round-driver@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-headless@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-hmr@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-home-paths@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-hook-protocol@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-hooks-claude-code@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-hooks-codex@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-host-directory-picker@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-host-directory-picker-auto@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-host-directory-picker-browse@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-host-directory-picker-native@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-host-frontend-static@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-host-open-in-app@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-host-plugin-inventory@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-host-webserver@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-http-proxy@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-invariants@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-jobs@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-jobs-local@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-launch-environment@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-lazy-require@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-llm@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-llm-deepseek@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-llm-deepseek-account@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-llm-deepseek-api-key@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-llm-pi-ai@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-llm-retry@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-mcp-client@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-mcp-resources@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-message-feedback@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-native-command@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-office-to-pdf@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-output-retention@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-package-manifest@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-permission-presets@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-persona@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-plan-mode@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-plugin-manager@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-plugin-package-inventory-deepseek@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-ptc-runtime@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-ptc-runtime-node@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-pwsh-local@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-pwsh-sandbox@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-repeat-tool-reminder@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-sandbox@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-sandbox-local@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-sandbox-policy@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-sandbox-windows-acl@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-schedule@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-scope@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-sdk-app@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-sdk-jsonrpc-server@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-sdk-minimal@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-sdk-protocol@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-session@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-session-checkpoint-policy@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-session-format@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-session-format-catalog@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-session-format-v0-to-v1@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-session-format-v1-to-v2@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-session-format-v2-to-v3@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-session-format-v3-to-v4@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-session-log-deepseek@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-session-log-export@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-session-persistence@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-session-persistence-jsonl@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-session-projection@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-session-projection-cache@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-session-query@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-session-query-sqlite@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-session-reference@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-session-stats@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-session-telemetry@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-session-telemetry-otel@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-session-title@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-session-title-first-prompt-llm@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-session-title-llm@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-session-turn-outline@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-settings@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-shell@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-shell-env@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-skill@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-skill-badge@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-skill-filesystem@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-skill-office@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-spill@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-spill-local@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-spill-policy@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-storage@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-storage-domain@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-storage-json@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-subagent@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-subagent-fork-in-process@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-subagent-in-process-driver@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-subagent-spawn-in-process@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-subprocess@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-subprocess-local@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-system-prompt@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-terminal@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-terminal-bash@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-time-context@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-timeout@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-tmux-context@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-token-meter@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-tool-ask-user@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-tool-bash@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-tool-bash-persistent@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-tool-call-timeout-policy@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-tool-cordis@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-tool-fs@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-tool-fs-search@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-tool-goal@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-tool-jobs@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-tool-present@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-tool-pwsh@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-tool-pwsh-persistent@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-tool-ralph@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-tool-skill@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-tool-str-replace-editor@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-tool-subagent@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-tool-subagent-control@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-tool-todo@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-tool-web@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-tool-workflow@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-tool-workspace-dependencies@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-tools@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-typert-loader@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-typert-protocol@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-typert-registry@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-user-approval@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-user-questions@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-util-code-language@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-util-crypto@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-util-time@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-util-values@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-util-workspace-path@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-web@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-web-app@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-web-fetch-http@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-web-frontend@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-web-search-deepseek@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-webhook@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-webhook-github@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-win32-process@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-workflow@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-workflow-ptc@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-workspace@0.1.7-rc.2` — MIT
- `@deepseek-ai/dsh-workspace-changes@0.1.7-rc.2` — MIT
- `@deepseek-ai/schemastery@3.18.4` — MIT
- `@earendil-works/pi-ai@0.85.1` — MIT
- `@earendil-works/pi-telemetry@0.85.1` — MIT
- `@eslint-community/regexpp@4.12.2` — MIT
- `@img/colour@1.1.0` — MIT
- `@joplin/turndown-plugin-gfm@1.0.68` — MIT
- `@koromix/koffi-android-arm64@3.3.1` — MIT
- `@modelcontextprotocol/client@2.0.0` — MIT
- `@modelcontextprotocol/core@2.0.0` — MIT
- `@octokit/openapi-types@29.0.1` — MIT
- `@octokit/openapi-webhooks-types@12.1.0` — MIT
- `@octokit/request-error@7.1.2` — MIT
- `@octokit/types@18.0.0` — MIT
- `@octokit/webhooks@14.2.0` — MIT
- `@octokit/webhooks-methods@6.0.0` — MIT
- `@sec-ant/readable-stream@0.4.1` — MIT
- `@sindresorhus/merge-streams@4.0.0` — MIT
- `@stablelib/base64@1.0.1` — MIT
- `@types/node@26.6.3` — MIT
- `@types/retry@0.12.0` — MIT
- `@vscode/ripgrep@1.18.0` — MIT
- `@vscode/ripgrep-android-arm64@15.2.0` — MIT
- `@xterm/addon-serialize@0.14.0` — MIT
- `@xterm/headless@6.0.0` — MIT
- `agent-base@7.1.4` — MIT
- `ajv@8.20.0` — MIT
- `base64-js@1.5.1` — MIT
- `bignumber.js@9.3.1` — MIT
- `bowser@2.14.1` — MIT
- `brotli@1.3.3` — MIT
- `bundle-name@4.1.1` — MIT
- `bytes@3.1.2` — MIT
- `chokidar@5.0.0` — MIT
- `clone@2.1.2` — MIT
- `commander@15.0.0` — MIT
- `compressible@2.0.18` — MIT
- `compression@1.8.2` — MIT
- `content-type@2.1.0` — MIT
- `cross-spawn@7.0.6` — MIT
- `data-uri-to-buffer@4.0.1` — MIT
- `debug@2.6.9` — MIT
- `default-browser@5.5.1` — MIT
- `default-browser-id@5.0.1` — MIT
- `define-lazy-prop@3.0.0` — MIT
- `destroy@1.2.0` — MIT
- `dfa@1.2.0` — MIT
- `eventsource@3.0.7` — MIT
- `eventsource-parser@3.1.1` — MIT
- `execa@10.0.1` — MIT
- `extend@3.0.2` — MIT
- `fast-deep-equal@3.1.3` — MIT
- `fetch-blob@3.2.0` — MIT
- `fflate@0.8.2` — MIT
- `figures@6.1.0` — MIT
- `fontkit@2.0.4` — MIT
- `formdata-polyfill@4.0.10` — MIT
- `get-stream@9.0.1` — MIT
- `http-proxy-agent@7.0.2` — MIT
- `https-proxy-agent@7.0.6` — MIT
- `ipaddr.js@2.5.0` — MIT
- `is-docker@3.0.0` — MIT
- `is-in-ssh@1.0.0` — MIT
- `is-inside-container@1.0.0` — MIT
- `is-plain-obj@4.1.0` — MIT
- `is-stream@4.0.1` — MIT
- `is-unicode-supported@2.1.0` — MIT
- `is-wsl@3.1.1` — MIT
- `jose@6.2.12` — MIT
- `js-tokens@4.0.0` — MIT
- `js-yaml@4.3.2` — MIT
- `json-bigint@1.0.0` — MIT
- `json-schema-to-ts@3.1.1` — MIT
- `json-schema-traverse@1.0.0` — MIT
- `jwa@2.0.1` — MIT
- `jws@4.0.1` — MIT
- `koffi@3.3.1` — MIT
- `mime-db@1.54.0` — MIT
- `mime-types@3.0.2` — MIT
- `ms@2.1.3` — MIT
- `negotiator@0.6.4` — MIT
- `node-addon-api@7.1.1` — MIT
- `node-addon-native-custom-loader@0.1.6` — MIT
- `node-addon-require-builtin@0.1.6` — MIT
- `node-domexception@1.0.0` — MIT
- `node-fetch@3.3.2` — MIT
- `node-pty@1.2.0-beta.15` — MIT
- `npm-run-path@6.0.0` — MIT
- `on-headers@1.1.0` — MIT
- `open@11.0.4` — MIT
- `p-retry@4.6.2` — MIT
- `pako@0.2.9` — MIT
- `parse-ms@4.0.0` — MIT
- `partial-json@0.1.7` — MIT
- `path-key@4.0.0` — MIT
- `picomatch@4.0.7` — MIT
- `pkce-challenge@5.0.1` — MIT
- `powershell-utils@0.2.1` — MIT
- `pretty-ms@9.3.1` — MIT
- `readdirp@5.1.1` — MIT
- `require-from-string@2.0.2` — MIT
- `resolve.exports@2.0.3` — MIT
- `restructure@3.0.2` — MIT
- `retry@0.13.1` — MIT
- `run-applescript@7.1.0` — MIT
- `safe-buffer@5.2.1` — MIT
- `shebang-command@2.0.0` — MIT
- `shebang-regex@3.0.0` — MIT
- `standardwebhooks@1.1.1` — MIT
- `strip-final-newline@4.0.0` — MIT
- `tiny-inflate@1.0.3` — MIT
- `ts-algebra@2.0.0` — MIT
- `turndown@7.2.4` — MIT
- `typebox@1.3.7` — MIT
- `undici@8.11.2` — MIT
- `undici-types@8.9.0` — MIT
- `unicode-properties@1.4.1` — MIT
- `unicode-trie@2.0.0` — MIT
- `unicorn-magic@0.3.0` — MIT
- `vary@1.1.2` — MIT
- `web-streams-polyfill@3.3.3` — MIT
- `which-command@0.1.0` — MIT
- `ws@8.21.3` — MIT
- `wsl-utils@1.0.0` — MIT
- `xmlchars@2.2.0` — MIT
- `yoctocolors@2.2.0` — MIT
- `zod@4.6.5` — MIT

### ISC（8）

- `@js-temporal/polyfill@0.5.1` — ISC
- `isexe@2.0.0` — ISC
- `picocolors@1.1.1` — ISC
- `saxes@6.0.0` — ISC
- `semver@7.8.5` — ISC
- `signal-exit@4.1.0` — ISC
- `which@2.0.2` — ISC
- `yaml@2.9.1` — ISC

### Apache-2.0（59）

- `@agentclientprotocol/sdk@1.4.0` — Apache-2.0
- `@aws-crypto/sha256-browser@5.2.0` — Apache-2.0
- `@aws-crypto/sha256-js@5.2.0` — Apache-2.0
- `@aws-crypto/supports-web-crypto@5.2.0` — Apache-2.0
- `@aws-crypto/util@5.2.0` — Apache-2.0
- `@aws-sdk/client-bedrock-runtime@3.1048.0` — Apache-2.0
- `@aws-sdk/core@3.978.1` — Apache-2.0
- `@aws-sdk/credential-provider-env@3.972.72` — Apache-2.0
- `@aws-sdk/credential-provider-http@3.972.74` — Apache-2.0
- `@aws-sdk/credential-provider-ini@3.973.17` — Apache-2.0
- `@aws-sdk/credential-provider-login@3.972.79` — Apache-2.0
- `@aws-sdk/credential-provider-node@3.972.84` — Apache-2.0
- `@aws-sdk/credential-provider-process@3.972.72` — Apache-2.0
- `@aws-sdk/credential-provider-sso@3.973.16` — Apache-2.0
- `@aws-sdk/credential-provider-web-identity@3.972.78` — Apache-2.0
- `@aws-sdk/eventstream-handler-node@3.972.35` — Apache-2.0
- `@aws-sdk/middleware-eventstream@3.972.30` — Apache-2.0
- `@aws-sdk/middleware-websocket@3.972.54` — Apache-2.0
- `@aws-sdk/nested-clients@3.997.46` — Apache-2.0
- `@aws-sdk/signature-v4-multi-region@3.996.47` — Apache-2.0
- `@aws-sdk/token-providers@3.1138.0` — Apache-2.0
- `@aws-sdk/types@3.974.6` — Apache-2.0
- `@aws-sdk/util-locate-window@3.965.10` — Apache-2.0
- `@aws-sdk/xml-builder@3.972.41` — Apache-2.0
- `@aws/lambda-invoke-store@0.3.0` — Apache-2.0
- `@google/genai@1.52.0` — Apache-2.0
- `@opentelemetry/api@1.9.1` — Apache-2.0
- `@opentelemetry/api-logs@0.220.0` — Apache-2.0
- `@opentelemetry/core@2.9.0` — Apache-2.0
- `@opentelemetry/exporter-logs-otlp-http@0.220.0` — Apache-2.0
- `@opentelemetry/otlp-exporter-base@0.220.0` — Apache-2.0
- `@opentelemetry/otlp-transformer@0.220.0` — Apache-2.0
- `@opentelemetry/resources@2.9.0` — Apache-2.0
- `@opentelemetry/sdk-logs@0.220.0` — Apache-2.0
- `@opentelemetry/sdk-metrics@2.9.0` — Apache-2.0
- `@opentelemetry/sdk-trace@2.9.0` — Apache-2.0
- `@opentelemetry/semantic-conventions@1.43.0` — Apache-2.0
- `@smithy/core@3.35.0` — Apache-2.0
- `@smithy/credential-provider-imds@4.5.2` — Apache-2.0
- `@smithy/fetch-http-handler@5.8.0` — Apache-2.0
- `@smithy/is-array-buffer@2.2.0` — Apache-2.0
- `@smithy/node-http-handler@4.12.1` — Apache-2.0
- `@smithy/signature-v4@5.7.4` — Apache-2.0
- `@smithy/types@4.19.0` — Apache-2.0
- `@smithy/util-buffer-from@2.2.0` — Apache-2.0
- `@smithy/util-utf8@2.3.0` — Apache-2.0
- `@swc/helpers@0.5.23` — Apache-2.0
- `detect-libc@2.1.2` — Apache-2.0
- `ecdsa-sig-formatter@1.0.11` — Apache-2.0
- `gaxios@7.3.1` — Apache-2.0
- `gcp-metadata@8.1.2` — Apache-2.0
- `google-auth-library@10.9.1` — Apache-2.0
- `google-logging-utils@1.1.3` — Apache-2.0
- `human-signals@8.0.1` — Apache-2.0
- `jsbi@4.3.2` — Apache-2.0
- `long@5.3.2` — Apache-2.0
- `openai@6.40.0` — Apache-2.0
- `sharp@0.35.4` — Apache-2.0
- `sherpa-onnx-node@1.13.8` — Apache-2.0

### BSD（16）

- `@deepseek-ai/node-addon-system@0.1.2` — BSD-3-Clause
- `@mixmark-io/domino@2.2.0` — BSD-2-Clause
- `@protobufjs/aspromise@1.1.2` — BSD-3-Clause
- `@protobufjs/base64@1.1.2` — BSD-3-Clause
- `@protobufjs/codegen@2.0.5` — BSD-3-Clause
- `@protobufjs/eventemitter@1.1.1` — BSD-3-Clause
- `@protobufjs/fetch@1.1.1` — BSD-3-Clause
- `@protobufjs/float@1.0.2` — BSD-3-Clause
- `@protobufjs/path@1.1.2` — BSD-3-Clause
- `@protobufjs/pool@1.1.0` — BSD-3-Clause
- `@protobufjs/utf8@1.1.2` — BSD-3-Clause
- `buffer-equal-constant-time@1.0.1` — BSD-3-Clause
- `diff@9.0.0` — BSD-3-Clause
- `fast-uri@3.1.8` — BSD-3-Clause
- `protobufjs@7.6.6` — BSD-3-Clause
- `tslib@2.8.1` — 0BSD

### MPL（1）

- `@deepseek-ai/libreoffice-kit@0.1.2` — MPL-2.0

### Unlicense / Public Domain（1）

- `fast-sha256@1.3.0` — Unlicense

### 其他（1）

- `argparse@2.0.1` — Python-2.0

---

## 二·五、借鉴实现（非依赖，源码级参考）—— 1 个

`recognize/uiaction/DshActionMain.java` 的关键实现在设计上参考了
[AcidGr/agent-mobile-use](https://github.com/AcidGr/agent-mobile-use)（MIT,
© 2026 AcidGr）的 `vd-tool-java/src/com/agent/ToolMain.java`：

- UiAutomation 反射引导序列（HandlerThread looper / `connect(int)`+`connect()`
  双形态 / `setServiceInfo` 标志组合）—— 绕开 app_process 无主 Looper 的 exit 137
- `getWindowsOnAllDisplays()` 读非默认屏树
- `ACTION_SET_TEXT` + 60ms + `refresh()` 读回校验、`isMasked`（密码框圆点判成功）
- 无 fallback 的单通道注入纪律

本仓库的实现是重写（argv 一次一进程、无 stdin daemon、聚焦模式单一通道），
未逐行复制；在此按 MIT 归因。

---

## 三、生成方式

```sh
node dsh/tools/gen-third-party-notices.mjs
```

运行时部分的数据来源：`TERMUX_PKG_LICENSE`（各包的 `build.sh`）、Termux APT 索引的 `Packages`
文件、以及包内自带的 `usr/share/doc/<pkg>/copyright`。**不是手抄的猜测。**
