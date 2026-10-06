// DshHookEntry.java — LSPosed 模块入口: 允许 App 启动到虚拟副屏
//
// 背景
// ────
// AOSP 默认拒绝把 App 启动到虚拟屏, 三个叠加的检查点:
//   1. SafeActivityOptions.checkPermissions → SecurityException (uid 级,
//      START_TASK_FROM_DISPLAY 是 signature 权限, root 也拿不到 —— 实测
//      "Permission Denial: starting Intent ... uid=0 with launchDisplayId=N")
//   2. DisplayManagerService.validatePackageName → 非系统包不能建屏/承载
//   3. WM 的 canHostTasks / canLaunchOnDisplay 系列 → 虚拟屏默认不可承载任务
// 我们**不依赖 LSPosed 的 user 段**(会被 targetSdk 限制), 直接在 system_server
// 里把这几处判定改成 true。
//
// ⚠ 为什么这里要"精确到重载", 以及"为什么把装载推迟到开机之后"
// ────────────────────────────────────────────────────────────────
// 这个 hook 跑在 system_server 里, 改的是权限校验方法的返回值。它对**开机
// 阶段**的影响是真实风险: 一旦 system_server 起不来, 用户**没法**进系统去关它
// —— 那时候唯一的出路是 recovery / 格式化, 而"删标记文件"这条救急路径本身
// 就要求你能进系统。这是个死循环, 结构性风险独立于"历史上有没有出过事"。
//
// ⚠ 关于历史事故的诚实记载(2026-10-07 更正)
//   · 本仓库曾经有过"这个 hook 把手机搞到开不了机(需格式化 /data)"的记载,
//     并把根因写成 `hookAllMethods`。**那是未经证实的归因。**
//   · 实际情况: 当时用户通宵到凌晨 5 点、有数据备份, 为尽快恢复直接格式化了
//     /data, **没有做任何排查** —— 没有 logcat、没有崩溃栈、没有复现。
//     所以那次事故的根因**至今未知**, "与 hook 相关"只是时间上的相关。
//   · 因此本文件下面各条的理由分两类, 不要混为一谈:
//       [防御性设计] —— 因为理论上危险所以不这么做(与事故无关)
//       [实测]       —— 有 logcat / 复现支撑
//
// 具体设计:
//   ① [防御性设计] **只 hook 返回类型严格是 boolean 的方法**: 用反射枚举重载,
//      逐个检查 `getReturnType() == boolean.class`, 非 boolean 的**跳过并记录**。
//      `XposedBridge.hookAllMethods` 不看返回类型 —— 把非 boolean 重载替换成
//      `return TRUE` 会在调用点崩。参考实现用的就是 hookAllMethods, 我们不用它。
//      (注: 参考实现在真机上长期没出过这类事故, 所以这是"更稳", 不是"唯一正确"。)
//   ② [防御性设计] **native / abstract 方法不碰**(改 native 返回值风险最高)。
//   ③ [防御性设计] **全程 try/catch, 任何异常只记日志, 绝不向上抛**: 即使
//      LSPosed API 变了、某个类结构变了, 最坏结果是"这个钩子没装上"。
//   ④ [结构性风险] 两道开关 + 启动失败自愈:
//        · 必须存在标记文件 /data/system/dsh-vd-hook.on 才启用(安装器创建)。
//          数据被清 → 标记没了 → 模块**彻底惰性**。
//          (路径必须在 system_server 读得到的地方, 见下面 MARKER 的说明)
//        · persist.dsh.vd.hook=0 可临时关闭。
//        · 连续 N 次启动都没能活过 120s → 自动停用自己并留下计数。
//   ⑤ [结构性风险, 2026-10-07 新增] **把 hook 的实际装载推迟到开机完成之后**:
//      见 INSTALL_DELAY_MS / scheduleInstall 的说明 —— 开机阶段完全不碰系统,
//      出了状况用户也进得去系统、关得掉。"安装即用"不受影响(装机时自动注册
//      作用域 + 建标记, 用户不用做任何事)。
//
// 与 agent-mobile-use HookEntry (MIT, © 2026 AcidGr) 的差异
// ────────────────────────────────────────────────────────
// 相同之处: 目标方法清单基本一致(它 9 个 + validatePackageName); IME 隔离
//           也是从它那里学来的(见 hookImeIsolation)。
// 不同之处:
//   · 不用无差别 hookAllMethods, 改成"精确到重载"(理由见文件头 ①, 防御性设计)。
//     [注: 参考实现一直用 hookAllMethods 且长期没出过这类事故 —— 所以我们是
//      "更稳", 而不是"修了它的 bug"。]
//   · 不用 findAndHookMethod: 它在 LSPosed API 82+ 返回 Unhook(不是 void),
//     且对不定参数/重载易漏; 实测其版本在本机 9 个点**全部**
//     NoSuchMethodError/ClassNotFound。
//   · 只 hook system_server 的跨屏承载部分, 不做 SystemUI/ColorOS 那两块
//     (它那两个是 OPPO 专有的流体云/侧键, 与本项目无关)。
//   · 逐条打日志(成功/跳过/失败都打) —— 参考实现失败是静默的, 只能靠猜。
//   · 类缺失不算失败: MIUI 精简了一批 server 类, 打 MISS 继续。
//   · 多了它没有的: 开机后延迟装载(⑤) + 标记/属性/失败自愈三道闸。
package com.dsh.hook;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.util.HashSet;
import java.util.Set;

