import { invoke } from '@tauri-apps/api/core'

export type ProfileType = 'chatgpt' | 'proxy'

export type Profile = {
  id: string
  name: string
  notes: string
  profile_type: ProfileType
  source: string
  last_synced_at: string
}

export type AppStatePayload = {
  profiles: Profile[]
  active_profile_id: string | null
  codex_home: string
  profiles_home: string
  // 这里展示的是当前运行安装包版本，不等同于源码 package.json 的开发版本。
  app_version: string
}

export type ActionResult = {
  state: AppStatePayload
  message: string
  desktop_sync: DesktopSyncStatus | null
}

export type DesktopSyncStatus = {
  codex_relaunched: boolean
  vscode_reloaded: boolean
  notes: string[]
}

export type AppUpdateStatus = {
  status: 'up_to_date' | 'available' | 'installed'
  message: string
  current_version: string
  next_version: string | null
}

export type ImportCurrentPayload = {
  name: string
  notes: string
}

export type CreateProxyPayload = {
  name: string
  notes: string
  providerName: string
  baseUrl: string
  apiKey: string
  model: string
  reasoningEffort: string
  personality: string
  serviceTier: string
}

export type UpdateProfilePayload = {
  profileId: string
  name: string
  notes: string
}

export const isTauriRuntime = () =>
  typeof window !== 'undefined' &&
  ('__TAURI_INTERNALS__' in window || '__TAURI_METADATA__' in window)

const ensureTauri = () => {
  if (!isTauriRuntime()) {
    throw new Error('当前不是 Tauri 桌面环境，暂时无法执行本地配置同步。')
  }
}

export const loadState = async () => {
  ensureTauri()
  return invoke<AppStatePayload>('load_state')
}

export const importCurrentProfile = async (payload: ImportCurrentPayload) => {
  ensureTauri()
  // 这里直接交给后端读取 ~/.codex，前端只负责收集名称与备注。
  return invoke<ActionResult>('import_current_profile', { payload })
}

export const createProxyProfile = async (payload: CreateProxyPayload) => {
  ensureTauri()
  return invoke<ActionResult>('create_proxy_profile', {
    payload: {
      name: payload.name,
      notes: payload.notes,
      provider_name: payload.providerName,
      base_url: payload.baseUrl,
      api_key: payload.apiKey,
      model: payload.model,
      reasoning_effort: payload.reasoningEffort,
      personality: payload.personality,
      service_tier: payload.serviceTier,
    },
  })
}

export const switchProfile = async (profileId: string) => {
  ensureTauri()
  return invoke<ActionResult>('switch_profile', { profileId })
}

export const resyncActiveProfile = async (profileId: string) => {
  ensureTauri()
  // 这个动作只允许针对当前激活账号，避免把 live token 写错到别的 Profile。
  return invoke<ActionResult>('resync_active_profile', { profileId })
}

export const updateProfile = async (payload: UpdateProfilePayload) => {
  ensureTauri()
  return invoke<ActionResult>('update_profile', {
    payload: {
      profile_id: payload.profileId,
      name: payload.name,
      notes: payload.notes,
    },
  })
}

export const deleteProfile = async (profileId: string) => {
  ensureTauri()
  return invoke<ActionResult>('delete_profile', {
    payload: {
      profile_id: profileId,
    },
  })
}

export const syncDesktopClients = async () => {
  ensureTauri()
  return invoke<ActionResult>('sync_desktop_clients')
}

export const checkAppUpdate = async () => {
  ensureTauri()
  // 更新包由后端 updater 插件校验签名并安装，前端只负责触发和展示结果。
  return invoke<AppUpdateStatus>('check_app_update')
}

export const checkAppUpdateAvailable = async () => {
  ensureTauri()
  // 启动自动检查只读取 Release manifest，不下载也不安装。
  return invoke<AppUpdateStatus>('check_app_update_available')
}
