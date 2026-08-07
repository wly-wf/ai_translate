import { type MouseEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { cursorPosition, getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { siAnthropic, siDeepseek, siGooglegemini, siMoonshotai, type SimpleIcon } from "simple-icons";
import bailianIcon from "@lobehub/icons-static-svg/icons/bailian-color.svg";
import xiaomiMimoIcon from "@lobehub/icons-static-svg/icons/xiaomimimo.svg";
import zhipuIcon from "@lobehub/icons-static-svg/icons/zhipu-color.svg";
import { SelectionFloat } from "./SelectionFloat";
import appIcon from "../src-tauri/icons/tray-icon.svg";
import "./App.css";

type SettingsProviderId = "deepseek" | "xiaomi" | "qwen" | "zhipu" | "moonshot" | "openai" | "google" | "anthropic";
type ProviderId = SettingsProviderId;
type GenericProviderId = "openai" | "google" | "anthropic";
type SettingsPage = "providers" | "generic" | "connection" | "general" | "interface" | "about";
type ApiProtocol = "openai" | "google" | "anthropic";
type ProviderTranslationResult = { providerId: ProviderId; model: string; translation?: string | null; error?: string | null };
type Translation = { source: string; results: ProviderTranslationResult[]; requestId?: number };
type TranslationError = { requestId: number; message: string };
type ActiveProviderChanged = { providerId: ProviderId; model: string };
type UserPreferences = { autoSelection: boolean; keepOnTop: boolean; quickTranslateProvider: ProviderId | null };
type TitlebarDragState = {
  startX: number;
  startY: number;
  started: boolean;
  cleanup: () => void;
};

type TranslationProvider = {
  id: ProviderId;
  vendor: string;
  model: string;
  mark: string;
  accent: string;
  enabled: boolean;
  summary: string;
};

type SettingsProvider = {
  id: SettingsProviderId;
  vendor: string;
  model: string;
  baseUrl: string;
  protocol: ApiProtocol;
  mark: string;
  accent: string;
  summary: string;
};

type ProviderDraft = {
  apiKey: string;
  baseUrl: string;
  model: string;
  saved: boolean;
};

type ProviderConfigResponse = {
  apiKey: string;
  baseUrl: string;
  model: string;
};

type ConnectionState = {
  providerId: SettingsProviderId | null;
  status: "idle" | "testing" | "success" | "error";
  message: string;
};

type ModelChoice = {
  providerId: ProviderId;
  model: string;
};

const PROVIDER_ICONS: Partial<Record<ProviderId, SimpleIcon>> = {
  deepseek: siDeepseek,
  anthropic: siAnthropic,
  google: siGooglegemini,
};

const SETTINGS_PROVIDER_ICONS: Partial<Record<SettingsProviderId, SimpleIcon>> = {
  deepseek: siDeepseek,
  moonshot: siMoonshotai,
  anthropic: siAnthropic,
  google: siGooglegemini,
};

const PROVIDER_IMAGE_ICONS: Partial<Record<SettingsProviderId, { src: string; className: string }>> = {
  xiaomi: { src: xiaomiMimoIcon, className: "provider-mimo-mark" },
  qwen: { src: bailianIcon, className: "provider-bailian-mark" },
  zhipu: { src: zhipuIcon, className: "provider-zhipu-mark" },
};

const SETTINGS_PROVIDERS: SettingsProvider[] = [
  {
    id: "deepseek",
    vendor: "DeepSeek",
    model: "deepseek-v4-flash",
    baseUrl: "https://api.deepseek.com",
    protocol: "openai",
    mark: "D",
    accent: "#16a394",
    summary: "适合日常取词、技术文档和快速翻译。",
  },
  {
    id: "xiaomi",
    vendor: "Xiaomi MiMo",
    model: "mimo-v2.5-pro",
    baseUrl: "https://api.xiaomimimo.com/v1",
    protocol: "openai",
    mark: "M",
    accent: "#ff6900",
    summary: "Xiaomi MiMo 开放平台，兼容 OpenAI 接口。",
  },
  {
    id: "qwen",
    vendor: "阿里云百炼",
    model: "qwen-plus",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    protocol: "openai",
    mark: "Q",
    accent: "#5b55d6",
    summary: "阿里云百炼兼容模式，支持通义千问。",
  },
  {
    id: "zhipu",
    vendor: "智谱开放平台",
    model: "glm-5.2",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    protocol: "openai",
    mark: "Z",
    accent: "#3478f6",
    summary: "智谱开放平台，兼容 OpenAI SDK。",
  },
  {
    id: "moonshot",
    vendor: "Moonshot",
    model: "kimi-k2.5",
    baseUrl: "https://api.moonshot.cn/v1",
    protocol: "openai",
    mark: "K",
    accent: "#242936",
    summary: "Moonshot API，适合长文本和中文场景。",
  },
];

const GENERIC_PROVIDERS: SettingsProvider[] = [
  {
    id: "openai",
    vendor: "OpenAI",
    model: "gpt-4o-mini",
    baseUrl: "https://api.openai.com/v1",
    protocol: "openai",
    mark: "O",
    accent: "#111827",
    summary: "标准 OpenAI Chat Completions 兼容接口。",
  },
  {
    id: "google",
    vendor: "Google Gemini",
    model: "gemini-3.5-flash",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    protocol: "google",
    mark: "G",
    accent: "#5578df",
    summary: "Google Gemini 原生 generateContent 接口。",
  },
  {
    id: "anthropic",
    vendor: "Anthropic Claude",
    model: "claude-sonnet-4-5",
    baseUrl: "https://api.anthropic.com/v1",
    protocol: "anthropic",
    mark: "A",
    accent: "#d27b52",
    summary: "Anthropic Messages API。",
  },
];

const ALL_SETTINGS_PROVIDERS = [...SETTINGS_PROVIDERS, ...GENERIC_PROVIDERS];

function createProviderDrafts(): Record<SettingsProviderId, ProviderDraft> {
  return Object.fromEntries(ALL_SETTINGS_PROVIDERS.map((provider) => [provider.id, {
    apiKey: "",
    baseUrl: provider.baseUrl,
    model: "",
    saved: false,
  }])) as Record<SettingsProviderId, ProviderDraft>;
}

const TRANSLATION_PROVIDERS: TranslationProvider[] = ALL_SETTINGS_PROVIDERS.map((provider) => ({
  ...provider,
  enabled: true,
}));
const AVAILABLE_TRANSLATION_PROVIDERS = TRANSLATION_PROVIDERS.filter((provider) => provider.enabled);

const DEFAULT_PROVIDER_ID: ProviderId = "deepseek";
const DEFAULT_USER_PREFERENCES: UserPreferences = { autoSelection: true, keepOnTop: false, quickTranslateProvider: null };
const isTauriDesktop = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function isMostlyEnglish(value: string) {
  const latinCount = value.match(/[A-Za-z]/g)?.length ?? 0;
  const cjkCount = value.match(/[\u3400-\u9fff]/g)?.length ?? 0;
  return latinCount > cjkCount;
}

function normalizeParagraphText(value: string) {
  return value
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((paragraph) => paragraph
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .reduce((joined, line) => {
        if (!joined) return line;
        const previous = joined.charAt(joined.length - 1);
        const next = line.charAt(0);
        const previousIsCjk = /[\u3400-\u9fff]/.test(previous);
        const nextIsCjk = /[\u3400-\u9fff]/.test(next);
        const needsSpace = !previousIsCjk
          && !nextIsCjk
          && previous !== "-"
          && !/[([{"'“‘]/.test(previous)
          && !/[,.!?;:)]}"'。，！？；：、）】》”’]/.test(next);
        return `${joined}${needsSpace ? " " : ""}${line}`;
      }, ""))
    .filter(Boolean)
    .join("\n\n");
}

function ProviderIcon({ provider }: { provider: { id: string; mark: string; accent: string } }) {
  const imageIcon = PROVIDER_IMAGE_ICONS[provider.id as SettingsProviderId];
  if (imageIcon) {
    return <span className={`provider-mark provider-brand-mark ${imageIcon.className}`} aria-hidden="true"><img className="provider-brand-image" src={imageIcon.src} alt="" /></span>;
  }
  const icon = PROVIDER_ICONS[provider.id as ProviderId] ?? SETTINGS_PROVIDER_ICONS[provider.id as SettingsProviderId];
  return <span className={`provider-mark${icon ? " provider-brand-mark" : ""}`} style={icon ? { color: `#${icon.hex}` } : { backgroundColor: provider.accent }} aria-hidden="true">
    {icon ? <svg className="provider-icon" viewBox="0 0 24 24"><path d={icon.path} /></svg> : provider.mark}
  </span>;
}

function ModelPicker({ value, choices, onChange, ariaLabel, disabled = false }: { value: ProviderId | null; choices: ModelChoice[]; onChange: (providerId: ProviderId) => void; ariaLabel: string; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selectedChoice = choices.find((choice) => choice.providerId === value) ?? null;
  const selectedProvider = selectedChoice ? AVAILABLE_TRANSLATION_PROVIDERS.find((provider) => provider.id === selectedChoice.providerId) : null;

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: globalThis.MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return <div className={`model-picker${open ? " is-open" : ""}`} ref={rootRef}>
    <button className="model-picker-trigger" type="button" aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((current) => !current)} disabled={disabled || choices.length === 0}>
      {selectedProvider ? <ProviderIcon provider={selectedProvider} /> : <span className="model-picker-placeholder-icon" aria-hidden="true">◇</span>}
      <span className="model-picker-value">{selectedChoice && selectedProvider ? <><strong>{selectedChoice.model}</strong><small>{selectedProvider.vendor}</small></> : <strong>未设置默认模型</strong>}</span>
      <svg className="model-picker-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
    </button>
    {open && <div className="model-picker-menu" role="listbox" aria-label={ariaLabel}>{choices.map((choice) => { const provider = AVAILABLE_TRANSLATION_PROVIDERS.find((item) => item.id === choice.providerId); if (!provider) return null; const selected = choice.providerId === value; return <button className={`model-picker-option${selected ? " is-selected" : ""}`} type="button" role="option" aria-selected={selected} key={choice.providerId} onClick={() => { onChange(choice.providerId); setOpen(false); }}><ProviderIcon provider={provider} /><span><strong>{choice.model}</strong><small>{provider.vendor}</small></span>{selected && <span className="model-picker-selected-dot" aria-hidden="true" />}</button>; })}</div>}
  </div>;
}

async function nativeInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauriDesktop()) {
    throw new Error("当前页面运行在普通浏览器中。请关闭此页面，并使用 `npm.cmd run tauri dev` 打开的 AI Translate 桌面窗口。");
  }
  return invoke<T>(command, args);
}

function useUserPreferences() {
  const [preferences, setPreferences] = useState<UserPreferences>(DEFAULT_USER_PREFERENCES);
  const [loaded, setLoaded] = useState(false);
  const [preferencesError, setPreferencesError] = useState("");
  const saveChain = useRef<Promise<unknown>>(Promise.resolve());

  useEffect(() => {
    if (!isTauriDesktop()) {
      setLoaded(true);
      return;
    }
    let cancelled = false;
    void nativeInvoke<UserPreferences>("get_preferences")
      .then((stored) => {
        if (cancelled) return;
        setPreferences({ ...DEFAULT_USER_PREFERENCES, ...(stored ?? {}) });
        setLoaded(true);
      })
      .catch((error) => {
        if (cancelled) return;
        setPreferencesError(String(error));
        setLoaded(true);
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!isTauriDesktop() || !loaded) return;
    let cancelled = false;
    saveChain.current = saveChain.current
      .catch(() => undefined)
      .then(() => nativeInvoke("save_preferences", preferences))
      .catch((error) => {
        if (!cancelled) setPreferencesError(String(error));
      });
    return () => { cancelled = true; };
  }, [loaded, preferences]);

  return {
    autoSelection: preferences.autoSelection,
    keepOnTop: preferences.keepOnTop,
    quickTranslateProvider: preferences.quickTranslateProvider,
    setAutoSelection: (value: boolean) => setPreferences((current) => ({ ...current, autoSelection: value })),
    setKeepOnTop: (value: boolean) => setPreferences((current) => ({ ...current, keepOnTop: value })),
    setQuickTranslateProvider: (value: ProviderId | null) => setPreferences((current) => ({ ...current, quickTranslateProvider: value })),
    preferencesError,
  };
}

function Icon({ name }: { name: "menu" | "close" | "chevron" | "pin" | "minimize" }) {
  const paths: Record<string, React.ReactNode> = {
    menu: <path d="M3 5h12M3 9h12M3 13h12" />,
    close: <path d="m3 3 12 12M15 3 3 15" />,
    chevron: <path d="m3 6 5 5 5-5" />,
    pin: <><path d="M5 3.5h8M6 3.5v5.2l-2.8 3.1h11.6L12 8.7V3.5M9 11.8v4.7" /></>,
    minimize: <path d="M3 9h12" />,
  };

  return <svg className={`ui-icon ui-icon-${name}`} viewBox="0 0 18 18" aria-hidden="true">{paths[name]}</svg>;
}

export function ExpandableText({ text, kind, textClassName = "" }: { text: string; kind: "source" | "translation"; textClassName?: string }) {
  const textRef = useRef<HTMLParagraphElement>(null);
  const measurementRef = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => {
    setExpanded(false);
    setOverflowing(false);
  }, [text]);

  useLayoutEffect(() => {
    if (expanded) return;
    const element = textRef.current;
    const measurement = measurementRef.current;
    if (!element || !measurement) return;
    const measure = () => {
      const collapsedHeight = element.getBoundingClientRect().height;
      const expandedHeight = measurement.getBoundingClientRect().height;
      setOverflowing(expandedHeight > collapsedHeight + 1);
    };
    const frame = window.requestAnimationFrame(measure);
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    resizeObserver?.observe(element);
    resizeObserver?.observe(measurement);
    window.addEventListener("resize", measure);
    return () => {
      window.cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [expanded, text]);

  const toggleExpanded = () => setExpanded((current) => !current);
  const canExpand = overflowing;
  const textLabel = kind === "source" ? "原文" : "译文";

  return <div
    className={`text-expandable ${kind}-expandable${expanded ? " is-expanded" : ""}${overflowing ? " is-overflowing" : ""}`}
  >
    <p ref={textRef} className={`${kind}${textClassName ? ` ${textClassName}` : ""}`}>{text}</p>
    <p ref={measurementRef} className={`${kind} text-measure${textClassName ? ` ${textClassName}` : ""}`} aria-hidden="true">{text}</p>
    {canExpand && <button
      type="button"
      className={`text-expand-button ${kind}-expand-button`}
      aria-label={expanded ? `收起完整${textLabel}` : `展开完整${textLabel}`}
      aria-expanded={expanded}
      title={expanded ? `收起${textLabel}` : `展开完整${textLabel}`}
      onClick={toggleExpanded}
    >
      <Icon name="chevron" />
    </button>}
  </div>;
}

function QuickTranslateIcon() {
  return <svg className="quick-translate-icon" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M5.25 5.5h9.1a3 3 0 0 1 3 3v3.9a3 3 0 0 1-3 3H9.7l-3.55 2.9v-2.95a3 3 0 0 1-1.9-2.8V8.5a3 3 0 0 1 3-3Z" />
    <path d="M7.45 9.15h4.55M9.72 7.85v2.6M7.45 11.65h3.05" />
    <path className="quick-translate-spark" d="m18.1 3.15.62 1.82 1.83.62-1.83.62-.62 1.83-.62-1.83-1.83-.62 1.83-.62.62-1.82Z" />
  </svg>;
}

function ReturnToFloatIcon() {
  return <svg className="quick-translate-icon" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12.75 5.25h5.5a2 2 0 0 1 2 2v9.5a2 2 0 0 1-2 2h-5.5" />
    <path d="m10.5 8.5-3.5 3.5 3.5 3.5M7.25 12h9" />
    <path d="M4 5.25v13.5" />
  </svg>;
}

function SearchIcon({ className = "provider-search-icon" }: { className?: string }) {
  return <svg className={className} viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m15.5 15.5 4.5 4.5" /></svg>;
}

function ModelAddIcon() {
  return <svg className="model-toolbar-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>;
}

function ModelRefreshIcon() {
  return <svg className="model-toolbar-icon model-refresh-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0 1.1 4.6" /><path d="M20 5v6h-6" /></svg>;
}

function SettingsNavIcon({ name }: { name: "general" | "interface" | "providers" | "about" }) {
  const paths = {
    general: <><path d="M4 6h16M4 12h16M4 18h16" /><circle cx="9" cy="6" r="1.7" /><circle cx="15" cy="12" r="1.7" /><circle cx="11" cy="18" r="1.7" /></>,
    interface: <><rect x="3.5" y="4" width="17" height="13" rx="2" /><path d="M8 21h8M12 17v4" /></>,
    providers: <><rect x="4" y="4" width="7" height="7" rx="1.2" /><rect x="13" y="13" width="7" height="7" rx="1.2" /><path d="M11 7.5h2M16.5 11v2" /></>,
    about: <><circle cx="12" cy="12" r="8.5" /><path d="M12 10v6M12 7.5v.01" /></>,
  };
  return <svg className="settings-nav-icon" viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>;
}

function MainWindow() {
  const [result, setResult] = useState<Translation | null>(null);
  const [text, setText] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [settingsPage, setSettingsPage] = useState<SettingsPage>("providers");
  const [selectedSettingsProviderId, setSelectedSettingsProviderId] = useState<SettingsProviderId>("deepseek");
  const [providerDrafts, setProviderDrafts] = useState<Record<SettingsProviderId, ProviderDraft>>(createProviderDrafts);
  const [connectionState, setConnectionState] = useState<ConnectionState>({ providerId: null, status: "idle", message: "" });
  const [showApiKey, setShowApiKey] = useState(false);
  const { autoSelection, keepOnTop, quickTranslateProvider, setAutoSelection, setKeepOnTop, preferencesError } = useUserPreferences();
  const [hasApiKey, setHasApiKey] = useState(false);
  const [activeProviderId, setActiveProviderId] = useState<ProviderId>(DEFAULT_PROVIDER_ID);
  const [activeProviderModel, setActiveProviderModel] = useState(SETTINGS_PROVIDERS[0].model);
  const [enabledProviderIds, setEnabledProviderIds] = useState<ProviderId[]>([DEFAULT_PROVIDER_ID]);
  const [enabledProviderModels, setEnabledProviderModels] = useState<Partial<Record<ProviderId, string>>>({ deepseek: SETTINGS_PROVIDERS[0].model });
  const [quickTranslateProviderId, setQuickTranslateProviderId] = useState<ProviderId>(DEFAULT_PROVIDER_ID);
  const [loading, setLoading] = useState(false);
  const [expandedProviderIds, setExpandedProviderIds] = useState<ProviderId[]>([DEFAULT_PROVIDER_ID]);
  const [showQuickTranslate, setShowQuickTranslate] = useState(false);
  const [notice, setNotice] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const latestRequestId = useRef(0);
  const latestTranslationAttempt = useRef(0);
  const titlebarDragRef = useRef<TitlebarDragState | null>(null);
  const activationGraceUntilRef = useRef(0);
  const focusLossTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!isTauriDesktop()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const windowHandle = getCurrentWindow();
    const clearFocusLossTimer = () => {
      if (focusLossTimerRef.current !== null) {
        window.clearTimeout(focusLossTimerRef.current);
        focusLossTimerRef.current = null;
      }
    };
    const checkFocusLoss = () => {
      focusLossTimerRef.current = window.setTimeout(() => {
        focusLossTimerRef.current = null;
        if (keepOnTop || Date.now() < activationGraceUntilRef.current) return;
        void Promise.all([
          windowHandle.isFocused(),
          windowHandle.isMinimized(),
          cursorPosition(),
          windowHandle.outerPosition(),
          windowHandle.outerSize(),
        ])
          .then(([focused, minimized, cursor, position, size]) => {
            if (focused || minimized || Date.now() < activationGraceUntilRef.current) return;
            const insideWindow = cursor.x >= position.x
              && cursor.x < position.x + size.width
              && cursor.y >= position.y
              && cursor.y < position.y + size.height;
            if (!insideWindow) void nativeInvoke<void>("minimize_window").catch(() => undefined);
          })
          .catch(() => undefined);
      }, Math.max(250, activationGraceUntilRef.current - Date.now()));
    };
    void windowHandle.onFocusChanged(({ payload: focused }) => {
      if (focused) {
        activationGraceUntilRef.current = Date.now() + 400;
        clearFocusLossTimer();
        void nativeInvoke<Translation | null>("get_latest_translation")
          .then((snapshot) => {
            if (!snapshot || (snapshot.requestId ?? 0) <= latestRequestId.current) return;
            applyTranslationSnapshot(snapshot);
          })
          .catch(() => undefined);
        return;
      }
      if (!keepOnTop) {
        clearFocusLossTimer();
        checkFocusLoss();
      }
    }).then((remove) => {
      if (disposed) {
        remove();
      } else {
        unlisten = remove;
      }
    }).catch(() => undefined);
    return () => {
      disposed = true;
      clearFocusLossTimer();
      unlisten?.();
    };
  }, [keepOnTop]);

  function acceptRequest(requestId?: number) {
    if (requestId !== undefined && requestId < latestRequestId.current) return false;
    if (requestId !== undefined) latestRequestId.current = requestId;
    return true;
  }

  function translationIsPending(snapshot: Translation) {
    return snapshot.results.length > 0
      && snapshot.results.some((item) => !item.translation && !item.error);
  }

  function applyTranslationSnapshot(snapshot: Translation) {
    if (!acceptRequest(snapshot.requestId)) return;
    const providerId = snapshot.results[0]?.providerId ?? DEFAULT_PROVIDER_ID;
    setActiveProviderId(providerId);
    if (snapshot.results[0]?.model) setActiveProviderModel(snapshot.results[0].model);
    setResult(snapshot);
    setExpandedProviderIds(snapshot.results.map((item) => item.providerId));
    setLoading(translationIsPending(snapshot));
    setNotice("");
    setShowSettings(false);
    setShowQuickTranslate(false);
  }

  async function loadEnabledProviders(providerIds: ProviderId[]) {
    setEnabledProviderIds(providerIds);
    const entries = await Promise.all(providerIds.map(async (providerId) => {
      const config = await nativeInvoke<ProviderConfigResponse | null>("get_provider_config", { provider: providerId });
      return [providerId, config?.model] as const;
    }));
    setEnabledProviderModels(Object.fromEntries(entries.filter((entry): entry is readonly [ProviderId, string] => Boolean(entry[1]))));
    setHasApiKey(providerIds.length > 0);
  }

  function finishTitlebarDrag() {
    const drag = titlebarDragRef.current;
    drag?.cleanup();
    titlebarDragRef.current = null;
  }

  function beginTitlebarDrag(event: MouseEvent<HTMLElement>) {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button, input, textarea, select")) return;
    finishTitlebarDrag();

    const startX = event.screenX;
    const startY = event.screenY;
    let cleanedUp = false;
    const handleMove = (moveEvent: globalThis.MouseEvent) => {
      const drag = titlebarDragRef.current;
      if (!drag || drag.started) return;
      const deltaX = moveEvent.screenX - drag.startX;
      const deltaY = moveEvent.screenY - drag.startY;
      if (deltaX * deltaX + deltaY * deltaY < 16) return;
      drag.started = true;
      void getCurrentWindow().startDragging().catch(() => {
        drag.started = false;
      });
    };
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", finishTitlebarDrag);
    };
    titlebarDragRef.current = { startX, startY, started: false, cleanup };
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", finishTitlebarDrag);
  }

  useEffect(() => {
    if (!isTauriDesktop()) {
      setNotice("当前是普通浏览器预览，无法保存 API Key 或调用翻译。请使用 Tauri 桌面窗口。");
      return;
    }
    void nativeInvoke<ProviderId[]>("get_enabled_providers")
      .then((providerIds) => {
        const enabled = providerIds ?? [];
        if (enabled[0]) setActiveProviderId(enabled[0]);
        setExpandedProviderIds(enabled);
        return loadEnabledProviders(enabled);
      })
      .catch((error) => setNotice(String(error)));
    const startedListener = listen<Translation>("translation-started", (event) => {
      activationGraceUntilRef.current = Date.now() + 400;
      applyTranslationSnapshot(event.payload);
    });
    const resultListener = listen<Translation>("translation-result", (event) => {
      activationGraceUntilRef.current = Date.now() + 400;
      applyTranslationSnapshot(event.payload);
    });
    const errorListener = listen<TranslationError>("translation-error", (event) => {
      if (!acceptRequest(event.payload.requestId)) return;
      activationGraceUntilRef.current = Date.now() + 400;
      setLoading(false);
      setNotice(event.payload.message);
    });
    const settingsListener = listen("open-settings", () => { switchSettingsPage("providers"); setShowSettings(true); setShowQuickTranslate(false); setNotice(""); });
    const windowListener = listen("translation-window:open", () => {
      activationGraceUntilRef.current = Date.now() + 500;
      setShowSettings(false);
      setShowQuickTranslate(false);
      setNotice("");
    });
    const quickTranslateListener = listen("quick-translate:open", () => {
      activationGraceUntilRef.current = Date.now() + 500;
      setShowSettings(false);
      setShowQuickTranslate(true);
      setNotice("");
    });
    const activeProviderListener = listen<ActiveProviderChanged>("active-provider-changed", (event) => {
      setActiveProviderId(event.payload.providerId);
      setActiveProviderModel(event.payload.model);
      setExpandedProviderIds([event.payload.providerId]);
      setHasApiKey(true);
    });
    const enabledProvidersListener = listen<ProviderId[]>("enabled-providers-changed", (event) => {
      const enabled = event.payload ?? [];
      if (enabled[0]) setActiveProviderId(enabled[0]);
      setExpandedProviderIds(enabled);
      void loadEnabledProviders(enabled).catch((error) => setNotice(String(error)));
    });
    void nativeInvoke<Translation | null>("get_latest_translation")
      .then((snapshot) => {
        if (snapshot) applyTranslationSnapshot(snapshot);
      })
      .catch(() => undefined);
    return () => {
      void startedListener.then((remove) => remove());
      void resultListener.then((remove) => remove());
      void errorListener.then((remove) => remove());
      void settingsListener.then((remove) => remove());
      void windowListener.then((remove) => remove());
      void quickTranslateListener.then((remove) => remove());
      void activeProviderListener.then((remove) => remove());
      void enabledProvidersListener.then((remove) => remove());
    };
  }, []);

  useEffect(() => {
    if (!isTauriDesktop() || !result || !translationIsPending(result)) return;
    const timer = window.setInterval(() => {
      void nativeInvoke<Translation | null>("get_latest_translation")
        .then((snapshot) => {
          if (!snapshot || snapshot.requestId !== result.requestId
            || JSON.stringify(snapshot.results) === JSON.stringify(result.results)) return;
          applyTranslationSnapshot(snapshot);
        })
        .catch(() => undefined);
    }, 150);
    return () => window.clearInterval(timer);
  }, [result]);

  useEffect(() => {
    if (preferencesError) setNotice(preferencesError);
  }, [preferencesError]);

  useEffect(() => {
    if (quickTranslateProvider && enabledProviderIds.includes(quickTranslateProvider)) {
      setQuickTranslateProviderId(quickTranslateProvider);
      return;
    }
    setQuickTranslateProviderId((current) => enabledProviderIds.includes(current) ? current : (enabledProviderIds[0] ?? current));
  }, [enabledProviderIds, quickTranslateProvider]);

  async function translate() {
    if (!text.trim()) return;
    const attempt = latestTranslationAttempt.current + 1;
    latestTranslationAttempt.current = attempt;
    setLoading(true);
    setNotice("");
    setExpandedProviderIds(enabledProviderIds);
    try {
      const translated = await nativeInvoke<Translation>("translate_text", { text, provider: quickTranslateProviderId });
      if (attempt !== latestTranslationAttempt.current || !acceptRequest(translated.requestId)) return;
      const providerId = translated.results[0]?.providerId ?? activeProviderId;
      setActiveProviderId(providerId);
      if (translated.results[0]?.model) setActiveProviderModel(translated.results[0].model);
      setExpandedProviderIds(translated.results.map((item) => item.providerId));
      setResult(translated);
      setShowQuickTranslate(false);
    } catch (error) {
      if (attempt === latestTranslationAttempt.current) setNotice(String(error));
    } finally {
      if (attempt === latestTranslationAttempt.current) setLoading(false);
    }
  }

  function switchSettingsPage(page: SettingsPage) {
    setSettingsPage(page);
    if (page === "providers" && !SETTINGS_PROVIDERS.some((provider) => provider.id === selectedSettingsProviderId)) {
      setSelectedSettingsProviderId(SETTINGS_PROVIDERS[0].id);
    }
    if (page === "generic" && !GENERIC_PROVIDERS.some((provider) => provider.id === selectedSettingsProviderId)) {
      setSelectedSettingsProviderId(GENERIC_PROVIDERS[0].id);
    }
  }

  function selectSettingsProvider(providerId: SettingsProviderId) {
    setSelectedSettingsProviderId(providerId);
    setConnectionState({ providerId: null, status: "idle", message: "" });
  }

  function updateSelectedDraft(field: keyof ProviderDraft, value: string | boolean) {
    setProviderDrafts((drafts) => ({
      ...drafts,
      [selectedSettingsProviderId]: { ...drafts[selectedSettingsProviderId], [field]: value },
    }));
  }

  async function saveProviderConfig() {
    const provider = ALL_SETTINGS_PROVIDERS.find((item) => item.id === selectedSettingsProviderId);
    const draft = providerDrafts[selectedSettingsProviderId];
    if (!provider || !draft.baseUrl.trim() || !draft.model.trim()) {
      setNotice("请填写完整的 Base URL 和模型名称。");
      return;
    }
    try {
      await nativeInvoke("save_provider_config", {
        provider: provider.id,
        apiKey: draft.apiKey,
        baseUrl: draft.baseUrl,
        model: draft.model,
      });
      setProviderDrafts((drafts) => ({ ...drafts, [provider.id]: { ...drafts[provider.id], apiKey: "", saved: true } }));
      if (provider.id === "deepseek") setHasApiKey(true);
      setNotice(`${provider.vendor} 配置已安全保存。`);
    } catch (error) { setNotice(String(error)); }
  }

  async function testConnection() {
    const provider = ALL_SETTINGS_PROVIDERS.find((item) => item.id === selectedSettingsProviderId);
    const draft = providerDrafts[selectedSettingsProviderId];
    if (!provider) return;
    setConnectionState({ providerId: provider.id, status: "testing", message: "正在发送测试请求…" });
    try {
      const result = await nativeInvoke<{ latencyMs: number; message: string }>("test_provider_connection", {
        provider: provider.id,
        apiKey: draft.apiKey,
        baseUrl: draft.baseUrl,
        model: draft.model,
      });
      setConnectionState({ providerId: provider.id, status: "success", message: `${result.message} · ${result.latencyMs} ms` });
    } catch (error) {
      setConnectionState({ providerId: provider.id, status: "error", message: String(error) });
    }
  }

  function openQuickTranslate() {
    setShowSettings(false);
    setShowQuickTranslate(true);
    setNotice("");
  }

  function returnToFloatingTranslate() {
    setShowSettings(false);
    setShowQuickTranslate(false);
    setNotice("");
  }

  function toggleQuickTranslate() {
    if (showQuickTranslate) {
      returnToFloatingTranslate();
      return;
    }
    openQuickTranslate();
  }

  const activeProviderDefinition = AVAILABLE_TRANSLATION_PROVIDERS.find((provider) => provider.id === activeProviderId) ?? AVAILABLE_TRANSLATION_PROVIDERS[0];
  const activeProvider = { ...activeProviderDefinition, model: enabledProviderModels[activeProviderId] ?? activeProviderModel ?? activeProviderDefinition.model };
  const quickTranslateChoices = enabledProviderIds.map((providerId) => {
    const provider = AVAILABLE_TRANSLATION_PROVIDERS.find((item) => item.id === providerId);
    return provider ? { providerId, model: enabledProviderModels[providerId] ?? provider.model } : null;
  }).filter((choice): choice is ModelChoice => choice !== null);
  const selectedSettingsProvider = ALL_SETTINGS_PROVIDERS.find((provider) => provider.id === selectedSettingsProviderId) ?? SETTINGS_PROVIDERS[0];
  const selectedDraft = providerDrafts[selectedSettingsProvider.id];
  const settingsCollection = settingsPage === "generic" ? GENERIC_PROVIDERS : SETTINGS_PROVIDERS;

  function renderProviderSettings() {
    return <>
      <div className="settings-page-heading">
        <div><p className="eyebrow">{settingsPage === "generic" ? "通用接口" : "AI 提供商"}</p><h1>{settingsPage === "generic" ? "通用接口配置" : "厂商接口配置"}</h1></div>
        <span className="settings-page-meta">{settingsCollection.length} 个接口</span>
      </div>
      <p className="settings-description">{settingsPage === "generic" ? "使用标准协议连接 OpenAI、Google Gemini 或 Anthropic，也可以替换为兼容这些协议的服务。" : "选择一个厂商，配置 API Key 和模型。密钥保存到 Windows 凭据管理器。"}</p>
      <div className="settings-provider-grid">
        {settingsCollection.map((provider) => <button className={`settings-provider-card ${provider.id === selectedSettingsProvider.id ? "is-selected" : ""}`} key={provider.id} onClick={() => selectSettingsProvider(provider.id)}>
          <ProviderIcon provider={provider} />
          <span className="settings-provider-card-copy"><strong>{provider.vendor}</strong><small>{provider.model}</small></span>
          <span className="settings-protocol-badge">{provider.protocol === "openai" ? "OpenAI 兼容" : provider.protocol === "google" ? "Gemini" : "Messages"}</span>
        </button>)}
      </div>
      <div className="settings-form-card">
        <div className="settings-form-heading"><div><p className="eyebrow">当前配置</p><h2>{selectedSettingsProvider.vendor}</h2></div><span className="settings-form-model">{selectedSettingsProvider.model}</span></div>
        <label className="field-label" htmlFor="provider-api-key">API Key</label>
        <input id="provider-api-key" value={selectedDraft.apiKey} onChange={(event) => updateSelectedDraft("apiKey", event.target.value)} type="password" placeholder={selectedDraft.saved ? "已保存，留空以保留当前 Key" : "粘贴 API Key"} />
        <label className="field-label settings-field-label" htmlFor="provider-base-url">Base URL</label>
        <input id="provider-base-url" value={selectedDraft.baseUrl} onChange={(event) => updateSelectedDraft("baseUrl", event.target.value)} spellCheck={false} />
        <label className="field-label settings-field-label" htmlFor="provider-model">模型名称</label>
        <input id="provider-model" value={selectedDraft.model} onChange={(event) => updateSelectedDraft("model", event.target.value)} spellCheck={false} />
        <p className="settings-form-help">{selectedSettingsProvider.summary}</p>
        {connectionState.providerId === selectedSettingsProvider.id && connectionState.status !== "idle" && <p className={`connection-result ${connectionState.status}`} role="status">{connectionState.message}</p>}
        <div className="action-row settings-actions"><button className="primary" onClick={() => void saveProviderConfig()}>保存配置</button><button className="secondary" onClick={() => void testConnection()} disabled={connectionState.status === "testing"}>{connectionState.status === "testing" ? "测试中…" : "测试连接"}</button></div>
      </div>
    </>;
  }

  function renderProviderSettingsWithKey() {
    const generic = settingsPage === "generic";
    return <>
      <div className="settings-page-heading"><div><p className="eyebrow">{generic ? "通用接口" : "AI 提供商"}</p><h1>{generic ? "通用接口配置" : "厂商接口配置"}</h1></div><span className="settings-page-meta">{settingsCollection.length} 个接口</span></div>
      <p className="settings-description">{generic ? "使用 OpenAI、Google Gemini 或 Anthropic 的标准接口，也可以替换为兼容这些协议的服务。" : "选择一个厂商，配置 API Key、Base URL 和模型。密钥由 Windows 凭据管理器保护。"}</p>
      <div className="settings-provider-grid">
        {settingsCollection.map((provider) => <button className={`settings-provider-card ${provider.id === selectedSettingsProvider.id ? "is-selected" : ""}`} key={provider.id} onClick={() => selectSettingsProvider(provider.id)}>
          <ProviderIcon provider={provider} />
          <span className="settings-provider-card-copy"><strong>{provider.vendor}</strong><small>{provider.model}</small></span>
          <span className="settings-protocol-badge">{provider.protocol === "openai" ? "OpenAI 兼容" : provider.protocol === "google" ? "Gemini" : "Messages"}</span>
        </button>)}
      </div>
      <div className="settings-form-card">
        <div className="settings-form-heading"><div><p className="eyebrow">当前配置</p><h2>{selectedSettingsProvider.vendor}</h2></div><span className="settings-form-model">{selectedSettingsProvider.model}</span></div>
        <label className="field-label" htmlFor="provider-api-key">API Key</label>
        <div className="api-key-input-wrap">
          <input id="provider-api-key" value={selectedDraft.apiKey} onChange={(event) => updateSelectedDraft("apiKey", event.target.value)} type={showApiKey ? "text" : "password"} placeholder={selectedDraft.saved ? "已保存，留空以保留当前 Key" : "粘贴 API Key"} />
          <button type="button" className="api-key-toggle" onClick={() => setShowApiKey((visible) => !visible)} aria-label={showApiKey ? "隐藏 API Key" : "显示 API Key"} title={showApiKey ? "隐藏 API Key" : "显示 API Key"}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.4-5.5 9.5-5.5 9.5 5.5 9.5 5.5-3.4 5.5-9.5 5.5S2.5 12 2.5 12Z" /><circle cx="12" cy="12" r="2.5" /></svg>
          </button>
        </div>
        <label className="field-label settings-field-label" htmlFor="provider-base-url">Base URL</label>
        <input id="provider-base-url" value={selectedDraft.baseUrl} onChange={(event) => updateSelectedDraft("baseUrl", event.target.value)} spellCheck={false} />
        <label className="field-label settings-field-label" htmlFor="provider-model">模型名称</label>
        <input id="provider-model" value={selectedDraft.model} onChange={(event) => updateSelectedDraft("model", event.target.value)} spellCheck={false} />
        <p className="settings-form-help">{selectedSettingsProvider.summary}</p>
        {connectionState.providerId === selectedSettingsProvider.id && connectionState.status !== "idle" && <p className={`connection-result ${connectionState.status}`} role="status">{connectionState.message}</p>}
        <div className="action-row settings-actions"><button className="primary" onClick={() => void saveProviderConfig()}>保存配置</button><button className="secondary" onClick={() => void testConnection()} disabled={connectionState.status === "testing"}>{connectionState.status === "testing" ? "测试中…" : "测试连接"}</button></div>
      </div>
    </>;
  }

  function renderConnectionPage() {
    return <>
      <div className="settings-page-heading"><div><p className="eyebrow">连通性</p><h1>连接测试</h1></div><span className="settings-page-meta">实时请求</span></div>
      <p className="settings-description">选择一个已配置的接口，发送最小测试请求，确认地址、密钥和模型都可用。</p>
      <div className="connection-selector-card">
        <label className="field-label" htmlFor="connection-provider">测试接口</label>
        <select id="connection-provider" value={selectedSettingsProvider.id} onChange={(event) => selectSettingsProvider(event.target.value as SettingsProviderId)}>
          <optgroup label="AI 提供商">{SETTINGS_PROVIDERS.map((provider) => <option value={provider.id} key={provider.id}>{provider.vendor} · {provider.model}</option>)}</optgroup>
          <optgroup label="通用接口">{GENERIC_PROVIDERS.map((provider) => <option value={provider.id} key={provider.id}>{provider.vendor} · {provider.model}</option>)}</optgroup>
        </select>
        <div className="connection-summary"><ProviderIcon provider={selectedSettingsProvider} /><div><strong>{selectedSettingsProvider.vendor}</strong><span>{selectedDraft.baseUrl}</span><span>{selectedDraft.model}</span></div></div>
        {connectionState.providerId === selectedSettingsProvider.id && connectionState.status !== "idle" && <p className={`connection-result ${connectionState.status}`} role="status">{connectionState.message}</p>}
        <button className="primary connection-test-button" onClick={() => void testConnection()} disabled={connectionState.status === "testing"}>{connectionState.status === "testing" ? "正在测试…" : "开始测试连接"}</button>
      </div>
      <div className="connection-note"><span className="note-mark">i</span><p>测试只发送一条“Reply with OK only.”请求，不会触发翻译，也不会保存明文 API Key。</p></div>
    </>;
  }

  function renderGeneralPage() {
    return <>
      <div className="settings-page-heading"><div><p className="eyebrow">偏好</p><h1>界面设置</h1></div></div>
      <p className="settings-description">调整悬浮翻译按钮和翻译结果窗口的显示方式。</p>
      <div className="preference-list">
        <label className="preference-row"><span><strong>选中文本自动显示悬浮按钮</strong><small>鼠标完成选区后显示翻译入口</small></span><input type="checkbox" checked={autoSelection} onChange={(event) => setAutoSelection(event.target.checked)} /></label>
        <label className="preference-row"><span><strong>翻译窗口保持置顶</strong><small>结果窗口不会被其他窗口遮挡</small></span><input type="checkbox" checked={keepOnTop} onChange={(event) => setKeepOnTop(event.target.checked)} /></label>
      </div>
      <div className="settings-info-card"><strong>接口扩展</strong><p>新增厂商时，请先在对应页面填写 Base URL、模型和 API Key，再用连接测试确认配置可用。</p></div>
    </>;
  }

  return <main className="app-shell">
    <header className="titlebar" onMouseDown={beginTitlebarDrag} onMouseUp={finishTitlebarDrag}>
      <div className="titlebar-start">
        <img className="app-icon" src={appIcon} alt="AI Translate 翻译图标" />
        <span className="app-name">AI Translate</span>
      </div>
      <div className="titlebar-actions">
        <button className={`titlebar-quick-action${showQuickTranslate ? " is-active" : ""}`} type="button" onClick={toggleQuickTranslate} aria-label={showQuickTranslate ? "返回悬浮翻译" : "快速翻译"} title={showQuickTranslate ? "返回悬浮翻译" : "快速翻译"}>
          {showQuickTranslate ? <ReturnToFloatIcon /> : <QuickTranslateIcon />}
        </button>
        <button className={`titlebar-icon-button titlebar-pin${keepOnTop ? " is-active" : ""}`} type="button" onClick={() => setKeepOnTop(!keepOnTop)} aria-label={keepOnTop ? "取消置顶" : "置顶"} aria-pressed={keepOnTop} title={keepOnTop ? "取消置顶" : "置顶"}>
          <Icon name="pin" />
        </button>
        <button className="titlebar-icon-button" onClick={() => void nativeInvoke("open_settings_window").catch((error) => setNotice(String(error)))} aria-label="更多操作">
          <Icon name="menu" />
        </button>
        <button className="titlebar-icon-button titlebar-minimize" type="button" onClick={() => void nativeInvoke<void>("minimize_window").catch(() => undefined)} aria-label="最小化" title="最小化">
          <Icon name="minimize" />
        </button>
        <button className="titlebar-icon-button titlebar-close" type="button" onClick={() => void nativeInvoke("hide_window")} aria-label="关闭" title="关闭翻译窗口">
          <Icon name="close" />
        </button>
      </div>
    </header>

    {showSettings ? <section className="settings-shell">
      <aside className="settings-sidebar">
        <div className="settings-sidebar-title"><span className="sidebar-mark">AI</span><div><strong>设置中心</strong><small>AI Translate</small></div></div>
        <nav className="settings-nav" aria-label="设置页面">
          <button aria-label="AI 提供商" className={settingsPage === "providers" ? "is-active" : ""} onClick={() => switchSettingsPage("providers")}><span aria-hidden="true">◈</span>AI 提供商</button>
          <button aria-label="通用接口" className={settingsPage === "generic" ? "is-active" : ""} onClick={() => switchSettingsPage("generic")}><span aria-hidden="true">◇</span>通用接口</button>
          <button aria-label="连接测试" className={settingsPage === "connection" ? "is-active" : ""} onClick={() => switchSettingsPage("connection")}><span aria-hidden="true">⌁</span>连接测试</button>
          <button aria-label="界面设置" className={settingsPage === "general" ? "is-active" : ""} onClick={() => switchSettingsPage("general")}><span aria-hidden="true">⚙</span>界面设置</button>
        </nav>
        <button className="settings-back" onClick={() => setShowSettings(false)}>← 返回翻译</button>
      </aside>
      <div className="settings-main">
        {settingsPage === "connection" ? renderConnectionPage() : settingsPage === "general" ? renderGeneralPage() : settingsPage === "providers" || settingsPage === "generic" ? renderProviderSettingsWithKey() : renderProviderSettings()}
        {notice && <p className="notice" role="status">{notice}</p>}
      </div>
    </section> : <section className={`content${showQuickTranslate ? " quick-content" : ""}`}>
      {showQuickTranslate ? <div className="quick-translate-page">
        <div className="quick-translate-heading"><p className="eyebrow">快速翻译</p></div>
        {!hasApiKey && <div className="warning"><span className="warning-icon" aria-hidden="true">!</span><p>请先在设置中配置并选择一个翻译模型。</p></div>}
        <div className="quick-model-picker"><ModelPicker value={quickTranslateProviderId} choices={quickTranslateChoices} onChange={setQuickTranslateProviderId} ariaLabel="选择翻译模型" disabled={!enabledProviderIds.length} /></div>
        <div className="input-card"><div className="input-head"><label className="field-label" htmlFor="translation-input">输入文本</label><span className="character-count">{text.length} 字符</span></div>
          <textarea ref={inputRef} id="translation-input" className={/[A-Za-z]/.test(text) ? "is-mixed-language" : undefined} value={text} onChange={(event) => setText(event.target.value)} placeholder="输入要翻译的文字…" />
        </div>
        <div className="quick-translate-action"><button className="primary" disabled={loading || !text.trim()} onClick={() => void translate()}>{loading ? "翻译中…" : "翻译"}</button></div>
      </div> : result ? <div className="translation-result">
        <div className="provider-list">
          {result.results.map((providerResult) => {
            const providerDefinition = AVAILABLE_TRANSLATION_PROVIDERS.find((provider) => provider.id === providerResult.providerId) ?? activeProvider;
            const provider = { ...providerDefinition, model: providerResult.model || providerDefinition.model };
            const isOpen = expandedProviderIds.includes(provider.id);
            return <article className={`provider-card ${isOpen ? "is-open" : "is-closed"} is-active`} key={provider.id}>
              <button className="provider-header" onClick={() => setExpandedProviderIds((ids) => isOpen ? ids.filter((id) => id !== provider.id) : [...ids, provider.id])} aria-expanded={isOpen}>
                <ProviderIcon provider={provider} />
                <span className="provider-heading"><strong>{provider.model}/{provider.vendor}</strong></span>
                <Icon name="chevron" />
              </button>
              {isOpen && <div className="provider-body">
                {providerResult.translation ? <>
                  <div className="text-line"><ExpandableText kind="source" text={normalizeParagraphText(result.source)} /></div>
                  <div className="text-line translation-line"><ExpandableText kind="translation" text={providerResult.translation} textClassName={isMostlyEnglish(providerResult.translation) ? "translation-english" : undefined} /></div>
                </> : <div className="provider-placeholder"><span className="placeholder-dot" />{providerResult.error ?? (loading ? "翻译中…" : "翻译失败")}</div>}
              </div>}
            </article>;
          })}
        </div>
      </div> : <div className="floating-empty-state">
        <div className="floating-empty-mark" aria-hidden="true"><QuickTranslateIcon /></div>
        <p className="eyebrow">悬浮翻译</p>
        <h1>选中文本开始翻译</h1>
        <p className="hint">在任意应用中选中文本，翻译入口会出现在选区旁边。</p>
        <div className="floating-empty-tip"><span>选中文本后，点击悬浮翻译按钮即可开始</span></div>
      </div>}{notice && <p className="notice" role="status">{notice}</p>}
    </section>}
  </main>;
}

function LegacySettingsWindow() {
  const [settingsPage, setSettingsPage] = useState<SettingsPage>("providers");
  const [selectedSettingsProviderId, setSelectedSettingsProviderId] = useState<SettingsProviderId>("deepseek");
  const [providerDrafts, setProviderDrafts] = useState<Record<SettingsProviderId, ProviderDraft>>(createProviderDrafts);
  const [connectionState, setConnectionState] = useState<ConnectionState>({ providerId: null, status: "idle", message: "" });
  const { autoSelection, keepOnTop, setAutoSelection, setKeepOnTop, preferencesError } = useUserPreferences();
  const [notice, setNotice] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [providerSearch, setProviderSearch] = useState("");
  const [enabledProviders, setEnabledProviders] = useState<Partial<Record<SettingsProviderId, boolean>>>({ deepseek: true });

  useEffect(() => {
    if (preferencesError) setNotice(preferencesError);
  }, [preferencesError]);

  const selectedSettingsProvider = ALL_SETTINGS_PROVIDERS.find((provider) => provider.id === selectedSettingsProviderId) ?? SETTINGS_PROVIDERS[0];
  const selectedDraft = providerDrafts[selectedSettingsProvider.id];
  const settingsCollection = settingsPage === "generic" ? GENERIC_PROVIDERS : SETTINGS_PROVIDERS;
  const filteredProviders = settingsCollection.filter((provider) => {
    const query = providerSearch.trim().toLowerCase();
    return !query || `${provider.vendor} ${provider.model}`.toLowerCase().includes(query);
  });

  useEffect(() => {
    if (!isTauriDesktop()) return;
    let cancelled = false;
    void nativeInvoke<ProviderConfigResponse | null>("get_provider_config", { provider: selectedSettingsProviderId })
      .then((config) => {
        if (cancelled || !config) return;
        setProviderDrafts((drafts) => ({
          ...drafts,
          [selectedSettingsProviderId]: { apiKey: config.apiKey, baseUrl: config.baseUrl, model: config.model, saved: true },
        }));
        setEnabledProviders((providers) => ({ ...providers, [selectedSettingsProviderId]: true }));
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [selectedSettingsProviderId]);

  function dragWindow(event: MouseEvent<HTMLElement>) {
    if ((event.target as HTMLElement).closest("button, input, textarea, select")) return;
    void getCurrentWindow().startDragging();
  }

  function switchSettingsPage(page: SettingsPage) {
    setSettingsPage(page);
    if (page === "providers" && !SETTINGS_PROVIDERS.some((provider) => provider.id === selectedSettingsProviderId)) {
      setSelectedSettingsProviderId(SETTINGS_PROVIDERS[0].id);
    }
    if (page === "generic" && !GENERIC_PROVIDERS.some((provider) => provider.id === selectedSettingsProviderId)) {
      setSelectedSettingsProviderId(GENERIC_PROVIDERS[0].id);
    }
  }

  function selectSettingsProvider(providerId: SettingsProviderId) {
    setSelectedSettingsProviderId(providerId);
    setSettingsPage(GENERIC_PROVIDERS.some((provider) => provider.id === providerId) ? "generic" : "providers");
    setConnectionState({ providerId: null, status: "idle", message: "" });
    setShowApiKey(false);
  }

  function updateSelectedDraft(field: keyof ProviderDraft, value: string) {
    setProviderDrafts((drafts) => ({
      ...drafts,
      [selectedSettingsProviderId]: { ...drafts[selectedSettingsProviderId], [field]: value },
    }));
  }

  async function saveProviderConfig() {
    const provider = selectedSettingsProvider;
    const draft = providerDrafts[provider.id];
    if (!draft.baseUrl.trim() || !draft.model.trim()) {
      setNotice("请填写完整的 Base URL 和模型名称。");
      return;
    }
    try {
      await nativeInvoke("save_provider_config", { provider: provider.id, apiKey: draft.apiKey, baseUrl: draft.baseUrl, model: draft.model });
      const savedConfig = await nativeInvoke<ProviderConfigResponse | null>("get_provider_config", { provider: provider.id });
      setProviderDrafts((drafts) => ({
        ...drafts,
        [provider.id]: {
          ...drafts[provider.id],
          apiKey: savedConfig?.apiKey ?? draft.apiKey,
          baseUrl: savedConfig?.baseUrl ?? draft.baseUrl,
          model: savedConfig?.model ?? draft.model,
          saved: true,
        },
      }));
      setEnabledProviders((providers) => ({ ...providers, [provider.id]: true }));
      setNotice(`${provider.vendor} 配置已安全保存。`);
    } catch (error) {
      setNotice(String(error));
    }
  }

  async function testConnection() {
    const provider = selectedSettingsProvider;
    const draft = providerDrafts[provider.id];
    setConnectionState({ providerId: provider.id, status: "testing", message: "正在发送测试请求…" });
    try {
      const result = await nativeInvoke<{ latencyMs: number; message: string }>("test_provider_connection", {
        provider: provider.id, apiKey: draft.apiKey, baseUrl: draft.baseUrl, model: draft.model,
      });
      setConnectionState({ providerId: provider.id, status: "success", message: `${result.message} · ${result.latencyMs} ms` });
    } catch (error) {
      setConnectionState({ providerId: provider.id, status: "error", message: String(error) });
    }
  }

  function renderProviderDetails() {
    const apiPath = selectedSettingsProvider.protocol === "google" ? "/models/{model}:generateContent" : selectedSettingsProvider.protocol === "anthropic" ? "/messages" : "/chat/completions";
    const isEnabled = enabledProviders[selectedSettingsProvider.id] ?? selectedDraft.saved;
    return <div className="provider-detail-content">
      <h1 className="sr-only">{settingsPage === "generic" ? "通用接口配置" : "厂商接口配置"}</h1>
      <header className="settings-detail-heading" onMouseDown={dragWindow}>
        <div className="settings-detail-title"><h1>{selectedSettingsProvider.vendor}</h1><button className="detail-gear" type="button" onClick={() => setSettingsPage("general")} aria-label="打开偏好设置" title="偏好设置">⚙</button></div>
        <label className="settings-switch" title={isEnabled ? "停用当前接口" : "启用当前接口"}>
          <input type="checkbox" checked={isEnabled} onChange={(event) => setEnabledProviders((providers) => ({ ...providers, [selectedSettingsProvider.id]: event.target.checked }))} />
          <span aria-hidden="true" />
        </label>
      </header>

      <div className="settings-form-layout">
        <div className="settings-field-group">
          <div className="settings-label-row"><label className="field-label" htmlFor="provider-api-key">API Key</label><button className="inline-test" type="button" onClick={() => void testConnection()} disabled={connectionState.status === "testing"}><span aria-hidden="true">♡</span>{connectionState.status === "testing" ? "测试中" : "测试"}</button></div>
          <div className="api-key-input-wrap"><input id="provider-api-key" value={selectedDraft.apiKey} onChange={(event) => updateSelectedDraft("apiKey", event.target.value)} type={showApiKey ? "text" : "password"} placeholder={selectedDraft.saved ? "已保存，留空以保留当前 Key" : "粘贴 API Key"} /><button type="button" className="api-key-toggle" onClick={() => setShowApiKey((visible) => !visible)} aria-label={showApiKey ? "隐藏 API Key" : "显示 API Key"} title={showApiKey ? "隐藏 API Key" : "显示 API Key"}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.4-5.5 9.5-5.5 9.5 5.5 9.5 5.5-3.4 5.5-9.5 5.5S2.5 12 2.5 12Z" /><circle cx="12" cy="12" r="2.5" /></svg></button></div>
        </div>
        <div className="settings-field-group"><label className="field-label" htmlFor="provider-base-url">API Base URL</label><input id="provider-base-url" value={selectedDraft.baseUrl} onChange={(event) => updateSelectedDraft("baseUrl", event.target.value)} spellCheck={false} /></div>
        <div className="settings-field-group"><label className="field-label" htmlFor="provider-api-path">API 路径</label><input id="provider-api-path" value={apiPath} readOnly spellCheck={false} /></div>
      </div>

      <section className="model-section">
        <div className="model-section-header"><div className="model-section-title"><h2>模型</h2><span>{selectedDraft.model ? "1" : "0"}</span></div><div className="model-toolbar"><button type="button" aria-label="添加模型" title="添加模型"><ModelAddIcon /></button><button className="fetch-models" type="button" onClick={() => setNotice("模型列表已刷新。")}><ModelRefreshIcon /><span>获取</span></button></div></div>
        <div className="model-group"><div className="model-group-heading"><strong>{selectedSettingsProvider.vendor}</strong></div><div className="model-row"><ProviderIcon provider={selectedSettingsProvider} /><label className="model-input-label" htmlFor="provider-model"><span className="sr-only">模型名称</span><input id="provider-model" value={selectedDraft.model} onChange={(event) => updateSelectedDraft("model", event.target.value)} spellCheck={false} /></label><div className="model-row-actions"><button type="button" aria-label="固定模型" title="固定模型">⌖</button><button type="button" aria-label="模型参数" title="模型参数">⌘</button><button type="button" aria-label="模型设置" title="模型设置">☷</button><button type="button" aria-label="移除模型" title="移除模型">−</button></div></div></div>
      </section>

      <div className="provider-detail-footer"><div className="action-row settings-actions"><button className="primary" onClick={() => void saveProviderConfig()}>保存配置</button></div></div>
      {connectionState.providerId === selectedSettingsProvider.id && connectionState.status !== "idle" && <p className={`connection-result ${connectionState.status}`} role="status">{connectionState.message}</p>}
    </div>;
  }

  function renderConnectionPage() {
    return <>
      <div className="settings-page-heading"><div><p className="eyebrow">连通性</p><h1>连接测试</h1></div><span className="settings-page-meta">实时请求</span></div>
      <p className="settings-description">选择一个已配置的接口，发送最小测试请求，确认地址、密钥和模型都可用。</p>
      <div className="connection-selector-card">
        <label className="field-label" htmlFor="connection-provider">测试接口</label>
        <select id="connection-provider" value={selectedSettingsProvider.id} onChange={(event) => selectSettingsProvider(event.target.value as SettingsProviderId)}>
          <optgroup label="AI 提供商">{SETTINGS_PROVIDERS.map((provider) => <option value={provider.id} key={provider.id}>{provider.vendor} · {provider.model}</option>)}</optgroup>
          <optgroup label="通用接口">{GENERIC_PROVIDERS.map((provider) => <option value={provider.id} key={provider.id}>{provider.vendor} · {provider.model}</option>)}</optgroup>
        </select>
        <div className="connection-summary"><ProviderIcon provider={selectedSettingsProvider} /><div><strong>{selectedSettingsProvider.vendor}</strong><span>{selectedDraft.baseUrl}</span><span>{selectedDraft.model}</span></div></div>
        {connectionState.providerId === selectedSettingsProvider.id && connectionState.status !== "idle" && <p className={`connection-result ${connectionState.status}`} role="status">{connectionState.message}</p>}
        <button className="primary connection-test-button" onClick={() => void testConnection()} disabled={connectionState.status === "testing"}>{connectionState.status === "testing" ? "正在测试…" : "开始测试连接"}</button>
      </div>
      <div className="connection-note"><span className="note-mark">i</span><p>测试只发送一条最小请求，不会触发翻译，也不会保存明文 API Key。</p></div>
    </>;
  }

  function renderGeneralPage() {
    return <>
      <div className="settings-page-heading"><div><p className="eyebrow">偏好</p><h1>界面设置</h1></div></div>
      <p className="settings-description">调整悬浮翻译按钮和翻译结果窗口的显示方式。</p>
      <div className="preference-list">
        <label className="preference-row"><span><strong>选中文本自动显示悬浮按钮</strong><small>鼠标完成选区后显示翻译入口</small></span><input type="checkbox" checked={autoSelection} onChange={(event) => setAutoSelection(event.target.checked)} /></label>
        <label className="preference-row"><span><strong>翻译窗口保持置顶</strong><small>结果窗口不会被其他窗口遮挡</small></span><input type="checkbox" checked={keepOnTop} onChange={(event) => setKeepOnTop(event.target.checked)} /></label>
      </div>
      <div className="settings-info-card"><strong>接口扩展</strong><p>新增厂商时，在对应页面填写 Base URL、模型和 API Key，再使用连接测试确认配置可用。</p></div>
    </>;
  }

  function renderProviderPanel() {
    return <aside className="settings-provider-panel">
      <div className="provider-panel-heading" onMouseDown={dragWindow}><div><p className="provider-panel-kicker">AI Translate</p><h2>接口供应商</h2></div><button className="panel-add-icon" type="button" onClick={() => setNotice("请从列表中选择一个供应商进行配置。")} aria-label="添加供应商" title="添加供应商">＋</button></div>
      <div className="provider-search"><SearchIcon /><input aria-label="搜索供应商或分组" value={providerSearch} onChange={(event) => setProviderSearch(event.target.value)} placeholder="搜索供应商或分组" /></div>
      <div className="provider-mode-switch" aria-label="接口类型"><button type="button" className={settingsPage === "providers" ? "is-active" : ""} onClick={() => switchSettingsPage("providers")}>厂商接口</button><button type="button" className={settingsPage === "generic" ? "is-active" : ""} onClick={() => switchSettingsPage("generic")}>通用接口</button></div>
      <div className="provider-list-heading"><span>{settingsPage === "generic" ? "通用接口" : "AI 提供商"}</span><strong>{filteredProviders.length}</strong></div>
      <nav className="provider-list-nav" aria-label="供应商列表">{filteredProviders.map((provider) => { const enabled = enabledProviders[provider.id] ?? providerDrafts[provider.id].saved; return <button type="button" className={`provider-list-item ${provider.id === selectedSettingsProvider.id ? "is-selected" : ""}`} key={provider.id} onClick={() => selectSettingsProvider(provider.id)}><ProviderIcon provider={provider} /><span className="provider-list-copy"><strong>{provider.vendor}</strong></span><span className={`provider-list-status ${enabled ? "is-enabled" : ""}`}>{enabled ? "启用" : "禁用"}</span></button>; })}</nav>
      <div className="provider-panel-footer"><button type="button" className={settingsPage === "connection" ? "is-active" : ""} onClick={() => setSettingsPage("connection")}><span aria-hidden="true">◌</span>连接测试</button><button type="button" className={settingsPage === "general" ? "is-active" : ""} onClick={() => setSettingsPage("general")}><span aria-hidden="true">⚙</span>界面设置</button><button type="button" className="provider-add-button" onClick={() => setNotice("请从列表中选择一个供应商进行配置。")}>＋ 添加</button></div>
    </aside>;
  }

  return <main className="app-shell settings-window-shell">
    <section className="settings-shell">
      {renderProviderPanel()}
      <div className="settings-main">
        {settingsPage === "connection" ? renderConnectionPage() : settingsPage === "general" ? renderGeneralPage() : renderProviderDetails()}
        {notice && <p className="notice" role="status">{notice}</p>}
      </div>
    </section>
  </main>;
}

function SettingsWindow() {
  const [settingsPage, setSettingsPage] = useState<SettingsPage>("providers");
  const [selectedSettingsProviderId, setSelectedSettingsProviderId] = useState<SettingsProviderId>("deepseek");
  const [providerDrafts, setProviderDrafts] = useState<Record<SettingsProviderId, ProviderDraft>>(createProviderDrafts);
  const [connectionState, setConnectionState] = useState<ConnectionState>({ providerId: null, status: "idle", message: "" });
  const { autoSelection, keepOnTop, quickTranslateProvider, setAutoSelection, setKeepOnTop, setQuickTranslateProvider, preferencesError } = useUserPreferences();
  const [notice, setNotice] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [providerSearch, setProviderSearch] = useState("");
  const [enabledProviders, setEnabledProviders] = useState<Partial<Record<SettingsProviderId, boolean>>>({});
  const [enabledProviderIds, setEnabledProviderIds] = useState<SettingsProviderId[]>([]);
  const [settingsEnabledProviderModels, setSettingsEnabledProviderModels] = useState<Partial<Record<ProviderId, string>>>({});
  const [addedGenericProviders, setAddedGenericProviders] = useState<GenericProviderId[]>([]);
  const [isAddingProvider, setIsAddingProvider] = useState(false);
  const [addProviderId, setAddProviderId] = useState<GenericProviderId>("openai");
  const [addProviderName, setAddProviderName] = useState(GENERIC_PROVIDERS[0].vendor);
  const [useResponsesApi, setUseResponsesApi] = useState(false);
  const [fetchedModels, setFetchedModels] = useState<Partial<Record<SettingsProviderId, string[]>>>({});
  const [fetchingProviderId, setFetchingProviderId] = useState<SettingsProviderId | null>(null);
  const [modelFetchMessage, setModelFetchMessage] = useState<{ providerId: SettingsProviderId | null; message: string }>({ providerId: null, message: "" });
  const [manualModelProviderIds, setManualModelProviderIds] = useState<SettingsProviderId[]>([]);

  useEffect(() => {
    if (preferencesError) setNotice(preferencesError);
  }, [preferencesError]);

  useEffect(() => {
    if (!isTauriDesktop()) return;
    void nativeInvoke<SettingsProviderId[]>("get_enabled_providers")
      .then((providers) => setEnabledProviderIds(providers ?? []))
      .catch((error) => setNotice(String(error)));
  }, []);

  useEffect(() => {
    if (!isTauriDesktop() || !enabledProviderIds.length) {
      setSettingsEnabledProviderModels({});
      return;
    }
    let cancelled = false;
    void Promise.all(enabledProviderIds.map(async (providerId) => {
      const config = await nativeInvoke<ProviderConfigResponse | null>("get_provider_config", { provider: providerId });
      return config?.model ? [providerId, config.model] as const : null;
    })).then((entries) => {
      if (!cancelled) setSettingsEnabledProviderModels(Object.fromEntries(entries.filter((entry): entry is readonly [ProviderId, string] => entry !== null)));
    }).catch((error) => {
      if (!cancelled) setNotice(String(error));
    });
    return () => { cancelled = true; };
  }, [enabledProviderIds]);

  const selectedSettingsProvider = ALL_SETTINGS_PROVIDERS.find((provider) => provider.id === selectedSettingsProviderId) ?? SETTINGS_PROVIDERS[0];
  const selectedDraft = providerDrafts[selectedSettingsProvider.id];
  const addProviderDefinition = GENERIC_PROVIDERS.find((provider) => provider.id === addProviderId) ?? GENERIC_PROVIDERS[0];
  const providerCollection = settingsPage === "connection"
    ? [...SETTINGS_PROVIDERS, ...GENERIC_PROVIDERS.filter((provider) => addedGenericProviders.includes(provider.id as GenericProviderId))]
    : [...SETTINGS_PROVIDERS, ...GENERIC_PROVIDERS.filter((provider) => addedGenericProviders.includes(provider.id as GenericProviderId))];
  const filteredProviders = providerCollection.filter((provider) => {
    const query = providerSearch.trim().toLowerCase();
    return !query || `${provider.vendor} ${provider.model}`.toLowerCase().includes(query);
  });
  const isProviderPage = settingsPage === "providers" || settingsPage === "generic" || settingsPage === "connection";
  const activeNavPage = isProviderPage ? "providers" : settingsPage;

  useEffect(() => {
    if (!isTauriDesktop()) return;
    let cancelled = false;
    void Promise.all(GENERIC_PROVIDERS.map(async (provider) => {
      try {
        const config = await nativeInvoke<ProviderConfigResponse | null>("get_provider_config", { provider: provider.id });
        return config ? { provider, config } : null;
      } catch {
        return null;
      }
    })).then((entries) => {
      if (cancelled) return;
      const configured = entries.filter((entry): entry is NonNullable<typeof entry> => entry !== null);
      if (!configured.length) return;
      setAddedGenericProviders(configured.map(({ provider }) => provider.id as GenericProviderId));
      setProviderDrafts((drafts) => configured.reduce((nextDrafts, { provider, config }) => ({
        ...nextDrafts,
        [provider.id]: { apiKey: config.apiKey, baseUrl: config.baseUrl, model: config.model, saved: true },
      }), drafts));
      setEnabledProviders((providers) => configured.reduce((nextProviders, { provider }) => ({ ...nextProviders, [provider.id]: true }), providers));
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!isTauriDesktop()) return;
    let cancelled = false;
    void nativeInvoke<ProviderConfigResponse | null>("get_provider_config", { provider: selectedSettingsProviderId })
      .then((config) => {
        if (cancelled || !config) return;
        setProviderDrafts((drafts) => ({
          ...drafts,
          [selectedSettingsProviderId]: { apiKey: config.apiKey, baseUrl: config.baseUrl, model: config.model, saved: true },
        }));
        setEnabledProviders((providers) => ({ ...providers, [selectedSettingsProviderId]: true }));
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [selectedSettingsProviderId]);

  function dragWindow(event: MouseEvent<HTMLElement>) {
    if ((event.target as HTMLElement).closest("button, input, textarea, select")) return;
    void getCurrentWindow().startDragging();
  }

  function switchSettingsPage(page: SettingsPage) {
    setSettingsPage(page);
    setNotice("");
    if (page === "providers" && !SETTINGS_PROVIDERS.some((provider) => provider.id === selectedSettingsProviderId)) {
      setSelectedSettingsProviderId(SETTINGS_PROVIDERS[0].id);
    }
    if (page === "generic" && !GENERIC_PROVIDERS.some((provider) => provider.id === selectedSettingsProviderId)) {
      setSelectedSettingsProviderId(GENERIC_PROVIDERS[0].id);
    }
  }

  function selectSettingsProvider(providerId: SettingsProviderId) {
    setSelectedSettingsProviderId(providerId);
    if (settingsPage === "providers" || settingsPage === "generic") {
      setSettingsPage(GENERIC_PROVIDERS.some((provider) => provider.id === providerId) ? "generic" : "providers");
    }
    setConnectionState({ providerId: null, status: "idle", message: "" });
    setModelFetchMessage({ providerId: null, message: "" });
    setShowApiKey(false);
    setNotice("");
  }

  function updateAddDraft(field: keyof ProviderDraft, value: string) {
    setProviderDrafts((drafts) => ({
      ...drafts,
      [addProviderId]: { ...drafts[addProviderId], [field]: value },
    }));
  }

  function openAddProvider(providerId: GenericProviderId = "openai") {
    const provider = GENERIC_PROVIDERS.find((item) => item.id === providerId) ?? GENERIC_PROVIDERS[0];
    setAddProviderId(provider.id as GenericProviderId);
    setAddProviderName(provider.vendor);
    setUseResponsesApi(false);
    setShowApiKey(false);
    setSettingsPage("providers");
    setNotice("");
    setIsAddingProvider(true);
  }

  function closeAddProvider() {
    setIsAddingProvider(false);
    setNotice("");
  }

  function selectAddProvider(providerId: GenericProviderId) {
    const provider = GENERIC_PROVIDERS.find((item) => item.id === providerId) ?? GENERIC_PROVIDERS[0];
    setAddProviderId(provider.id as GenericProviderId);
    setAddProviderName(provider.vendor);
    setUseResponsesApi(false);
    setNotice("");
  }

  async function addGenericProvider() {
    const provider = addProviderDefinition;
    const draft = providerDrafts[provider.id];
    const shouldEnable = enabledProviders[provider.id] ?? true;
    if (!draft.apiKey.trim() || !draft.baseUrl.trim() || !draft.model.trim()) {
      setNotice("请填写 API Key、Base URL 和模型名称。");
      return;
    }
    try {
      await nativeInvoke("save_provider_config", { provider: provider.id, apiKey: draft.apiKey, baseUrl: draft.baseUrl, model: draft.model });
      if (shouldEnable) {
        const providers = await nativeInvoke<SettingsProviderId[]>("set_provider_enabled", { provider: provider.id, enabled: true });
        setEnabledProviderIds(providers);
      }
      setAddedGenericProviders((providers) => providers.includes(provider.id as GenericProviderId) ? providers : [...providers, provider.id as GenericProviderId]);
      setSelectedSettingsProviderId(provider.id);
      setEnabledProviders((providers) => ({ ...providers, [provider.id]: shouldEnable }));
      setProviderDrafts((drafts) => ({ ...drafts, [provider.id]: { ...drafts[provider.id], saved: true } }));
      setIsAddingProvider(false);
      setNotice(`${addProviderName || provider.vendor} 已添加${shouldEnable ? "并加入翻译" : "。"}`);
    } catch (error) {
      setNotice(String(error));
    }
  }

  function updateSelectedDraft(field: keyof ProviderDraft, value: string) {
    setProviderDrafts((drafts) => ({
      ...drafts,
      [selectedSettingsProviderId]: { ...drafts[selectedSettingsProviderId], [field]: value },
    }));
  }

  async function saveProviderConfig() {
    const provider = selectedSettingsProvider;
    const draft = providerDrafts[provider.id];
    if (!draft.baseUrl.trim() || !draft.model.trim()) {
      setNotice("请填写完整的 Base URL 和模型名称。");
      return;
    }
    try {
      await nativeInvoke("save_provider_config", { provider: provider.id, apiKey: draft.apiKey, baseUrl: draft.baseUrl, model: draft.model });
      const savedConfig = await nativeInvoke<ProviderConfigResponse | null>("get_provider_config", { provider: provider.id });
      setProviderDrafts((drafts) => ({
        ...drafts,
        [provider.id]: {
          ...drafts[provider.id],
          apiKey: savedConfig?.apiKey ?? draft.apiKey,
          baseUrl: savedConfig?.baseUrl ?? draft.baseUrl,
          model: savedConfig?.model ?? draft.model,
          saved: true,
        },
      }));
      setEnabledProviders((providers) => ({ ...providers, [provider.id]: true }));
      setNotice(`${provider.vendor} 配置已安全保存。`);
    } catch (error) {
      setNotice(String(error));
    }
  }

  async function setSelectedProviderEnabled(enabled: boolean) {
    const provider = selectedSettingsProvider;
    const draft = providerDrafts[provider.id];
    try {
      if (enabled) {
        if ((!draft.saved && !draft.apiKey.trim()) || !draft.baseUrl.trim() || !draft.model.trim()) {
          setNotice("请先填写 API Key、URL 和模型名称。");
          return;
        }
        await nativeInvoke("save_provider_config", {
          provider: provider.id,
          apiKey: draft.apiKey,
          baseUrl: draft.baseUrl,
          model: draft.model,
        });
        setProviderDrafts((drafts) => ({ ...drafts, [provider.id]: { ...drafts[provider.id], saved: true } }));
        setEnabledProviders((providers) => ({ ...providers, [provider.id]: true }));
      }
      const providers = await nativeInvoke<SettingsProviderId[]>("set_provider_enabled", { provider: provider.id, enabled });
      setEnabledProviderIds(providers);
      setNotice("");
    } catch (error) {
      setNotice(String(error));
    }
  }

  async function testConnection() {
    const provider = selectedSettingsProvider;
    const draft = providerDrafts[provider.id];
    setConnectionState({ providerId: provider.id, status: "testing", message: "正在发送测试请求…" });
    try {
      const result = await nativeInvoke<{ latencyMs: number; message: string }>("test_provider_connection", {
        provider: provider.id, apiKey: draft.apiKey, baseUrl: draft.baseUrl, model: draft.model,
      });
      setConnectionState({ providerId: provider.id, status: "success", message: `${result.message} · ${result.latencyMs} ms` });
    } catch (error) {
      setConnectionState({ providerId: provider.id, status: "error", message: String(error) });
    }
  }

  async function fetchProviderModels() {
    const provider = selectedSettingsProvider;
    const draft = providerDrafts[provider.id];
    if (!draft.baseUrl.trim()) {
      setModelFetchMessage({ providerId: provider.id, message: "请先填写 URL。" });
      return;
    }
    setFetchingProviderId(provider.id);
    setModelFetchMessage({ providerId: provider.id, message: "" });
    try {
      const models = await nativeInvoke<string[]>("fetch_provider_models", {
        provider: provider.id,
        apiKey: draft.apiKey,
        baseUrl: draft.baseUrl,
      });
      setFetchedModels((current) => ({ ...current, [provider.id]: models }));
      setModelFetchMessage({ providerId: provider.id, message: "" });
    } catch (error) {
      const message = String(error).replace(provider.id, provider.vendor);
      setModelFetchMessage({ providerId: provider.id, message });
    } finally {
      setFetchingProviderId(null);
    }
  }

  function renderProviderDetails() {
    const apiPath = selectedSettingsProvider.protocol === "google" ? "/models/{model}:generateContent" : selectedSettingsProvider.protocol === "anthropic" ? "/messages" : "/chat/completions";
    const isEnabledForTranslation = enabledProviderIds.includes(selectedSettingsProvider.id);
    const availableModels = fetchedModels[selectedSettingsProvider.id] ?? [];
    const isFetchingModels = fetchingProviderId === selectedSettingsProvider.id;
    const showModelEditor = Boolean(selectedDraft.model) || availableModels.length > 0 || manualModelProviderIds.includes(selectedSettingsProvider.id);
    return <div className="provider-detail-page">
      <h1 className="sr-only">{settingsPage === "generic" ? "通用接口配置" : "厂商接口配置"}</h1>
      <div className="provider-detail-intro">
        <div><h2>{selectedSettingsProvider.vendor}</h2></div>
        <label className="settings-switch" title={isEnabledForTranslation ? "从翻译中移除" : "加入翻译"}><input type="checkbox" checked={isEnabledForTranslation} onChange={(event) => void setSelectedProviderEnabled(event.target.checked)} aria-label="启用此翻译模型" /><span aria-hidden="true" /></label>
      </div>
      <section className="settings-form-card provider-config-card">
        <div className="settings-field-group"><div className="settings-label-row"><label className="field-label" htmlFor="provider-api-key">API Key</label><div className="connection-test-cluster">{connectionState.providerId === selectedSettingsProvider.id && connectionState.status !== "idle" && <span className={`connection-inline-result ${connectionState.status}`} role="status" title={connectionState.message}>{connectionState.message}</span>}<button className="inline-test" type="button" onClick={() => void testConnection()} disabled={connectionState.status === "testing"}><span aria-hidden="true">♡</span>{connectionState.status === "testing" ? "测试中" : "测试连接"}</button></div></div><div className="api-key-input-wrap"><input id="provider-api-key" value={selectedDraft.apiKey} onChange={(event) => updateSelectedDraft("apiKey", event.target.value)} type={showApiKey ? "text" : "password"} placeholder={selectedDraft.saved ? "已保存，留空以保留当前 Key" : "粘贴 API Key"} /><button type="button" className="api-key-toggle" onClick={() => setShowApiKey((visible) => !visible)} aria-label={showApiKey ? "隐藏 API Key" : "显示 API Key"} title={showApiKey ? "隐藏 API Key" : "显示 API Key"}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.4-5.5 9.5-5.5 9.5 5.5 9.5 5.5-3.4 5.5-9.5 5.5S2.5 12 2.5 12Z" /><circle cx="12" cy="12" r="2.5" /></svg></button></div></div>
        <div className="settings-field-group"><label className="field-label" htmlFor="provider-base-url">URL</label><input id="provider-base-url" value={selectedDraft.baseUrl} onChange={(event) => updateSelectedDraft("baseUrl", event.target.value)} spellCheck={false} /></div>
        <div className="settings-field-group"><label className="field-label" htmlFor="provider-api-path">API 路径</label><input id="provider-api-path" value={apiPath} readOnly spellCheck={false} /></div>
        <div className="model-section provider-model-section"><div className="model-section-header"><div className="model-section-title"><h3>模型</h3><span>{availableModels.length || (selectedDraft.model ? 1 : 0)}</span></div><div className="model-toolbar"><button type="button" aria-label="添加模型" title="添加模型" aria-expanded={showModelEditor} onClick={() => setManualModelProviderIds((providers) => providers.includes(selectedSettingsProvider.id) ? providers : [...providers, selectedSettingsProvider.id])}><ModelAddIcon /></button>{modelFetchMessage.providerId === selectedSettingsProvider.id && modelFetchMessage.message && <span className="model-fetch-message" role="status" title={modelFetchMessage.message}><span className="model-fetch-message-icon" aria-hidden="true">!</span><span>{modelFetchMessage.message}</span></span>}<button className="fetch-models" type="button" onClick={() => void fetchProviderModels()} disabled={isFetchingModels}><ModelRefreshIcon /><span>{isFetchingModels ? "获取中…" : "获取"}</span></button></div></div>{showModelEditor && <div className="model-group"><div className="model-group-heading"><strong>{selectedSettingsProvider.vendor}</strong></div><div className="model-row"><ProviderIcon provider={selectedSettingsProvider} /><label className="model-input-label" htmlFor="provider-model"><span className="sr-only">模型名称</span><input id="provider-model" value={selectedDraft.model} onChange={(event) => updateSelectedDraft("model", event.target.value)} spellCheck={false} /></label><button type="button" className="model-remove-button" onClick={() => { updateSelectedDraft("model", ""); setManualModelProviderIds((providers) => providers.filter((providerId) => providerId !== selectedSettingsProvider.id)); }} aria-label="移除模型" title="移除模型">−</button></div>{availableModels.length > 0 && <div className="fetched-model-list" role="listbox" aria-label={`${selectedSettingsProvider.vendor} 可用模型`}>{availableModels.map((model) => <button type="button" role="option" aria-selected={model === selectedDraft.model} className={model === selectedDraft.model ? "is-selected" : ""} key={model} onClick={() => updateSelectedDraft("model", model)}><span>{model}</span>{model === selectedDraft.model && <span aria-hidden="true">✓</span>}</button>)}</div>}</div>}</div>
      </section>
      <div className="provider-detail-footer"><div className="action-row settings-actions"><button className="primary" onClick={() => void saveProviderConfig()}>保存配置</button></div></div>
    </div>;
  }

  function renderConnectionPage() {
    return <div className="settings-page-view"><div className="settings-page-heading"><div><p className="settings-page-eyebrow">连通性</p><h1>连接测试</h1></div><span className="settings-page-meta">实时请求</span></div><p className="settings-description">选择一个已配置的接口，发送最小测试请求，确认地址、密钥和模型都可用。</p><div className="connection-selector-card"><label className="field-label" htmlFor="connection-provider">测试接口</label><select id="connection-provider" value={selectedSettingsProvider.id} onChange={(event) => selectSettingsProvider(event.target.value as SettingsProviderId)}><optgroup label="AI 提供商">{SETTINGS_PROVIDERS.map((provider) => <option value={provider.id} key={provider.id}>{provider.vendor} · {provider.model}</option>)}</optgroup><optgroup label="通用接口">{GENERIC_PROVIDERS.map((provider) => <option value={provider.id} key={provider.id}>{provider.vendor} · {provider.model}</option>)}</optgroup></select><div className="connection-summary"><ProviderIcon provider={selectedSettingsProvider} /><div><strong>{selectedSettingsProvider.vendor}</strong><span>{selectedDraft.baseUrl}</span><span>{selectedDraft.model}</span></div></div>{connectionState.providerId === selectedSettingsProvider.id && connectionState.status !== "idle" && <p className={`connection-result ${connectionState.status}`} role="status">{connectionState.message}</p>}<button className="primary connection-test-button" onClick={() => void testConnection()} disabled={connectionState.status === "testing"}>{connectionState.status === "testing" ? "正在测试…" : "开始测试连接"}</button></div><div className="connection-note"><span className="note-mark">i</span><p>测试只发送一条最小请求，不会触发翻译，也不会保存明文 API Key。</p></div></div>;
  }

  function renderCommonPage() {
    const defaultModelChoices = enabledProviderIds.map((providerId) => {
      const provider = AVAILABLE_TRANSLATION_PROVIDERS.find((item) => item.id === providerId);
      return provider ? { providerId, model: settingsEnabledProviderModels[providerId] ?? provider.model } : null;
    }).filter((choice): choice is ModelChoice => choice !== null);
    return <div className="settings-page-view"><div className="settings-page-heading"><div><p className="settings-page-eyebrow">偏好</p><h1>通用设置</h1></div></div><p className="settings-description">管理应用的基础行为与默认工作方式。</p><section className="default-quick-model-card"><div className="default-quick-model-copy"><span className="default-quick-model-mark" aria-hidden="true"><QuickTranslateIcon /></span><div><strong>默认快速翻译模型</strong><small>打开快速翻译时优先选择此模型，仍可在翻译窗口中临时切换。</small></div></div><ModelPicker value={quickTranslateProvider} choices={defaultModelChoices} onChange={setQuickTranslateProvider} ariaLabel="设置默认快速翻译模型" disabled={!defaultModelChoices.length} />{!defaultModelChoices.length && <p className="default-quick-model-empty">请先在“供应商”页面启用至少一个翻译模型。</p>}</section><section className="placeholder-settings-card"><div className="placeholder-setting-row"><div><strong>启动时自动运行</strong><small>随 Windows 启动 AI Translate</small></div><span className="placeholder-badge">即将支持</span></div><div className="placeholder-setting-row"><div><strong>默认目标语言</strong><small>自动识别并翻译为指定语言</small></div><span className="placeholder-value">自动识别</span></div><div className="placeholder-setting-row"><div><strong>配置同步</strong><small>在设备之间同步供应商配置</small></div><span className="placeholder-badge">即将支持</span></div></section></div>;
  }

  function renderInterfacePage() {
    return <div className="settings-page-view"><div className="settings-page-heading"><div><p className="settings-page-eyebrow">外观与交互</p><h1>界面设置</h1></div></div><p className="settings-description">调整悬浮按钮和翻译结果窗口的显示方式。</p><section className="interface-settings-card"><label className="preference-row"><span><strong>选中文本自动显示悬浮按钮</strong><small>鼠标完成选区后显示翻译入口</small></span><input type="checkbox" checked={autoSelection} onChange={(event) => setAutoSelection(event.target.checked)} /></label><label className="preference-row"><span><strong>翻译窗口保持置顶</strong><small>结果窗口不会被其他窗口遮挡</small></span><input type="checkbox" checked={keepOnTop} onChange={(event) => setKeepOnTop(event.target.checked)} /></label><div className="placeholder-setting-row"><div><strong>主题与字体</strong><small>主题切换和字体大小设置</small></div><span className="placeholder-badge">即将支持</span></div></section></div>;
  }

  function renderAboutPage() {
    return <div className="settings-page-view about-page"><div className="about-brand"><img src={appIcon} alt="AI Translate 图标" /><div><p className="settings-page-eyebrow">AI Translate</p><h1>关于</h1><p>轻量、快速的桌面翻译工具。</p></div></div><section className="about-card"><div><span>当前版本</span><strong>0.1.0</strong></div><div><span>翻译引擎</span><strong>DeepSeek</strong></div></section><div className="settings-info-card"><strong>更多信息</strong><p>更新日志、反馈入口和自动更新功能将在后续版本接入。</p></div></div>;
  }

  function renderAddProviderPage() {
    const apiPath = addProviderDefinition.protocol === "google" ? "/models/{model}:generateContent" : addProviderDefinition.protocol === "anthropic" ? "/messages" : useResponsesApi ? "/responses" : "/chat/completions";
    const draft = providerDrafts[addProviderId];
    const tabLabels: Record<GenericProviderId, string> = { openai: "OpenAI", google: "Google", anthropic: "Claude" };
    return <section className="settings-add-provider-page" aria-labelledby="add-provider-title"><div className="settings-topbar" onMouseDown={dragWindow}><div className="settings-brand settings-brand-top"><img src={appIcon} alt="AI Translate 图标" /><div><strong>AI Translate</strong></div></div><div className="settings-window-actions"><button type="button" className="settings-window-button settings-minimize-button" onClick={() => void nativeInvoke<void>("minimize_window").catch(() => undefined)} aria-label="最小化" title="最小化"><Icon name="minimize" /></button><button type="button" className="settings-close-button" onClick={closeAddProvider} aria-label="关闭添加供应商" title="关闭添加供应商"><Icon name="close" /></button></div></div>
      <header className="add-provider-header" onMouseDown={dragWindow}><h1 id="add-provider-title">添加供应商</h1><button type="button" className="add-provider-close" onClick={closeAddProvider} aria-label="关闭添加供应商" title="关闭添加供应商"><Icon name="close" /></button></header>
      <div className="add-provider-content">
        <div className="add-provider-tabs" role="tablist" aria-label="供应商类型">{GENERIC_PROVIDERS.map((provider) => <button type="button" role="tab" aria-selected={provider.id === addProviderId} className={provider.id === addProviderId ? "is-active" : ""} key={provider.id} onClick={() => selectAddProvider(provider.id as GenericProviderId)}>{tabLabels[provider.id as GenericProviderId]}</button>)}</div>
        <div className="add-provider-form">
          <label className="add-provider-option"><span>是否启用</span><span className="settings-switch"><input type="checkbox" checked={enabledProviders[addProviderId] ?? true} onChange={(event) => setEnabledProviders((providers) => ({ ...providers, [addProviderId]: event.target.checked }))} /><span aria-hidden="true" /></span></label>
          {addProviderDefinition.protocol === "openai" && <label className="add-provider-option"><span>Use Responses API</span><span className="settings-switch settings-switch-muted"><input type="checkbox" checked={useResponsesApi} onChange={(event) => setUseResponsesApi(event.target.checked)} /><span aria-hidden="true" /></span></label>}
          <div className="add-provider-field"><label htmlFor="add-provider-name">名称</label><input id="add-provider-name" value={addProviderName} onChange={(event) => setAddProviderName(event.target.value)} /></div>
          <div className="add-provider-field"><label htmlFor="add-provider-api-key">API Key</label><div className="api-key-input-wrap"><input id="add-provider-api-key" value={draft.apiKey} onChange={(event) => updateAddDraft("apiKey", event.target.value)} type={showApiKey ? "text" : "password"} placeholder="" /><button type="button" className="api-key-toggle" onClick={() => setShowApiKey((visible) => !visible)} aria-label={showApiKey ? "隐藏 API Key" : "显示 API Key"} title={showApiKey ? "隐藏 API Key" : "显示 API Key"}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.4-5.5 9.5-5.5 9.5 5.5 9.5 5.5-3.4 5.5-9.5 5.5S2.5 12 2.5 12Z" /><circle cx="12" cy="12" r="2.5" /></svg></button></div></div>
          <div className="add-provider-field"><label htmlFor="add-provider-base-url">Base URL</label><input id="add-provider-base-url" value={draft.baseUrl} onChange={(event) => updateAddDraft("baseUrl", event.target.value)} spellCheck={false} /></div>
          <div className="add-provider-field"><label htmlFor="add-provider-api-path">API 路径</label><input id="add-provider-api-path" value={apiPath} readOnly spellCheck={false} /></div>
        </div>
        {notice && <p className="notice add-provider-notice" role="status">{notice}</p>}
        <div className="add-provider-actions"><button className="primary" type="button" onClick={() => void addGenericProvider()}>＋ 添加</button></div>
      </div>
    </section>;
  }

  function renderProviderColumn() {
    return <aside className="settings-provider-column">
      <div className="provider-search"><SearchIcon /><input aria-label="搜索供应商或分组" value={providerSearch} onChange={(event) => setProviderSearch(event.target.value)} placeholder="搜索供应商或分组" /></div>
      <div className="provider-list-heading"><span>可用接口</span><strong>{filteredProviders.length}</strong></div>
      <nav className="provider-list-nav" aria-label="供应商列表">{filteredProviders.map((provider) => { const enabled = enabledProviderIds.includes(provider.id); return <button type="button" className={`provider-list-item ${provider.id === selectedSettingsProvider.id ? "is-selected" : ""}`} key={provider.id} onClick={() => selectSettingsProvider(provider.id)}><ProviderIcon provider={provider} /><span className="provider-list-copy"><strong>{provider.vendor}</strong></span><span className={`provider-list-status-dot ${enabled ? "is-enabled" : ""}`} aria-hidden="true" /><span className="sr-only">{enabled ? "已启用" : "未启用"}</span></button>; })}</nav>
      <div className="provider-column-footer"><button type="button" className="provider-add-button" onClick={() => openAddProvider()}>＋ 添加</button></div>
    </aside>;
  }

  if (isAddingProvider) {
    return <main className="app-shell settings-window-shell"><section className="settings-add-provider-shell">{renderAddProviderPage()}</section></main>;
  }

  return <main className="app-shell settings-window-shell"><section className={`settings-shell settings-shell-${isProviderPage ? "providers" : "single"}`}><div className="settings-topbar" onMouseDown={dragWindow}><div className="settings-brand settings-brand-top"><img src={appIcon} alt="AI Translate 图标" /><div><strong>AI Translate</strong></div></div><div className="settings-window-actions"><button type="button" className="settings-window-button settings-minimize-button" onClick={() => void nativeInvoke<void>("minimize_window").catch(() => undefined)} aria-label="最小化" title="最小化"><Icon name="minimize" /></button><button type="button" className="settings-close-button" onClick={() => void nativeInvoke("hide_settings_window")} aria-label="关闭设置" title="关闭设置"><Icon name="close" /></button></div></div><aside className="settings-nav-panel"><div className="settings-brand" onMouseDown={dragWindow}><img src={appIcon} alt="AI Translate 图标" /><div><strong>AI Translate</strong><small>设置中心</small></div></div><nav className="settings-primary-nav" aria-label="设置分类"><button type="button" className={activeNavPage === "general" ? "is-active" : ""} onClick={() => switchSettingsPage("general")}><SettingsNavIcon name="general" />通用设置</button><button type="button" className={activeNavPage === "interface" ? "is-active" : ""} onClick={() => switchSettingsPage("interface")}><SettingsNavIcon name="interface" />界面设置</button><button type="button" className={activeNavPage === "providers" ? "is-active" : ""} onClick={() => switchSettingsPage("providers")}><SettingsNavIcon name="providers" />供应商</button><button type="button" className={activeNavPage === "about" ? "is-active" : ""} onClick={() => switchSettingsPage("about")}><SettingsNavIcon name="about" />关于</button></nav></aside>{isProviderPage && renderProviderColumn()}<section className="settings-main">{settingsPage === "connection" ? renderConnectionPage() : settingsPage === "general" ? renderCommonPage() : settingsPage === "interface" ? renderInterfacePage() : settingsPage === "about" ? renderAboutPage() : renderProviderDetails()}{notice && <p className="notice" role="status">{notice}</p>}</section></section></main>;
}

function App() {
  let label = "main";
  try {
    label = getCurrentWebviewWindow().label;
  } catch {
    label = new URLSearchParams(window.location.search).get("window") ?? "main";
  }
  if (label === "selection-float") return <SelectionFloat />;
  if (label === "settings") return <SettingsWindow />;
  if (label === "settings-legacy") return <LegacySettingsWindow />;
  return <MainWindow />;
}

export default App;
