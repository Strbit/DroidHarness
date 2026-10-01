// uiaction.mjs — screen-mcp 的动作层: 文字注入 + 物理 tap/swipe/key
//
// 结构(为什么分两层)
// ─────────────────
// · 物理 input 事件 (tap/swipe/key): 直接 `/system/bin/input`，无需无障碍。
// · 文字注入: 无障碍 ACTION_SET_TEXT，只能由 app_process Java 进程发起
//   (Node 没有; `input text` 只收 ASCII; uiautomator shell 命令没有该动作)。
//   承体是 recognize/uiaction/DshActionMain.java 编出的 dex，一次一进程。
//
// 微信的关键事实(2026-10 真机实测, 小米 25102RKBEC / Android 16 / HyperOS):
//   微信只在**有真实 AccessibilityService 绑定时**才交出无障碍树 —— 而我们的
//   动作进程走 UiAutomation, 它不算(registerUiTestAutomationService 不进
//   mEnabledServices)。所以 screen_text 动作前必须临时挂一个预装无障碍服务
//   (选系统自带的 SelectToSpeak, 免安装任何 APK), 动作后按原值还原。
//   同屏的 screen_tree/screen_targets 也会因此受益(树从"空"变"有")。
//
// dex 与启动器的落点
// ─────────────────
// 跟着本文件所在目录推导(…/tools/lib/ → …/tools/)：装机时 customize.sh 把
// 模块 tools/ 整体布署到 /data/adb/dsh/tools/，dex 就在那儿；启动器是运行时
// 生成的 sh 脚本，写在同目录。**不在代码里写死绝对路径** —— 换布署位置时
// (比如测试环境)这层仍然自洽。
//
// 服务挂载的状态纪律
// ─────────────────
// `settings put secure enabled_accessibility_services` 是全局单值。我们必须:
//   · 写前读原值 → 只追加自己 → marker 文件记录"我们挂的"和"挂之前是什么"
//   · 动作后还原原值; 若原值本来就含该服务, 则**不动**(别人的配置不是我们的)
//   · kill -9 留下的脏状态由下次动作前的 reconcile 修: marker 在而值与记录
//     不一致 → 按记录还原
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand, envForCommand } from './spawn-env.mjs';

/** 本文件所在目录的上一级 = tools 根(dex 的落点)。 */
const TOOLS_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export const DEX_PATH = path.join(TOOLS_DIR, 'dsh-action.dex');
const RUNNER_PATH = path.join(TOOLS_DIR, 'dsh-action-run.sh');

/** dex 缺失时的自检说明(模型读到它能自己判断该找谁)。 */
const DEX_MISSING_HINT =
  `设备上没有 ${DEX_PATH}。它由 dsh/tools/build-uiaction.mjs 编译、随模块 tools/ 布署; ` +
  `若手工补: 先 node dsh/tools/build-uiaction.mjs && node dsh/tools/stage-tools.mjs，再重装模块。`;

// ── 无障碍服务挂载/还原 ─────────────────────────────────────

/** 挂的系统预装服务。选 SelectToSpeak: 实测本机预装、可绑定、平时不抢焦点。 */
const A11Y_SERVICE =
  'com.google.android.marvin.talkback/com.google.android.accessibility.selecttospeak.SelectToSpeakService';

/** 绑定等待: 服务列表变化后 AccessibilityManagerService 需要时间连上, 实测 4s 稳。 */
const A11Y_BIND_WAIT_MS = 4000;

const MARKER_FILE = '/data/local/tmp/dsh-a11y-attached.json';

const run = (cmd, args, opts = {}) => runCommand(cmd, args, opts);

async function readA11ySettings() {
  const [svcs, enabled] = await Promise.all([
    run('/system/bin/settings', ['get', 'secure', 'enabled_accessibility_services']),
    run('/system/bin/settings', ['get', 'secure', 'accessibility_enabled']),
  ]);
  const s = svcs.stdout.trim();
  return { services: s && s !== 'null' ? s : '', enabled: enabled.stdout.trim() };
}

async function writeA11ySettings({ services, enabled }) {
  if (services) {
    await run('/system/bin/settings', ['put', 'secure', 'enabled_accessibility_services', services]);
    await run('/system/bin/settings', ['put', 'secure', 'accessibility_enabled', enabled || '1']);
  } else {
    await run('/system/bin/settings', ['delete', 'secure', 'enabled_accessibility_services']);
    await run('/system/bin/settings', ['put', 'secure', 'accessibility_enabled', '0']);
  }
}

