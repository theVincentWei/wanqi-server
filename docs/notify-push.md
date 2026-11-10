# 通知系统服务端(万器移植版)与推送预留接口

> 契约唯一来源:workspace `dimina-notify-contract.md`(含 §10 实现偏差登记)。
> 本文件只记录万器移植版的落点、与 dsh-Go 原版的差异、以及**推送接口的未来接入方式**。

## 1. 端点面(与 dsh-Go 原版一致)

```
POST /api/v1/apps/<appId>/notify            后端发送(微信兼容请求体,app_token 鉴权)
POST /api/v1/apps/<appId>/notify/templates  模板登记(app_token 鉴权)
GET  /api/v1/apps/<appId>/notify/templates  模板列表(app_token 或 loopback)
POST /api/v1/apps/<appId>/notify/token      发放 app token(publisherKey 保护)
GET  /api/v1/notices?since=&appId=          宿主轮询(含 unread;deviceToken/loopback)
POST /api/v1/notices/read                   标已读(ids / all+appId)
POST /api/v1/notices/consent                宿主订阅回执(仅 loopback)
```

errcode → HTTP 状态:0→200、40001→401、43101→403、45009→429、其余业务错→400
(40002 特意不用 404:Cascade 会把 404 当「路由不认」穿透到网关 catch-all,契约 §10 偏差 5)。

## 2. 与 dsh-Go 原版的差异(移植时手工合并,非覆盖)

| 差异 | 说明 |
|---|---|
| `db.dart` 手工合并 | 万器侧保留自己的改动(apps.backend 列、`close()`、单连接串行化 + 断线重连);dsh-Go 侧的 `transaction()`/`DbTx`(独立连接事务)与 notify 四表 bootstrap 叠加进来 |
| `SendOutcome.notice` | 万器新增:发送落库成功后带出通知信封(id/appId/title/body/page/state),供推送分发用;幂等命中与失败为 null |
| `GET /notices` 鉴权 | dsh-Go 原版未鉴权(契约 §10.1.3 遗留);万器补上:配置了 `deviceToken` 时要求 `Bearer <deviceToken>`,loopback 始终放行,未配置 = 既有 LAN 信任(测试环境默认空,轮询契约不变) |
| 推送分发 | 万器新增 `lib/notify_push.dart`(见下节);dsh-Go 原版纯客户端拉、无抽象 |

## 3. 推送预留接口(用户新要求,v1 = 无推送)

**v1 语义**:没有服务端推送。dsh-go 宿主轮询 `GET /api/v1/notices` 即投递;进程被杀期间
不补发(契约 §9.6 有意为之)。`lib/notify_push.dart` 只是把**未来的落点留好**:

```dart
abstract class PushDispatcher {
  String get name;
  Future<void> dispatch(PushEnvelope envelope); // 必须尽力而为:吞异常,不抛
}

class NullPushDispatcher implements PushDispatcher { ... } // v1 默认
```

- 调用时机:`NotifyStore.send` 落库成功(事务已提交)后,`notices.dart` 调一次;
  **dedupe 幂等命中不会分发**(同一通知只推一次)。
- 信封 `PushEnvelope`:`{id, appId, templateId, title, body, page, state}`,与
  `notify_messages` 行一致;`page` 是小程序内路由,推送通道落地时放进自定义
  payload,由宿主翻译成 `DiminaHost.open(appId, page)`。
- 失败语义:分发失败只写日志(`[notify] push dispatch failed`),**绝不影响发送响应**——
  errcode 0 在落库时已成立,推送是增益不是路径。

### 未来接入 APNs / 厂商通道的步骤

1. 实现 `PushDispatcher`:`ApnsPushDispatcher`(HTTP/2 + token 凭证)、
   `HonorPushDispatcher` / `MiPushDispatcher`(厂商 REST);信封→厂商 payload 的
   映射放各自实现里,契约面不改。
2. `config.json` 加 push 段(凭证不进包、不进 git):

   ```json
   {
     "push": { "dispatcher": "apns", "apns": { "keyPath": "...", "topic": "..." } }
   }
   ```

   `dispatcher` 取值当前仅 `'none'`;未知取值退回 none 并日志提醒,不炸 server。
3. `bin/apphub.dart` 的 `buildPushDispatcher(cfg.push.dispatcher)` 按取值注册;
   多通道并存时改为注册一组 dispatcher 按 `state`(formal/trial)过滤即可。
4. 设备 token 的登记端点(v2):宿主拿到系统推送 token 后
   `POST /api/v1/notices/device-token`(loopback / deviceToken 保护)——**还没设计,
   接 APNs 时一起定**,本文件只占位提醒。

## 4. 自检与测试

```
cd server
dart run tool/notify_selfcheck.dart          # 纯逻辑自检,111 checks,免 DB 免 test 包
dart test test/notify_logic_test.dart        # 同源断言挂在 dart test 里(回归守卫)
```

E2E(连真实 :7620)见 `tool/notify_selfcheck.dart` 顶部注释与验收报告;轮询鉴权在
`config.local.json` 的 `deviceToken` 置空时走 LAN 信任,置值后手机宿主必须带 Bearer。
