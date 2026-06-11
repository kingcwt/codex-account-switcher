import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const appName = 'codex-account-switcher'
const releaseBranch = 'main'

const versionFiles = {
  packageJson: 'package.json',
  packageLock: 'package-lock.json',
  tauriConfig: 'src-tauri/tauri.conf.json',
  cargoToml: 'src-tauri/Cargo.toml',
  cargoLock: 'src-tauri/Cargo.lock',
}

function run(command, args, options = {}) {
  // 发布脚本需要可审计的 git/npm/cargo 调用，这里统一打印命令并禁用 shell 展开。
  console.log(`$ ${command} ${args.join(' ')}`)
  return execFileSync(command, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: options.stdio ?? ['ignore', 'pipe', 'inherit'],
  })
}

function readJson(file) {
  return JSON.parse(readFileSync(resolve(file), 'utf8'))
}

function writeJson(file, data) {
  // 保持仓库现有的 2 空格 JSON 风格，避免发版时产生无关格式变更。
  writeFileSync(resolve(file), `${JSON.stringify(data, null, 2)}\n`)
}

function normalizeVersion(input) {
  const rawVersion = input?.trim().replace(/^v/, '')
  if (!rawVersion || !/^\d+\.\d+\.\d+$/.test(rawVersion)) {
    throw new Error('版本格式必须是 x.y.z，例如 0.1.4 或 v0.1.4。')
  }

  return rawVersion
}

function parseVersion(version) {
  return normalizeVersion(version).split('.').map((part) => Number(part))
}

function compareVersions(left, right) {
  const leftParts = parseVersion(left)
  const rightParts = parseVersion(right)

  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] - rightParts[index]
    }
  }

  return 0
}

function incrementPatch(version) {
  const [major, minor, patch] = parseVersion(version)
  return `${major}.${minor}.${patch + 1}`
}

function getRemoteVersions() {
  run('git', ['fetch', 'origin', releaseBranch, '--tags'], { stdio: 'inherit' })
  const output = run('git', ['ls-remote', '--tags', 'origin', 'refs/tags/v*'])

  return output
    .split('\n')
    .map((line) => line.match(/refs\/tags\/v(\d+\.\d+\.\d+)$/)?.[1])
    .filter(Boolean)
    .sort(compareVersions)
}

function getLocalTags() {
  const output = run('git', ['tag', '--list', 'v*'])

  return new Set(
    output
      .split('\n')
      .map((tag) => tag.trim())
      .filter(Boolean),
  )
}

function assertCleanTrackedWorktree() {
  // 只阻止已跟踪文件的未提交修改；未跟踪草稿文件不会被本脚本提交。
  const status = run('git', ['status', '--porcelain', '--untracked-files=no']).trim()
  if (status) {
    throw new Error(`当前存在已跟踪文件未提交，请先处理后再发版：\n${status}`)
  }
}

function assertOnReleaseBranch() {
  const branch = run('git', ['branch', '--show-current']).trim()
  if (branch !== releaseBranch) {
    throw new Error(`发版脚本只能在 ${releaseBranch} 分支执行，当前分支是 ${branch || '(detached)'}。`)
  }

  const localHead = run('git', ['rev-parse', 'HEAD']).trim()
  const remoteHead = run('git', ['rev-parse', `origin/${releaseBranch}`]).trim()
  if (localHead !== remoteHead) {
    throw new Error(`当前 ${releaseBranch} 与 origin/${releaseBranch} 不一致，请先同步后再发版。`)
  }
}

function resolveTargetVersion(remoteVersions, manualVersion) {
  const latestVersion = remoteVersions.at(-1)
  const targetVersion = manualVersion ? normalizeVersion(manualVersion) : incrementPatch(latestVersion ?? '0.0.0')

  if (latestVersion && compareVersions(targetVersion, latestVersion) <= 0) {
    throw new Error(`目标版本 v${targetVersion} 必须大于已发布最高版本 v${latestVersion}。`)
  }

  if (remoteVersions.includes(targetVersion)) {
    throw new Error(`远端已存在 v${targetVersion}，不能重复发布。`)
  }

  if (getLocalTags().has(`v${targetVersion}`)) {
    throw new Error(`本地已存在 v${targetVersion} tag，请先确认是否重复发版。`)
  }

  return targetVersion
}

