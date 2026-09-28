// 用法: node probe/tools/webui-ui-test.mjs   (在仓库根目录跑)
// WebUI 行为测试: 用 mock DOM + mock ksu 跑真实的 script, 喂真实设备输出。
// 目的是验证"解析 dshctl 输出"和"token 掩码/交互绑定"这两处会出错的地方,
// 而不是靠肉眼看 HTML。
import fs from 'node:fs';

const html = fs.readFileSync('dsh/module/webroot/index.html', 'utf8');
const js = html.match(/<script>([\s\S]*?)<\/script>/)[1];

/* ── 真实设备输出样本 (从 adb 抓的原文) ─────────────────────── */
const STATUS_RUNNING = [
  '状态: 运行中',
  '  pid 25101',
  '  监督进程 pid 25099',
  '监听: 127.0.0.1:3080 (仅本机)',
  '端口: 3080 已在监听',
  'HTTP: 401 (401 = 在跑但要求鉴权, 属正常)',
].join('\n');

const STATUS_STOPPED = [
  '状态: 未运行',
  '用 /data/adb/modules/dsh_android/bin/dshctl start 拉起, 或重启手机让 service.sh 自动拉起',
].join('\n');

const TOKEN = 'YtQr9Hvb34NnQLT0cARdE4UaFmtyQU9JDCnTOHKytFk';
const URL_FULL = 'http://127.0.0.1:3080/?token=' + TOKEN;

/* ── 可切换的 mock 状态 ─────────────────────────────────────── */
let statusOut = STATUS_RUNNING;
let tokenOut = TOKEN;
let urlOut = URL_FULL;
const execLog = [];
const spawnLog = [];

/* ── 最小 DOM mock ──────────────────────────────────────────── */
function mkEl(tag) {
  return {
    tag, id: '', textContent: '', className: '', href: '',
    children: [], _kids: [], firstChild: null, dataset: {}, style: {},
    onclick: null,
    appendChild(c) { this._kids.push(c); this.children = this._kids; this.firstChild = this._kids[0] || null; return c; },
    removeChild(c) { const i = this._kids.indexOf(c); if (i >= 0) this._kids.splice(i, 1); this.children = this._kids; this.firstChild = this._kids[0] || null; return c; },
    setAttribute() {}, removeAttribute() {}, select() {}, focus() {},
  };
}
const els = {};
function el(id) { if (!els[id]) { els[id] = mkEl('div'); els[id].id = id; } return els[id]; }

global.document = {
  getElementById: el,
  createElement: mkEl,
  body: mkEl('body'),
  execCommand: () => true,
};
global.window = global;
global.ksu = {
  exec(cmd, _opts, cb) { execLog.push(cmd); setTimeout(() => global[cb](0, routeExec(cmd), ''), 0); },
  // 按 WebViewInterface.kt 的真实行为模拟: 逐行 emit('data'), 最后 emit('exit')。
  // 注意它在 Kotlin 侧是 `window[cb].stdout.emit('data', 一行)`, 且每行不带换行。
  spawn(command, argsJson, _opts, cb) {
    spawnLog.push({ command, args: JSON.parse(argsJson) });
    const lines = [
      'dsh web: http://127.0.0.1:3080/?token=<已掩码: dshctl token>',
      '状态: 运行中',
    ];
    let i = 0;
    const step = () => {
      if (i < lines.length) { global[cb].stdout.emit('data', lines[i++]); setTimeout(step, 0); }
      else { global[cb].emit('exit', 0); }
    };
    setTimeout(step, 0);
  },
  toast() {},
  moduleInfo() { return JSON.stringify({ id: 'dsh_android' }); },
};
function routeExec(cmd) {
  if (/status$/.test(cmd)) return statusOut;
  if (/ token$/.test(cmd)) return tokenOut;
  if (/ url$/.test(cmd)) return urlOut;
  return '';
}

