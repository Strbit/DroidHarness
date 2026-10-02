// VdMain.java — 设备侧虚拟副屏守护进程（PR B）
//
// 职责
// ───
// 创建一块 trusted VirtualDisplay（ OWN_FOCUS + 镜像挖孔 + SHOULD_SHOW_SYSTEM_DECORATIONS），
// 把 ImageReader 的单帧输出落盘成 PNG，等待 stop 信号后销毁副屏、清理状态。
//
// 与参考实现(AcidGr/agent-mobile-use DaemonMain, MIT)的取舍
// ────────────────────────────────────────────────────────
// 它做了 H.264 实时流（MediaCodec + Surface 切换 + 127.0.0.1:3071）——那是为了
// "人在 PC 上连续看副屏"的监控台。DSH agent 的形状是"按需看一眼"：读树 → 动作 →
// 截图确认，帧率需求为零。所以这里不做编码器，只保留 ImageReader 单帧路径：
//   · acquireLatestImage() 拿最新帧（丢弃积压帧，读到的永远是"现在"）
//   · 行内 JPEG 编码（Bitmap.compress），直接写调用方指定的路径
// 省掉 MediaCodec 会话管理的全部复杂度，也没有"encoder 会话中 surface 被切走"
// 的竞态。帧是被动缓存的（onImageAvailable 只 close 不保存），请求时才取。
//
// 与 PR A(DshActionMain) 的关系
// ────────────────────────────
// 两个独立进程、两个 dex：动作是秒生秒灭的，副屏必须常驻。副屏进程**不带**
// UiAutomation（它会抢无障碍单会话，把 PR A 的注入挤掉）；树的读取仍由动作
// 进程的 getWindowsOnAllDisplays 完成 —— displayId 只是参数。
//
// 生命周期契约
// ───────────
//   · 启动参数: <width> <height> <dpi>
//   · 状态文件: /data/local/tmp/dsh-vd-status.json （running/failed + displayId + pid）
//   · 停止信号: touch /data/local/tmp/dsh-vd-stop → 进程销毁副屏并 exit 0
//   · 崩溃自愈: 下次 vd_start 前若状态文件还在而进程已死 → 过期状态, 直接覆盖
//   · stdout: READY 行由 Node 侧等待；之后的日志进 stderr 不参与协议
//
// 截图命令（stdout 协议, 一次一命令一应答）
//   shot <displayId> <outputPath.b64>   把副屏当前帧编码 JPEG 写到指定路径
//   ping / quit
package com.dsh.uiaction;

import android.graphics.PixelFormat;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.os.Handler;
import android.os.HandlerThread;

import java.io.File;
import java.io.FileOutputStream;
import java.lang.reflect.Constructor;
import java.lang.reflect.Method;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.Base64;

public final class VdMain {
    private static final String STATUS_FILE = "/data/local/tmp/dsh-vd-status.json";
    private static final String STOP_FILE = "/data/local/tmp/dsh-vd-stop";
    private static final String READY_MARK = "<<<VD_READY>>>";

    private static int sW = 1200, sH = 2608, sDpi = 480;
    private static VirtualDisplay sVd;
    private static ImageReader sReader;
    private static HandlerThread sDrainThread;
    /** 本副屏的逻辑 displayId(NULL=-1 表示还没建好), cleanup 清栈要用。 */
    private static int sDisplayId = -1;
    /** cleanup 幂等闸: main 正常收尾与 JVM 关闭钩子可能都触发。 */
    private static volatile boolean sCleaned = false;
    /** listener 保留的最新帧; shot 取走并关闭。acquireLatestImage 是一次性消费,
     *  没有 listener 留帧的话 shot 时队列里永远没有可用帧(真机冒烟实测)。 */
    private static android.media.Image sHeldImage;

