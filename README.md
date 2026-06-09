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

## 安装 VS Code Bridge

`codex-account-switcher` 切换账号后会更新 `~/.codex-switchboard/vscode-refresh.signal`。Bridge 扩展在每个 VS Code 窗口中监听该文件，并重启对应的扩展宿主，让 Codex 插件重新读取账号，同时保留当前窗口。

```bash
mkdir -p /private/tmp/codex-switchboard-bridge-vsix/extension
cp vscode-bridge/package.json vscode-bridge/extension.js vscode-bridge/README.md /private/tmp/codex-switchboard-bridge-vsix/extension/
cp vscode-bridge/vsix/[Content_Types].xml vscode-bridge/vsix/extension.vsixmanifest /private/tmp/codex-switchboard-bridge-vsix/
cd /private/tmp/codex-switchboard-bridge-vsix
zip -qr /private/tmp/codex-switchboard-bridge-0.2.0.vsix .
/Applications/Visual\ Studio\ Code.app/Contents/Resources/app/bin/code --install-extension /private/tmp/codex-switchboard-bridge-0.2.0.vsix --force
```

安装后，可在 VS Code 命令面板运行 `Codex Switchboard: Restart Extension Host` 验证 Bridge。

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
