// XposedBridge stub — 编译期用; 运行时由 LSPosed 提供真实实现
//
// ⚠ 返回类型必须与 LSPosed 运行时**逐字一致**: ART 的方法解析把返回类型算进
// 签名描述符, 写成 void/Object 会在真机上抛 NoSuchMethodError(实测踩过:
// "No static method findAndHookMethod(...)V in class .../XposedHelpers")。
// 新版 LSPosed(API 82+)的 hookMethod / findAndHookMethod / hookAllMethods
// 都返回 XC_MethodHook.Unhook (hookAllMethods 返回 Set<Unhook>)。
package de.robv.android.xposed;

import java.lang.reflect.Member;
import java.util.Set;

public final class XposedBridge {
    public static void log(String text) { throw new UnsupportedOperationException("stub"); }
    public static void log(Throwable t) { throw new UnsupportedOperationException("stub"); }

    public static XC_MethodHook.Unhook hookMethod(Member method, XC_MethodHook callback) {
        throw new UnsupportedOperationException("stub");
    }

    /** 覆盖该名字的**所有重载**。这是 hook 不定参数方法的正确入口。 */
    public static Set<XC_MethodHook.Unhook> hookAllMethods(
            Class<?> hookClass, String methodName, XC_MethodHook callback) {
        throw new UnsupportedOperationException("stub");
    }
}
