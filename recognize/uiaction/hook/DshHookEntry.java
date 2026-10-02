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
// ⚠⚠ 血泪教训: 这个文件曾经把用户的手机搞到开不了机 ⚠⚠
// ────────────────────────────────────────────────────────
// 旧实现用 `XposedBridge.hookAllMethods(类, "方法名", returnConstant(Boolean.TRUE))`。
// hookAllMethods 的语义是"**覆盖该方法的所有重载**" —— 它不看返回类型。
// 只要某个同名重载返回的不是 boolean(比如 void、int、对象, 或者某个我们自己
// 没料到的包内重载), 就会在**调用点**抛异常 → system_server 崩溃 →
// 反复重启 → 用户被迫进 recovery → 只能格式化 /data 才救回来。
//
// 修法(本文件现在的形态), 四道闸:
//   ① **只 hook 返回类型严格是 boolean 的方法**: 用反射枚举重载, 逐个检查
//      `getReturnType() == boolean.class`, 非 boolean 的**跳过并记录**。
//      这样"把 boolean 方法强改成 true"绝不可能落到别的方法上。
//   ② **native / abstract 方法不碰**(native 改返回值风险最高)。
//   ③ **全程 try/catch, 任何异常只记日志, 绝不向上抛**: 即使 LSPosed API
//      变了、某个类结构变了, 最坏结果是"这个钩子没装上", 而不是开机崩。
//   ④ **两道开关 + 启动失败自愈**:
//        · 必须存在标记文件 /data/system/dsh-vd-hook.on 才启用(安装器创建)。
//          数据被清 → 标记没了 → 模块**彻底惰性**, 不可能再拖垮开机。
//          (路径必须在 system_server 读得到的地方, 见下面 MARKER 的说明)
//        · persist.dsh.vd.hook=0 可临时关闭。
//        · 连续 N 次启动都没能活过 120s → 自动停用自己并留下计数。
//
// 与 agent-mobile-use HookEntry (MIT, © 2026 AcidGr) 的差异
// ────────────────────────────────────────────────────────
//   · 不用 findAndHookMethod: 它在 LSPosed API 82+ 返回 Unhook(不是 void),
//     且对不定参数/重载易漏; 实测其版本在本机 9 个点**全部**
//     NoSuchMethodError/ClassNotFound。
//   · 不用无差别 hookAllMethods(见上, 这是事故根因), 改成"精确到重载"。
//   · 只 hook system_server(作用域里叫 "system"), 去掉 SystemUI/ColorOS 部分。
//   · 逐条打日志(成功/跳过/失败都打) —— 参考实现失败是静默的, 只能靠猜。
//   · 类缺失不算失败: MIUI 精简了一批 server 类, 打 MISS 继续。
package com.dsh.hook;

import android.os.Handler;
import android.os.Looper;

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
    /** 活过这么久就认为这次启动是成功的, 计数清零。 */
    private static final long DISARM_RESET_MS = 120_000L;

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
        // 闸 ④-c: 启动失败自愈
        int fails = readFails();
        if (fails >= MAX_FAILED_BOOTS) {
            log("DISARMED: 连续 " + fails + " 次启动失败, 本次不 hook。"
                    + " 删除 " + FAILS + " 可复位。");
            return;
        }
        writeFails(fails + 1);

        log("loaded in system_server (process=" + lpparam.processName + "), targets="
                + TARGETS.length + ", 第 " + (fails + 1) + " 次尝试");
        ClassLoader cl = lpparam.classLoader;
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

        // 活过 DISARM_RESET_MS 就算这次启动成功了, 计数清零
        try {
            new Handler(Looper.getMainLooper()).postDelayed(new Runnable() {
                @Override public void run() {
                    try {
                        if (new File(FAILS).delete()) log("启动成功, 失败计数已清零");
                    } catch (Throwable ignored) {}
                }
            }, DISARM_RESET_MS);
            log("已挂 " + (DISARM_RESET_MS / 1000) + "s 后的自愈计数清零");
        } catch (Throwable t) {
            log("无法挂载自愈定时器(不影响功能): " + t);
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
