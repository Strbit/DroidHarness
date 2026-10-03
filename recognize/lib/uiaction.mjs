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
import { execFile as execFileCb } from 'node:child_process';
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
  const VERSION_MARK = '# dsh-runner-v3: text|vd';
  try {
    const cur = fs.readFileSync(RUNNER_PATH, 'utf8');
    if (cur.includes(VERSION_MARK) && cur.includes('com.dsh.uiaction')) return;
  } catch { /* 不在, 重写 */ }
  const script = [
    '#!/system/bin/sh',
    '# 由 screen-mcp (lib/uiaction.mjs) 生成; 删除后下次动作会重建。',
    VERSION_MARK,
    '# 用法: dsh-action-run.sh text <displayId> <b64-utf8> <replace|append>',
    '#       dsh-action-run.sh vd   <width> <height> <dpi>   (常驻, stdin 命令循环)',
    'PID=$(pgrep -f system_server | head -1)',
    // 继承的优先(sh 服务的 env 由 init 导出, 实测带 BOOTCLASSPATH), 没有
    // 再从 system_server 的 /proc 借 —— 两个来源, 同一份真值, 不依赖 root。
    '[ -n "$BOOTCLASSPATH" ] || export BOOTCLASSPATH=$(tr \'\\0\' \'\\n\' < /proc/$PID/environ | sed -n \'s/^BOOTCLASSPATH=//p\')',
    '[ -n "$DEX2OATBOOTCLASSPATH" ] || export DEX2OATBOOTCLASSPATH=$(tr \'\\0\' \'\\n\' < /proc/$PID/environ | sed -n \'s/^DEX2OATBOOTCLASSPATH=//p\')',
    '[ -n "$BOOTCLASSPATH" ] || { echo "{\\"ok\\":false,\\"error\\":\\"no-bootclasspath\\",\\"reason\\":\\"继承与 /proc 都拿不到 BOOTCLASSPATH\\"}"; exit 3; }',
    'export ANDROID_ROOT=/system ANDROID_DATA=/data',
    'export ANDROID_ART_ROOT=/apex/com.android.art',
    'export ANDROID_I18N_ROOT=/apex/com.android.i18n',
    'export ANDROID_TZDATA_ROOT=/apex/com.android.tzdata',
    'export CLASSPATH="' + DEX_PATH + '"',
    'if [ "$1" = "vd" ]; then',
    '  shift',
    '  exec /system/bin/app_process /system/bin com.dsh.uiaction.VdMain "$@"',
    'fi',
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
      //
      // **退出码≠0 不是基础设施失败**: 动作进程用 exit 3 表达业务失败
      // (no_focused_input 等), JSON 结论就在 stdout —— 真机上曾把 exit 3 当
      // crash 抛掉, 模型看到的是 "Command failed" 而不是可行动的业务错误。
      // 所以这里 catch 后先尝试解析 stdout 的 JSON, 只有**连 JSON 都没有**才算
      // 基础设施失败(那才是值得带 stderr 报错的场景)。
      let res;
      try {
        res = await run(
          '/system/bin/sh',
          [RUNNER_PATH, 'text', String(Number(displayId)), b64, 'focused', modeArg],
          { timeout },
        );
      } catch (e) {
        const out = String(e.stdout || '');
        const end = out.indexOf('<<<END_OF_JSON>>>');
        const line = (end >= 0 ? out.slice(0, end) : out)
          .split('\n').map((s) => s.trim()).filter(Boolean).pop();
        if (line) {
          try { return JSON.parse(line); }
          catch { /* 不是 JSON, 落到下面的真失败 */ }
        }
        const se = String(e.stderr || '').trim();
        throw new Error(
          `动作进程失败(无业务结论): ${e.message}\n` +
          `  stderr: ${se ? se.slice(0, 500) : '(空)'}` +
          `\n  (exit 3 且 stdout 有 JSON = 业务失败, 不应走到这里; 若复现请检查 runner 输出协议)`,
        );
      }
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

/**
 * 把副屏宽度夹到主屏宽度, 高度按同比缩放。
 *
 * 为什么必须这样: 真机实测, 副屏宽度 ≠ 主屏宽度时**主屏桌面**的大时钟会按
 * (副屏宽/主屏宽) 缩放且不自愈 —— 用户看到"时钟被切掉一位"。
 * 尺寸与密度都不参与触发(1200x1200@480 与 1200x2608@320 都正常)。
 *
 * 拿不到主屏宽度(或值不合理)时**原样返回**, 不猜。
 * @returns {{width:number,height:number,snapped:boolean,ratio?:number}}
 */
export function snapWidthToMain(width, height, mainWidth) {
  const w = Number(width), h = Number(height), mw = Number(mainWidth);
  if (!Number.isFinite(mw) || mw <= 0) return { width: w, height: h, snapped: false };
  if (!Number.isFinite(w) || w === mw) return { width: w, height: h, snapped: false };
  const ratio = mw / w;
  return {
    width: mw,
    height: Math.max(1, Math.round(h * ratio)),
    snapped: true,
    ratio,
  };
}

/** 供测试: 副屏几何的纯函数。 */
export const _vdGeom = { snapWidthToMain };


// ═══════════════════════ 虚拟副屏 (PR B) ═══════════════════════
//
// 形状与动作层不同: 副屏守护进程必须**常驻**(它持有 VirtualDisplay),
// 而 screen-mcp 是长驻 MCP stdio 服务 —— 所以这里维护一个从本进程
// spawn 出来的子进程, 生命周期与本 MCP 实例绑定:
//   · 本 MCP 退出 → 子进程随之被杀(它持有 display, 死了 display 就没了,
//     状态文件由下次 vdStart 的过期检查覆盖)
//   · 同一 MCP 实例内只允许一个副屏(再 start 前必须 stop)
//   · shot 走 stdin/stdout 命令协议(<<<VD_END>>> 分帧), 不重建进程
//
// 与动作层共用同一个 dex: VdMain 与 DshActionMain 两个 main 并存,
// app_process 按类名选入口。

const VD_STATUS_FILE = '/data/local/tmp/dsh-vd-status.json';
const VD_STOP_FILE = '/data/local/tmp/dsh-vd-stop';
const VD_END = '<<<VD_END>>>';
const VD_READY = '<<<VD_READY>>>';

let vdChild = null;          // 子进程句柄
let vdInfo = null;           // { displayId, width, height, dpi }
let vdPending = null;        // shot/ping 的应答解析器挂这里
let vdChain = Promise.resolve();

/**
 * 前台守卫: 副屏运行期间, 记录用户在主屏上的前台 App。
 *
 * 为什么必须有它
 * ──────────────
 * 副屏上的 task 一旦失去"容身之处"就会被 WM reparent 回 display 0 **并置顶**,
 * 把用户正在用的 App 顶掉。正常停止路径(vdStop / VdMain.cleanup)已经用
 * "先删栈再释放"挡住了; 但**SIGKILL / OOM 杀死守护进程**时进程来不及清理,
 * Java 侧也捕获不到(实测: 用户在 piliplus, 副屏跑着设置, kill -9 之后
 * 前台立刻变成设置)。这里是在 JS 侧的兜底: 守护进程非正常退出时, 核对主屏
 * 前台是否被换掉, 是就把原来那个 App 拉回来。
 */
let vGuard = null;           // { component, displayId } | null
let vLastGuardRestore = null; // 最近一次"守卫把前台抢回来"的记录(给 vdGet 展示)

/** 读某块屏当前的顶层 Activity 组件名(如 com.example.piliplus/.MainActivity)。 */
async function foregroundComponent(displayId = 0) {
  const r = await run('/system/bin/dumpsys', ['activity', 'activities'], { timeout: 20000 });
  let cur = null;
  for (const line of String(r.stdout || '').split('\n')) {
    const d = line.match(/^Display #(\d+) /);
    if (d) { cur = Number(d[1]); continue; }
    if (cur === Number(displayId) && line.includes('topResumedActivity=')) {
      const a = line.match(/u0 ([^\s]+) t\d+/);
      if (a) return a[1];
    }
  }
  return null;
}

const vdChainRun = (fn) => {
  const p = vdChain.then(fn, fn);
  vdChain = p.catch(() => {});
  return p;
};

function vdStatusJson() {
  try { return JSON.parse(fs.readFileSync(VD_STATUS_FILE, 'utf8')); }
  catch { return null; }
}

/**
 * 启动副屏。幂等: 已在跑且尺寸一致 → 直接返回现有信息; 尺寸不同 → 报错
 * (先 stop)。进程死掉但状态文件还在 → 视为过期, 直接覆盖重启。
 */
export async function vdStart(width, height, dpi) {
  return vdChainRun(async () => {
    // 宽度被夹到主屏宽度时记下原始请求值(供结果回传)。
    let widthSnappedFrom = null;
    if (!fs.existsSync(DEX_PATH)) {
      const e = new Error(DEX_MISSING_HINT);
      e.code = 'dex-missing';
      throw e;
    }
    ensureRunner();
    // 真实几何: 从物理屏推导(与 runner 一样不依赖 root; wm 是系统二进制)。
    // 调用方显式给了三个值就用给定的; 缺哪个补哪个。
    let w = width, h = height, d = dpi;
    let mainW = null, mainH = null, mainDpi = null;
    try {
      const [sz, den] = await Promise.all([
        run('/system/bin/wm', ['size']),
        run('/system/bin/wm', ['density']),
      ]);
      const pm = sz.stdout.match(/(\d+)x(\d+)/);
      const pd = den.stdout.match(/(\d+)/);
      if (pm) { mainW = Number(pm[1]); mainH = Number(pm[2]); }
      if (pd) mainDpi = Number(pd[1]);
    } catch { /* 拿不到就退化: 只信调用方给的值 */ }
    if (w == null) w = mainW;
    if (h == null) h = mainH;
    if (d == null) d = mainDpi;
    if (!Number.isFinite(w) || !Number.isFinite(h) || !Number.isFinite(d)) {
      throw new Error(`副屏几何不完整: ${w}x${h}@${d} —— 传 width/height/dpi 或让设备端推导`);
    }

    // ⚠ 副屏宽度必须与主屏一致，否则会**改坏主屏桌面**（真机实测，见下）
    // ─────────────────────────────────────────────────────────────
    // 现象: 副屏宽度 ≠ 主屏宽度时, 主屏桌面的大时钟/日期组件会按
    //       (副屏宽 / 主屏宽) 缩放, 且**不会自动恢复**。用户看到的是
    //       "时钟被切掉一位"(如 18:17 的 7 只剩右半)。
    // 实测(小米 25102RKBEC / Android 16, 主屏 1200x2608@480):
    //       副屏 1200x2608@480 → 时钟高 326 (正常)
    //       副屏 1200x2608@320 → 时钟高 326 (正常) ← 密度无关
    //       副屏 1200x1200@480 → 时钟高 326 (正常) ← 高度无关
    //       副屏  800x1200@480 → 时钟高 217 (异常) ← 宽度 800/1200 = 0.667
    //       217 / 326 = 0.666 ≈ 800 / 1200
    // 机制: 创建/销毁副屏会让 MIUI 的 AutoDensityController 重算 display 0
    //       的配置(logcat: "on display changed 0 context dpi:478 origin dpi:480"),
    //       桌面据此重新布局; 副屏宽度参与了这次重算。
    // 因此: 把宽度**夹到主屏宽度**, 高度按原比例同比缩放(保住调用方要的宽高比),
    //       于是"省显存"仍然可用 —— 只能靠压高度/密度, 不能压宽度。
    const snapped = snapWidthToMain(w, h, mainW);
    if (snapped.snapped) {
      widthSnappedFrom = { width: w, height: h };
      w = snapped.width;
      h = snapped.height;
    }

    // 幂等: 已在跑且**解析后**的几何一致 → 直接返回现有信息。
    // 必须放在几何解析之后 —— 否则 `screen_vd_start` 不带参数调用第二次时,
    // 会拿 null 去和 vdInfo.width(1200) 比, 误判成"不同尺寸"而报错。
    if (vdChild) {
      if (vdInfo && vdInfo.width === w && vdInfo.height === h && vdInfo.dpi === d) {
        return { ...vdInfo, already: true };
      }
      throw new Error(
        `本实例已有一块副屏 (displayId=${vdInfo?.displayId}, ${vdInfo?.width}x${vdInfo?.height}@${vdInfo?.dpi})。` +
        `不同尺寸请先 screen_vd_stop。`,
      );
    }

    // 孤儿回收: 状态文件 running 且那个进程还活着 —— 但它不是**本实例**的
    // 子进程(MCP 重启后 vdChild 丢失)。没人能再对它 shot/stop, 留着只是
    // 白占一块 display 与一个常驻进程 → 杀掉, 走全新启动。
    // (同一实例内的重复 start 已在上面用 vdChild 拦住, 不会走到这里。)
    const prev = vdStatusJson();
    if (prev && prev.status === 'running') {
      const alive = await run('/system/bin/sh', ['-c', `kill -0 ${Number(prev.pid)} 2>/dev/null && echo alive || echo dead`])
        .then((r) => r.stdout.trim() === 'alive').catch(() => false);
      if (alive) {
        await run('/system/bin/sh', ['-c', `kill ${Number(prev.pid)}; sleep 1; kill -9 ${Number(prev.pid)} 2>/dev/null; rm -f ${VD_STATUS_FILE} ${VD_STOP_FILE}`]);
      } else {
        await run('/system/bin/sh', ['-c', `rm -f ${VD_STATUS_FILE} ${VD_STOP_FILE}`]);
      }
    }

    // env 从继承里来(runner 脚本自己兜底), 这里只挑命令
    const child = spawnProcess('/system/bin/sh', [RUNNER_PATH, 'vd', String(w), String(h), String(d)]);
    // stdout 分发器: 先攒到 READY, 之后把后续数据交给 shot 的应答解析器。
    // 一个 data 监听器贯穿始终 —— 若在 ready 前后各挂一个, ready 那个会一直
    // 占着事件, shot 的应答就没人读了。
    let readySink = '';       // READY 前的缓冲
    let readyDone = false;
    let resolveReady = null;  // 在 data 监听器**之前**声明(TDZ: 回调里引用它)
    child.stdout.on('data', (d) => {
      const s = d.toString('utf8');
      if (!readyDone) {
        readySink += s;
        if (s.includes(VD_READY)) {
          readyDone = true;
          const r = readySink;
          readySink = '';
          if (typeof resolveReady === 'function') resolveReady(r);
        }
      } else if (vdPending) {
        vdPending(s);
      }
    });
    vdChild = child;
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('副屏启动超时 (30s 无 READY)')), 30000);
        // readySink 已在监听器前初始化为 ''; 这里只挂 resolve/超时
        resolveReady = (buf) => { clearTimeout(timer); resolve(buf); };
        child.on('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(`副屏进程提前退出 (code=${code})`));
        });
        child.on('error', (e) => { clearTimeout(timer); reject(e); });
      });
    } catch (e) {
      vdChild = null;
      try { child.kill(); } catch { /* 已死 */ }
      throw e;
    }

    // READY 之后读状态文件拿 displayId
    const st = vdStatusJson();
    if (!st || st.status !== 'running' || !Number.isFinite(st.display_id)) {
      throw new Error(`副屏 READY 但状态文件异常: ${JSON.stringify(st)}`);
    }
    vdInfo = { displayId: st.display_id, width: st.width, height: st.height, dpi: st.dpi };
    if (widthSnappedFrom) vdInfo.widthSnappedFrom = widthSnappedFrom;

    // 记录用户此刻在主屏上的前台 App —— 给"守护进程猝死"兜底用。
    // 只记第一次(后面几轮 vdStart 若已在跑会 early return, 不会覆盖)。
    try {
      const fg = await foregroundComponent(0);
      if (fg) vGuard = { component: fg, displayId: st.display_id, expected: false };
    } catch { /* 拿不到就不守卫, 别因此让 vdStart 失败 */ }

    // 进程退出: 清引用(让下次 vdStart 走全新路径), 并做前台守卫。
    //
    // 正常停止(vdStop)时 vGuard.expected=true, 这里什么都不做 —— 那条路已经
    // "先删栈再释放", 前台本来就不会变。
    // 意外死亡(SIGKILL/OOM/崩溃)时 VdMain 来不及清理, 副屏的 task 会掉回主屏
    // 抢前台; 这里核对一下, 被抢就把用户原来的 App 拉回来。
    child.on('exit', () => {
      if (vdChild === child) { vdChild = null; vdInfo = null; }
      const g = vGuard;
      vGuard = null;
      if (!g || g.expected || !g.component) return;
      void (async () => {
        try {
          const now = await foregroundComponent(0);
          if (now && now !== g.component) {
            await run('/system/bin/am', ['start', '-n', g.component], { timeout: 15000 });
            vLastGuardRestore = { stolenBy: now, restored: g.component };
          }
        } catch { /* 兜底失败也不能抛(在 exit 回调里) */ }
      })();
    });
    return { ...vdInfo, already: false };
  });
}

