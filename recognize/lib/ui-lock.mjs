// ui-lock.mjs — uiautomator 的单飞锁 (serialized lock)
//
// 为什么必须有这个文件 (2026-09-29 真机实测, Android 16 / Redmi)
// --------------------------------------------------------------
// `uiautomator` 不是可以并发调的命令。三条实测:
//
//   · 两个 `uiautomator dump` 同时跑: 一个 exit=0 出 55635 B 文件,
//     另一个 **exit=137 (SIGKILL) 而且不生成文件**。
//   · 已经有别的 UiAutomation 会话在场时再 dump: 同样被 Killed;
//     那个会话释放之后就正常。
//   · 在**同一个** screen-mcp 实例上并行发 tree / targets / tree
//     (这就是一轮里模型发多个 tool call 的形状): 3 个里 2 个失败。
//
// 根因是平台的: Android 的 UiAutomation 是**单会话**资源, 第二个连接会被框架
// 直接杀掉 —— 不是报错, 是 SIGKILL。而 MCP 服务是长驻进程, harness 会把一轮里
// 的多个 tool call **并发**投进来, 所以"并发"在服务器上不是异常路径, 是默认路径。
//
// 为什么修在锁里而不是"让调用方小心"
// -----------------------------------
// 调用方是模型。它不知道、也不该知道"这一轮别同时点两个看屏幕的工具"。
// 把约束放在能执行它的地方: 服务端串行化。
//
// 顺带修的第二件事: 旧实现把 execFile 的 stdout/stderr **整个丢掉**, 于是
// SIGKILL 这种明确的原因在返回里只剩一个 `dump-file-missing` 字符串 ——
// 完全无法归因。这一轮排查因此猜过命名空间、猜过环境变量污染、猜过息屏,
// 全错, 而答案一直躺在被丢掉的那行 stderr 里。

/** 创建一个 FIFO 单飞锁。 */
export function createSerialLock() {
  let tail = Promise.resolve();
  let active = 0;
  let peak = 0;
  let queued = 0;

  return {
    /**
     * 排入一个任务。前一个任务**成功或失败都会继续** —— 失败不留 rejected
     * 在链上, 否则一次抛错就把后面所有任务永久卡死 (那种死法在测试里很难看见,
     * 因为第一个任务往往就是成功的)。
     * @returns 任务的返回值; 任务抛错时以同一个错误 reject。
     */
    async run(fn) {
      queued++;
      // active 的增减必须发生在**真正执行任务的那一刻**，而不是 run() 被调用的
      // 那一刻: async 函数体在第一个 await 之前是同步执行的, 把 active++ 写在外
      // 面就等于"8 个调用同时进锁"——测出来的峰值并发是假数字(上一版就是这样，
      // 被 test-ui-lock.mjs 的第 1 组断言当场抓住)。
      const task = async () => {
        active++;
        if (active > peak) peak = active;
        try {
          return await fn();
        } finally {
          active--;
        }
      };
      const result = tail.then(task, task);
      // 链尾只关心"settled", 不传播失败
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      try {
        return await result;
      } finally {
        queued--;
      }
    },
    /** 诊断用: 当前并发数峰值 / 队列长度。测试靠它证明"真的串行了"。 */
    stats: () => ({ peak, queued }),
  };
}

/** 屏幕读取用的那把锁 (进程级单例)。 */
export const uiLock = createSerialLock();