import de.robv.android.xposed.IXposedHookLoadPackage;
import de.robv.android.xposed.XC_MethodHook;
import de.robv.android.xposed.XC_MethodReplacement;
import de.robv.android.xposed.XposedBridge;
import de.robv.android.xposed.XposedHelpers;
import de.robv.android.xposed.callbacks.XC_LoadPackage;

public class DshHookEntry implements IXposedHookLoadPackage {
    private static final String TAG = "DshHook";

    /**
     * 启用标记: 存在才 hook。安装器创建; 数据被清则自然消失 → 模块惰性。
     *
     * ⚠ 位置踩过坑: 一开始放在 /data/adb/dsh/ 下, 结果**永远读不到** ——
     * /data/adb 的权限是 drwx------(700, 仅 root), 而 hook 跑在 system_server
     * (uid 1000) 里, 连目录都进不去, File.exists() 直接返回 false(它把
     * EACCES 当"不存在")。实测现象: 标记明明建了, 日志还是 "inert: 无标记"。
     * /data/system 是 system_server 自己的地盘(失败计数也放这儿), 一定能读;
     * 且 factory reset 会清掉它 —— 正是我们要的"清零即惰性"。
     */
    private static final String MARKER = "/data/system/dsh-vd-hook.on";
    /** 启动失败计数(system_server 自己有权读写 /data/system)。 */
    private static final String FAILS = "/data/system/dsh-vd-hook-fails";
    /** 连续多少次"活不过 DISARM_RESET_MS"就自废武功。 */
    private static final int MAX_FAILED_BOOTS = 3;
    /** 装载之后撑过这么久就认为这次是安全的, 计数清零。 */
    private static final long DISARM_RESET_MS = 120_000L;
    /** 等 sys.boot_completed 的上限; 超时就不装(开机都没走完, 更不该动系统)。 */
    private static final long BOOT_WAIT_TIMEOUT_MS = 180_000L;
    /** 轮询 boot_completed 的间隔。 */
    private static final long BOOT_POLL_INTERVAL_MS = 2_000L;
    /** 保证 system_server 内只安排一次装载(handleLoadPackage 可能被回调多次)。 */
    private static final java.util.concurrent.atomic.AtomicBoolean sInstallScheduled =
            new java.util.concurrent.atomic.AtomicBoolean(false);

    /** {类名, 方法名} —— 只对该名字里**返回 boolean** 的重载生效 */
    private static final String[][] TARGETS = {
        {"android.view.Display", "canHostTasks"},
        {"android.hardware.display.DisplayManager", "canHostTasks"},
        {"com.android.server.wm.DisplayContent", "canHostTasksLocked"},
        {"com.android.server.wm.LogicalDisplay", "canHostTasksLocked"},
        {"com.android.server.wm.ActivityTaskSupervisor", "isCallerAllowedToLaunchOnDisplay"},
        {"com.android.server.wm.ActivityTaskSupervisor", "isCallerAllowedToLaunchOnTaskDisplayArea"},
        {"com.android.server.wm.ActivityTaskSupervisor", "canPlaceEntityOnDisplay"},
        {"com.android.server.wm.ActivityRecord", "canBeLaunchedOnDisplay"},
        {"com.android.server.wm.Task", "canBeLaunchedOnDisplay"},
        {"com.android.server.wm.RootWindowContainer", "canLaunchOnDisplay"},
        {"com.android.server.display.DisplayManagerService", "validatePackageName"},
    };

