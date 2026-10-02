// XC_MethodHook stub (编译期; 见 XposedBridge.java 说明)
package de.robv.android.xposed;

import java.lang.reflect.Member;

public abstract class XC_MethodHook {
    protected void beforeHookedMethod(MethodHookParam param) throws Throwable {}
    protected void afterHookedMethod(MethodHookParam param) throws Throwable {}

    /** hook 句柄。**必须存在**: LSPosed 的 hookMethod/hookAllMethods 返回它。 */
    public class Unhook implements java.util.function.Consumer<XC_MethodHook> {
        public void unhook() { throw new UnsupportedOperationException("stub"); }
        @Override public void accept(XC_MethodHook hook) { throw new UnsupportedOperationException("stub"); }
    }

    public static final class MethodHookParam {
        public Member method;
        public Object thisObject;
        public Object[] args;
        public Object result;
        public Throwable throwable;
        public boolean returnEarly;
        public Object getResult() { throw new UnsupportedOperationException("stub"); }
        public void setResult(Object r) { throw new UnsupportedOperationException("stub"); }
    }
}
