# wanqi server 生命周期设计(v1,2026-11-11)

> 状态(2026-11-11):脚本版已全部落地并实测;`bin/apphub.dart` 的 Db.connect 重试为唯一待办(脚本级 wait 已双保险)。
> 背景:2026-11-11 下午整条服务链(MariaDB/server/引擎)同时躺平——launchd 域进不去、DB 没起、server 连库即崩、只能全程手动 nohup 救火。本文把生命周期定成法:单入口、依赖有序、健康可测、agent 可操作、launchd 只管看护。

## 1. 组件清单与拓扑

| 组件 | 端口 | 真实启动器(唯一) | 依赖 | 数据 |
|---|---|---|---|---|
| MariaDB | 3306 | `/opt/homebrew/opt/mariadb/bin/mariadbd --datadir=/opt/homebrew/var/mysql --port=3306 --bind-address=127.0.0.1`(注册态由 brew services 托管,手动态由 lifecycle nohup) | – | `/opt/homebrew/var/mysql` |
| wanqi server(生产) | 7610 | `~/dsh/apphub/start-apphub-server.sh` → `dart run bin/apphub.dart --config ~/dsh/apphub/config.json`(代码源 `~/Code/wanqi/server`) | MariaDB | DB `apphub` + `~/dsh/apphub/data` |
| 引擎(dsh web) | 7611 | `~/dsh/apphub/engine-supervisor.sh` → `~/.local/bin/dsh web --port 7611`(崩溃 3s 重启,维护 `engine-launch.txt` token) | – | 日志 |
| wanqi server(测试) | 7620 | `~/dsh/apphub/start-wanqi-test.sh`(独立库 `apphub_test`,数据 `~/dsh/wanqi-test`) | MariaDB | 独立库 + 独立数据目录 |

