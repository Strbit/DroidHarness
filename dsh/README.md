# DSH on Android 鈥?KernelSU / Magisk 妯″潡

鎶?DeepSeek Harness 璺戝湪**宸?root 鐨?arm64 瀹夊崜璁惧**涓婏紝浠?KernelSU / Magisk 妯″潡褰㈡€佸垎鍙戙€?
- **閫傜敤鑼冨洿**锛氬凡 root 鐨?**arm64-v8a** 瀹夊崜璁惧銆侹ernelSU / Magisk / APatch 鍧囧彲锛堟ā鍧楁牸寮忎笌 Magisk 鍏煎锛?- **娴嬭瘯鐜**锛氬彧鍦?**Redmi K90 Pro Max 路 HyperOS 3 / Android 16 路 KernelSU** 涓婇獙杩囷紱鍏朵粬鏈哄瀷涓?ROM 鏈獙璇?- **涓嶉渶瑕?Termux**锛氳繍琛屾椂鍦?PC 涓婁粠 Termux 鐨?`.deb` 瑙ｅ嚭鏉ワ紝鎵撹繘妯″潡
- **鍙粦 `127.0.0.1`**锛氳繖涓嶆槸淇濆畧锛屾槸璁捐绾︽潫锛堣涓嬶級

## 妯″潡閲屾湁浠€涔?
```
module/
鈹溾攢鈹€ module.prop
鈹溾攢鈹€ customize.sh              瀹夎鏃? 寤虹鍙烽摼鎺?+ 鍐掔儫娴嬭瘯
鈹溾攢鈹€ service.sh                寮€鏈? 鎷夎捣 dsh web (甯︾洃鐫ｄ笌鐔旀柇)
鈹溾攢鈹€ bin/dshctl                鎺у埗鑴氭湰 start/stop/status/log/forward
鈹溾攢鈹€ usr/                      杩愯鏃?(aarch64 Node 26.4.0 + bash + ripgrep + npm + pnpm + 渚濊禆搴?
鈹?  鈹斺攢鈹€ share/doc/<鍖呭悕>/copyright        鍚勭涓夋柟缁勪欢鐨勮鍙瘉鍏ㄦ枃
鈹斺攢鈹€ app/                      DSH 搴旂敤鏍?(495 涓?npm 鍖?
    鈹斺攢鈹€ node_modules/
        鈹溾攢鈹€ @deepseek-ai/dsh/lib/bin.js     鍏ュ彛
        鈹溾攢鈹€ @koromix/koffi-android-arm64/   鍘熺敓妯″潡鐨勫钩鍙伴缂栬瘧鍖?        鈹斺攢鈹€ node-addon-require-builtin/     鈫?宸茶 JS 鏇胯韩椤舵浛, 瑙佷笅
```

**涓轰粈涔堣繍琛屾椂閲屾湁 npm 鍜?pnpm**锛欴SH 鐨勬彃浠剁鐞嗗櫒**鍐欐浜嗚皟鐢?`pnpm`**锛坄execa("pnpm", ...)`锛夛紝
娌℃湁瀹冿紝GUI 鐨?娣诲姞鎻掍欢"鍜?`dsh plugin add` 閮戒細澶辫触銆?
## 璁稿彲璇?
| 鏂囦欢 | 瑕嗙洊 |
|---|---|
| [`../LICENSE`](../LICENSE)锛圓pache-2.0锛?| **鍙鐩栨湰椤圭洰鑷繁鍐欑殑浠ｇ爜** |
| [`../THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md) | **闅忓寘鍒嗗彂鐨勭涓夋柟缁勪欢** 鈥斺€?27 涓繍琛屾椂浜岃繘鍒?+ 495 涓?npm 鍖?|

杩愯鏃堕噷鏈?**5 涓彈 GPL / LGPL 绾︽潫**锛坄bash`銆乣readline`銆乣git`銆乣less`銆乣libiconv`锛夛紝
鍒嗗彂瀹冧滑鏃舵彁渚涘搴旀簮鐮佹槸**涔夊姟**锛屾竻鍗曢噷缁欎簡鍦板潃銆傝鍙瘉鍏ㄦ枃闅忓寘鍙戝湪 `usr/share/doc/<鍖呭悕>/copyright`
锛堣繖浜涙枃浠?*涓嶈瑁佸壀** 鈥斺€?鏃╂湡鐗堟湰鐨勮鍓€昏緫鍒犱簡瀹冧滑锛岄偅鏄敊鐨勶級銆?
---

## 鏋勫缓

```powershell
cd D:\projects\DroidHarness

# 1. 鍙栬繍琛屾椂 (aarch64 Node + bash + ripgrep + npm + pnpm)
node probe\tools\fetch-runtime.mjs --out dsh\module

# 2. 瑁?DSH 搴旂敤鏍戝苟鎵撹ˉ涓?(涓や釜 shim 閮戒細瀹炴祴鏍￠獙)
node dsh\tools\build-dsh-tree.mjs

