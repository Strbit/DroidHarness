# 夹具来源说明
#
# oneplus-probe-list-displays.txt
#   来源: 真机实跑原样输出
#   设备: OnePlus PLK110 / Android 16 / KernelSU
#   命令: adb shell su -c 'CLASSPATH=/data/adb/dsh/tools/probe/classes.dex \
#           app_process /system/bin Displays'
#   说明: 逐字保存，未改写。用于验证解析器与真机形态一致。
#
# oneplus-probe-error-no-dm.txt
#   来源: **按协议构造**，不是实拍
#   原因: 想抓"拿不到 DisplayManager"的真实输出，但用不存在的类名去跑时
#         app_process 直接 `Aborted` 了（进程级失败，根本没进到我们的 main），
#         所以拿不到 ERROR 行。
#   做法: 按 src/Displays.java 里 error() 的实际格式手写。
#   用途: 只验证**解析器对 ERROR 行的处理**（不静默当成"设备没有屏"），
#         不声称验证了那条运行时路径。
#
# 规矩: 夹具必须注明来源。手写的可以留，但不能标成实拍 ——
#       之前吃过三次"夹具偷偷偏离真机"的亏（字段顺序、段头分隔线、多余的 state 字段）。
