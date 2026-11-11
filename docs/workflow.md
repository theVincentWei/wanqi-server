# 多仓开发与合入策略(2026-11-11 定稿)

> 三个仓,三种身份,一套节奏。本文是惯例法,不是教程;冲突时以「不变式」节为准。

## 0. 三仓身份与不变式

| 仓 | 身份 | 上游 | 主线 | 存档形式 |
|---|---|---|---|---|
| **wanqi** | 我们的平台本体(开源) | 无(自己的) | `master` 线性 | master 本身就是存档 |
| **dsh-Go** | 手机宿主(闭源,非我们所有) | ccch1mneyyy/dsh-Go(用户 fork,走 PR 主线) | `main`(本地线,领先 origin/main 120+) | `patches/dsh-go-series/catalog.tsv` 分类目录(+按需再生) |
| **dimina** | 容器 fork(上游 didi/dimina 本体不开源) | didi/dimina | `main`(本地线,领先上游 28) | `patches/dimina-series/` **全量补丁物化**(线性可 am 重放) |

不变式:
1. **开发位置 = 改动的家**:服务端/CLI/文档/示例在 wanqi;手机宿主在 dsh-Go;容器在 dimina。不用软链接、不做跨仓源码镜像。
2. **补丁是导出格式,不是开发格式**:永远在真实的家里开发,验收后导出存档。
3. **验收必含归档项**:dimina 新提交 → 追加 series + README 行;dsh-Go 新提交 → 追加 catalog 行;漏了不算验收通过。

## 1. 常规任务节奏(每个特性)

```
① 各仓开 feature 分支(或 dimina 直接 commit 本地 main)
② 开发 + 各自仓的测试/analyze 全绿
③ 跨仓联动验收(如 autoSync:测试 server E2E + 真机/模拟器行为断言)
④ 验收通过 → 各主线 fast-forward(wanqi master / dsh-Go main / dimina main)
⑤ 归档:dimina 追加 format-patch(--binary)进 dimina-series;dsh-Go 追加 catalog 行
⑥ 特性分支删除;两侧工作树回到干净
```

- 特性分支允许(大改动/有风险时),但**合入只许 fast-forward**(`--ff-only`);要杂交的历史先在自己的分支理成线性再回来。
- 共享工作树纪律:**不切分支**——用 `git branch -f <主线> <分支>` 收口(指针操作,不碰工作树),需要改动落在某分支时就直接在那条分支上提交。

## 2. dsh-Go:跟上游主线升级

本仓历史**含 32 个 merge,merge 携带真实内容**(实证:线性 am 重放丢冲突解决)——所以:

- **升级方式 = merge,不是 rebase**:`git fetch origin && git merge origin/main`,冲突一次解决,我们的历史(含 merge)原样保留。
- rebase/线性化只用于**新特性分支内部**(分支可以线性,rebase 上 main 前理直)。
- **升级后动作**:全量回归(测试 + 真机冒烟)→ catalog.tsv 增量补登 → 树 SHA 抽查(可选:`git format-patch` 再生 + 临时 clone 对账)。
- **备份**:定期 `git push origin main`(origin 是用户自己的 fork)。**push 前必做全量历史密钥扫描**(见 backlog)。

## 3. dimina:跟上游 didi/dimina 升级

本仓历史线性(am 重放可逐字节还原,树 SHA 已对账)——所以:

- **升级方式 = rebase**:`git fetch --unshallow origin && git rebase --onto <新上游基线> <旧基线> main`,merge 提交会被丢弃——**这是安全的**(树 SHA 对账已证明内容不依赖它们),但 rebase 后必须跑一次「全系列 git am → 树 SHA 对账」作为安全门。
- rebase 后:`patches/dimina-series/` 全系列**重新物化**(编号/基线/树 SHA 全部刷新)+ README 更新。
- **建议(未做)**:给 fork 建自己的私有远端,原始历史双保险。

## 4. wanqi 自身

- master 单线直推;开源前执行「历史压缩」(重建干净初始提交,原历史私档保留)——**待用户拍板**。
- `patches/` 目录是 dsh-Go/dimina 两仓的**档案室**:catalog 与补丁的更新随对应仓的任务验收走。

## 5. 分类纪律(dsh-go catalog)

- 每个新提交落 catalog 时标三类之一:**平台对接**(可随万器公开,待拍板)/ **个人 UI**(永不开源)/ **基础设施**;拿不准按主要目的归并 + 备注理由。
- 开源物化(平台类精选补丁)**挂起中**——等用户对开源范围拍板,届时从 git 按分类再生,不预支体积。