# 3. 鎵撳寘
node probe\tools\pack-module.mjs --module dsh\module
```

浜х墿鍦?`dsh\dist\`銆?
### 涓轰粈涔堟墦鍖呰剼鏈槸 Node 鑰屼笉鏄?PowerShell

鍘熸潵鐨?`build-module.ps1` 鍔熻兘鏄鐨勶紝浣嗘參寰楃璋憋細**28,074 涓潯鐩 300鈥?60 绉?*銆傛椂闂村嚑涔庡叏鑺卞湪 PowerShell 鐨勯€愭枃浠跺紑閿€涓婏紙瀵硅薄鍒涘缓銆佹祦寮€鍏炽€?NET 浜掓搷浣滐級锛岃€屼笉鏄帇缂?鈥斺€?Deflate 鏈韩鑳借窇 20鈥?0 MB/s锛岄偅鐗堝彧鏈夌害 1 MB/s銆傚畠杩樺浜嗕竴姝ュ畬鍏ㄤ笉蹇呰鐨?staging锛堢敤 `Copy-Item` 鎶?350 MiB 鍐嶆嫹涓€閬嶏級銆?
`pack-module.mjs` 涓嶅仛 staging 鎷疯礉锛岀敤 Node 鐨?zlib锛圕 瀹炵幇锛夛紝寮傛 `deflateRaw` 璧?libuv 绾跨▼姹犳嬁鍒板苟琛屻€傚疄娴?**106 MiB / 219 鏉＄洰 7.1 绉?*銆?
**浠ｄ环鏄綋绉ぇ 5%**锛?NET 鐨?Deflate 鐢ㄧ殑鏄?zlib-ng锛屽帇缂╃巼纭疄姣旀爣鍑?zlib 濂姐€傚疄娴嬪悓涓€涓?`usr/bin/node`锛?
```
.NET (PowerShell)   15.244 MiB
Node zlib level 9   16.151 MiB
```

鎴戣瘯杩?`memLevel:9` / `windowBits:15` / `Z_FILTERED`锛?*鍏ㄩ兘鏇村樊**锛?5.34 / 35.13 / 36.45 MiB vs L9 鐨?35.13锛夈€傛墍浠ヨ繖涓嶆槸鍙傛暟娌¤皟瀵癸紝鏄疄鐜扮殑宸埆銆?
**5% 鐨勪綋绉崲 15脳 鐨勯€熷害鏄垝绠楃殑**锛岃€屼笖鐪熸鐨勪綋绉敹鐩婂湪瑁佸壀 app 鏍戯紙瑙?宸茬煡闄愬埗"锛夈€俙build-module.ps1` 淇濈暀鐫€ 鈥斺€?闇€瑕侀偅 5% 鏃跺彲浠ョ敤瀹冦€?
---

## 瀹夎涓庝娇鐢?
**瑁?*锛欿ernelSU 绠＄悊鍣?鈫?妯″潡 鈫?浠庢湰鍦板畨瑁?鈫?閫?zip銆傚畨瑁呮棩蹇楅噷浼氱湅鍒板啋鐑熸祴璇曠粨鏋溿€?
**閲嶅惎鍚?* `service.sh` 鑷姩鎷夎捣銆傛棩蹇楋細

```sh
adb shell su -c 'cat /data/adb/dsh/logs/dsh.log'
```

**璁块棶**锛堝湪 PC 涓婏級锛?
```powershell
adb forward tcp:3080 tcp:3080
```

鐒跺悗娴忚鍣ㄦ墦寮€ `http://127.0.0.1:3080`銆?
**鎺у埗**锛?
```sh
adb shell su -c 'dshctl status'    # 鍦ㄨ窇鍚? 鐩戝惉鍝噷
adb shell su -c 'dshctl log 60'    # 鐪嬫棩蹇?adb shell su -c 'dshctl restart'
adb shell su -c 'dshctl stop'
adb shell su -c 'dshctl forward'   # 鎵撳嵃 PC 渚ц鏁茬殑鍛戒护
```

---

## 鍥涗釜鍏抽敭鍐冲畾锛堥兘韪╄繃锛?
### 1. `--ignore-scripts` 鏄繀椤荤殑

`npm install` 鐨勫畨瑁呰剼鏈湪 **HOST**锛圵indows锛変笂璺戯紝浣嗗寘鏄粰 **TARGET**锛坅ndroid锛夎鐨勩€俴offi 鐨?`install` 鑴氭湰浼氬姞杞藉钩鍙?`.node`鈥斺€斿畠鎷垮埌鐨勬槸 android 鐨勶紝鍦?Windows 涓婂姞杞戒笉浜嗏€斺€斾簬鏄洖閫€鍒?*浠庢簮鐮佺紪璇?*锛岀劧鍚庡洜涓烘病鏈?CMake 鑰屽け璐ャ€?
璺宠繃鑴氭湰鍗冲彲锛氬钩鍙伴缂栬瘧鍖呭凡缁忕敱 `--os=android --cpu=arm64` 瑁呭ソ浜嗐€?
> 鍙︿竴涓弽渚嬶細**缁濅笉鑳界敤 `--omit=optional`**銆俴offi 鐨勫钩鍙伴缂栬瘧鍖呮鏄?`optionalDependencies`锛岀渷鎺夊畠绛変簬鎶?koffi 搴熸帀銆?
### 2. `node-addon-require-builtin` 蹇呴』鐢?JS 鏇胯韩椤舵浛

鍘熷寘鐨?`optionalDependencies` 閲屽彧鏈夎繖浜涘钩鍙帮細

```
darwin-arm64  darwin-x64  linux-arm64-gnu  linux-x64-gnu
win32-arm64-msvc  win32-x64-msvc  win32-ia32-msvc
```

**娌℃湁 android**锛坄linux-arm64-gnu` 涔熸晳涓嶄簡鈥斺€擜ndroid 鐢?bionic锛屼笉鏄?glibc锛夈€傛墍浠?npm 鍦?Android 涓婁竴涓钩鍙板寘閮借涓嶄笂锛宍require` 蹇呯劧鎶涖€?
鑰?DSH 閲屾湁涓ゅ闇€瑕佸畠锛?
| 浣嶇疆 | 琛屼负 |
|---|---|
| `cordis-plugin-loader` | 鏈?`--expose-internals` 鍒嗘敮涓旀暣浣?try/catch锛?*鏈潵灏变笉浼氭寕** |
| `dsh-app-boot` | **鏃犱繚鎶?*鐨?`createRequire(...)("node-addon-require-builtin")` 鈫?灏辨槸瀹冨繀椤婚《鏇跨殑鍘熷洜 |

