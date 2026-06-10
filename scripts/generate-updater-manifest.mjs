import fs from 'node:fs';
import path from 'node:path';

// 参数读取保持简单明确，供 GitHub Actions 和本地验证共用。
const args = process.argv.slice(2);
const getArg = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

// latest.json 只描述 updater 压缩包，不描述 DMG 安装包。
const rootDir = process.cwd();
const tag = getArg('--tag') || process.env.GITHUB_REF_NAME;
const repository = getArg('--repository') || process.env.GITHUB_REPOSITORY;
const arch = getArg('--arch') || (process.arch === 'arm64' ? 'aarch64' : process.arch);
const outputPath = getArg('--output') || path.join(rootDir, 'latest.json');
const releaseDir = arch === 'x86_64'
  ? path.join(rootDir, 'src-tauri', 'target', 'x86_64-apple-darwin', 'release')
  : path.join(rootDir, 'src-tauri', 'target', 'release');
const macosBundleDir = path.join(releaseDir, 'bundle', 'macos');

if (!tag) {
  throw new Error('Missing release tag. Pass --tag or set GITHUB_REF_NAME.');
}

if (!repository) {
  throw new Error('Missing repository. Pass --repository or set GITHUB_REPOSITORY.');
}

// GitHub release asset 下载地址可由仓库、tag 和文件名稳定推导，避免依赖上传后的 API 再查询。
const toReleaseDownloadUrl = (assetName) => {
  const encodedName = assetName.split('/').map(encodeURIComponent).join('/');
  return `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodedName}`;
};

const signatureFile = fs.readdirSync(macosBundleDir)
  .find((name) => name.endsWith('.app.tar.gz.sig'));

if (!signatureFile) {
  throw new Error(`No updater signature found in ${macosBundleDir}`);
}

const updaterAssetName = signatureFile.replace(/\.sig$/, '');
const signature = fs.readFileSync(path.join(macosBundleDir, signatureFile), 'utf8').trim();
const payload = {
  signature,
  url: toReleaseDownloadUrl(updaterAssetName),
};

// Tauri v2 updater 使用 darwin-aarch64 / darwin-x86_64 平台键匹配当前系统。
const manifest = {
  version: tag.replace(/^v/, ''),
  notes: `Release ${tag}`,
  pub_date: new Date().toISOString(),
  platforms: {
    [`darwin-${arch}`]: payload,
    [`darwin-${arch}-app`]: payload,
  },
};

fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Updater manifest generated: ${outputPath}`);
