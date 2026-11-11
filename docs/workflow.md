# 多仓开发与合入策略(v2,2026-11-11)

> 四个仓,各改各的。本文是惯例法,不是教程;冲突时以「不变式」节为准。
> **v2 变化**:fork 备份成立(theVincentWei 名下两仓,public)——改动永远发生在对应仓里、主线推自己的 fork;旧的「每次提交追加补丁/catalog 归档」纪律**降级为静态档案**,不再随提交维护。

## 0. 四仓身份与不变式

| 仓 | 身份 | 远端 | 主线 | 备份 |
|---|---|---|---|---|
| **wanqi** | 小程序管理框架(server/CLI/docs/skill,开源) | 无远端(遗留:开源建仓待拍板) | `master` 线性 | master 本身即存档 |
| **dsh-go-miniprograms** | 小程序源码仓(源码真身 + 盘上 `dist/`) | 无远端(遗留:建议建 theVincentWei 仓) | `main` 线性 | 本地 git |
| **dsh-Go** | 手机宿主(AGPL 公开) | origin=`theVincentWei/dsh-Go`(我们的 fork);upstream=`ccch1mneyyy/dsh-Go`(**项目本体**,旧文档误记为用户 fork) | `main` = 基线 a75c6cff@#602 + 124 本地提交(落后上游 ~1250) | push origin(fork main=本地线 + `v1.0.11-local` tag + `upstream` 分支) |
| **dimina** | 容器 fork(公开) | origin=`theVincentWei/dimina`;upstream=`didi/dimina` | `main` = 基线 v1.8.1 + 30 适配提交 + 1 档案提交(上游 tip 领先 11) | push origin(fork main=本地线,v1.8.1 tag 在历史内) |

不变式:
1. **开发位置 = 改动的家**:管理框架/文档/skill 在 wanqi;小程序在 dsh-go-miniprograms;宿主在 dsh-Go;容器在 dimina。**到对应仓里改**,不跨仓镜像、不在 wanqi 代改别仓的东西。
2. **有 fork 的仓,主线前进后推 fork**:`git push origin main`(本地线与上游已分叉,首次/升级后用 `--force`);wanqi 与小程序仓暂无远端。
3. **合入只许 fast-forward**;共享工作树纪律:**不切分支**——用 `git branch -f <主线> <分支>` 收口,需要改动落在某分支时就直接在那条分支上提交。
4. **升级 = 对齐上游后强刷 fork**(§2/§3)。
5. **档案是静态的**:`dimina/patches/`(series 全量 + notify-only)与 `dsh-Go/local-series/catalog.tsv` 不再随提交追加;仅当 dimina 跟上游升级(rebase)时,现场 `git format-patch --binary` 再生全系列做「git am → 树 SHA 对账」安全门(§3),对账过才收口。开源范围已拍板**全公开**(2026-11-11),catalog 三类标注(平台对接/个人 UI/基础设施)降级为历史备注。

## 1. 常规节奏(每个特性)

```
① 到对应对应仓改代码(小改动直接主线提交;大改动开 feature 分支)
② 该仓测试/analyze 全绿
③ 跨仓联动验收(涉及 server+容器+宿主时:测试 server :7620 E2E + 真机/模拟器行为断言)
④ 主线 fast-forward 收口(feature 分支 `git branch -f` 收口后删除)
⑤ 有 fork 的仓 push origin main(已分叉用 --force)
```

UI 改动铁律不变:写代码前出预览图等用户确认(dsh-go-miniprogram skill §铁律)。

## 2. dsh-Go:跟上游主线升级

- 本仓历史含 32 个**携带真实内容**的 merge(实证:线性 am 重放丢冲突解决)→ **升级 = merge,不是 rebase**:`git fetch upstream && git merge upstream/main`,冲突一次解决,我们的历史原样保留。
- 升级后:全量回归(测试 + 真机冒烟)→ `git push --force origin main` 刷 fork(合并含上游历史后,普通 push 亦可)。
- rebase/线性化只用于新特性分支内部(分支可以线性,合回 main 前理直)。

## 3. dimina:跟上游 didi/dimina 升级

- 本仓历史线性(am 重放可逐字节还原)→ **升级 = rebase**:`git fetch upstream && git rebase --onto <新基线> v1.8.1 main`(2026-11-11 时点上游 tip b52a516 领先 11 个提交)。
- rebase 后必须跑安全门:现场 `git format-patch --binary v1.8.1..main -o /tmp/series` → 临时 clone 从 v1.8.1 `git am` 全系列 → `git rev-parse HEAD^{tree}` 与本地 main 树 SHA **逐字节对账**,过闸才收口。
- 收口后 `git push --force origin main` 刷 fork;`patches/series/` 存档按需刷新(编号/基线/树 SHA 全部刷新 + README 更新)。

## 4. wanqi 与 dsh-go-miniprograms 自身

- wanqi master 单线直推;开源前「历史压缩」(重建干净初始提交,原历史私档保留)**待用户拍板**,届时建 `theVincentWei/wanqi` 公开仓作为远端。
- dsh-go-miniprograms:发版 = 改包根 `bundle.json`(code 严格递增)→ dmcc 编译 → zip 落 `dist/`(`.gitignore` 约定产物不入库,盘上供万器取用);建议建远端仓备份(公开/私有待拍板)。
- wanqi **不携带任何别仓档案**(2026-11-11 减负定稿);日常开发查档:`dimina 仓 patches/`、`dsh-Go 仓 local-series/`。
