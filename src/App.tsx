import {
	AlertCircle,
	ArrowLeft,
	ArrowRight,
	BarChart3,
	Bot,
	BookOpen,
	CalendarDays,
	ChevronDown,
	ChevronRight,
	CheckCircle2,
	Clock3,
	Code,
	GraduationCap,
	Heart,
	Import,
	LayoutDashboard,
	Layers,
	LoaderCircle,
	Monitor,
	PanelLeft,
	PencilLine,
	RefreshCw,
	RotateCcw,
	Search,
	Settings,
	Sparkles,
	Trash2,
	WandSparkles,
	X,
	type LucideIcon
} from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
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
type AppSection = "overview" | "profiles" | "settings";
type SidebarItemId = AppSection | "import" | "sync" | "updates";
type UsageSession = {
	profileId: string;
	startedAt: string;
	endedAt: string;
};

const EMPTY_PROFILES: AppStatePayload["profiles"] = [];
const WINDOW_DRAG_BLOCK_SELECTOR =
	'button, a, input, textarea, select, label, summary, [role="button"], [contenteditable="true"], [data-no-window-drag]';
const USAGE_STORAGE_KEY = "codex-account-switcher:usage-sessions:v1";
const HEATMAP_WEEKS = 13;
const MAX_STORED_USAGE_SESSIONS = 900;
const BROWSER_PREVIEW_STATE: AppStatePayload = {
	// 浏览器预览没有 Tauri 后端，这组账号示例只用于验证当前产品的 Profiles 列表态，不会写入真实账号配置。
	profiles: [
		{
			id: "personal-main",
			name: "个人账号（kingcwt321）",
			notes: "官方登录 · 日常开发使用",
			profile_type: "chatgpt",
			source: "preview",
			last_synced_at: "2026-06-25T12:11:11.000Z"
		},
		{
			id: "work-proxy",
			name: "工作模式",
			notes: "工作代理 · 已同步到桌面应用",
			profile_type: "proxy",
			source: "preview",
			last_synced_at: "2026-06-25T11:18:22.000Z"
		},
		{
			id: "test-lab",
			name: "测试环境",
			notes: "工作代理 · 用于验证发布包",
			profile_type: "proxy",
			source: "preview",
			last_synced_at: "2026-06-25T09:23:39.000Z"
		},
		{
			id: "backup-login",
			name: "备用官方账号",
			notes: "官方登录 · 低频备用",
			profile_type: "chatgpt",
			source: "preview",
			last_synced_at: "2026-06-24T18:08:14.000Z"
		},
		{
			id: "release-bot",
			name: "发布验证账号",
			notes: "工作代理 · 检查自动更新流程",
			profile_type: "proxy",
			source: "preview",
			last_synced_at: "2026-06-24T09:12:40.000Z"
		},
		{
			id: "client-demo",
			name: "客户演示账号",
			notes: "官方登录 · 演示环境",
			profile_type: "chatgpt",
			source: "preview",
			last_synced_at: "2026-06-23T15:30:22.000Z"
		},
		{
			id: "sandbox-proxy",
			name: "沙盒代理",
			notes: "工作代理 · 临时测试",
			profile_type: "proxy",
			source: "preview",
			last_synced_at: "2026-06-22T10:42:08.000Z"
		},
		{
			id: "personal-lab",
			name: "个人实验账号",
			notes: "官方登录 · 插件和脚本调试",
			profile_type: "chatgpt",
			source: "preview",
			last_synced_at: "2026-06-21T19:05:31.000Z"
		}
	],
	active_profile_id: "work-proxy",
	codex_home: "~/.codex",
	profiles_home: "~/.codex-switchboard/profiles",
	app_version: "0.1.8"
};

const SIDEBAR_ITEMS: Array<{
	id: SidebarItemId;
	label: string;
	icon: LucideIcon;
	badge?: (count: number) => string | null;
}> = [
	{ id: "overview", label: "Overview", icon: LayoutDashboard },
	{
		id: "profiles",
		label: "Profiles",
		icon: Bot,
		badge: (count) => (count > 0 ? String(count) : null)
	},
	{ id: "import", label: "Import", icon: Import },
	{ id: "sync", label: "Sync", icon: WandSparkles },
	{ id: "updates", label: "Updates", icon: RefreshCw },
	{ id: "settings", label: "Settings", icon: Settings }
];