/** marker: 记录"我们挂了什么、挂之前是什么"。kill -9 后的还原依据。 */
function writeMarker(prev) {
  try {
    fs.writeFileSync(MARKER_FILE, JSON.stringify({ prev, ours: A11Y_SERVICE, at: Date.now(), pid: process.pid }));
  } catch { /* 写不进去不致命: 只是丢掉 kill -9 自愈 */ }
}

function readMarker() {
  try { return JSON.parse(fs.readFileSync(MARKER_FILE, 'utf8')); } catch { return null; }
}

function clearMarker() {
  try { fs.unlinkSync(MARKER_FILE); } catch { /* 已不在 */ }
}

/** enabled_accessibility_services 是冒号分隔列表。 */
const hasService = (list, svc) =>
  String(list || '').split(':').map((s) => s.trim()).includes(svc);

const mergeService = (orig, svc) => (orig ? `${orig}:${svc}` : svc);

function removeService(list, svc) {
  return String(list || '')
    .split(':').map((s) => s.trim()).filter(Boolean)
    .filter((s) => s !== svc)
    .join(':');
}

/**
 * 挂服务。返回 { attached, detach }。
 * 原值已含该服务 → attached:false, detach 为 no-op(别人的配置不是我们的, 不还原)。
 */
async function attachA11yService() {
  const orig = await readA11ySettings();
  if (hasService(orig.services, A11Y_SERVICE)) {
    return { attached: false, detach: async () => {} };
  }
  const merged = mergeService(orig.services, A11Y_SERVICE);
  await writeA11ySettings({ services: merged, enabled: '1' });
  writeMarker(orig);
  await new Promise((r) => setTimeout(r, A11Y_BIND_WAIT_MS));
  return {
    attached: true,
    detach: async () => {
      try {
        // 只在"现在的值仍然只是 原值+我们"时才还原 —— 中途有人动过就不碰,
        // 宁可多留一个系统服务, 也不能把用户/别人的改动回滚掉。
        const cur = await readA11ySettings();
        if (cur.services === merged) await writeA11ySettings(orig);
      } finally {
        clearMarker();
      }
    },
  };
}

/**
 * kill -9 自愈: 上次进程死在 attach 与 detach 之间, 留下了挂在全局的服务。
 * 判据: marker 在, 且当前值 = marker.prev + marker.ours(没被人动过) → 还原 prev。
 */
async function reconcileA11y() {
  const marker = readMarker();
  if (!marker) return;
  try {
    const cur = await readA11ySettings();
    const expected = mergeService(marker.prev?.services || '', marker.ours);
    if (cur.services === expected || cur.services === marker.ours) {
      await writeA11ySettings(marker.prev || { services: '', enabled: '0' });
    }
  } catch { /* settings 不可用时留待下次 */ }
  clearMarker();
}

// ── 物理动作 ────────────────────────────────────────────────

/** 串行化: 挂服务→fork→还原 的序列不并发(uiautomator 单飞锁是同款教训)。 */
let actionChain = Promise.resolve();
const chain = (fn) => {
  const p = actionChain.then(fn, fn);
  actionChain = p.catch(() => {});
  return p;
};

/**
 * 一次物理动作: tap / swipe / key。直接走 /system/bin/input。
 * displayId 非 0 时加 -d —— 实测 `input -d <id>` 在虚拟副屏上真实落地。
 * spawnImpl 可注入(测试用), 与 runCommand 的可测试性设计一致。
 */
export async function physicalInput(kind, args, { timeout = 15000, spawnImpl } = {}) {
  const argv = [];
  const displayId = args.displayId !== undefined && args.displayId !== null ? Number(args.displayId) : 0;
  if (Number.isFinite(displayId) && displayId !== 0) argv.push('-d', String(displayId));
  if (kind === 'tap') {
    argv.push('tap', String(args.x), String(args.y));
  } else if (kind === 'swipe') {
    argv.push('swipe', String(args.x1), String(args.y1), String(args.x2), String(args.y2));
    if (args.durationMs !== undefined && args.durationMs !== null) {
      argv.push(String(Math.max(0, Math.round(Number(args.durationMs)))));
    }
  } else if (kind === 'key') {
    argv.push('keyevent', String(args.keycode));
  } else {
    throw new Error('未知动作: ' + kind);
  }
  const t0 = Date.now();
  try {
    await run('/system/bin/input', argv, { timeout, ...(spawnImpl ? { spawnImpl } : {}) });
    return { ok: true, kind, args, cost_ms: Date.now() - t0 };
  } catch (e) {
    const err = new Error(`/system/bin/input ${argv.join(' ')} 失败: ${e.message}`);
    err.detail = String(e.stderr || '').slice(0, 300);
    throw err;
  }
}

