import fs from 'node:fs';
import path from 'node:path';

// 生成命令行安装脚本：直接下载 updater app 压缩包，避免暴露浏览器可误点的 DMG 安装包。
const args = process.argv.slice(2);
const getArg = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

const rootDir = process.cwd();
const tauriConfig = JSON.parse(fs.readFileSync(path.join(rootDir, 'src-tauri', 'tauri.conf.json'), 'utf8'));
const tag = getArg('--tag') || process.env.GITHUB_REF_NAME;
const repository = getArg('--repository') || process.env.GITHUB_REPOSITORY;
const arch = getArg('--arch') || 'aarch64';
const outputPath = getArg('--output') || path.join(rootDir, 'install-macos.sh');

if (!tag) {
  throw new Error('Missing release tag. Pass --tag or set GITHUB_REF_NAME.');
}

if (!repository) {
  throw new Error('Missing repository. Pass --repository or set GITHUB_REPOSITORY.');
}

const productName = tauriConfig.productName;
const uploadedArchiveName = `${productName}.app.tar.gz`.replaceAll(' ', '.');
const legacyArchiveName = `${productName}_aarch64.app.tar.gz`.replaceAll(' ', '.');

const script = `#!/usr/bin/env bash
set -euo pipefail

APP_NAME="${productName}"
REPOSITORY="${repository}"
DEFAULT_VERSION="${tag}"
VERSION="\${VERSION:-$DEFAULT_VERSION}"
ARCHIVE_NAME="${uploadedArchiveName}"
LEGACY_ARCHIVE_NAME="${legacyArchiveName}"
ARCHIVE_URL="https://github.com/\${REPOSITORY}/releases/download/\${VERSION}/\${ARCHIVE_NAME}"
LEGACY_ARCHIVE_URL="https://github.com/\${REPOSITORY}/releases/download/\${VERSION}/\${LEGACY_ARCHIVE_NAME}"

TMP_DIR="$(mktemp -d)"
ARCHIVE_PATH="$TMP_DIR/$APP_NAME.app.tar.gz"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

echo "Downloading $APP_NAME $VERSION..."
# v0.1.0/v0.1.1 使用过旧资产名；这里保留 fallback，方便用户安装历史版本。
if ! curl -fL "$ARCHIVE_URL" -o "$ARCHIVE_PATH"; then
  echo "Primary archive not found, trying legacy archive name..."
  curl -fL "$LEGACY_ARCHIVE_URL" -o "$ARCHIVE_PATH"
fi

echo "Extracting app..."
tar -xzf "$ARCHIVE_PATH" -C "$TMP_DIR"

INSTALL_DIR="/Applications"
if [ ! -w "$INSTALL_DIR" ]; then
  INSTALL_DIR="$HOME/Applications"
  mkdir -p "$INSTALL_DIR"
fi

echo "Installing to $INSTALL_DIR..."
rm -rf "$INSTALL_DIR/$APP_NAME.app"
ditto "$TMP_DIR/$APP_NAME.app" "$INSTALL_DIR/$APP_NAME.app"
xattr -dr com.apple.quarantine "$INSTALL_DIR/$APP_NAME.app" >/dev/null 2>&1 || true

codesign --verify --deep --strict --verbose=2 "$INSTALL_DIR/$APP_NAME.app"

echo "$APP_NAME installed successfully."
open "$INSTALL_DIR/$APP_NAME.app"
`;

fs.writeFileSync(outputPath, script, { mode: 0o755 });
console.log(`macOS install script generated: ${outputPath}`);
