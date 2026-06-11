import {
	AlertCircle,
	CheckCircle2,
	Download,
	FolderCog,
	Import,
	LaptopMinimalCheck,
	LoaderCircle,
	PencilLine,
	RotateCcw,
	ShieldCheck,
	Sparkles,
	Trash2,
	WandSparkles,
	X
} from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useMemo, useState, type MouseEvent } from "react";
import appIconUrl from "../src-tauri/icons/128x128@2x.png";
import {
	type ActionResult,
	type AppUpdateStatus,
	type AppStatePayload,
	checkAppUpdate,
	checkAppUpdateAvailable,
	deleteProfile,
	importCurrentProfile,
	isTauriRuntime,
	loadState,
	resyncActiveProfile,
	switchProfile,
	syncDesktopClients,
	updateProfile
} from "./lib/account-switcher";

type ComposerMode = "current" | "edit";

const EMPTY_PROFILES: AppStatePayload["profiles"] = [];
const WINDOW_DRAG_BLOCK_SELECTOR =
	'button, a, input, textarea, select, label, summary, [role="button"], [contenteditable="true"], [data-no-window-drag]';

const padDatePart = (value: number) => String(value).padStart(2, "0");

const formatProfileTimestamp = (timestamp: string) => {
	const date = new Date(timestamp);

	if (Number.isNaN(date.getTime())) {
		// 历史 Profile 可能存在非标准时间字符串，解析失败时保留原值避免误导用户。
		return timestamp;
	}

	// 后端保存 UTC ISO 字符串，列表展示时按用户本机时区转成固定可读格式。
	return `${date.getFullYear()}-${padDatePart(date.getMonth() + 1)}-${padDatePart(date.getDate())} ${padDatePart(date.getHours())}:${padDatePart(date.getMinutes())}:${padDatePart(date.getSeconds())}`;
};

const getProfileInitial = (name: string) => {
	// 账号头像只作为列表视觉锚点，优先使用用户自定义名称的首字。
	const initial = name.trim().slice(0, 1);
	return initial || "C";
};

