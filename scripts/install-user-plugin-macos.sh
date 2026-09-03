#!/bin/bash
set -euo pipefail

# 个人用户级侧载安装。目标根目录可通过 TARGET_ROOT 覆盖，便于隔离测试。
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [[ -d "$SCRIPT_DIR/plugin" ]]; then
  PROJECT_ROOT="$SCRIPT_DIR"
  DEFAULT_BUILD_PATH="$PROJECT_ROOT/plugin"
else
  PROJECT_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
  DEFAULT_BUILD_PATH="$PROJECT_ROOT/dist"
fi
BUILD_PATH="${BUILD_PATH:-$DEFAULT_BUILD_PATH}"
TARGET_ROOT="${TARGET_ROOT:-$HOME/Library/Application Support/Adobe/UXP/Plugins/External}"
PLUGIN_ID="com.hechao.premiere.voiceover-namer"
RUN_ID="$(date +%Y%m%d-%H%M%S)-$(uuidgen 2>/dev/null | tr -d '-' | cut -c1-8 || printf '%s' "$$")"

fail() { printf '安装失败：%s\n' "$1" >&2; exit 1; }
PLUTIL_BIN="${PLUTIL_BIN:-$(command -v plutil || true)}"
[[ -n "$PLUTIL_BIN" && -x "$PLUTIL_BIN" ]] || fail "找不到 macOS 自带的 plutil，无法安全读取 manifest.json。"

manifest_value() {
  local manifest_path="$1"
  local key_path="$2"
  "$PLUTIL_BIN" -extract "$key_path" raw -o - "$manifest_path" 2>/dev/null
}

if [[ "${VOICEOVER_NAMER_SKIP_PREMIERE_CHECK:-0}" != "1" ]] && /usr/bin/pgrep -if "Adobe Premiere Pro" >/dev/null 2>&1; then
  fail "请先完全退出 Premiere Pro，再运行安装。"
fi
[[ -d "$BUILD_PATH" ]] || fail "找不到构建目录：$BUILD_PATH，请先运行 npm run build。"
[[ ! -L "$BUILD_PATH" ]] || fail "构建目录不能是符号链接：$BUILD_PATH"
[[ -f "$BUILD_PATH/manifest.json" ]] || fail "构建目录缺少 manifest.json：$BUILD_PATH"
[[ -z "$(find "$BUILD_PATH" -type l -print -quit)" ]] || fail "构建目录包含符号链接，已拒绝安装。"

MANIFEST_ID="$(manifest_value "$BUILD_PATH/manifest.json" id)" || fail "无法解析 manifest.json 的插件 ID。"
[[ "$MANIFEST_ID" == "$PLUGIN_ID" ]] || fail "manifest.json 的插件 ID 不正确。"
HOST_APP="$(manifest_value "$BUILD_PATH/manifest.json" host.app)" || fail "无法解析 manifest.json 的宿主信息。"
[[ "$HOST_APP" == "premierepro" ]] || fail "manifest.json 不是 Premiere Pro 插件。"
VERSION="$(manifest_value "$BUILD_PATH/manifest.json" version)" || fail "无法解析 manifest.json 的版本号。"
[[ -n "$VERSION" ]] || fail "manifest.json 缺少版本号。"
if [[ -f "$PROJECT_ROOT/package.json" ]]; then
  EXPECTED_VERSION="$(manifest_value "$PROJECT_ROOT/package.json" version)" || fail "无法解析 package.json 的版本号。"
  [[ "$VERSION" == "$EXPECTED_VERSION" ]] || fail "构建版本 $VERSION 与项目版本 $EXPECTED_VERSION 不一致，请先重新构建。"
fi