/**
 * 停止副屏。
 *
 * ⚠ 关键: **先移除副屏上的栈, 再释放副屏** —— 否则会抢主屏前台
 * ──────────────────────────────────────────────────────────────
 * 真机实测(小米 25102RKBEC / Android 16):
 *   · 副屏活着时, 主屏前台全程不受影响(OWN_FOCUS|STEAL_TOP_FOCUS_DISABLED
 *     让两块屏各有各的焦点)
 *   · 但**直接 release 副屏**时, WM 把它承载的 task reparent 回 display 0
 *     且 onTop=true(AOSP 的 moveRootTaskToDisplay 固定置顶) → 用户正在用的
 *     App 被顶掉。实测: 用户在看 piliplus, 释放副屏后前台变成 Settings。
 *   · 正确做法: 副屏还活着时先 `am stack remove <stackId>` 清掉它上面的栈
 *     (task 随栈销毁, 没有东西需要 reparent), 再释放副屏 → 前台不变。
 *     实测三阶段(A/B/C)前台都是同一个 ActivityRecord, 逐字未变。
 *
 * 为什么不用 move-stack 把 task 搬回主屏
 * ─────────────────────────────────────
 * `cmd activity display move-stack` 同样是置顶语义 —— 实测立刻抢走前台。
 * 它的语义是"迁移", 不是"归还", 用在这里就是错的。
 */
