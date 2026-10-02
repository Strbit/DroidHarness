// XC_LoadPackage stub (编译期; 见 XposedBridge.java 说明)
package de.robv.android.xposed.callbacks;

public class XC_LoadPackage {
    public static final class LoadPackageParam {
        public String packageName;
        public String processName;
        public ClassLoader classLoader;
        public Object appInfo;          // 运行时是 ApplicationInfo; stub 无 android.jar, 用 Object
        public boolean isFirstApplication;
    }
}
