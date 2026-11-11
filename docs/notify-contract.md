# Dimina 小程序通知系统契约 v1(万器镜像)

> **本文件是镜像,不是活源。** 契约唯一来源 = 万器开发工作区的 `dimina-notify-contract.md`
> (2026-11-10 拍板);此处为 2026-11-11 的快照镜像,供开源读者自包含阅读。两边若冲突,以工作区为准。
>
> **仓库边界(必读)**:通知系统跨三个仓库,本仓库只承载**平台侧(AppHub server)**实现:
> - **宿主端(dsh-go,Flutter 手机壳)**:通知中心、订阅面板、系统通知投递、点击跳转——**闭源,不在本仓库**;
> - **容器端(Dimina,小程序容器)**:`wx.requestSubscribeMessage` / `getSetting.subscriptionsSetting` API 面——
>   容器本体不开源,但其所需的**全部容器侧改动已物化为补丁**公开在本仓库
>   [`patches/dimina/notify-only/`](../patches/dimina/notify-only/README.md)(含逐文件 diff 摘要与宿主对接说明);
> - **平台端(AppHub server)**:模板登记、发送判定、配额记账、通知存储、轮询/已读——在本仓库 `server/`。
>
> **实现状态**:镜像时点 P1–P4 已全部实现(含 §10 实现偏差登记,改代码前必读 §10);
> 契约头部「待实现」为拍板时的原始状态,保留不改以忠实原文。推送(App push)为 v1 预留接口,
> v1 仅客户端拉取,见 README「通知系统」一节。

---

# Dimina 小程序通知系统契约 v1

> 状态：**设计已拍板，待实现**。拍板日期 2026-11-10。
> 拍板结论：走**微信兼容路线**；小程序前端只申请订阅、不发通知；服务端才有发送权；
> 通知的收集与治理在 AppHub，展示与跳转在 dsh-go，Dimina 只提供 API 面。
> 与既有文档关系：并入 `docs/apps/miniprogram-spec.md` 的通知章节；宿主侧并入
> `docs/design/`（通知中心）。本文件是实现的唯一依据。

---

## 0. 目标与非目标

**目标**

1. 小程序（前端 JS + 后端）用**微信同形**的 API 完成「申请订阅 → 服务端发送 → 落到手机通知」。
2. 所有小程序的通知**统一收集**到一处，可管理：未读、已读、去重、按 app 分组、点击跳转。
3. 小程序全程**不直接与 dsh-go 打交道**，只与框架/平台契约打交道。
4. 自研小程序与未来第三方小程序走同一条路，不搞两套。

**非目标（v1 明确不做）**

- 长期订阅（微信仅特定类目开放）——只支持一次性订阅。
- 模板人工审核（我们没有运营方）——降级为「登记 + 结构校验」。
- 多用户 / openid / 群发。dsh-go 是单机单用户。
- 小程序前端直接发本地通知（**永久不做**，见 §7 取舍 1）。
- Web 端通知中心复用（留接口，不在 v1）。

---

## 1. 兼容策略：形状严格兼容，治理语义本地化

### 1.1 为什么走兼容

不是因为要迁第三方代码（我们的小程序都是自研的），而是为了**继承一套被验证过的防骚扰语义**：
「用户点击触发授权 → 一次性配额 → 服务端发送 → 平台聚合展示 → 点击回跳」。
自己发明一套，代价是踩一遍微信踩过的坑。

### 1.2 三层分工（锁死，不再讨论）

```
小程序 JS ──wx.requestSubscribeMessage/getSetting──▶ Dimina（API 面）
                                                         │ bridge
                                                         ▼
小程序后端 ──POST send(token)──▶ AppHub（平台：模板/配额/存储/校验）
                                                         │ poll + read
                                                         ▼
                                              dsh-go（宿主：面板/通知/跳转）
```

