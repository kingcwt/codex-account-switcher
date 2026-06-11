cask "codex-account-switcher" do
  version "0.1.3"
  sha256 "4d5cbe38b54295de88dcfd77c0c100d5013ed30157cb8c6db2c82a8ab3925484"

  url "https://github.com/kingcwt/codex-account-switcher/releases/download/v#{version}/Codex.Account.Switcher_#{version}_aarch64.dmg"
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