    public static void main(String[] args) {
        // 主 Looper: ImageReader listener 需要 Handler；与 DshActionMain 同一个坑
        if (android.os.Looper.getMainLooper() == null) {
            android.os.Looper.prepareMainLooper();
        }
        // SIGTERM(父进程 child.kill() 用的正是这个)/ JVM 正常退出都走钩子。
        // serveLoop 末尾的 cleanup() 覆盖 EOF/quit, 钩子覆盖信号 —— 两条路都要
        // "先清栈再 release", 否则用户前台会被抢。SIGKILL 捕获不到, 由 JS 侧
        // 的前台守卫兜底(见 recognize/lib/uiaction.mjs 的 vdStart 退出监听)。
        try {
            Runtime.getRuntime().addShutdownHook(new Thread(new Runnable() {
                @Override public void run() { cleanup(); }
            }, "DshVdCleanup"));
        } catch (Throwable ignored) { /* 钩子加不上也要能跑 */ }
        int code = 1;
        try {
            if (args.length >= 3) {
                sW = Integer.parseInt(args[0]);
                sH = Integer.parseInt(args[1]);
                sDpi = Integer.parseInt(args[2]);
            }
            create();
            System.out.println(READY_MARK);
            System.out.flush();
            code = serveLoop();
        } catch (Throwable t) {
            status("failed", -1);
            System.err.println("[VdMain] fatal: " + t);
            t.printStackTrace();
            code = 1;
        }
        System.out.flush();
        System.err.flush();
        Runtime.getRuntime().halt(code);
    }

    // ── 副屏创建（反射隐藏 API）────────────────────────────────
    //
    // flags = 1545 | 16384 | 65536（真机验证过的一组，来自参考实现）:
    //   1 PUBLIC | 8 OWN_CONTENT_ONLY | 512 SHOULD_SHOW_SYSTEM_DECORATIONS
    //   | 1024 TRUSTED | 16384 OWN_FOCUS | 65536 STEAL_TOP_FOCUS_DISABLED
    // TRUSTED 让副屏能承载真实 Activity；OWN_FOCUS+STEAL_TOP_FOCUS_DISABLED
    // 保证它不抢物理屏的前台焦点（用户正在用手机时自动化在上面的屏进行）。
    // 挖孔镜像: 物理屏有打孔(cutout), 不镜像的话副屏 App 的布局会把状态栏
    // 画进孔里, 与主屏坐标系错位。
    private static void create() throws Exception {
        Class<?> atClass = Class.forName("android.app.ActivityThread");
        Method systemMain = atClass.getMethod("systemMain");
        Object at = systemMain.invoke(null);
        Method getSysCtx = atClass.getMethod("getSystemContext");
        android.content.Context ctx = (android.content.Context) getSysCtx.invoke(at);

        Class<?> dmClass = Class.forName("android.hardware.display.DisplayManager");
        Constructor<?> dmCtor = dmClass.getDeclaredConstructor(android.content.Context.class);
        dmCtor.setAccessible(true);
        DisplayManager dm = (DisplayManager) dmCtor.newInstance(ctx);

        try {
            java.lang.reflect.Field f = dmClass.getDeclaredField("mDisplayIdToMirror");
            f.setAccessible(true);
            f.setInt(dm, 0);
        } catch (Throwable ignored) { /* 不镜像也能跑, 只是 cutout 可能不对 */ }

        sDrainThread = new HandlerThread("DshVdDrain");
        sDrainThread.start();
        Handler drainHandler = new Handler(sDrainThread.getLooper());

        sReader = ImageReader.newInstance(sW, sH, PixelFormat.RGBA_8888, 2);
        // listener 只负责**丢弃积压帧**: maxImages=2, 如果 shot 不来, 旧帧会占满
        // 队列导致 SurfaceFlinger 停在旧内容。保留最新一帧不关(shot 取它),
        // 丢弃更早的那帧 —— acquireLatestImage 语义由这里手工实现:
        //   onAvailable 时: close 掉手里的旧帧, acquire 新帧存着
        //   shot 时: 取走存着的帧(队列空出来), 用完关
        sHeldImage = null;
        sReader.setOnImageAvailableListener(r -> {
            try {
                Image stale = sHeldImage;
                sHeldImage = r.acquireLatestImage();
                if (stale != null) try { stale.close(); } catch (Throwable ignored) {}
            } catch (Throwable ignored) {}
        }, drainHandler);

        int flags = 1545 | 16384 | 65536;
        VirtualDisplay vd = null;
        try {
            Class<?> cBuilder = Class.forName("android.hardware.display.VirtualDisplayConfig$Builder");
            Constructor<?> ctor = cBuilder.getConstructor(String.class, int.class, int.class, int.class);
            Object builder = ctor.newInstance("DshVirtualDisplay", sW, sH, sDpi);
            cBuilder.getMethod("setSurface", Class.forName("android.view.Surface"))
                    .invoke(builder, sReader.getSurface());
            cBuilder.getMethod("setFlags", int.class).invoke(builder, flags);

            // 镜像物理屏挖孔（拿不到就算了, 不失败）
            try {
                android.view.Display phys = dm.getDisplay(0);
                Object cutout = phys.getClass().getMethod("getCutout").invoke(phys);
                if (cutout != null) {
                    cBuilder.getMethod("setDisplayCutout", Class.forName("android.view.DisplayCutout"))
                            .invoke(builder, cutout);
                }
            } catch (Throwable ignored) {}

            Object config = cBuilder.getMethod("build").invoke(builder);
            Method mCreate = dm.getClass().getMethod("createVirtualDisplay",
                    Class.forName("android.hardware.display.VirtualDisplayConfig"));
            vd = (VirtualDisplay) mCreate.invoke(dm, config);
        } catch (Throwable t) {
            // 没有 fallback: 静默降级会起一块 flags/尺寸都不对的屏, 比失败更糟
            System.err.println("[VdMain] VirtualDisplayConfig creation failed (no fallback): " + t);
            t.printStackTrace();
        }
        if (vd == null || vd.getDisplay() == null) {
            status("failed", -1);
            throw new IllegalStateException("virtual display creation failed");
        }
        sVd = vd;
        int id = vd.getDisplay().getDisplayId();
        sDisplayId = id;
        status("running", id);
        System.err.println("[VdMain] virtual display " + id + " ready (" + sW + "x" + sH + "@" + sDpi + ")");
    }

