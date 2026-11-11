// 通知协议纯逻辑单测(契约 dimina-notify-contract §4.2 九步发送判定等)。
// 与 tool/notify_selfcheck.dart 同源:那份是免 test 包的自检跑法,这份挂在
// dart test 里当回归守卫。
library;

import 'dart:convert';

import 'package:apphub/notify_logic.dart';
import 'package:apphub/notify_push.dart';
import 'package:apphub/notify_store.dart';
import 'package:test/test.dart';

Object goodData() => <String, Object?>{
      'thing01': <String, Object?>{'value': '订单已发货'},
      'time2': <String, Object?>{'value': '15:01'},
    };

Map<String, Object?> templateWithFields(List<Map<String, Object?>> fields) =>
    <String, Object?>{
      'template_id': 'tpl_1a2b3c4d',
      'app_id': 'wx5b8e2f4a9c1d7e60',
      'name': '订单状态',
      'fields_json': jsonEncode(<Object?>[
        <String, Object?>{'key': 'thing01', 'type': 'thing'},
        <String, Object?>{'key': 'time2', 'type': 'time'},
      ]),
    };

SendDecision decide({
  bool tokenValid = true,
  Map<String, Object?>? tmpl,
  Object? data,
  String? argumentError,
  bool prefsEnabled = true,
  int remain = 1,
  bool rateLimited = false,
  bool dedupeHit = false,
}) =>
    decideSend(
      tokenValid: tokenValid,
      template: tmpl,
      data: data ?? goodData(),
      argumentError: argumentError,
      prefsEnabled: prefsEnabled,
      remain: remain,
      rateLimited: rateLimited,
      dedupeHit: dedupeHit,
    );

