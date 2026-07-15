# GLB 集成进度（INTEGRATION-PROGRESS）

最后更新：2026-07-15（**里程碑 11 完成**：移动端横握改版——插卡即转场（zoom+roll 90°）、双轴撑满取景、屏幕外卡带盒+侧滑唤出、grip 内换卡；mobile-grip 套件重写 38 断言；e2e **49/49** 原样全过 = 桌面零改动）

## 里程碑 11：移动端横握改版（本轮，完成）

用户反馈里程碑 9 的横握理解错了，按新规格重做：插卡即主动转场、横屏完全撑满不留背景边、收纳包藏屏幕外右侧+侧滑唤出、换卡全程不退出横握。全部逻辑仍只在 coarse+小屏路径；桌面 e2e 49/49 逐位不变。

### ① 插卡即转场（INSERTING 开始）
- `insertFlow` 同步前缀（= 拖卡松手的用户手势链内，transient activation 有效）新增：`tryLandscapeLock()`（`documentElement.requestFullscreen()` → 链内 `screen.orientation.lock('landscape')`，Android 有效；全链路 catch 静默，iOS 降级为旋转提示药丸）+ `scene3d.beginGripCinematic()` + 关抽屉。替代里程碑 9 的"canvas pointerdown 试探一次 lock"（已删除）。
- **过场动画**：`Scene3D.cineT` 0→1（GRIP_CINE_DUR=0.8s，easeInOutCubic），每帧在 lookAt 后 `camera.rotateZ(-(1-k)·90°)`——绕视轴 roll 90°→0°，同时相机 rig 以既有 damp 从竖屏 play 机位推近到 grip 机位（zoom）。时长与 insertSequence 0.82s 同步，BOOTING 点亮时刚好到位。每场页面会话只播一次（`cineDone`）；Android 锁定成功→视口旋转→resize→grip 布局，动画与物理旋转叠加；iOS 未锁定→竖屏播一次（镜头语言即"该转了"），物理旋转后直接进入不重播。
- **gripSession**：`beginGripCinematic` 置位（仅 gripEligibleDevice 会调用）；`gripMode = layout==='grip' && gripSession && !gripSuppressed`（不再依赖 playView）——换卡经过的 OFF 窗口保持横握取景，"换卡全程不退出横握"。suppressed 复位语义不变（离开 grip 上下文：转竖屏或弹卡 OFF）。fresh-load 横屏无 session → hero，行为同 m9。
- prefers-reduced-motion：`beginGripCinematic` 直接标记 done、不启动 cineT → 零 roll 直接到位（套件断言 roll 恒 0）。

### ② 完全撑满（双轴）
- `GRIP_HALF_WIDTH 74→67.5`、`GRIP_TARGET (−0.8,8,13.35)→(−0.8,1.5,13.35)`（elev 0.02、应用层 clamp 0.05 不变）。844×390 实测（refit 吸附后）：设备 bbox 投影 x −54..909（覆盖宽 114% ≥98%）、y −72..473（覆盖高 140% ≥100%）→ 背景纸色不可见；LCD 95→**241px（×2.55 vs 竖屏 play）**；D-pad (103,153)、A (784,132)、B (707,159) 全部距边 ≥60px 且在左右拇指区；L/R、Start/Select 也仍在画面内。壳体上下沿按规格允许裁切（外露卡带只露出顶缘一条，56px 弹卡阈值不变，鼠标/捕获拖拽可达；真机从顶缘起拖受屏幕边界限制，EXIT GRIP chip 与抽屉换卡提供替代路径——如实备注）。
- 新探针钩子 `deviceScreenBounds()`（deviceGroup bbox 八角投影 CSS px，撑满断言用）。

