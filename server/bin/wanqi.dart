/// wanqi — the Wanqi Bundle CLI entrypoint.
library;

import 'dart:io';

import 'package:apphub/wanqi_cli.dart';

Future<void> main(List<String> args) async {
  exitCode = await WanqiCli().run(args);
}