/**
 * 列出某块屏上的**真实 App**栈（排除 home/launcher）。
 *
 * 为什么不能直接用 stacksOnDisplay: 副屏**永远**有一个 home 类型的栈
 * （`com.miui.home/.launcher.SecondaryDisplayLauncher`，实测空副屏也有），
 * 拿它当"有 App"会让 screen_vd_stop 永远拒绝。判据用 stack list 里那块屏的
 * `mActivityType=home`。
 *
 * @returns [{ stackId, package }]
 */
export async function appsOnDisplay(displayId) {
  const r = await run('/system/bin/cmd', ['activity', 'stack', 'list'], { timeout: 20000 });
  const out = String(r.stdout || '');
  const res = [];
  let curStack = null, curDisplay = null, isHome = false;
  for (const line of out.split('\n')) {
    const h = line.match(/^RootTask id=(\d+).*displayId=(\d+)/);
    if (h) { curStack = Number(h[1]); curDisplay = Number(h[2]); isHome = false; continue; }
    if (curStack === null || curDisplay !== Number(displayId)) continue;
    if (/mActivityType=home/.test(line)) { isHome = true; continue; }
    const t = line.match(/^\s+taskId=\d+:\s+([A-Za-z0-9._]+)\//);
    if (t && !isHome) res.push({ stackId: curStack, package: t[1] });
  }
  return res;
}

// ── 停止副屏(丢弃内容) ──────────────────────────────────────
//
// ⚠ 实测结论: **销毁承载着 App 的副屏, 用户会看到那个 App 在主屏上闪一下。**
//   机制: 删栈会让 WM 跑一条跨屏 CLOSE 过渡, 把被删 task 的 surface 从副屏
//   尺寸动到**主屏**尺寸上渲染。实测 logcat:
//     onTransitionReady t=CLOSE r=[0@Point(0,0)]
//       ...Task #199 com.tencent.mm  sb=Rect(0,0-800,1200) eb=Rect(0,0-2608,1200) d=22->0
//   sb=副屏尺寸 / eb=**主屏**尺寸 / d=显示从 22 变到 0。用户原话:
//   "闪过去一个悬浮窗一样的东西, 能看到是微信, 闪一下就没了"。
//
//   试过但**无效**的做法(已撤): 删栈期间临时把过渡动画 scale 设 0。
//   用户复看仍然闪, 且那条跨屏过渡记录仍在 —— 所以不成立, 不做无用改动
//   (而且它改的是全局设置, 有副作用)。
//
//   因此默认行为改成: **副屏上有 App 就不销毁**, 报错让调用方明确选:
//     · 要留住状态 → screen_vd_handoff(搬回主屏, 用户接手)
//     · 就是要丢   → 传 force: true(调用方明确接受"会闪一下 + 状态丢失")
//   而 agent 干完活的**默认收尾是什么都不做**: 副屏和 App 都留着, 用户前台
//   一动不动。这也正是参考实现(agent-mobile-use)的做法 —— 它的 stop 路径
//   从不被正常流程调用, `vd.release()` 之前也不清栈。
export async function vdStop({ force = false } = {}) {
  return vdChainRun(async () => {
    if (!vdChild) return { stopped: false, reason: 'no-display' };
    const child = vdChild;
    const info = vdInfo;

    // 0. 副屏上还有**真实 App** → 默认**不销毁**(理由见上面的实测结论)。
    //    注意用 appsOnDisplay 而不是 stacksOnDisplay: 副屏永远有一个 home 栈,
    //    那不算"有 App"(否则空副屏也会被拒)。
    let occupied = [];
    if (info && Number.isFinite(info.displayId)) {
      try { occupied = await appsOnDisplay(info.displayId); } catch { occupied = []; }
    }
    if (occupied.length > 0 && !force) {
      const list = occupied.map((o) => `${o.package}(stack ${o.stackId})`).join(', ');
      return {
        stopped: false, reason: 'occupied',
        displayId: info?.displayId ?? null, apps: occupied,
        detail:
          `副屏(displayId=${info?.displayId}) 上还有 App：${list}。默认不销毁 —— ` +
          `销毁会把它们连状态一起丢掉，而且实测**用户会看到那个 App 在主屏上闪一下**。\n` +
          `要留住状态 → 用 screen_vd_handoff（搬回主屏，用户接手）；\n` +
          `确实要丢   → 传 force: true（调用方明确接受"会闪一下 + 状态丢失"）。\n` +
          `agent 干完活的默认收尾是**什么都不做**：副屏留着，用户前台不受影响。`,
      };
    }

    // 1. 副屏还活着 → 清掉它上面的所有 RootTask
    const removed = [];
    if (info && Number.isFinite(info.displayId)) {
      try {
        const stacks = await stacksOnDisplay(info.displayId);
        for (const s of stacks) {
          const r = await run('/system/bin/am', ['stack', 'remove', String(s)], { timeout: 15000 });
          const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
          removed.push({ stackId: s, ok: !/Error|Exception/i.test(out) });
        }
      } catch { /* 尽力而为: 清不掉也不影响后续释放 */ }
    }

    // 2. 再让守护进程释放副屏
    vdChild = null;
    vdInfo = null;
    // 正常停止: 告知前台守卫"这条路是预期的", 别多此一举去拉 App
    if (vGuard) vGuard.expected = true;
    try { fs.writeFileSync(VD_STOP_FILE, 'stop'); } catch { /* 尽力 */ }
    try { child.stdin.write('quit\n'); } catch { /* 已死 */ }
    child.stdin.end();
    await new Promise((resolve) => {
      const t = setTimeout(() => { try { child.kill(); } catch { /* 已死 */ } resolve(); }, 5000);
      child.on('exit', () => { clearTimeout(t); resolve(); });
    });
    try { fs.unlinkSync(VD_STOP_FILE); } catch { /* 已不在 */ }
    return { stopped: true, displayId: info?.displayId ?? null, clearedStacks: removed, forced: !!force };
  });
}

/**
 * 交接: 把副屏上的 App **搬回主屏**, 连它当前的状态(比如支付界面)一起交给用户。
 *
 * 为什么这个必须存在 —— 它才是"AI 干完活让用户接手"的正确收尾
 * ──────────────────────────────────────────────────────────
 * 典型场景(用户原话): "让 AI 为我选好外卖, 并且留在那个支付界面, 我切过去
 * 就可以付款下单"。这里 **绝不能销毁副屏** —— 销毁会把 App 的状态一起丢掉。
 * 正确做法是把承载它的 task 从副屏搬到主屏: reparent 不重建 Activity,
 * 所以界面停在原处(支付页还是支付页), 用户直接就能操作。
 *
 * 此时抢前台是**期望行为**(用户就是要切过去)。与 vdStop 的区别:
 *   · vdHandoff = 交接    → 搬到主屏并置顶(用户接管)
 *   · vdStop    = 丢弃    → 先清副屏的栈再释放(不打扰用户, 状态一起丢)
 * 两者都保留, 由调用方按意图选。
 */
export async function vdHandoff(pkg, { timeout = 30000 } = {}) {
  return vdChainRun(async () => {
    if (!vdChild || !vdInfo) throw new Error('副屏未运行。先 screen_vd_start。');
    const vdDid = vdInfo.displayId;
    const tasks = await findTasks(pkg);
    const onVd = tasks.find((t) => t.displayId === vdDid && t.isRoot)
      || tasks.find((t) => t.displayId === vdDid);
    if (!onVd) {
      return {
        ok: false, error: 'not-on-vd',
        detail: `${pkg} 在副屏(displayId=${vdDid}) 上没有 task。` +
          `当前: ${tasks.map((t) => `#${t.taskId}@d${t.displayId}`).join(', ') || '(无)'}`,
      };
    }
    const r = await run('/system/bin/cmd', ['activity', 'display', 'move-stack',
      String(onVd.taskId), '0'], { timeout });
    const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
    if (/Error|Exception/i.test(out)) {
      return { ok: false, error: 'move-failed', output: out.slice(0, 300) };
    }
    // 复核: 真的到主屏了吗
    await new Promise((res) => setTimeout(res, 1200));
    const after = await findTasks(pkg);
    const moved = after.find((t) => t.taskId === onVd.taskId);
    if (!moved || moved.displayId !== 0) {
      return {
        ok: false, error: 'move-noop',
        detail: `task #${onVd.taskId} 未到主屏(现在 display ${moved ? moved.displayId : '找不到'})`,
      };
    }
    return { ok: true, taskId: onVd.taskId, from: vdDid, to: 0 };
  });
}

/**
 * 某块屏上最顶层 task 的包名(给"省略 package 的交接"用)。
 * 形如: `  taskId=113: com.android.settings/com.android.settings.Settings ...`
 */
export async function topPackageOnDisplay(displayId) {
  const r = await run('/system/bin/cmd', ['activity', 'stack', 'list'], { timeout: 20000 });
  let cur = null;
  for (const line of String(r.stdout || '').split('\n')) {
    const m = line.match(/^RootTask id=(\d+).*displayId=(\d+)/);
    if (m) { cur = Number(m[2]); continue; }
    if (cur === Number(displayId)) {
      const t = line.match(/^\s+taskId=\d+:\s+([A-Za-z0-9._]+)\//);
      if (t) return t[1];
    }
  }
  return null;
}

/**
 * 副屏截图: JPEG Buffer + 元信息。
 *
 * 历史(排查报告 workspace/123 钉死的一条缺陷, 已修):
 *   VdMain 曾把 PixelFormat.RGBA_8888 的缓冲区按 A,R,G,B 读, 于是 alpha 槽
 *   装进真值 R, 再被 premultiply 一次, 产出确定性色彩变换
 *   (红变蓝、绿变黑、暗部发紫; 白色是不动点所以"白字看着正常")。
 *   修好后本函数不再需要额外色彩校正 —— 若将来又出现通道错位, 用
 *   (255,0,0) 投到副屏采一次: 采到 (255,0,0) 才对, 采到 (0,0,254) 即复发。
 *
 * 注: 这里**不再**声明 maxAgeMs。原先声明了却从未使用, 是个骗人的死参数
 * (调用方传了以为有用)。副屏帧是请求时才取的, 没有缓存可复用, 所以本函数
 * 天然只返回"刚取的那一帧"。
 */
export async function vdShot() {
  return vdChainRun(async () => {
    if (!vdChild || !vdInfo) throw new Error('副屏未运行。先 screen_vd_start。');
    const outPath = `/data/local/tmp/dsh-vd-shot-${Date.now().toString(36)}.jpg`;
    const resp = await vdCommand(`shot ${vdInfo.displayId} ${Buffer.from(outPath, 'utf8').toString('base64')}`);
    let json;
    try { json = JSON.parse(resp); } catch { throw new Error(`shot 应答不可解析: ${resp.slice(0, 200)}`); }
    if (!json.ok) throw new Error(`副屏截图失败: ${json.error || '未知'}`);
    const jpeg = fs.readFileSync(outPath);
    fs.unlinkSync(outPath);
    if (jpeg.length < 3 || jpeg[0] !== 0xFF || jpeg[1] !== 0xD8) {
      throw new Error(`截图不是合法 JPEG (${jpeg.length} B)`);
    }
    // 无缓存可复用: 每一帧都是本次现取的, 如实报为不一致于主屏的语义
    return {
      jpeg, displayId: vdInfo.displayId, costMs: json.cost_ms,
      width: vdInfo.width, height: vdInfo.height,
      fromCache: false, frameTimestamp: Date.now(),
    };
  });
}

/** 副屏信息(树/动作工具要用 displayId)。 */
export function vdGet() { return vdInfo ? { ...vdInfo } : null; }

// ── 把 App 放到指定屏（副屏承载的关键路径）────────────────────
//
// 为什么不是简单地 `am start --display N`
// ──────────────────────────────────────
// 真机实测(小米 25102RKBEC / Android 16):
//   · 对**已运行**的 singleTask App(微信), `am start --display N` 不会新建实例,
//     系统把 intent 交给主屏上那个既有实例(输出 "Warning: Activity not started,
//     intent has been delivered to currently running top-most instance"),
//     结果是**把用户正在看的 App 拉到前台** —— 这既没上副屏, 又打扰了用户。
//   · 对**未运行**的 App, `am start --display N` 是有效的(冷启动直接建在副屏)。
// 正确做法分两路:
//   已有 task → `cmd activity display move-stack <rootTaskId> <displayId>`
//                (真机验证: 微信 task 移到副屏, 副屏窗口 mCurrentFocus 变成微信;
//                 副屏销毁后自动回主屏, 不丢状态)
//   没有 task → `am start --display <id>`
//
// 前置条件: LSPosed hook 必须已生效(见 uiaction/hook/DshHookEntry.java), 否则
// move-stack 报 "moveRootTaskToDisplay: Unknown displayId=N"(实测)。

/**
 * 找出某个包当前所有 task 及其所在 display。
 * 解析 dumpsys activity activities 的 "Display #N" 分段 + "Task{... #id ...}" 行。
 * 返回 [{ taskId, displayId, isRoot, visible }]，按 taskId 升序。
 */
export async function findTasks(pkg) {
  const out = await run('/system/bin/sh', [
    '-c',
    // awk 追踪最近的 Display # 表头, 把 Task 行归到它名下。
    // 不用 grep -B: 表头与 Task 之间还有别的行, -B 的窗口大小不可靠。
    `dumpsys activity activities 2>/dev/null | awk -v pkg="${pkg.replace(/"/g, '')}" '
       /^Display #/ { d=$2; sub("#","",d) }
       /Task\\{/ && $0 ~ ("A=[0-9]*:" pkg) {
         line=$0
         if (match(line, /#[0-9]+/)) { t=substr(line, RSTART+1, RLENGTH-1); print d" "t" "line }
       }'`,
  ], { timeout: 20000 });
  const tasks = [];
  for (const line of String(out.stdout || '').split('\n')) {
    const m = line.match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const rest = m[3];
    tasks.push({
      displayId: Number(m[1]),
      taskId: Number(m[2]),
      isRoot: /rootOfTask=true/.test(rest),
      visible: /visible=true/.test(rest),
      raw: rest.slice(0, 200),
    });
  }
  return tasks;
}

/**
 * 列出某块屏上的 RootTask id。
 * 用于副屏销毁前的清栈: 必须先把它们 remove 掉, 否则 release 时 reparent 会抢前台。
 */
export async function stacksOnDisplay(displayId) {
  const r = await run('/system/bin/cmd', ['activity', 'stack', 'list'], { timeout: 20000 });
  const out = String(r.stdout || '');
  const ids = [];
  let cur = null;
  for (const line of out.split('\n')) {
    // 形如: RootTask id=113 bounds=[0,0][800,1200] displayId=11 userId=0
    const m = line.match(/^RootTask id=(\d+).*displayId=(\d+)/);
    if (m) {
      cur = { id: Number(m[1]), displayId: Number(m[2]) };
      if (cur.displayId === Number(displayId)) ids.push(cur.id);
      continue;
    }
  }
  return ids;
}

/**
 * 把 App 放到目标屏。
 *
 * ⚠ 设计红线: **只在副屏原生启动, 绝不搬运主屏的 task**
 * ────────────────────────────────────────────────────
 * 真机实测教训:
 *   · `am start --display N`(不带 MULTIPLE_TASK)对已运行的 singleTask App
 *     (微信)会把 intent 交给主屏那个既有实例 → **把用户正在看的 App 拉到前台**
 *   · `cmd activity display move-stack <taskId> <displayId>` 是"迁移"语义,
 *     实测立刻抢走前台; 副屏销毁时 task 又被 reparent 回来再抢一次
 *   · `am start -f 0x18000000 --display N`(NEW_TASK|MULTIPLE_TASK)会在副屏
 *     **新建一个独立 task**, 主屏那边完全不碰 —— 实测期间主屏前台逐字未变
 *
 * 所以这里固定用第三种。副屏上跑的是同一 App 的**另一个 task**(同一账号/进程),
 * 不是分身用户, 也不动用户手上那个实例。
 *
 * @returns { ok, method, displayId, taskId?, output, error?, detail? }
 */
/**
 * 解析某个包的启动 Activity, 返回 "包/Activity"(如 com.tencent.mm/.ui.LauncherUI)。
 *
 * 为什么需要: `am start -n` 只接受组件全称, 给裸包名会报
 * `IllegalArgumentException: Bad component name`。而 screen_app 的常见调用是
 * `{ package: "com.tencent.mm" }`(不写 activity), 所以必须先解析。
 * 解析失败返回 null —— 由调用方如实报错, 不猜一个组件名。
 */
export async function resolveLaunchActivity(pkg, { timeout = 15000 } = {}) {
  const r = await run('/system/bin/cmd', ['package', 'resolve-activity', '--brief', pkg], { timeout });
  const out = String(r.stdout || '');
  // 输出末尾一行就是答案, 形如:
  //   priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=false
  //   com.tencent.mm/.ui.LauncherUI
  const m = out.match(/^\s*([A-Za-z0-9._]+)\/([A-Za-z0-9._$]+)\s*$/m);
  return m ? `${m[1]}/${m[2]}` : null;
}

export async function launchOnDisplay(displayId, pkg, activity = null, { timeout = 30000 } = {}) {
  const target = Number(displayId);
  const FLAG_NEW_TASK_MULTIPLE = '0x18000000'; // NEW_TASK | MULTIPLE_TASK

  // `am start -n` 要的是 "包/Activity" 全称 —— 只给包名会被直接拒:
  //   java.lang.IllegalArgumentException: Bad component name: com.tencent.mm
  // (真机踩到: 此前所有手测都显式带了 activity, 所以这个分支一直没被走到。)
  // 没给 activity 时先解析该包的启动 Activity。
  let component = activity ? `${pkg}/${activity}` : null;
  if (!component) {
    component = await resolveLaunchActivity(pkg);
    if (!component) {
      return {
        ok: false, method: 'am-start-multiple', displayId: target,
        error: 'resolve-activity-failed',
        detail: `解析不出 ${pkg} 的启动 Activity(cmd package resolve-activity 无结果)。` +
          `请显式传 activity 参数, 或用 screen_app 的 dryRun 先确认包名。`,
      };
    }
  }

  const args = ['start', '-f', FLAG_NEW_TASK_MULTIPLE, '--display', String(target), '-n', component];
  const r = await run('/system/bin/am', args, { timeout });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();

  if (/Error|Exception|not found|does not exist/i.test(out)) {
    return {
      ok: false, method: 'am-start-multiple', displayId: target,
      output: out.slice(0, 400), error: 'am-start-failed',
      detail: `在 display ${target} 上启动 ${pkg} 失败。跨屏承载需要 LSPosed hook 生效; ` +
        `缺 hook 时 WM 会拒绝把 task 放到虚拟屏。`,
    };
  }

  // 复核: 目标屏上真的出现了该包的 task 吗(不靠命令退出码 —— 它可能为 0 而实际没动)
  //
  // ⚠ 这里原本只 sleep 1200ms 就查一次, 会**假阴性**: task 注册晚于 am 返回时,
  //   明明已经上屏了却报 `launch-not-on-target`(排查报告 §4.1 实测: 同一时刻
  //   screen_targets 读到 93 个节点、com.android.browser 确在副屏)。
  //   改成轮询等待: 最多 ~9s, 每 600ms 一次, 命中即返回。
  let onTarget = null;
  for (let i = 0; i < 15; i++) {
    await new Promise((res) => setTimeout(res, 600));
    const after = await findTasks(pkg);
    onTarget = after.find((t) => t.displayId === target);
    if (onTarget) break;
  }
  if (!onTarget) {
    const after = await findTasks(pkg);
    return {
      ok: false, method: 'am-start-multiple', displayId: target,
      output: out.slice(0, 300), error: 'launch-not-on-target',
      detail: `命令已发但等了 ~9s, display ${target} 上仍没有 ${pkg} 的 task。` +
        `当前该包 task: ${after.map((t) => `#${t.taskId}@d${t.displayId}`).join(', ') || '(无)'}`,
    };
  }
  return {
    ok: true, method: 'am-start-multiple', displayId: target,
    taskId: onTarget.taskId, output: out.slice(0, 200),
  };
}



/**
 * 任意屏的控件树(含副屏): 一次一进程走 dex 的 tree 命令。
 *
 * 与注入共用"挂服务→fork→还原"的纪律: 微信只在真实无障碍服务绑定时才交出树
 * (副屏也一样, 实测 app_nodes 0→24)。结果是一行 JSON(node_count/nodes[])。
 */
export async function fetchTree(displayId, { timeout = 45000 } = {}) {
  return chain(async () => {
    if (!fs.existsSync(DEX_PATH)) {
      const e = new Error(DEX_MISSING_HINT);
      e.code = 'dex-missing';
      throw e;
    }
    ensureRunner();
    await reconcileA11y();
    const { detach } = await attachA11yService();
    try {
      let res;
      try {
        res = await run('/system/bin/sh', [RUNNER_PATH, 'tree', String(Number(displayId))], { timeout });
      } catch (e) {
        // 同 injectText: exit 3 可能带业务 JSON(如树读不到), 先解析再定失败
        const out = String(e.stdout || '');
        const end = out.indexOf('<<<END_OF_JSON>>>');
        const line = (end >= 0 ? out.slice(0, end) : out)
          .split('\n').map((s) => s.trim()).filter(Boolean).pop();
        if (line) {
          try { return JSON.parse(line); } catch { /* 落到真失败 */ }
        }
        const se = String(e.stderr || '').trim();
        throw new Error(
          `树进程失败(无业务结论): ${e.message}\n  stderr: ${se ? se.slice(0, 500) : '(空)'}`,
        );
      }
      const out = String(res.stdout || '');
      const end = out.indexOf('<<<END_OF_JSON>>>');
      const line = (end >= 0 ? out.slice(0, end) : out)
        .split('\n').map((s) => s.trim()).filter(Boolean).pop();
      if (!line) throw new Error('树进程无输出');
      try { return JSON.parse(line); }
      catch { throw new Error(`树进程输出不可解析: ${line.slice(0, 200)}`); }
    } finally {
      await detach();
    }
  });
}

/** 向副屏守护进程发一条命令, 等 <<<VD_END>>> 分帧的应答。 */
function vdCommand(cmd) {
  return new Promise((resolve, reject) => {
    const child = vdChild;
    if (!child) { reject(new Error('副屏进程不在')); return; }
    let buf = '';
    const timer = setTimeout(() => {
      vdPending = null;
      reject(new Error(`副屏命令超时 (${cmd.split(' ')[0]})`));
    }, 30000);
    vdPending = (data) => {
      buf += data;
      const idx = buf.indexOf(VD_END);
      if (idx >= 0) {
        clearTimeout(timer);
        vdPending = null;
        resolve(buf.slice(0, idx).trim());
      }
    };
    try { child.stdin.write(cmd + '\n'); }
    catch (e) { clearTimeout(timer); vdPending = null; reject(e); }
  });
}

/** 与 runCommand 的 execFile 并列: 这里要的是流式子进程(常驻 stdin/stdout)。 */
function spawnProcess(cmd, args) {
  return execFileCb(cmd, args, {
    maxBuffer: 4 * 1024 * 1024,
    env: envForCommand(cmd),
  });
}