if [[ -f "$PROJECT_ROOT/SHA256SUMS.txt" ]]; then
  [[ -z "$(find "$PROJECT_ROOT" -type l -print -quit)" ]] || fail "安装包包含符号链接，已拒绝安装。"
  checksum_count=0
  while IFS= read -r checksum_line || [[ -n "$checksum_line" ]]; do
    expected_hash="${checksum_line%%  *}"
    relative_path="${checksum_line#*  }"
    [[ "$checksum_line" == "$expected_hash  $relative_path" ]] || fail "安装包 SHA-256 清单格式不正确。"
    [[ "${#expected_hash}" == "64" && "$expected_hash" != *[!0-9A-Fa-f]* ]] || fail "安装包 SHA-256 哈希格式不正确。"
    case "$relative_path" in
      ""|/*|.|..|./*|../*|*/.|*/..|*/./*|*/../*|*\\*) fail "安装包 SHA-256 清单包含不安全路径：$relative_path" ;;
    esac
    [[ -f "$PROJECT_ROOT/$relative_path" && ! -L "$PROJECT_ROOT/$relative_path" ]] || fail "安装包 SHA-256 清单指向缺失文件或符号链接：$relative_path"
    actual_hash="$(shasum -a 256 "$PROJECT_ROOT/$relative_path" | awk '{ print $1 }')"
    [[ "$actual_hash" == "$expected_hash" ]] || fail "安装包 SHA-256 清单校验失败：$relative_path"
    checksum_count=$((checksum_count + 1))
  done < "$PROJECT_ROOT/SHA256SUMS.txt"
  package_file_count=0
  while IFS= read -r package_file; do
    package_relative="${package_file#./}"
    listed=0
    while IFS= read -r checksum_line || [[ -n "$checksum_line" ]]; do
      [[ "${checksum_line#*  }" == "$package_relative" ]] && listed=1
    done < "$PROJECT_ROOT/SHA256SUMS.txt"
    [[ "$listed" == "1" ]] || fail "安装包存在未列入 SHA-256 清单的文件：$package_relative"
    package_file_count=$((package_file_count + 1))
  done < <(cd "$PROJECT_ROOT" && find . -type f ! -path './SHA256SUMS.txt' -print | LC_ALL=C sort)
  [[ "$checksum_count" -ge 10 && "$checksum_count" == "$package_file_count" ]] || fail "安装包 SHA-256 清单数量不完整或包含重复项。"
fi

inventory() {
  local root="$1"
  (
    cd "$root"
    find . -type f -print | LC_ALL=C sort | while IFS= read -r relative; do
      relative="${relative#./}"
      shasum -a 256 "$relative" | awk -v path="$relative" '{ print $1 "  " path }'
    done
  )
}

UXP_ROOT="$(dirname "$(dirname "$TARGET_ROOT")")"
STAGING_ROOT="$UXP_ROOT/PluginStaging"
BACKUP_ROOT="$UXP_ROOT/PluginBackups"
TARGET_PATH="$TARGET_ROOT/$PLUGIN_ID"
STAGING_PATH="$STAGING_ROOT/$PLUGIN_ID-$RUN_ID"
BACKUP_PATH="$BACKUP_ROOT/$PLUGIN_ID-before-$RUN_ID"
FAILED_PATH="$BACKUP_ROOT/$PLUGIN_ID-failed-$RUN_ID"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/voiceover-namer-install.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT

mkdir -p "$TARGET_ROOT" "$STAGING_ROOT" "$BACKUP_ROOT"
mkdir "$STAGING_PATH"
cp -R "$BUILD_PATH"/. "$STAGING_PATH"/
[[ -z "$(find "$STAGING_PATH" -type l -print -quit)" ]] || fail "临时目录包含符号链接，已拒绝安装；现场已保留：$STAGING_PATH"
inventory "$BUILD_PATH" > "$TMP_ROOT/source.sha256"
inventory "$STAGING_PATH" > "$TMP_ROOT/staging.sha256"
cmp -s "$TMP_ROOT/source.sha256" "$TMP_ROOT/staging.sha256" || fail "临时目录逐文件 SHA-256 校验失败；临时目录已保留：$STAGING_PATH"

PREVIOUS_INSTALL=0
if [[ -e "$TARGET_PATH" || -L "$TARGET_PATH" ]]; then
  [[ ! -L "$TARGET_PATH" && -d "$TARGET_PATH" ]] || fail "目标路径已存在但不是普通插件目录（拒绝符号链接或非目录）：$TARGET_PATH"
  [[ -f "$TARGET_PATH/manifest.json" ]] || fail "目标插件缺少 manifest.json，未替换目标目录：$TARGET_PATH"
  OLD_MANIFEST_ID="$(manifest_value "$TARGET_PATH/manifest.json" id)" || fail "无法解析旧插件 manifest.json，未替换目标目录。"
  [[ "$OLD_MANIFEST_ID" == "$PLUGIN_ID" ]] || fail "旧插件 manifest ID 不匹配，未替换目标目录。"
  mv "$TARGET_PATH" "$BACKUP_PATH" || fail "无法备份旧插件；未替换目标目录。"
  PREVIOUS_INSTALL=1
fi

[[ ! -e "$TARGET_PATH" && ! -L "$TARGET_PATH" ]] || fail "目标路径在安装切换前被其他进程占用，已停止安装：$TARGET_PATH"
if ! mv "$STAGING_PATH" "$TARGET_PATH"; then
  if [[ "$PREVIOUS_INSTALL" == "1" && -d "$BACKUP_PATH" && ! -e "$TARGET_PATH" ]]; then
    mv "$BACKUP_PATH" "$TARGET_PATH" || true
  fi
  fail "无法将校验后的插件放入目标目录；旧版本已尝试恢复。"
fi

if ! inventory "$TARGET_PATH" > "$TMP_ROOT/installed.sha256" || ! cmp -s "$TMP_ROOT/source.sha256" "$TMP_ROOT/installed.sha256"; then
  mv "$TARGET_PATH" "$FAILED_PATH" || true
  if [[ "$PREVIOUS_INSTALL" == "1" && -d "$BACKUP_PATH" && ! -e "$TARGET_PATH" ]]; then
    mv "$BACKUP_PATH" "$TARGET_PATH" || true
  fi
  fail "安装后 SHA-256 校验失败；失败版本已保留：$FAILED_PATH"
fi

printf '安装完成：%s\n版本：%s\n文件数：%s\n' "$TARGET_PATH" "$VERSION" "$(wc -l < "$TMP_ROOT/source.sha256" | tr -d ' ')"
if [[ "$PREVIOUS_INSTALL" == "1" ]]; then
  printf '旧版本可恢复备份：%s\n' "$BACKUP_PATH"
fi
printf '下一步：启动 Premiere，在“窗口 > UXP 插件”中打开“赫朝录音命名器”。\n'