### ③ 屏幕外卡带盒 + 侧滑唤出 + grip 内插卡
- 收纳包 grip 停放位从 (0,−220,−60) 改为 **(170,8,50)（屏幕右缘外）**；抽屉唤出位 **(2,8,50)**（盖住下半屏，卡带在屏内可抓）。`CartridgeManager.setGripPouchOpen` 只改 goal，pouch 既有 per-frame 缓动执行滑入/滑出；`homeWorld` 改用 pouchGroup **实时**位姿（桌面/竖屏 setLayout 直吸后 goal≡live，逐位不变），home 卡带随包滑动。
- **手势**：gripMode 下未被按键/卡带认领的 pointerdown 记 edgeSwipe；右缘 24px 内起滑、左滑 ≥48px（|dy|<90）→ 唤出；抽屉开时任意右滑 ≥48px → 收回；pointerup 快速水平甩动（<320ms、|dx|≥90、|dx|≥2|dy|）→ 切换。插卡成功 / EXIT GRIP / 离开 grip / 20s 超时（交互 poke 重置）自动收回。
- **抽屉相机联动**：`scene3d.setGripDrawerOpen` → grip 机位 target.y **+14**、radius **×1.1**——把插槽 approach 投影拉到屏幕顶缘附近（实测 y≈−47px，配合 dragFocus 推近时更近），使 m10 的屏幕空间深度辅助（120px 窗口）在顶缘拖放时权重 w≈0.4+ 可达，世界 50mm 吸附 + 平面重瞄逐帧收缩 → CDP 触屏拖 cascade7（前排 z=63，深度差 69mm 触发辅助）实测 **snapDist 11.6mm < 20** 松手即 INSERTING→BOOTING→PLAYING。后排（upload 槽，z=37）走世界吸附收缩（真机 60Hz 约 0.4s 收敛，备注）。
- 换卡流：PLAYING 上拖 56px 弹卡 → OFF（gripMode 保持、抽屉可开）→ 侧滑唤出 → 拖新卡到顶缘插入 → 全程横握取景不变、不重播转场、插卡成功抽屉自动滑出。

### ④ 保留项
56px 屏幕阈值弹卡（fromInserted 分支未动）、EXIT GRIP chip（退出到正常横屏 play 布局、游戏继续）、grip 隐藏 touch-zones、触键直接按、竖屏提示药丸（锁失败/iOS 兜底）——全部保留并通过套件断言。

### ⑤ 桌面零改动（构造性）
所有新逻辑门控：`gripEligibleDevice`（coarse+小屏）→ tryLandscapeLock/beginGripCinematic/setGripDrawerOpen；`gripMode` → edgeSwipe/抽屉位。桌面永不进 grip 布局、session 永不置位 → updateCamera 分支、setLayout、dragMove 与改动前逐位等价（cineT 恒 1、roll 恒 0）。e2e **49/49 原样全过**佐证。

### 测试（已登记）
- `tests/mobile-grip.mjs`（重写，**38 断言**）：转场（INSERTING 即 cineActive+roll≈90°、完成后 roll=0、旋转进入不重播、二次插卡不重播）、撑满（投影宽 ≥98% 高 ≥100%、LCD ×1.5+、按键区完整+拇指区）、提示药丸显示/关闭、触键边沿+行程、56px 弹卡且**停留** grip、侧滑唤出（drawerOpen+包滑到 x<6+插槽投影到顶缘+卡带可抓）、右滑收回（射线探测找无认领空位起滑——卡带上起拖是换卡手势）、CDP 触屏抽屉拖卡插入（snap<20 → PLAYING）、插卡后抽屉自动收回、EXIT GRIP（游戏继续+回正常机位 LCD<0.75×）、旋转循环重新沉浸、reduced-motion 跳过动画且撑满。截图 **15-grip-cinematic.png**（竖屏转场 roll 中段）、**16-grip-pouch-swipe.png**（抽屉唤出）、12/13 重拍。
- 排障记录：SwiftShader 2–8fps 下 pouch 滑入需 ~6–8s 墙钟 → 抽屉超时设为 20s 且 pointerdown poke 重置；refit() 吸附机位消抖（改目标后先等 ≥3 帧让 goal 刷新）；关闭滑动手势起点必须在卡带投影外（卡带上起拖=换卡手势）。
- 开发探针：tests/probe-grip2.mjs（grip 取景/抽屉/插卡数值）、tests/probe-raf.mjs（帧率诊断）。

### 回归（最终构建）
- `node tests/e2e.mjs` **49/49**（桌面基线原样全过 = 桌面零行为变化）
- `node tests/mobile-grip.mjs` **38/38**
- `node tests/mobile-insert.mjs` **7/7** · `node tests/responsive.mjs` **12/12** · `node tests/slowload.mjs` **18/18**
- `npm run build` ✓

### 里程碑 11 改动文件清单
源码：src/scene/Scene3D.ts（gripSession/cine 转场/撑满机位/抽屉联动/gripMode 重定义）、src/scene/CartridgeManager.ts（抽屉位姿/setGripPouchOpen/homeWorld 实时包位/home 卡随包滑动）、src/main.ts（insertFlow 转场链/fullscreen+lock/释放、edgeSwipe 手势、抽屉开关+超时、syncGripUi 重写、deviceScreenBounds 钩子）
测试：tests/mobile-grip.mjs（重写）、tests/probe-grip2.mjs / tests/probe-raf.mjs（探针）
文档：README.md（Mobile 段落重写 + 套件说明）、INTEGRATION-PROGRESS.md（本文件）

