/// AppHub server entrypoint — thin wrapper.
/// Real body lives in lib/server_runner.dart so the compiled `wanqi serve`
/// (分发形态)和 launchd 启动器(dart run bin/apphub.dart)共用同一循环。
library;

import 'package:apphub/server_runner.dart';

Future<void> main(List<String> args) async {
  await runServer(args);
}