function updateCargoPackageVersion(content, version) {
  const lines = content.split('\n')
  let inPackageSection = false

  return lines
    .map((line) => {
      if (/^\[package\]\s*$/.test(line)) {
        inPackageSection = true
        return line
      }

      if (/^\[.+\]\s*$/.test(line)) {
        inPackageSection = false
      }

      if (inPackageSection && /^version = "/.test(line)) {
        return `version = "${version}"`
      }

      return line
    })
    .join('\n')
}

function updateCargoLockAppVersion(content, version) {
  const blocks = content.split('\n\n')

  return blocks
    .map((block) => {
      if (block.includes('[[package]]') && block.includes(`name = "${appName}"`)) {
        // Cargo.lock 中只更新当前应用包，避免误改依赖库里相同的版本号。
        return block.replace(/^version = ".*"$/m, `version = "${version}"`)
      }

      return block
    })
    .join('\n\n')
}

function updateVersionFiles(version) {
  const packageJson = readJson(versionFiles.packageJson)
  packageJson.version = version
  writeJson(versionFiles.packageJson, packageJson)

  const packageLock = readJson(versionFiles.packageLock)
  packageLock.version = version
  if (packageLock.packages?.['']) {
    packageLock.packages[''].version = version
  }
  writeJson(versionFiles.packageLock, packageLock)

  const tauriConfig = readJson(versionFiles.tauriConfig)
  tauriConfig.version = version
  writeJson(versionFiles.tauriConfig, tauriConfig)

  const cargoToml = readFileSync(resolve(versionFiles.cargoToml), 'utf8')
  writeFileSync(resolve(versionFiles.cargoToml), updateCargoPackageVersion(cargoToml, version))

  const cargoLock = readFileSync(resolve(versionFiles.cargoLock), 'utf8')
  writeFileSync(resolve(versionFiles.cargoLock), updateCargoLockAppVersion(cargoLock, version))
}

function runChecks() {
  // tag 推送会触发线上构建，这里先做本地基础检查，避免明显失败的版本进入 Release。
  run('npm', ['run', 'lint'], { stdio: 'inherit' })
  run('npm', ['run', 'build'], { stdio: 'inherit' })
  run('cargo', ['check', '--manifest-path', 'src-tauri/Cargo.toml'], { stdio: 'inherit' })
}

function commitAndPush(version) {
  const files = Object.values(versionFiles)
  run('git', ['add', ...files], { stdio: 'inherit' })
  run('git', ['commit', '-m', `Release v${version}`], { stdio: 'inherit' })
  run('git', ['push', 'origin', releaseBranch], { stdio: 'inherit' })
  run('git', ['tag', `v${version}`], { stdio: 'inherit' })
  run('git', ['push', 'origin', `v${version}`], { stdio: 'inherit' })
}

function printUsage() {
  console.log(`
Usage:
  npm run deploy
  npm run deploy -- 0.1.4
  npm run deploy -- v0.1.4

说明:
  不传版本时，会基于远端 origin 的最大 v* tag 自动递增 patch 版本。
  传入版本时，版本必须大于远端已发布最高版本，且不能和远端或本地 tag 重复。
`)
}

function main() {
  const manualVersion = process.argv[2]

  if (manualVersion === '--help' || manualVersion === '-h') {
    printUsage()
    return
  }

  assertCleanTrackedWorktree()
  const remoteVersions = getRemoteVersions()
  assertOnReleaseBranch()

  const targetVersion = resolveTargetVersion(remoteVersions, manualVersion)
  console.log(`准备发布 v${targetVersion}`)

  updateVersionFiles(targetVersion)
  runChecks()
  commitAndPush(targetVersion)

  console.log(`发布完成：v${targetVersion}`)
}

main()