| 层 | 管什么 | 不管什么 |
|---|---|---|
| **Dimina** | API 名字与签名、参数校验、把调用桥给宿主、把结果回给 JS、`getSetting` 的订阅状态回读 | 不存通知、不记账、不弹面板、不投递 |
| **AppHub** | 模板登记与 id 发放、`data` 结构/格式校验、订阅配额记账、通知对象存储与已读、发送鉴权、限流 | 不碰设备 UI |
| **dsh-go** | 订阅面板（原生）、系统通知/Banner、通知中心、点击路由、把 consent 结果回传 AppHub | 不定义协议 |

**五问判据**（有争论时用它裁决）：
谁定义 API 形状 → Dimina；谁弹面板 → dsh-go；谁存/记账/校验 → AppHub；谁显示通知 → dsh-go；谁负责跳转 → dsh-go。

### 1.3 为什么 Dimina 不能「完全不管」

`wx.requestSubscribeMessage` 若不由 Dimina 注册，小程序 JS 调用直接 `is not a function`，
连「申请」这一步都发不出去，AppHub 无从记账。Dimina 是**唯一能让小程序看见这个 API 的地方**。

---

## 2. 契约

### 2.1 前端 API（Dimina 实现）

#### `wx.requestSubscribeMessage(Object object)`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `tmplIds` | `string[]` | 是 | 模板 id 集合，最多 5 个 |
| `success` / `fail` / `complete` | `function` | 否 | 回调 |

成功回调形状（与微信一致）：

```json
{ "errMsg": "requestSubscribeMessage:ok", "tpl_abc123": "accept" }
```

值域：`accept`（同意）/ `reject`（拒绝）/ `ban`（模板被封禁）/ `filter`（模板被过滤）。

**硬约束（照抄微信）**：仅在用户点击行为中可调用。非点击态调用返回 fail。

**实现要点**：框架侧只做参数校验 + 桥接；**面板由宿主弹**（§5.3）。

#### `wx.getSetting()` 返回值新增 `subscriptionsSetting`

```json
{
  "authSetting": { ... },
  "subscriptionsSetting": {
    "mainSwitch": true,
    "itemSettings": { "tpl_abc123": "accept", "tpl_def456": "reject" }
  }
}
```

`mainSwitch` = 用户级订阅总开关（关掉后所有发送失败，见 §2.4 的 43101）。

### 2.2 后端 API（AppHub 实现）

```
POST /api/v1/apps/<appId>/notify
Authorization: Bearer <app_token>
Content-Type: application/json
```

请求体（**字段名照抄微信** `subscribe/send`）：

| 字段 | 类型 | 必填 | 兼容状态 | 说明 |
|---|---|---|---|---|
| `template_id` | string | 是 | ✅ | 模板 id，须已登记 |
| `page` | string | 否 | ✅ | 点击跳转页，仅本小程序内，可带参 `index?foo=bar` |
| `touser` | string | 是 | 🔇 | 保留以兼容微信代码；单机忽略 |
| `data` | object | 是 | ✅ | `{"thing01": {"value": "..."}}`，按键类型校验 |
| `miniprogram_state` | string | 否 | ↔ | `formal`/`trial`/`developer`；**缺省 formal** → 映射 AppHub 版本通道 |
| `lang` | string | 是 | 🔇 | 保留；v1 界面语言跟系统 |

响应：`{"errcode": 0, "errmsg": "ok"}`（失败见 §2.4）。

### 2.3 字段兼容状态总表

| 状态 | 含义 | 字段 |
|---|---|---|
| ✅ 生效 | 语义完全落地 | `template_id`、`page`、`data` + 值格式校验、`mainSwitch`、一次性配额 |
| 🔇 空转 | 收下但不生效，服务端**接受不报错**，文档与调试日志标注忽略 | `touser`(openid)、`lang`、第三方平台代调用/权限集 |
| ↔ 换实现 | 微信有、我们换等价物 | `miniprogram_state`→版本通道；「服务通知」→通知中心；系统通知→`NotifyChannel`；点击→容器 navigate；模板审核→模板登记 |

**铁律**：凡 🔇 字段必须在本文档与代码注释里显式标注，禁止「假装支持」。这是本设计的核心纪律。

