import android.os.Looper;

import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.Method;

/**
 * 屏枚举探针 —— 通过 DisplayManager API 拿**类型化对象**，不解析任何文本。
 *
 * 为什么需要它
 * ------------
 * 在此之前，"设备上有哪些屏 / 每块屏什么状态"这件事是从 `dumpsys display` 的
 * 人类可读转储里用正则挖的。那条路无法靠"多收集几台设备"收敛：
 *
 *   同一个 uniqueId 字段在三处有三种拼法（实测）:
 *     cmd display:        uniqueId "local:..."    无等号
 *     DisplayDeviceInfo:  uniqueId="local:..."    双引号
 *     mViewports:         uniqueId='local:...'    单引号
 *
 *   同一个 mState= 锚点在同一份输出里出现两次（一次是屏状态、一次是
 *   AUTO_BRIGHTNESS_DISABLED），裸 state= 有 101 处历史噪声。
 *
 * API 路线把通用性交给 AOSP 本身。同一机制的活证据就是 `uiautomator` 自己
 * （见 /system/bin/uiautomator）：它不带 App、不用 root、跨机型可用，
 * 因为它走 UiAutomation API 而不是解析文本。
 *
 * 输出协议（stdout，一行一字段，便于 shell/Node 侧解析）
 * --------------------------------------------------
 *   OK|<tool>
 *   SOURCE|<DisplayManager|DisplayManagerGlobal>
 *   COUNT|<n>
 *   DISPLAY|<id>|<key>=<value>|<key>=<value>|...
 *   END
 *
 * 出错时：
 *   ERROR|<code>|<可读说明>
 * 退出码：0 成功 / 2 拿不到 DisplayManager / 3 枚举失败
 *
 * 三条实测得到的硬约束（都踩过，别改）
 * ----------------------------------
 *   1. **必须先 Looper.prepare()，再 ActivityThread.systemMain()**。
 *      顺序反了会 `Can't create handler inside thread that has not called
 *      Looper.prepare()`（Handler 在 ActivityThread 构造函数里就创建了）。
 *   2. `getType()` / `getUniqueId()` 是 @hide，编译期的 android.jar 里没有 ——
 *      但它们**运行时就在那儿**，所以反射是这里的正确做法，不是 hack。
 *   3. DisplayManager 的构造函数是 `(Context, DisplayManagerGlobal)`，
 *      两者都要反射；直接 new 拿不到。
 */
public class Displays {

    // ── 输出 ────────────────────────────────────────────────

    static void line(String s) {
        System.out.println(s);
    }

    static void err(String s) {
        System.err.println("[displays-probe] " + s);
    }

    static void error(String code, String detail) {
        line("ERROR|" + code + "|" + detail);
        System.exit(code.equals("no-display-manager") ? 2 : 3);
    }

    /** 反射调无参方法；失败返回 null（不抛） */
    static String call(Object obj, String method) {
        try {
            Method m = obj.getClass().getMethod(method);
            Object r = m.invoke(obj);
            return r == null ? null : String.valueOf(r);
        } catch (Throwable t) {
            return null;
        }
    }

    /** 读公开字段；失败返回 null */
    static String field(Object obj, String name) {
        try {
            Field f = obj.getClass().getField(name);
            Object v = f.get(obj);
            return v == null ? null : String.valueOf(v);
        } catch (Throwable t) {
            return null;
        }
    }

    /** 追加 k=v，值里若含分隔符就做最小转义（名称可能带 | 或换行） */
    static void kv(StringBuilder sb, String k, String v) {
        if (v == null) return;
        String clean = v.replace("|", "/").replace("\n", " ").replace("\r", " ");
        sb.append('|').append(k).append('=').append(clean);
    }

    // ── 取系统 Context ──────────────────────────────────────

    static Object systemContext() throws Exception {
        Class<?> at = Class.forName("android.app.ActivityThread");
        Method systemMain = at.getDeclaredMethod("systemMain");
        systemMain.setAccessible(true);
        Object thread = systemMain.invoke(null);
        Method getSystemContext = at.getDeclaredMethod("getSystemContext");
        getSystemContext.setAccessible(true);
        return getSystemContext.invoke(thread);
    }

    // ── 主流程 ──────────────────────────────────────────────

