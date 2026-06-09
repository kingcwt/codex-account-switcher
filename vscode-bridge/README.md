# Codex Account Switcher Bridge

This extension runs in every local VS Code window and watches
`~/.codex-switchboard/vscode-refresh.signal`. When Codex Account Switcher updates
the signal, every window restarts its extension host without reloading the
window.

The URI `vscode://cuihongran.codex-account-switcher-bridge/restart-extension-host`
is retained for manual troubleshooting, but only the shared signal reaches all
open windows.