### 2.4 错误码

| errcode | errmsg | 场景 |
|---|---|---|
| 0 | ok | 成功 |
| 40001 | invalid credential | token 无效 |
| 40002 | template not registered | `template_id` 未登记 |
| 40003 | data invalid: <field> | `data` 键缺失/类型不符/长度超限 |
| 43101 | user refuse to accept the msg | 用户拒绝 / 未订阅（配额耗尽）/ `mainSwitch` 关闭 |
| 45009 | rate limited | 超过限流（每 app 每分钟 20 条、每日 200 条） |
| 47003 | argument invalid: <field> | 其他参数错误 |

错误码沿用微信同名值，便于迁入代码按 `errcode` 分支处理。

---

## 3. 数据模型（AppHub）

### 3.1 新增表

```sql
-- 模板登记：小程序声明 → AppHub 发 id。等价于微信「选用模板」，省掉审核。
CREATE TABLE IF NOT EXISTS notify_templates (
  template_id VARCHAR(64) PRIMARY KEY,   -- 平台发放，形如 tpl_<hash8>
  app_id      VARCHAR(64) NOT NULL,
  name        VARCHAR(64) NOT NULL,      -- 人读名，如「订单状态」
  fields_json TEXT NOT NULL,             -- [{"key":"thing01","type":"thing"},...]
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_app_name (app_id, name)
);

-- 订阅记账：一次性配额。user 单机固定为 'local'。
CREATE TABLE IF NOT EXISTS notify_subscriptions (
  app_id      VARCHAR(64) NOT NULL,
  template_id VARCHAR(64) NOT NULL,
  user_id     VARCHAR(64) NOT NULL DEFAULT 'local',
  remain      INT NOT NULL DEFAULT 0,    -- 剩余可发条数；accept +1
  item_status VARCHAR(16) NOT NULL DEFAULT 'accept',  -- 最近一次用户表态；reject 时留痕（§3.4）
  updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (app_id, template_id, user_id)
);

-- 用户级总开关
CREATE TABLE IF NOT EXISTS notify_prefs (
  scope   VARCHAR(64) PRIMARY KEY,       -- 'global' | 'app:<appId>'
  enabled TINYINT NOT NULL DEFAULT 1
);

-- 通知对象（替代现在往 install_events 塞字符串的做法）
CREATE TABLE IF NOT EXISTS notify_messages (
  id           BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  app_id       VARCHAR(64) NOT NULL,
  template_id  VARCHAR(64) NOT NULL,
  title        VARCHAR(128) NOT NULL,
  body         VARCHAR(512) NOT NULL,
  page         VARCHAR(512) NULL,        -- 点击路由
  miniprogram_state VARCHAR(16) NOT NULL DEFAULT 'formal',
  dedupe_key   VARCHAR(128) NULL,        -- 幂等键：同 app+key 只落一条
  read_at      TIMESTAMP NULL,
  dismissed_at TIMESTAMP NULL,
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_app_created (app_id, created_at),
  KEY idx_read (read_at),
  UNIQUE KEY uk_app_dedupe (app_id, dedupe_key)   -- NULL 可重复；并发同 key 由唯一键兜底
);
```

迁移：`notify_messages` 建立后，`AppHubNoticeService` 从 `install_events` 切走；
旧 `event='notify'` 行只做历史保留，不再参与轮询。

### 3.2 模板登记接口

```
POST /api/v1/apps/<appId>/notify/templates   { "name": "订单状态", "fields": [{"key":"thing01","type":"thing"}] }
→ { "template_id": "tpl_1a2b3c4d" }
GET  /api/v1/apps/<appId>/notify/templates
```

同 `name` 重复登记返回已存在的 id（幂等），字段变更则复用 id + 更新 `fields_json`。

**鉴权（重要）**：写入（POST）需 app token；**读取（GET）额外放行 loopback**。
原因：订阅面板由宿主弹出，宿主要拿模板名来渲染，但宿主不持有小程序后端的 app token（那是后端凭证）。
GET 是只读元数据，loopback 放行不扩大攻击面。

