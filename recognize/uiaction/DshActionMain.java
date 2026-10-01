// DshActionMain.java — 设备侧动作注入的一次性进程（screen-mcp 每次动作 fork 一次）
//
// 为什么是 Java/app_process 而不是 Node 子进程
// ─────────────────────────────────────────
// 文字注入唯一的确定性通道是无障碍 ACTION_SET_TEXT（CharSequence 原生携带 UTF-8，
// 实测微信 EditText 一次写入「国庆快乐」成功且可读回）。该 API 只有无障碍连接里的
// 进程才有，Node 没有。uiautomator 的 shell 命令没有这个动作；`input text` 只收
// ASCII。所以动作层是一个 app_process Java 工具：与 uiautomator dump 同一信任级别
// （UiAutomation），单发单收，exit 码承载成败。
//
// 为什么"一次一进程"而不是常驻 daemon
// ─────────────────────────────────
// agent-mobile-use 用常驻 stdin 循环，但它有两个我们不必付的代价：
//   · 常驻 = 与 uiautomator dump 抢 UiAutomation 单会话（单飞锁那段注释）。
//     我们 screen_tree 仍走 uiautomator dump；动作进程生灭，dump 不会被我们卡死。
//   · 常驻进程死亡后的状态自愈要自己写；单发进程每次都是干净启动。
// 代价是每次 fork ~300ms 冷启动——动作频率下完全可接受。
//
// 借鉴 agent-mobile-use（MIT, © 2026 AcidGr）的关键实现，均已在本机验证：
//   · UiAutomation 反射引导（HandlerThread looper；绕开 app_process 无主 Looper
//     时 AccessibilityInteractionClient 构造器抛异常被 RuntimeInit 杀死的 exit 137）
//   · connect(int) / connect() 双形态
//   · setServiceInfo flags = INCLUDE_NOT_IMPORTANT|WEB|VIEW_IDS|RETRIEVE_INTERACTIVE_WINDOWS
//   · getWindowsOnAllDisplays() —— 这是 uiautomator dump 拿不到的非默认屏树
//   · ACTION_SET_TEXT + 60ms + refresh() 读回 + isMasked（密码框圆点判成功）
//   · 无 fallback：写失败就带证据报错，绝不退化为乱点（乱点比失败危险）
//
// 用法（全部参数走 argv，不拼 shell 字符串——与 screen-mcp.mjs 同一条注入纪律）:
//   DshActionMain text <displayId> <b64-utf8> [target] [mode]   target=focused; mode=replace|append
//   DshActionMain type  <displayId> <plain-utf8-argv>           便捷形态（不推荐 CJK 用）
//   DshActionMain nodeinfo <displayId>                          列出可编辑节点（JSON）
// 输出: stdout 一行 JSON + END 标记。exit: 0=ok, 3=业务失败(见 json.error), 1=基础设施失败。
package com.dsh.uiaction;

import android.accessibilityservice.AccessibilityServiceInfo;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.lang.reflect.Constructor;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;

public final class DshActionMain {
    private static final String END = "<<<END_OF_JSON>>>";

    public static void main(String[] args) {
        // ⚠ 主 Looper 必须最先准备(真机 logcat 实测的坑, 不要挪走):
        // app_process 起的进程**没有主 Looper**。UiAutomation.connect() 会走到
        // AccessibilityInteractionClient, 它的构造器执行 new Handler(Looper.getMainLooper());
        // 拿到的 Looper 是 null → Handler 构造器读 Looper.mQueue NPE →
        // "FATAL EXCEPTION: UiAutomation" → RuntimeInit 把整个进程杀掉
        // (表现为 shell 打印 "Killed"、exit 137、stderr 里什么都没有)。
        // 真机症状: screen_text 报 "Command failed" 且无任何输出 —— 极难归因。
        if (android.os.Looper.getMainLooper() == null) {
            android.os.Looper.prepareMainLooper();
        }
        String json;
        int code;
        try {
            if (args.length == 0) { json = errJson("usage", "无参数。用法: text|type|nodeinfo ..."); code = 1; }
            else {
                String action = args[0];
                if ("text".equals(action) || "type".equals(action)) {
                    if (args.length < 3) { json = errJson("usage", "text <displayId> <b64|plain> [target] [mode]"); code = 1; }
                    else {
                        int displayId = Integer.parseInt(args[1]);
                        String text = "text".equals(action)
                                ? new String(Base64.getDecoder().decode(args[2]), StandardCharsets.UTF_8)
                                : args[2];
                        String target = args.length >= 4 ? args[3] : "focused";
                        String mode = args.length >= 5 ? args[4] : "replace";
                        json = runType(displayId, target, text, "append".equals(mode));
                        code = isOk(json) ? 0 : 3;
                    }
                } else if ("nodeinfo".equals(action)) {
                    if (args.length < 2) { json = errJson("usage", "nodeinfo <displayId>"); code = 1; }
                    else { json = runNodeInfo(Integer.parseInt(args[1])); code = isOk(json) ? 0 : 3; }
                } else {
                    json = errJson("usage", "未知动作: " + action); code = 1;
                }
            }
        } catch (Throwable t) {
            json = errJson("internal_error", String.valueOf(t));
            code = 1;
        }
        System.out.print(json + "\n" + END + "\n");
        System.out.flush();
        System.err.flush();
        Runtime.getRuntime().halt(code);
    }