## 里程碑 10：portrait 触屏拖卡插入修复（本轮，完成）

### 根因
`CartridgeManager.dragMove` 非插入态用"相机朝向平面"拖拽，卡带被锁在 home 深度。portrait 布局收纳包在机身前下方 z≈134，与插槽 approach（z≈−5.8）有 ~130mm 视轴深度差：屏幕空间拖拽永远进不了 50mm 世界吸附半径，endDrag 的 20mm 落入阈值物理不可达 → 必然"拖错回弹"（桌面收纳包 z≈6，深度差仅 ~12mm，所以桌面一直正常）。

### 修复（src/scene/CartridgeManager.ts，仅 dragMove 非插入态分支）
- 世界空间 50mm 吸附/20mm 落入逻辑**逐字保留**。新增**屏幕空间深度辅助**：每帧量 `|dragPlane.distanceToPoint(SLOT_APPROACH_POS)|`（视轴深度差），**仅当 > 50mm（=SNAP）时**启用辅助——卡带始终在拖拽平面内运动，该值布局内稳定：桌面 ~12mm 永不进此分支（桌面行为构造性逐位不变，非仅靠测试担保）；portrait ~113mm 启用。
- 辅助逻辑：把 SLOT_APPROACH_POS 投影到屏幕，指针与投影的屏幕距离 < **120 CSS px** 时按 `w = f²·0.94 + 0.06`（f = 1 − d/120，与世界吸附同型）把拖拽 target 向 approach 世界坐标混合；贴死（d→0）时 w=1 → target=approach，endDrag 20mm 阈值真实可达（实测磁吸后 Δ=0.1mm）。远离时保持 1:1 平面手感，错误落点依旧回弹。
- endDrag 未改：落入判定仍是世界 20mm + hasRom。
- grip 核对：gripMode 时收纳包停放在 (0,−220,−60) 出画面，本无卡可拖（插入发生在进入 grip 前）；grip 布局+gripSuppressed 时收纳包回桌面位 (160,−36,6)、相机桌面参数 → 深度差 ~12mm 走桌面路径。辅助分支在 grip 永不触发，不报错。横握弹卡 56px 屏幕阈值不变。

### 测试
- `tests/mobile-insert.mjs`（新增，**7/7**）：iPhone 13 上下文（390×844、dsf3、hasTouch+isMobile），CDP `Input.dispatchTouchEvent` 真触屏拖拽——portrait 布局+收纳包 z=134 深度差断言 → 错误落点触屏拖回弹不启动 → cascade7 从收纳包拖到插槽投影点（中途等相机推近稳定后重瞄），断言磁吸发生（`cartDistToSlot` = 0.1mm < 20）→ 松手后 `fsm.onChange` 记录到 **INSERTING→BOOTING→PLAYING** 顺序序列 → 无页面错误。截图 tests/shots/14-mobile-portrait-touch-insert.png。
- `main.ts` 新钩子（登记）：`cartDistToSlot(id)` —— 卡带到 SLOT_APPROACH_POS 的世界距离（磁吸探针）。
- 排障记录：加载后相机向 portrait hero 缓动未完时投影漂移，touchStart 会落空 → 套件内 `waitCameraSettled`（投影稳定判定）后再发起拖拽。

### 回归（最终构建）
- `node tests/e2e.mjs` **49/49**（桌面基线原样全过 = 桌面零行为变化）
- `node tests/responsive.mjs` **12/12** · `node tests/slowload.mjs` **18/18** · `node tests/mobile-grip.mjs` **20/20**
- `npm run build` ✓

### 里程碑 10 改动文件清单
源码：src/scene/CartridgeManager.ts（dragMove 屏幕空间深度辅助）、src/main.ts（cartDistToSlot 钩子，已登记）
测试：tests/mobile-insert.mjs（新增）
文档：README.md（Mobile 段落触屏拖卡 + 测试命令）、INTEGRATION-PROGRESS.md（本文件）

## 里程碑 9：移动端「横握沉浸模式」（完成）

手机插卡游玩时横屏自动切换为横握视图：机身铺满视口宽度、LCD 居中最大化、D-pad/A/B 在左右拇指区、直接点按 3D 实体键。桌面端行为零改动（全部改动仅在 coarse+小屏+横屏路径生效）。