    @Override
    public void handleLoadPackage(XC_LoadPackage.LoadPackageParam lpparam) {
        // 顶层兜底: 这个方法的任何异常都不许外泄到 LSPosed/ART
        try {
            handle0(lpparam);
        } catch (Throwable t) {
            log("FATAL(已吞掉, 不影响开机) " + t);
        }
    }

    private void handle0(XC_LoadPackage.LoadPackageParam lpparam) {
        boolean isSystem = "system".equals(lpparam.processName)
                || "android".equals(lpparam.processName)
                || "android".equals(lpparam.packageName);
        if (!isSystem) return;

        // 闸 ④-a: 标记文件
        if (!new File(MARKER).exists()) {
            log("inert: 无标记 " + MARKER + " (模块不生效, 这是安全默认)");
            return;
        }
        // 闸 ④-b: 属性开关
        if ("0".equals(sysProp("persist.dsh.vd.hook", "1"))) {
            log("disabled by persist.dsh.vd.hook=0");
            return;
        }
        // 闸 ④-c: 启动失败自愈(计数到顶就完全不动)。
        // 这里先粗查一次是为了"早退, 连线程都不起"; 真正的判定在
        // waitBootThenInstall() 里再查一遍并自增 —— 因为计数统计的是
        // "装载之后系统没撑住", 而不该记在开机阶段头上(那时我们什么都没做)。
        if (readFails() >= MAX_FAILED_BOOTS) {
            log("DISARMED: 连续 " + MAX_FAILED_BOOTS + " 次装载后系统没撑住, 本次不装载。"
                    + " 删 " + FAILS + " 复位。");
            return;
        }

        // 闸 ⑤: **不在开机阶段装载** —— 只安排一个线程, 等 sys.boot_completed 再装。
        // 理由见文件头 ⑤: 开机阶段完全不碰系统, 出状况用户也进得去系统、关得掉。
        // 注意这里**不加失败计数** —— 计数只统计"装载之后系统还是崩了"的情况,
        // 见 waitBootThenInstall() 里的说明。
        if (!sInstallScheduled.compareAndSet(false, true)) {
            log("已安排过装载(system_server 内重复回调), 跳过");
            return;
        }
        final ClassLoader cl = lpparam.classLoader;
        log("armed: 标记存在, 等 sys.boot_completed=1 后再装载 (开机阶段不 hook 任何方法)");
        try {
            Thread t = new Thread(new Runnable() {
                @Override public void run() { waitBootThenInstall(cl); }
            }, "DshHookInstall");
            t.setDaemon(true);
            t.start();
        } catch (Throwable t) {
            log("无法启动装载线程(本次不装载, 不影响开机): " + t);
        }
    }

    /**
     * 等开机完成 → 重新核对开关 → 装载 hook → 确认活过 120s。
     *
     * 为什么在**单独的线程**里等: handleLoadPackage 是在 system_server 启动早期
     * 被调用的, 那时绝不能阻塞也不能碰系统。
     *
     * 为什么装载前**重新核对**标记/属性: 用户完全可能在开机过程中就把它们关掉了
     * (这正是我们希望的救急路径), 不能因为"装载已安排"就无视。
     */
    private void waitBootThenInstall(ClassLoader cl) {
        long deadline = System.currentTimeMillis() + BOOT_WAIT_TIMEOUT_MS;
        while (System.currentTimeMillis() < deadline) {
            if ("1".equals(sysProp("sys.boot_completed", ""))) break;
            try { Thread.sleep(BOOT_POLL_INTERVAL_MS); } catch (InterruptedException e) { return; }
        }
        if (!"1".equals(sysProp("sys.boot_completed", ""))) {
            log("等 boot_completed 超时(" + (BOOT_WAIT_TIMEOUT_MS / 1000) + "s) —— 不装载。"
                    + " 开机都没走完, 更不该动系统。");
            return;
        }
        if (!new File(MARKER).exists()) {
            log("boot 完成后发现标记已被删除 —— 不装载");
            return;
        }
        if ("0".equals(sysProp("persist.dsh.vd.hook", "1"))) {
            log("boot 完成后发现属性已禁用 —— 不装载");
            return;
        }

        // 计数只在**真正要装载**时加: 它统计的是"装了之后系统还是崩了"。
        // 开机阶段我们什么都没做, 所以不该记在它头上。
        int fails = readFails();
        if (fails >= MAX_FAILED_BOOTS) {
            log("DISARMED: 连续 " + fails + " 次装载后系统没撑住, 放弃。删 " + FAILS + " 复位。");
            return;
        }
        writeFails(fails + 1);
        log("boot_completed=1, 开始装载 (第 " + (fails + 1) + " 次尝试), targets="
                + TARGETS.length);

        int ok = 0, miss = 0, skip = 0, fail = 0;
        for (String[] t : TARGETS) {
            int r = hookBoolean(cl, t[0], t[1]);
            if (r > 0) ok += r;
            else if (r == 0) fail++;
            else if (r == -1) miss++;
            else skip += -r;
        }
        log("done: " + ok + " 个重载已 hook, " + miss + " 个类不存在, "
                + skip + " 个非 boolean 重载跳过, " + fail + " 个失败");

        // IME 隔离(非 boolean, 单独处理): 让副屏的软键盘不弹到主屏
        int ime = hookImeIsolation(cl);
        log("IME 隔离: " + (ime > 0 ? ("已 hook " + ime + " 个重载") : "未装上(见上面的 MISS/FAIL)"));

        // 撑过 DISARM_RESET_MS 就算这次装载是安全的, 计数清零。
        // 中途系统崩了 → 这句不会执行 → 计数留着, 下次开机继续加, 到 3 次自废。
        try {
            Thread.sleep(DISARM_RESET_MS);
            if (new File(FAILS).delete()) log("装载后已撑过 " + (DISARM_RESET_MS / 1000) + "s, 失败计数已清零");
        } catch (InterruptedException ignored) {
        } catch (Throwable t) {
            log("清理失败计数出错(不影响功能): " + t);
        }
    }

