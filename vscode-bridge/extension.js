const vscode = require("vscode");
const fs = require("fs");
const os = require("os");
const path = require("path");

const RESTART_PATH = "/restart-extension-host";
const REFRESH_SIGNAL_PATH = path.join(
  os.homedir(),
  ".codex-switchboard",
  "vscode-refresh.signal"
);

async function restartExtensionHost() {
  // VS Code 没有公开的单扩展重启 API；重启扩展宿主可让 Codex 重读账号，同时保留当前窗口。
  await vscode.commands.executeCommand("workbench.action.restartExtensionHost");
}

function activate(context) {
  // 每个 VS Code 窗口都会启动一个本地 bridge，通过共享信号文件接收同一次刷新请求。
  let lastSignalMtimeMs = fs.existsSync(REFRESH_SIGNAL_PATH)
    ? fs.statSync(REFRESH_SIGNAL_PATH).mtimeMs
    : 0;
  fs.watchFile(REFRESH_SIGNAL_PATH, { interval: 500 }, (current) => {
    if (current.mtimeMs <= lastSignalMtimeMs) {
      return;
    }

    lastSignalMtimeMs = current.mtimeMs;
    void restartExtensionHost();
  });

  context.subscriptions.push({
    dispose() {
      // 扩展宿主重启前停止轮询，避免旧实例继续持有监听器。
      fs.unwatchFile(REFRESH_SIGNAL_PATH);
    },
  });

  // 保留 URI 入口用于手动排障，但 URI 只会被一个窗口接收，桌面端广播不依赖它。
  const uriHandler = vscode.window.registerUriHandler({
    handleUri(uri) {
      if (uri.path !== RESTART_PATH) {
        return;
      }

      void restartExtensionHost();
    },
  });

  // 命令面板入口用于确认 bridge 能否在当前窗口重启扩展宿主。
  const restartCommand = vscode.commands.registerCommand(
    "codexSwitchboard.restartExtensionHost",
    restartExtensionHost
  );

  context.subscriptions.push(uriHandler, restartCommand);
}

function deactivate() {}

module.exports = {
  activate,
  deactivate,
};
