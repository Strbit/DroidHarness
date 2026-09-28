// 设备夹具：只用真实样本，不编造
//
// 每个样本都注明来源。测试的意义在于覆盖**已知的真实形态差异** ——
// 编造的样本只会测试我的想象。
//
// 来源说明:
//   ONEPLUS  = 从 OnePlus PLK110 实机抓取（fixtures/oneplus-*.txt）
//   XIAOMI   = PR #11 第二轮审阅给出的实测行（@Strbit, Xiaomi 25102RKBEC）
//              逐字采用他贴出的数据和形态，只补齐了段结构的外壳
//   MALFORMED= 故意不含 DisplayDeviceInfo，验证"解析不出来要报错"而不是兜底

/** OnePlus PLK110 · Android 16 —— 实机抓取
 *  字段顺序以真机为准: DisplayDeviceInfo 在前(行 75), mState 在后(行 95)。 */
export const ONEPLUS = {
  name: 'OnePlus PLK110',
  dumpsysDisplay: `Display Devices: size=1
-----------------------
  mDisplayId=0
  mBaseDisplayInfo=DisplayInfo{"内置屏幕", displayId 0, FLAG_SECURE}
  DisplayDeviceInfo{"内置屏幕": uniqueId="local:4630946903293830803", 1272 x 2772, modeId 5, renderFrameRate 55.0, hasArrSupport false, colorMode 0, density 560, 455.0535 x 448.46368 dpi, touch INTERNAL, rotation 0, type INTERNAL, address {port=147, model=0x40446dac388626}}
  mAdapter=LocalDisplayAdapter
  mUniqueId=local:4630946903293830803
  mOverrideDisplayInfo=DisplayInfo{"内置屏幕", displayId 0}
  mState=OFF
  mCommittedState=OFF
  mBrightnessState=-1.0
---------------
`,
  surfaceFlinger: `Display 4630946903293830803 (HWC display 0): port=147 pnpId=QCM displayName=""`,
  power: `mWakefulness=Dozing
mWakefulnessChanging=false
mHoldingDisplaySuspendBlocker=false`,
  viewportsLine: `  mViewports=[DisplayViewport{type=INTERNAL, valid=true, isActive=false, displayId=0, uniqueId='local:4630946903293830803', physicalPort=147, orientation=0}]`,
  expect: {
    count: 1,
    defaultSurfaceFlingerId: '4630946903293830803',
    firstLogicalId: 0,
    firstWidth: 1272,
    firstHeight: 2772,
    firstNativeState: 'OFF',
    wakefulness: 'Dozing',
  },
};

/** Xiaomi 25102RKBEC · Android 16 —— PR #11 第二轮审阅给出的实测行 */
export const XIAOMI = {
  name: 'Xiaomi 25102RKBEC',
  // 审阅原文: `grep -c 'Display [0-9]* \[id=' = 0` —— 这条形态在它上面不存在
  // 审阅原文的稳定行: DisplayDeviceInfo{"内置屏幕": uniqueId="local:4630946964337362323",
  //                 1200 x 2608, modeId 3, renderFrameRate 60.000004, ...
  dumpsysDisplay: `Display Devices: size=1
-----------------------
  mDisplayId=0
  mBaseDisplayInfo=DisplayInfo{"内置屏幕", displayId 0, FLAG_SECURE}
  DisplayDeviceInfo{"内置屏幕": uniqueId="local:4630946964337362323", 1200 x 2608, modeId 3, renderFrameRate 60.000004, hasArrSupport false, colorMode 0, density 440, touch INTERNAL, rotation 0, type INTERNAL}
  mAdapter=LocalDisplayAdapter
  mUniqueId=local:4630946964337362323
  mState=ON
  mCommittedState=ON
---------------
`,
  surfaceFlinger: `Display 4630946964337362323 (HWC display 0): port=147 pnpId=QCM displayName=""`,
  power: `mWakefulness=Awake`,
  viewportsLine: `  mViewports=[DisplayViewport{type=INTERNAL, valid=true, isActive=true, displayId=0, uniqueId='local:4630946964337362323', physicalPort=147, orientation=0}]`,
  expect: {
    count: 1,
    defaultSurfaceFlingerId: '4630946964337362323',
    firstLogicalId: 0,
    firstWidth: 1200,
    firstHeight: 2608,
    firstNativeState: 'ON',
    wakefulness: 'Awake',
  },
};

/** 多屏 + 历史 state 噪声：验证虚拟副屏能枚举出来，且不被历史值污染 */
export const VIRTUAL_DISPLAY = {
  name: '主屏 + 虚拟副屏（模拟形态）',
  dumpsysDisplay: `BrightnessEvent: brt=1569.0 state=OFF
BrightnessEvent: brt=1000.0 state=DOZE
BrightnessEvent: brt=800.0 state=ON
Display Devices: size=2
  mDisplayId=0
  DisplayDeviceInfo{"内置屏幕": uniqueId="local:4630946903293830803", 1272 x 2772, modeId 5, renderFrameRate 60.0, density 560, touch INTERNAL, rotation 0, type INTERNAL}
  mAdapter=LocalDisplayAdapter
  mState=ON
  mCommittedState=ON
  mDisplayId=2
  DisplayDeviceInfo{"AgentVirtualDisplay": uniqueId="local:9999999999999999999", 1080 x 2400, modeId 1, renderFrameRate 60.0, density 420, touch INTERNAL, rotation 0, type VIRTUAL}
  mState=ON
  mCommittedState=ON
---------------
`,
  surfaceFlinger: `Display 4630946903293830803 (HWC display 0): port=147 pnpId=QCM displayName=""
Display 9999999999999999999 (HWC display 1): port=0 pnpId= displayName="AgentVirtualDisplay"`,
  power: `mWakefulness=Awake`,
  viewportsLine: `  mViewports=[DisplayViewport{type=INTERNAL, valid=true, isActive=true, displayId=0, uniqueId='local:4630946903293830803', physicalPort=147, orientation=0}, DisplayViewport{type=VIRTUAL, valid=true, isActive=true, displayId=2, uniqueId='local:9999999999999999999', physicalPort=0, orientation=0}]`,
  expect: {
    count: 2,
    defaultSurfaceFlingerId: '4630946903293830803',
    // 历史 BrightnessEvent 里有 state=OFF 和 state=ON，绝不能污染真实状态
    firstNativeState: 'ON',
    virtualLogicalId: 2,
    virtualSfId: '9999999999999999999',
    virtualWidth: 1080,
  },
};

/** 无 DisplayDeviceInfo：必须报错，不能兜底 */
export const MALFORMED = {
  name: '不含 DisplayDeviceInfo（未来未知设备）',
  dumpsysDisplay: `Some Other Section: size=1
  totally different format, no device info here
---------------
`,
  surfaceFlinger: ``,
  power: `mWakefulness=Awake`,
  expect: { errorIsNotNull: true },
};

export const ALL = [ONEPLUS, XIAOMI, VIRTUAL_DISPLAY, MALFORMED];
