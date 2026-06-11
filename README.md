# codex-account-switcher

一个面向 macOS 的 Codex 账号切换器。它会把当前 Codex 配置保存为本地 Profile，并在切换账号时同步更新 Codex App、Codex CLI 和 VS Code 中的 Codex 插件。

## 功能

- 从 `~/.codex/config.toml` 和 `~/.codex/auth.json` 导入当前账号
- 保存多个本地账号快照并快速切换
- 切换前自动保存当前激活账号的最新状态
- 覆盖 Codex 配置前保存一份最后可用备份
- 支持编辑账号名称与备注、删除账号、重新应用配置和同步快照
- 支持通过 macOS 菜单栏直接切换账号
- 切换后自动尝试重启 Codex App
- 通过配套 Bridge 通知所有 VS Code 窗口刷新 Codex 插件

## 工作方式

应用不会修改数据库，也不会把账号信息上传到远端。所有 Profile 和备份均保存在本机：

为兼容已有安装和账号快照，本地数据目录继续沿用 `~/.codex-switchboard/`。

```text
~/.codex-switchboard/
├── active-profile.json
├── backup/
│   └── last-known-good/
├── profiles/
│   └── <profile-id>/
│       ├── meta.json
│       ├── config.toml
│       └── auth.json
└── vscode-refresh.signal
```

切换账号时，目标 Profile 中的 `config.toml` 和 `auth.json` 会写入 `~/.codex/`。应用写入的敏感文件会在 Unix 系统上设置为仅当前用户可读写。

## 环境要求

- macOS
- Node.js 和 npm
- Rust 工具链
- Tauri 2 所需的系统依赖
- 已安装 Codex App 或 Codex CLI，并已生成 `~/.codex/config.toml` 与 `~/.codex/auth.json`

## 本地运行

```bash
npm install
npm run desktop
```

浏览器预览只展示界面，不能读写本地 Codex 配置：

```bash
npm run dev
```

## 开发检查

```bash
npm run lint
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
```

## 发布与自动更新

当前仓库可直接承载源码开发、安装包发布和应用内更新：

- `dev`：日常源码开发分支
- `main`：项目介绍、下载入口和稳定说明
- `v*` tag：触发 GitHub Actions 自动构建并发布安装包
- GitHub Releases：存放 `.dmg`、`.app.tar.gz`、签名和 `latest.json`

首次发版前需要生成 Tauri updater 签名密钥，并把密钥写入仓库 Secrets。私钥只放 Secrets，不提交到仓库。

```bash
npm run tauri -- signer generate -w ~/.tauri/codex-account-switcher.key
```

在 GitHub 仓库的 `Settings -> Secrets and variables -> Actions` 中配置：

- `TAURI_UPDATER_PRIVATE_KEY`：生成的私钥内容
- `TAURI_UPDATER_PRIVATE_KEY_PASSWORD`：生成密钥时设置的密码；如果未设置密码则留空
- `TAURI_UPDATER_PUBKEY`：生成命令输出的公钥

发版时更新 `src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml` 中的版本号后推送 tag：

```bash
git tag v0.1.0
git push origin v0.1.0
```

GitHub Actions 会构建 macOS 安装包并上传到当前仓库的 Release。应用内“检查更新”会读取当前仓库最新 Release 的 `latest.json`，校验签名后安装更新，重启应用后生效。

### macOS 下载安全校验

当前 macOS Release 采用参考项目的兼容链路：Tauri 生成原始产物后，脚本会清理 app bundle 扩展属性、执行 ad-hoc 重签、重做 DMG，并用重签后的 app 重新生成 updater 压缩包和签名。

Chrome/Safari 直接下载未公证 DMG 时，macOS 仍可能给文件写入 `com.apple.quarantine` 并触发 Gatekeeper 拦截。Release 会额外上传 `install-macos.sh`，通过命令行下载、安装并清理隔离属性：

```bash
curl -fsSL https://github.com/kingcwt/codex-account-switcher/releases/latest/download/install-macos.sh | bash
```

也可以用 Homebrew Cask 安装：

```bash
brew tap kingcwt/codex-account-switcher https://github.com/kingcwt/codex-account-switcher
brew install --cask codex-account-switcher
```

安装完成后，应用内自动更新继续使用 Tauri updater 的签名校验。

## 安装 VS Code Bridge

`codex-account-switcher` 切换账号后会更新 `~/.codex-switchboard/vscode-refresh.signal`。Bridge 扩展在每个 VS Code 窗口中监听该文件，并重启对应的扩展宿主，让 Codex 插件重新读取账号，同时保留当前窗口。

```bash
mkdir -p /private/tmp/codex-account-switcher-bridge-vsix/extension
cp vscode-bridge/package.json vscode-bridge/extension.js vscode-bridge/README.md /private/tmp/codex-account-switcher-bridge-vsix/extension/
cp vscode-bridge/vsix/[Content_Types].xml vscode-bridge/vsix/extension.vsixmanifest /private/tmp/codex-account-switcher-bridge-vsix/
cd /private/tmp/codex-account-switcher-bridge-vsix
zip -qr /private/tmp/codex-account-switcher-bridge-0.2.0.vsix .
/Applications/Visual\ Studio\ Code.app/Contents/Resources/app/bin/code --install-extension /private/tmp/codex-account-switcher-bridge-0.2.0.vsix --force
```

安装后，可在 VS Code 命令面板运行 `Codex Account Switcher: Restart Extension Host` 验证 Bridge。

## 技术栈

- Tauri 2
- React 19
- TypeScript
- Rust
- Vite
- Tailwind CSS

## 项目结构

```text
src/             React 前端与 Tauri 调用封装
src-tauri/       Tauri 桌面端、Profile 文件管理和菜单栏逻辑
vscode-bridge/   VS Code 扩展宿主刷新桥接扩展
```

## 安全提示

Profile 中包含 Codex 登录凭据或 API Key。请勿把 `~/.codex-switchboard/`、`~/.codex/auth.json` 或任何真实账号快照提交到 Git。
