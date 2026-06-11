cask "codex-account-switcher" do
  version "0.1.3"
  sha256 "f3a4de42e40dcd1f1637d1ccf8747e48f9a4f4f77a1fd1a90a649bcfb332c43b"

  url "https://github.com/kingcwt/codex-account-switcher/releases/download/v#{version}/Codex.Account.Switcher.app.tar.gz"
  name "Codex Account Switcher"
  desc "Menu bar profile switcher for Codex accounts and proxy configs"
  homepage "https://github.com/kingcwt/codex-account-switcher"

  # Homebrew 安装路径避开浏览器下载链路，减少 Chrome/Safari quarantine 对未公证包的拦截。
  app "Codex Account Switcher.app"

  zap trash: [
    "~/Library/Application Support/com.cuihongran.codex-account-switcher",
    "~/Library/Caches/com.cuihongran.codex-account-switcher",
    "~/Library/Preferences/com.cuihongran.codex-account-switcher.plist",
  ]
end
