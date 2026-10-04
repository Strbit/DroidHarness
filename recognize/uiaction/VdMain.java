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
        //
        // ⚠ 钩子里同样要过"有 App 就拒绝清理"这道闸: SIGTERM 是 JS 侧
        //   `child.kill()` 走的路径, 绕开它就会重演"删用户 task / 抢用户前台"。
        //   钩子**不能阻止退出**(SIGTERM 已经在退了), 但可以做到**不动 App 栈** ——
        //   只清 home 栈, App 栈留给 WM reparent(抢一次前台), 至少数据不丢。
        //   "完全不抢前台"那条路由 serveLoop 的拒绝退出覆盖(它不走到钩子)。
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
            if ("quit".equals(line) || "exit".equals(line)) {
                // ⚠ 有真实 App 时**拒绝退出**（详见 refuseExitIfOccupied 的说明）。
                if (refuseExitIfOccupied()) continue;
                break;
            }
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
        // stdin EOF(父进程死了/管道断了)是**意外**退出, 同样要过这道闸 ——
        // 否则测试脚本一 process.exit, 用户前台就被 reparent 抢掉(实测事故)。
        if (refuseExitIfOccupied()) {
            // 拒绝退出: 不能再读 stdin(已 EOF), 但**保持进程存活**,
            // 让副屏与上面的 App 都留在原地。外部要收掉它就显式 handoff。
            System.err.println("[VdMain] stdin EOF 但副屏上有 App —— 拒绝退出, 进程保持存活");
            while (true) {
                try { Thread.sleep(3600_000L); } catch (InterruptedException ignored) { }
            }
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
                    // ⚠⚠ 通道顺序: PixelFormat.RGBA_8888 的缓冲区字节布局就是
                    //     **R,G,B,A**, 而 Bitmap 的 int 像素是 **A,R,G,B**。
                    // 我第一版把缓冲区也按 A,R,G,B 读, 导致 alpha 槽里装进了真值 R;
                    // setPixels 后位图被当成 premultiplied, JPEG 编码时又乘一次
                    // "alpha", 于是产出这条确定性色彩变换(真机逐点实测):
                    //     观测.R = 真值.R × 真值.G / 255
                    //     观测.G = 真值.R × 真值.B / 255
                    //     观测.B = 真值.R × 真值.A / 255   (不透明时 = 真值.R)
                    // 表现: 红色变蓝、绿色变黑、暗部发紫(因为 R/G 被平方压制,
                    // B 保持原值 → B 远大于 R/G); 而白色是这条变换的不动点,
                    // 所以"白字看着正常"极具迷惑性。
                    // (排查报告 workspace/123 用 16 个色块、含先预测后验证的独立
                    //  第二组, 把这四条公式钉死了; 本行的修正就是那个根因。)
                    int r = buf.get((base + x) * pixStride) & 0xFF;
                    int g = buf.get((base + x) * pixStride + 1) & 0xFF;
                    int b = buf.get((base + x) * pixStride + 2) & 0xFF;
                    int a = buf.get((base + x) * pixStride + 3) & 0xFF;
                    pixels[y * w + x] = (a << 24) | (r << 16) | (g << 8) | b;
                }
            }
            bmp.setPixels(pixels, 0, w, 0, 0, w, h);

            // ── 黑帧检测(P0): 绝不能把"全黑 JPEG"当成功返回 ──────────
            // 最坏的失败模式是成功返回一张内容为空的合法图片: JPEG 头校验
            // 查不出"图是黑的", Agent 会据此误判"副屏没内容"。
            // 排查报告(workspace/123)记录过一次恒黑的事故, 虽然在当前版本上
            // 未能复现(四个界面状态四个 md5), 但这个闸必须常在: 宁可报错。
            // 采样网格 32x32: 一个界面再暗, 也不至于所有采样点都精确为 0。
            {
                final int GS = 32;
                int nonBlack = 0, samples = 0;
                for (int gy = 0; gy < GS; gy++) {
                    for (int gx = 0; gx < GS; gx++) {
                        int x = (gx + 1) * w / (GS + 1);
                        int y = (gy + 1) * h / (GS + 1);
                        int p = pixels[y * w + x];
                        if ((p & 0x00FFFFFF) != 0) nonBlack++;
                        samples++;
                    }
                }
                if (nonBlack == 0) {
                    throw new IllegalStateException(
                            "取到全黑帧（" + samples + " 个采样点全为 0）—— ImageReader 未获得有效内容。" +
                            "副屏内容请改用无障碍树读取; 若持续出现, 检查副屏是否真的在渲染");
                }
            }

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

    /** 列出某块屏上**非 home** 类型的 RootTask id（真实 App 的栈）。 */
    private static java.util.List<String> appStacksOnDisplay(int displayId) {
        java.util.List<String> ids = new java.util.ArrayList<String>();
        if (displayId < 0) return ids;
        try {
            java.util.regex.Pattern patRoot =
                    java.util.regex.Pattern.compile("^RootTask id=(\\d+).*displayId=(\\d+)");
            java.util.regex.Pattern patHome =
                    java.util.regex.Pattern.compile("mActivityType=home\\b");
            Process p = new ProcessBuilder("/system/bin/cmd", "activity", "stack", "list")
                    .redirectErrorStream(true).start();
            java.io.BufferedReader r = new java.io.BufferedReader(
                    new java.io.InputStreamReader(p.getInputStream(), StandardCharsets.UTF_8));
            String line;
            String curId = null;
            boolean curHome = false;
            while ((line = r.readLine()) != null) {
                java.util.regex.Matcher m = patRoot.matcher(line);
                if (m.find()) {
                    if (curId != null && !curHome) ids.add(curId);
                    curHome = false;
                    curId = (Integer.parseInt(m.group(2)) == displayId) ? m.group(1) : null;
                    continue;
                }
                if (curId != null && !curHome && patHome.matcher(line).find()) curHome = true;
            }
            if (curId != null && !curHome) ids.add(curId);
            r.close();
            p.waitFor();
        } catch (Throwable t) {
            System.err.println("[VdMain] appStacksOnDisplay failed: " + t);
        }
        return ids;
    }

    /**
     * 副屏上还有真实 App 时**拒绝退出**。返回 true 表示"已拒绝"。
     *
     * 为什么必须拒绝（真机实测，两种收尾都不可接受）:
     *   · 退出前**清掉** App 栈 → `am stack remove` 会真的删掉那些 task。
     *     而 `screen_app` 现在会把**用户主屏的 task 迁移**到副屏，所以删的是
     *     **用户自己的任务**。实测事故: `Destroy ... Task #27 com.tencent.mm`
     *     → 用户微信界面消失。
     *   · 退出前**保留** App 栈 → `vd.release()` 时 WM 把它们 reparent 回 display 0
     *     且 onTop=true(AOSP 的 moveRootTaskToDisplay 固定置顶) → **抢用户前台**。
     *     实测: 连跑三轮测试, 用户前台被连抢三次。
     *
     * 两者都不行, 所以答案是**不退**: 既不删栈也不 release, 副屏与 App 原地留存。
     * 要收掉它就显式 `screen_vd_handoff`(搬回主屏交给用户), 或用户自己关掉那个 App。
     *
     * 只有"副屏上只剩它自己的 home 栈"时才允许退出 —— 那种情况清栈无害,
     * 且必须清(否则 release 时 home 栈被 reparent 回 display 0 同样抢前台)。
     */
    private static boolean refuseExitIfOccupied() {
        java.util.List<String> apps = appStacksOnDisplay(sDisplayId);
        if (apps.isEmpty()) return false;
        System.err.println("[VdMain] 拒绝退出: 副屏(display " + sDisplayId + ") 上还有 "
                + apps.size() + " 个真实 App 栈 " + apps
                + " —— 删它会毁用户数据, 保留它 release 会抢用户前台。"
                + " 请显式 handoff 或先关掉那些 App。");
        return true;
    }

    private static void cleanup() {
        if (sCleaned) return;
        sCleaned = true;

        // ⚠⚠ **必须先处理副屏上的栈, 再 release** ⚠⚠
        // ────────────────────────────────────────────────
        // 直接 release 时, WindowManager 会把它承载的 RootTask reparent 回
        // display 0 **且置顶**(AOSP 的 moveRootTaskToDisplay 固定 onTop=true),
        // 于是用户正在用的 App 被顶掉。真机实测: 用户在看 piliplus, 副屏上跑
        // 着设置, 守护进程一退出, 前台立刻变成"设置" —— 这正是用户报的
        // "为什么 App 会跳回主屏"。
        //
        // 但**只能删我们自己建的 home 栈**, 真实 App 的栈一律不碰 ——
        // 因为 screen_app 现在会把你主屏的 task 迁移到副屏, 那些栈里装的是
        // **用户自己的任务**。删了它就是删用户的数据(实测事故, 见下)。
        // 保留 App 栈的代价是 release 时它们会被 reparent 回主屏、抢一次前台,
        // 但任务和状态都在 —— 比数据被删轻得多。
        removeStacksOnDisplay(sDisplayId, /* onlyHome= */ true);

        try { if (sHeldImage != null) sHeldImage.close(); } catch (Throwable ignored) {}
        sHeldImage = null;
        try { if (sVd != null) sVd.release(); } catch (Throwable ignored) {}
        try { if (sReader != null) sReader.close(); } catch (Throwable ignored) {}
        try { if (sDrainThread != null) sDrainThread.quitSafely(); } catch (Throwable ignored) {}
        new File(STOP_FILE).delete();
    }

    /**
     * 清掉指定屏上的 RootTask。
     *
     * `onlyHome=true` 时**只删 home 类型栈** —— 也就是 MIUI 给每块新屏自动建的那个
     * `SecondaryDisplayLauncher`，属于我们这块屏自己的东西。**真实 App 的栈一律不碰。**
     *
     * ⚠ 为什么必须区分（实测事故，2026-10-05）:
     *   `screen_app` 改成"已有 task 就迁移"之后，副屏上承载的可能是**用户自己主屏的
     *   task**（同一个 task 被 move-stack 搬过来）。此时若还按老逻辑"删掉副屏上所有栈"，
     *   守护进程一退出就会**把用户的 task 删掉**。实测日志:
     *     Destroy timeout of remove-task, attempt to kill Task #27 com.tencent.mm
     *     onTransitionReady t=CLOSE ... Task{m=CLOSE ... d=2->0}
     *   用户看到的是"微信画面闪一下"，而且那个 task 真的没了。
     *   改造前这行是安全的（副屏上的栈都是我们自己用 MULTIPLE_TASK 建的），
     *   引入迁移之后就不再安全 —— 这是随迁移一起引入的回归。
     *
     * 保留 home 栈的删除仍然必要: 不删它，release 时它会被 reparent 回 display 0
     * （WM 的 moveRootTaskToDisplay 固定 onTop=true），把用户前台顶掉。
     *
     * 不删真实 App 栈的代价: release 时它们同样会被 reparent 回主屏（会抢一次前台），
     * 但**任务与状态都还在**。相比之下"数据被删掉"严重得多，所以选这个。
     */
    private static void removeStacksOnDisplay(int displayId, boolean onlyHome) {
        if (displayId < 0) return;
        try {
            java.util.List<String> ids = new java.util.ArrayList<String>();
            java.util.regex.Pattern patRoot =
                    java.util.regex.Pattern.compile("^RootTask id=(\\d+).*displayId=(\\d+)");
            java.util.regex.Pattern patHome =
                    java.util.regex.Pattern.compile("mActivityType=home\\b");
            Process p = new ProcessBuilder("/system/bin/cmd", "activity", "stack", "list")
                    .redirectErrorStream(true).start();
            java.io.BufferedReader r = new java.io.BufferedReader(
                    new java.io.InputStreamReader(p.getInputStream(), StandardCharsets.UTF_8));
            String line;
            // 每个 RootTask 的 `mActivityType=` 出现在紧跟其后的 configuration 行里，
            // 所以要等看到下一段才敢判定上一段是不是 home。
            String curId = null;
            boolean curHome = false;
            while ((line = r.readLine()) != null) {
                java.util.regex.Matcher m = patRoot.matcher(line);
                if (m.find()) {
                    // 结算上一段
                    if (curId != null && (!onlyHome || curHome)) ids.add(curId);
                    curHome = false;
                    if (Integer.parseInt(m.group(2)) == displayId) {
                        curId = m.group(1);
                    } else {
                        curId = null;   // 不在目标屏, 这一段不用管
                    }
                    continue;
                }
                if (curId != null && !curHome && patHome.matcher(line).find()) curHome = true;
            }
            if (curId != null && (!onlyHome || curHome)) ids.add(curId);
            r.close();
            p.waitFor();
            for (String id : ids) {
                new ProcessBuilder("/system/bin/am", "stack", "remove", id)
                        .redirectErrorStream(true).start().waitFor();
            }
            System.err.println("[VdMain] cleared " + ids.size() + " stack(s) on display " + displayId
                    + (onlyHome ? " (仅 home 栈; 真实 App 栈保留)" : ""));
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
