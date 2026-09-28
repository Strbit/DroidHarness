// adb -- 设备访问层
//
// 设计约束(来自 docs/mobile-control-layer-design.md §7 设计纪律):
//   · 所有平台路径运行时发现, 不硬编码
//   · 探测失败就报错, 不用默认值兜底(静默错坐标比报错危险得多)
//   · 控制层里不允许出现 "dsh" 这个词 —— 本模块与 harness 完全解耦
//
// 设备侧文件策略: 只往 /data/local/tmp 写临时文件, 且用完立即删除。
// 用户存储(/sdcard)一律不碰。

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const execFileAsync = promisify(execFile);

// 设备侧临时目录: 系统为每个 app 准备的、可写且不在用户存储里的位置
export const DEVICE_TMP = '/data/local/tmp';

// PC 侧临时目录
// 名字刻意保持中性: 识别层不绑任何 harness, 换 harness 时这里一行不改。
export function pcTmpDir() {
  const d = path.join(os.tmpdir(), 'mobile-recognize');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export class AdbError extends Error {
  constructor(message, { code, stderr, argv } = {}) {
    super(message);
    this.name = 'AdbError';
    this.code = code;
    this.stderr = stderr;
    this.argv = argv;
  }
}

/**
 * 定位 adb。不硬编码路径:
 *   1. PATH 里能找到就用它
 *   2. 否则试几个常见安装位置, 逐个验证可执行
 *   3. 都失败就报错, 并告诉用户怎么指定
 */
export function findAdb() {
  const fromEnv = process.env.ADB;
  if (fromEnv) {
    if (!fs.existsSync(fromEnv)) {
      throw new AdbError(`ADB 环境变量指向的文件不存在: ${fromEnv}`);
    }
    return fromEnv;
  }

  const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const names = process.platform === 'win32' ? ['adb.exe', 'adb'] : ['adb'];
  for (const dir of pathDirs) {
    for (const name of names) {
      const cand = path.join(dir, name);
      try {
        if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand;
      } catch { /* 无权限等, 跳过 */ }
    }
  }

  const guesses = process.platform === 'win32'
    ? ['D:\\platform-tools\\adb.exe', 'C:\\platform-tools\\adb.exe',
       path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk', 'platform-tools', 'adb.exe')]
    : ['/usr/bin/adb', '/usr/local/bin/adb', path.join(os.homedir(), 'Android/Sdk/platform-tools/adb')];

  for (const g of guesses) {
    try {
      if (g && fs.existsSync(g) && fs.statSync(g).isFile()) return g;
    } catch { /* 跳过 */ }
  }

  throw new AdbError(
    '找不到 adb。请把它放进 PATH, 或用环境变量 ADB 指定完整路径, ' +
    '例如: set ADB=D:\\platform-tools\\adb.exe'
  );
}

export class Device {
  constructor({ adbPath, serial } = {}) {
    this.adb = adbPath || findAdb();
    this.serial = serial || null;
  }

  argv(args) {
    const base = this.serial ? ['-s', this.serial] : [];
    return [...base, ...args];
  }

  /** 执行 adb, 返回 stdout 字符串(二进制用 execOut) */
  async shell(command, { asRoot = false } = {}) {
    const cmd = asRoot ? `su -c ${shQuote(command)}` : command;
    try {
      const { stdout } = await execFileAsync(this.adb, this.argv(['shell', cmd]), {
        maxBuffer: 64 * 1024 * 1024,
        encoding: 'utf8',
        windowsHide: true,
      });
      return stdout;
    } catch (e) {
      throw new AdbError(`adb shell 失败: ${command}`, {
        code: e.code, stderr: e.stderr, argv: this.argv(['shell', cmd]),
      });
    }
  }

  /** 执行 adb, 返回原始 Buffer(截屏等二进制必须走这条) */
  async execOut(args) {
    try {
      const { stdout } = await execFileAsync(this.adb, this.argv(['exec-out', ...args]), {
        maxBuffer: 256 * 1024 * 1024,
        encoding: 'buffer',
        windowsHide: true,
      });
      return stdout;
    } catch (e) {
      throw new AdbError(`adb exec-out 失败: ${args.join(' ')}`, { code: e.code, stderr: e.stderr });
    }
  }

  /** 连接状态 */
  async devices() {
    const out = await this.shell('echo ok').catch(() => null);
    if (out === null) return [];
    const raw = await execFileAsync(this.adb, ['devices', '-l'], { encoding: 'utf8', windowsHide: true });
    return raw.stdout.split('\n').slice(1)
      .map((l) => l.trim()).filter(Boolean)
      .map((l) => {
        const [serial, state] = l.split(/\s+/);
        const model = (l.match(/model:(\S+)/) || [])[1] || null;
        return { serial, state, model };
      });
  }

  /** 是否有 root(su 可用) —— 运行时探测, 不假设 */
  async hasRoot() {
    try {
      const out = await this.shell('id', { asRoot: true });
      return /\buid=0\(root\)/.test(out);
    } catch {
      return false;
    }
  }

  /** 设备侧临时文件的唯一路径 */
  deviceTempPath(tag) {
    const rand = Math.random().toString(36).slice(2, 10);
    return `${DEVICE_TMP}/rec-${tag}-${process.pid}-${rand}`;
  }

  /** 删除设备侧临时文件(silent) */
  async removeDeviceFile(p) {
    if (!p || !p.startsWith(DEVICE_TMP)) {
      throw new AdbError(`拒绝删除 ${DEVICE_TMP} 之外的文件: ${p}`);
    }
    try {
      await this.shell(`rm -f ${shQuote(p)}`);
    } catch { /* 清理失败不致命 */ }
  }
}

/** POSIX shell 单引号转义 */
export function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}
