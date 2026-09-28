// spawn-env 自检: 子进程环境分类
//
// 这个测试存在的理由很具体: PR #11 的阻断问题(LD_LIBRARY_PATH 打死 uiautomator)
// 之所以逃过 39 项单测, 是因为那些测试全在测纯函数, 而唯一覆盖端到端路径的
// test-screen-mcp.mjs 恰好没有断言。所以这里的每一条都是**真断言**, 且
// 通过注入 spawnImpl 在无设备的机器上验证"传下去的环境到底是什么"。
import { envForCommand, isSystemBinary, runCommand } from './lib/spawn-env.mjs';

let pass = 0, fail = 0;
const tests = [];
let group = null;
const g = (n) => { group = n; };
const t = (name, fn) => tests.push({ name, fn, group });
const eq = (a, b, m) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${m || ''}: 期望 ${JSON.stringify(b)}, 得到 ${JSON.stringify(a)}`);
  }
};
const ok = (c, m) => { if (!c) throw new Error(m || '断言失败'); };

// 模拟 DSH 服务的 environ —— 这正是设备上实测到的值
const POLLUTED = {
  PATH: '/data/adb/modules/dsh_android/usr/bin:/system/bin',
  LD_LIBRARY_PATH: '/data/adb/modules/dsh_android/usr/lib',
  HOME: '/data/adb/dsh/workspace',
  TMPDIR: '/data/adb/dsh/tmp',
};

g('系统二进制的识别');

t('系统分区里的二进制被识别为系统二进制', () => {
  for (const c of ['/system/bin/uiautomator', '/system/bin/screencap', '/system/bin/dumpsys',
    '/system/bin/input', '/vendor/bin/foo', '/apex/com.android.art/bin/x']) {
    ok(isSystemBinary(c), `${c} 应被判为系统二进制`);
  }
});

t('模块自带的 node 不是系统二进制（它需要 LD_LIBRARY_PATH）', () => {
  ok(!isSystemBinary('/data/adb/modules/dsh_android/usr/bin/node'), 'node 不该被剔除环境');
});

t('非字符串输入不炸', () => {
  ok(!isSystemBinary(null));
  ok(!isSystemBinary(undefined));
  ok(!isSystemBinary(123));
});

g('环境分类：一个变量两向绑定');

t('系统二进制：LD_LIBRARY_PATH 被剔除', () => {
  const env = envForCommand('/system/bin/uiautomator', POLLUTED);
  ok(!('LD_LIBRARY_PATH' in env), 'LD_LIBRARY_PATH 必须被剔除，否则 uiautomator 起不来');
});

t('系统二进制：其余环境原样保留（只剔一个变量，不是清空环境）', () => {
  const env = envForCommand('/system/bin/screencap', POLLUTED);
  eq(env.PATH, POLLUTED.PATH, 'PATH 应保留');
  eq(env.HOME, POLLUTED.HOME, 'HOME 应保留');
  eq(env.TMPDIR, POLLUTED.TMPDIR, 'TMPDIR 应保留');
  eq(Object.keys(env).sort(), ['HOME', 'PATH', 'TMPDIR'], '只少了 LD_LIBRARY_PATH');
});

t('node 自身：LD_LIBRARY_PATH 必须保留（否则 node 找不到 libz.so.1）', () => {
  const env = envForCommand('/data/adb/modules/dsh_android/usr/bin/node', POLLUTED);
  eq(env.LD_LIBRARY_PATH, POLLUTED.LD_LIBRARY_PATH, 'node 需要它，不能剔');
});

t('不修改传入的基准环境（无副作用）', () => {
  const base = { ...POLLUTED };
  envForCommand('/system/bin/uiautomator', base);
  eq(base.LD_LIBRARY_PATH, POLLUTED.LD_LIBRARY_PATH, '基准对象不该被改');
});

t('screencap 实测两者都能跑，但仍归入系统二进制（按性质而非按现状分类）', () => {
  // 这是刻意的：依赖"某个二进制恰好不受污染"是脆弱的
  ok(isSystemBinary('/system/bin/screencap'));
  ok(!('LD_LIBRARY_PATH' in envForCommand('/system/bin/screencap', POLLUTED)));
});

g('runCommand：真正传下去的是什么');

t('系统二进制走 execFile 时 env 已剔除该变量', async () => {
  let seen = null;
  await runCommand('/system/bin/uiautomator', ['dump', '/tmp/x.xml'], {
    baseEnv: POLLUTED,
    spawnImpl: (cmd, args, opts, cb) => { seen = opts; cb(null, 'ok', ''); },
  });
  ok(seen, '应调用 spawnImpl');
  ok(!('LD_LIBRARY_PATH' in seen.env), '传下去的 env 必须已剔除');
  eq(seen.env.PATH, POLLUTED.PATH, '其余环境保留');
});

t('node 走 execFile 时 env 保留该变量', async () => {
  let seen = null;
  await runCommand('/data/adb/modules/dsh_android/usr/bin/node', ['-e', '1'], {
    baseEnv: POLLUTED,
    spawnImpl: (cmd, args, opts, cb) => { seen = opts; cb(null, '', ''); },
  });
  eq(seen.env.LD_LIBRARY_PATH, POLLUTED.LD_LIBRARY_PATH, 'node 的 env 不该被动');
});

t('参数走 argv 数组，不拼 shell（挡住工具参数注入）', async () => {
  let seenArgs = null;
  await runCommand('/system/bin/screencap', ['-p'], {
    baseEnv: POLLUTED,
    spawnImpl: (cmd, args, opts, cb) => { seenArgs = args; cb(null, '', ''); },
  });
  ok(Array.isArray(seenArgs), 'args 必须是数组');
  eq(seenArgs, ['-p']);
});

t('默认值：timeout 20s / encoding utf8 / maxBuffer 256MiB', async () => {
  let seen = null;
  await runCommand('/system/bin/dumpsys', ['display'], {
    baseEnv: POLLUTED,
    spawnImpl: (cmd, args, opts, cb) => { seen = opts; cb(null, 'x', ''); },
  });
  eq(seen.timeout, 20000);
  eq(seen.encoding, 'utf8');
  eq(seen.maxBuffer, 256 * 1024 * 1024);
});

t('encoding 可被显式覆盖为 buffer（截屏需要）', async () => {
  let seen = null;
  await runCommand('/system/bin/screencap', ['-p'], {
    baseEnv: POLLUTED, encoding: 'buffer', timeout: 30000,
    spawnImpl: (cmd, args, opts, cb) => { seen = opts; cb(null, Buffer.from([1]), ''); },
  });
  eq(seen.encoding, 'buffer');
  eq(seen.timeout, 30000);
});

t('子进程失败时 reject 且带上 stderr', async () => {
  let err = null;
  try {
    await runCommand('/system/bin/uiautomator', ['dump', '/tmp/x'], {
      baseEnv: POLLUTED,
      spawnImpl: (cmd, args, opts, cb) => {
        cb(Object.assign(new Error('exit 1'), { code: 1 }), '', 'CANNOT LINK EXECUTABLE');
      },
    });
  } catch (e) { err = e; }
  ok(err, '应 reject');
  eq(err.stderr, 'CANNOT LINK EXECUTABLE', 'stderr 应带出，便于诊断');
  ok(err.message.includes('uiautomator'), '错误里应含命令，便于定位');
});

t('成功时返回 stdout/stderr', async () => {
  const r = await runCommand('/system/bin/dumpsys', ['display'], {
    baseEnv: POLLUTED,
    spawnImpl: (cmd, args, opts, cb) => cb(null, '<hierarchy/>', 'warn'),
  });
  eq(r.stdout, '<hierarchy/>');
  eq(r.stderr, 'warn');
});

let lastGroup;
for (const { name, fn, group: grp } of tests) {
  if (grp !== lastGroup) {
    console.log(`${lastGroup === undefined ? '' : '\n'}── ${grp ?? '(未分组)'} ──`);
    lastGroup = grp;
  }
  try {
    await fn();
    console.log(`  [ OK ] ${name}`);
    pass++;
  } catch (e) {
    console.log(`  [FAIL] ${name}: ${e.message}`);
    fail++;
  }
}
console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
if (fail) process.exitCode = 1;
