# 星际穿行（Star Drift）· 太空 3D 飞行 · 团队接口契约（v1）

Dimina **小游戏格式**（`compileType: "game"`），单机离线，three.js WebGL 渲染，**3A 观感路线**：PBR + IBL 环境反射 + ACES 色调映射 + 暗色聚焦场景（不做 bloom/多 pass 后期）。
玩法：飞船无尽向前穿行小行星带，横向拖拽躲避 + 收集能量晶体，距离即分数。
工作区：`~/Documents/deepseek-harness/default-workspace/star-drift-build/`
（源码先在工作区开发；lead 负责同步 `~/Code/dsh-go-miniprograms/star-drift/` 并编译发布——队员不写工作区以外路径。）

## 分工（严格互不相交）

| 成员 | 文件 |
|---|---|
| engine-dev | `src/engine.js`、`src/constants.js`、`test/engine.test.js`、`package.json`(type:module) |
| render-dev | `src/renderer.js`、`assets/`（模型获取与拆包）、`preview/` |
| shell-dev | `game.js`、`game.json`、`project.config.json`、`src/main.js`、`src/store.js`、`build.sh` |
| lead | `CONTRACT.md`、icon、同步源码、编译/打包/发布、仿真器验证 |

## 运行时配方（road-hop/three-bench 已验证，直接继承）

- **分辨率铁律**：禁止手动预设 canvas.width/height；`dpr=min(pr||2,3,4096/max(w,h))` → `setPixelRatio(dpr)` → `setSize(cssW,cssH,false)`
- rAF：`canvas.requestAnimationFrame`（挂 canvas）；触摸：`wx.onTouchStart/Move/End/Cancel`
- 存储：`wx.getStorageSync/setStorageSync` try/catch + 内存兜底
- HUD：**第二块 wx.createCanvas() 画 2D → CanvasTexture 贴回唯一 WebGL canvas**（Dimina 已验证），拿不到降级无 HUD 不崩
- 资产管线（three-bench 已验证）：**禁内嵌纹理 glb / 禁 Blob / 禁 URL.createObjectURL**；外置 `.gltf + .bin + 贴图`，`FileLoader.prototype.load` 补丁拦 `pkg:/` 前缀走 `readFileSync`（.gltf 必须 utf8 字符串 parse）；贴图 src 翻译 `https://appassets.androidplatform.net/<appId>/main/assets/...`；glb 先用 `three-bench-build/glb-split.js` 思路拆
- esbuild 全链路 ESM → CJS bundle（`game.js` 里 require）；'Multiple instances' ≤1
- 性能预算：在屏对象 ≤80、三角形 ≤35k、2048² 贴图 ≤4 张（基准场景 18.7k tris 已验证跑通）

## 3A 观感技术点（render-dev 主责）

1. **IBL 环境反射**：`scene.environment = equirect 全景贴图`（EquirectangularReflectionMapping，three 内部自动转 PMREM，无需手动生成器）——贴图进包走 appassets；M1 先在 harness 验证效果，设备降级退路 = 三点光（Hemisphere+2 Directional）
2. **ACESFilmicToneMapping** + 曝光调整（一行，必做）
3. 软阴影可关（太空场景多为自发光/环境光，阴影非必需——按实测效果取舍）
4. 禁 EffectComposer/bloom 多 pass（桥接开销翻倍）；辉光观感靠 emissive + ACES
5. 飞船引擎尾焰：emissive 材质 + 简单 sprite 粒子（可选，M2+）

## 玩法规则（MVP）

- 世界：飞船沿 -z 无尽飞行，横向范围 cols 等效 ±4 世界单位（拖拽映射），不可纵向机动
- 障碍：小行星（3~4 种尺寸/转速模型复用）按 z 波段生成，密度随距离爬坡；能量晶体（八面体自发光）穿插其间
- 碰撞：球体近似（飞船 r=0.5 vs 小行星 r、晶体拾取 r=0.8）；撞小行星 = 护盾-1（MVP 直接死亡，deathReason 'asteroid'）
- 计分：距离（米）+ 晶体 ×50；best 经 store 持久化
- 操作：拖拽映射横向目标位（平滑跟随 lerp），无蓄力/跳跃
- 相机：跟随飞船后上方，横向轻微跟随（视差感），正交或透视由 render-dev 实测定（透视更有 3A 纵深感，优先试透视）

## 里程碑

- M1（当前）：IBL/ACES 验证 + 飞船模型获取 + 真渲染预览图（玩法/开始双帧）→ 用户拍板
- M2：场景 + 飞行操控 + 相机（模拟器可跑）
- M3：小行星/晶体/碰撞/计分/死亡重来
- M4：icon（用户拍板后）→ 打包发布 → 仿真器验证