### 判定逻辑（复用既有 layout 管线，无平行体系）
- `LayoutMode` 扩展为 `'desktop' | 'portrait' | 'grip'`（Scene3D.resize）：`matchMedia('(pointer: coarse)') && Math.min(w,h) <= 500 && w > h` → **grip**，否则维持原 `w/h < 1.05 ? portrait : desktop`。桌面 UA/视口永不进入 grip（responsive 新增断言：非触屏视口 `gripEligibleDevice === false`、1000×760 触屏视口 min>500 不进 grip）。
- `coarseMq` change 监听 + 既有 render 尺寸轮询 → 旋转即切换。Playwright isMobile+hasTouch 实测 `pointer: coarse` 为 true（探针验证后采用，与 overlay.ts 触摸检测同一信号）。
- `scene3d.gripMode` = `layout==='grip' && playView && !gripSuppressed`；`gripEligibleDevice` = coarse+小屏（与方向无关，供提示判定）。

### 横握机位参数（Scene3D.updateCamera grip 分支）
- `GRIP_HALF_WIDTH = 74`mm（机身 144.5mm 宽 → 铺满 ≈98% 视口宽）；`gripRadius = 74 / (tan(13°) × aspect)` 每次 resize 重算（844×390 时 ≈148）。
- `GRIP_TARGET = (−0.8, 8, 13.35)`（LCD 平面中心、轻微头部余量）、az 0、elev 0.02（应用层 clamp 0.05）。实测：LCD 投影 95px → **220px（×2.32 vs 竖屏 play 布局）**；D-pad 中心 (132,193)、A (751,174)、B (680,198)，全部距边 ≥8px。
- grip 布局下禁用 pointer 视差（拇指频繁划屏会晃相机）；非 playView 时 grip 回落到 desktop hero 参数（= 改动前手机横屏行为），gripSuppressed+playView 回落 desktop play 参数。desktop/portrait 各三元表达式值逐一核对不变。
- 屏幕纹理不变（NearestFilter、严格 3:2，既有）。

### 竖屏引导提示（#grip-hint）
- 仅 `PLAYING && 竖屏 && gripEligibleDevice && 未关闭` 时显示；小药丸「⟳ Rotate your phone to play in landscape ✕」，top:44px 居中、不挡 LCD、仅关闭按钮接收指针事件、session 级关闭记忆、prefers-reduced-motion 去过渡。页面加载/OFF 态不显示。

### 横握交互
- 触摸点按 3D 按键沿用既有 pointer 逻辑（tap A → down+up 边沿、按住有 3D 行程，已测）。
- **弹卡**：grip 取景太满，26mm 世界阈值在屏幕边缘物理不可达 → gripMode 时改用屏幕空间阈值：上拖 ≥56 CSS px 弹卡（ndc.y 向上为正；世界阈值桌面保留不变）。弹卡 → OFF → playView false → 自动回正常布局（收纳包回 (160,−36,6)）。
- **EXIT GRIP chip**（#grip-exit，左上角）：`setGripSuppressed(true)` → 回落正常横屏 play 布局、游戏继续；opt-out 在「离开 grip 上下文」（转回竖屏或弹卡）时自动复位，下次 PLAYING 横屏重新沉浸。
- gripMode 时 touch-zones 辅助层加 `.grip-hidden` 隐藏（横握直接点实体键），退出即恢复。
- 收纳包：gripMode 时 `setLayout` 停放到 (0,−220,−60) 出画面（插入态卡带不受影响）；`setPlayView`/`setGripSuppressed` 现在会重发 onLayout 使包位置随 playView 联动（idempotent 直吸，桌面无副作用）。

### 可选增强：screen.orientation.lock
- 仅在 gripMode 下的 canvas pointerdown 用户手势内尝试一次 `screen.orientation.lock('landscape')`；Promise rejection 静默 catch，iOS Safari 无此 API 走可选调用+try/catch 双保险，降级为提示引导，不报错。

### 测试（已登记）
- `tests/mobile-grip.mjs`（新增，**20/20**）：iPhone 视口 390×844 竖屏（提示出现/可关闭）→ 844×390 横屏（grip 激活、包 y=−220、chip 可见、LCD ×2.32、按键区完整且在左右拇指区、NearestFilter+实时画面）→ 触摸 tap A 边沿 + 按住行程 → 上拖 90px 弹卡回正常布局（含 zones 恢复）→ 重插卡 EXIT GRIP chip 退出不弹卡、游戏继续、回正常横屏机位 → 转回竖屏 portrait 恢复 → 无页面错误。截图 **tests/shots/12-mobile-portrait-hint.png、13-mobile-landscape-grip.png**。
- `tests/responsive.mjs` +3 断言：非触屏视口不 grip-eligible、非触屏竖屏 PLAYING 无提示、1000×760 触屏（min>500）不进 grip。
- `tests/e2e.mjs` 未改动：**49/49** 原基线全过 = 桌面零改动确认。
- 排障记录：首跑弹卡拖拽 FAIL —— ndc 向上为正，upPx 符号写反，修正后过。

