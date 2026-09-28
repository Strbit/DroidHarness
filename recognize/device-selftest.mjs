// 设备侧 Node 自检：验证模块自带的 Node 能做什么
// 这是"识别逻辑能否跑在手机上"的前提验证
console.log('node-ok ' + process.version + ' ' + process.platform + '/' + process.arch);

// 1. 能否 spawn 子进程（识别要调 screencap / uiautomator）
import { execFileSync } from 'node:child_process';
try {
  const out = execFileSync('/system/bin/screencap', ['-p'], { maxBuffer: 64 * 1024 * 1024 });
  console.log('spawn-screencap-ok bytes=' + out.length +
    ' png=' + (out[0] === 0x89 && out[1] === 0x50));
} catch (e) {
  console.log('spawn-screencap-FAIL ' + e.message);
}

// 2. 能否写 /data/local/tmp 并读回
import fs from 'node:fs';
try {
  const p = '/data/local/tmp/rec-selftest.txt';
  fs.writeFileSync(p, 'hello');
  const back = fs.readFileSync(p, 'utf8');
  fs.unlinkSync(p);
  console.log('tmpfile-ok ' + back);
} catch (e) {
  console.log('tmpfile-FAIL ' + e.message);
}

// 3. 能否执行 uiautomator dump 并读 XML
try {
  execFileSync('/system/bin/uiautomator', ['dump', '/data/local/tmp/rec-selftest.xml'],
    { stdio: 'ignore', timeout: 20000 });
  const xml = fs.readFileSync('/data/local/tmp/rec-selftest.xml', 'utf8');
  fs.unlinkSync('/data/local/tmp/rec-selftest.xml');
  console.log('uitree-ok bytes=' + xml.length + ' hasHierarchy=' + xml.includes('<hierarchy'));
} catch (e) {
  console.log('uitree-FAIL ' + e.message);
}

// 4. 是否有可用的 OCR（预期没有）
try {
  execFileSync('/system/bin/which', ['tesseract'], { stdio: 'ignore' });
  console.log('ocr-tesseract-present');
} catch {
  console.log('ocr-none (as expected)');
}

// 5. 网络（未来若要接云端 OCR）
import net from 'node:net';
const s = net.connect({ host: '127.0.0.1', port: 3080 }, () => { console.log('loopback-ok 3080'); s.end(); });
s.on('error', () => console.log('loopback-fail'));
setTimeout(() => process.exit(0), 1500);