### 3.3 轮询与已读

```
GET  /api/v1/notices?since=<id>&appId=<可选>
→ { "notices": [ {id, appId, templateId, title, body, page, state, ts} ], "unread": 7 }

POST /api/v1/notices/read   { "ids": [1,2,3] }      -- 标记已读
POST /api/v1/notices/read   { "all": true, "appId": "..." }
```

`since` 语义保持现状（id 单调递增），新增 `unread` 汇总给角标用。

### 3.4 宿主内部端点：订阅结果上报

订阅面板由**宿主**弹出，用户点了 accept/reject，宿主必须告诉平台，否则配额无从记账。
这条不是给小程序用的，是设备 UI → 平台的回执：

```
POST /api/v1/notices/consent          -- 仅 loopback 可访问（AppHub 本地进程）
{ "appId": "wx...", "templateId": "tpl_1a2b3c4d", "action": "accept" | "reject" }
→ { "errcode": 0, "errmsg": "ok", "remain": 1 }
```

- `accept` → 该 `(app, template, local)` 配额 `remain + 1`；`reject` → 记 `itemSettings=reject`，配额不动。
- 鉴权：**不引入新密钥**，只校验连接来源是 loopback（设备上的宿主与 AppHub 同机/同隧道）。这是「宿主内部 API」而不是「小程序 API」的分界。
- 该端点是加在 `notices.dart` 还是独立路由由实现决定，但**必须**与面向小程序的 `/notify` 分开鉴权模型。

### 3.5 框架 ↔ 宿主扩展契约（Dimina 不得依赖 dsh-go）
Dimina 通过 `registerExtModule` 回调宿主，模块名固定 `dsh-notify`：

| 事件 | 入参 | 宿主返回 |
|---|---|---|
| `showSubscribePanel` | `{appId, tmplIds: [...]}` | `{results: {tplId: 'accept'\|'reject'}}` |
| `getSubscribeState` | `{}` | `{mainSwitch: bool, itemSettings: {tplId: 'accept'\|'reject'}}` |

框架负责把 `results` 映射成微信形状（`{errMsg:'requestSubscribeMessage:ok', <tplId>:'accept'}`），
宿主只负责弹 UI 与回传，不认识微信语义。宿主无实现 / 非点击态 → 框架按微信语义 fail。

---

## 4. 状态机

### 4.1 订阅配额

```
未订阅 ──用户点 accept──▶ remain+1（可发 1 条）──发送成功──▶ remain-1
                          └─用户点 reject──▶ 保持 0，记录 itemSettings=reject
mainSwitch 关闭 ──▶ 所有发送 43101（配额仍保留）
```

### 4.2 发送判定（服务端，顺序执行）

1. token 校验 → 40001
2. 模板存在且属该 app → 40002
3. `data` 按键类型校验 → 40003
4. `miniprogram_state` 合法性 → 47003（**缺省按 `formal`**，与微信「默认为正式版」一致）
5. **幂等去重**：同 `app + dedupe_key` 命中 → 直接返回 0（提前到配额之前，否则配额归零后的重试会被误判 43101）
6. `notify_prefs.global` 或 `app:<id>` 关闭 → 43101
7. 配额 `remain <= 0` → 43101
8. 限流 → 45009
9. 落 `notify_messages`、`remain-1`、写 audit（唯一键 `uk_app_dedupe` 兜底并发）

**关键**：判定与落库在**一个事务**内，防止并发超发。

### 4.3 通知对象生命周期

```
created(unread) ──客户端拉到──▶ shown（本地通知已弹）
   └─用户点通知──▶ read + 跳转
   └─用户划掉──▶ dismissed（不删，通知中心仍可见）
```

服务端保留 30 天，之后归档删除（v1 先不做归档，只留清理 SQL 待接）。

---

## 5. 分层实现落点（文件级）

### 5.1 Dimina — 前端 API 面