    public static void main(String[] args) {
        // ① Looper 必须在最前（见类注释第 1 条）
        if (Looper.myLooper() == null) {
            Looper.prepare();
        }

        Object dm = null;
        Object global = null;

        // ② DisplayManagerGlobal 单例
        try {
            Class<?> gCls = Class.forName("android.hardware.display.DisplayManagerGlobal");
            Method getInstance = gCls.getDeclaredMethod("getInstance");
            getInstance.setAccessible(true);
            global = getInstance.invoke(null);
        } catch (Throwable t) {
            err("DisplayManagerGlobal.getInstance 失败: " + t);
        }

        // ③ DisplayManager（主路径：从系统 Context 取；兜底：反射构造）
        try {
            Object context = systemContext();
            Method getSystemService = context.getClass().getMethod("getSystemService", String.class);
            dm = getSystemService.invoke(context, "display");
        } catch (Throwable t) {
            Throwable c = rootCause(t);
            err("从 Context 取 DisplayManager 失败: " + c.getClass().getSimpleName() + ": " + c.getMessage());
        }
        if (dm == null && global != null) {
            try {
                Class<?> gCls = Class.forName("android.hardware.display.DisplayManagerGlobal");
                Class<?> dmCls = Class.forName("android.hardware.display.DisplayManager");
                Constructor<?> ctor = dmCls.getDeclaredConstructor(
                        Class.forName("android.content.Context"), gCls);
                ctor.setAccessible(true);
                dm = ctor.newInstance(systemContext(), global);
            } catch (Throwable t) {
                err("反射构造 DisplayManager 失败: " + rootCause(t));
            }
        }

        if (dm == null && global == null) {
            error("no-display-manager",
                    "拿不到 DisplayManager 与 DisplayManagerGlobal，无法枚举屏");
        }

        // ④ 首选 DisplayManagerGlobal.getDisplayIds() + getDisplayInfo(id)
        if (global != null) {
            if (emitViaGlobal(global)) return;
        }

        // ⑤ 次选 DisplayManager.getDisplays()（公开 API，但拿不到 DisplayInfo 的细节字段）
        if (dm != null) {
            if (emitViaManager(dm)) return;
        }

        error("enumerate-failed", "两条 API 路径都枚举不出屏");
    }

    static Throwable rootCause(Throwable t) {
        Throwable c = t;
        while (c.getCause() != null) c = c.getCause();
        return c;
    }

    /**
     * DisplayManagerGlobal.getDisplayIds() + getDisplayInfo(id)。
     *
     * getDisplayInfo 返回的是 `android.view.DisplayInfo` —— 一个**字段公开**的
     * 类型化对象。所以这里读的是字段，不是文本。
     */
    static boolean emitViaGlobal(Object global) {
        try {
            Class<?> gCls = global.getClass();
            Method getDisplayIds = gCls.getMethod("getDisplayIds");
            int[] ids = (int[]) getDisplayIds.invoke(global);

            line("OK|list-displays");
            line("SOURCE|DisplayManagerGlobal");
            line("COUNT|" + ids.length);

            Method getDisplayInfo = gCls.getMethod("getDisplayInfo", int.class);
            for (int id : ids) {
                Object info = getDisplayInfo.invoke(global, id);
                StringBuilder sb = new StringBuilder("DISPLAY|").append(id);
                if (info != null) {
                    kv(sb, "name", field(info, "name"));
                    kv(sb, "uniqueId", field(info, "uniqueId"));
                    kv(sb, "type", field(info, "type"));
                    kv(sb, "state", field(info, "state"));
                    kv(sb, "rotation", field(info, "rotation"));
                    kv(sb, "modeId", field(info, "modeId"));
                    kv(sb, "renderFrameRate", field(info, "renderFrameRate"));
                    kv(sb, "logicalWidth", field(info, "logicalWidth"));
                    kv(sb, "logicalHeight", field(info, "logicalHeight"));
                    kv(sb, "appWidth", field(info, "appWidth"));
                    kv(sb, "appHeight", field(info, "appHeight"));
                    kv(sb, "logicalDensityDpi", field(info, "logicalDensityDpi"));
                    kv(sb, "flags", field(info, "flags"));
                    kv(sb, "displayGroupId", field(info, "displayGroupId"));
                    kv(sb, "displayId", field(info, "displayId"));
                } else {
                    kv(sb, "info", "null");
                }
                line(sb.toString());
            }
            line("END");
            return true;
        } catch (Throwable t) {
            err("getDisplayInfo 路径失败: " + rootCause(t));
            return false;
        }
    }

    /**
     * DisplayManager.getDisplays() —— 公开 API。
     * 拿得到 id / name / state / type / uniqueId / rotation / refreshRate，
     * 但**没有** DisplayInfo 那些细分字段（appWidth 等），所以作为次选。
     */
    static boolean emitViaManager(Object dm) {
        try {
            Method getDisplays = dm.getClass().getMethod("getDisplays");
            Object[] displays = (Object[]) getDisplays.invoke(dm);

            line("OK|list-displays");
            line("SOURCE|DisplayManager");
            line("COUNT|" + displays.length);

            for (Object d : displays) {
                StringBuilder sb = new StringBuilder("DISPLAY|").append(call(d, "getDisplayId"));
                kv(sb, "name", call(d, "getName"));
                kv(sb, "uniqueId", call(d, "getUniqueId"));
                kv(sb, "type", call(d, "getType"));
                kv(sb, "state", call(d, "getState"));
                kv(sb, "rotation", call(d, "getRotation"));
                kv(sb, "refreshRate", call(d, "getRefreshRate"));
                kv(sb, "flags", call(d, "getFlags"));
                line(sb.toString());
            }
            line("END");
            return true;
        } catch (Throwable t) {
            err("getDisplays 路径失败: " + rootCause(t));
            return false;
        }
    }
}