**鏇胯韩鐨勫師鐞?*锛氳繖涓寘鍞竴鐨勮兘鍔涙槸"鎶?Node 鐨?internal 妯″潡 require 鍑烘潵"锛岃€?Node 鑷繁灏辨湁杩欐潯璺€斺€斿惎鍔ㄦ椂鍔?`--expose-internals`锛宍require("internal/...")` 鐩存帴鍙敤銆傛墍浠ワ細

```js
function requireBuiltin(moduleId) { return require(moduleId); }
```

涓嶉渶瑕佷换浣曞師鐢熶唬鐮併€傛浛韬簮鐮佸湪 [`shim/node-addon-require-builtin.js`](shim/node-addon-require-builtin.js)锛岀敱 `build-dsh-tree.mjs` 鍦ㄦ瀯寤烘湡瑕嗙洊鍒?`app/node_modules/node-addon-require-builtin/lib/index.js`銆?
**杩欎竴姝ユ槸瀹炴祴杩囩殑**锛屼笉鏄帹鏂細

```
鉁?shim 瀹炴祴閫氳繃: shim-ok object function
路 涓嶅甫鏃楁爣鏃? 闇€瑕?Node 浠?--expose-internals 鍚姩鎵嶈兘瑙ｆ瀽 "internal/..."   鈫?鍙鐨勯敊璇?```

`requireBuiltin("internal/modules/esm/loader")` 杩斿洖鐨勫璞＄‘瀹炲甫 `getOrInitializeCascadedLoader` 鍑芥暟鈥斺€旀鏄?`dsh-app-boot` 闇€瑕佺殑銆?
### 3. `node-addon-system/flock` 涔熻鏇胯韩 鈥斺€?浣嗚繖涓槸**璇箟闄嶇骇**

杩欎釜鏄悗鏉ュ湪鐪熸満涓婃挒鍑烘潵鐨勶紝鐥囩姸寰堢洿鎺ワ細

```
鏈疆杩愯澶辫触: flock is not supported on android-arm64
```

`dsh-session-persistence-jsonl` 鐨勪細璇濆啓鍏ヨ矾寰勮缁?`session.lock` 涓婁竴涓潪闃诲 `flock(2)`锛岀敤鐨勬槸 `@deepseek-ai/node-addon-system` 鐨勫師鐢熸ā鍧椼€傝€屽畠鐨?`optionalDependencies` 閲岋細

```
darwin-arm64  darwin-x64  linux-x64  linux-arm64
                              鈫?娌℃湁 android
```

鍔犺浇鍣ㄧ涓€鍙ュ氨鎸夊钩鍙版嫆缁濓細

```js
if (platform !== 'linux' && platform !== 'darwin') throw ...
```

**娉ㄦ剰锛氭妸 `platform` 楠楁垚 `linux` 涔熸病鐢?* 鈥斺€?瀹冭繕浼氭寜 `report.header.glibcVersionRuntime` 鍦?glibc / musl 涔嬮棿閫夛紝鑰?Android 鐢ㄧ殑鏄?bionic锛屼袱鑰呴兘涓嶆槸銆?
**杩欎釜閿佹槸骞蹭粈涔堢殑**锛氳法**杩涚▼**鐨勪細璇濆啓鎵€鏈夋潈浜掓枼銆備袱涓?DSH 杩涚▼鍚屾椂鍐欏悓涓€涓細璇濇棩蹇椾細鎾曡瀹冦€傞攣鍦ㄦ寔鏈夎€呯殑 fd 鍏抽棴鏃剁敱鍐呮牳閲婃斁锛堣繘绋嬪穿婧冧篃涓€鏍凤級锛屾墍浠ヤ笉浼氱暀姝婚攣銆傝鑰呬笉纰板畠銆?
**涓轰粈涔堝彲浠ラ檷绾?*锛?*涓婃父鑷繁瀵瑰崟杩涚▼閮ㄧ讲灏辨槸杩欎箞鍋氱殑**銆傝鏂囦欢鑷繁鐨勬敞閲婂師鏂囷細

> The browser worker stubs the native flock entry to immediate success: it is single-process, so the in-process write claim already excludes every writer.

鎴戜滑鐨勯儴缃插悓鏍锋槸鍗曡繘绋?鈥斺€?`service.sh` 鏄敮涓€鎷夎捣鍏ュ彛锛屽甫 pidfile 妫€鏌ワ紝鎷掔粷鍚姩绗簩涓疄渚嬶紱杩涚▼鍐呯殑鍐欎簰鏂ョ敱 `SessionWriteLease` 鑷繁鐨勭姸鎬佷繚璇侊紝涓?flock 鏃犲叧銆傛墍浠ヤ涪鎺夌殑**鍙湁**"涓や釜 DSH 杩涚▼涔嬮棿鐨勪簰鏂?銆?
鏇胯韩婧愮爜鍦?[`shim/node-addon-system-flock.js`](shim/node-addon-system-flock.js)锛屽疄娴嬶細

```
鉁?flock shim 瀹炴祴閫氳繃: flock-shim-ok js-shim-single-process
```

**杩欎釜鍋囪浠€涔堟椂鍊欎細鐮?*锛堝悓鏍峰啓鍦?shim 鏂囦欢椤堕儴锛夛細

- 浣犳墜鍔ㄥ啀璺戜竴涓?`dsh web`锛岃€岀洃鐫ｈ繘绋嬩篃鍦ㄨ窇锛屼笖涓よ€呮寚鍚戝悓涓€涓?`DSH_HOME`
- 浣犳妸 `service.sh` 鐨?pidfile 妫€鏌ュ幓鎺?
閭ｆ椂鍙兘鍑虹幇浼氳瘽鏃ュ織鎾曡銆?*鐪熼渶瑕佽法杩涚▼閿佺殑璇濓紝姝ｇ‘鍋氭硶鏄敤 Android NDK 鎶婃湰鍖呰嚜甯︾殑 `src/flock.c` 缂栨垚 android-arm64 鐨?`.node`**锛堟簮鐮佹槸闅忓寘鍙戠殑锛夛紝鑰屼笉鏄户缁敤鏇胯韩銆?
### 4. 鑴氭湰鐨?shebang 鍐欐浜?Termux 璺緞锛屽繀椤婚噸鍐?
**杩欐潯鎴戜竴寮€濮嬫紡浜嗭紝鑰屼笖婕忓緱寰堥殣钄斤細鎴戝彧楠岃瘉浜?ELF 浜岃繘鍒?鑳借窇"锛屾病楠岃瘉鑴氭湰銆?*

Termux 鐨勫寘閲岋紝**鑴氭湰**鏂囦欢鐨?shebang 鍐欐浜嗭細

```
#!/data/data/com.termux/files/usr/bin/sh
```

ELF 浜岃繘鍒朵笉璇?shebang锛屾墍浠ュ畠浠病浜嬶紱浣嗚剼鏈殑琛ㄧ幇鏄€?*鏂囦欢鏄庢槑鍦紝鍗存姤 No such file or directory**銆嶁€斺€?`execve` 鎵句笉鍒拌В閲婂櫒銆?
鏈€闃寸殑涓€渚嬶細`git-submodule` / `git-mergetool` 鏄?git 鑷甫鐨?shell 鑴氭湰锛屽湪 `usr/libexec/git-core/` 涓嬨€俫it 鎵惧緱鍒板畠浠€佷絾 execve 澶辫触锛屼簬鏄?*璋庢姤**鎴愶細

```
git: 'submodule' is not a git command. See 'git --help'.
```

**杩欎釜閿欒淇℃伅浼氭妸鎺掓煡鏂瑰悜甯﹀亸鍒般€実it 瑁呭緱涓嶅叏銆嶃€?* 瀹為檯褰卞搷锛歚git clone --recurse-submodules`銆乣git submodule update`銆乣git mergetool`銆乣git filter-branch` 鍏ㄩ儴涓嶅彲鐢ㄣ€傝€屼笖鎴戝姞杩涜繍琛屾椂鐨?`npm` / `npx` / `wcurl` / `curl-config` **涔熸槸鍔犱簡浣嗕笉鑳界敤** 鈥斺€?瀹冧滑鐨勫叆鍙?`npm-cli.js` 鐨?shebang 鏄?`#!/data/data/com.termux/files/usr/bin/env node`锛岃€?**Android 涓婃病鏈?`/usr/bin/env`**銆?
瀹炴祴鍏?**70 涓?*鏂囦欢锛宍fetch-runtime.mjs` 鐨?`rewriteShebangs()` 鍦ㄦ瀯寤烘湡閲嶅啓鍏朵腑 48 涓細

| 鍘?shebang | 涓暟 | 閲嶅啓鎴?|
|---|---|---|
| `#!鈥?bin/sh` | 32 | `#!/system/bin/sh` |
| `#!鈥?bin/env node` | 12 | `#!/data/adb/modules/dsh_android/usr/bin/node` |
| `#!鈥?bin/env sh` | 2 | `#!/system/bin/sh` |
| `#!鈥?bin/bash` | 2 | `#!/data/adb/modules/dsh_android/usr/bin/bash` |
| `#!鈥?bin/env python3` | 14 | **涓嶅姩** 鈥斺€?妯″潡閲屾病鏈?python |
| `#!鈥?bin/perl` | 7 | **涓嶅姩** 鈥斺€?娌℃湁 perl |
| `#!鈥?bin/python` | 1 | **涓嶅姩** |