| 动作 | 文件 | 说明 |
|---|---|---|
| 新增 | `fe/packages/service/src/api/core/open-api/subscribe-message/index.js` | 照 `open-api/setting/index.js` 的 3 行模式：`export function requestSubscribeMessage(opts){ return invokeAPI('requestSubscribeMessage', opts) }` |
| 修改 | `fe/packages/service/src/api/core/open-api/setting/index.js` | 无改动（`getSetting` 已透传，`subscriptionsSetting` 由原生返回） |
| 参考 | `fe/packages/service/src/api/index.js` | `import.meta.glob('./core/**/index.js')` 自动挂载，新增目录即注册；`blockedPublicApiNames` 无需改动 |
| 桥接 | `fe/packages/container-sdk/src/core/bridge.ts:189-193` | 已有 `invokeAPI(name, params, this)` 通用通道，**无需改动** |

### 5.2 Dimina — 原生实现

| 端 | 动作 | 文件 |
|---|---|---|
| Android | 新增 | `android/dimina/src/main/kotlin/com/didi/dimina/api/openapi/SubscribeMessageApi.kt`（照 `openapi/SettingApi.kt`） |
| Android | 注册 | `android/dimina/src/main/kotlin/com/didi/dimina/core/MiniApp.kt:397` 旁加 `SubscribeMessageApi().registerWith(apiRegistry)` |
| Android | 修改 | `openapi/SettingApi.kt` 的 `settingResult()`：返回体加 `subscriptionsSetting`（读宿主扩展通道拿状态） |
| iOS | 新增 | `iOS/dimina/DiminaKit/Container/Api/OpenAPI/SubscribeMessageAPI.swift`（照 `SettingAPI.swift`） |
| iOS | 修改 | `iOS/dimina/DiminaKit/Container/Api/OpenAPI/SettingAPI.swift`：同上加 `subscriptionsSetting` |
| 宿主扩展点 | **复用** | `com.didi.dimina.Dimina.registerExtModule(name, ExtModuleHandler)`（契约见 `api/ext/ExtModuleHandler.kt`）：框架把「弹面板/查状态」回调给宿主，宿主不认识维」 |

**注意**：Dimina 框架**不得**依赖 dsh-go。所有涉及用户交互的动作走 `ExtModuleHandler` 回宿主。

### 5.3 dsh-go — 宿主侧

| 动作 | 文件 | 说明 |
|---|---|---|
| 新增 | `app/android/.../dimina/NotifyExtModule.kt` | 实现 `ExtModuleHandler`，处理 `showSubscribePanel` / `getSubscribeState` |
| 修改 | `app/android/.../dimina/DiminaPlugin.kt` | 在容器初始化处 `Dimina.registerExtModule("dsh-notify", ...)` |
| 面板 UI | v1：容器内原生 Dialog；v2：Flutter 玻璃 sheet | 视觉统一放 v2，先把链路跑通 |
| 修改 | `app/lib/ui/applet/dimina/dimina_host.dart` | `dsh/dimina` channel 加 `notifyConsent` 方法：面板结果回给 Dart，再上报 AppHub 记账 |
| 重写 | `app/lib/notify/apphub_notices.dart` | 由「拉到就弹系统通知」改为「拉到 → 写通知中心 store → 按前台/后台分流投递」；新增已读上报 |
| 新增 | `app/lib/ui/notify/notification_center.dart` | 通知中心页：按 app 分组、未读点、点击跳转、全部已读 |
| 修改 | `app/lib/notify/notify_channel.dart` | `NotifyPost` 增加 `source:'miniapp'` 与 `notifyId`，供点击后回写已读；不改原生契约 |
| 复用 | `app/lib/ui/notify/chat_alert_host.dart` | 前台 Banner 复用；小程序通知与聊天通知共用根 Overlay 层 |

**点击跳转**：`notify_messages.page` → `DiminaHost.open(appId, page: page)`；
实例已在则 navigate，不在则冷启到该页。跳转失败（页不存在）落通知中心页兜底。

### 5.4 AppHub — 平台侧