function App() {
	const [appState, setAppState] = useState<AppStatePayload | null>(null);
	const [showComposer, setShowComposer] = useState(false);
	const [mode, setMode] = useState<ComposerMode>("current");
	const [profileName, setProfileName] = useState("");
	const [profileNotes, setProfileNotes] = useState("");
	const [successTitle, setSuccessTitle] = useState("同步成功");
	const [successMessage, setSuccessMessage] = useState<string | null>(null);
	const [errorMessage, setErrorMessage] = useState<string | null>(null);
	const [appUpdate, setAppUpdate] = useState<AppUpdateStatus | null>(null);
	const [desktopSync, setDesktopSync] =
		useState<ActionResult["desktop_sync"]>(null);
	const [editingProfileId, setEditingProfileId] = useState<string | null>(
		null
	);
	const [isLoading, setIsLoading] = useState(true);
	const [isSubmitting, setIsSubmitting] = useState(false);

	const profiles = appState?.profiles ?? EMPTY_PROFILES;
	const activeProfileId = appState?.active_profile_id ?? null;
	const activeProfile = useMemo(
		() =>
			profiles.find((profile) => profile.id === activeProfileId) ?? null,
		[activeProfileId, profiles]
	);
	const composerTitle = mode === "edit" ? "编辑账号" : "导入当前配置";
	// 配置文件写入成功不代表桌面客户端刷新成功，这里单独标出需要人工处理的自动化失败。
	const desktopSyncFailed =
		desktopSync != null &&
		(!desktopSync.codex_relaunched || !desktopSync.vscode_reloaded);
	const updateButtonLabel =
		appUpdate?.status === "available" && appUpdate.next_version
			? `更新到 ${appUpdate.next_version}`
			: "检查更新";

	useEffect(() => {
		const bootstrap = async () => {
			if (!isTauriRuntime()) {
				setErrorMessage(
					"当前是浏览器预览模式。请通过 Tauri 桌面应用运行后再执行真实配置同步。"
				);
				setIsLoading(false);
				return;
			}

			try {
				const state = await loadState();
				setAppState(state);
				try {
					const updateStatus = await checkAppUpdateAvailable();
					// 启动自动检查只改变按钮状态，不弹成功提示，避免打断账号切换工作流。
					setAppUpdate(updateStatus.status === "available" ? updateStatus : null);
				} catch (updateError) {
					// 更新服务不可用不影响账号切换主流程，保留手动检查入口供用户重试。
					console.warn("自动检查更新失败", updateError);
				}
			} catch (error) {
				setErrorMessage(
					error instanceof Error
						? error.message
						: "加载本地 Profiles 失败"
				);
			} finally {
				setIsLoading(false);
			}
		};

		void bootstrap();

		let unlisten: (() => void) | undefined;
		if (isTauriRuntime()) {
			// 菜单栏切换账号后，主窗口也要立即刷新到同一份状态。
			void listen<AppStatePayload>(
				"account-switcher://state-updated",
				(event) => {
					setAppState(event.payload);
				}
			).then((dispose) => {
				unlisten = dispose;
			});
		}

		return () => {
			unlisten?.();
		};
	}, []);

	const openComposer = (nextMode: ComposerMode) => {
		setMode(nextMode);
		setEditingProfileId(null);
		setProfileName("");
		setProfileNotes("");
		setErrorMessage(null);
		setShowComposer(true);
	};

	const startEditingProfile = (profileId: string) => {
		const target = profiles.find((profile) => profile.id === profileId);
		if (!target) return;

		// 编辑流程先只暴露名称和备注，保持主切换面板足够轻。
		setMode("edit");
		setEditingProfileId(profileId);
		setProfileName(target.name);
		setProfileNotes(target.notes);
		setShowComposer(true);
		setErrorMessage(null);
	};

	const applyActionResult = (result: ActionResult) => {
		// 所有本地文件变更都以后端结果为准，避免前端自己拼状态。
		setAppState(result.state);
		setSuccessTitle("同步成功");
		setSuccessMessage(result.message);
		setErrorMessage(null);
		setDesktopSync(result.desktop_sync);
		setProfileName("");
		setProfileNotes("");
		setEditingProfileId(null);
		setShowComposer(false);
	};

	const handleCreateProfile = async () => {
		if (!profileName.trim()) return;

		setIsSubmitting(true);
		setErrorMessage(null);

		try {
			if (mode === "edit" && editingProfileId) {
				const result = await updateProfile({
					profileId: editingProfileId,
					name: profileName.trim(),
					notes: profileNotes.trim()
				});
				applyActionResult(result);
				return;
			}

			const result = await importCurrentProfile({
				name: profileName.trim(),
				notes: profileNotes.trim()
			});
			applyActionResult(result);
		} catch (error) {
			setErrorMessage(
				error instanceof Error ? error.message : "保存 Profile 失败"
			);
		} finally {
			setIsSubmitting(false);
		}
	};

	const handleSwitchProfile = async (profileId: string) => {
		if (profileId === activeProfileId) return;

		setIsSubmitting(true);
		setErrorMessage(null);

		try {
			const result = await switchProfile(profileId);
			applyActionResult(result);
		} catch (error) {
			setErrorMessage(
				error instanceof Error ? error.message : "切换 Profile 失败"
			);
		} finally {
			setIsSubmitting(false);
		}
	};

	const handleApplyProfile = async (profileId: string) => {
		// 重新应用会把 Account Switcher 中保存的 Profile 快照覆盖写入 ~/.codex。
		setIsSubmitting(true);
		setErrorMessage(null);

		try {
			const result = await switchProfile(profileId);
			applyActionResult(result);
		} catch (error) {
			setErrorMessage(
				error instanceof Error ? error.message : "应用 Profile 配置失败"
			);
		} finally {
			setIsSubmitting(false);
		}
	};

	const handleResyncActiveProfile = async () => {
		if (!activeProfileId) return;

		setIsSubmitting(true);
		setErrorMessage(null);

		try {
			const result = await resyncActiveProfile(activeProfileId);
			applyActionResult(result);
		} catch (error) {
			setErrorMessage(
				error instanceof Error
					? error.message
					: "重新同步当前 Profile 失败"
			);
		} finally {
			setIsSubmitting(false);
		}
	};

	const handleDeleteProfile = async (
		profileId: string,
		profileNameToDelete: string
	) => {
		const confirmed = window.confirm(
			`确认删除“${profileNameToDelete}”吗？此操作会删除工具内部快照。`
		);
		if (!confirmed) return;

		setIsSubmitting(true);
		setErrorMessage(null);

		try {
			const result = await deleteProfile(profileId);
			applyActionResult(result);
		} catch (error) {
			setErrorMessage(
				error instanceof Error ? error.message : "删除 Profile 失败"
			);
		} finally {
			setIsSubmitting(false);
		}
	};

	const handleSyncDesktopClients = async () => {
		setIsSubmitting(true);
		setErrorMessage(null);

		try {
			const result = await syncDesktopClients();
			applyActionResult(result);
		} catch (error) {
			setErrorMessage(
				error instanceof Error ? error.message : "同步桌面应用失败"
			);
		} finally {
			setIsSubmitting(false);
		}
	};

	const handleCheckAppUpdate = async () => {
		setIsSubmitting(true);
		setErrorMessage(null);

		try {
			const result = await checkAppUpdate();
			// 更新安装会替换应用包，业务状态不应被前端顺手改动。
			setSuccessTitle("更新检查完成");
			setSuccessMessage(result.message);
			setAppUpdate(null);
			setDesktopSync(null);
		} catch (error) {
			setErrorMessage(
				error instanceof Error ? error.message : "检查应用更新失败"
			);
		} finally {
			setIsSubmitting(false);
		}
	};

	const handleWindowDragStart = (event: MouseEvent<HTMLElement>) => {
		// 普通内容区按住即可拖动窗口，但保留按钮和输入类控件的原始交互。
		if (event.button !== 0 || !isTauriRuntime()) return;

		const target = event.target;
		if (
			target instanceof HTMLElement &&
			target.closest(WINDOW_DRAG_BLOCK_SELECTOR)
		) {
			return;
		}

		void getCurrentWindow().startDragging();
	};

	return (
		<main className="app-shell" onMouseDownCapture={handleWindowDragStart}>
			{/* 这里直接依赖 macOS 原生 title bar，不再在页面里重复绘制一层假的操作栏。 */}
			<header className="app-header">
				<div className="toolbar">
					<div className="toolbar-left">
						<img
							className="app-mark"
							src={appIconUrl}
							alt=""
							aria-hidden="true"
						/>
						<div className="toolbar-copy">
							<p className="eyebrow">Codex Account Switcher</p>
							<div className="toolbar-title-row">
								<h1>Account Switcher</h1>
								{activeProfile ? (
									<span className="summary-pill">
										当前: {activeProfile.name}
									</span>
								) : null}
							</div>
							<p className="toolbar-subtitle">
								像切换 App Store 账号一样切换 Codex 身份。
							</p>
						</div>
					</div>

					{/* 这块保留弹性空白，窗口拖拽由 app-shell 的原生 startDragging 统一处理。 */}
					<div className="toolbar-drag-fill" />

					<div className="toolbar-controls">
						{/* 路径属于当前运行上下文，固定放在桌面同步操作上方便于随时核对。 */}
						<div className="header-paths">
							<div className="header-path-row">
								<FolderCog size={12} />
								<span>{appState?.codex_home ?? "~/.codex"}</span>
							</div>
							<div className="header-path-row">
								<FolderCog size={12} />
								<span>
									{appState?.profiles_home ??
										"~/.codex-switchboard/profiles"}
								</span>
							</div>
						</div>

						<div className="toolbar-actions">
							{profiles.length > 0 ? (
								<button
									type="button"
									className="ghost-button"
									onClick={() => void handleSyncDesktopClients()}
									disabled={isSubmitting}
								>
									<WandSparkles size={13} />
									同步桌面应用
								</button>
							) : null}
							<button
								type="button"
								className={
									appUpdate?.status === "available"
										? "primary-button"
										: "ghost-button"
								}
								onClick={() => void handleCheckAppUpdate()}
								disabled={isSubmitting}
							>
								{appUpdate?.status === "available" ? (
									<Download size={13} />
								) : (
									<RotateCcw size={13} />
								)}
								{updateButtonLabel}
							</button>
							<button
								type="button"
								className="ghost-button"
								onClick={() => openComposer("current")}
							>
								<Import size={14} />
								导入
							</button>
						</div>
					</div>
				</div>
			</header>

			{/* 顶部 header 和内容框架固定，仅账号列表内部滚动。 */}
			<div className="app-main">
				{successMessage ? (
					<section
						className={`notice-banner ${desktopSyncFailed ? "notice-error" : "notice-success"}`}
						aria-live="polite"
					>
						<div className="status-copy">
							<span className={desktopSyncFailed ? "error-icon" : "status-icon"}>
								{desktopSyncFailed ? (
									<AlertCircle size={16} />
								) : (
									<CheckCircle2 size={16} />
								)}
							</span>
							<div>
								<strong>
									{desktopSyncFailed
										? "同步已写入，刷新失败"
										: successTitle}
								</strong>
								<p>{successMessage}</p>
							</div>
						</div>

						{desktopSync ? (
							<div className="sync-pills">
								<span
									className={`sync-pill ${desktopSync.codex_relaunched ? "" : "sync-pill-muted"}`}
								>
									<LaptopMinimalCheck size={14} />
									{desktopSync.codex_relaunched
										? "Codex App 已同步"
										: "Codex App 需手动确认"}
								</span>
								<span
									className={`sync-pill ${desktopSync.vscode_reloaded ? "" : "sync-pill-muted"}`}
								>
									<ShieldCheck size={14} />
									{desktopSync.vscode_reloaded
										? "VS Code 插件已同步"
										: "VS Code 需手动确认"}
								</span>
							</div>
						) : null}
					</section>
				) : null}

				{errorMessage ? (
					<section
						className="notice-banner notice-error"
						aria-live="polite"
					>
						<div className="status-copy">
							<span className="error-icon">
								<AlertCircle size={16} />
							</span>
							<div>
								<strong>操作未完成</strong>
								<p>{errorMessage}</p>
							</div>
						</div>
					</section>
				) : null}

				<section className="workspace-grid">
					<aside className="sidebar-panel">
						<div className="section-header">
							<div>
								<p className="section-kicker">Profiles</p>
								<h2>账号列表</h2>
							</div>
							<div className="sidebar-header-meta">
								<span className="meta-chip">
									{profiles.length} 个账号
								</span>
								{profiles.length > 0 ? (
									<button
										type="button"
										className="mini-button"
										onClick={() => openComposer("current")}
									>
										<Import size={14} />
										导入
									</button>
								) : null}
							</div>
						</div>

						{/* 账号列表采用 macOS 分组列表形态，避免工具型卡片堆叠造成视觉拥挤。 */}
						{isLoading ? (
							<div className="empty-state compact-empty">
								<div className="empty-ornament">
									<LoaderCircle size={18} className="spin" />
								</div>
								<h3>正在读取本地 Profiles</h3>
								<p>
									工具会加载当前账号列表，并识别当前激活状态。
								</p>
							</div>
						) : profiles.length === 0 ? (
							<div className="empty-state compact-empty">
								<div className="empty-ornament">
									<Sparkles size={18} />
								</div>
								<h3>还没有账号</h3>
								<p>
									点击右上角“导入”，把当前 Codex
									配置保存成一个可切换账号。
								</p>
							</div>
						) : (
							<div className="profile-list">
								{profiles.map((profile) => {
									const isActive =
										profile.id === activeProfileId;

									return (
										<div
											key={profile.id}
											className={`profile-card ${isActive ? "profile-card-active" : ""}`}
										>
											<div
												className="profile-avatar"
												aria-hidden="true"
											>
												{getProfileInitial(profile.name)}
											</div>

											<div className="profile-card-body">
												<div className="profile-card-top">
													<div className="profile-primary">
														<div className="profile-name-row">
															<strong>
																{profile.name}
															</strong>
															{isActive ? (
																<span className="active-chip">
																	当前
																</span>
															) : null}
														</div>
														<p>
															{profile.notes ||
																"未填写备注"}
														</p>
													</div>
												</div>

												<div className="profile-meta-row">
													<span>
														{profile.profile_type ===
														"chatgpt"
															? "官方登录"
															: "工作代理"}
													</span>
													<span>
														{formatProfileTimestamp(
															profile.last_synced_at
														)}
													</span>
												</div>

												<div className="profile-actions">
													{!isActive ? (
														<button
															type="button"
															className="mini-button"
															onClick={() =>
																void handleSwitchProfile(
																	profile.id
																)
															}
															disabled={isSubmitting}
														>
															<Download size={14} />
															切换
														</button>
													) : (
														<>
															<button
																type="button"
																className="mini-button"
																onClick={() =>
																	void handleApplyProfile(
																		profile.id
																	)
																}
																disabled={isSubmitting}
															>
																<Download
																	size={14}
																/>
																应用配置
															</button>
															<button
																type="button"
																className="mini-button"
																onClick={() =>
																	void handleResyncActiveProfile()
																}
																disabled={isSubmitting}
															>
																<RotateCcw
																	size={14}
																/>
																同步快照
															</button>
														</>
													)}

													<button
														type="button"
														className="mini-button"
														onClick={() =>
															startEditingProfile(
																profile.id
															)
														}
														disabled={isSubmitting}
													>
														<PencilLine size={14} />
														编辑
													</button>

													<button
														type="button"
														className="mini-button mini-button-danger"
														onClick={() =>
															void handleDeleteProfile(
																profile.id,
																profile.name
															)
														}
														disabled={isSubmitting}
													>
														<Trash2 size={14} />
														删除
													</button>
												</div>
											</div>
										</div>
									);
								})}
							</div>
							)}

					</aside>
				</section>
			</div>

			{showComposer ? (
				<div
					className="sheet-backdrop"
					role="presentation"
					onClick={() => setShowComposer(false)}
				>
					<section
						className="sheet-panel"
						role="dialog"
						aria-modal="true"
						aria-label={composerTitle}
						onClick={(event) => event.stopPropagation()}
					>
						<div className="sheet-header">
							<div>
								<p className="section-kicker">Import</p>
								<h2>{composerTitle}</h2>
							</div>
							<button
								type="button"
								className="mini-button icon-only-button"
								onClick={() => setShowComposer(false)}
							>
								<X size={14} />
							</button>
						</div>

						<div className="composer-copy">
							<p>
								{mode === "edit"
									? "这里只编辑名称和备注，真实认证快照保持不变。"
									: "工具会自动读取当前 Codex 的 config/auth，并把它保存成一个可切换账号。"}
							</p>
						</div>

						<div className="form-grid">
							<label className="field">
								<span>列表名称</span>
								<input
									value={profileName}
									onChange={(event) =>
										setProfileName(event.target.value)
									}
									placeholder="例如：工作账号 / 个人主账号"
								/>
							</label>

							<label className="field field-span-2">
								<span>备注说明</span>
								<textarea
									value={profileNotes}
									onChange={(event) =>
										setProfileNotes(event.target.value)
									}
									placeholder="例如：给个人开发使用，或用于某个工作项目"
									rows={3}
								/>
							</label>
						</div>

						<div className="form-footer">
							<button
								type="button"
								className="ghost-button"
								onClick={() => setShowComposer(false)}
							>
								取消
							</button>
							<button
								type="button"
								className="primary-button"
								disabled={!profileName.trim() || isSubmitting}
								onClick={() => void handleCreateProfile()}
							>
								{isSubmitting
									? "正在同步..."
									: mode === "edit"
										? "保存当前编辑"
										: "导入并设为当前激活"}
							</button>
						</div>
					</section>
				</div>
			) : null}
		</main>
	);
}

export default App;