涓や釜鍏抽敭缁嗚妭锛?
1. **蹇呴』鍐欒繍琛屾椂璺緞 `/data/adb/modules/<id>/usr/...`锛屼笉鏄?`modules_update/...`** 鈥斺€?瀹夎鏈熼棿鍦?`modules_update`锛岄噸鍚悗灏变笉鍦ㄤ簡銆俙id` 浠?`module.prop` 璇伙紝涓嶅啓姝汇€?2. **鍙敼鏂囨湰鑴氭湰**锛氬厛鍒ゅ墠涓ゅ瓧鑺傛槸涓嶆槸 `#!`锛圗LF 棣栧瓧鑺傛槸 `\x7f`锛屽ぉ鐒舵帓闄わ級锛岃€屼笖鍙崲绗竴琛屻€佸叾浣欏瓧鑺傚師鏍蜂繚鐣欍€?
**閭?22 涓病瑙ｉ噴鍣ㄧ殑**锛坧ython3 / perl / python锛夊湪 README 閲屾爣娉ㄤ负涓嶆敮鎸侊細`node-gyp` 缂栬瘧鍘熺敓妯″潡銆乣git cvsserver` / `git send-email` / `gitweb` / `git p4` 鐢ㄤ笉浜嗐€?
> 杩欐潯鏄?*鎵嬫満绔?agent 瀹炴祴鍑烘潵鐨?*锛屽畠缁欏嚭鐨勬竻鍗曪紙70 涓€佹寜 shebang 鍒嗙被锛夊拰鎴戜簨鍚庡鏍哥殑缁撴灉瀹屽叏涓€鑷淬€?
---

### 5. `git` 浜岃繘鍒堕噷缂栬瘧杩涗簡 Termux 鐨?exec-path

**杩欐潯鍜屼笂闈㈢ 4 鏉℃槸鐙珛闂锛屼絾鐥囩姸鍙犲湪鍚屼竴涓懡浠や笂銆?*

淇畬 shebang 涔嬪悗锛宍npm` / `npx` / `wcurl` 閮借兘鐢ㄤ簡锛屼絾 git 鐨?*鑴氭湰鍨嬪瓙鍛戒护**浠嶇劧鍏ㄦ寕锛岃€屼笖鎶ョ殑鏄?*璇鎬?*鐨勯敊璇細

```
$ git submodule
git: 'submodule' is not a git command. See 'git --help'.
```

鑰?`git-submodule` 鏄庢槑灏卞湪妯″潡閲屻€乻hebang 涔熷凡缁忎慨鎴?`#!/system/bin/sh` 浜嗐€?*闂鍦ㄤ簬 git 鍘嬫牴涓嶅幓妯″潡鐩綍鎵?*锛?
```
$ git --exec-path
/data/data/com.termux/files/usr/libexec/git-core      鈫?杩欎釜鐩綍涓嶅瓨鍦?```

exec-path 鏄?*缂栬瘧杩涗簩杩涘埗**鐨勶紝git 鎵惧瓙鍛戒护鏃跺彧鏌ュ畠銆俠uiltin 瀛愬懡浠わ紙`add` / `commit` / `status` 鈥︼級缂栬瘧鍦ㄤ簩杩涘埗閲屾墍浠ヤ笉鍙楀奖鍝?鈥斺€?杩欎篃鏄繖涓?bug 瀹规槗婕忔帀鐨勫師鍥犮€?
鐩存帴璺戣剼鏈兘鐪嬪埌涓嬩竴灞傜棁鐘讹細