### 里程碑 9 改动文件清单
源码：src/scene/Scene3D.ts（LayoutMode+'grip'、grip 判定/机位/半径重算、gripMode/gripEligibleDevice/setGripSuppressed、setPlayView 重发 onLayout、grip 禁视差）、src/scene/CartridgeManager.ts（gripMode 停包、fromInserted 拖拽 ndcY0 + grip 56px 弹卡阈值）、src/main.ts（grip UI 同步、提示关闭、chip、orientation.lock、onLayout 扩展）、index.html（#grip-hint、#grip-exit）、src/styles.css（grip-hint/exit 样式 + reduced-motion + touch-zones.grip-hidden）
测试：tests/mobile-grip.mjs（新增）、tests/responsive.mjs（+3 断言）
文档：README.md（Mobile 段落 + 测试命令）、INTEGRATION-PROGRESS.md（本文件）

### 验收结果（里程碑 9，最终构建）
- `npm run build` ✓
- `node tests/mobile-grip.mjs` **20/20 MOBILE GRIP CHECKS PASSED**
- `node tests/e2e.mjs` **49/49 ALL ACCEPTANCE CHECKS PASSED**（桌面基线不变）
- `node tests/responsive.mjs` **12/12** · `node tests/slowload.mjs` **18/18** · `node tests/webkit-smoke.mjs` **全过**

## 里程碑 8：慢网络首屏 + 即时存档 + 换 ROM 面板（已完成）

### ① 慢网络/冷缓存首屏取景（已完成，已验证）
- 现象：线上慢网络/冷缓存首屏，取景在 GLB 加载完成前确定，机身掉到画面下方外；resize 后恢复；本地快网络正常（本地探针 3s 延迟 GLB 复现不出 → 属环境依赖型）。
- 修复（Scene3D.ts）：
  - 新增 `refit()`：重跑 resize()（布局/aspect/渲染尺寸/收纳包吸附）+ 相机 rig 无缓动直接吸附到目标值；构造器里 `handheld.ready.then(() => refit())` —— GLB（含支架/LCD）就绪后强制重新 fit/layout 一次。
  - `render()` 每帧轮询 `window.innerWidth/innerHeight`，与上次 resize 不同则立即 resize() —— 覆盖不派发 window resize 的视口变化（嵌入 iframe 生长、移动端浏览器 chrome），resize 幂等。
- 加载态：index.html 新增 `#boot-status`（极简 LOADING 小片），main.ts 在 `handheld.ready` settle 后加 `.done` 淡出；加载失败也不会常驻。
- 验证：`tests/slowload.mjs`（新增）—— page.route 延迟 gba.glb 2.5s，1400×900 / 1366×768 / 1920×1080 三分辨率：加载中 LOADING 可见 + 支架在安全 hero 机位画面内；就绪后 chip 隐藏 + 机身顶/底/左/右投影全部在视口内。**18/18 PASS**；截图 tests/shots/slowload-*.png。

### ② 即时存档 save state（已完成，e2e 已验证）
- `EmulatorAdapter`：`saveStateSnapshot(): Promise<Uint8Array|null>`（saveState(0) + 读 `${saveStatePath}/${romKey}.ss0`，复用 flushSave 既有模式；核心拒绝/未运行返回 null）；`loadStateSnapshot(bytes): Promise<boolean>`（写回 ss0 文件后 loadState(0)，返回核心自己的判定，不伪造成功）。
- `SaveStore`：复用已有 `states` store（`putState/getState`，id `${hash}:0`）——schema 零变更，与 SRAM 分 store 互不干扰；弹卡自动存 state 的既有逻辑不变。
- UI：顶栏 SAVE / LOAD 两个克制小按钮（`.icon-btn.wide`），`fsm.onChange` 驱动 disabled，仅 PLAYING 可用；toast 如实（State saved / State loaded / No saved state for this game / 核心拒绝时不伪造成功）。
- e2e：首次 PLAYING 无存档点 LOAD 如实提示；SAVE 后 store.getState(hash) 非空；OFF 态按钮 disabled；**重载页面→重新插卡→LOAD 成功且帧继续推进**。