| 动作 | 文件 | 说明 |
|---|---|---|
| 重写 | `apphub/lib/notices.dart` | 现 `_push`/`_poll` 扩为：模板登记、发送校验（§4.2 八步）、轮询含 unread、已读上报 |
| 修改 | `apphub/lib/db.dart` | 建 §3.1 四张表 + 迁移 |
| 新增 | `apphub/lib/notify_store.dart` | 模板/订阅/消息的 SQL 封装，事务边界在此 |
| 参考 | `apphub/lib/gateway.dart:77` | 鉴权写法参考：`(headers['authorization'] ?? '') == 'Bearer $key'`；send 用小写 app_token，不要复用 publisher key |
| 修改 | `apphub/lib/db.dart:89` `app_tokens` | 表已在（`token`/`ai_daily_tokens`），确认发放流程并接给 notify 鉴权 |
| 保留 | `install_events` 通知行 | 仅历史留档，不再参与轮询 |

**当前门槛要替换**：现在的「该 app 至少注册过一条网关路由才允许响铃」（`notices.dart:44`）升级为 token 鉴权 + 模板登记，路由数不再作为代理指标。

---

## 6. 聚合入口与交互

### 6.1 通知中心（dsh-go）

- 入口：会话列表顶部「服务通知」入口 + 小程序桌面 AppHub 组角标。
- 列表：按时间倒序，按 app 分组可折叠；未读加粗 + 圆点。
- 操作：单条点击 → 跳转；单条划掉 → dismissed；「全部已读」。
- 空态：文案「小程序的通知会出现在这里」。

### 6.2 与聊天通知的关系

两者**共用投递管道**，但**不混流**：聊天通知不进入通知中心列表（它属于会话），
小程序通知不进入会话流。通知中心只收 `source=miniapp`。

---

## 7. 取舍与待拍板

1. **前端永久不能直接发通知**。理由：系统通知权限收口在宿主，放开即破坏「统一管理」前提；
   微信也没给。**已定**。
2. **不做模板审核**。只做登记 + 结构校验。**已定**：自用平台无运营方。
3. **v1 用原生订阅面板**，v2 再统一为 Flutter 玻璃 sheet。**已定**（先通链路）。
4. **待拍板**：通知中心是独立页，还是并入现有「消息/会话」页做一个 tab？
   建议独立页（原因：会话流被小程序通知污染会很难受）。
5. **待拍板**：`dedupe_key` 是否需要前端/后端约定格式？建议后端自由填（可选），
   服务端只做「同 app+同 key 且 24h 内」去重。

---

## 8. 分期与验收

| 期 | 内容 | 验收 |
|---|---|---|
| **P1**（不依赖 Dimina 改动） | dsh-go 通知中心 + AppHub 通知对象化（§3.1 四表、轮询含 unread、已读上报）+ AppHubNoticeService 改造 | 手动往 `notify_messages` 插一条 → 手机出通知 → 点开进通知中心 → 点击跳小程序页 → 未读点归零 |
| **P2** | AppHub 发送协议：模板登记 + §4.2 八步校验 + 限流 + errcode | 后端用兼容请求体发一条 → 落库 → 客户端收到；配额耗尽返回 43101 |
| **P3** | Dimina 前端 API + Android 原生（requestSubscribeMessage / getSetting.subscriptionsSetting） | 小程序 JS 调 requestSubscribeMessage → 宿主弹面板 → accept 后 AppHub 配额 +1 → 发送成功 |
| **P4** | iOS 对齐 + 点击路由兜底 + 通知中心细节打磨 | iOS 全链路同 P3；跳转失败落通知中心 |

**P1 可以立刻开工且与其余三期解耦**，建议先落地。

---

## 9. 已知坑（实现时必读）

1. `DiminaHost` 的 `dsh/dimina` channel 是**双向**的（`dimina_host.dart:35,51`），
   加方法不用新开链路；但要注意 Dart 侧 `setMethodCallHandler` 已有一个注册点，
   新增分支不要覆盖。
2. AppHub 是 Dart VM 服务，`notices` 端点当前**无鉴权**（只查路由数），
   P2 必须在同一次改动里把 token 鉴权加上，否则是「谁都能响你的手机」。