```
$ usr/libexec/git-core/git-submodule
usr/libexec/git-core/git-submodule[22]: .: git-sh-setup: No such file or directory
```

`git-sh-setup` 鍚屾牱闈?exec-path 瀹氫綅銆?
**淇硶**锛坄service.sh`锛夛細

```sh
export GIT_EXEC_PATH="$PREFIX/libexec/git-core"
export GIT_TEMPLATE_DIR="$PREFIX/share/git-core/templates"
```

`GIT_EXEC_PATH` 鏄?git 瀹樻柟鏀寔鐨勮鐩栨柟寮忋€?*涓嶈鏀逛簩杩涘埗** 鈥斺€?閲岄潰閭ｆ潯 Termux 璺緞 48 瀛楄妭锛岃€屾ā鍧楄矾寰?49 瀛楄妭锛屽師鍦版墦琛ヤ竵浼氭孩鍑恒€?
`GIT_TEMPLATE_DIR` 鏄『甯︾殑锛氭ā鏉跨洰褰曚篃鏄?Termux 璺緞锛屼笉璁剧殑璇?`git init` 瑁呭嚭 **0 涓?* hook 鏍锋湰锛堝疄娴嬭浜嗕箣鍚庢槸 14 涓級銆?
**鐪熸満楠屾敹**锛堝湪 DSH 杩涚▼鑷繁鐨勭幆澧冮噷璺戯級锛?
```
git --exec-path -> /data/adb/modules/dsh_android/usr/libexec/git-core
git submodule   -> fatal: not a git repository (...)     鈫?姝ｇ‘琛屼负: 鎵惧埌鑴氭湰骞舵墽琛屼簡
git mergetool   -> warning: failed to exec 'man': ...    鈫?鑴氭湰璺戣捣鏉ヤ簡, 鍙槸娌℃墦鍖?man
git init 鐨?hook 鏍锋湰鏁? 14
```

> 杩欐潯鍚屾牱鏄?*鎵嬫満绔?agent 瀹炴祴鍙戠幇鐨?*銆傚畠杩樻寚鍑轰竴涓鏄撹鍒ょ殑鐐癸細**闂 4 鍜岄棶棰?5 鏄袱涓嫭绔?bug锛屼慨鎺夊叾涓竴涓笉浼氳 `git submodule` 鐨勭棁鐘舵秷澶?* 鈥斺€?鎵€浠ャ€屼慨浜嗗嵈娌″彉鍖栥€嶄笉浠ｈ〃娌′慨瀵广€?
---

## 宸ヤ綔鍖哄湪 `/data/adb/dsh/workspace`锛屼笉鍦?`/sdcard`

**杩欐槸蹇呴』鐨勶紝涓嶆槸鍋忓ソ銆?*

Android 鐨?`/sdcard` 鏄?**FUSE**锛?*涓嶅疄鐜?`link(2)`**锛堝疄娴?`ln a b` 鈫?`Function not implemented`锛夈€傝€?DSH 鐨?`writeFileAtomic` 缁欍€屽垱寤烘柊鏂囦欢銆嶈蛋鐨勬鏄?`link()`锛堜负浜嗘嬁 no-replace 璇箟锛夛細

```js
// @deepseek-ai/dsh-fs-local
if (createIfAbsent !== void 0) try {
    await linkFile(tempPath, absolutePath);      // 鈫?鍒涘缓鏂版枃浠?} catch (error) {
    await throwGuardedCreateFailure(error, ...); // 鈫?涓婃父娌℃湁闄嶇骇
}
...
else await rename(tempPath, absolutePath);       // 鈫?瑕嗙洊宸叉湁鏂囦欢锛團USE 鏀寔锛?```

浜庢槸宸ヤ綔鍖哄湪 `/sdcard` 涓婃椂锛?
```
ENOSYS: function not implemented, link
  '.../.foo.md.<pid>.<uuid>.tmpdir/foo.md.tmp' -> '.../foo.md'
```

**agent 鏃犳硶鏂板缓浠讳綍鏂囦欢锛屽彧鑳芥敼宸茬粡瀛樺湪鐨勩€?* 鑰屽伐浣滃尯鏄富璺緞锛屾墍浠ヨ繖浼氳 harness 鍩烘湰涓嶅彲鐢ㄣ€?
瀹炴祴瀵圭収锛堝悓涓€鍙拌澶囷級锛?
| 浣嶇疆 | 鏂囦欢绯荤粺 | `link()` |
|---|---|---|
| `/sdcard/DroidHarness` | `fuse` | 鉁?`Function not implemented` |
| `/data/adb/dsh/workspace` | ext4 | 鉁?|

**浠ｄ环**锛氬伐浣滃尯鍙樻垚 root-only锛屾櫘閫氭枃浠剁鐞嗗櫒鐪嬩笉鍒帮紝瑕佺敤 root 绠＄悊鍣紙鎴?`adb pull`锛夈€?
**鍙﹀鏋勫缓鏈熻繕缁?`dsh-fs-local` 鎵撲簡琛ヤ竵**锛坄dsh/tools/build-dsh-tree.mjs` 鐨?`TEXT_PATCHES`锛夛紝璁╁畠鍦?`link()` 澶辫触鏃堕檷绾ф垚 `copyFile` + `COPYFILE_EXCL` 鈥斺€?鍚屾牱鏄€岀洰鏍囧凡瀛樺湪灏?EEXIST銆嶇殑鍘熷瓙璇箟锛屼笉闇€瑕佺‖閾炬帴锛?*杩欐牱鍗充娇鐢ㄦ埛鑷繁鎶婂伐浣滃尯閫夊埌 `/sdcard` 涔熻兘鐢?*锛堜唬浠锋槸澶氫竴娆℃嫹璐濓級銆?
> **涓嶈兘闄嶇骇鎴?`rename()`** 鈥斺€?閭ｄ細涓㈡帀 no-replace 璇箟锛屼袱涓苟鍙戝垱寤鸿€呬細浜掔浉瑕嗙洊锛岃€岃皟鐢ㄦ柟鐨?`throwGuardedCreateFailure` 閭ｅ瀹堝崼灏辨槸涓哄畠鍐欑殑銆?>
> 琛ヤ竵甯?*閿氱偣鏍￠獙**锛氭壘涓嶅埌閿氱偣銆佹垨閿氱偣涓嶅敮涓€锛屽氨鐩存帴 die銆傚畞鍙瀯寤哄け璐ワ紝涔熶笉瑕侀潤榛樺け鏁?鈥斺€?閭ｇ bug 鍙湪鐪熸満涓娿€佸彧鍦?agent 鎯冲啓鏂囦欢鏃舵墠鏆撮湶銆?
---

## 鎻掍欢瀹夎锛坧npm锛?
DSH 鐨勬彃浠剁鐞嗗櫒**鎶婂弬鏁板師鏍疯浆鍙戠粰 `pnpm` 鎵ц**锛屾墍浠ヨ繍琛屾椂閲屽繀椤绘湁 pnpm銆傛湰妯″潡甯︾殑鏄?**NDK 缂栫殑 Android ELF**锛坧npm 12.7.0锛?6.8 MiB锛沗ELF 64-bit LSB arm64, dynamic (/system/bin/linker64)` 鈥斺€?涓嶆槸 Termux 閭ｄ釜鍐欐璺緞鐨勬瀯寤猴級銆?
瀹冨湪 Android 涓婃湁涓や釜鍧戯紝`service.sh` 宸茬粡澶勭悊浜嗙涓€涓細