### ③ 换 ROM 按钮面板（已完成，e2e 已验证）
- 顶栏 CARTS 按钮 → `#dlg-carts` 面板：列出 upload-1/upload-2 两槽，各显示当前 ROM 标题（空白显示 LOAD YOUR ROM）+「Choose file」（复用 `pendingUploadSlot` + 隐藏 fileInput → 同一个 `importFile(file, slotId)` 通路、同一套校验与标签生成）+「Clear」。
- `CartridgeManager.clearUploadedCart(slotId)`：槽位复位为空白卡（沿用槽位 id 与原格）。
- `main.ts clearUploadSlot`：已插入主机的卡先弹卡再清（toast 提示）；清除映射 `uploadSlots[slotId]`，无引用 hash 的 ROM 字节从 IndexedDB 驱逐（复用 importFile 的驱逐规则）。
- importFile 末尾 `renderCartsPanel()` 保持面板打开时标签同步。
- e2e：面板两槽标题与 cart def 一致；经面板 filechooser 给 upload-2 换 ROM 标签变化；Clear 后槽位空白；**刷新后清空的槽不恢复、另一槽仍恢复**。

## 里程碑 7：卡带包 2 预设 + 2 独立上传卡

### 槽位机制
- `BUNDLED_CARTS` 移除 pong（ROM 文件保留在 public/roms/ 供测试）；新增 `UPLOAD_SLOTS = ['upload-1', 'upload-2']`，构造时在收纳包后排两格放入 `isBlank` 空白卡（LOAD YOUR ROM）。
- `setUploadedCart(slotId, def)`：卡带**沿用槽位 id**（upload-1/2）和原位格，导入后变成可插入的临时卡带；`insertById('upload-1')` 等钩子天然可用，main.ts 无需为插入改钩子。
- 激活带槽位身份：`onBlankActivate(cartId)`（原是单一 imported 逻辑）；main.ts `blankDown` 记录 cart.id → `pendingUploadSlot` → `importFile(file, slotId)`。拖文件到卡带包：首个空白槽位，都满则替换 upload-1。
- 两槽完全独立：各自 label（header 标题 + hash 派生 accent、imported 斜纹样式）、各自 romBytes、互不影响。

### 持久化（最多 2 个导入 ROM）
- 映射存 config：`uploadSlots: { 'upload-1': hash, 'upload-2': hash }`（SaveStore 已有 config store，零 schema 变更）。
- 导入时：putRom(bytes) → 更新槽位映射 → 旧 hash 无引用则 deleteRom 驱逐。
- 启动恢复：按映射从 listRoms 找字节 → 两槽各自 `setUploadedCart`；任何不被映射引用的 ROM 一律驱逐（替代旧的"只留最新一个"逻辑，main.ts 已删除 `storedRoms.slice(1)` 删除循环）。

### 测试改动（已登记）
- `tests/e2e.mjs`：①三 ROM 启动覆盖：cascade7/gbarcade 走预设，**pong 经 importBytes 导入 upload-1 后启动**（顺带覆盖导入流程）；②10 次换卡用 ['cascade7','gbarcade','upload-1']；③新增断言：两槽同时拒绝随机文本、拒绝后槽位仍空白、**两张上传卡共存且各自标签正确**、upload-2 导入卡启动、截断 ROM 报错自动弹卡（改用 upload-2，之后补回好 ROM）；④重载后**两张上传卡都恢复**。断言数 39 → **41**。
- `main.ts` 钩子：`importBytes(bytes, name, slot = 'upload-1')` 增加槽位参数（已登记）。
- `tests/responsive.mjs` / `tests/webkit-smoke.mjs` / 6 个开发探针（probe3/probe-core/probe-frames/probe-audio/probe-thread/debug-boot）：insertById 'pong' → 'cascade7'。
- `README.md` / `src/ui/overlay.ts`：预设列表改为 CASCADE7 + GBArcade（README 注明 Pong 文件仍随包附带、不在默认卡带包；Credits 面板不再列 Pong）；Your ROMs 改为两个 LOAD YOUR ROM 槽位文案。

### 验收
- `npm run build` ✓ · `node tests/e2e.mjs` **41/41 ALL ACCEPTANCE CHECKS PASSED** · `responsive` 全过 · `webkit-smoke` 全过
- 截图：01-hero（2 预设 + 2 空白上传卡）、09-pouch（e2e 流程末：预设 + pong 上传卡 + my-backup 上传卡斜纹标签）、glb-credits.png 重拍（面板无 Pong、双槽文案）

## 里程碑 6：直立展陈姿态（本轮）