    /**
     * 精确到重载地 hook: 只处理**返回类型严格为 boolean** 的同名方法。
     *
     * @return >0 = 成功 hook 的重载数; 0 = 有失败; -1 = 类不存在;
     *         <0(非-1) = 该类只有非 boolean 重载, 全部跳过(值为跳过数的相反数)
     */
    private static int hookBoolean(ClassLoader cl, String className, String methodName) {
        Class<?> clazz;
        try {
            clazz = XposedHelpers.findClassIfExists(className, cl);
        } catch (Throwable t) {
            log("ERR(找类) " + className + ": " + t);
            return 0;
        }
        if (clazz == null) {
            log("MISS " + className);
            return -1;
        }

        int hooked = 0, skipped = 0, failed = 0;
        Set<String> seen = new HashSet<String>();
        try {
            // 连同父类一起枚举(canHostTasks 等可能定义在父类上)
            for (Class<?> c = clazz; c != null && c != Object.class; c = c.getSuperclass()) {
                Method[] ms;
                try { ms = c.getDeclaredMethods(); } catch (Throwable t) { continue; }
                for (Method m : ms) {
                    if (!methodName.equals(m.getName())) continue;
                    if (!seen.add(c.getName() + "#" + m.toGenericString())) continue;

                    // 闸 ①: 返回类型必须严格是 boolean
                    if (m.getReturnType() != boolean.class) {
                        skipped++;
                        log("SKIP(非 boolean) " + c.getName() + "#" + m.toGenericString());
                        continue;
                    }
                    // 闸 ②: native / abstract 不碰
                    int mod = m.getModifiers();
                    if (Modifier.isNative(mod) || Modifier.isAbstract(mod)) {
                        skipped++;
                        log("SKIP(native/abstract) " + c.getName() + "#" + m.toGenericString());
                        continue;
                    }
                    try {
                        m.setAccessible(true);
                        XposedBridge.hookMethod(m, XC_MethodReplacement.returnConstant(Boolean.TRUE));
                        hooked++;
                        log("OK " + c.getName() + "#" + m.toGenericString());
                    } catch (Throwable t) {
                        failed++;
                        log("FAIL " + c.getName() + "#" + m.toGenericString() + ": " + t);
                    }
                }
            }
        } catch (Throwable t) {
            log("ERR(枚举) " + className + "#" + methodName + ": " + t);
        }

        if (hooked == 0 && failed == 0) {
            // 只有非 boolean 重载, 或方法根本不存在
            log("MISS " + className + "#" + methodName
                    + (skipped > 0 ? " (只有 " + skipped + " 个非 boolean 重载)" : " (方法不存在)"));
            return skipped > 0 ? -skipped : -1;
        }
        if (failed > 0) return 0;
        return hooked;
    }

