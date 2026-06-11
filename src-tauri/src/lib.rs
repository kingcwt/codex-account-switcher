use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager,
};
use tauri_plugin_positioner::{Position, WindowExt};
use tauri_plugin_updater::UpdaterExt;

const STATE_UPDATED_EVENT: &str = "account-switcher://state-updated";
const TRAY_ID: &str = "codex-account-switcher";
const TRAY_ITEM_OPEN_WINDOW: &str = "open-account-switcher-window";
const TRAY_ITEM_QUIT: &str = "quit";
const TRAY_ITEM_EMPTY: &str = "empty-profiles";

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
struct ProfileSummary {
    id: String,
    name: String,
    notes: String,
    profile_type: String,
    source: String,
    last_synced_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct AppStatePayload {
    profiles: Vec<ProfileSummary>,
    active_profile_id: Option<String>,
    codex_home: String,
    profiles_home: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct ActionResult {
    state: AppStatePayload,
    message: String,
    desktop_sync: Option<DesktopSyncStatus>,
}

#[derive(Debug, Serialize, Deserialize)]
struct ImportCurrentPayload {
    name: String,
    notes: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct CreateProxyPayload {
    name: String,
    notes: String,
    provider_name: String,
    base_url: String,
    api_key: String,
    model: String,
    reasoning_effort: String,
    personality: String,
    service_tier: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct UpdateProfilePayload {
    profile_id: String,
    name: String,
    notes: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct DeleteProfilePayload {
    profile_id: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct ActiveProfileFile {
    active_profile_id: String,
    last_switched_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct DesktopSyncStatus {
    codex_relaunched: bool,
    vscode_reloaded: bool,
    notes: Vec<String>,
}

#[derive(Debug, Serialize)]
struct AppUpdateStatus {
    status: String,
    message: String,
    current_version: String,
    next_version: Option<String>,
}

#[cfg(unix)]
fn tighten_permissions(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|error| format!("无法更新文件权限 {}: {}", path.display(), error))
}

#[cfg(not(unix))]
fn tighten_permissions(_path: &Path) -> Result<(), String> {
    Ok(())
}

fn current_timestamp() -> String {
    Utc::now().to_rfc3339()
}

fn home_dir() -> Result<PathBuf, String> {
    env::var("HOME")
        .map(PathBuf::from)
        .map_err(|_| "无法读取 HOME 环境变量".to_string())
}

fn codex_home_dir() -> Result<PathBuf, String> {
    if let Ok(value) = env::var("CODEX_HOME") {
        if !value.trim().is_empty() {
            return Ok(PathBuf::from(value));
        }
    }

    Ok(home_dir()?.join(".codex"))
}

fn account_switcher_home_dir() -> Result<PathBuf, String> {
    // 保留旧数据目录，避免应用改名后现有 Profile 和备份不可见。
    Ok(home_dir()?.join(".codex-switchboard"))
}

fn profiles_dir() -> Result<PathBuf, String> {
    Ok(account_switcher_home_dir()?.join("profiles"))
}

fn active_profile_file() -> Result<PathBuf, String> {
    Ok(account_switcher_home_dir()?.join("active-profile.json"))
}

fn vscode_refresh_signal_file() -> Result<PathBuf, String> {
    // 每个 VS Code 窗口里的 bridge 都监听同一个信号文件，用一次写入广播扩展宿主刷新请求。
    Ok(account_switcher_home_dir()?.join("vscode-refresh.signal"))
}

fn backup_dir() -> Result<PathBuf, String> {
    Ok(account_switcher_home_dir()?.join("backup").join("last-known-good"))
}

fn ensure_account_switcher_dirs() -> Result<(), String> {
    let profiles = profiles_dir()?;
    let backup = backup_dir()?;

    fs::create_dir_all(&profiles).map_err(|error| format!("无法创建 profiles 目录: {}", error))?;
    fs::create_dir_all(&backup).map_err(|error| format!("无法创建 backup 目录: {}", error))?;

    Ok(())
}

fn profile_dir(profile_id: &str) -> Result<PathBuf, String> {
    Ok(profiles_dir()?.join(profile_id))
}

fn profile_meta_path(profile_id: &str) -> Result<PathBuf, String> {
    Ok(profile_dir(profile_id)?.join("meta.json"))
}

fn profile_config_path(profile_id: &str) -> Result<PathBuf, String> {
    Ok(profile_dir(profile_id)?.join("config.toml"))
}

fn profile_auth_path(profile_id: &str) -> Result<PathBuf, String> {
    Ok(profile_dir(profile_id)?.join("auth.json"))
}

fn codex_config_path() -> Result<PathBuf, String> {
    Ok(codex_home_dir()?.join("config.toml"))
}

fn codex_auth_path() -> Result<PathBuf, String> {
    Ok(codex_home_dir()?.join("auth.json"))
}

fn write_text_file(path: &Path, contents: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("无法创建目录 {}: {}", parent.display(), error))?;
    }

    fs::write(path, contents).map_err(|error| format!("无法写入文件 {}: {}", path.display(), error))?;
    tighten_permissions(path)?;
    Ok(())
}

fn write_json_file<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let serialized =
        serde_json::to_string_pretty(value).map_err(|error| format!("无法序列化 JSON: {}", error))?;
    write_text_file(path, &serialized)
}

fn read_text_file(path: &Path) -> Result<String, String> {
    fs::read_to_string(path).map_err(|error| format!("无法读取文件 {}: {}", path.display(), error))
}

fn detect_profile_type(auth_contents: &str) -> String {
    let parsed = serde_json::from_str::<Value>(auth_contents);

    match parsed {
        Ok(value) if value.get("tokens").is_some() || value.get("auth_mode").is_some() => {
            "chatgpt".to_string()
        }
        Ok(value) if value.get("OPENAI_API_KEY").is_some() => "proxy".to_string(),
        _ => "chatgpt".to_string(),
    }
}

fn make_profile_id(name: &str) -> String {
    let slug = name
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() {
                ch.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>()
        .split('-')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>()
        .join("-");

    let fallback = if slug.is_empty() { "profile" } else { &slug };
    format!("{}-{}", fallback, Utc::now().timestamp_millis())
}

fn save_profile_snapshot(
    profile_id: &str,
    summary: &ProfileSummary,
    config_contents: &str,
    auth_contents: &str,
) -> Result<(), String> {
    let dir = profile_dir(profile_id)?;
    fs::create_dir_all(&dir)
        .map_err(|error| format!("无法创建 Profile 目录 {}: {}", dir.display(), error))?;

    write_json_file(&profile_meta_path(profile_id)?, summary)?;
    write_text_file(&profile_config_path(profile_id)?, config_contents)?;
    write_text_file(&profile_auth_path(profile_id)?, auth_contents)?;
    Ok(())
}

fn read_profile_summary(path: &Path) -> Result<ProfileSummary, String> {
    let raw = read_text_file(path)?;
    serde_json::from_str(&raw).map_err(|error| format!("无法解析 Profile 元信息 {}: {}", path.display(), error))
}

fn load_profiles() -> Result<Vec<ProfileSummary>, String> {
    ensure_account_switcher_dirs()?;

    let mut profiles = Vec::new();
    let entries = fs::read_dir(profiles_dir()?).map_err(|error| format!("无法读取 profiles 目录: {}", error))?;

    for entry in entries {
        let entry = entry.map_err(|error| format!("无法读取 profile 条目: {}", error))?;
        if !entry
            .file_type()
            .map_err(|error| format!("无法读取 profile 文件类型: {}", error))?
            .is_dir()
        {
            continue;
        }

        let meta_path = entry.path().join("meta.json");
        if meta_path.exists() {
            profiles.push(read_profile_summary(&meta_path)?);
        }
    }

    profiles.sort_by(|left, right| right.last_synced_at.cmp(&left.last_synced_at));
    Ok(profiles)
}

fn read_active_profile_id() -> Result<Option<String>, String> {
    let path = active_profile_file()?;
    if !path.exists() {
        return Ok(None);
    }

    let raw = read_text_file(&path)?;
    let active: ActiveProfileFile =
        serde_json::from_str(&raw).map_err(|error| format!("无法解析 active-profile.json: {}", error))?;

    Ok(Some(active.active_profile_id))
}

fn set_active_profile_id(profile_id: &str) -> Result<(), String> {
    let active = ActiveProfileFile {
        active_profile_id: profile_id.to_string(),
        last_switched_at: current_timestamp(),
    };

    write_json_file(&active_profile_file()?, &active)
}

fn clear_active_profile_id() -> Result<(), String> {
    let path = active_profile_file()?;
    if path.exists() {
        fs::remove_file(&path)
            .map_err(|error| format!("无法删除当前激活状态文件 {}: {}", path.display(), error))?;
    }

    Ok(())
}

fn load_state_payload() -> Result<AppStatePayload, String> {
    let profiles = load_profiles()?;
    let active_profile_id = read_active_profile_id()?;

    Ok(AppStatePayload {
        profiles,
        active_profile_id,
        codex_home: codex_home_dir()?.display().to_string(),
        profiles_home: profiles_dir()?.display().to_string(),
    })
}

fn current_codex_snapshot() -> Result<(String, String), String> {
    let config_contents = read_text_file(&codex_config_path()?)?;
    let auth_contents = read_text_file(&codex_auth_path()?)?;
    Ok((config_contents, auth_contents))
}

fn backup_current_codex_snapshot() -> Result<(), String> {
    let backup = backup_dir()?;
    fs::create_dir_all(&backup).map_err(|error| format!("无法创建回滚目录 {}: {}", backup.display(), error))?;

    if let Ok(config_contents) = read_text_file(&codex_config_path()?) {
        // 每次覆盖 ~/.codex 前先留一份最后已知可用快照，方便后续回滚。
        write_text_file(&backup.join("config.toml"), &config_contents)?;
    }

    if let Ok(auth_contents) = read_text_file(&codex_auth_path()?) {
        write_text_file(&backup.join("auth.json"), &auth_contents)?;
    }

    Ok(())
}

fn sync_current_back_to_profile(profile_id: &str) -> Result<(), String> {
    let meta_path = profile_meta_path(profile_id)?;
    if !meta_path.exists() {
        return Ok(());
    }

    let mut summary = read_profile_summary(&meta_path)?;
    let (config_contents, auth_contents) = current_codex_snapshot()?;

    // 官方登录 token 会在运行过程中自动刷新，切换前先把最新快照写回原 Profile。
    summary.last_synced_at = current_timestamp();
    save_profile_snapshot(profile_id, &summary, &config_contents, &auth_contents)
}

fn write_snapshot_to_codex(profile_id: &str) -> Result<(), String> {
    let config_contents = read_text_file(&profile_config_path(profile_id)?)?;
    let auth_contents = read_text_file(&profile_auth_path(profile_id)?)?;

    // 切换动作的本质是覆盖 ~/.codex 里的当前生效文件，让 App / CLI / VS Code 下一次读取到它。
    backup_current_codex_snapshot()?;
    write_text_file(&codex_config_path()?, &config_contents)?;
    write_text_file(&codex_auth_path()?, &auth_contents)?;
    Ok(())
}

fn proxy_config_from_payload(payload: &CreateProxyPayload) -> String {
    format!(
        "# 由 Codex Account Switcher 生成的代理 Profile。\ncli_auth_credentials_store = \"file\"\nmodel_provider = \"{provider_name}\"\n\n[model_providers.{provider_name}]\nname = \"{provider_name}\"\nbase_url = \"{base_url}\"\nwire_api = \"responses\"\nrequires_openai_auth = true\n\nmodel = \"{model}\"\nmodel_reasoning_effort = \"{reasoning_effort}\"\npersonality = \"{personality}\"\nservice_tier = \"{service_tier}\"\n",
        provider_name = payload.provider_name.trim(),
        base_url = payload.base_url.trim(),
        model = payload.model.trim(),
        reasoning_effort = payload.reasoning_effort.trim(),
        personality = payload.personality.trim(),
        service_tier = payload.service_tier.trim()
    )
}

fn run_command(program: &str, args: &[&str]) -> Result<(), String> {
    let output = Command::new(program)
        .args(args)
        .output()
        .map_err(|error| format!("执行命令失败 {}: {}", program, error))?;

    if output.status.success() {
        Ok(())
    } else {
        // macOS 自动化命令失败时，stderr/stdout 里通常包含真正的权限或启动原因。
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let details = if !stderr.is_empty() {
            format!("，stderr: {}", stderr)
        } else if !stdout.is_empty() {
            format!("，stdout: {}", stdout)
        } else {
            String::new()
        };

        Err(format!(
            "命令执行失败 {}，退出码: {:?}{}",
            program,
            output.status.code(),
            details
        ))
    }
}

fn run_osascript(script: &str) -> Result<(), String> {
    run_command("osascript", &["-e", script])
}

fn restart_codex_app() -> Result<(), String> {
    // 切换后主动重启 Codex，让它重新读取 ~/.codex 里的最新身份。
    let _ = run_osascript("tell application \"Codex\" to quit");
    // bundle id 比显示名称更稳定，失败时再交给 LaunchServices 按应用名查找。
    match run_command("open", &["-b", "com.openai.codex"]) {
        Ok(_) => Ok(()),
        Err(bundle_error) => run_command("open", &["-a", "Codex"]).map_err(|name_error| {
            format!(
                "bundle id 启动失败：{}；按名称启动失败：{}",
                bundle_error, name_error
            )
        }),
    }
}

fn restart_vscode_extension_hosts() -> Result<(), String> {
    // bridge 在所有已打开窗口中监听此文件，并分别重启当前窗口的扩展宿主，不重载 VS Code 窗口。
    write_text_file(&vscode_refresh_signal_file()?, &current_timestamp())
}

fn sync_desktop_apps() -> DesktopSyncStatus {
    let mut status = DesktopSyncStatus {
        codex_relaunched: false,
        vscode_reloaded: false,
        notes: Vec::new(),
    };

    match restart_codex_app() {
        Ok(_) => {
            status.codex_relaunched = true;
            status.notes.push("Codex 已尝试重启".to_string());
        }
        Err(error) => {
            status.notes.push(format!("Codex 重启失败：{}", error));
        }
    }

    match restart_vscode_extension_hosts() {
        Ok(_) => {
            status.vscode_reloaded = true;
            status.notes.push("已通知所有 VS Code 窗口刷新插件".to_string());
        }
        Err(error) => {
            status.notes.push(format!("VS Code 插件刷新信号写入失败：{}", error));
        }
    }

    status
}

fn emit_state_update(app: &AppHandle, state: &AppStatePayload) {
    let _ = app.emit(STATE_UPDATED_EVENT, state);
}

fn build_tray_menu(app: &AppHandle) -> Result<tauri::menu::Menu<tauri::Wry>, tauri::Error> {
    let profiles = load_profiles().unwrap_or_default();
    let active_profile_id = read_active_profile_id().ok().flatten();
    let mut profile_items = Vec::new();

    if profiles.is_empty() {
        profile_items.push(MenuItemBuilder::with_id(TRAY_ITEM_EMPTY, "暂无账号")
            .enabled(false)
            .build(app)?);
    } else {
        for profile in profiles {
            let label = if active_profile_id.as_deref() == Some(profile.id.as_str()) {
                format!("✓ {}", profile.name)
            } else {
                profile.name
            };

            profile_items.push(
                MenuItemBuilder::with_id(format!("profile::{}", profile.id), label).build(app)?,
            );
        }
    }

    let open_window_item = MenuItemBuilder::with_id(TRAY_ITEM_OPEN_WINDOW, "打开账号切换器").build(app)?;
    let quit_item = MenuItemBuilder::with_id(TRAY_ITEM_QUIT, "退出").build(app)?;

    let mut builder = MenuBuilder::new(app);
    for item in &profile_items {
        builder = builder.item(item);
    }

    builder.item(&open_window_item).separator().item(&quit_item).build()
}

fn refresh_tray_menu(app: &AppHandle) -> Result<(), tauri::Error> {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let menu = build_tray_menu(app)?;
        tray.set_menu(Some(menu))?;
    }

    Ok(())
}

fn activate_profile(profile_id: &str) -> Result<ActionResult, String> {
    ensure_account_switcher_dirs()?;

    let target_meta_path = profile_meta_path(profile_id)?;
    if !target_meta_path.exists() {
        return Err("目标 Profile 不存在".to_string());
    }

    let current_active = read_active_profile_id()?;
    if let Some(active_profile_id) = current_active.as_ref() {
        if active_profile_id != profile_id {
            sync_current_back_to_profile(active_profile_id)?;
        }
    }

    let summary = read_profile_summary(&target_meta_path)?;
    let is_reapplying_active = current_active.as_deref() == Some(profile_id);
    write_snapshot_to_codex(profile_id)?;
    set_active_profile_id(profile_id)?;

    let desktop_sync = sync_desktop_apps();
    // 同一 Profile 的再次应用是从快照覆盖 ~/.codex，不是一次账号切换。
    let message = if is_reapplying_active {
        format!(
            "已将“{}”的快照重新应用到当前 Codex。{}",
            summary.name,
            desktop_sync.notes.join("；")
        )
    } else {
        format!(
            "已切换到“{}”。{}",
            summary.name,
            desktop_sync.notes.join("；")
        )
    };

    Ok(ActionResult {
        state: load_state_payload()?,
        message,
        desktop_sync: Some(desktop_sync),
    })
}

#[tauri::command]
fn load_state() -> Result<AppStatePayload, String> {
    load_state_payload()
}

#[tauri::command]
fn import_current_profile(app: AppHandle, payload: ImportCurrentPayload) -> Result<ActionResult, String> {
    ensure_account_switcher_dirs()?;

    let name = payload.name.trim();
    if name.is_empty() {
        return Err("请输入 Profile 名称".to_string());
    }

    let (config_contents, auth_contents) = current_codex_snapshot()?;
    let profile_id = make_profile_id(name);
    let summary = ProfileSummary {
        id: profile_id.clone(),
        name: name.to_string(),
        notes: if payload.notes.trim().is_empty() {
            "从当前 Codex 配置导入".to_string()
        } else {
            payload.notes.trim().to_string()
        },
        profile_type: detect_profile_type(&auth_contents),
        source: "~/.codex".to_string(),
        last_synced_at: current_timestamp(),
    };

    save_profile_snapshot(&profile_id, &summary, &config_contents, &auth_contents)?;
    set_active_profile_id(&profile_id)?;

    let result = ActionResult {
        state: load_state_payload()?,
        message: format!("已成功导入“{}”，并设为当前激活账号。", summary.name),
        desktop_sync: None,
    };
    emit_state_update(&app, &result.state);
    let _ = refresh_tray_menu(&app);
    Ok(result)
}

#[tauri::command]
fn create_proxy_profile(app: AppHandle, payload: CreateProxyPayload) -> Result<ActionResult, String> {
    ensure_account_switcher_dirs()?;

    let name = payload.name.trim();
    if name.is_empty() {
        return Err("请输入代理 Profile 名称".to_string());
    }
    if payload.base_url.trim().is_empty() {
        return Err("请输入代理 base_url".to_string());
    }
    if payload.provider_name.trim().is_empty() {
        return Err("请输入 provider 名称".to_string());
    }
    if payload.api_key.trim().is_empty() {
        return Err("请输入代理 API Key".to_string());
    }

    let profile_id = make_profile_id(name);
    let summary = ProfileSummary {
        id: profile_id.clone(),
        name: name.to_string(),
        notes: if payload.notes.trim().is_empty() {
            "通过工具创建的工作代理".to_string()
        } else {
            payload.notes.trim().to_string()
        },
        profile_type: "proxy".to_string(),
        source: payload.base_url.trim().to_string(),
        last_synced_at: current_timestamp(),
    };
    let config_contents = proxy_config_from_payload(&payload);
    let auth_contents = serde_json::to_string_pretty(&json!({
        "OPENAI_API_KEY": payload.api_key.trim()
    }))
    .map_err(|error| format!("无法生成代理 auth.json: {}", error))?;

    save_profile_snapshot(&profile_id, &summary, &config_contents, &auth_contents)?;
    write_snapshot_to_codex(&profile_id)?;
    set_active_profile_id(&profile_id)?;

    let desktop_sync = sync_desktop_apps();
    let message = format!(
        "已成功创建代理配置“{}”，并同步为当前激活账号。{}",
        summary.name,
        desktop_sync.notes.join("；")
    );

    let result = ActionResult {
        state: load_state_payload()?,
        message,
        desktop_sync: Some(desktop_sync),
    };
    emit_state_update(&app, &result.state);
    let _ = refresh_tray_menu(&app);
    Ok(result)
}

#[tauri::command]
fn switch_profile(app: AppHandle, profile_id: String) -> Result<ActionResult, String> {
    let result = activate_profile(&profile_id)?;
    emit_state_update(&app, &result.state);
    let _ = refresh_tray_menu(&app);
    Ok(result)
}

#[tauri::command]
fn resync_active_profile(app: AppHandle, profile_id: String) -> Result<ActionResult, String> {
    ensure_account_switcher_dirs()?;

    let active_profile_id = read_active_profile_id()?
        .ok_or_else(|| "当前没有激活的 Profile，无法重新同步".to_string())?;
    if active_profile_id != profile_id {
        return Err("只允许重新同步当前激活的 Profile，避免把错误状态写回其他账号".to_string());
    }

    sync_current_back_to_profile(&profile_id)?;
    let summary = read_profile_summary(&profile_meta_path(&profile_id)?)?;

    let result = ActionResult {
        state: load_state_payload()?,
        message: format!("已将当前 Codex 最新状态重新保存到“{}”。", summary.name),
        desktop_sync: None,
    };
    emit_state_update(&app, &result.state);
    let _ = refresh_tray_menu(&app);
    Ok(result)
}

#[tauri::command]
fn update_profile(app: AppHandle, payload: UpdateProfilePayload) -> Result<ActionResult, String> {
    ensure_account_switcher_dirs()?;

    let mut summary = read_profile_summary(&profile_meta_path(&payload.profile_id)?)?;
    let name = payload.name.trim();
    if name.is_empty() {
        return Err("请输入 Profile 名称".to_string());
    }

    summary.name = name.to_string();
    summary.notes = payload.notes.trim().to_string();
    summary.last_synced_at = current_timestamp();

    let config_contents = read_text_file(&profile_config_path(&payload.profile_id)?)?;
    let auth_contents = read_text_file(&profile_auth_path(&payload.profile_id)?)?;
    save_profile_snapshot(&payload.profile_id, &summary, &config_contents, &auth_contents)?;

    let result = ActionResult {
        state: load_state_payload()?,
        message: format!("已更新“{}”的名称与备注。", summary.name),
        desktop_sync: None,
    };
    emit_state_update(&app, &result.state);
    let _ = refresh_tray_menu(&app);
    Ok(result)
}

#[tauri::command]
fn delete_profile(app: AppHandle, payload: DeleteProfilePayload) -> Result<ActionResult, String> {
    ensure_account_switcher_dirs()?;

    let meta_path = profile_meta_path(&payload.profile_id)?;
    let summary = read_profile_summary(&meta_path)?;
    let profile_path = profile_dir(&payload.profile_id)?;
    if profile_path.exists() {
        fs::remove_dir_all(&profile_path)
            .map_err(|error| format!("无法删除 Profile 目录 {}: {}", profile_path.display(), error))?;
    }

    if read_active_profile_id()?.as_deref() == Some(payload.profile_id.as_str()) {
        // 删除当前激活项时只清除工具内部指针，不擅自改写 ~/.codex，避免误切换到其他账号。
        clear_active_profile_id()?;
    }

    let result = ActionResult {
        state: load_state_payload()?,
        message: format!("已删除“{}”。", summary.name),
        desktop_sync: None,
    };
    emit_state_update(&app, &result.state);
    let _ = refresh_tray_menu(&app);
    Ok(result)
}

#[tauri::command]
fn sync_desktop_clients(app: AppHandle) -> Result<ActionResult, String> {
    ensure_account_switcher_dirs()?;

    let desktop_sync = sync_desktop_apps();
    let result = ActionResult {
        state: load_state_payload()?,
        message: desktop_sync.notes.join("；"),
        desktop_sync: Some(desktop_sync),
    };
    emit_state_update(&app, &result.state);
    Ok(result)
}

#[tauri::command]
async fn check_app_update_available(app: AppHandle) -> Result<AppUpdateStatus, String> {
    // 启动时只探测 Release manifest，不下载也不安装，避免用户无感知替换应用。
    let updater = app
        .updater()
        .map_err(|error| format!("无法初始化更新检查: {}", error))?;

    let update = updater
        .check()
        .await
        .map_err(|error| format!("检查更新失败: {}", error))?;

    let Some(update) = update else {
        return Ok(AppUpdateStatus {
            status: "up_to_date".to_string(),
            message: "当前已是最新版本。".to_string(),
            current_version: app.package_info().version.to_string(),
            next_version: None,
        });
    };

    Ok(AppUpdateStatus {
        status: "available".to_string(),
        message: format!("发现新版本 {}。", update.version),
        current_version: update.current_version,
        next_version: Some(update.version),
    })
}

#[tauri::command]
async fn check_app_update(app: AppHandle) -> Result<AppUpdateStatus, String> {
    // 更新包由 GitHub Release 托管并通过 Tauri 签名校验，前端只触发流程不接触下载地址。
    let updater = app
        .updater()
        .map_err(|error| format!("无法初始化更新检查: {}", error))?;

    let update = updater
        .check()
        .await
        .map_err(|error| format!("检查更新失败: {}", error))?;

    let Some(update) = update else {
        return Ok(AppUpdateStatus {
            status: "up_to_date".to_string(),
            message: "当前已是最新版本。".to_string(),
            current_version: app.package_info().version.to_string(),
            next_version: None,
        });
    };

    let current_version = update.current_version.clone();
    let next_version = update.version.clone();
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|error| format!("下载或安装更新失败: {}", error))?;

    Ok(AppUpdateStatus {
        status: "installed".to_string(),
        message: format!("已安装 {}，重启应用后生效。", next_version),
        current_version,
        next_version: Some(next_version),
    })
}

fn toggle_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if matches!(window.is_visible(), Ok(true)) {
            let _ = window.hide();
            return;
        }

        let _ = window.move_window(Position::TrayCenter);
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn build_tray(app: &AppHandle) -> Result<(), tauri::Error> {
    let Some(icon) = app.default_window_icon().cloned() else {
        // 开发态如果图标还没生成，先跳过 tray，避免整个应用因为入口资源缺失直接失败。
        return Ok(());
    };
    let menu = build_tray_menu(app)?;

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            TRAY_ITEM_OPEN_WINDOW => toggle_main_window(app),
            TRAY_ITEM_QUIT => app.exit(0),
            id if id.starts_with("profile::") => {
                let profile_id = id.trim_start_matches("profile::");
                if let Ok(result) = activate_profile(profile_id) {
                    emit_state_update(app, &result.state);
                    let _ = refresh_tray_menu(app);
                }
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let _ = refresh_tray_menu(&tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_positioner::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            ensure_account_switcher_dirs()
                .map_err(|error| -> Box<dyn std::error::Error> { error.into() })?;

            build_tray(&app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_state,
            import_current_profile,
            create_proxy_profile,
            switch_profile,
            resync_active_profile,
            update_profile,
            delete_profile,
            sync_desktop_clients,
            check_app_update_available,
            check_app_update
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