### 姿态与支架方案
- **旋转**：GLB 原生朝向即直立（屏幕 +Z、Y 上），`glbRoot` 不再旋转；新增 `deviceGroup`（rotation.x = **DISPLAY_LEAN = −0.17 rad ≈ 后仰 9.7°**），pivot 组/LCD/键帽牌全部挂在其下；`group` 仅负责 shake。
- **展示支架**（`handheld.standGroup`，场景道具非机身零件，深色哑光亚克力 0x1b1c20 roughness 0.92）：底板 124×5×50 @ (0,−43.5,−8) + 两个 cradle 托块 16×13×32 @ (±54,−38.5,−5) 随机身后仰角 + 低位背托条 80×5×4 @ (0,−36.3,−9)（只托电池仓下沿，背面照几乎不遮挡）。floor 降至 y=−46。接触阴影正常。
- 层级：`group(shake) → deviceGroup(lean) → glbRoot(×1000) + 8 个 pivot 组 + LCD + chips`；`standGroup` 由 Scene3D 加入场景（不随 shake）。

### 新卡槽锚点（GLB 几何实测 + 后仰变换，代码内 applyEuler 计算）
- 未后仰锚点 (0, 36.5, 4.7)mm（槽底 glb y≈33.5、槽壁 y≈36.5–40.5，卡带顶外露 ≈11.5mm）
- **SLOT_ANCHOR_POS ≈ (0, 36.8, −1.6)**、**SLOT_APPROACH_POS ≈ (0, 61.4, −5.8)**（沿槽轴后仰延长线，插入=从上往下落入，与重力一致）
- 插入态卡带 rotation.x = DISPLAY_LEAN（随槽后仰）；insertSequence mid 改为 approach/anchor 中点；弹卡上拖语义不变（z 平面 + y 阈值）

### 按键动画轴（直立后）
- A/B/Start/Select 沿 −Z 下沉（1.8/0.9mm）；D-pad 倾斜在 **rotation.x（上下）+ rotation.y（左右）**；肩键 rotation.x = +0.19（验证为向壳内合拢）；电源滑块沿 +Y 滑 3.5mm
- 键帽牌改到直立坐标 (x, y, z=13.45)、面向 +Z 无旋转

### main.ts / tests 钩子改动（任务书允许，原因登记）
- `main.ts`：`dpadDirection` 由 dz 改为 **dy**（直立后 D-pad 面在 XY 平面，上=+Y）；`slotScreenPos` 由硬编码 (0,30,−25.5) 改为投影导入的 `SLOT_APPROACH_POS`（锚点已变，合成拖拽需要瞄准真实槽口）
- `tests/e2e.mjs`：斜向断言 `grpDpad.rotation.z` → **`.y`**（倾斜轴变了，2 处）；06–09 特写 cameraOverride 机位适配直立（纯截图构图）
- `tests/responsive.mjs`：pong 画面断言 `unique > 4` → **`>= 2`**（pong 恒为黑白 2 色，原断言内容性必挂，与本次改动无关，探针实测 0.5–4s 恒为 2）；DPR cascade7 采样由固定 sleep(1000) 改为 **waitForFunction(unique>4, 15s)**（SwiftShader 下首帧落地 0.5–1s 抖动，实测 500ms 时 unique=1）

### 其他修复
- `CartridgeManager` 构造时 `setLayout(scene3d.layoutMode)`（竖屏首载时 Scene3D 构造期 onLayout 还是 null，portrait 布局从不生效）；`setLayout` 收纳包改为**直接吸附**（SwiftShader 低帧率下缓动 1.2s 走不完，responsive 检查点必挂）
- 收纳包落地新高度 y=−36（随 floor −46）
- **LED 发光链修复**：led 网格原被壳体模塑透镜穹顶遮挡（z 12.8 < 壳面 13）→ attach 到 ledLift 组 +z **1.6mm** 抬到穹顶之上（运行时变换，未动 GLB 顶点）；材质克隆：底色深绿 0x0d2815、roughness 0.9（软箱高光会打白 2.4mm 小点）、envMapIntensity 0.15、emissive 0x33ff66 峰值 **2.5**（≥6 会过曝成白）

### 相机（Scene3D）
- hero：az −0.38、elev 0.35（左前上方 ~20°）、radius 600、target (0,2,0)
- play：az 0、elev 0.32（正面略俯视）、radius 565、target (0,4,2)
- dragFocus：lerp 目标 (0,26,0)（槽在顶部）、radius ×0.94
- portrait：hero radius 820 target (0,2,45)；play radius 720 target (0,4,30)；收纳包 (0,−36,134) 在机身前下方