### 1. store 涓嶈兘钀藉湪 `/sdcard`

pnpm 闈?*纭摼鎺?*鎶?store 閲岀殑鏂囦欢閾捐繘 `node_modules`銆傝€?`/sdcard` 鏄?FUSE/sdcardfs锛?*涓嶆敮鎸佺‖閾炬帴** 鈥斺€?璺ㄦ枃浠剁郴缁熶細鐩存帴鎶ワ細

```
Cross-device link not permitted
```

pnpm 鐨?store 榛樿鍦?`$HOME` 涓嬨€傝€屾湰妯″潡鐨?`HOME` 鏄伐浣滃尯 鈥斺€?瀹?*鏇剧粡**鏄?`/sdcard/DroidHarness`锛團USE锛夛紝浜庢槸 pnpm 鎶ワ細

```
ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK
  lock directory must be a real directory owned by the current user
  /sdcard/DroidHarness/.cache/pnpm-store-operation-locks-0
```

**鎵嬫満绔?agent 瀹炴祴锛歚npm_config_cache_dir` / `npm_config_store_dir` / `npm_config_state_dir` / `XDG_CACHE_HOME` / `--cache-dir` / `--config.cacheDir` / `--store-dir` 鍏ㄩ兘鎸笉鍔ㄥ畠** 鈥斺€?pnpm 鏍规湰涓嶈閭ｅ嚑涓彉閲忋€?*鍞竴鏈夋晥鐨勬槸缁欏畠涓€涓崟鐙殑 `HOME`銆?*

鎵€浠ユ瀯寤烘湡鐢熸垚浜嗕竴灞傚惎鍔ㄥ櫒锛?
```
usr/bin/pnpm-bin   鈫?鍘?ELF 鏀瑰悕 (46.8 MiB)
usr/bin/pnpm       鈫?#!/system/bin/sh
                      export HOME="$DSH_HOME_DIR"
                      exec "${0%/*}/pnpm-bin" "$@"
```

鍙敼 pnpm 瀛愯繘绋嬬殑 `HOME`锛孌SH 鑷繁鐨?`HOME` 涓嶅姩锛圙UI 鐨勫伐浣滃尯閫夋嫨鍣ㄤ粠瀹冭捣姝ワ級銆傝繖鏍蜂笉绠″伐浣滃尯琚€夊埌鍝紝pnpm 鐨?store 閮界ǔ鍦?`/data`銆?
> 杩欎釜鍧戞槸**鎵嬫満绔?agent 瀹炴祴鍑烘潵鐨?*锛屼笉鏄垜鎺ㄧ殑銆?>
> 鍙﹀锛歚service.sh` 閲岃繕鐣欑潃涓夎 `npm_config_*`锛岄偅瀵?**pnpm 鏄?no-op**锛堢暀鐫€鏄洜涓?**npm** 浼氳瀹冧滑锛夈€傛垜涓€寮€濮嬩互涓洪偅涓夎淇ソ浜嗛棶棰?鈥斺€?閭ｆ槸閿欑殑銆?
### 2. JS 鐗?pnpm 鐨?shebang锛堟湰妯″潡涓嶅彈褰卞搷锛?
npm 涓婂彂甯冪殑 pnpm 鐨?`bin/pnpm.mjs` shebang 鏄?`#!/usr/bin/env node`锛岃€?**Android 涓婃病鏈?`/usr/bin/env`**锛岀洿鎺?exec 浼氬け璐?鈥斺€?蹇呴』鍖呬竴灞傚惎鍔ㄥ櫒鏄惧紡鐢?node 鎷夎捣銆?
**鏈ā鍧楃敤鐨勬槸 NDK 缂栫殑 Android ELF锛堜笉璇?shebang锛夛紝鎵€浠ヤ笉鍙楄繖鏉″奖鍝嶃€?* 浣嗗鏋滀綘鎶?`usr/bin/pnpm` 鎹㈡垚 npm 涓婄殑 pnpm JS 鍖咃紝灏辫娉ㄦ剰銆?
### 瑁呮彃浠?
Web GUI 鈫?**璁剧疆 鈫?鎻掍欢 鈫?娣诲姞鎻掍欢**锛屽～ npm 鍖呭悕锛堝 `dsh-web-mobile`锛夈€傝瀹屽埛鏂伴〉闈㈠嵆鍙紙瀹㈡埛绔彃浠惰蛋 HMR锛屼笉鐢ㄩ噸鍚?DSH锛夈€?
---

## 涓轰粈涔堝彧缁?`127.0.0.1`