    /**
     * IME 隔离: 让副屏上的输入框**把软键盘弹在副屏**, 而不是弹到主屏。
     *
     * 为什么需要(这是从参考实现 agent-mobile-use 学来的缺口):
     *   输入法的目标屏由 `InputMethodManagerService#computeImeDisplayIdForTarget`
     *   决定。它的默认逻辑会把 IME 放到"主屏"上 —— 于是 agent 在副屏点输入框、
     *   用户主屏上却弹出一个键盘。对"不打扰用户"这个核心目标是直接破坏:
     *   用户正看小说/打游戏, 屏幕上突然冒出一块键盘。
     *
     * 做法: 目标屏非 0 时直接返回它自己(`param.setResult(displayId)`)。
     * 与 TARGETS 那批不同, 这个方法的返回值是 int —— 所以**不能**走
     * `hookBoolean`(它只认 boolean 重载), 必须单独 hook, 且参数/返回都要
     * 明确处理。这也是为什么它没有被塞进 TARGETS。
     *
     * 防御: 与别处一致 —— 类找不到只打 MISS; 参数类型不符就原样放行
     * (绝不能让 IME 崩, 那会直接影响用户打字)。
     *
     * @return 成功 hook 的重载数(0 = 没装上)
     */
    private static int hookImeIsolation(ClassLoader cl) {
        final String CN = "com.android.server.inputmethod.InputMethodManagerService";
        final String MN = "computeImeDisplayIdForTarget";
        Class<?> clazz;
        try {
            clazz = XposedHelpers.findClassIfExists(CN, cl);
        } catch (Throwable t) {
            log("ERR(找类) " + CN + ": " + t);
            return 0;
        }
        if (clazz == null) {
            log("MISS " + CN + " (MIUI/HyperOS 上可能被精简)");
            return 0;
        }
        int hooked = 0;
        try {
            for (Method m : clazz.getDeclaredMethods()) {
                if (!MN.equals(m.getName())) continue;
                // 这个方法的返回值是 int; 参数首参是 displayId(int)。
                // 只要签名对得上就 hook, 对不上宁可跳过。
                Class<?>[] ps = m.getParameterTypes();
                if (m.getReturnType() != int.class || ps.length < 1 || ps[0] != int.class) {
                    log("SKIP(签名不符) " + CN + "#" + m.toGenericString());
                    continue;
                }
                if (Modifier.isNative(m.getModifiers()) || Modifier.isAbstract(m.getModifiers())) {
                    log("SKIP(native/abstract) " + CN + "#" + m.toGenericString());
                    continue;
                }
                try {
                    m.setAccessible(true);
                    XposedBridge.hookMethod(m, new XC_MethodHook() {
                        @Override protected void beforeHookedMethod(MethodHookParam param) {
                            try {
                                Object a0 = param.args[0];
                                if (a0 instanceof Integer) {
                                    int displayId = (Integer) a0;
                                    if (displayId != 0) param.setResult(displayId);
                                }
                            } catch (Throwable ignored) {
                                // 出任何问题都放行原逻辑 —— 绝不能让 IME 挂掉
                            }
                        }
                    });
                    hooked++;
                    log("OK " + CN + "#" + m.toGenericString() + " (IME 隔离)");
                } catch (Throwable t) {
                    log("FAIL " + CN + "#" + m.toGenericString() + ": " + t);
                }
            }
        } catch (Throwable t) {
            log("ERR(枚举) " + CN + "#" + MN + ": " + t);
        }
        if (hooked == 0) log("MISS " + CN + "#" + MN + " (方法不存在或签名不符)");
        return hooked;
    }

    // ── 失败计数(全部吞异常: 计数坏了也不能影响开机) ──────────────

    private static int readFails() {
        try {
            File f = new File(FAILS);
            if (!f.exists()) return 0;
            FileInputStream in = new FileInputStream(f);
            try {
                byte[] b = new byte[16];
                int n = in.read(b);
                if (n <= 0) return 0;
                return Integer.parseInt(new String(b, 0, n).trim());
            } finally { in.close(); }
        } catch (Throwable t) { return 0; }
    }

    private static void writeFails(int v) {
        try {
            FileOutputStream out = new FileOutputStream(FAILS);
            try { out.write(String.valueOf(v).getBytes()); } finally { out.close(); }
        } catch (Throwable t) {
            log("写失败计数失败(不影响功能): " + t);
        }
    }

    private static void log(String s) {
        try { XposedBridge.log("[" + TAG + "] " + s); } catch (Throwable ignored) {}
    }

    private static String sysProp(String key, String def) {
        try {
            Class<?> sp = Class.forName("android.os.SystemProperties");
            Method m = sp.getMethod("get", String.class, String.class);
            return String.valueOf(m.invoke(null, key, def));
        } catch (Throwable t) { return def; }
    }
}
