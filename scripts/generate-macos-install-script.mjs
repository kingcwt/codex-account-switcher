import fs from 'node:fs';
import path from 'node:path';

// 生成命令行安装脚本：通过 curl 下载不会写入浏览器 quarantine，并在复制后再次清理隔离属性。
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
const version = tag.replace(/^v/, '');
const uploadedDmgName = `${productName}_${version}_${arch}.dmg`.replaceAll(' ', '.');
const dmgUrl = `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(uploadedDmgName)}`;

const script = `#!/usr/bin/env bash
set -euo pipefail

APP_NAME="${productName}"
DMG_URL="${dmgUrl}"

TMP_DIR="$(mktemp -d)"
DMG_PATH="$TMP_DIR/$APP_NAME.dmg"
MOUNT_DIR="$(mktemp -d)"

cleanup() {
  hdiutil detach "$MOUNT_DIR" -quiet >/dev/null 2>&1 || true
  rm -rf "$TMP_DIR" "$MOUNT_DIR"
}
trap cleanup EXIT

echo "Downloading $APP_NAME..."
curl -fL "$DMG_URL" -o "$DMG_PATH"

# Chrome/Safari 下载会写入 quarantine；命令行安装时主动清理，避免 Gatekeeper 误拦截未公证的内部应用。
xattr -c "$DMG_PATH" >/dev/null 2>&1 || true

echo "Mounting installer..."
hdiutil attach "$DMG_PATH" -nobrowse -quiet -mountpoint "$MOUNT_DIR"

INSTALL_DIR="/Applications"
if [ ! -w "$INSTALL_DIR" ]; then
  INSTALL_DIR="$HOME/Applications"
  mkdir -p "$INSTALL_DIR"
fi

echo "Installing to $INSTALL_DIR..."
rm -rf "$INSTALL_DIR/$APP_NAME.app"
ditto "$MOUNT_DIR/$APP_NAME.app" "$INSTALL_DIR/$APP_NAME.app"
xattr -dr com.apple.quarantine "$INSTALL_DIR/$APP_NAME.app" >/dev/null 2>&1 || true

codesign --verify --deep --strict --verbose=2 "$INSTALL_DIR/$APP_NAME.app"

echo "$APP_NAME installed successfully."
open "$INSTALL_DIR/$APP_NAME.app"
`;

fs.writeFileSync(outputPath, script, { mode: 0o755 });
console.log(`macOS install script generated: ${outputPath}`);