鏈変竴绫昏璁￠敊璇殑鍚庢灉鐗瑰埆涓ラ噸锛屾瀯鎴愭槸涓変釜鍐冲畾鍙犲姞锛?*缁?`0.0.0.0` + 鏃犻壌鏉?+ 鎻愪緵浠绘剰鍛戒护鎵ц**銆備笁鑰呭彔鍔犵瓑浜庢妸璁惧 root 鏉冮檺鎸傚湪缃戠粶涓娿€?
鑰屼笖杩樻湁绗簩鏉℃洿闅愯斀鐨勮矾寰勶細濡傛灉绔偣涓嶆牎楠岃姹傜被鍨嬨€佽€屽搷搴斿張甯﹂€氶厤 CORS 澶达紝**鎵嬫満涓婃祻瑙堝櫒鎵撳紑鐨勪换鎰忕綉椤?*涔熻兘閫犳垚鍛戒护鎵ц鈥斺€?*杩欐潯璺笉鍙楅槻鐏闄愬埗**锛堟湰鏈哄洖鐜祦閲忎笉鍙?iptables 绠★級銆?
DSH 鏈韩灏辨槸涓€涓兘璺?shell 鐨?agent锛屾墍浠ヨ繖閲屾妸绗竴鏉￠拤姝伙細**鍙粦鍥炵幆**銆傝杩滅▼璁块棶灏辫蛋 `adb forward` 鎴?SSH 闅ч亾鈥斺€旈偅鏄湁鎰忎负涔嬨€佹湁鏄庣‘杈圭晫鐨勩€?
---

## 鍏煎鎬?
| 椤?| 鐘舵€?|
|---|---|
| Root 绠＄悊鍣?| **KernelSU 宸插疄娴?*銆侻agisk / APatch 搴旇涔熻兘瑁咃紙妯″潡鏍煎紡鍏煎锛夛紝浣?*鏈獙璇?* |
| ABI | **鍙仛浜?arm64-v8a**銆傚叾浠?ABI 闇€瑕佸彟閰嶈繍琛屾椂锛坄fetch-runtime.mjs --arch`锛?|
| Android 鐗堟湰 | 鍙湪 **Android 16** 涓婇獙杩囥€傝繍琛屾椂鏉ヨ嚜 Termux 鐨勫寘锛岀悊璁烘敮鎸佽寖鍥磋窡瀹冧竴鑷?|
| ROM | 鍙湪 **HyperOS 3** 涓婇獙杩囥€?*妯″潡涓嶄緷璧栦换浣?OEM 鐗规€?*锛汬yperOS / MIUI 鐗规湁鐨勬敞鎰忎簨椤硅[骞冲彴绗旇](../docs/android-agent-harness-plan.md) 绗?3 绔狅紙濡傛灉浣犵殑 ROM 涓嶆槸杩欎竴绯伙紝閭ｇ珷鍙互鏁寸珷璺宠繃锛?|
| 灞忓箷 | 涓嶄緷璧栧叿浣撳垎杈ㄧ巼 / DPI锛堣繍琛屾椂鎺㈡祴锛?|
| SoC | 涓嶄緷璧栥€傚敮涓€娌捐竟鐨勬槸绔晶 OCR 鐨?NPU 鏀寔锛岃€岄偅涓姛鑳界幇鍦ㄦ病鍋?|

## 宸茬煡闄愬埗

- **棣栨瀹夎杈冩參**锛?4,228 涓枃浠惰瑙ｅ帇銆傚畨瑁呰剼鏈?*鏁呮剰涓嶅 `app/` 鍋?`set_perm_recursive`**锛堥偅鏄€愪釜 shell 璋冪敤锛屼細鎱㈠埌涓嶅彲鎺ュ彈锛夛紝鏀圭敤涓€鏉?`chmod -R 0755`銆?- **`node-pty` 娌℃湁鍘熺敓妯″潡**锛氬畨瑁呰剼鏈璺宠繃锛堝畠鍦?HOST 涓婅窇锛岃€屽寘鏄粰 TARGET 鐨勶級锛屾墍浠ユ寔涔呯粓绔笉鍙敤銆侱SH 璁捐涓婂蹇嶃€?- **`sharp` 娌℃湁 android 鍙樹綋**锛氬浘鐗囧鐞嗗彲鑳戒笉鍙敤銆?- **鏋勫缓浜х墿涓嶈繘 git**锛歚dsh/module/{app,usr}/` 鐢变笂闈袱鏉″懡浠ら噸寤恒€?
## 瑁佸壀

`app/` 宸茬粡瑁佽繃涓€杞細**224.6 MiB / 25,715 鏂囦欢 鈫?111.8 MiB / 12,008 鏂囦欢**銆?
瑁佹帀鐨勬槸杩愯鏈熺敤涓嶅埌鐨勪笢瑗匡細source map 44 MiB銆乣.d.ts` 绫诲瀷澹版槑 33 MiB銆乄indows 璋冭瘯绗﹀彿 20 MiB銆丮arkdown 涓庢祴璇曠洰褰?16 MiB銆?
```sh
node dsh/tools/build-dsh-tree.mjs --skip-install --prune --dry-run   # 鍏堢湅浼氬垹浠€涔?node dsh/tools/build-dsh-tree.mjs --skip-install --prune             # 鐪熷垹
```

鎸?*寮曠敤鎵弿**鍒ゆ柇锛屼笉鏄寜鐩綍鍚嶇寽銆傝繖娆″畠鎷︿綇浜嗕竴涓湡浼氬潖浜嬬殑鍒犻櫎锛歚yaml/dist/doc/` 鍚嶅瓧鍍忔枃妗ｏ紝瀹為檯鏄?`Document.js` 杩欎簺**杩愯鏃朵唬鐮?*銆傚悓绫绘暀璁繕鏈?koffi 鐨?`src/`銆?
## 浣撶Н

```
usr/   183.9 MiB /  2,216 鏂囦欢     杩愯鏃?(node 47.4 + pnpm 46.8 + libicudata 33.1 + ...)
app/   111.8 MiB / 12,008 鏂囦欢     DSH 搴旂敤鏍?(宸茶鍓?
                               鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
       295.7 MiB / 14,228 鏂囦欢
zip    113.3 MiB                   (Node 鎵撳寘鍣? 18.7 绉?
```

