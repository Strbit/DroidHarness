// spawn-env -- 子进程环境分类 + 可测试的执行封装
//
// 为什么需要这个文件
// ------------------
// DSH 服务进程的 environ 里有 `LD_LIBRARY_PATH=/data/adb/modules/dsh_android/usr/lib`
// (它在 service.sh 里被 export, 因为模块自带的 node 需要它来找 libz 等库)。//
// 而 `screen-mcp` 由 harness 经 stdio spawn, **必然继承**这个变量。
//
// 问题: 该变量指向的是 Termux 编译的库。系统二进制(尤其 `uiautomator` 会经
// `app_process` 起 ART)在里面会撞上版本节点不匹配的库, 直接 fatal:
//
//   CANNOT LINK EXECUTABLE "app_process": cannot find "libz.so" from verneed[1]
//
// 实测(Android 16)同一条命令:
//   带该变量   -> uiautomator dump  exit=1, 文件大小 0
//   不带该变量 -> uiautomator dump  exit=0, 19774 B
//
// **但不能全局删掉它** —— node 自己需要:
//   剔除后 -> CANNOT LINK EXECUTABLE ".../usr/bin/node": library "libz.so.1" not found
//
// 所以**一个变量两向绑定**: node 要它, 系统二进制要它不在。
// 唯一正确的修法是**按子进程区分**, 而不是全局增删。
//
// 注意 `screencap` 实测两者都能出图(它不像 uiautomator 那样起 ART),
// 但仍然归入"系统二进制"一类: 依赖"某个二进制恰好不受污染"是脆弱的,
// 分类依据是"它是不是系统二进制", 不是"它现在恰好能不能跑"。

import { execFile } from 'node:child_process';

/** 哪些命令算"系统二进制": 跑它们时必须剔除 Termux 的库路径。 */
const SYSTEM_BIN_RE = /^\/(system|vendor|apex)\//;

/**
 * 判断某个可执行文件是否属于"需要干净环境的系统二进制"。
 *
 * 依据路径前缀而不是文件名白名单: 白名单会漏掉将来新增的命令,
 * 而路径前缀表达的正是我们真正关心的性质(它在系统分区, 用系统的 linker 环境)。
 */
export function isSystemBinary(cmd) {
  if (typeof cmd !== 'string') return false;
  return SYSTEM_BIN_RE.test(cmd);
}

/**
 * 为某条命令构造子进程环境。
 *
 * 系统二进制 -> 剔除 LD_LIBRARY_PATH(其余环境原样保留)
 * 其他(尤其 node 自身) -> 原样继承(它需要那个变量)
 *
 * @param cmd 可执行文件路径
 * @param baseEnv 基准环境(默认 process.env, 便于测试注入)
 * @returns 该子进程应使用的环境对象
 */
export function envForCommand(cmd, baseEnv = process.env) {
  if (!isSystemBinary(cmd)) return baseEnv;
  const env = { ...baseEnv };
  delete env.LD_LIBRARY_PATH;
  return env;
}

/**
 * 执行一个子进程, 并按命令类别决定环境。
 *
 * `spawnImpl` 可注入, 目的是让"环境分类"这件事能在**没有设备**的机器上被测到 ——
 * 这正是它上一次逃过测试的原因(唯一能覆盖端到端路径的测试恰好没有断言)。
 *
 * @param cmd 可执行文件路径
 * @param args 参数数组(始终是数组, 不拼 shell 字符串 —— 这挡住了命令注入)
 * @param opts {timeout, encoding, execOpts, baseEnv, spawnImpl}
 */
export function runCommand(cmd, args, opts = {}) {
  const {
    timeout = 20000,
    encoding = 'utf8',
    execOpts = {},
    baseEnv = process.env,
    spawnImpl = null,
  } = opts;
  // 默认必须能跑: 曾经这里只有 `const spawn = spawnImpl;` —— 调用方忘了传就
  // 是 `spawn is not a function`, 而**观察工具全都传了**(screen-mcp 传 execFile),
  // 所以这个坑只在新增的动作层(uiaction.mjs)上暴露, PC 单测又恰好只测了注入
  // 路径的那几条。真机 MCP 链路一跑就炸 —— 默认实现兜住它, 注入仍然优先。
  const spawn = spawnImpl ?? execFile;

  const execOptions = {
    maxBuffer: 256 * 1024 * 1024,
    timeout,
    encoding,
    // 关键: 按命令类别给出环境, 不再无条件继承
    env: envForCommand(cmd, baseEnv),
    ...execOpts,
  };

  return new Promise((resolve, reject) => {
    spawn(cmd, args, execOptions, (err, stdout, stderr) => {
      if (err) {
        // stdout 必须跟 err 一起走: 动作进程(dex)用 exit 3 表达业务失败, 结论 JSON
        // 就在 stdout —— 只带 stderr 的话, 调用方拿不到结论, 真机上表现为
        // "Command failed" + 空 stderr 的无头案(实测绕了好几轮)。
        reject(Object.assign(new Error(`${cmd} ${args.join(' ')}: ${err.message}`), { stdout, stderr }));
      } else resolve({ stdout, stderr });
    });
  });
}

export { SYSTEM_BIN_RE };