    // ── 命令循环 ──────────────────────────────────────────────

    private static int serveLoop() throws Exception {
        new File(STOP_FILE).delete();
        java.io.BufferedReader in = new java.io.BufferedReader(
                new java.io.InputStreamReader(System.in, StandardCharsets.UTF_8));
        String line;
        while ((line = in.readLine()) != null) {
            line = line.trim();
            if (line.isEmpty()) continue;
            if ("quit".equals(line) || "exit".equals(line)) break;
            if ("ping".equals(line)) { System.out.println("pong\n<<<VD_END>>>"); System.out.flush(); continue; }
            if (line.startsWith("shot ")) {
                String[] p = line.split(" ");
                String resp;
                try {
                    if (p.length < 3) throw new IllegalArgumentException("shot <displayId> <pathB64>");
                    String outPath = new String(Base64.getDecoder().decode(p[2]), StandardCharsets.UTF_8);
                    long t0 = System.currentTimeMillis();
                    shot(outPath);
                    resp = "{\"ok\":true,\"path\":\"" + esc(outPath) + "\",\"cost_ms\":"
                            + (System.currentTimeMillis() - t0) + "}";
                } catch (Throwable t) {
                    resp = "{\"ok\":false,\"error\":\"" + esc(String.valueOf(t)) + "\"}";
                }
                System.out.println(resp + "\n<<<VD_END>>>");
                System.out.flush();
                continue;
            }
            System.out.println("{\"ok\":false,\"error\":\"unknown command: " + esc(line) + "\"}\n<<<VD_END>>>");
            System.out.flush();
        }
        cleanup();
        status("stopped", -1);
        return 0;
    }

    /** 取 listener 留下的最新帧 → ARGB Bitmap → JPEG 落盘。 */
    private static void shot(String outPath) throws Exception {
        Image img = sHeldImage;
        sHeldImage = null;
        if (img == null) {
            // 没有留帧(副屏刚建/内容没刷新过): 直接再取一次
            img = sReader.acquireLatestImage();
        }
        if (img == null) throw new IllegalStateException("没有可用帧（副屏可能没有内容）");
        try {
            Image.Plane plane = img.getPlanes()[0];
            ByteBuffer buf = plane.getBuffer();
            int rowStride = plane.getRowStride();
            int pixStride = plane.getPixelStride();
            int w = img.getWidth(), h = img.getHeight();
            android.graphics.Bitmap bmp = android.graphics.Bitmap.createBitmap(w, h,
                    android.graphics.Bitmap.Config.ARGB_8888);
            int[] pixels = new int[w * h];
            int rowPad = (rowStride - w * pixStride) / pixStride;
            for (int y = 0; y < h; y++) {
                int base = y * (w + rowPad);
                for (int x = 0; x < w; x++) {
                    int a = buf.get((base + x) * pixStride) & 0xFF;
                    int r = buf.get((base + x) * pixStride + 1) & 0xFF;
                    int g = buf.get((base + x) * pixStride + 2) & 0xFF;
                    int b = buf.get((base + x) * pixStride + 3) & 0xFF;
                    pixels[y * w + x] = (a << 24) | (r << 16) | (g << 8) | b;
                }
            }
            bmp.setPixels(pixels, 0, w, 0, 0, w, h);
            File out = new File(outPath);
            File parent = out.getParentFile();
            if (parent != null) parent.mkdirs();
            FileOutputStream fos = new FileOutputStream(out);
            try {
                bmp.compress(android.graphics.Bitmap.CompressFormat.JPEG, 85, fos);
            } finally {
                fos.flush();
                fos.close();
            }
            bmp.recycle();
        } finally {
            img.close();
        }
    }