## 里程碑 0–5（GLB 集成，已完成，详见 git 前次记录）

- 程序化机身整体替换为 GLB（yassineCGI CC-BY-4.0），命名零件挂接、LCD 平面三层屏幕材质、键帽牌
- 基线红项根因：`carts.group` 从未入场景 + 水平拖拽平面在相机推近时抓取偏移 z 向 −48mm → 改为相机朝向平面拖拽
- cameraOverride 传普通对象致 lookAt NaN 黑屏修复（旧基线特写全黑未被发现）
- README + 页面 Credits 署名齐全；e2e 39/39 两轮

## 改动文件清单（累计）

源码：src/scene/HandheldModel.ts（GLB+直立+支架）、src/scene/Scene3D.ts（支架入场景/地板/机位/cameraOverride 修复）、src/scene/CartridgeManager.ts（入场景/进包/拖拽/插槽/布局吸附）、src/ui/overlay.ts（Credits）、**src/main.ts（dpadDirection dy + slotScreenPos 钩子，已登记）**
测试：tests/e2e.mjs（斜向断言 .y + 特写机位，已登记）、tests/responsive.mjs（pong ≥2 + DPR 等待条件，已登记）、tests/inspect-glb{,2,3}.mjs（分析）、tests/shots-glb.mjs（验收截图，机位已更新）
文档：README.md、INTEGRATION-PROGRESS.md（本文件）

## 验收结果（最终构建，里程碑 8）

- `npm run build` ✓
- `node tests/e2e.mjs` **49/49 ALL ACCEPTANCE CHECKS PASSED**（41 → 49：无存档读档如实提示、SAVE 按 hash 落盘、OFF 态按钮禁用、**重载页面→重插卡→LOAD 恢复且帧继续**、面板双槽标题、面板换 ROM 标签变化、Clear 槽位空白、**刷新后清空槽不恢复+另一槽保持**）
- `node tests/slowload.mjs` **18/18**（gba.glb 延迟 2.5s × 1400×900/1366×768/1920×1080：加载中 LOADING+安全机位、就绪后整机在画面内；截图 tests/shots/slowload-*.png）
- `node tests/responsive.mjs` **全过**（portrait 收纳包 x=0 z=134、DPR2、触摸）
- `node tests/webkit-smoke.mjs` **全过**（cascade7 启动）
- 截图：tests/shots/01-hero.png（直立 hero）、03-drag-inserted.png（卡带插顶槽、LED 绿）、06–09 特写有效

### 里程碑 8 改动文件清单
源码：src/scene/Scene3D.ts（refit + render 尺寸轮询 + ready 后 refit）、src/core/EmulatorAdapter.ts（saveStateSnapshot/loadStateSnapshot）、src/scene/CartridgeManager.ts（clearUploadedCart）、src/main.ts（boot-status、SAVE/LOAD 流程、CARTS 面板接线）、index.html（boot-status、顶栏三按钮、dlg-carts）、src/styles.css（boot-status、icon-btn.wide/disabled、cart-row）
测试：tests/e2e.mjs（+8 断言）、tests/slowload.mjs（新增）
文档：README.md（顶栏功能 + slowload 说明）、INTEGRATION-PROGRESS.md

## 旧验收结果（里程碑 7，存档）

- `node tests/e2e.mjs` 41/41（直立姿态 + 2 预设 + 2 上传卡）；responsive / webkit-smoke 全过
- 截图：tests/shots/01-hero.png（直立 hero）、03-drag-inserted.png（卡带插顶槽、LED 绿）、06–09 特写有效；验收套 glb-{hero,playing,front,buttonsCU,top,edgeR,edgeL,back,wireframe,credits}.png 全部直立重拍

## 遗留风险 / 备注

- SwiftShader 下弹簧/补间为慢动作（dt 钳 0.05 + 低帧率），真机 GPU 正常；e2e 全部为条件等待型断言，不受影响
- LED 网格抬升 1.6mm 覆盖模塑透镜（近景侧面可见轻微凸起，游玩机位不可见）
- 支架为程序化场景道具（任务书明示允许），与机身 GLB 严格分离
- hero 截图 1.5s 时点依赖 GLB 加载速度（本地+预热足够）
- 慢网络修复属环境依赖型防御（本地探针从未复现线上故障）：refit + 尺寸轮询覆盖所有"取景早于就绪/视口变化不派发 resize"的情形；线上复验需在真实公网冷缓存确认
- 弹卡自动存 state 与手动 SAVE 共用同一槽（`${hash}:0`），LOAD 总是读最新快照——语义一致，不分版本
