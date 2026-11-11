#!/usr/bin/env bash
# wanqi CLI 全局安装器(在 wanqi 仓内任意位置执行):
#   bash server/tool/install-cli.sh
# 探测 repo 与 dart 位置,生成 ~/.local/bin/wanqi(路径烙定为默认值,WANQI_REPO/DART_BIN env 仍可覆盖)。
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
DART="${DART_BIN:-}"
if [ -z "$DART" ]; then
  for c in "$HOME/dev/flutter/bin/cache/dart-sdk/bin/dart" "$(command -v dart 2>/dev/null || true)"; do
    if [ -n "$c" ] && [ -x "$c" ]; then DART="$c"; break; fi
  done
fi
[ -n "${DART:-}" ] && [ -x "$DART" ] || {
  echo "install-cli: ✗ 未找到可执行的 dart(装 Flutter,或 DART_BIN=/path/to/dart bash $0 重试)"
  exit 1
}
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"
mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/wanqi" <<'SHIM'
#!/usr/bin/env bash
# 由 install-cli.sh 生成(repo: __REPO__, dart: __DART__);env WANQI_REPO/DART_BIN 可覆盖。
# dart 不可用时 `wanqi service …` 自动降级走 lifecycle.sh(应急后门)。
set -euo pipefail
REPO="${WANQI_REPO:-__REPO__}"
DART="${DART_BIN:-__DART__}"
if [ ! -x "$DART" ]; then
  if [ "${1:-}" = "service" ]; then shift; exec bash "$REPO/server/tool/lifecycle.sh" "$@"; fi
  echo "wanqi: dart 不可用($DART)。service 已降级为 lifecycle.sh;其余命令需要 dart。" >&2
  exit 69
fi
exec env PUB_CACHE="$REPO/.pub-cache" "$DART" run "$REPO/server/bin/wanqi.dart" "$@"
SHIM
sed -i '' -e "s|__REPO__|$REPO|g" -e "s|__DART__|$DART|g" "$BIN_DIR/wanqi"
chmod +x "$BIN_DIR/wanqi"
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) echo "提示: $BIN_DIR 不在 PATH,请把它加进 shell 配置";; esac
echo "✓ 已安装 $BIN_DIR/wanqi(repo: $REPO,dart: $DART)"
echo "  验证: wanqi service status"