依赖图(严格顺序):`MariaDB → server(生产/测试) → [server 自己拉起各 bundle backend];引擎与 DB 无关,可并行。

## 2. 不变式

1. **单一控制入口**:`server/tool/lifecycle.sh`——所有组件的 `status/start/stop/restart/doctor/logs`,幂等、可从**任何会话/任何 launchd 域**运行(纯进程/端口操作,绝不依赖 launchctl 成功)。
2. **启动器只有一份**:launchd plist 与 lifecycle.sh 都只是调同一个脚本。launchd 负责 KeepAlive(崩溃自愈 + 登录自启);lifecycle.sh 负责 agent/手动形态。两者幂等共存:
   - `start`:目标端口已健康 → no-op;否则清 stale 端口占用 → 先试 `launchctl kickstart`(gui 域可用时最正规),报 125/域错误则降级 `nohup <脚本>`。
   - `stop`:kill 监听进程。launchd 托管态下 KeepAlive 会拉回(stop≈restart),真要停服去用户 Terminal `launchctl bootout`——文档如实写明,不做假语义。
3. **依赖内建**:server 启动脚本内建 wait-for-db(循环探 3306,最多 60s,超时打明确报错指向 `lifecycle.sh doctor db`);lifecycle 拉起顺序恒为 db→server→(并行)engine。
4. **健康判定**(doctor 的唯一标准):
   - 3306:TCP 可连 + `mariadb -e 'SELECT 1'` 成功;
   - 7610/7620:`GET /api/v1/apps` 200;
   - 7611:TCP 可连且 `/` 返回 200/401(**401 = token 保护,是健康,不是故障**);
   - 全绿输出一行 `SERVICE_OK`,任一组件输出组件名 + 修复动作。
5. **每次动 server 前先 doctor**:构建(尤其 gradle)、会话重启、装机验收前,先跑 `lifecycle.sh doctor`,exit 0 才继续(写进两个 skill 的既定流程)。
6. **plist 纪律**:launchd 只指向 `~/dsh/apphub/` 下的稳定路径,**永不指向会话工作区**(2026-11-11 staging 残留教训)。
7. **日志统一** `~/dsh/apphub/*.log`;`lifecycle.sh logs <组件>` 输出尾部,不另造日志地。

## 3. lifecycle.sh 接口

```
server/tool/lifecycle.sh status [--json]        # 四组件健康表 + 托管形态(launchd/nohup/未运行)
server/tool/lifecycle.sh doctor                 # 检查 + 按依赖序自动修复;exit 0=全绿,1=仍有组件不健康
server/tool/lifecycle.sh start|stop|restart [db|server|engine|test|all]
server/tool/lifecycle.sh logs <db|server|engine|test> [-n 行数] [-f]
```

实现要点:

- **托管形态判定**:`launchctl print gui/$(id -u)/<label>` 成功 = launchd 态;125/失败静默 = 不可见(不视为错误);再查 nohup 脚本进程 = 手动态;都没有 = 未运行。
- **db.start**:3306 在 → no-op;否则 `brew services start mariadb`(容错 125)→ 5s 仍不在 → 直接 nohup `mariadbd`(参数见 §1,日志 `~/dsh/apphub/mariadb.log`)。
- **并发防护**:`mkdir /tmp/wanqi-lifecycle.lock` 原子锁,doctor 串行化。
- **--json**:status 输出机器可读结果,供 skill/脚本判断。
- bash 实现(不做成 dart CLI 子命令):lifecycle 必须在 dart/pub 环境坏了时依然可用——它是救火的最后手段,不能依赖被救对象。

## 4. 服务端代码小改(随实现落)

- `bin/apphub.dart`:`Db.connect` 加重试(10 × 3s),启动行打 `db ready (127.0.0.1:3306)`;连接失败的重试期打 `waiting for db (n/10)`。消除「server 比 DB 先起就秒死」的时序脆断——脚本级 wait + 代码级 retry 双保险。

## 5. 一次性迁移(用户 Terminal,gui 域)

```bash
brew services start mariadb                                  # 注册 + 开机自启
launchctl kickstart -k gui/$(id -u)/app.dsh.apphub.server    # 顶掉手动 nohup,交回 launchd
launchctl kickstart -k gui/$(id -u)/app.dsh.apphub.engine
launchctl kickstart -k gui/$(id -u)/app.dsh.wanqi-test.server
```

此后日常态 = launchd 全托管;lifecycle.sh 的 start 多为 no-op,doctor 只观察不动手。

## 6. 故障手册(今天案例固化)

| 症状 | 判定 | 处置 |
|---|---|---|
| 手机市场空白 / AppHub 未连接 | `lifecycle.sh doctor` | 按缺失组件拉起(先看 db) |
| server 起了又秒死 | server 日志 `Connection refused` 指向 db 端口 | `lifecycle.sh start db` 后 restart server |
| gradle 大构建后 7610 死 | 已知挤死坑(构建完必现检查) | `lifecycle.sh doctor` |
| `125: Domain does not support…` | agent 会话不在 gui launchd 域(非故障) | 走 lifecycle.sh 降级 nohup;要回归 launchd 托管让用户在 Terminal kickstart |
| 引擎 `/` 返回 401 | 正常(token 保护) | 不是故障,别修 |
| 引擎 supervisor 日志出现会话工作区路径 | plist 曾指过临时目录(历史残留) | 确认 plist 指向 `~/dsh/apphub/` 稳定路径,无则改 |

## 7. 实现清单

- [x] `server/tool/lifecycle.sh`(status/doctor/start/stop/restart/logs,含 db 内建拉起)
- [x] `start-apphub-server.sh` 加 wait-for-db(与 §4 代码 retry 二选一先落脚本版)
- [x] 测试 server 启动脚本确认已存在:`~/dsh/wanqi-test/start-wanqi-test-server.sh`(无需抽出)
- [ ] `bin/apphub.dart` Db.connect 重试(§4)
- [x] skill 联动:`dsh-go-install`「连坐三件」段、`dsh-go-miniprogram` 排障段改指向 `lifecycle.sh doctor`
- [x] `docs/workflow.md` 不变式补一条:「动 server 前先 doctor」
