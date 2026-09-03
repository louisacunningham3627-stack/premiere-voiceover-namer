#!/bin/bash
set -euo pipefail

# 卸载只移动到备份目录，保留可恢复性。目标根目录可通过 TARGET_ROOT 覆盖。
TARGET_ROOT="${TARGET_ROOT:-$HOME/Library/Application Support/Adobe/UXP/Plugins/External}"
PLUGIN_ID="com.hechao.premiere.voiceover-namer"
RUN_ID="$(date +%Y%m%d-%H%M%S)-$(uuidgen 2>/dev/null | tr -d '-' | cut -c1-8 || printf '%s' "$$")"

fail() { printf '卸载失败：%s\n' "$1" >&2; exit 1; }
PLUTIL_BIN="${PLUTIL_BIN:-$(command -v plutil || true)}"
[[ -n "$PLUTIL_BIN" && -x "$PLUTIL_BIN" ]] || fail "找不到 macOS 自带的 plutil，无法安全读取 manifest.json。"

manifest_value() {
  local manifest_path="$1"
  local key_path="$2"
  "$PLUTIL_BIN" -extract "$key_path" raw -o - "$manifest_path" 2>/dev/null
}

if [[ "${VOICEOVER_NAMER_SKIP_PREMIERE_CHECK:-0}" != "1" ]] && /usr/bin/pgrep -if "Adobe Premiere Pro" >/dev/null 2>&1; then
  fail "请先完全退出 Premiere Pro，再运行卸载。"
fi

TARGET_PATH="$TARGET_ROOT/$PLUGIN_ID"
if [[ ! -e "$TARGET_PATH" && ! -L "$TARGET_PATH" ]]; then
  printf '插件未安装：%s\n' "$TARGET_PATH"
  exit 0
fi
[[ ! -L "$TARGET_PATH" && -d "$TARGET_PATH" ]] || fail "目标路径不是普通插件目录（拒绝符号链接或非目录）：$TARGET_PATH"
[[ -f "$TARGET_PATH/manifest.json" ]] || fail "目标插件缺少 manifest.json，未移动任何文件。"
OLD_MANIFEST_ID="$(manifest_value "$TARGET_PATH/manifest.json" id)" || fail "无法解析插件 manifest.json，未移动任何文件。"
[[ "$OLD_MANIFEST_ID" == "$PLUGIN_ID" ]] || fail "插件 manifest ID 不匹配，未移动任何文件。"

UXP_ROOT="$(dirname "$(dirname "$TARGET_ROOT")")"
BACKUP_ROOT="$UXP_ROOT/PluginBackups"
BACKUP_PATH="$BACKUP_ROOT/$PLUGIN_ID-uninstalled-$RUN_ID"
mkdir -p "$BACKUP_ROOT"
mv "$TARGET_PATH" "$BACKUP_PATH" || fail "无法移动插件到可恢复备份目录。"

printf '卸载完成，插件已移出扫描目录。\n原位置：%s\n可恢复备份：%s\n恢复命令：mv "%s" "%s"\n' \
  "$TARGET_PATH" "$BACKUP_PATH" "$BACKUP_PATH" "$TARGET_PATH"