    private static void cleanup() {
        if (sCleaned) return;
        sCleaned = true;

        // ⚠⚠ **必须先删掉副屏上的栈, 再 release** ⚠⚠
        // ────────────────────────────────────────────────
        // 直接 release 时, WindowManager 会把它承载的 RootTask reparent 回
        // display 0 **且置顶**(AOSP 的 moveRootTaskToDisplay 固定 onTop=true),
        // 于是用户正在用的 App 被顶掉。真机实测: 用户在看 piliplus, 副屏上跑
        // 着设置, 守护进程一退出, 前台立刻变成"设置" —— 这正是用户报的
        // "为什么 App 会跳回主屏"。
        // 先把副屏上的栈 remove 掉(task 随栈销毁, 没有东西需要 reparent),
        // 再释放副屏, 用户前台就一点都不动。实测三阶段前台逐字未变。
        // JS 侧 vdStop() 里的顺序与这里一致, 两处都改才能覆盖所有退出路径。
        removeStacksOnDisplay(sDisplayId);

        try { if (sHeldImage != null) sHeldImage.close(); } catch (Throwable ignored) {}
        sHeldImage = null;
        try { if (sVd != null) sVd.release(); } catch (Throwable ignored) {}
        try { if (sReader != null) sReader.close(); } catch (Throwable ignored) {}
        try { if (sDrainThread != null) sDrainThread.quitSafely(); } catch (Throwable ignored) {}
        new File(STOP_FILE).delete();
    }

    /**
     * 清掉指定屏上的所有 RootTask(用 `am stack remove`)。
     *
     * 为什么不直接调 ActivityTaskManager: 本进程是 app_process(shell/root 身份),
     * 没有 system_server 内的 Binder 句柄; 而 `am stack remove` 走的就是
     * ActivityManagerShellCommand, 是这类操作的正规入口(实测有效, 见真机日志
     * "cleared 2 stack(s) on display N")。
     */
    private static void removeStacksOnDisplay(int displayId) {
        if (displayId < 0) return;
        try {
            java.util.List<String> ids = new java.util.ArrayList<String>();
            java.util.regex.Pattern pat =
                    java.util.regex.Pattern.compile("^RootTask id=(\\d+).*displayId=(\\d+)");
            Process p = new ProcessBuilder("/system/bin/cmd", "activity", "stack", "list")
                    .redirectErrorStream(true).start();
            java.io.BufferedReader r = new java.io.BufferedReader(
                    new java.io.InputStreamReader(p.getInputStream(), StandardCharsets.UTF_8));
            String line;
            while ((line = r.readLine()) != null) {
                java.util.regex.Matcher m = pat.matcher(line);
                if (m.find() && Integer.parseInt(m.group(2)) == displayId) {
                    ids.add(m.group(1));
                }
            }
            r.close();
            p.waitFor();
            for (String id : ids) {
                new ProcessBuilder("/system/bin/am", "stack", "remove", id)
                        .redirectErrorStream(true).start().waitFor();
            }
            System.err.println("[VdMain] cleared " + ids.size() + " stack(s) on display " + displayId);
        } catch (Throwable t) {
            System.err.println("[VdMain] clear stacks failed: " + t);
        }
    }

    private static void status(String st, int displayId) {
        try {
            String json = String.format(
                    "{\"status\":\"%s\",\"pid\":%d,\"display_id\":%d,\"width\":%d,\"height\":%d,\"dpi\":%d}",
                    st, android.os.Process.myPid(), displayId, sW, sH, sDpi);
            FileOutputStream fos = new FileOutputStream(STATUS_FILE);
            fos.write(json.getBytes(StandardCharsets.UTF_8));
            fos.flush();
            fos.close();
        } catch (Throwable t) {
            System.err.println("[VdMain] status write failed: " + t);
        }
    }

    private static String esc(String s) {
        return s.replace("\\", "\\\\").replace("\"", "\\\"")
                .replace("\n", "\\n").replace("\r", "\\r");
    }
}
