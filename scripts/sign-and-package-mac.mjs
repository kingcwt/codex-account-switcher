import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 读取 Tauri 配置，确保脚本跟随应用名和版本号变化，不额外维护重复配置。
const rootDir = process.cwd();
const tauriConfigPath = path.join(rootDir, 'src-tauri', 'tauri.conf.json');
const tauriConfig = JSON.parse(fs.readFileSync(tauriConfigPath, 'utf8'));
const productName = tauriConfig.productName;
const version = tauriConfig.version;

// GitHub Actions 当前只发布 macOS arm64；本地执行时按当前机器架构推断。
const arch = process.argv[2] || (process.arch === 'arm64' ? 'aarch64' : process.arch);
const releaseDirByArch = {
  x86_64: path.join(rootDir, 'src-tauri', 'target', 'x86_64-apple-darwin', 'release'),
  universal: path.join(rootDir, 'src-tauri', 'target', 'universal-apple-darwin', 'release'),
};
const releaseDir = releaseDirByArch[arch] || path.join(rootDir, 'src-tauri', 'target', 'release');
const bundleDir = path.join(releaseDir, 'bundle');
const macosBundleDir = path.join(bundleDir, 'macos');
const dmgBundleDir = path.join(bundleDir, 'dmg');
const appPath = path.join(macosBundleDir, `${productName}.app`);
const appArchivePath = path.join(macosBundleDir, `${productName}.app.tar.gz`);
const appArchiveSigPath = `${appArchivePath}.sig`;
const dmgPath = path.join(dmgBundleDir, `${productName}_${version}_${arch}.dmg`);
const desktopPackageDir = path.join(rootDir, 'desktop-packages');
const desktopPackagePath = path.join(desktopPackageDir, path.basename(dmgPath));
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-account-switcher-dmg-'));
const stagedAppPath = path.join(tempDir, `${productName}.app`);
const stagedApplicationsLink = path.join(tempDir, 'Applications');

// 本地 .env 使用 updater 命名，Tauri CLI signer 使用 signing 命名，这里做兼容映射。
process.env.TAURI_SIGNING_PRIVATE_KEY ||= process.env.TAURI_UPDATER_PRIVATE_KEY;
process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ||= process.env.TAURI_UPDATER_PRIVATE_KEY_PASSWORD;

// 使用 execFile 避免 shell 展开影响带空格的 app 路径。
const run = (command, args) => {
  execFileSync(command, args, { stdio: 'inherit' });
};

// 递归清理下载隔离等扩展属性，避免打包进 DMG 后触发“已损坏”类拦截。
const clearExtendedAttributes = (targetPath) => {
  try {
    run('/usr/bin/xattr', ['-c', targetPath]);
  } catch {
    // 某些构建产物没有可写扩展属性，忽略后继续处理子项。
  }

  const stat = fs.lstatSync(targetPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    return;
  }

  for (const entry of fs.readdirSync(targetPath)) {
    clearExtendedAttributes(path.join(targetPath, entry));
  }
};

// 与已验证项目保持一致：对完整 app bundle 做 ad-hoc 签名并立即校验。
const signAppBundle = () => {
  run('codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', appPath]);
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);
};

// updater 压缩包必须来自重签后的 app bundle，并重新生成 Tauri updater 签名。
const rebuildUpdaterArchive = () => {
  fs.rmSync(appArchivePath, { force: true });
  fs.rmSync(appArchiveSigPath, { force: true });
  run('tar', ['-czf', appArchivePath, '-C', macosBundleDir, `${productName}.app`]);
  run('npm', ['run', 'tauri', '--', 'signer', 'sign', appArchivePath]);
};

// DMG 需要从已签名且已清理属性的 app 重新制作，保证用户下载的是同一份已验证 bundle。
const rebuildDmg = () => {
  fs.mkdirSync(dmgBundleDir, { recursive: true });
  run('ditto', [appPath, stagedAppPath]);
  fs.symlinkSync('/Applications', stagedApplicationsLink);
  run('hdiutil', [
    'create',
    '-volname',
    `${productName} ${version}`,
    '-srcfolder',
    tempDir,
    '-ov',
    '-format',
    'UDZO',
    dmgPath,
  ]);
};

if (!fs.existsSync(appPath)) {
  throw new Error(`App bundle not found: ${appPath}`);
}

clearExtendedAttributes(appPath);
signAppBundle();
clearExtendedAttributes(appPath);
rebuildDmg();
rebuildUpdaterArchive();

// 保留一份根目录副本，方便本机排查和人工下载验证。
fs.mkdirSync(desktopPackageDir, { recursive: true });
fs.copyFileSync(dmgPath, desktopPackagePath);

console.log(`Signed macOS DMG created: ${dmgPath}`);
console.log(`Copied macOS DMG to: ${desktopPackagePath}`);
console.log(`Signed macOS updater archive created: ${appArchivePath}`);