void main() {
  group('模板 id(§3.2 登记幂等的基石)', () {
    test('同 app 同名 id 稳定,形如 tpl_<hash8>', () {
      final String first = templateIdFor('wx5b8e2f4a9c1d7e60', '订单状态');
      expect(templateIdFor('wx5b8e2f4a9c1d7e60', '订单状态'), first);
      expect(RegExp(r'^tpl_[0-9a-f]{8}$').hasMatch(first), isTrue);
    });

    test('不同 app / 不同 name 得到不同 id', () {
      final String base = templateIdFor('wx5b8e2f4a9c1d7e60', '订单状态');
      expect(templateIdFor('wxb6f8f4a9c1d7e611', '订单状态') == base, isFalse);
      expect(templateIdFor('wx5b8e2f4a9c1d7e60', '支付结果') == base, isFalse);
    });
  });

  group('模板 fields 校验(§3.2)', () {
    test('合法声明', () {
      expect(
          validateTemplateFields(<Object?>[
            <String, Object?>{'key': 'thing01', 'type': 'thing'},
            <String, Object?>{'key': 'time2', 'type': 'time'},
          ]),
          isNull);
      expect(validateTemplateFields(<Object?>[]), isNull);
    });

    test('非法声明逐条定位', () {
      expect(validateTemplateFields('x'), 'fields');
      expect(validateTemplateFields(<Object?>['thing01']), 'fields[0]');
      expect(
          validateTemplateFields(
              <Object?>[<String, Object?>{'key': 'Thing 1', 'type': 'thing'}]),
          'fields[0].key');
      expect(
          validateTemplateFields(
              <Object?>[<String, Object?>{'key': 'thing01', 'type': 'rich'}]),
          'fields[0].type');
      expect(
          validateTemplateFields(<Object?>[
            <String, Object?>{'key': 'thing01', 'type': 'thing'},
            <String, Object?>{'key': 'thing01', 'type': 'thing'},
          ]),
          'fields[1].key');
    });

    test('normalize 保留 key/type', () {
      expect(
          normalizeTemplateFields(<Object?>[
            <String, Object?>{'key': 'thing01', 'type': 'thing', 'extra': 1},
          ]),
          <Map<String, Object?>>[
            <String, Object?>{'key': 'thing01', 'type': 'thing'},
          ]);
    });
  });

  group('data 值格式校验(微信规则)', () {
    String? v(String type, String value) => validateDataValue(type, value);

    test('thing/name 汉字按宽 2 计', () {
      expect(v('thing', 'a' * 20), isNull);
      expect(v('thing', '字' * 10), isNull);
      expect(v('thing', '字' * 11), isNotNull);
      expect(v('thing', ''), 'must not be empty');
      expect(v('name', '字' * 5), isNull);
      expect(v('name', '字' * 6), isNotNull);
    });

    test('number/letter/character_string 长度与字符集', () {
      expect(v('number', '1' * 32), isNull);
      expect(v('number', '1' * 33), isNotNull);
      expect(v('number', '12a'), isNotNull);
      expect(v('letter', 'a' * 32), isNull);
      expect(v('letter', 'abc1'), isNotNull);
      expect(v('character_string', 'ABC-123_45'), isNull);
      expect(v('character_string', 'a' * 33), isNotNull);
    });

    test('symbol:5 个以内且不含字母数字汉字', () {
      expect(v('symbol', '...'), isNull);
      expect(v('symbol', '......'), isNotNull);
      expect(v('symbol', 'a'), isNotNull);
    });

    test('time 24 小时制', () {
      expect(v('time', '00:00'), isNull);
      expect(v('time', '9:05'), isNull);
      expect(v('time', '24:00'), isNotNull);
      expect(v('time', '15:60'), isNotNull);
    });

    test('date 年月日/连字符/斜杠', () {
      expect(v('date', '2026年11月10日'), isNull);
      expect(v('date', '2026-11-10'), isNull);
      expect(v('date', '2026/11/10'), isNull);
      expect(v('date', '2026-13-01'), isNotNull);
      expect(v('date', '2026-11'), isNotNull);
    });

    test('amount 币种符号 + 金额', () {
      expect(v('amount', '¥10.00'), isNull);
      expect(v('amount', '10.00'), isNotNull);
      expect(v('amount', '¥10.001'), isNotNull);
    });

    test('phone_number / car_number / phrase / 未知类型', () {
      expect(v('phone_number', '1' * 17), isNull);
      expect(v('phone_number', '1' * 18), isNotNull);
      expect(v('car_number', '粤B12345'), isNull);
      expect(v('car_number', '粤B123456789'), isNotNull);
      expect(v('phrase', '你好世界啊'), isNull);
      expect(v('phrase', '你好世界啊呀'), isNotNull);
      expect(v('phrase', 'ab'), isNotNull);
      expect(v('rich', 'x'), isNotNull);
    });

    test('整个 data 对象校验(§4.2 第 3 步)', () {
      final List<Map<String, Object?>> fields = <Map<String, Object?>>[
        <String, Object?>{'key': 'thing01', 'type': 'thing'},
        <String, Object?>{'key': 'time2', 'type': 'time'},
      ];
      expect(validateDataValues(goodData(), fields), isNull);
      expect(
          validateDataValues(<String, Object?>{
            'thing01': <String, Object?>{'value': '已发货'},
          }, fields),
          'time2');
      expect(
          validateDataValues(<String, Object?>{
            'thing01': '已发货',
            'time2': <String, Object?>{'value': '15:01'},
          }, fields),
          'thing01');
      expect(validateDataValues('x', fields), 'data');
    });
  });

  group('发送判定九步顺序(§4.2,dedupe 分支按 §10 偏差 3 前移)', () {
    final Map<String, Object?> template = templateWithFields(const <Map<String, Object?>>[]);
    final Object? badData = <String, Object?>{
      'thing01': <String, Object?>{'value': ''},
      'time2': <String, Object?>{'value': '15:01'},
    };

    test('第 1 步 token 无效最先返回 40001', () {
      final SendDecision decision = decide(
          tokenValid: false,
          tmpl: null,
          data: badData,
          prefsEnabled: false,
          remain: 0,
          rateLimited: true);
      expect(decision.errcode, 40001);
      expect(decision.errmsg, 'invalid credential');
    });

    test('第 2 步 模板未登记先于 data → 40002', () {
      final SendDecision decision = decide(
          tmpl: null,
          data: badData,
          argumentError: 'miniprogram_state',
          prefsEnabled: false);
      expect(decision.errcode, 40002);
      expect(decision.errmsg, 'template not registered');
    });

    test('第 3 步 data 非法先于参数/开关/配额/限流 → 40003 带字段名', () {
      final SendDecision decision = decide(
          tmpl: template,
          data: badData,
          argumentError: 'miniprogram_state',
          prefsEnabled: false,
          remain: 0,
          rateLimited: true);
      expect(decision.errcode, 40003);
      expect(decision.errmsg, 'data invalid: thing01');
    });

    test('第 4 步 参数非法先于开关/配额/限流 → 47003', () {
      final SendDecision decision = decide(
          tmpl: template,
          argumentError: 'miniprogram_state',
          prefsEnabled: false,
          remain: 0,
          rateLimited: true);
      expect(decision.errcode, 47003);
      expect(decision.errmsg, 'argument invalid: miniprogram_state');
    });

    test('第 5 步 总开关关闭先于配额/限流 → 43101', () {
      final SendDecision decision =
          decide(tmpl: template, prefsEnabled: false, remain: 0, rateLimited: true);
      expect(decision.errcode, 43101);
      expect(decision.errmsg, 'user refuse to accept the msg');
    });

    test('幂等命中:配额归零后重试同 key 仍返回 0(§10 偏差 3)', () {
      final SendDecision decision = decide(
          tmpl: template, remain: 0, rateLimited: false, dedupeHit: true);
      expect(decision.errcode, 0);
      expect(decision.dedupe, isTrue);
      expect(decision.sends, isFalse);
    });

    test('第 6 步 配额耗尽先于限流 → 43101', () {
      expect(decide(tmpl: template, remain: 0, rateLimited: true).errcode, 43101);
      expect(decide(tmpl: template, remain: -1).errcode, 43101);
    });

    test('第 7 步 限流 → 45009', () {
      final SendDecision decision = decide(tmpl: template, remain: 1, rateLimited: true);
      expect(decision.errcode, 45009);
      expect(decision.errmsg, 'rate limited');
    });

    test('第 8 步 全通过 → 0 且需要落库', () {
      final SendDecision decision = decide(tmpl: template, remain: 1);
      expect(decision.errcode, 0);
      expect(decision.errmsg, 'ok');
      expect(decision.sends, isTrue);
    });
  });

  group('去重幂等语义(§7.5:同 app + key 24h 只落一条)', () {
    test('重试不落库不扣配额,配额用光后仍幂等', () {
      final Map<String, Object?> template = templateWithFields(const <Map<String, Object?>>[]);
      int remain = 2;
      int rows = 0;
      final Set<String> seenKeys = <String>{};

      SendDecision send(String? key) {
        final bool hit = key != null && seenKeys.contains(key);
        final SendDecision decision = decideSend(
          tokenValid: true,
          template: template,
          data: goodData(),
          prefsEnabled: true,
          remain: remain,
          rateLimited: false,
          dedupeHit: hit,
        );
        if (decision.sends) {
          rows++;
          remain--;
          if (key != null) seenKeys.add(key);
        }
        return decision;
      }

      expect(send('order:42').errcode, 0);
      expect(rows, 1);
      expect(remain, 1);
      final SendDecision retry = send('order:42');
      expect(retry.errcode, 0);
      expect(retry.dedupe, isTrue);
      expect(rows, 1);
      expect(remain, 1);
      expect(send('order:43').errcode, 0);
      expect(remain, 0);
      expect(send('order:43').errcode, 0);
      expect(rows, 2);
      expect(send('order:44').errcode, 43101);
    });
  });

  group('参数与派生规则', () {
    test('miniprogram_state:缺省合法(按 formal)', () {
      expect(isValidMiniprogramState(null), isTrue);
      expect(isValidMiniprogramState('formal'), isTrue);
      expect(isValidMiniprogramState('trial'), isTrue);
      expect(isValidMiniprogramState('developer'), isTrue);
      expect(isValidMiniprogramState('beta'), isFalse);
      expect(notifyVersionChannels['formal'], 'stable');
    });

    test('page:可空、仅站内路径', () {
      expect(isValidPage(null), isTrue);
      expect(isValidPage('pages/order/index?foo=bar'), isTrue);
      expect(isValidPage(1), isFalse);
      expect(isValidPage('https://evil.example/x'), isFalse);
    });

    test('loopback 判定(§3.4 宿主内部端点)', () {
      expect(isLoopbackAddress('127.0.0.1'), isTrue);
      expect(isLoopbackAddress('127.1.2.3'), isTrue);
      expect(isLoopbackAddress('::1'), isTrue);
      expect(isLoopbackAddress('::ffff:127.0.0.1'), isTrue);
      expect(isLoopbackAddress('192.168.1.23'), isFalse);
      expect(isLoopbackAddress('8.8.8.8'), isFalse);
    });

    test('title=模板名,body=按字段顺序拼值(§10 偏差 8)', () {
      final List<Map<String, Object?>> fields = <Map<String, Object?>>[
        <String, Object?>{'key': 'thing01', 'type': 'thing'},
        <String, Object?>{'key': 'time2', 'type': 'time'},
      ];
      expect(messageTitle('订单状态'), '订单状态');
      expect(messageBody(fields, goodData()), '订单已发货 · 15:01');
      expect(
          messageBody(fields, <String, Object?>{
            'thing01': <String, Object?>{'value': '长' * 300},
            'time2': <String, Object?>{'value': '15:01'},
          }).length <= 512,
          isTrue);
    });

    test('限流口径 20/分钟、200/天(§10 偏差 6:本地自然日)', () {
      expect(notifyRatePerMinute, 20);
      expect(notifyRatePerDay, 200);
      expect(notifyDedupeWindow, const Duration(hours: 24));
    });
  });

  group('推送预留接口(PushDispatcher)', () {
    test('NullPushDispatcher 无操作且 name=none', () async {
      final PushDispatcher dispatcher = NullPushDispatcher();
      expect(dispatcher.name, 'none');
      await dispatcher.dispatch(PushEnvelope(
        id: 1,
        appId: 'wx5b8e2f4a9c1d7e60',
        templateId: 'tpl_1a2b3c4d',
        title: '订单状态',
        body: '订单已发货',
        page: 'pages/order/index',
        state: 'formal',
      ));
    });

    test('PushEnvelope 与 Map 互转', () {
      final PushEnvelope envelope = PushEnvelope(
        id: 7,
        appId: 'a',
        templateId: 'tpl_x',
        title: 't',
        body: 'b',
        page: null,
        state: 'trial',
      );
      final PushEnvelope back = PushEnvelope.fromMap(envelope.toMap());
      expect(back.id, 7);
      expect(back.page, isNull);
      expect(back.state, 'trial');
    });

    test('SendOutcome.notice 默认 null(幂等/失败不分发)', () {
      expect(const SendOutcome(errcode: 0, errmsg: 'ok', dedupe: true).notice, isNull);
      expect(const SendOutcome(errcode: 43101, errmsg: 'refused').notice, isNull);
    });
  });

  group('宿主上报告知(§3.5/§6.4 修订:升级完成之类也进收件箱)', () {
    test('合法 body 校验通过,解析补齐缺省', () {
      const Map<String, Object?> body = <String, Object?>{
        'appId': 'wx3d8b6f2a9c4e7d15',
        'title': '双拼教练',
        'body': '「双拼教练」已升级至 v1.3.0',
        'dedupeKey': 'upgrade-30',
      };
      expect(validateHostNotice(body), isNull);
      final HostNoticeInput input = parseHostNotice(body);
      expect(input.appId, 'wx3d8b6f2a9c4e7d15');
      expect(input.title, '双拼教练');
      expect(input.body, '「双拼教练」已升级至 v1.3.0');
      expect(input.page, isNull);
      expect(input.dedupeKey, 'upgrade-30');
    });

    test('body 缺省字段:body 空、page/dedupeKey 空 = null', () {
      const Map<String, Object?> body = <String, Object?>{
        'appId': 'wx3d8b6f2a9c4e7d15',
        'title': '记账',
      };
      expect(validateHostNotice(body), isNull);
      final HostNoticeInput input = parseHostNotice(body);
      expect(input.body, '');
      expect(input.page, isNull);
      expect(input.dedupeKey, isNull);
    });

    test('非法逐项定位:非 Map/appId/title/body/page/dedupeKey', () {
      expect(validateHostNotice('nope'), 'body');
      expect(validateHostNotice(<String, Object?>{'title': 't'}), 'appId');
      expect(validateHostNotice(<String, Object?>{'appId': 'wx1'}), 'title');
      expect(validateHostNotice(<String, Object?>{'appId': 'wx1', 'title': ' '}), 'title');
      expect(
        validateHostNotice(<String, Object?>{
          'appId': 'wx1',
          'title': 't',
          'body': 'x' * 513,
        }),
        'body',
      );
      expect(
        validateHostNotice(<String, Object?>{
          'appId': 'wx1',
          'title': 't',
          'page': 'https://evil.example',
        }),
        'page',
      );
      expect(
        validateHostNotice(<String, Object?>{
          'appId': 'wx1',
          'title': 't',
          'dedupeKey': 'k' * 129,
        }),
        'dedupeKey',
      );
    });

    test('title 两端空白在解析时裁掉(128 按裁后计)', () {
      final String pad = 'x' * 127;
      expect(
        validateHostNotice(<String, Object?>{'appId': 'wx1', 'title': ' $pad '}),
        isNull,
      );
      expect(
        validateHostNotice(<String, Object?>{'appId': 'wx1', 'title': ' $pad x'}),
        'title',
      );
      final HostNoticeInput input =
          parseHostNotice(<String, Object?>{'appId': 'wx1', 'title': ' 记账 '});
      expect(input.title, '记账');
    });
  });
}