/* ── 跑真实 script ──────────────────────────────────────────── */
eval(js);
const tick = () => new Promise(r => setTimeout(r, 5));

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log('  [OK]   ' + label); }
  else { fail++; console.log('  [FAIL] ' + label + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}

await tick(); await tick();

console.log('==== 1) 模块 id 与命令路径 (来自 moduleInfo) ====');
check('modinfo 里用了 KernelSU 给的 id',
  /dsh_android/.test(el('modinfo').textContent), el('modinfo').textContent);
check('命令是绝对路径 /data/adb/modules/<id>/bin/dshctl',
  execLog.some(c => c === '/data/adb/modules/dsh_android/bin/dshctl status'), execLog);

console.log('\n==== 2) 运行中状态解析 ====');
check('stateText = 运行中', el('stateText').textContent === '运行中', el('stateText').textContent);
check('dot 带 on 类', el('dot').className === 'dot on', el('dot').className);
const dlText = el('detail')._kids.map(k => k.textContent).join(' | ');
check('解析出进程 pid', /25101/.test(dlText), dlText);
check('解析出监督进程', /25099/.test(dlText), dlText);
check('解析出端口', /3080 已在监听/.test(dlText), dlText);
check('HTTP 行的人话说明', /401 = 在跑但要求 token/.test(dlText), dlText);
check('没有残留错误提示', el('err').className.includes('hidden'), el('err').className);

console.log('\n==== 3) 未运行状态 (切到停止样本后刷新) ====');
statusOut = STATUS_STOPPED;
el('bRefresh').onclick();
await tick(); await tick();
check('stateText = 未运行', el('stateText').textContent === '未运行', el('stateText').textContent);
check('dot 带 off 类', el('dot').className === 'dot off', el('dot').className);

console.log('\n==== 4) token 不再单独展示 (同一个值放两处 = 泄露面翻倍) ====');
// 断言写在 HTML 源上, 而不是"mock 里元素不存在" —— 我的 el() 是按需创建的,
// 查元素存在性会给出假阴性。
check('HTML 里没有 tokenBox 节点', !/id="tokenBox"/.test(html));
check('HTML 里没有 取 token / 显示 按钮', !/id="bToken"|id="bReveal"/.test(html));
check('JS 里没有 maskToken/paintToken/realToken 残留',
  !/maskToken|paintToken|realToken|revealed/.test(js));
check('.mask 样式已随之下线', !/\.mask\s*\{/.test(html));

console.log('\n==== 5) 取链接: token 只在这一个地方出现 ====');
el('bUrl').onclick();
await tick(); await tick();
check('urlBox 文本是完整链接', el('urlBox').textContent === URL_FULL, el('urlBox').textContent);
check('urlBox href 已设置', el('urlBox').href === URL_FULL, el('urlBox').href);
check('去掉 disabled 类', !el('urlBox').className.includes('disabled'), el('urlBox').className);
// 复制走的是 realUrl, 不依赖已删除的 token 变量
el('bCopy').onclick();
await tick();
check('复制未走失败分支', !/复制失败/.test(el('err').textContent), el('err').textContent);

console.log('\n==== 6) 静态命令检查: 没有任何用户输入进入命令 ====');
const CTL_PATH = '/data/adb/modules/dsh_android/bin/dshctl';
// 两条通路的形状本来就不同, 断言必须分开写:
//   exec  → 整条命令是 `CTL + ' 子命令'` (字符串)
//   spawn → command 就是裸 CTL, 子命令在 args 数组里 (KernelSU 侧再拼回去)
const ALLOWED = ['status', 'url'];
check('exec 命令都是 CTL + 固定子命令 (status/url)',
  execLog.every(c => ALLOWED.some(s => c === CTL_PATH + ' ' + s)), execLog);
// 点完所有按钮之后再确认一次: 页面从不取裸 token (真值只随 url 来)
check('页面从不执行 dshctl token',
  !execLog.some(c => / token$/.test(c)), execLog);
// 启停已交给「执行」按钮: 本页必须发不出任何写命令。
// 这条是安全不变量, 不是样式偏好 —— 它保证将来页面被注入时最坏只是读到日志。
check('HTML 里没有启停按钮 (操作卡已下线)',
  !/id="bStart"|id="bStop"|id="bRestart"|<h2>操作<\/h2>/.test(html));
check('JS 里没有 runOp/armConfirm 残留', !/runOp|armConfirm/.test(js));
check('页面从不执行写命令 (start/stop/restart/toggle)',
  !execLog.concat(spawnLog.map(s => s.args.join(' '))).some(c => /\b(start|stop|restart|toggle)\b/.test(c)),
  { execLog, spawnLog: spawnLog.map(s => s.args) });
check('spawn 的 command 恰为裸 CTL (子命令走 args)',
  spawnLog.every(s => s.command === CTL_PATH), spawnLog.map(s => s.command));
check('spawn 只出现 log, 且行数来自白名单常量',
  spawnLog.every(s => s.args.length === 2 && s.args[0] === 'log' && [20, 40, 100].includes(Number(s.args[1]))),
  spawnLog);

console.log('\n==== 7) 日志区: spawn 协议与逐行渲染 ====');
// 档位 chips 的数量: 真机截图上曾经出现 6 个 (20/40/100 各两份), 因为
// buildChips() 在 init 里被调了两次 —— 这种"多渲染一份"的缺陷 mock DOM 才抓得到,
// 之前只靠肉眼看截图, 所以补成断言。
check('日志档位恰好 3 个 (无重复渲染)',
  el('logChips').children.length === 3, el('logChips').children.length);
check('档位值 = 20/40/100',
  el('logChips').children.map(c => c.textContent).join(',') === '20 行,40 行,100 行',
  el('logChips').children.map(c => c.textContent));
await tick(); await tick(); await tick();
const logText = el('logBody').textContent;
check('spawn 的 stdout 逐行进了日志区', /已掩码: dshctl token/.test(logText), JSON.stringify(logText));
// 真机上出现过 "读取中…  HOME=/data/adb/dsh/workspace" —— 占位符没整行换掉,
// 和第一行拼在了一起。用正则查内容是查不出这种前缀污染的。
check('占位符"读取中…"已被换掉 (不与日志同行)', !/读取中/.test(logText), JSON.stringify(logText));
check('首行就是日志内容', logText.split('\n')[0].includes('dsh web'), JSON.stringify(logText.split('\n')[0]));
check('多行都渲染了 (不是只留最后一行)', /状态: 运行中/.test(logText), JSON.stringify(logText));
check('日志里没有明文 token', !logText.includes(TOKEN), JSON.stringify(logText));
el('logChips').children[0].onclick();
await tick(); await tick(); await tick();
check('点 20 行档位后 spawn args = ["log","20"]',
  spawnLog[spawnLog.length - 1].args[1] === '20', spawnLog[spawnLog.length - 1]);

console.log('\n==== 汇总: ' + pass + ' 通过 / ' + fail + ' 失败 ====');
process.exitCode = fail === 0 ? 0 : 1;