const PROFILE_VISUALS: Record<
	AppStatePayload["profiles"][number]["profile_type"],
	{ icon: LucideIcon; color: string }
> = {
	chatgpt: { icon: GraduationCap, color: "#8b5cf6" },
	proxy: { icon: Code, color: "#3b82f6" }
};

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

const getProfileTypeLabel = (profileType: AppStatePayload["profiles"][number]["profile_type"]) =>
	// 列表和概览共用同一份 Profile 类型文案，避免不同区域展示不一致。
	profileType === "chatgpt" ? "官方登录" : "工作代理";

const getProfileMeta = (
	profile: AppStatePayload["profiles"][number],
	isActive: boolean
) =>
	// 备注存在时优先作为副文案，空备注再回落到类型和同步时间，保证真实账号列表也有稳定信息层级。
	profile.notes.trim() ||
	`${getProfileTypeLabel(profile.profile_type)}${isActive ? " · deployed" : ""} · ${formatProfileTimestamp(profile.last_synced_at)}`;

const getProfileVisual = (profile: AppStatePayload["profiles"][number]) =>
	// 账号行沿用 Agency 风格的彩色线性图标，但语义仍按当前产品的 Profile 类型区分。
	PROFILE_VISUALS[profile.profile_type];

const readUsageSessions = () => {
	try {
		const rawValue = window.localStorage.getItem(USAGE_STORAGE_KEY);
		if (!rawValue) return [];

		const parsedValue = JSON.parse(rawValue);
		if (!Array.isArray(parsedValue)) return [];

		// 统计数据只保存在本机 localStorage，读取时做形状校验，避免旧数据污染 Overview。
		return parsedValue.filter(
			(session): session is UsageSession =>
				typeof session?.profileId === "string" &&
				typeof session?.startedAt === "string" &&
				typeof session?.endedAt === "string"
		);
	} catch {
		return [];
	}
};

const writeUsageSessions = (sessions: UsageSession[]) => {
	window.localStorage.setItem(
		USAGE_STORAGE_KEY,
		JSON.stringify(sessions.slice(-MAX_STORED_USAGE_SESSIONS))
	);
};

const toDayKey = (date: Date) =>
	`${date.getFullYear()}-${padDatePart(date.getMonth() + 1)}-${padDatePart(date.getDate())}`;

const toMonthKey = (date: Date) =>
	`${date.getFullYear()}-${padDatePart(date.getMonth() + 1)}`;

const getSessionMinutes = (session: UsageSession) => {
	const startedAt = new Date(session.startedAt).getTime();
	const endedAt = new Date(session.endedAt).getTime();

	if (Number.isNaN(startedAt) || Number.isNaN(endedAt) || endedAt <= startedAt) {
		return 0;
	}

	return Math.max(1, Math.round((endedAt - startedAt) / 60000));
};

const formatDuration = (minutes: number) => {
	if (minutes < 60) return `${minutes}m`;

	const hours = Math.floor(minutes / 60);
	const restMinutes = minutes % 60;
	return restMinutes > 0 ? `${hours}h ${restMinutes}m` : `${hours}h`;
};

const getCurrentTimestamp = () =>
	// 时间读取集中在组件外部，避免 React 纯渲染规则把事件处理里的 Date.now 误判为 render 副作用。
	Date.now();

const buildPreviewUsageSessions = (
	profiles: AppStatePayload["profiles"]
): UsageSession[] => {
	const now = new Date();

	// 浏览器预览没有真实本机切换历史，这组稳定样例只用于验证热力图和月统计排版。
	return Array.from({ length: 78 }, (_, index) => {
		const profile = profiles[index % Math.max(profiles.length, 1)];
		const dayOffset = 77 - index;
		const startedAt = new Date(now);
		startedAt.setDate(now.getDate() - dayOffset);
		startedAt.setHours(9 + (index % 7), 10 + (index % 5) * 8, 0, 0);

		const endedAt = new Date(startedAt);
		endedAt.setMinutes(startedAt.getMinutes() + 22 + (index % 6) * 19);

		return {
			profileId: profile?.id ?? "preview",
			startedAt: startedAt.toISOString(),
			endedAt: endedAt.toISOString()
		};
	});
};

