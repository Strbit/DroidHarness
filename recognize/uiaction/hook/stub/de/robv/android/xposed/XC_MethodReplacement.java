// XC_MethodReplacement stub (编译期; 见 XposedBridge.java 说明)
package de.robv.android.xposed;

public abstract class XC_MethodReplacement extends XC_MethodHook {
    /** 常量替换。<T> 泛型是为了 stub 能接受任意返回类型(运行时真签名如此)。 */
    public static <T> XC_MethodReplacement returnConstant(final T value) {
        throw new UnsupportedOperationException("stub");
    }
}
