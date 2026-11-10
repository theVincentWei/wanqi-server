/// 推送分发预留接口(Bundle 平台用户新要求,契约 dimina-notify-contract 之上)。
///
/// **v1 语义:无推送,纯客户端拉**——dsh-go 宿主轮询 `GET /api/v1/notices`
/// (契约 §3.3),进程被杀期间不补发(§9.6 有意为之)。本文件只是给未来的
/// APNs / 安卓厂商通道**留好落点**:发送成功、`notify_messages` 已落库提交后,
/// [NotifyStore] 的调用方会调用 [PushDispatcher.dispatch];v1 注册的是
/// [NullPushDispatcher](无操作)。
///
/// 未来接入真实推送的方式(见 docs/notify-push.md):
///   1. 实现 [PushDispatcher](如 ApnsPushDispatcher / HonorPushDispatcher);
///   2. config.json 加 `push.dispatcher` 段;
///   3. bin/apphub.dart 里 buildPushDispatcher 按配置注册。
/// 分发失败只写日志,绝不影响发送响应(errcode 0 已成立,推送是尽力而为)。
library;

/// 一条已落库通知的推送信封。字段与 `notify_messages` 行一致(契约 §3.1),
/// 由 NotifyStore.send 在落库成功后组装。
class PushEnvelope {
  const PushEnvelope({
    required this.id,
    required this.appId,
    required this.templateId,
    required this.title,
    required this.body,
    required this.page,
    required this.state,
  });

  factory PushEnvelope.fromMap(Map<String, Object?> map) => PushEnvelope(
        id: map['id'] as int,
        appId: map['appId'] as String,
        templateId: map['templateId'] as String,
        title: map['title'] as String,
        body: map['body'] as String,
        page: map['page'] as String?,
        state: map['state'] as String? ?? 'formal',
      );

  final int id;
  final String appId;
  final String templateId;
  final String title;
  final String body;

  /// 点击路由(仅本小程序内,契约 §2.2);APNs 落地时映射到自定义 payload,
  /// 由宿主翻译成 DiminaHost.open(appId, page)。
  final String? page;

  /// 微信原值 formal / trial / developer(§2.3 ↔);推送通道可按它过滤测试包。
  final String state;

  Map<String, Object?> toMap() => <String, Object?>{
        'id': id,
        'appId': appId,
        'templateId': templateId,
        'title': title,
        'body': body,
        'page': page,
        'state': state,
      };
}

/// 推送分发抽象。实现方必须**尽力而为**:任何异常都应吞掉并记日志,
/// 不得向调用方抛出(发送的 HTTP 响应与推送解耦)。
abstract class PushDispatcher {
  String get name;

  /// 通知已落库后调用。同一通知只会 dispatch 一次(重试命中的 dedupe 分支
  /// 不会走到这里)。
  Future<void> dispatch(PushEnvelope envelope);
}

/// v1 默认实现:无推送,纯客户端拉(契约 §3.3 轮询即投递)。
class NullPushDispatcher implements PushDispatcher {
  @override
  String get name => 'none';

  @override
  Future<void> dispatch(PushEnvelope envelope) async {}
}

/// 按配置构建分发器。v1 只认 'none';未来加 'apns' / 'honor' / 'mipush' 等
/// 时在 config.json 的 `push.dispatcher` 里选(见 docs/notify-push.md)。
PushDispatcher buildPushDispatcher(String dispatcher) {
  switch (dispatcher) {
    case 'none':
      return NullPushDispatcher();
    default:
      // 未知配置不炸 server,退回无推送并让运维在日志里看到一次提醒。
      return NullPushDispatcher();
  }
}