    private static boolean isOk(String json) { return json.startsWith("{\"ok\":true"); }

    private static String errJson(String error, String reason) {
        return "{\"ok\":false,\"error\":\"" + esc(error) + "\",\"reason\":\"" + esc(reason) + "\"}";
    }

    // ── UiAutomation 引导 ────────────────────────────────────────

    /** 引导结果: uiAutomation 对象 + 它的 Class（反射调用全程不引用具体类型签名以外的 API）。 */
    private static final class Boot {
        final Object ua;
        final Class<?> cls;
        Boot(Object ua, Class<?> cls) { this.ua = ua; this.cls = cls; }
    }

    private static Boot boot() throws Exception {
        android.os.HandlerThread ht = new android.os.HandlerThread("DshActionThread");
        ht.start();
        Class<?> uacClass = Class.forName("android.app.UiAutomationConnection");
        Object uac = uacClass.getConstructor().newInstance();
        Class<?> uiClass = Class.forName("android.app.UiAutomation");
        Class<?> iuacClass = Class.forName("android.app.IUiAutomationConnection");
        Object ua = uiClass.getConstructor(android.os.Looper.class, iuacClass)
                .newInstance(ht.getLooper(), uac);
        try {
            uiClass.getMethod("connect", int.class).invoke(ua, 0);
        } catch (NoSuchMethodException e) {
            uiClass.getMethod("connect").invoke(ua);
        }
        AccessibilityServiceInfo info = new AccessibilityServiceInfo();
        info.eventTypes = -1;              // TYPE_WINDOWS_CHANGED | TYPE_WINDOW_CONTENT_CHANGED | ...
        info.feedbackType = 16;            // FEEDBACK_GENERIC
        info.flags = 0x2 | 0x8 | 0x10 | 0x40;
        // 0x2 INCLUDE_NOT_IMPORTANT: 也收"对无障碍不重要"的窗口（部分输入框挂在上面）
        // 0x8 WEB_ACCESSIBILITY     : WebView 内容
        // 0x10 VIEW_IDS             : getViewIdResourceName() 可用（读回定位要用）
        // 0x40 RETRIEVE_INTERACTIVE_WINDOWS: getWindowsOnAllDisplays() 需要
        uiClass.getMethod("setServiceInfo", AccessibilityServiceInfo.class).invoke(ua, info);
        return new Boot(ua, uiClass);
    }

    // ── 节点收集 ────────────────────────────────────────────────

    /** 指定屏的所有窗口根节点；空树时重扫（微信等首帧常为空，实测 3×300ms 够）。 */
    private static List<AccessibilityNodeInfo> rootsByDisplay(Boot boot, int displayId) throws Exception {
        List<AccessibilityNodeInfo> roots = new ArrayList<>();
        Object displays = boot.cls.getMethod("getWindowsOnAllDisplays").invoke(boot.ua);
        if (displays == null) return roots;
        Class<?> saClass = displays.getClass();
        int n = (Integer) saClass.getMethod("size").invoke(displays);
        Method keyAt = saClass.getMethod("keyAt", int.class);
        Method valueAt = saClass.getMethod("valueAt", int.class);
        for (int i = 0; i < n; i++) {
            int dId = (Integer) keyAt.invoke(displays, i);
            if (dId != displayId) continue;
            List<?> wins = (List<?>) valueAt.invoke(displays, i);
            if (wins == null) continue;
            for (Object win : wins) {
                Object rootObj;
                try { rootObj = win.getClass().getMethod("getRoot").invoke(win); }
                catch (Throwable t) { rootObj = null; }
                if (rootObj instanceof AccessibilityNodeInfo) roots.add((AccessibilityNodeInfo) rootObj);
            }
        }
        return roots;
    }