// ── 文字注入 ────────────────────────────────────────────────

/**
 * 生成 app_process 启动器(幂等)。
 *
 * 为什么是 sh 脚本而不是 Node 直接 exec app_process:
 * BOOTCLASSPATH 等必须是 system_server 那份真值 —— 脚本里现场读 /proc推导,
 * 真源只有一个(Node 侧不再复制一份推导逻辑, 两份迟早漂移)。
 * b64 由调用方放在 argv 里传进来: CJK 不进 shell 字符串, 注入面与 screen-mcp 一致。
 *
 * LF 强制: 本文件可能由 Windows 侧工具链接触; busybox sh 把 \r 当命令内容。
 */
function ensureRunner() {
  // 幂等检查必须锚定**版本标记行**而不是类名: 类名在所有版本的脚本里都在,
  // 而参数布局改过 —— 拿类名判"已在"会放行旧布局的脚本, 注入时 $1='text'
  // 被当 displayId, parseInt 直接炸。改布局时同步改这一行标记。
  const VERSION_MARK = '# argv: <text> <displayId> <b64-utf8> <replace|append>';
  try {
    const cur = fs.readFileSync(RUNNER_PATH, 'utf8');
    if (cur.includes(VERSION_MARK) && cur.includes('com.dsh.uiaction.DshActionMain')) return;
  } catch { /* 不在, 重写 */ }
  const script = [
    '#!/system/bin/sh',
    '# 由 screen-mcp (lib/uiaction.mjs) 生成; 删除后下次动作会重建。',
    VERSION_MARK,
    'PID=$(pgrep -f system_server | head -1)',
    'export BOOTCLASSPATH=$(tr \'\\0\' \'\\n\' < /proc/$PID/environ | sed -n \'s/^BOOTCLASSPATH=//p\')',
    'export DEX2OATBOOTCLASSPATH=$(tr \'\\0\' \'\\n\' < /proc/$PID/environ | sed -n \'s/^DEX2OATBOOTCLASSPATH=//p\')',
    'export ANDROID_ROOT=/system ANDROID_DATA=/data',
    'export ANDROID_ART_ROOT=/apex/com.android.art',
    'export ANDROID_I18N_ROOT=/apex/com.android.i18n',
    'export ANDROID_TZDATA_ROOT=/apex/com.android.tzdata',
    'export CLASSPATH="' + DEX_PATH + '"',
    'exec /system/bin/app_process /system/bin com.dsh.uiaction.DshActionMain "$@"',
    '',
  ].join('\n');
  fs.writeFileSync(RUNNER_PATH, script);
  try { fs.chmodSync(RUNNER_PATH, 0o755); } catch { /* 尽力而为 */ }
}

/**
 * 文字注入: 挂服务 → sh 启动器 → app_process(dex) → 读 JSON → 还原服务。
 * 全程串行(actionChain)。失败原样抛出/返回 —— 没有任何"换个姿势再试一次"。
 */
export async function injectText(displayId, text, { timeout = 45000, mode = 'replace' } = {}) {
  return chain(async () => {
    if (!fs.existsSync(DEX_PATH)) {
      const e = new Error(DEX_MISSING_HINT);
      e.code = 'dex-missing';
      throw e;
    }
    ensureRunner();
    const b64 = Buffer.from(text, 'utf8').toString('base64');
    const modeArg = mode === 'append' ? 'append' : 'replace';

    await reconcileA11y();
    const { detach } = await attachA11yService();
    try {
      // /system/bin/sh 是系统二进制 → envForCommand 自动剔除 LD_LIBRARY_PATH
      // (Termux 库路径会打死 app_process 的 ART, 见 spawn-env.mjs 头部实测)。
      const res = await run(
        '/system/bin/sh',
        [RUNNER_PATH, 'text', String(Number(displayId)), b64, 'focused', modeArg],
        { timeout },
      );
      const out = String(res.stdout || '');
      const end = out.indexOf('<<<END_OF_JSON>>>');
      const line = (end >= 0 ? out.slice(0, end) : out)
        .split('\n').map((s) => s.trim()).filter(Boolean).pop();
      if (!line) {
        throw new Error(
          `动作进程无输出${res.stderr ? `; stderr: ${String(res.stderr).slice(0, 200)}` : ''}`,
        );
      }
      try { return JSON.parse(line); }
      catch { throw new Error(`动作进程输出不可解析: ${line.slice(0, 200)}`); }
    } finally {
      await detach();
    }
  });
}

/** 供测试: 服务列表的纯函数(合并/摘除/判定)。 */
export const _a11yList = { hasService, mergeService, removeService };