function App() {
	const [appState, setAppState] = useState<AppStatePayload | null>(null);
	const [activeSection, setActiveSection] = useState<AppSection>("profiles");
	const [overviewSnapshotAt, setOverviewSnapshotAt] = useState(() =>
		getCurrentTimestamp()
	);
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
	const [profileQuery, setProfileQuery] = useState("");
	const [editingProfileId, setEditingProfileId] = useState<string | null>(
		null
	);
	const [usageSessions, setUsageSessions] = useState<UsageSession[]>(() =>
		readUsageSessions()
	);
	const [activeUsageSession, setActiveUsageSession] = useState<{
		profileId: string;
		startedAt: number;
	} | null>(null);
	const activeUsageRef = useRef<{ profileId: string; startedAt: number } | null>(
		null
	);
	const [isLoading, setIsLoading] = useState(true);
	const [isSubmitting, setIsSubmitting] = useState(false);
	const runsInTauri = isTauriRuntime();

	const profiles = appState?.profiles ?? EMPTY_PROFILES;
	const activeProfileId = appState?.active_profile_id ?? null;
	const activeProfile =
		profiles.find((profile) => profile.id === activeProfileId) ?? null;
	const isBrowserPreview =
		profiles.length > 0 &&
		profiles.every((profile) => profile.source === "preview");
	const sidebarProfileCount = profiles.length;
	const sidebarStatusLabel = `${profiles.length} accounts`;
	const visibleProfiles = useMemo(() => {
		const query = profileQuery.trim().toLowerCase();
		if (!query) return profiles;

		// 搜索仅影响当前列表展示，不写入任何 Profile 数据。
		return profiles.filter((profile) =>
			[profile.name, profile.notes, getProfileTypeLabel(profile.profile_type)]
				.join(" ")
				.toLowerCase()
				.includes(query)
		);
	}, [profileQuery, profiles]);
	const composerTitle = mode === "edit" ? "编辑账号" : "导入当前配置";
	// 配置文件写入成功不代表桌面客户端刷新成功，这里单独标出需要人工处理的自动化失败。
	const desktopSyncFailed =
		desktopSync != null &&
		(!desktopSync.codex_relaunched || !desktopSync.vscode_reloaded);
	const updateButtonLabel =
		appUpdate?.status === "available" && appUpdate.next_version
			? `更新到 ${appUpdate.next_version}`
			: "检查更新";
	const overviewStats = useMemo(() => {
		const sessions = isBrowserPreview
			? buildPreviewUsageSessions(profiles)
			: [...usageSessions];

		if (!isBrowserPreview && activeUsageSession) {
			sessions.push({
				profileId: activeUsageSession.profileId,
				startedAt: new Date(activeUsageSession.startedAt).toISOString(),
				endedAt: new Date(overviewSnapshotAt).toISOString()
			});
		}

		const profileTotals = new Map<string, number>();
		const dayTotals = new Map<string, number>();
		const monthTotals = new Map<string, number>();

		for (const session of sessions) {
			const minutes = getSessionMinutes(session);
			if (minutes <= 0) continue;

			const startedAt = new Date(session.startedAt);
			profileTotals.set(
				session.profileId,
				(profileTotals.get(session.profileId) ?? 0) + minutes
			);
			dayTotals.set(toDayKey(startedAt), (dayTotals.get(toDayKey(startedAt)) ?? 0) + minutes);
			monthTotals.set(
				toMonthKey(startedAt),
				(monthTotals.get(toMonthKey(startedAt)) ?? 0) + minutes
			);
		}

		const overviewNow = new Date(overviewSnapshotAt);
		const heatmapStart = new Date(overviewNow);
		heatmapStart.setDate(
			heatmapStart.getDate() - (HEATMAP_WEEKS * 7 - 1 + heatmapStart.getDay())
		);
		heatmapStart.setHours(0, 0, 0, 0);

		const heatmapDays = Array.from({ length: HEATMAP_WEEKS * 7 }, (_, index) => {
			const date = new Date(heatmapStart);
			date.setDate(heatmapStart.getDate() + index);
			const key = toDayKey(date);
			const minutes = dayTotals.get(key) ?? 0;
			const level =
				minutes === 0 ? 0 : minutes < 30 ? 1 : minutes < 90 ? 2 : minutes < 180 ? 3 : 4;

			return { key, label: key.slice(5), minutes, level };
		});

		const profileRows = profiles
			.map((profile) => ({
				profile,
				minutes: profileTotals.get(profile.id) ?? 0
			}))
			.sort((left, right) => right.minutes - left.minutes);
		const topProfile = profileRows[0] ?? null;
		const totalMinutes = profileRows.reduce((total, row) => total + row.minutes, 0);
		const todayMinutes = dayTotals.get(toDayKey(overviewNow)) ?? 0;
		const thisMonthMinutes = monthTotals.get(toMonthKey(overviewNow)) ?? 0;
		const monthRows = Array.from({ length: 6 }, (_, index) => {
			const date = new Date(overviewNow);
			date.setMonth(date.getMonth() - (5 - index));
			const key = toMonthKey(date);

			return { key, minutes: monthTotals.get(key) ?? 0 };
		});

		return {
			heatmapDays,
			monthRows,
			profileRows,
			thisMonthMinutes,
			todayMinutes,
			topProfile,
			totalMinutes
		};
	}, [
		activeUsageSession,
		isBrowserPreview,
		overviewSnapshotAt,
		profiles,
		usageSessions
	]);

	useEffect(() => {
		const bootstrap = async () => {
			if (!runsInTauri) {
				setAppState(BROWSER_PREVIEW_STATE);
				setIsLoading(false);
				return;
			}

			try {
				const state = await loadState();
				setAppState(state);
				// Profiles 首屏只依赖本地状态；更新检查走后台，避免网络/Release manifest 拖住加载页。
				setIsLoading(false);

				void checkAppUpdateAvailable()
					.then((updateStatus) => {
						// 启动自动检查只改变按钮状态，不弹成功提示，避免打断账号切换工作流。
						setAppUpdate(
							updateStatus.status === "available" ? updateStatus : null
						);
					})
					.catch((updateError) => {
						// 更新服务不可用不影响账号切换主流程，保留手动检查入口供用户重试。
						console.warn("自动检查更新失败", updateError);
					});
			} catch (error) {
				setErrorMessage(
					error instanceof Error
						? error.message
						: "加载本地 Profiles 失败"
				);
				setIsLoading(false);
			}
		};

		void bootstrap();

		let unlisten: (() => void) | undefined;
		if (runsInTauri) {
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
	}, [runsInTauri]);

	useEffect(() => {
		if (isLoading) return;

		const syncUsageSession = async () => {
			const now = getCurrentTimestamp();
			const currentSession = activeUsageRef.current;

			if (currentSession && currentSession.profileId !== activeProfileId) {
				const closedSession = {
					profileId: currentSession.profileId,
					startedAt: new Date(currentSession.startedAt).toISOString(),
					endedAt: new Date(now).toISOString()
				};

				setUsageSessions((previousSessions) => {
					const nextSessions = [...previousSessions, closedSession].slice(
						-MAX_STORED_USAGE_SESSIONS
					);
					if (!isBrowserPreview) writeUsageSessions(nextSessions);
					return nextSessions;
				});
			}

			// 真实使用时长从本版本打开应用后开始统计，不回填后端不存在的历史周期。
			const nextSession = activeProfileId
				? { profileId: activeProfileId, startedAt: now }
				: null;
			activeUsageRef.current = nextSession;
			setActiveUsageSession(nextSession);
		};

		void syncUsageSession();
	}, [activeProfileId, isBrowserPreview, isLoading]);

	useEffect(
		() => () => {
			const currentSession = activeUsageRef.current;
			if (!currentSession || isBrowserPreview) return;

			const closedSession = {
				profileId: currentSession.profileId,
				startedAt: new Date(currentSession.startedAt).toISOString(),
				endedAt: new Date().toISOString()
			};
			writeUsageSessions([...readUsageSessions(), closedSession]);
		},
		[isBrowserPreview]
	);

	useEffect(() => {
		if (!successMessage || desktopSyncFailed) return undefined;

		const timer = window.setTimeout(() => {
			setSuccessMessage(null);
			setDesktopSync(null);
		}, 4000);

		// 普通成功提示自动消失；桌面刷新失败需要保留，避免用户错过人工处理信息。
		return () => window.clearTimeout(timer);
	}, [desktopSyncFailed, successMessage]);

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

	const dismissNotice = () => {
		setSuccessMessage(null);
		setErrorMessage(null);
		setDesktopSync(null);
	};

	const handleSidebarItemClick = (itemId: SidebarItemId) => {
		if (itemId === "overview" || itemId === "profiles" || itemId === "settings") {
			if (itemId === "overview") {
				// 打开 Overview 时刷新一次当前会话时长，不依赖轮询也不在 render 里读 ref。
				setOverviewSnapshotAt(getCurrentTimestamp());
			}
			setActiveSection(itemId);
			return;
		}

		if (itemId === "import") {
			openComposer("current");
			return;
		}

		if (itemId === "sync") {
			void handleSyncDesktopClients();
			return;
		}

		void handleCheckAppUpdate();
	};

	const handleWindowDragStart = (event: MouseEvent<HTMLElement>) => {
		// 普通内容区按住即可拖动窗口，但保留按钮和输入类控件的原始交互。
		if (event.button !== 0 || !runsInTauri) return;

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
		<main
			className={`app-shell ${runsInTauri ? "desktop-shell" : "browser-shell"}`}
			onMouseDownCapture={handleWindowDragStart}
		>
			{runsInTauri ? (
				// 自绘 titlebar 只属于 Tauri 桌面壳；浏览器预览使用浏览器自身 chrome，内容必须铺满页面。
				<header className="agency-titlebar">
					<button type="button" className="title-icon title-sidebar">
						<PanelLeft size={16} />
					</button>
					<div className="title-nav">
						<button type="button" className="title-icon">
							<ArrowLeft size={17} />
						</button>
						<button type="button" className="title-icon title-icon-muted">
							<ArrowRight size={17} />
						</button>
					</div>
					<strong className="titlebar-heading">
						{activeSection === "overview"
							? "Overview"
							: activeSection === "settings"
								? "Settings"
								: "Profiles"}
					</strong>
					<div className="titlebar-actions">
						<button type="button" className="titlebar-pill">
							<Monitor size={15} />
						</button>
						<button type="button" className="titlebar-pill">
							<BookOpen size={15} />
						</button>
						<button type="button" className="titlebar-pill">
							<Settings size={15} />
						</button>
						<button type="button" className="titlebar-pill titlebar-heart">
							<Heart size={15} fill="currentColor" />
						</button>
					</div>
				</header>
			) : null}

			<div className="agency-frame">
				<aside className="agency-sidebar">
					<div className="agency-brand">
						<span className="brand-mark" aria-hidden="true">🤖</span>
						<strong>Codex Switcher</strong>
					</div>

					<nav className="agency-nav" aria-label="Primary navigation">
						{SIDEBAR_ITEMS.map((item) => {
							const Icon = item.icon;
							const badge = item.badge?.(sidebarProfileCount);
							return (
								<button
									key={item.label}
									type="button"
									className={`agency-nav-item ${activeSection === item.id ? "active" : ""}`}
									onClick={() => handleSidebarItemClick(item.id)}
									disabled={
										isSubmitting &&
										(item.id === "sync" || item.id === "updates")
									}
								>
									<Icon size={16} />
									<span>{item.label}</span>
									{badge ? <strong>{badge}</strong> : null}
								</button>
							);
						})}
					</nav>

					<div className="agency-sidebar-footer">
						<span className="status-dot" />
						<span>{sidebarStatusLabel}</span>
						{isBrowserPreview ? null : (
							<span className="sidebar-version">v{appState?.app_version ?? "?"}</span>
						)}
					</div>
				</aside>

				<section className="agency-content">
					{activeSection === "profiles" ? (
						<div className="agents-toolbar">
							<button type="button" className="filter-button">
								All profiles
								<ChevronDown size={15} />
							</button>
							<label className="search-shell">
								<Search size={17} />
								<input
									value={profileQuery}
									onChange={(event) => setProfileQuery(event.target.value)}
									placeholder="Search profiles by name, notes, or type..."
								/>
							</label>
							<button
								type="button"
								className="refresh-button"
								onClick={() => void handleCheckAppUpdate()}
								disabled={isSubmitting}
								title={updateButtonLabel}
							>
								<RefreshCw size={18} />
							</button>
						</div>
					) : null}

					<div className="notification-stack">
						{successMessage ? (
							<section
								className={`notice-banner ${desktopSyncFailed ? "notice-error" : "notice-success"}`}
								aria-live="polite"
							>
								<span className={desktopSyncFailed ? "error-icon" : "status-icon"}>
									{desktopSyncFailed ? <AlertCircle size={15} /> : <CheckCircle2 size={15} />}
								</span>
								<div className="notice-copy">
									<strong>{desktopSyncFailed ? "同步已写入，刷新失败" : successTitle}</strong>
									<p>{successMessage}</p>
								</div>
								<button
									type="button"
									className="notice-close"
									onClick={dismissNotice}
									aria-label="关闭提示"
								>
									<X size={14} />
								</button>
							</section>
						) : null}

						{errorMessage ? (
							<section className="notice-banner notice-error" aria-live="polite">
								<span className="error-icon">
									<AlertCircle size={15} />
								</span>
								<div className="notice-copy">
									<strong>操作未完成</strong>
									<p>{errorMessage}</p>
								</div>
								<button
									type="button"
									className="notice-close"
									onClick={dismissNotice}
									aria-label="关闭提示"
								>
									<X size={14} />
								</button>
							</section>
						) : null}
					</div>

					{activeSection === "overview" ? (
						<div className="overview-page">
							<div className="overview-header">
								<div>
									<p className="section-kicker">Usage</p>
									<h1>Profile usage overview</h1>
								</div>
								<span>
									{isBrowserPreview
										? "Preview history"
										: "Tracking starts from this version"}
								</span>
							</div>

							<div className="overview-summary">
								<section>
									<Clock3 size={15} />
									<span>Today</span>
									<strong>{formatDuration(overviewStats.todayMinutes)}</strong>
								</section>
								<section>
									<CalendarDays size={15} />
									<span>This month</span>
									<strong>{formatDuration(overviewStats.thisMonthMinutes)}</strong>
								</section>
								<section>
									<Bot size={15} />
									<span>Current</span>
									<strong>{activeProfile?.name ?? "No active profile"}</strong>
								</section>
								<section>
									<BarChart3 size={15} />
									<span>Top profile</span>
									<strong>
										{overviewStats.topProfile
											? overviewStats.topProfile.profile.name
											: "No usage yet"}
									</strong>
								</section>
							</div>

							<section className="usage-panel heatmap-panel">
								<div className="panel-heading">
									<strong>Daily activity</strong>
									<span>{formatDuration(overviewStats.totalMinutes)} tracked</span>
								</div>
								<div className="usage-heatmap" aria-label="Daily profile usage heatmap">
									{overviewStats.heatmapDays.map((day) => (
										<span
											key={day.key}
											className={`heat-cell level-${day.level}`}
											title={`${day.key}: ${formatDuration(day.minutes)}`}
											aria-label={`${day.key}: ${formatDuration(day.minutes)}`}
										/>
									))}
								</div>
							</section>

							<div className="overview-grid">
								<section className="usage-panel">
									<div className="panel-heading">
										<strong>Profiles</strong>
										<span>By duration</span>
									</div>
									<div className="usage-bars">
										{overviewStats.profileRows.map(({ profile, minutes }) => {
											const visual = getProfileVisual(profile);
											const share =
												overviewStats.totalMinutes > 0
													? (minutes / overviewStats.totalMinutes) * 100
													: 0;

											return (
												<div key={profile.id} className="usage-row">
													<span style={{ color: visual.color }}>
														{getProfileTypeLabel(profile.profile_type)}
													</span>
													<strong>{profile.name}</strong>
													<em>{formatDuration(minutes)}</em>
													<i style={{ width: `${share}%`, background: visual.color }} />
												</div>
											);
										})}
									</div>
								</section>

								<section className="usage-panel">
									<div className="panel-heading">
										<strong>Recent months</strong>
										<span>Last 6 months</span>
									</div>
									<div className="month-bars">
										{overviewStats.monthRows.map((month) => {
											const maxMonthMinutes = Math.max(
												1,
												...overviewStats.monthRows.map((row) => row.minutes)
											);

											return (
												<div key={month.key}>
													<span>{month.key.slice(5)}</span>
													<i
														style={{
															height: `${Math.max(8, (month.minutes / maxMonthMinutes) * 88)}%`
														}}
													/>
													<strong>{formatDuration(month.minutes)}</strong>
												</div>
											);
										})}
									</div>
								</section>
							</div>
						</div>
					) : null}

					{activeSection === "settings" ? (
						<div className="empty-state settings-state">
							<Settings size={30} />
							<strong>Settings</strong>
							<p>当前版本先保留设置入口，避免侧边栏点击后无反馈。</p>
						</div>
					) : null}

					{activeSection === "profiles" ? (
						<>
							<div className="agents-list-head">
								<div className="section-label">
									<Layers size={17} />
									<span>Profiles</span>
								</div>
								<div className="section-actions">
									<button type="button" onClick={() => openComposer("current")}>
										<Import size={15} />
										Import
									</button>
									<button
										type="button"
										onClick={() => void handleSyncDesktopClients()}
										disabled={isSubmitting || profiles.length === 0}
									>
										<WandSparkles size={15} />
										Sync
									</button>
									<span>Select</span>
								</div>
							</div>

							<div className="agents-scroll">
								{isLoading ? (
									<div className="empty-state">
										<LoaderCircle size={32} className="spin" />
										<strong>Loading profiles</strong>
										<p>读取本地账号和当前激活状态。</p>
									</div>
								) : visibleProfiles.length === 0 ? (
									<div className="empty-state">
										<Sparkles size={34} />
										<strong>{profiles.length === 0 ? "No profiles yet" : "No matching profiles"}</strong>
										<p>
											{profiles.length === 0
												? "Import your current Codex identity to start switching."
												: "Try a different name, role, or note."}
										</p>
										<button type="button" onClick={() => openComposer("current")}>
											<Import size={15} />
											Import current profile
										</button>
									</div>
								) : (
									<ul className="agency-rows">
										{visibleProfiles.map((profile) => {
											const isActive = profile.id === activeProfileId;
											const visual = getProfileVisual(profile);
											const Icon = visual.icon;
											return (
												<li key={profile.id} className={isActive ? "active" : ""}>
													<div className="row-main">
														<span className="row-icon" style={{ color: visual.color }}>
															<Icon size={20} />
														</span>
														<button
															type="button"
															className="row-copy"
															onClick={() =>
																isActive
																	? void handleApplyProfile(profile.id)
																	: void handleSwitchProfile(profile.id)
															}
															disabled={isSubmitting}
														>
															<strong>
																<span>{profile.name}</span>
																{isActive ? <em>Current</em> : null}
															</strong>
															<span>{getProfileMeta(profile, isActive)}</span>
														</button>
													</div>
													<div className="row-actions">
														{isActive ? (
															<button
																type="button"
																onClick={() => void handleResyncActiveProfile()}
																disabled={isSubmitting}
															>
																<RotateCcw size={15} />
																Sync
															</button>
														) : null}
														<button
															type="button"
															onClick={() => startEditingProfile(profile.id)}
															disabled={isSubmitting}
														>
															<PencilLine size={15} />
														</button>
														<button
															type="button"
															className="danger"
															onClick={() => void handleDeleteProfile(profile.id, profile.name)}
															disabled={isSubmitting}
														>
															<Trash2 size={15} />
														</button>
														<ChevronRight className="row-chevron" size={20} />
													</div>
												</li>
											);
										})}
									</ul>
								)}
							</div>
						</>
					) : null}
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