3. 通知点击后回写已读是**客户端职责**，服务端不要依赖它（点击可能失败/进程被杀）。
4. `NotifyChannel` 在 widget test / desktop 下原生侧缺失，已有容错
   （`NotifySystemStatus.unavailable()`），通知中心 UI 的测试要用 `FakeNotifyChannel`
   （现成参考：`app/lib/dev/pet_probe_support.dart:308`）。
5. 前台/后台分流已有现成判定（`appForegroundProvider` + `ChatAlertHost`），
   小程序通知接进去即可，不要另写一套生命周期监听。
6. 小程序通知在**进程被杀期间不补发**（现行设计 §4.6.4「连接活着才推」），
   服务端保留记录、下次启动通知中心可见——这是有意为之，不要当 bug 修。

---

## 10. 实现偏差登记（已接受，2026-11-11）

实现过程中与本文档字面不同的地方，逐条登记。**后续改代码前先读这一节**，不要以为是 bug。

| # | 偏差 | 原因 / 裁定 |
|---|---|---|
| 1 | `notify_subscriptions` 增加 `item_status` 列 | §3.4 要求记录用户 `reject` 表态，原表无处存。已同步 §3.1 |
| 2 | `notify_messages` 增加 `UNIQUE KEY uk_app_dedupe(app_id, dedupe_key)` | 并发同 key 只靠「先查再插」会漏；唯一键兜底，`NULL` 可重复。已同步 §3.1 |
| 3 | 幂等去重判定**提前到配额/限流之前** | 否则配额归零后的重试被误判 43101，幂等失效。已同步 §4.2 |
| 4 | `miniprogram_state` 由「必填」放宽为「缺省 formal」 | 与微信「默认为正式版」一致。已同步 §2.2 |
| 5 | HTTP 状态码映射自定：0→200、40001→401、43101→403、45009→429、其余业务错→400 | 40002 特意不用 404：shelf `Cascade` 会把 404 当「本路由不认」，落到网关 catch-all 变成 not found 文本 |
| 6 | 「每日 200」按**服务器本地自然日**(`CURDATE()`)计 | 规格未定口径；自然日比滚动 24h 好解释 |
| 7 | consent 非 loopback 拒绝复用 47003 | 规格没有「禁止」专用码 |
| 8 | 通知 `title` = 模板 name（≤128）、`body` = 按模板字段顺序拼 value（` · `，≤512） | 规格未定义派生规则。**v1 不允许后端覆盖 title/body**：强制走模板，防绕过 data 校验与治理 |
| 9 | 新增 `POST /api/v1/apps/<appId>/notify/token`（publisher key 保护）+ `apphubctl token --app <id>` | `app_tokens` 原来只有建表没有发放流程，P2 联调无 token 不可用；未引入新密钥体系 |

### 10.1 已知遗留（不阻塞，发布/集成阶段处理）

1. `shared/jssdk` 未重打：真机上旧 bundle 能通过 native 名字枚举到 `requestSubscribeMessage`，
   但要让 service bundle 内含显式实现需走发布流程（`pnpm build && pnpm generate:sdk`，会 bump versionCode）。
2. iOS 未做 xcodebuild 真编译验证：本沙箱 SPM/Clang 缓存写在工作区外必失败。
   源码已按 Android 行为对齐并通过 `swiftc -parse`；需在沙箱外跑一次
   `xcodebuild -project iOS/dimina.xcodeproj -scheme dimina -destination 'generic/platform=iOS Simulator' build`。
3. `GET /api/v1/notices` 轮询端点**仍未鉴权**（沿用 M1 LAN 信任）。发送端点已加 token 鉴权；
   轮询暴露的是通知正文，属隐私面，建议下一轮补（设备侧可用 loopback 或 device token）。
4. `notify_prefs` 的 global/app 开关没有写接口（规格未定义 UI 入口），E2E 只能 SQL 置位。
5. 30 天清理未接（§4.3 v1 不做，代码留了待接点）。
