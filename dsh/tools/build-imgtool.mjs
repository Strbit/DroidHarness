#!/usr/bin/env node
/**
 * build-imgtool.mjs — 编译 imgtool 的两个目标。
 *
 * 为什么不在仓库里直接放编译好的二进制
 * ------------------------------------
 * 这个仓库对大二进制的一贯做法是"构建时取"（usr/ 那 99MiB 的 Node 运行时由
 * fetch-runtime.mjs 下载），而不是提交进来。imgtool 没有可下载的官方发行物，
 * 所以只能**本地编译**：装机用的 aarch64 静态可执行文件由这个脚本产出，放到
 * 模块应用树里（build-dsh-tree.mjs 负责拷）。代价是打包机器需要 Go —— 缺了
 * 会在打包阶段明确报错并给出修复命令，不会悄悄产出一个没有屏幕识别的包。
 *
 *   · windows/amd64        → .build/imgtool/imgtool.exe       (PC 测试用)
 *   · linux/arm64 CGO=0    → .build/imgtool/imgtool-linux-arm64
 *                            (装机用; 静态链接、无解释器, 真机 root 直接 exec。
 *                             GOOS=linux 而不是 android: android 目标需要 cgo,
 *                             而这个工具一行 cgo 都没有 —— 产出的就是纯静态 ELF)
 *
 * 用法:
 *   node dsh/tools/build-imgtool.mjs            两个都编
 *   node dsh/tools/build-imgtool.mjs --only=win  只编 PC 版
 *   GO=/path/to/go node dsh/tools/build-imgtool.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const SRC = path.join(ROOT, 'tools', 'imgtool');
const OUT = path.join(ROOT, '.build', 'imgtool');

const log = (m) => console.log(m);
const die = (m) => {
  console.error(m);
  process.exit(1);
};

/** 找 Go: 环境变量 → PATH → 便携安装位置（本轮就是这样装的）。 */
function findGo() {
  if (process.env.GO) return process.env.GO;
  const r = spawnSync('go', ['version'], { encoding: 'utf8' });
  if (!r.error && r.status === 0) return 'go';
  const portable = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'go', 'bin', 'go.exe');
  if (fs.existsSync(portable)) return portable;
  return null;
}

const only = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7);

if (!fs.existsSync(path.join(SRC, 'main.go'))) die(`! 找不到 ${path.join(SRC, 'main.go')}`);
const go = findGo();
if (!go) {
  die(
    '! 找不到 Go 工具链。安装方式二选一:\n' +
      '    winget install GoLang.Go            (或)\n' +
      '    # 便携版: 解压 go*.windows-amd64.zip 到 %LOCALAPPDATA%\\Programs\\go\n' +
      '  也可以显式指定: GO=D:\\go\\bin\\go.exe node dsh/tools/build-imgtool.mjs',
  );
}
const ver = spawnSync(go, ['version'], { encoding: 'utf8' });
log(`== imgtool 编译 ==`);
log(`go: ${(ver.stdout || ver.stderr || '').trim()}`);

fs.mkdirSync(OUT, { recursive: true });

// 国内镜像: 依赖里只有 golang.org/x/image, 官方 proxy 常常连不上。
// 不影响已缓存的情况；显式设过 GOPROXY 就尊重用户的。
const env = {
  ...process.env,
  GOPROXY: process.env.GOPROXY || 'https://mirrors.aliyun.com/goproxy/,https://goproxy.cn,direct',
  GOFLAGS: process.env.GOFLAGS || '',
  CGO_ENABLED: '0',
};

const targets = [
  { key: 'win', label: 'PC (windows/amd64)', goos: 'windows', goarch: 'amd64', out: 'imgtool.exe', strip: true },
  { key: 'arm64', label: '装机 (linux/arm64, 静态)', goos: 'linux', goarch: 'arm64', out: 'imgtool-linux-arm64', strip: true },
].filter((t) => !only || t.key === only);

if (targets.length === 0) die(`! --only=${only} 不认识 (可选: win / arm64)`);

const results = [];
for (const t of targets) {
  const dest = path.join(OUT, t.out);
  const args = ['build', '-trimpath', '-o', dest];
  if (t.strip) args.push('-ldflags=-s -w');
  args.push('.');
  const r = spawnSync(go, args, {
    cwd: SRC,
    encoding: 'utf8',
    env: { ...env, GOOS: t.goos, GOARCH: t.goarch },
  });
  if (r.status !== 0) die(`! ${t.label} 编译失败:\n${(r.stdout || '') + (r.stderr || '')}`);
  const buf = fs.readFileSync(dest);
  const sha = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
  results.push({ ...t, dest, size: buf.length, sha });
  log(`  ✓ ${t.label}: ${path.relative(ROOT, dest)}  ${(buf.length / 1024).toFixed(0)} KiB  sha256:${sha}`);
}

// 装机版必须是 aarch64 静态 ELF —— 这两点弄错了, 真机上就是"命令找不到"
// 或"没有那个文件或目录"(动态链接的解释器不存在), 而且报错完全指不到这里。
const arm = results.find((r) => r.key === 'arm64');
if (arm) {
  const b = fs.readFileSync(arm.dest);
  const okMagic = b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46;
  const okClass = b[4] === 2; // 64bit
  const okEndian = b[5] === 1; // little
  const machine = b[18] | (b[19] << 8);
  const okMachine = machine === 0xb7; // aarch64
  const okType = b[16] === 2; // ET_EXEC (静态, 不是 ET_DYN/需要解释器)
  if (!(okMagic && okClass && okEndian && okMachine && okType)) {
    die(
      `! 装机版不是预期的 aarch64 静态 ELF: magic=${okMagic} class=${okClass} le=${okEndian}` +
        ` machine=0x${machine.toString(16)} type=${b[16]} —— 真机上会起不来`,
    );
  }
  log(`  ✓ 装机版 ELF 校验通过: aarch64 / 64bit / ET_EXEC(无解释器)`);
}

log(`\n产出目录: ${path.relative(ROOT, OUT)}`);