    private static void collectAll(AccessibilityNodeInfo node, int depth, List<AccessibilityNodeInfo> out) {
        if (node == null || depth > 40) return;
        out.add(node);
        for (int i = 0; i < node.getChildCount(); i++) {
            try { collectAll(node.getChild(i), depth + 1, out); } catch (Throwable ignored) {}
        }
    }

    private static List<AccessibilityNodeInfo> scanDisplay(Boot boot, int displayId) throws Exception {
        List<AccessibilityNodeInfo> all = new ArrayList<>();
        for (int pass = 0; pass < 3; pass++) {
            all.clear();
            for (AccessibilityNodeInfo root : rootsByDisplay(boot, displayId)) collectAll(root, 0, all);
            if (!all.isEmpty()) break;
            Thread.sleep(300);
        }
        return all;
    }

    // ── 动作: 注入文本 ───────────────────────────────────────────

    private static String runType(int displayId, String targetSpec, String text, boolean append) {
        String error = null, reason = null, focusHint = null, bounds = null;
        String before = null, after = null, vid = null, cls = null, mode = "none";
        boolean ok = false;
        long start = System.currentTimeMillis();
        try {
            Boot boot = boot();
            List<AccessibilityNodeInfo> all = scanDisplay(boot, displayId);

            AccessibilityNodeInfo target = null;
            boolean focusMode = targetSpec == null || targetSpec.isEmpty() || "focused".equalsIgnoreCase(targetSpec);
            if (focusMode) {
                AccessibilityNodeInfo focusedAny = null;
                for (AccessibilityNodeInfo an : all) {
                    if (an.isFocused() && an.isEditable()) { target = an; break; }
                    if (focusedAny == null && an.isFocused()) focusedAny = an;
                }
                if (target == null && focusedAny != null) target = firstEditable(focusedAny);
                if (target == null) {
                    error = "no_focused_input";
                    if (focusedAny == null) focusHint = "nothing";
                    else focusHint = typeOf(focusedAny) + "@" + rectOf(focusedAny);
                    reason = "当前没有聚焦的可输入框。先 screen_tap 点击输入框再 screen_text（不传 target）。";
                }
            } else {
                error = "invalid_target";
                reason = "screen_text 只支持 focused（先点击聚焦，再注入）。资源定位交给 screen_tree/screen_targets。";
            }

            // 单通道：一次 ACTION_SET_TEXT、一次读回、一个结论。故意没有第二策略——
            // 任何 fallback（点中心再粘贴）都会把"定位错了"放大成"乱点+剪贴板被清"。
            if (target != null && error == null) {
                vid = target.getViewIdResourceName();
                cls = typeOf(target);
                bounds = rectOf(target);
                CharSequence bc = target.getText();
                before = bc != null ? bc.toString() : null;
                // append: 在原文本后接新文本。注意 ACTION_SET_TEXT 是**替换**语义;
                // 拿 before 拼接即可, 但 before 可能是密码框圆点(见 isMasked) ——
                // 圆点时 append 会写入圆点字符, 所以密码框上 append 一律拒绝。
                String finalText = text;
                if (append) {
                    if (before != null && isMasked(before, before)) {
                        error = "append_rejected";
                        reason = "目标框是密码框(读回是圆点), append 会把圆点写进真文本 —— 拒绝。";
                        finalText = null;
                    } else {
                        finalText = (before != null ? before : "") + text;
                    }
                }
                if (finalText != null) {
                    android.os.Bundle bargs = new android.os.Bundle();
                    bargs.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, finalText);
                    boolean setOk = false;
                    try { setOk = target.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, bargs); }
                    catch (Throwable ignored) {}
                    if (!setOk) {
                        error = "inject_rejected";
                        reason = "ACTION_SET_TEXT 被拒绝（控件可能不支持 setText）。";
                    } else {
                        mode = append ? "action_set_text_append" : "action_set_text";
                        Thread.sleep(60);
                        boolean fresh = true;
                        try { fresh = target.refresh(); } catch (Throwable t) { fresh = false; }
                        CharSequence ac = target.getText();
                        after = ac != null ? ac.toString() : null;
                        if (!fresh) { ok = true; error = "verify_unavailable"; reason = "stale_node"; }
                        else if (after == null) { ok = true; error = "verify_unavailable"; reason = "unreadable"; }
                        else if (after.equals(finalText)) { ok = true; }
                        else if (isMasked(after, finalText)) { ok = true; error = "verify_unavailable"; reason = "masked"; }
                        else { error = "verify_mismatch"; reason = "读回 \"" + after + "\" != 写入 \"" + finalText + "\""; }
                    }
                }
            }
        } catch (Throwable t) {
            error = "internal_error";
            reason = String.valueOf(t);
        }
        long cost = System.currentTimeMillis() - start;
        StringBuilder sb = new StringBuilder();
        sb.append("{\"ok\":").append(ok);
        sb.append(",\"display\":").append(displayId);
        sb.append(",\"mode\":\"").append(esc(mode)).append("\"");
        sb.append(",\"cost_ms\":").append(cost);
        if (vid != null) sb.append(",\"vid\":\"").append(esc(vid)).append("\"");
        if (cls != null) sb.append(",\"type\":\"").append(esc(cls)).append("\"");
        if (bounds != null) sb.append(",\"bounds\":\"").append(esc(bounds)).append("\"");
        if (error != null) sb.append(",\"error\":\"").append(esc(error)).append("\"");
        if (reason != null) sb.append(",\"reason\":\"").append(esc(reason)).append("\"");
        if (focusHint != null) sb.append(",\"focus_hint\":\"").append(esc(focusHint)).append("\"");
        if (before != null) sb.append(",\"before_text\":\"").append(esc(before)).append("\"");
        if (after != null) sb.append(",\"verified_text\":\"").append(esc(after)).append("\"");
        sb.append("}");
        return sb.toString();
    }

    // ── 动作: 列出可编辑节点（供模型确认靶子）──────────────────

    private static String runNodeInfo(int displayId) {
        long start = System.currentTimeMillis();
        try {
            Boot boot = boot();
            List<AccessibilityNodeInfo> all = scanDisplay(boot, displayId);
            StringBuilder items = new StringBuilder();
            int count = 0;
            for (AccessibilityNodeInfo an : all) {
                if (!an.isEditable()) continue;
                CharSequence tc = an.getText();
                String t = tc != null ? tc.toString() : "";
                if (items.length() > 0) items.append(",");
                items.append("{\"vid\":\"").append(esc(nz(an.getViewIdResourceName())))
                     .append("\",\"type\":\"").append(esc(typeOf(an)))
                     .append("\",\"bounds\":\"").append(rectOf(an))
                     .append("\",\"focused\":").append(an.isFocused())
                     .append(",\"text\":\"").append(esc(truncate(t, 80))).append("\"}");
                count++;
                if (count >= 20) break;
            }
            return "{\"ok\":true,\"display\":" + displayId
                    + ",\"cost_ms\":" + (System.currentTimeMillis() - start)
                    + ",\"editable_count\":" + count
                    + ",\"editable\":[" + items + "]}";
        } catch (Throwable t) {
            return errJson("internal_error", String.valueOf(t));
        }
    }

    // ── 小工具 ─────────────────────────────────────────────────

    private static AccessibilityNodeInfo firstEditable(AccessibilityNodeInfo node) {
        if (node == null) return null;
        if (node.isEditable()) return node;
        for (int i = 0; i < node.getChildCount(); i++) {
            try {
                AccessibilityNodeInfo r = firstEditable(node.getChild(i));
                if (r != null) return r;
            } catch (Throwable ignored) {}
        }
        return null;
    }

    private static String typeOf(AccessibilityNodeInfo n) {
        CharSequence cn = n.getClassName();
        String s = cn != null ? cn.toString() : "View";
        int dot = s.lastIndexOf('.');
        return dot >= 0 ? s.substring(dot + 1) : s;
    }

    private static String rectOf(AccessibilityNodeInfo n) {
        android.graphics.Rect r = new android.graphics.Rect();
        n.getBoundsInScreen(r);
        return r.left + "," + r.top + "," + r.right + "," + r.bottom;
    }

    private static String nz(String s) { return s != null ? s : ""; }

    private static String truncate(String s, int max) {
        return s.length() <= max ? s : s.substring(0, max) + "…";
    }

    /**
     * 密码框读回是圆点而不是原文——这是**成功**而不是失配。
     * 判据来自 agent-mobile-use isMasked()：长度一致（或圆点满额）且全是遮罩字符。
     */
    private static boolean isMasked(String shown, String sent) {
        if (shown == null || sent == null || sent.isEmpty()) return false;
        if (shown.length() != sent.length() && shown.length() != 1) return false;
        for (int i = 0; i < shown.length(); i++) {
            char c = shown.charAt(i);
            if (c != '•' && c != '●' && c != '○' && c != '∗' && c != '*' && c != '\u2022') return false;
        }
        return true;
    }

    private static String esc(String s) {
        if (s == null) return "";
        StringBuilder sb = new StringBuilder(s.length() + 8);
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '\\': sb.append("\\\\"); break;
                case '"': sb.append("\\\""); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
            }
        }
        return sb.toString();
    }
}
