# audio-test 工具脚本

验收小程序「音频验收」(appid `wx3a7f2c9e1b8d4f56`)的配套工具。

## 生成测试曲目

```sh
node tools/gen-audio.js            # 产出 tools/out/{bundle-melody,net-echo}.wav
```

- `bundle-melody.wav`:包内曲目,4s 上行音阶,打进 zip 的 `main/assets/`。
- `net-echo.wav`:网络曲目,3s 下行音阶+颤音,由 AppHub 网关反代伺服。

## 网络曲源(必须走 AppHub 网关)

真机宿主 App 的 networkSecurityConfig 只对 `127.0.0.1`/`localhost` 放行 cleartext,
公网 http 会被系统拦,所以网络曲源走网关反代:

```sh
# 1. 起静态服务(端口 9208,根目录 tools/out;文件需在 out/audio/ 下)
node tools/net-server.js

# 2. 注册路由(一次性)
cd ~/Code/dsh-Go/apphub
~/dev/flutter/bin/cache/dart-sdk/bin/dart run bin/apphubctl.dart route add \
  --app wx3a7f2c9e1b8d4f56 --prefix / --target http://127.0.0.1:9208 \
  --key $(python3 -c "import json;print(json.load(open('$HOME/dsh/apphub/config.json'))['publisherKey'])")

# 3. 验证
curl -sI http://127.0.0.1:7610/api/v1/apps/wx3a7f2c9e1b8d4f56/audio/net-echo.wav
```

小程序内网络曲源 URL 固定为:
`http://127.0.0.1:7610/api/v1/apps/wx3a7f2c9e1b8d4f56/audio/net-echo.wav`
(手机侧经 dsh-go App 的 SSH 隧道访问 127.0.0.1:7610。)

## 编译打包发布(完整链路)

```sh
cd ~/Code/dimina/fe
node packages/compiler/src/bin/index.js build \
  -c <项目目录>/audio-test -s /tmp/audio-test-dist

# 编译器资产收编只认图片扩展名,音频需手动注入 main/assets/
mkdir -p /tmp/audio-test-dist/wx3a7f2c9e1b8d4f56/main/assets
cp tools/out/bundle-melody.wav /tmp/audio-test-dist/wx3a7f2c9e1b8d4f56/main/assets/

cd /tmp/audio-test-dist/wx3a7f2c9e1b8d4f56
zip -qr /tmp/audio-test-<版本>.zip main

cd ~/Code/dsh-Go/apphub
~/dev/flutter/bin/cache/dart-sdk/bin/dart run bin/apphubctl.dart publish \
  /tmp/audio-test-<版本>.zip --app wx3a7f2c9e1b8d4f56 --name 音频验收 \
  --path pages/audio/audio --version-code <递增> --version-name <X.Y.Z> \
  --key $(python3 -c "import json;print(json.load(open('$HOME/dsh/apphub/config.json'))['publisherKey'])")
```

注意:dart 不要走 `~/dev/flutter/bin/dart` 包装脚本(会尝试写 flutter cache);
直接用 `~/dev/flutter/bin/cache/dart-sdk/bin/dart`。