**`pnpm` 涓€涓枃浠跺氨 46.8 MiB** 鈥斺€?瀹冩槸闈欐€侀摼鎺ョ殑 Rust 浜岃繘鍒讹紝鑰屼笖**宸茬粡 strip 杩?*锛坄.debug_*` 涓?`.symtab` 閮芥槸 0锛宍.text` 鍗?36 MiB锛夛紝娌″緱鍘嬨€傛兂鍐嶇槮韬彧鏈変袱鏉¤矾锛岄兘瑕佸厛鍦ㄧ湡鏈轰笂楠岃瘉鎻掍欢鑳借涓婏細鎹㈡垚 npm 涓婄殑 pnpm JS 鍖咃紙鐪佺害 33 MiB锛屾湭楠岃瘉鑳藉惁鍦?bionic 涓婅窇锛夈€佹垨涓嶈 `git`锛堢渷绾?17 MiB锛屼唬浠锋槸 `dsh plugin add github:...` 涓嶅彲鐢級銆?
## 宸插疄娴?
鍦ㄦ祴璇曟満锛圧EDMI K90 Pro Max 路 HyperOS 3 / Android 16 路 KernelSU锛変笂锛?
```
妯″潡鐩綍 exec: OK   (u:r:ksu:s0 + SELinux enforcing)
Node 26.4.0 / ABI 147 / platform=android / arch=arm64
spawn / TLS / 绯荤粺 CA 搴? 鍏ㄨ繃
shim 瀹炴祴閫氳繃: shim-ok object function
dsh web 宸叉媺璧? 鐩戝惉 127.0.0.1:3080, Web GUI 鍙甯歌闂?```

**涓や釜 shim 閮藉湪鐪熸満涓婇獙杩?*锛堢敤鎵嬫満鑷繁鐨?Node 璺戠湡瀹?import锛屼笉鏄湪 PC 涓婃帹鏂級锛?
```
$ node --input-type=module -e 'import {tryLockExclusive,FLOCK_IMPLEMENTATION} from "@deepseek-ai/node-addon-system/flock"; ...'
flock-ok js-shim-single-process
```

**閰嶇疆 API 鍚庡璇濊兘姝ｅ父璺戝畬** 鈥斺€?2026-09-26 鐪熸満纭锛屼慨鎺変簡涔嬪墠閭ｅ彞
`鏈疆杩愯澶辫触: flock is not supported on android-arm64`銆?
### 楠岃瘉鏃惰俯鐨勫潙涓€锛歚adb shell su` 涓嶄竴瀹氬瓨鍦?
杩欏彴璁惧涓?`su` 涓嶅湪 `adb shell` 鐨?PATH 閲岋紙KernelSU 榛樿涓嶅線 PATH 鏀?`su`锛夛細

```
$ adb shell 'su -c id'
/system/bin/sh: su: inaccessible or not found
```

**瑕佸湪 KernelSU 绠＄悊鍣ㄩ噷缁?`com.android.shell`锛坲id 2000锛夋巿鏉?root锛宍adb shell su` 鎵嶈兘鐢ㄣ€?* 鍦ㄩ偅涔嬪墠鎵€鏈?`adb shell "su -c '...'"` 褰㈠紡鐨勫懡浠ら兘浼氬け璐?鈥斺€?鑰屽け璐ヤ俊鎭槸 "not found"锛屽緢瀹规槗琚璇绘垚"娌?root"銆?
### 楠岃瘉鏃惰俯鐨勫潙浜岋細鍒嬁绔彛鍙风寽鏈嶅姟

PC 鐨?`127.0.0.1:3080` 鏄?*鐢佃剳绔嚜宸辩殑 DSH**銆傛墜鏈虹瑕佸彟寮€涓€涓浆鍙戠鍙ｏ紙鏈」鐩敤 `13080`锛夛細

```powershell
adb forward tcp=13080 tcp=3080
adb forward --list          # 鈫?鍏堢湅鏄犲皠琛? 鍒嬁杩斿洖鍊肩寽鏄皝
```

涓嶅甫 token 璁块棶浼氬緱鍒?**401**锛圖SH 鐨?token 閴存潈锛夆€斺€?閭ｆ槸**杞彂閫氫簡**鐨勮瘉鎹紝涓嶆槸閿欒銆倀oken 姣忔閲嶅惎 DSH 閮戒細鍙橈紝鍙?`dshctl log` 閲屾渶鏂伴偅鏉°€?
### 楠岃瘉鏃惰俯鐨勫潙涓夛細Windows 涓婂甫鍐掑彿鐨?deb 鏂囦欢鍚?
瑙?`probe/tools/fetch-runtime.mjs` 閲?`safeCacheName()` 鐨勬敞閲娿€侱ebian 鐨?epoch 鐗堟湰鍙峰舰濡?`1:3.6.3`锛屼細鍘熸牱鍑虹幇鍦ㄧ储寮曠殑 `Filename` 閲岋紝鑰?Windows 鎶?`:` 褰?NTFS 澶囩敤鏁版嵁娴佸垎闅旂 鈥斺€?浜庢槸 `openssl` 涓?`ca-certificates` 琚潤榛樿烦杩囷紝**TLS 褰诲簳鍧忔帀涓旀病鏈変换浣曟姤閿?*銆?
## 涓?`probe/` 鐨勫叧绯?
`probe/` 鏄?*鍦板熀楠岃瘉妯″潡**锛屽畠鍥炵瓟浜?KernelSU 妯″潡閲岃兘涓嶈兘璺?bionic Node"杩欎釜闂锛?
```
妯″潡鐩綍 exec: OK (u:r:ksu:s0 + enforcing)
Node 26.4.0 / ABI 147 / platform=android / arch=arm64
spawn / TLS / CA 鍏ㄨ繃
```

缁撹閫氳繃鍚庢墠鏈夎繖涓寮忔ā鍧椼€俙probe/` 淇濈暀鐫€锛屼互鍚庢帓鏌ュ钩鍙伴棶棰樿繕鑳界敤銆?
骞冲彴浜嬪疄銆佸钩鍙拌涓轰笌鍧戞竻鍗曘€佸畨鍏ㄨ璁¤緭鍏ャ€侀闄╃櫥璁板唽鐨勫畬鏁磋褰曡 [`../docs/android-agent-harness-plan.md`](../docs/android-agent-harness-plan.md)銆?