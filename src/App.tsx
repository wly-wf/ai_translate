import { type CSSProperties, type MouseEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { cursorPosition, getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { siDeepseek, siGithub, siMoonshotai, type SimpleIcon } from "simple-icons";
import bailianIcon from "@lobehub/icons-static-svg/icons/bailian-color.svg";
import xiaomiMimoIcon from "@lobehub/icons-static-svg/icons/xiaomimimo.svg";
import zhipuIcon from "@lobehub/icons-static-svg/icons/zhipu-color.svg";
import { SelectionFloat } from "./SelectionFloat";
import { useLongPressReorder } from "./useLongPressReorder";
import appIcon from "../src-tauri/icons/tray-icon.svg";
import "./App.css";

type SettingsProviderId = "deepseek" | "xiaomi" | "qwen" | "zhipu" | "moonshot" | "openai";
type ProviderId = SettingsProviderId;
type GenericProviderId = "openai";
type SettingsPage = "providers" | "generic" | "connection" | "preferences" | "proxy" | "about";
type ProviderTranslationResult = { providerId: ProviderId; model: string; translation?: string | null; error?: string | null };
type Translation = { source: string; results: ProviderTranslationResult[]; requestId?: number };
type TranslationError = { requestId: number; message: string };
type ActiveProviderChanged = { providerId: ProviderId; model: string };
type ThemeMode = "light" | "dark" | "system";
type ProxyMode = "system" | "disabled" | "custom";
type ProxyType = "http" | "https" | "socks4" | "socks5";
type UserPreferences = {
  autoSelection: boolean;
  keepOnTop: boolean;
  quickTranslateProvider: ProviderId | null;
  quickTranslateModel: string | null;
  themeMode: ThemeMode;
  sourceFontSize: number;
  translationFontSize: number;
  proxyMode: ProxyMode;
  proxyUrl: string;
  proxyType: ProxyType;
  proxyHost: string;
  proxyPort: string;
  proxyUsername: string;
  proxyPassword: string;
  proxyBypass: string;
  proxyTestUrl: string;
  providerOrder: string[];
};
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
  mark: string;
  accent: string;
  summary: string;
};

type ProviderDraft = {
  vendorName: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  models: string[];
  saved: boolean;
};

type ProviderConfigResponse = {
  vendorName?: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  models: string[];
};

type ConnectionState = {
  providerId: SettingsProviderId | null;
  status: "idle" | "testing" | "success" | "error";
  message: string;
};

type ModelChoice = {
  id: string;
  providerId: ProviderId;
  model: string;
  vendor: string;
};

const APP_VERSION = "0.1.0";
const PROJECT_LINKS = [
  {
    id: "repository",
    title: "GitHub 开源仓库",
    description: "查看源代码、版本发布和项目进展。",
    url: "https://github.com/wly-wf/ai_translate",
  },
  {
    id: "issues",
    title: "GitHub Issues",
    description: "提交问题、功能建议和使用反馈。",
    url: "https://github.com/wly-wf/ai_translate/issues",
  },
] as const;

const PROVIDER_ICONS: Partial<Record<ProviderId, SimpleIcon>> = {
  deepseek: siDeepseek,
};

const SETTINGS_PROVIDER_ICONS: Partial<Record<SettingsProviderId, SimpleIcon>> = {
  deepseek: siDeepseek,
  moonshot: siMoonshotai,
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
    mark: "D",
    accent: "#16a394",
    summary: "适合日常取词、技术文档和快速翻译。",
  },
  {
    id: "xiaomi",
    vendor: "Xiaomi MiMo",
    model: "mimo-v2.5-pro",
    baseUrl: "https://api.xiaomimimo.com",
    mark: "M",
    accent: "#ff6900",
    summary: "Xiaomi MiMo 开放平台，兼容 OpenAI 接口。",
  },
  {
    id: "qwen",
    vendor: "阿里云百炼",
    model: "qwen-plus",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    mark: "Q",
    accent: "#5b55d6",
    summary: "阿里云百炼兼容模式，支持通义千问。",
  },
  {
    id: "zhipu",
    vendor: "智谱开放平台",
    model: "glm-5.2",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    mark: "Z",
    accent: "#3478f6",
    summary: "智谱开放平台，兼容 OpenAI SDK。",
  },
  {
    id: "moonshot",
    vendor: "Moonshot",
    model: "kimi-k2.5",
    baseUrl: "https://api.moonshot.cn",
    mark: "K",
    accent: "#242936",
    summary: "Moonshot API，适合长文本和中文场景。",
  },
];

const GENERIC_PROVIDERS: SettingsProvider[] = [
  {
    id: "openai",
    vendor: "OpenAI 兼容接口",
    model: "gpt-4o-mini",
    baseUrl: "https://api.openai.com",
    mark: "O",
    accent: "#5f83bd",
    summary: "标准 OpenAI Chat Completions 兼容接口。",
  },
];

const ALL_SETTINGS_PROVIDERS = [...SETTINGS_PROVIDERS, ...GENERIC_PROVIDERS];

function createProviderDrafts(): Record<SettingsProviderId, ProviderDraft> {
  return Object.fromEntries(ALL_SETTINGS_PROVIDERS.map((provider) => [provider.id, {
    vendorName: provider.vendor,
    apiKey: "",
    baseUrl: provider.baseUrl,
    model: "",
    models: [] as string[],
    saved: false,
  }])) as Record<SettingsProviderId, ProviderDraft>;
}

function uniqueModels(models: string[]) {
  return models.reduce<string[]>((result, model) => {
    const normalized = model.trim();
    if (normalized && !result.includes(normalized)) result.push(normalized);
    return result;
  }, []);
}

function customProviderMark(name: string, fallback = "供") {
  return Array.from(name.trim())[0] || fallback;
}

function withCustomProviderIdentity<T extends { vendor: string; mark: string; accent: string }>(provider: T, name: string): T {
  const vendor = name.trim();
  return {
    ...provider,
    vendor: vendor || provider.vendor,
    mark: customProviderMark(vendor),
    accent: "#5f83bd",
  };
}

function modelsFromConfig(config: Pick<ProviderConfigResponse, "model" | "models">) {
  return uniqueModels(config.models?.length ? config.models : [config.model]);
}

function draftFromConfig(config: ProviderConfigResponse, fallbackVendor = ""): ProviderDraft {
  const models = modelsFromConfig(config);
  return { vendorName: config.vendorName?.trim() || fallbackVendor, apiKey: config.apiKey, baseUrl: config.baseUrl, model: models[0] ?? "", models, saved: true };
}

function translationResultKey(result: Pick<ProviderTranslationResult, "providerId" | "model">) {
  return `${result.providerId}\u0000${result.model}`;
}

function modelChoiceKey(providerId: ProviderId, model: string) {
  return `${providerId}\u0000${model}`;
}

const TRANSLATION_PROVIDERS: TranslationProvider[] = ALL_SETTINGS_PROVIDERS.map((provider) => ({
  ...provider,
  enabled: true,
}));
const AVAILABLE_TRANSLATION_PROVIDERS = TRANSLATION_PROVIDERS.filter((provider) => provider.enabled);

const DEFAULT_PROVIDER_ID: ProviderId = "deepseek";
const DEFAULT_PROVIDER_ORDER = ALL_SETTINGS_PROVIDERS.map((provider) => provider.id);
const DEFAULT_USER_PREFERENCES: UserPreferences = {
  autoSelection: true,
  keepOnTop: false,
  quickTranslateProvider: null,
  quickTranslateModel: null,
  themeMode: "system",
  sourceFontSize: 14,
  translationFontSize: 16,
  proxyMode: "disabled",
  proxyUrl: "",
  proxyType: "https",
  proxyHost: "127.0.0.1",
  proxyPort: "7890",
  proxyUsername: "",
  proxyPassword: "",
  proxyBypass: "localhost,127.0.0.1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,::1",
  proxyTestUrl: "https://www.google.com",
  providerOrder: DEFAULT_PROVIDER_ORDER,
};

function orderedProviderIds(order: readonly string[], availableIds: readonly ProviderId[]) {
  const available = new Set<string>(availableIds);
  const result = order.filter((providerId): providerId is ProviderId => available.has(providerId));
  for (const providerId of availableIds) {
    if (!result.includes(providerId)) result.push(providerId);
  }
  return result;
}

function orderProviders<T extends { id: ProviderId }>(providers: readonly T[], order: readonly string[]) {
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  return orderedProviderIds(order, providers.map((provider) => provider.id))
    .map((providerId) => byId.get(providerId))
    .filter((provider): provider is T => Boolean(provider));
}

function orderProviderResults<T extends { providerId: ProviderId }>(results: readonly T[], order: readonly string[]) {
  const rank = new Map(order.map((providerId, index) => [providerId, index]));
  return results
    .map((result, index) => ({ result, index }))
    .sort((left, right) => (rank.get(left.result.providerId) ?? Number.MAX_SAFE_INTEGER)
      - (rank.get(right.result.providerId) ?? Number.MAX_SAFE_INTEGER) || left.index - right.index)
    .map(({ result }) => result);
}

function initialUserPreferences() {
  if (typeof window === "undefined") return DEFAULT_USER_PREFERENCES;
  try {
    const stored = JSON.parse(window.localStorage.getItem("ai-translate-appearance") ?? "null") as Partial<UserPreferences> | null;
    if (!stored) return DEFAULT_USER_PREFERENCES;
    return {
      ...DEFAULT_USER_PREFERENCES,
      themeMode: stored.themeMode ?? DEFAULT_USER_PREFERENCES.themeMode,
      sourceFontSize: stored.sourceFontSize ?? DEFAULT_USER_PREFERENCES.sourceFontSize,
      translationFontSize: stored.translationFontSize ?? DEFAULT_USER_PREFERENCES.translationFontSize,
    };
  } catch {
    return DEFAULT_USER_PREFERENCES;
  }
}

function appearanceMatches(a: UserPreferences, b: UserPreferences) {
  return a.themeMode === b.themeMode
    && a.sourceFontSize === b.sourceFontSize
    && a.translationFontSize === b.translationFontSize;
}
const isTauriDesktop = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function containsCjk(value: string) {
  return /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(value);
}

function translationLanguageClass(source: string) {
  // The native translation target uses the same direction rule: any CJK in
  // the source translates to English; otherwise the target is Chinese. Base
  // typography on that direction instead of acronyms inside the translation.
  return containsCjk(source)
    ? "translation-english"
    : "translation-chinese";
}

function normalizeSourceText(value: string) {
  const normalized = value.replace(/\r\n?/g, "\n");
  if (containsCjk(normalized)) return normalized;

  // PDF and document UIA providers often expose visual line wrapping as hard
  // newlines. Reflow those English soft wraps for this narrower window while
  // retaining blank-line paragraph boundaries from the source document.
  return normalized
    .split(/\n[\t ]*\n+/)
    .map((paragraph) => paragraph
      .replace(/[\t ]*\n[\t ]*/g, " ")
      .replace(/[\t ]+/g, " ")
      .trim())
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

function CheckIcon() {
  return <svg className="quick-model-check-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m5.5 12.5 4.1 4.1 8.9-9" /></svg>;
}

function ModelPicker({ value, choices, onChange, ariaLabel, disabled = false }: { value: string | null; choices: ModelChoice[]; onChange: (choice: ModelChoice) => void; ariaLabel: string; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selectedChoice = choices.find((choice) => choice.id === value) ?? null;
  const providerForChoice = (choice: ModelChoice) => {
    const provider = AVAILABLE_TRANSLATION_PROVIDERS.find((item) => item.id === choice.providerId);
    return provider ? withCustomProviderIdentity(provider, choice.vendor) : provider;
  };
  const selectedProvider = selectedChoice ? providerForChoice(selectedChoice) : null;

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
    {open && <div className="model-picker-menu" role="listbox" aria-label={ariaLabel}>{choices.map((choice) => { const provider = providerForChoice(choice); if (!provider) return null; const selected = choice.id === value; return <button className={`model-picker-option${selected ? " is-selected" : ""}`} type="button" role="option" aria-selected={selected} key={choice.id} onClick={() => { onChange(choice); setOpen(false); }}><ProviderIcon provider={provider} /><span><strong>{choice.model}</strong><small>{provider.vendor}</small></span>{selected && <span className="model-picker-selected-dot" aria-hidden="true" />}</button>; })}</div>}
  </div>;
}

function InlineSelect({ value, options, onChange, ariaLabel }: { value: string; options: string[]; onChange: (value: string) => void; ariaLabel: string }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

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

  return <div className={`inline-select${open ? " is-open" : ""}`} ref={rootRef}>
    <button className="inline-select-trigger" type="button" role="combobox" aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
      <span>{value}</span><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
    </button>
    {open && <div className="inline-select-menu" role="listbox" aria-label={ariaLabel}>{options.map((option) => <button className={`inline-select-option${option === value ? " is-selected" : ""}`} type="button" role="option" aria-selected={option === value} key={option} onClick={() => { onChange(option); setOpen(false); }}><span>{option}</span>{option === value && <span className="inline-select-check" aria-hidden="true">✓</span>}</button>)}</div>}
  </div>;
}

function SegmentedControl({ value, options, onChange, ariaLabel }: {
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  ariaLabel: string;
}) {
  return <div className="segmented-control" role="radiogroup" aria-label={ariaLabel}>
    {options.map((option) => <button
      type="button"
      role="radio"
      aria-checked={value === option.value}
      className={value === option.value ? "is-selected" : ""}
      key={option.value}
      onClick={() => onChange(option.value)}
    >{option.label}</button>)}
  </div>;
}

async function nativeInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauriDesktop()) {
    throw new Error("当前页面运行在普通浏览器中。请关闭此页面，并使用 `npm.cmd run tauri dev` 打开的 AI Translate 桌面窗口。");
  }
  return invoke<T>(command, args);
}

function useUserPreferences() {
  const [preferences, setPreferences] = useState<UserPreferences>(initialUserPreferences);
  const [preferencesError, setPreferencesError] = useState("");
  const saveChain = useRef<Promise<unknown>>(Promise.resolve());
  const pendingPreferences = useRef<Partial<UserPreferences>>({});

  function mergeStoredPreferences(current: UserPreferences, stored: Partial<UserPreferences> | null | undefined) {
    const next = { ...DEFAULT_USER_PREFERENCES, ...(stored ?? {}) };
    for (const key of Object.keys(pendingPreferences.current) as (keyof UserPreferences)[]) {
      next[key] = current[key] as never;
    }
    return next;
  }

  useEffect(() => {
    if (!isTauriDesktop()) {
      return;
    }
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void listen<UserPreferences>("preferences-changed", (event) => {
      if (!cancelled) setPreferences((current) => {
        const next = mergeStoredPreferences(current, event.payload);
        return appearanceMatches(current, next) && JSON.stringify(current) === JSON.stringify(next) ? current : next;
      });
    }).then((remove) => {
      if (cancelled) remove();
      else unlisten = remove;
    }).catch(() => undefined);
    void nativeInvoke<UserPreferences>("get_preferences")
      .then((stored) => {
        if (cancelled) return;
        setPreferences((current) => mergeStoredPreferences(current, stored));
      })
      .catch((error) => {
        if (cancelled) return;
        setPreferencesError(String(error));
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    const systemTheme = typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-color-scheme: dark)")
      : null;
    const applyAppearance = () => {
      const resolvedTheme = preferences.themeMode === "system"
        ? (systemTheme?.matches ? "dark" : "light")
        : preferences.themeMode;
      root.dataset.theme = resolvedTheme;
      root.dataset.themeMode = preferences.themeMode;
      root.style.setProperty("--source-font-size", `${preferences.sourceFontSize}px`);
      root.style.setProperty("--translation-font-size", `${preferences.translationFontSize}px`);
      root.style.colorScheme = resolvedTheme;
      if (isTauriDesktop() && getCurrentWebviewWindow().label !== "selection-float") {
        void nativeInvoke<void>("set_window_appearance", {
          dark: resolvedTheme === "dark",
          followSystem: preferences.themeMode === "system",
        }).catch(() => undefined);
      }
      try {
        window.localStorage.setItem("ai-translate-appearance", JSON.stringify({
          themeMode: preferences.themeMode,
          sourceFontSize: preferences.sourceFontSize,
          translationFontSize: preferences.translationFontSize,
        }));
      } catch {
        // WebView storage can be unavailable during shutdown; preferences are
        // still persisted by the native settings store.
      }
    };
    applyAppearance();
    if (preferences.themeMode === "system") systemTheme?.addEventListener("change", applyAppearance);
    return () => systemTheme?.removeEventListener("change", applyAppearance);
  }, [preferences.themeMode, preferences.sourceFontSize, preferences.translationFontSize]);

  function updatePreference<K extends keyof UserPreferences>(preference: K, value: UserPreferences[K]) {
    pendingPreferences.current[preference] = value;
    setPreferences((current) => ({ ...current, [preference]: value }));
    if (!isTauriDesktop()) return;
    saveChain.current = saveChain.current
      .catch(() => undefined)
      .then(() => nativeInvoke<UserPreferences>("set_user_preference", { preference, value }))
      .then((saved) => {
        setPreferences((current) => {
          if (current[preference] !== value) return current;
          return { ...current, [preference]: saved ? saved[preference] : value };
        });
        if (pendingPreferences.current[preference] === value) delete pendingPreferences.current[preference];
        setPreferencesError("");
      })
      .catch((error) => {
        if (pendingPreferences.current[preference] === value) delete pendingPreferences.current[preference];
        setPreferencesError(String(error));
      });
  }

  return {
    autoSelection: preferences.autoSelection,
    keepOnTop: preferences.keepOnTop,
    quickTranslateProvider: preferences.quickTranslateProvider,
    quickTranslateModel: preferences.quickTranslateModel,
    themeMode: preferences.themeMode,
    sourceFontSize: preferences.sourceFontSize,
    translationFontSize: preferences.translationFontSize,
    proxyMode: preferences.proxyMode,
    proxyUrl: preferences.proxyUrl,
    proxyType: preferences.proxyType,
    proxyHost: preferences.proxyHost,
    proxyPort: preferences.proxyPort,
    proxyUsername: preferences.proxyUsername,
    proxyPassword: preferences.proxyPassword,
    proxyBypass: preferences.proxyBypass,
    proxyTestUrl: preferences.proxyTestUrl,
    providerOrder: preferences.providerOrder,
    setAutoSelection: (value: boolean) => updatePreference("autoSelection", value),
    setKeepOnTop: (value: boolean) => updatePreference("keepOnTop", value),
    setQuickTranslateProvider: (value: ProviderId | null) => updatePreference("quickTranslateProvider", value),
    setQuickTranslateModel: (value: string | null) => updatePreference("quickTranslateModel", value),
    setThemeMode: (value: ThemeMode) => updatePreference("themeMode", value),
    setSourceFontSize: (value: number) => updatePreference("sourceFontSize", value),
    setTranslationFontSize: (value: number) => updatePreference("translationFontSize", value),
    setProxyMode: (value: ProxyMode) => updatePreference("proxyMode", value),
    setProxyUrl: (value: string) => updatePreference("proxyUrl", value),
    setProxyType: (value: ProxyType) => updatePreference("proxyType", value),
    setProxyHost: (value: string) => updatePreference("proxyHost", value),
    setProxyPort: (value: string) => updatePreference("proxyPort", value),
    setProxyUsername: (value: string) => updatePreference("proxyUsername", value),
    setProxyPassword: (value: string) => updatePreference("proxyPassword", value),
    setProxyBypass: (value: string) => updatePreference("proxyBypass", value),
    setProxyTestUrl: (value: string) => updatePreference("proxyTestUrl", value),
    setProviderOrder: (value: string[]) => updatePreference("providerOrder", value),
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
  const textRef = useRef<HTMLDivElement>(null);
  const measurementRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const paragraphs = text
    .split(/\r\n?|\n/)
    .filter((paragraph) => paragraph.trim().length > 0);
  const renderParagraphs = () => paragraphs.map((paragraph, index) => (
    <p className="text-paragraph" key={`${index}-${paragraph}`}>{paragraph}</p>
  ));

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
    <div ref={textRef} className={`text-content ${kind}${textClassName ? ` ${textClassName}` : ""}`}>{renderParagraphs()}</div>
    <div ref={measurementRef} className={`text-content ${kind} text-measure${textClassName ? ` ${textClassName}` : ""}`} aria-hidden="true">{renderParagraphs()}</div>
    {canExpand && <button
      type="button"
      className={`text-expand-button ${kind}-expand-button`}
      aria-label={expanded ? `收起完整${textLabel}` : `展开完整${textLabel}`}
      aria-expanded={expanded}
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

function DeleteIcon() {
  return <svg className="provider-context-menu-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 7h15M9 7V4.5h6V7M7 7l.7 12h8.6L17 7M10 10.5v5M14 10.5v5" /></svg>;
}

function AvailableModelsDialog({ provider, models, selectedModels, isLoading, fetchError, closeButtonRef, onToggle, onClose, onRetry }: {
  provider: SettingsProvider;
  models: string[];
  selectedModels: string[];
  isLoading: boolean;
  fetchError: string;
  closeButtonRef: React.RefObject<HTMLButtonElement | null>;
  onToggle: (model: string) => void;
  onClose: () => void;
  onRetry: () => void;
}) {
  return <>
    <button type="button" className="model-dialog-backdrop" aria-label="关闭可用模型窗口" onClick={onClose} />
    <div className="model-dialog-card" role="dialog" aria-modal="true" aria-label={`${provider.vendor} 可用模型`}>
      <header className="model-dialog-header">
        <div className="model-dialog-heading">
          <span className="model-dialog-provider-mark" aria-hidden="true"><ProviderIcon provider={provider} /></span>
          <h2>{provider.vendor}</h2>
        </div>
        <button ref={closeButtonRef} type="button" className="model-dialog-close" onClick={onClose} aria-label="关闭可用模型" title="关闭"><Icon name="close" /></button>
      </header>

      {isLoading
        ? <div className="model-dialog-loading" role="status" aria-live="polite" aria-label={`正在获取 ${provider.vendor} 模型`}><span className="model-dialog-spinner" aria-hidden="true" /><strong>正在获取模型</strong><p>正在连接 {provider.vendor}，请稍候…</p></div>
        : fetchError
          ? <div className="model-dialog-empty model-dialog-error" role="alert"><span aria-hidden="true">!</span><strong>获取模型失败</strong><p>{fetchError}</p><button type="button" onClick={onRetry}>重新获取</button></div>
          : models.length > 0
            ? <div className="model-dialog-list" role="list" aria-label={`${provider.vendor} 可用模型列表`}>
              {models.map((model) => {
                const added = selectedModels.includes(model);
                return <div className="model-dialog-option" role="listitem" key={model}>
                  <strong>{model}</strong>
                  <button type="button" className={`model-dialog-action${added ? " is-remove" : ""}`} onClick={() => onToggle(model)} aria-label={added ? `移除模型 ${model}` : `添加模型 ${model}`} title={added ? "移除模型" : "添加模型"}>{added ? "−" : "+"}</button>
                </div>;
              })}
            </div>
            : <div className="model-dialog-empty"><span aria-hidden="true"><ModelRefreshIcon /></span><strong>没有获取到可用模型</strong><p>请检查接口地址或稍后重新获取。</p></div>}

      <footer className="model-dialog-footer"><button type="button" onClick={onClose}>{isLoading ? "隐藏" : "完成"}</button></footer>
    </div>
  </>;
}

function SettingsNavIcon({ name }: { name: "preferences" | "providers" | "proxy" | "about" }) {
  const paths = {
    preferences: <><path d="M4 6h16M4 12h16M4 18h16" /><circle cx="9" cy="6" r="1.7" /><circle cx="15" cy="12" r="1.7" /><circle cx="11" cy="18" r="1.7" /></>,
    providers: <><rect x="4" y="4" width="7" height="7" rx="1.2" /><rect x="13" y="13" width="7" height="7" rx="1.2" /><path d="M11 7.5h2M16.5 11v2" /></>,
    proxy: <><circle cx="6" cy="12" r="2.5" /><circle cx="18" cy="6" r="2.5" /><circle cx="18" cy="18" r="2.5" /><path d="m8.3 10.9 7.4-3.8M8.3 13.1l7.4 3.8" /></>,
    about: <><circle cx="12" cy="12" r="8.5" /><path d="M12 10v6M12 7.5v.01" /></>,
  };
  return <svg className="settings-nav-icon" viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>;
}

function AboutIcon({ name }: { name: "version" | "system" | "github" | "issues" | "external" | "refresh" }) {
  if (name === "github") {
    return <svg className="about-icon about-icon-github" viewBox="0 0 24 24" aria-hidden="true"><path d={siGithub.path} /></svg>;
  }
  const paths: Record<Exclude<typeof name, "github">, React.ReactNode> = {
    version: <><path d="M12 3.5a8.5 8.5 0 1 0 8.5 8.5" /><path d="M20.5 5v7h-7" /></>,
    system: <><rect x="3.5" y="4.5" width="17" height="12" rx="2" /><path d="M8 20h8M12 16.5V20" /></>,
    issues: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5v5.5M12 16.5v.01" /></>,
    external: <><path d="M9 5H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" /><path d="M14 3h7v7M21 3l-9 9" /></>,
    refresh: <><path d="M20 11a8 8 0 1 0 1 4" /><path d="M20 5v6h-6" /></>,
  };
  return <svg className="about-icon" viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>;
}

function MainWindow() {
  const [result, setResult] = useState<Translation | null>(null);
  const [text, setText] = useState("");
  const { keepOnTop, quickTranslateProvider, quickTranslateModel, providerOrder, setKeepOnTop, preferencesError } = useUserPreferences();
  const [hasApiKey, setHasApiKey] = useState(false);
  const [activeProviderId, setActiveProviderId] = useState<ProviderId>(DEFAULT_PROVIDER_ID);
  const [activeProviderModel, setActiveProviderModel] = useState(SETTINGS_PROVIDERS[0].model);
  const [enabledProviderIds, setEnabledProviderIds] = useState<ProviderId[]>([DEFAULT_PROVIDER_ID]);
  const [enabledProviderModels, setEnabledProviderModels] = useState<Partial<Record<ProviderId, string[]>>>({ deepseek: [SETTINGS_PROVIDERS[0].model] });
  const [enabledProviderNames, setEnabledProviderNames] = useState<Partial<Record<ProviderId, string>>>({});
  const [quickTranslateProviderId, setQuickTranslateProviderId] = useState<ProviderId>(DEFAULT_PROVIDER_ID);
  const [quickTranslateModelName, setQuickTranslateModelName] = useState(SETTINGS_PROVIDERS[0].model);
  const [loading, setLoading] = useState(false);
  const [expandedProviderIds, setExpandedProviderIds] = useState<string[]>([DEFAULT_PROVIDER_ID]);
  const [showQuickTranslate, setShowQuickTranslate] = useState(false);
  const [notice, setNotice] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const latestRequestId = useRef(0);
  const latestTranslationAttempt = useRef(0);
  const titlebarDragRef = useRef<TitlebarDragState | null>(null);
  const providerOrderRef = useRef(providerOrder);
  const activationGraceUntilRef = useRef(0);
  const focusLossTimerRef = useRef<number | null>(null);
  providerOrderRef.current = providerOrder;

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
    const orderedSnapshot = { ...snapshot, results: orderProviderResults(snapshot.results, providerOrderRef.current) };
    const providerId = orderedSnapshot.results[0]?.providerId ?? DEFAULT_PROVIDER_ID;
    setActiveProviderId(providerId);
    if (orderedSnapshot.results[0]?.model) setActiveProviderModel(orderedSnapshot.results[0].model);
    setResult(orderedSnapshot);
    setExpandedProviderIds(orderedSnapshot.results.map(translationResultKey));
    setLoading(translationIsPending(orderedSnapshot));
    setNotice("");
    setShowQuickTranslate(false);
  }

  async function loadEnabledProviders(providerIds: ProviderId[]) {
    const orderedIds = orderedProviderIds(providerOrderRef.current, providerIds);
    setEnabledProviderIds(orderedIds);
    const entries = await Promise.all(orderedIds.map(async (providerId) => {
      const config = await nativeInvoke<ProviderConfigResponse | null>("get_provider_config", { provider: providerId });
      return [providerId, config ? modelsFromConfig(config) : [], config?.vendorName?.trim()] as const;
    }));
    setEnabledProviderModels(Object.fromEntries(entries.flatMap(([providerId, models]) => models.length ? [[providerId, models]] : [])));
    setEnabledProviderNames(Object.fromEntries(entries.flatMap(([providerId, , vendorName]) => vendorName ? [[providerId, vendorName]] : [])));
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
    const windowListener = listen("translation-window:open", () => {
      activationGraceUntilRef.current = Date.now() + 500;
      setShowQuickTranslate(false);
      setNotice("");
    });
    const quickTranslateListener = listen("quick-translate:open", () => {
      activationGraceUntilRef.current = Date.now() + 500;
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
    const preferredModels = quickTranslateProvider ? enabledProviderModels[quickTranslateProvider] ?? [] : [];
    if (quickTranslateProvider && preferredModels.length) {
      setQuickTranslateProviderId(quickTranslateProvider);
      setQuickTranslateModelName(quickTranslateModel && preferredModels.includes(quickTranslateModel) ? quickTranslateModel : preferredModels[0]);
      return;
    }
    const fallbackProvider = enabledProviderIds.find((providerId) => (enabledProviderModels[providerId]?.length ?? 0) > 0);
    if (!fallbackProvider) return;
    setQuickTranslateProviderId(fallbackProvider);
    setQuickTranslateModelName((current) => enabledProviderModels[fallbackProvider]?.includes(current) ? current : enabledProviderModels[fallbackProvider]![0]);
  }, [enabledProviderIds, enabledProviderModels, quickTranslateModel, quickTranslateProvider]);

  useEffect(() => {
    setEnabledProviderIds((current) => orderedProviderIds(providerOrder, current));
    setResult((current) => current ? { ...current, results: orderProviderResults(current.results, providerOrder) } : current);
  }, [providerOrder]);

  async function translate() {
    if (!text.trim() || quickTranslateChoices.length === 0) return;
    const attempt = latestTranslationAttempt.current + 1;
    latestTranslationAttempt.current = attempt;
    setLoading(true);
    setNotice("");
    setExpandedProviderIds(enabledProviderIds);
    try {
      const translated = await nativeInvoke<Translation>("translate_text", { text, provider: quickTranslateProviderId, model: quickTranslateModelName });
      if (attempt !== latestTranslationAttempt.current || !acceptRequest(translated.requestId)) return;
      const orderedTranslation = { ...translated, results: orderProviderResults(translated.results, providerOrder) };
      const providerId = orderedTranslation.results[0]?.providerId ?? activeProviderId;
      setActiveProviderId(providerId);
      if (orderedTranslation.results[0]?.model) setActiveProviderModel(orderedTranslation.results[0].model);
      setExpandedProviderIds(orderedTranslation.results.map(translationResultKey));
      setResult(orderedTranslation);
      setShowQuickTranslate(false);
    } catch (error) {
      if (attempt === latestTranslationAttempt.current) setNotice(String(error));
    } finally {
      if (attempt === latestTranslationAttempt.current) setLoading(false);
    }
  }

  function openQuickTranslate() {
    setShowQuickTranslate(true);
    setNotice("");
  }

  function returnToFloatingTranslate() {
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

  const runtimeProvider = (providerId: ProviderId) => {
    const provider = AVAILABLE_TRANSLATION_PROVIDERS.find((item) => item.id === providerId);
    const vendorName = enabledProviderNames[providerId];
    return provider && vendorName ? withCustomProviderIdentity(provider, vendorName) : provider;
  };
  const activeProviderDefinition = runtimeProvider(activeProviderId) ?? AVAILABLE_TRANSLATION_PROVIDERS[0];
  const activeProvider = { ...activeProviderDefinition, model: enabledProviderModels[activeProviderId]?.[0] ?? activeProviderModel ?? activeProviderDefinition.model };
  const quickTranslateChoices = enabledProviderIds.flatMap((providerId) => {
    const provider = runtimeProvider(providerId);
    return provider ? (enabledProviderModels[providerId] ?? [provider.model]).map((model) => ({ id: modelChoiceKey(providerId, model), providerId, model, vendor: provider.vendor })) : [];
  });
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

    <section className={`content${showQuickTranslate ? " quick-content" : ""}`}>
      {showQuickTranslate ? <div className="quick-translate-page">
        <div className="quick-translate-heading"><p className="eyebrow">快速翻译</p></div>
        {!hasApiKey && <div className="warning"><span className="warning-icon" aria-hidden="true">!</span><p>请先在设置中配置并选择一个翻译模型。</p></div>}
        <div className="quick-model-picker"><ModelPicker value={modelChoiceKey(quickTranslateProviderId, quickTranslateModelName)} choices={quickTranslateChoices} onChange={(choice) => { setQuickTranslateProviderId(choice.providerId); setQuickTranslateModelName(choice.model); }} ariaLabel="选择翻译模型" disabled={!quickTranslateChoices.length} /></div>
        <div className="input-card"><div className="input-head"><label className="field-label" htmlFor="translation-input">输入文本</label><span className="character-count">{text.length} 字符</span></div>
          <textarea ref={inputRef} id="translation-input" className={/[A-Za-z]/.test(text) ? "is-mixed-language" : undefined} value={text} onChange={(event) => setText(event.target.value)} placeholder="输入要翻译的文字…" />
        </div>
        <div className="quick-translate-action"><button className="primary" disabled={loading || !text.trim() || quickTranslateChoices.length === 0} onClick={() => void translate()}>{loading ? "翻译中…" : "翻译"}</button></div>
      </div> : result ? <div className="translation-result">
        <div className="provider-list">
          {result.results.map((providerResult) => {
            const providerDefinition = runtimeProvider(providerResult.providerId) ?? activeProvider;
            const provider = { ...providerDefinition, model: providerResult.model || providerDefinition.model };
            const resultKey = translationResultKey(providerResult);
            const isOpen = expandedProviderIds.includes(resultKey);
            return <article className={`provider-card ${isOpen ? "is-open" : "is-closed"} is-active`} key={resultKey}>
              <button className="provider-header" onClick={() => setExpandedProviderIds((ids) => isOpen ? ids.filter((id) => id !== resultKey) : [...ids, resultKey])} aria-expanded={isOpen}>
                <ProviderIcon provider={provider} />
                <span className="provider-heading"><strong>{provider.model}/{provider.vendor}</strong></span>
                <Icon name="chevron" />
              </button>
              {isOpen && <div className="provider-body" aria-busy={!providerResult.translation && !providerResult.error && loading}>
                <div className="text-line"><ExpandableText kind="source" text={normalizeSourceText(result.source)} /></div>
                <div className="text-line translation-line">
                  {providerResult.translation
                    ? <div className="translation-reveal" key={providerResult.translation}>
                      <div className="translation-reveal-inner">
                        <ExpandableText kind="translation" text={providerResult.translation} textClassName={translationLanguageClass(result.source)} />
                      </div>
                    </div>
                    : <div className="provider-placeholder" role="status" aria-live="polite"><span className="placeholder-dot" />{providerResult.error ?? (loading ? "翻译中…" : "翻译失败")}</div>}
                </div>
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
    </section>
  </main>;
}

function SettingsWindow() {
  const [settingsPage, setSettingsPage] = useState<SettingsPage>("providers");
  const [selectedSettingsProviderId, setSelectedSettingsProviderId] = useState<SettingsProviderId>("deepseek");
  const [providerDrafts, setProviderDrafts] = useState<Record<SettingsProviderId, ProviderDraft>>(createProviderDrafts);
  const [connectionState, setConnectionState] = useState<ConnectionState>({ providerId: null, status: "idle", message: "" });
  const {
    autoSelection, keepOnTop, quickTranslateProvider, quickTranslateModel,
    themeMode, sourceFontSize, translationFontSize, proxyMode, proxyType, proxyHost, proxyPort,
    proxyUsername, proxyPassword, proxyBypass, proxyTestUrl, providerOrder,
    setAutoSelection, setKeepOnTop, setQuickTranslateProvider, setQuickTranslateModel,
    setThemeMode, setSourceFontSize, setTranslationFontSize, setProxyMode, setProxyType, setProxyHost,
    setProxyPort, setProxyUsername, setProxyPassword, setProxyBypass, setProxyTestUrl, setProviderOrder,
    preferencesError,
  } = useUserPreferences();
  const [notice, setNotice] = useState("");
  const [proxyTestState, setProxyTestState] = useState<{ status: "idle" | "testing" | "success" | "error"; message: string }>({ status: "idle", message: "" });
  const [showApiKey, setShowApiKey] = useState(false);
  const [providerSearch, setProviderSearch] = useState("");
  const [providerOrderPreview, setProviderOrderPreview] = useState<ProviderId[] | null>(null);
  const [providerContextMenu, setProviderContextMenu] = useState<{ providerId: GenericProviderId; x: number; y: number } | null>(null);
  const [deletingProviderId, setDeletingProviderId] = useState<GenericProviderId | null>(null);
  const [enabledProviderIds, setEnabledProviderIds] = useState<SettingsProviderId[]>([]);
  const [settingsEnabledProviderModels, setSettingsEnabledProviderModels] = useState<Partial<Record<ProviderId, string[]>>>({});
  const [addedGenericProviders, setAddedGenericProviders] = useState<GenericProviderId[]>([]);
  const [fetchedModels, setFetchedModels] = useState<Partial<Record<SettingsProviderId, string[]>>>({});
  const [fetchingProviderId, setFetchingProviderId] = useState<SettingsProviderId | null>(null);
  const [modelDialogProviderId, setModelDialogProviderId] = useState<SettingsProviderId | null>(null);
  const [modelFetchMessage, setModelFetchMessage] = useState<{ providerId: SettingsProviderId | null; message: string }>({ providerId: null, message: "" });
  const [modelFetchDetail, setModelFetchDetail] = useState<{ providerId: SettingsProviderId | null; message: string }>({ providerId: null, message: "" });
  const [manualModelProviderIds, setManualModelProviderIds] = useState<SettingsProviderId[]>([]);
  const [testModels, setTestModels] = useState<Partial<Record<SettingsProviderId, string>>>({});
  const [testModelDialogProviderId, setTestModelDialogProviderId] = useState<SettingsProviderId | null>(null);
  const [testModelDialogSelection, setTestModelDialogSelection] = useState("");
  const [quickModelDialogOpen, setQuickModelDialogOpen] = useState(false);
  const connectionRequestId = useRef(0);
  const modelFetchRequestId = useRef(0);
  const providerAutoSaveTimers = useRef<Partial<Record<SettingsProviderId, number>>>({});
  const providerAutoSaveRequestIds = useRef<Partial<Record<SettingsProviderId, number>>>({});
  const providerDraftsRef = useRef(providerDrafts);
  const modelFetchButtonRef = useRef<HTMLButtonElement>(null);
  const modelDialogCloseRef = useRef<HTMLButtonElement>(null);
  const testModelDialogCloseRef = useRef<HTMLButtonElement>(null);
  const quickModelTriggerRef = useRef<HTMLButtonElement>(null);
  const quickModelDialogCloseRef = useRef<HTMLButtonElement>(null);
  const providerContextMenuRef = useRef<HTMLDivElement>(null);
  const providerContextMenuActionRef = useRef<HTMLButtonElement>(null);
  const providerOrderPreviewRef = useRef<ProviderId[] | null>(null);
  const providerRowElementsRef = useRef(new Map<ProviderId, HTMLDivElement>());
  const providerRowRectsRef = useRef(new Map<ProviderId, DOMRect>());
  const providerRowAnimationsRef = useRef(new Map<ProviderId, Animation>());
  providerDraftsRef.current = providerDrafts;

  useEffect(() => {
    if (preferencesError) setNotice(preferencesError);
  }, [preferencesError]);

  useEffect(() => () => {
    Object.values(providerAutoSaveTimers.current).forEach((timer) => {
      if (timer !== undefined) window.clearTimeout(timer);
    });
  }, []);

  useEffect(() => {
    if (!modelDialogProviderId) return;
    const frame = window.requestAnimationFrame(() => modelDialogCloseRef.current?.focus());
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeModelDialog();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [modelDialogProviderId]);

  useEffect(() => {
    if (!testModelDialogProviderId) return;
    const frame = window.requestAnimationFrame(() => testModelDialogCloseRef.current?.focus());
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeTestModelDialog();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [testModelDialogProviderId]);

  useEffect(() => {
    if (!quickModelDialogOpen) return;
    const frame = window.requestAnimationFrame(() => quickModelDialogCloseRef.current?.focus());
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeQuickModelDialog();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [quickModelDialogOpen]);

  useEffect(() => {
    if (!providerContextMenu) return;
    const frame = window.requestAnimationFrame(() => providerContextMenuActionRef.current?.focus());
    const closeOnPointerDown = (event: PointerEvent) => {
      if (!providerContextMenuRef.current?.contains(event.target as Node)) setProviderContextMenu(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setProviderContextMenu(null);
    };
    const closeMenu = () => setProviderContextMenu(null);
    document.addEventListener("pointerdown", closeOnPointerDown);
    document.addEventListener("keydown", closeOnEscape);
    document.addEventListener("scroll", closeMenu, true);
    window.addEventListener("resize", closeMenu);
    window.addEventListener("blur", closeMenu);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", closeOnPointerDown);
      document.removeEventListener("keydown", closeOnEscape);
      document.removeEventListener("scroll", closeMenu, true);
      window.removeEventListener("resize", closeMenu);
      window.removeEventListener("blur", closeMenu);
    };
  }, [providerContextMenu]);

  useEffect(() => {
    if (!isTauriDesktop()) return;
    void nativeInvoke<SettingsProviderId[]>("get_enabled_providers")
      .then((providers) => setEnabledProviderIds(providers ?? []))
      .catch((error) => setNotice(String(error)));
  }, []);

  useEffect(() => {
    if (!isTauriDesktop()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<SettingsProviderId[]>("enabled-providers-changed", (event) => setEnabledProviderIds(event.payload ?? []))
      .then((stopListening) => {
        if (disposed) stopListening();
        else unlisten = stopListening;
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!isTauriDesktop() || !enabledProviderIds.length) {
      setSettingsEnabledProviderModels({});
      return;
    }
    let cancelled = false;
    void Promise.all(enabledProviderIds.map(async (providerId) => {
      const config = await nativeInvoke<ProviderConfigResponse | null>("get_provider_config", { provider: providerId });
      return config ? [providerId, modelsFromConfig(config)] as const : null;
    })).then((entries) => {
      if (!cancelled) setSettingsEnabledProviderModels(Object.fromEntries(entries.filter((entry): entry is readonly [ProviderId, string[]] => entry !== null && entry[1].length > 0)));
    }).catch((error) => {
      if (!cancelled) setNotice(String(error));
    });
    return () => { cancelled = true; };
  }, [enabledProviderIds]);

  const providerWithCustomName = (provider: SettingsProvider) => {
    const customName = provider.id === "openai" ? providerDrafts.openai.vendorName.trim() : "";
    return customName ? withCustomProviderIdentity(provider, customName) : provider;
  };
  const providerCollection = orderProviders(
    [...SETTINGS_PROVIDERS, ...GENERIC_PROVIDERS.filter((provider) => addedGenericProviders.includes(provider.id as GenericProviderId))]
      .map(providerWithCustomName),
    providerOrderPreview ?? providerOrder,
  );
  const selectedSettingsProvider = providerCollection.find((provider) => provider.id === selectedSettingsProviderId)
    ?? providerWithCustomName(SETTINGS_PROVIDERS[0]);
  const selectedDraft = providerDrafts[selectedSettingsProvider.id];
  const configuredTestModels = uniqueModels(selectedDraft.models);
  const selectedTestModel = testModels[selectedSettingsProvider.id] && configuredTestModels.includes(testModels[selectedSettingsProvider.id]!)
    ? testModels[selectedSettingsProvider.id]!
    : (configuredTestModels.includes(selectedDraft.model) ? selectedDraft.model : configuredTestModels[0] ?? "");
  const filteredProviders = providerCollection.filter((provider) => {
    const query = providerSearch.trim().toLowerCase();
    return !query || `${provider.vendor} ${provider.model}`.toLowerCase().includes(query);
  });
  const isProviderPage = settingsPage === "providers" || settingsPage === "generic" || settingsPage === "connection";
  const activeNavPage = isProviderPage ? "providers" : settingsPage;
  const reorder = useLongPressReorder<ProviderId>({
    items: providerCollection.map((provider) => provider.id),
    disabled: Boolean(providerSearch.trim()),
    getItemLabel: (providerId) => providerCollection.find((provider) => provider.id === providerId)?.vendor ?? providerId,
    onReorderStart: () => {
      const current = providerCollection.map((provider) => provider.id);
      providerOrderPreviewRef.current = current;
      setProviderOrderPreview(current);
      setProviderContextMenu(null);
    },
    onReorder: ({ fromIndex, toIndex }) => {
      const current = providerOrderPreviewRef.current ?? providerCollection.map((provider) => provider.id);
      const next = [...current];
      const [moved] = next.splice(fromIndex, 1);
      if (!moved) return;
      next.splice(toIndex, 0, moved);
      providerOrderPreviewRef.current = next;
      setProviderOrderPreview(next);
    },
    onReorderEnd: () => {
      const orderedVisible = providerOrderPreviewRef.current;
      providerOrderPreviewRef.current = null;
      setProviderOrderPreview(null);
      if (!orderedVisible) return;
      const visibleIds = new Set<string>(orderedVisible);
      setProviderOrder([...orderedVisible, ...providerOrder.filter((providerId) => !visibleIds.has(providerId))]);
    },
    onReorderCancel: () => {
      providerOrderPreviewRef.current = null;
      setProviderOrderPreview(null);
    },
  });

  useLayoutEffect(() => {
    const nextRects = new Map<ProviderId, DOMRect>();
    const isReordering = reorder.state.phase === "dragging" || reorder.state.phase === "keyboard";
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

    for (const provider of filteredProviders) {
      const element = providerRowElementsRef.current.get(provider.id);
      if (!element) continue;

      const runningAnimation = providerRowAnimationsRef.current.get(provider.id);
      const isPointerActive = reorder.state.phase === "dragging" && reorder.state.activeId === provider.id;
      if (isPointerActive) {
        runningAnimation?.cancel();
        nextRects.set(provider.id, element.getBoundingClientRect());
        continue;
      }
      if (!isReordering && runningAnimation) {
        nextRects.set(
          provider.id,
          providerRowRectsRef.current.get(provider.id) ?? element.getBoundingClientRect(),
        );
        continue;
      }
      let previousTop = providerRowRectsRef.current.get(provider.id)?.top;
      if (runningAnimation) {
        previousTop = element.getBoundingClientRect().top;
        runningAnimation.cancel();
      }

      const nextRect = element.getBoundingClientRect();
      nextRects.set(provider.id, nextRect);
      const deltaY = previousTop === undefined ? 0 : previousTop - nextRect.top;
      if (!isReordering || reduceMotion || Math.abs(deltaY) < 0.5 || typeof element.animate !== "function") continue;

      const scale = reorder.state.activeId === provider.id ? " scale(1.008)" : "";
      const animation = element.animate([
        { transform: `translate3d(0, ${deltaY}px, 0)${scale}` },
        { transform: `translate3d(0, 0, 0)${scale}` },
      ], {
        duration: 190,
        easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
      });
      providerRowAnimationsRef.current.set(provider.id, animation);
      const forgetAnimation = () => {
        if (providerRowAnimationsRef.current.get(provider.id) === animation) {
          providerRowAnimationsRef.current.delete(provider.id);
        }
      };
      animation.onfinish = forgetAnimation;
      animation.oncancel = forgetAnimation;
    }

    providerRowRectsRef.current = nextRects;
  }, [filteredProviders, reorder.state.activeId, reorder.state.phase]);

  useEffect(() => () => {
    providerRowAnimationsRef.current.forEach((animation) => animation.cancel());
    providerRowAnimationsRef.current.clear();
  }, []);

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
        [provider.id]: draftFromConfig(config, provider.vendor),
      }), drafts));
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!isTauriDesktop()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<string>("provider-config-saved", (event) => {
      const provider = GENERIC_PROVIDERS.find((item) => item.id === event.payload);
      if (!provider) return;
      void Promise.all([
        nativeInvoke<ProviderConfigResponse | null>("get_provider_config", { provider: provider.id }),
        nativeInvoke<SettingsProviderId[]>("get_enabled_providers"),
      ]).then(([config, enabledIds]) => {
        if (disposed || !config) return;
        setAddedGenericProviders((providers) => providers.includes(provider.id as GenericProviderId) ? providers : [...providers, provider.id as GenericProviderId]);
        setProviderDrafts((drafts) => ({ ...drafts, [provider.id]: draftFromConfig(config, provider.vendor) }));
        setEnabledProviderIds(enabledIds);
        setSelectedSettingsProviderId(provider.id);
        setSettingsPage("generic");
        setNotice(`${provider.vendor} 已添加。`);
      }).catch((error) => {
        if (!disposed) setNotice(String(error));
      });
    }).then((stopListening) => {
      if (disposed) stopListening();
      else unlisten = stopListening;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!isTauriDesktop()) return;
    let cancelled = false;
    void nativeInvoke<ProviderConfigResponse | null>("get_provider_config", { provider: selectedSettingsProviderId })
      .then((config) => {
        if (cancelled || !config) return;
        setTestModels((models) => ({ ...models, [selectedSettingsProviderId]: config.model }));
        setProviderDrafts((drafts) => ({
          ...drafts,
          [selectedSettingsProviderId]: draftFromConfig(config, ALL_SETTINGS_PROVIDERS.find((item) => item.id === selectedSettingsProviderId)?.vendor ?? ""),
        }));
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [selectedSettingsProviderId]);

  function dragWindow(event: MouseEvent<HTMLElement>) {
    if ((event.target as HTMLElement).closest("button, input, textarea, select")) return;
    void getCurrentWindow().startDragging();
  }

  function switchSettingsPage(page: SettingsPage) {
    modelFetchRequestId.current += 1;
    setFetchingProviderId(null);
    setProviderContextMenu(null);
    setSettingsPage(page);
    setModelDialogProviderId(null);
    setNotice("");
    if (page === "providers" && !SETTINGS_PROVIDERS.some((provider) => provider.id === selectedSettingsProviderId)) {
      setSelectedSettingsProviderId(SETTINGS_PROVIDERS[0].id);
    }
    if (page === "generic" && !GENERIC_PROVIDERS.some((provider) => provider.id === selectedSettingsProviderId)) {
      setSelectedSettingsProviderId(GENERIC_PROVIDERS[0].id);
    }
  }

  function selectSettingsProvider(providerId: SettingsProviderId) {
    connectionRequestId.current += 1;
    modelFetchRequestId.current += 1;
    setProviderContextMenu(null);
    setFetchingProviderId(null);
    setModelDialogProviderId(null);
    setSelectedSettingsProviderId(providerId);
    if (settingsPage === "providers" || settingsPage === "generic") {
      setSettingsPage(GENERIC_PROVIDERS.some((provider) => provider.id === providerId) ? "generic" : "providers");
    }
    setConnectionState({ providerId: null, status: "idle", message: "" });
    setModelFetchMessage({ providerId: null, message: "" });
    setModelFetchDetail({ providerId: null, message: "" });
    setShowApiKey(false);
    setNotice("");
  }

  function closeQuickModelDialog() {
    setQuickModelDialogOpen(false);
    window.requestAnimationFrame(() => quickModelTriggerRef.current?.focus());
  }

  function openAddProvider() {
    setModelDialogProviderId(null);
    setProviderContextMenu(null);
    setNotice("");
    void nativeInvoke("open_add_provider_window").catch((error) => setNotice(String(error)));
  }

  function showProviderContextMenu(providerId: SettingsProviderId, x: number, y: number) {
    if (!addedGenericProviders.includes(providerId as GenericProviderId)) {
      setProviderContextMenu(null);
      return;
    }
    const menuWidth = 168;
    const menuHeight = 48;
    const edge = 8;
    setProviderContextMenu({
      providerId: providerId as GenericProviderId,
      x: Math.max(edge, Math.min(x, window.innerWidth - menuWidth - edge)),
      y: Math.max(edge, Math.min(y, window.innerHeight - menuHeight - edge)),
    });
  }

  async function deleteCustomProvider(providerId: GenericProviderId) {
    const providerName = providerCollection.find((provider) => provider.id === providerId)?.vendor ?? "自定义供应商";
    cancelProviderAutoSave(providerId);
    setDeletingProviderId(providerId);
    setNotice("");
    try {
      const providers = await nativeInvoke<SettingsProviderId[]>("delete_custom_provider", { provider: providerId });
      setEnabledProviderIds(providers ?? []);
      setAddedGenericProviders((current) => current.filter((id) => id !== providerId));
      setProviderDrafts((drafts) => ({ ...drafts, [providerId]: createProviderDrafts()[providerId] }));
      setFetchedModels((current) => { const next = { ...current }; delete next[providerId]; return next; });
      setSettingsEnabledProviderModels((current) => { const next = { ...current }; delete next[providerId]; return next; });
      setTestModels((current) => { const next = { ...current }; delete next[providerId]; return next; });
      setManualModelProviderIds((current) => current.filter((id) => id !== providerId));
      if (selectedSettingsProviderId === providerId) {
        setSelectedSettingsProviderId(SETTINGS_PROVIDERS[0].id);
        setSettingsPage("providers");
        setConnectionState({ providerId: null, status: "idle", message: "" });
      }
      setNotice(`${providerName} 已删除。`);
    } catch (error) {
      setNotice(String(error));
    } finally {
      setDeletingProviderId(null);
      setProviderContextMenu(null);
    }
  }

  function closeModelDialog(restoreFocus = true) {
    setModelDialogProviderId(null);
    if (restoreFocus) window.requestAnimationFrame(() => modelFetchButtonRef.current?.focus());
  }

  function closeTestModelDialog() {
    setTestModelDialogProviderId(null);
    setTestModelDialogSelection("");
  }

  function toggleFetchedModel(providerId: SettingsProviderId, model: string) {
    const draft = providerDraftsRef.current[providerId];
    const models = draft.models.includes(model)
      ? draft.models.filter((item) => item !== model)
      : [...draft.models, model];
    const nextDraft = { ...draft, model: models[0] ?? "", models };
    updateProviderDraft(providerId, nextDraft);
    scheduleProviderAutoSave(providerId, nextDraft);
  }

  function updateSelectedDraft<K extends keyof ProviderDraft>(field: K, value: ProviderDraft[K]) {
    const providerId = selectedSettingsProviderId;
    const nextDraft = { ...providerDraftsRef.current[providerId], [field]: value };
    updateProviderDraft(providerId, nextDraft);
    scheduleProviderAutoSave(providerId, nextDraft);
  }

  function addManualModel() {
    setManualModelProviderIds((providers) => providers.includes(selectedSettingsProviderId) ? providers : [...providers, selectedSettingsProviderId]);
    setProviderDrafts((drafts) => {
      const draft = drafts[selectedSettingsProviderId];
      if (draft.models.some((model) => !model.trim())) return drafts;
      const models = [...draft.models, ""];
      return { ...drafts, [selectedSettingsProviderId]: { ...draft, model: models[0] ?? "", models } };
    });
  }

  function updateSelectedModel(index: number, value: string) {
    const providerId = selectedSettingsProviderId;
    const draft = providerDraftsRef.current[providerId];
    const models = draft.models.map((model, modelIndex) => modelIndex === index ? value : model);
    const nextDraft = { ...draft, model: models[0] ?? "", models };
    updateProviderDraft(providerId, nextDraft);
    scheduleProviderAutoSave(providerId, nextDraft);
  }

  function removeSelectedModel(index: number) {
    const providerId = selectedSettingsProviderId;
    const draft = providerDraftsRef.current[providerId];
    const models = draft.models.filter((_, modelIndex) => modelIndex !== index);
    const nextDraft = { ...draft, model: models[0] ?? "", models };
    updateProviderDraft(providerId, nextDraft);
    scheduleProviderAutoSave(providerId, nextDraft);
  }

  function providerConfigPayload(provider: SettingsProvider, draft: ProviderDraft, models: string[]) {
    const payload: Record<string, unknown> = { provider: provider.id, apiKey: draft.apiKey, baseUrl: draft.baseUrl, model: models[0], models };
    if (provider.id === "openai") payload.vendorName = draft.vendorName;
    return payload;
  }

  function updateProviderDraft(providerId: SettingsProviderId, draft: ProviderDraft) {
    providerDraftsRef.current = { ...providerDraftsRef.current, [providerId]: draft };
    setProviderDrafts((drafts) => ({ ...drafts, [providerId]: draft }));
  }

  function scheduleProviderAutoSave(providerId: SettingsProviderId, draft: ProviderDraft) {
    const pendingTimer = providerAutoSaveTimers.current[providerId];
    if (pendingTimer !== undefined) window.clearTimeout(pendingTimer);
    const models = uniqueModels(draft.models);
    if (!draft.baseUrl.trim() || !models.length) {
      delete providerAutoSaveTimers.current[providerId];
      return;
    }
    providerAutoSaveTimers.current[providerId] = window.setTimeout(() => {
      delete providerAutoSaveTimers.current[providerId];
      void persistProviderDraft(providerId, draft, models);
    }, 500);
  }

  function cancelProviderAutoSave(providerId: SettingsProviderId) {
    const pendingTimer = providerAutoSaveTimers.current[providerId];
    if (pendingTimer !== undefined) window.clearTimeout(pendingTimer);
    delete providerAutoSaveTimers.current[providerId];
  }

  async function persistProviderDraft(providerId: SettingsProviderId, draft: ProviderDraft, models: string[]) {
    const provider = ALL_SETTINGS_PROVIDERS.find((item) => item.id === providerId);
    if (!provider) return;
    const requestId = (providerAutoSaveRequestIds.current[providerId] ?? 0) + 1;
    providerAutoSaveRequestIds.current[providerId] = requestId;
    try {
      await nativeInvoke("save_provider_config", providerConfigPayload(provider, draft, models));
      if (providerAutoSaveRequestIds.current[providerId] !== requestId) return;
      setProviderDrafts((drafts) => ({
        ...drafts,
        [providerId]: { ...drafts[providerId], saved: true },
      }));
      if (enabledProviderIds.includes(providerId)) {
        setSettingsEnabledProviderModels((current) => ({ ...current, [providerId]: models }));
      }
    } catch (error) {
      if (providerAutoSaveRequestIds.current[providerId] === requestId) setNotice(String(error));
    }
  }

  async function setSelectedProviderEnabled(enabled: boolean) {
    const provider = selectedSettingsProvider;
    const draft = providerDrafts[provider.id];
    try {
      if (enabled) {
        const models = uniqueModels(draft.models);
        if (!draft.baseUrl.trim() || !models.length) {
          setNotice("请先填写 API 地址，并至少添加一个模型。");
          return;
        }
        cancelProviderAutoSave(provider.id);
        await nativeInvoke("save_provider_config", providerConfigPayload(provider, draft, models));
        setProviderDrafts((drafts) => ({ ...drafts, [provider.id]: { ...drafts[provider.id], model: models[0], models, saved: true } }));
      }
      const providers = await nativeInvoke<SettingsProviderId[]>("set_provider_enabled", { provider: provider.id, enabled });
      setEnabledProviderIds(providers);
      setNotice("");
    } catch (error) {
      setNotice(String(error));
    }
  }

  async function openTestModelDialog() {
    const provider = selectedSettingsProvider;
    let models = uniqueModels(providerDrafts[provider.id].models);
    if (!models.length) {
      const config = await nativeInvoke<ProviderConfigResponse | null>("get_provider_config", { provider: provider.id }).catch(() => null);
      if (config) {
        const nextDraft = draftFromConfig(config, provider.vendor);
        models = uniqueModels(nextDraft.models);
        setProviderDrafts((drafts) => ({ ...drafts, [provider.id]: nextDraft }));
      }
    }
    if (!models.length) {
      setConnectionState({ providerId: provider.id, status: "error", message: "请先配置模型" });
      return;
    }
    const currentModel = testModels[provider.id];
    setTestModelDialogSelection(currentModel && models.includes(currentModel) ? currentModel : models[0]);
    setModelDialogProviderId(null);
    setTestModelDialogProviderId(provider.id);
  }

  async function testConnection(modelOverride?: string) {
    if (!modelOverride) {
      await openTestModelDialog();
      return;
    }
    const provider = selectedSettingsProvider;
    let draft = providerDrafts[provider.id];
    let models = uniqueModels(draft.models);
    let model = modelOverride || selectedTestModel;
    if (!model || !models.includes(model)) {
      const config = await nativeInvoke<ProviderConfigResponse | null>("get_provider_config", { provider: provider.id }).catch(() => null);
      if (config) {
        draft = draftFromConfig(config, provider.vendor);
        models = uniqueModels(draft.models);
        model = draft.model;
      }
    }
    if (!model || !models.includes(model)) {
      setConnectionState({ providerId: provider.id, status: "error", message: "请先配置并选择一个模型" });
      return;
    }
    const requestId = connectionRequestId.current + 1;
    connectionRequestId.current = requestId;
    setConnectionState({ providerId: provider.id, status: "testing", message: "正在发送测试请求…" });
    try {
      const result = await nativeInvoke<{ latencyMs: number; message: string }>("test_provider_connection", {
        provider: provider.id, apiKey: draft.apiKey, baseUrl: draft.baseUrl, model,
      });
      if (requestId !== connectionRequestId.current) return;
      setConnectionState({ providerId: provider.id, status: "success", message: `${result.message} · ${result.latencyMs} ms` });
    } catch (error) {
      if (requestId !== connectionRequestId.current) return;
      const message = String(error).replace(/\s+/g, " ").trim();
      setConnectionState({ providerId: provider.id, status: "error", message: message.length > 160 ? `${message.slice(0, 157)}…` : message });
    }
  }

  async function fetchProviderModels() {
    const provider = selectedSettingsProvider;
    const draft = providerDrafts[provider.id];
    if (!draft.baseUrl.trim()) {
      setModelFetchMessage({ providerId: provider.id, message: "请先填写 URL。" });
      return;
    }
    const requestId = modelFetchRequestId.current + 1;
    modelFetchRequestId.current = requestId;
    setModelDialogProviderId(provider.id);
    setFetchingProviderId(provider.id);
    setModelFetchMessage({ providerId: provider.id, message: "" });
    setModelFetchDetail({ providerId: provider.id, message: "" });
    try {
      const models = await nativeInvoke<string[]>("fetch_provider_models", {
        provider: provider.id,
        apiKey: draft.apiKey,
        baseUrl: draft.baseUrl,
      });
      if (requestId !== modelFetchRequestId.current) return;
      setFetchedModels((current) => ({ ...current, [provider.id]: models }));
      setModelFetchMessage({ providerId: provider.id, message: "" });
      setModelFetchDetail({ providerId: provider.id, message: "" });
    } catch (error) {
      if (requestId !== modelFetchRequestId.current) return;
      setModelFetchMessage({ providerId: provider.id, message: "获取模型列表失败" });
      setModelFetchDetail({ providerId: provider.id, message: String(error).replace(provider.id, provider.vendor) });
    } finally {
      if (requestId === modelFetchRequestId.current) setFetchingProviderId(null);
    }
  }

  function renderModelDialog() {
    if (!modelDialogProviderId) return renderTestModelDialog();
    const provider = providerCollection.find((item) => item.id === modelDialogProviderId);
    if (!provider) return null;
    const models = fetchedModels[provider.id] ?? [];
    const selectedModels = providerDrafts[provider.id]?.models ?? [];
    const isLoading = fetchingProviderId === provider.id;
    const fetchError = modelFetchDetail.providerId === provider.id ? modelFetchDetail.message : "";

    return <AvailableModelsDialog
      provider={provider}
      models={models}
      selectedModels={selectedModels}
      isLoading={isLoading}
      fetchError={fetchError}
      closeButtonRef={modelDialogCloseRef}
      onToggle={(model) => toggleFetchedModel(provider.id, model)}
      onClose={() => closeModelDialog()}
      onRetry={() => void fetchProviderModels()}
    />;
  }

  function renderTestModelDialog() {
    if (!testModelDialogProviderId) return null;
    const provider = providerCollection.find((item) => item.id === testModelDialogProviderId);
    if (!provider) return null;
    const models = uniqueModels(providerDrafts[provider.id]?.models ?? []);

    return <>
      <button type="button" className="model-dialog-backdrop" aria-label="关闭测试模型窗口" onClick={closeTestModelDialog} />
      <div className="model-dialog-card test-model-dialog-card" role="dialog" aria-modal="true" aria-labelledby="test-model-dialog-title">
        <header className="model-dialog-header">
          <div className="model-dialog-heading"><h2 id="test-model-dialog-title">请选择要检测的模型</h2></div>
          <button ref={testModelDialogCloseRef} type="button" className="model-dialog-close" onClick={closeTestModelDialog} aria-label="关闭测试模型窗口" title="关闭"><Icon name="close" /></button>
        </header>
        <div className="test-model-dialog-content"><div className="test-model-select-field"><span>选择模型</span><InlineSelect value={testModelDialogSelection} options={models} onChange={setTestModelDialogSelection} ariaLabel="选择测试模型" /></div></div>
        <footer className="model-dialog-footer"><button type="button" className="test-model-dialog-cancel" onClick={closeTestModelDialog}>取消</button><button type="button" onClick={() => { const model = testModelDialogSelection; setTestModels((current) => ({ ...current, [provider.id]: model })); closeTestModelDialog(); void testConnection(model); }}>测试连接</button></footer>
      </div>
    </>;
  }

  function renderProviderDetails() {
    const isEnabledForTranslation = enabledProviderIds.includes(selectedSettingsProvider.id);
    const isFetchingModels = fetchingProviderId === selectedSettingsProvider.id;
    const showModelEditor = selectedDraft.models.length > 0 || manualModelProviderIds.includes(selectedSettingsProvider.id);
    return <div className="provider-detail-page">
      <h1 className="sr-only">{settingsPage === "generic" ? "通用接口配置" : "厂商接口配置"}</h1>
      <div className="provider-detail-intro">
        <div><h2>{selectedSettingsProvider.vendor}</h2></div>
        <label className="settings-switch" title={isEnabledForTranslation ? "从翻译中移除" : "加入翻译"}><input type="checkbox" checked={isEnabledForTranslation} onChange={(event) => void setSelectedProviderEnabled(event.target.checked)} aria-label="启用此翻译模型" /><span aria-hidden="true" /></label>
      </div>
      <section className="settings-form-card provider-config-card">
        <div className="settings-field-group">
          <div className="settings-label-row"><label className="field-label" htmlFor="provider-api-key">API Key</label><button className="inline-test" type="button" onClick={() => void testConnection()} disabled={connectionState.status === "testing"}><span aria-hidden="true">♡</span>{connectionState.status === "testing" ? "测试中" : "测试连接"}</button></div>
          <div className="api-key-input-wrap"><input id="provider-api-key" aria-label="API Key" value={selectedDraft.apiKey} onChange={(event) => updateSelectedDraft("apiKey", event.target.value)} type={showApiKey ? "text" : "password"} placeholder={selectedDraft.saved ? "已保存，留空以保留当前 Key" : ""} /><button type="button" className="api-key-toggle" onClick={() => setShowApiKey((visible) => !visible)} aria-label={showApiKey ? "隐藏 API Key" : "显示 API Key"} title={showApiKey ? "隐藏 API Key" : "显示 API Key"}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.4-5.5 9.5-5.5 9.5 5.5 9.5 5.5-3.4 5.5-9.5 5.5S2.5 12 2.5 12Z" /><circle cx="12" cy="12" r="2.5" /></svg></button></div>
          {connectionState.providerId === selectedSettingsProvider.id && connectionState.status !== "idle" && <span className={`connection-inline-result connection-field-result ${connectionState.status}`} role="status" title={connectionState.message}>{connectionState.message}</span>}
        </div>
        <div className="settings-field-group"><label className="field-label" htmlFor="provider-base-url">API 地址</label><input id="provider-base-url" value={selectedDraft.baseUrl} onChange={(event) => updateSelectedDraft("baseUrl", event.target.value)} spellCheck={false} placeholder="填写服务地址或完整的 /chat/completions 地址" /></div>
        <div className="model-section provider-model-section">
          <div className="model-section-header">
            <div className="model-section-title"><h3>模型</h3><span>{selectedDraft.models.filter((model) => model.trim()).length}</span></div>
            <div className="model-toolbar">
              <button type="button" aria-label="添加模型" title="添加模型" aria-expanded={showModelEditor} onClick={addManualModel}><ModelAddIcon /></button>
              {modelFetchMessage.providerId === selectedSettingsProvider.id && modelFetchMessage.message && <span className="model-fetch-message" role="status" title={modelFetchMessage.message}><span className="model-fetch-message-icon" aria-hidden="true">!</span><span>{modelFetchMessage.message}</span></span>}
              <button ref={modelFetchButtonRef} className="fetch-models" type="button" onClick={() => void fetchProviderModels()} disabled={isFetchingModels} aria-busy={isFetchingModels}><ModelRefreshIcon /><span>获取</span></button>
            </div>
          </div>
          {showModelEditor && <div className="model-group">
            <div className="model-group-heading"><strong>{selectedSettingsProvider.vendor}</strong></div>
            {selectedDraft.models.map((model, index) => <div className="model-row" key={index}><ProviderIcon provider={selectedSettingsProvider} /><label className="model-input-label" htmlFor={`provider-model-${index}`}><span className="sr-only">模型名称</span><input id={`provider-model-${index}`} value={model} onChange={(event) => updateSelectedModel(index, event.target.value)} spellCheck={false} /></label><button type="button" className="model-remove-button" onClick={() => removeSelectedModel(index)} aria-label={model ? `移除模型 ${model}` : "移除模型"} title="移除模型">−</button></div>)}
          </div>}
        </div>
      </section>
    </div>;
  }

  function renderConnectionPage() {
    return <div className="settings-page-view"><div className="settings-page-heading"><div><p className="settings-page-eyebrow">连通性</p><h1>连接测试</h1></div><span className="settings-page-meta">实时请求</span></div><p className="settings-description">选择一个已配置的接口，发送最小测试请求，确认地址、密钥和模型都可用。</p><div className="connection-selector-card"><label className="field-label" htmlFor="connection-provider">测试接口</label><select id="connection-provider" value={selectedSettingsProvider.id} onChange={(event) => selectSettingsProvider(event.target.value as SettingsProviderId)}><optgroup label="AI 提供商">{SETTINGS_PROVIDERS.map((provider) => <option value={provider.id} key={provider.id}>{provider.vendor} · {provider.model}</option>)}</optgroup><optgroup label="通用接口">{GENERIC_PROVIDERS.map((provider) => <option value={provider.id} key={provider.id}>{provider.vendor} · {provider.model}</option>)}</optgroup></select><div className="connection-summary"><ProviderIcon provider={selectedSettingsProvider} /><div><strong>{selectedSettingsProvider.vendor}</strong><span>{selectedDraft.baseUrl}</span><span>{selectedDraft.model}</span></div></div>{connectionState.providerId === selectedSettingsProvider.id && connectionState.status !== "idle" && <p className={`connection-result ${connectionState.status}`} role="status">{connectionState.message}</p>}<button className="primary connection-test-button" onClick={() => void testConnection()} disabled={connectionState.status === "testing"}>{connectionState.status === "testing" ? "正在测试…" : "开始测试连接"}</button></div><div className="connection-note"><span className="note-mark">i</span><p>测试只发送一条最小请求，不会触发翻译，也不会保存明文 API Key。</p></div></div>;
  }

  function renderPreferencesPage() {
    const defaultModelChoices = enabledProviderIds.flatMap((providerId) => {
      const provider = providerCollection.find((item) => item.id === providerId);
      return provider ? (settingsEnabledProviderModels[providerId] ?? [provider.model]).map((model) => ({ id: modelChoiceKey(providerId, model), providerId, model, vendor: provider.vendor })) : [];
    });
    return <div className="settings-page-view preferences-settings-page"><h1 className="sr-only">偏好设置</h1>
      <section className="preferences-section" aria-labelledby="preferences-general-title">
        <header className="preferences-section-heading"><h2 id="preferences-general-title">偏好</h2></header>
        <div className="preferences-section-rows">
          <div className="default-quick-model-card"><div className="default-quick-model-copy"><strong>默认快速翻译模型</strong></div><div className="default-quick-model-control">{renderQuickModelTrigger(defaultModelChoices)}</div></div>
          <div className="appearance-setting-row"><div><strong>颜色模式</strong></div><SegmentedControl ariaLabel="颜色模式" value={themeMode} options={[{ value: "light", label: "浅色" }, { value: "dark", label: "深色" }, { value: "system", label: "跟随系统" }]} onChange={(value) => setThemeMode(value as ThemeMode)} /></div>
          <div className="preference-setting-row"><div><strong>选中文本自动显示悬浮按钮</strong></div><label className="settings-switch"><input aria-label="选中文本自动显示悬浮按钮" type="checkbox" checked={autoSelection} onChange={(event) => setAutoSelection(event.target.checked)} /><span aria-hidden="true" /></label></div>
          <div className="preference-setting-row"><div><strong>翻译窗口保持置顶</strong></div><label className="settings-switch"><input aria-label="翻译窗口保持置顶" type="checkbox" checked={keepOnTop} onChange={(event) => setKeepOnTop(event.target.checked)} /><span aria-hidden="true" /></label></div>
        </div>
      </section>
      <section className="preferences-section" aria-labelledby="preferences-font-title">
        <header className="preferences-section-heading"><h2 id="preferences-font-title">字体</h2></header>
        <div className="preferences-section-rows">
          <div className="font-size-setting-row"><div><strong>原文字号</strong></div><label><span>{sourceFontSize}px</span><input aria-label="原文字号" type="range" min="12" max="24" step="1" value={sourceFontSize} onChange={(event) => setSourceFontSize(Number(event.target.value))} /></label></div>
          <div className="font-size-setting-row"><div><strong>译文字号</strong></div><label><span>{translationFontSize}px</span><input aria-label="译文字号" type="range" min="12" max="28" step="1" value={translationFontSize} onChange={(event) => setTranslationFontSize(Number(event.target.value))} /></label></div>
        </div>
      </section>
      <section className="preferences-section preferences-secondary-section" aria-labelledby="preferences-other-title">
        <header className="preferences-section-heading"><h2 id="preferences-other-title">其他</h2></header>
        <div className="preferences-section-rows"><div className="placeholder-setting-row"><div><strong>启动时自动运行</strong></div><span className="placeholder-badge">即将支持</span></div><div className="placeholder-setting-row"><div><strong>默认目标语言</strong></div><span className="placeholder-value">自动识别</span></div><div className="placeholder-setting-row"><div><strong>配置同步</strong></div><span className="placeholder-badge">即将支持</span></div></div>
      </section>
      {quickModelDialogOpen && renderQuickModelDialog(defaultModelChoices)}
    </div>;
  }

  function renderQuickModelTrigger(choices: ModelChoice[]) {
    const selectedChoice = choices.find((choice) => choice.providerId === quickTranslateProvider && (choice.model === quickTranslateModel || quickTranslateModel === null)) ?? null;
    const selectedProvider = selectedChoice
      ? providerCollection.find((provider) => provider.id === selectedChoice.providerId)
      : null;
    return <button ref={quickModelTriggerRef} className="default-quick-model-trigger" type="button" aria-label="设置默认快速翻译模型" aria-haspopup="dialog" aria-expanded={quickModelDialogOpen} onClick={() => setQuickModelDialogOpen(true)} disabled={!choices.length}>
      {selectedProvider ? <ProviderIcon provider={selectedProvider} /> : <span className="model-picker-placeholder-icon" aria-hidden="true">◇</span>}
      <span className="default-quick-model-value">{selectedChoice && selectedProvider ? <><strong>{selectedChoice.model}</strong><small>{selectedProvider.vendor}</small></> : <strong>未配置模型</strong>}</span>
    </button>;
  }

  function renderQuickModelDialog(choices: ModelChoice[]) {
    const selectedChoice = choices.find((choice) => choice.providerId === quickTranslateProvider && (choice.model === quickTranslateModel || quickTranslateModel === null)) ?? null;
    return <>
      <button type="button" className="quick-model-dialog-backdrop" aria-label="关闭模型选择" onClick={closeQuickModelDialog} />
      <section className="quick-model-dialog" role="dialog" aria-modal="true" aria-labelledby="quick-model-dialog-title">
        <header className="quick-model-dialog-header">
          <h2 id="quick-model-dialog-title">选择默认模型</h2>
          <button ref={quickModelDialogCloseRef} type="button" className="quick-model-dialog-close" onClick={closeQuickModelDialog} aria-label="关闭模型选择" title="关闭"><Icon name="close" /></button>
        </header>
        <div className="quick-model-choice-list" role="list" aria-label="已配置模型">
        {choices.map((choice) => {
          const provider = providerCollection.find((item) => item.id === choice.providerId);
          if (!provider) return null;
          const selected = choice.id === selectedChoice?.id;
          return <div role="listitem" key={choice.providerId}><button className={`quick-model-choice${selected ? " is-selected" : ""}`} type="button" aria-pressed={selected} onClick={() => {
            setQuickTranslateProvider(choice.providerId);
            setQuickTranslateModel(choice.model);
            closeQuickModelDialog();
          }}>
            <ProviderIcon provider={provider} />
            <span><strong>{choice.model}</strong><small>{provider.vendor}</small></span>
            {selected && <CheckIcon />}
          </button></div>;
        })}
        </div>
      </section>
    </>;
  }

  function renderProxyPage() {
    const proxyEnabled = proxyMode === "custom";
    const testProxy = async () => {
      if (!proxyEnabled || !proxyTestUrl.trim()) return;
      setProxyTestState({ status: "testing", message: "正在测试代理连接…" });
      try {
        const message = await nativeInvoke<string>("test_proxy_connection", { url: proxyTestUrl.trim() });
        setProxyTestState({ status: "success", message });
      } catch (error) {
        setProxyTestState({ status: "error", message: String(error) });
      }
    };
    return <div className="settings-page-view proxy-settings-page">
      <section className="proxy-settings-card" aria-labelledby="proxy-settings-title">
        <h2 id="proxy-settings-title">代理设置</h2>
        <div className="proxy-settings-rows">
          <div className="proxy-form-row"><span>启动代理</span><label className="settings-switch"><input aria-label="启动代理" type="checkbox" checked={proxyEnabled} onChange={(event) => setProxyMode(event.target.checked ? "custom" : "disabled")} /><span aria-hidden="true" /></label></div>
          <label className="proxy-form-row"><span>代理类型</span><select aria-label="代理类型" value={proxyType} disabled={!proxyEnabled} onChange={(event) => setProxyType(event.target.value as ProxyType)}><option value="http">HTTP</option><option value="https">HTTPS</option><option value="socks4">SOCKS4</option><option value="socks5">SOCKS5</option></select></label>
          <label className="proxy-form-row"><span>服务器地址</span><input aria-label="服务器地址" value={proxyHost} disabled={!proxyEnabled} onChange={(event) => setProxyHost(event.target.value)} placeholder="127.0.0.1" spellCheck={false} /></label>
          <label className="proxy-form-row"><span>端口</span><input aria-label="端口" inputMode="numeric" value={proxyPort} disabled={!proxyEnabled} onChange={(event) => setProxyPort(event.target.value.replace(/\D/g, ""))} placeholder="7890" /></label>
          <label className="proxy-form-row"><span>用户名</span><input aria-label="代理用户名" value={proxyUsername} disabled={!proxyEnabled} onChange={(event) => setProxyUsername(event.target.value)} placeholder="可选" autoComplete="off" /></label>
          <label className="proxy-form-row"><span>密码</span><input aria-label="代理密码" type="password" value={proxyPassword} disabled={!proxyEnabled} onChange={(event) => setProxyPassword(event.target.value)} placeholder="可选" autoComplete="new-password" /></label>
          <label className="proxy-form-row proxy-bypass-row"><span>代理绕过</span><textarea aria-label="代理绕过地址" value={proxyBypass} disabled={!proxyEnabled} onChange={(event) => setProxyBypass(event.target.value)} spellCheck={false} /></label>
          <p className="proxy-priority-note">同时配置全局代理与供应商代理时，将优先使用供应商代理。</p>
        </div>
      </section>
      <section className="proxy-test-panel" aria-label="代理连接测试">
        <label className="proxy-test-url"><span>连接测试</span><input aria-label="代理测试地址" value={proxyTestUrl} disabled={!proxyEnabled} onChange={(event) => setProxyTestUrl(event.target.value)} spellCheck={false} /></label>
        <button type="button" onClick={() => void testProxy()} disabled={!proxyEnabled || proxyTestState.status === "testing"}>{proxyTestState.status === "testing" ? "测试中…" : "测试"}</button>
        {proxyTestState.status !== "idle" && <p className={`proxy-test-result ${proxyTestState.status}`} role="status">{proxyTestState.message}</p>}
      </section>
    </div>;
  }

  function renderAboutPage() {
    return <div className="settings-page-view about-page">
      <header className="about-brand"><img src={appIcon} alt="" /><div><h1>AI Translate</h1><p>轻量、快速的 Windows 桌面翻译工具</p></div></header>
      <div className="about-info-list" aria-label="软件信息">
        <div className="about-info-row"><span className="about-link-icon" aria-hidden="true"><AboutIcon name="version" /></span><strong>版本</strong><span className="about-info-value">v{APP_VERSION} · 开发预览版</span></div>
        <div className="about-info-row"><span className="about-link-icon" aria-hidden="true"><AboutIcon name="refresh" /></span><strong>检查更新</strong><button type="button" className="about-update-button" disabled aria-describedby="about-update-status">暂不可用</button></div>
        {PROJECT_LINKS.map((link) => <div className="about-info-row" key={link.id}><span className="about-link-icon" aria-hidden="true"><AboutIcon name={link.id === "repository" ? "github" : "issues"} /></span><strong>{link.title}</strong>{link.url ? <a className="about-link-action" href={link.url} target="_blank" rel="noreferrer">{link.url}<AboutIcon name="external" /></a> : <span className="about-pending-badge">待配置</span>}</div>)}
      </div>
      <p className="about-update-status" id="about-update-status" role="status"><span aria-hidden="true" />自动更新暂不可用；源代码与问题反馈可通过上方入口访问。</p>
    </div>;
  }

  function renderProviderContextMenu() {
    if (!providerContextMenu) return null;
    const provider = providerCollection.find((item) => item.id === providerContextMenu.providerId);
    if (!provider) return null;
    const deleting = deletingProviderId === provider.id;
    return <div ref={providerContextMenuRef} className="provider-context-menu" role="menu" aria-label={`${provider.vendor} 操作`} style={{ left: providerContextMenu.x, top: providerContextMenu.y }}>
      <button ref={providerContextMenuActionRef} type="button" role="menuitem" className="provider-context-menu-delete" onClick={() => void deleteCustomProvider(provider.id as GenericProviderId)} disabled={deleting} aria-label={`删除供应商 ${provider.vendor}`}><DeleteIcon /><span>{deleting ? "删除中…" : "删除供应商"}</span></button>
    </div>;
  }

  function renderProviderColumn() {
    const draggedProvider = reorder.state.phase === "dragging" && reorder.state.activeId
      ? providerCollection.find((provider) => provider.id === reorder.state.activeId) ?? null
      : null;
    const draggedProviderEnabled = draggedProvider
      ? enabledProviderIds.includes(draggedProvider.id)
      : false;
    const dragOverlayStyle = reorder.state.dragOverlay
      ? {
          "--provider-overlay-x": `${reorder.state.dragOverlay.left}px`,
          "--provider-overlay-y": `${reorder.state.dragOverlay.top}px`,
          width: `${reorder.state.dragOverlay.width}px`,
          height: `${reorder.state.dragOverlay.height}px`,
        } as CSSProperties
      : undefined;
    return <aside className="settings-provider-column">
      <div className="provider-search"><SearchIcon /><input aria-label="搜索供应商或分组" value={providerSearch} onChange={(event) => setProviderSearch(event.target.value)} placeholder="搜索供应商或分组" /></div>
      <div className="provider-list-heading"><span>可用接口</span><strong>{filteredProviders.length}</strong></div>
      <nav className={`provider-list-nav${reorder.state.phase === "dragging" ? " is-pointer-dragging" : ""}`} aria-label="供应商列表">{filteredProviders.map((provider) => {
        const enabled = enabledProviderIds.includes(provider.id);
        const isCustom = addedGenericProviders.includes(provider.id as GenericProviderId);
        const isPressing = reorder.state.activeId === provider.id && reorder.state.phase === "pressing";
        const isPointerPlaceholder = reorder.state.activeId === provider.id && reorder.state.phase === "dragging";
        const isDragging = reorder.state.activeId === provider.id && reorder.state.phase === "keyboard";
        const isOver = reorder.state.phase === "keyboard"
          && reorder.state.overId === provider.id
          && reorder.state.activeId !== provider.id;
        const reorderProps = reorder.getItemProps<HTMLButtonElement>(provider.id);
        return <div
          className={`provider-list-row${isPressing ? " is-pressing" : ""}${isPointerPlaceholder ? " is-placeholder" : ""}${isDragging ? " is-dragging" : ""}${isOver ? " is-over" : ""}`}
          key={provider.id}
          ref={(element) => {
            if (element) providerRowElementsRef.current.set(provider.id, element);
            else providerRowElementsRef.current.delete(provider.id);
          }}
        ><button
            type="button"
            className={`provider-list-item ${provider.id === selectedSettingsProvider.id ? "is-selected" : ""}`}
            {...reorderProps}
            onClick={() => selectSettingsProvider(provider.id)}
            onContextMenu={(event) => {
              if (!isCustom) {
                setProviderContextMenu(null);
                return;
              }
              event.preventDefault();
              showProviderContextMenu(provider.id, event.clientX, event.clientY);
            }}
            onKeyDown={(event) => {
              reorderProps.onKeyDown(event);
              if (event.defaultPrevented) return;
              if (!isCustom || !(event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) return;
              event.preventDefault();
              const rect = event.currentTarget.getBoundingClientRect();
              showProviderContextMenu(provider.id, rect.left + 28, rect.bottom - 4);
            }}
            aria-haspopup={isCustom ? "menu" : undefined}
            aria-expanded={isCustom ? providerContextMenu?.providerId === provider.id : undefined}
          ><ProviderIcon provider={provider} /><span className="provider-list-copy"><strong>{provider.vendor}</strong></span><span className={`provider-list-status-dot ${enabled ? "is-enabled" : ""}`} aria-hidden="true" /><span className="sr-only">{enabled ? "已启用" : "未启用"}</span></button></div>;
      })}</nav>
      {draggedProvider && dragOverlayStyle && <div
        className="provider-list-row provider-drag-overlay"
        style={dragOverlayStyle}
        aria-hidden="true"
      ><div className={`provider-list-item ${draggedProvider.id === selectedSettingsProvider.id ? "is-selected" : ""}`}>
          <ProviderIcon provider={draggedProvider} />
          <span className="provider-list-copy"><strong>{draggedProvider.vendor}</strong></span>
          <span className={`provider-list-status-dot ${draggedProviderEnabled ? "is-enabled" : ""}`} />
        </div></div>}
      <span className="sr-only" role="status" {...reorder.liveRegionProps} />
      <div className="provider-column-footer"><button type="button" className="provider-add-button" onClick={() => openAddProvider()}>＋ 添加自定义供应商</button></div>
    </aside>;
  }

  return <main className="app-shell settings-window-shell"><section className={`settings-shell settings-shell-${isProviderPage ? "providers" : "single"}`}><div className="settings-topbar" onMouseDown={dragWindow}><div className="settings-brand settings-brand-top"><img src={appIcon} alt="AI Translate 图标" /><div><strong>AI Translate</strong></div></div><div className="settings-window-actions"><button type="button" className="settings-window-button settings-minimize-button" onClick={() => void nativeInvoke<void>("minimize_window").catch(() => undefined)} aria-label="最小化" title="最小化"><Icon name="minimize" /></button><button type="button" className="settings-close-button" onClick={() => void nativeInvoke("hide_settings_window")} aria-label="关闭设置" title="关闭设置"><Icon name="close" /></button></div></div><aside className="settings-nav-panel"><div className="settings-brand" onMouseDown={dragWindow}><img src={appIcon} alt="AI Translate 图标" /><div><strong>AI Translate</strong><small>设置中心</small></div></div><nav className="settings-primary-nav" aria-label="设置分类"><button type="button" className={activeNavPage === "preferences" ? "is-active" : ""} onClick={() => switchSettingsPage("preferences")}><SettingsNavIcon name="preferences" />偏好设置</button><button type="button" className={activeNavPage === "providers" ? "is-active" : ""} onClick={() => switchSettingsPage("providers")}><SettingsNavIcon name="providers" />供应商</button><button type="button" className={activeNavPage === "proxy" ? "is-active" : ""} onClick={() => switchSettingsPage("proxy")}><SettingsNavIcon name="proxy" />网络代理</button><button type="button" className={activeNavPage === "about" ? "is-active" : ""} onClick={() => switchSettingsPage("about")}><SettingsNavIcon name="about" />关于</button></nav></aside>{isProviderPage && renderProviderColumn()}<section className="settings-main">{settingsPage === "connection" ? renderConnectionPage() : settingsPage === "preferences" ? renderPreferencesPage() : settingsPage === "proxy" ? renderProxyPage() : settingsPage === "about" ? renderAboutPage() : renderProviderDetails()}{notice && !isProviderPage && <p className="notice" role="status">{notice}</p>}</section>{renderModelDialog()}{renderProviderContextMenu()}</section></main>;
}

function AddProviderWindow() {
  useUserPreferences();
  const [providerDrafts, setProviderDrafts] = useState<Record<SettingsProviderId, ProviderDraft>>(() => {
    const drafts = createProviderDrafts();
    return { ...drafts, openai: { ...drafts.openai, vendorName: "" } };
  });
  const [showApiKey, setShowApiKey] = useState(false);
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const [fetchedModels, setFetchedModels] = useState<string[]>([]);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [modelDialogOpen, setModelDialogOpen] = useState(false);
  const [modelFetchError, setModelFetchError] = useState("");
  const modelDialogCloseRef = useRef<HTMLButtonElement>(null);
  const modelFetchButtonRef = useRef<HTMLButtonElement>(null);
  const provider = GENERIC_PROVIDERS[0];
  const draft = providerDrafts.openai;
  const dialogProvider = withCustomProviderIdentity(provider, draft.vendorName);

  useEffect(() => {
    if (!modelDialogOpen) return;
    const frame = window.requestAnimationFrame(() => modelDialogCloseRef.current?.focus());
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeModelDialog();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [modelDialogOpen]);

  function dragWindow(event: MouseEvent<HTMLElement>) {
    if ((event.target as HTMLElement).closest("button, input")) return;
    void getCurrentWindow().startDragging();
  }

  function updateDraft(field: keyof ProviderDraft, value: string) {
    setProviderDrafts((drafts) => ({ ...drafts, openai: { ...drafts.openai, [field]: value } }));
  }

  function returnToSettings() {
    void nativeInvoke("return_to_settings_window").catch((error) => setNotice(String(error)));
  }

  function closeModelDialog() {
    setModelDialogOpen(false);
    window.requestAnimationFrame(() => modelFetchButtonRef.current?.focus());
  }

  function toggleFetchedModel(model: string) {
    setProviderDrafts((drafts) => {
      const currentDraft = drafts.openai;
      const currentModels = uniqueModels(currentDraft.models);
      const models = currentModels.includes(model)
        ? currentModels.filter((item) => item !== model)
        : [...currentModels, model];
      return { ...drafts, openai: { ...currentDraft, model: models[0] ?? "", models } };
    });
  }

  function updateModel(index: number, value: string) {
    setProviderDrafts((drafts) => {
      const currentDraft = drafts.openai;
      const models = currentDraft.models.length ? [...currentDraft.models] : [currentDraft.model];
      models[index] = value;
      return { ...drafts, openai: { ...currentDraft, model: models[0] ?? "", models } };
    });
  }

  function removeModel(index: number) {
    setProviderDrafts((drafts) => {
      const currentDraft = drafts.openai;
      const models = currentDraft.models.filter((_, modelIndex) => modelIndex !== index);
      return { ...drafts, openai: { ...currentDraft, model: models[0] ?? "", models } };
    });
  }

  async function fetchModels() {
    if (!draft.baseUrl.trim()) {
      setNotice("请先填写 API 地址");
      return;
    }
    setModelDialogOpen(true);
    setFetchingModels(true);
    setModelFetchError("");
    setNotice("");
    try {
      const models = await nativeInvoke<string[]>("fetch_provider_models", { provider: provider.id, apiKey: draft.apiKey, baseUrl: draft.baseUrl });
      setFetchedModels(uniqueModels(models));
    } catch (error) {
      setModelFetchError(String(error).replace(provider.id, dialogProvider.vendor));
    } finally {
      setFetchingModels(false);
    }
  }

  async function addProvider() {
    const configuredModels = uniqueModels(draft.models.length ? draft.models : [draft.model]);
    if (!draft.vendorName.trim()) {
      setNotice("请填写供应商名称。");
      return;
    }
    if (!draft.apiKey.trim()) {
      setNotice("请填写 API Key。");
      return;
    }
    if (!draft.baseUrl.trim() || !configuredModels.length) {
      setNotice("请填写 Base URL 和模型名称。");
      return;
    }
    setSaving(true);
    setNotice("");
    try {
      await nativeInvoke("save_provider_config", { provider: provider.id, vendorName: draft.vendorName, apiKey: draft.apiKey, baseUrl: draft.baseUrl, model: configuredModels[0], models: configuredModels });
      await nativeInvoke("set_provider_enabled", { provider: provider.id, enabled: true });
      await nativeInvoke("return_to_settings_window");
    } catch (error) {
      setNotice(String(error));
    } finally {
      setSaving(false);
    }
  }

  return <main className="app-shell add-provider-window-shell"><section className="settings-add-provider-page" aria-labelledby="add-provider-title">
    <div className="add-provider-titlebar" onMouseDown={dragWindow}>
      <h1 id="add-provider-title">添加自定义供应商</h1>
      <button type="button" className="titlebar-icon-button titlebar-close add-provider-window-close" onClick={returnToSettings} aria-label="关闭添加自定义供应商" title="关闭"><Icon name="close" /></button>
    </div>
    <div className="add-provider-content">
      <div className="add-provider-scroll">
        <div className="add-provider-protocol"><strong>OpenAI 兼容接口</strong><small>适用于支持 Chat Completions 协议的模型服务</small></div>
        <div className="add-provider-form">
          <div className="add-provider-field"><label htmlFor="add-provider-name">供应商名称</label><input id="add-provider-name" value={draft.vendorName} onChange={(event) => updateDraft("vendorName", event.target.value)} placeholder="供应商名称" required /></div>
          <div className="add-provider-field"><label htmlFor="add-provider-api-key">API Key</label><div className="api-key-input-wrap"><input id="add-provider-api-key" value={draft.apiKey} onChange={(event) => updateDraft("apiKey", event.target.value)} type={showApiKey ? "text" : "password"} autoComplete="off" placeholder="" required /><button type="button" className="api-key-toggle" onClick={() => setShowApiKey((visible) => !visible)} aria-label={showApiKey ? "隐藏 API Key" : "显示 API Key"} title={showApiKey ? "隐藏 API Key" : "显示 API Key"}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.4-5.5 9.5-5.5 9.5 5.5 9.5 5.5-3.4 5.5-9.5 5.5S2.5 12 2.5 12Z" /><circle cx="12" cy="12" r="2.5" /></svg></button></div></div>
          <div className="add-provider-field"><label htmlFor="add-provider-base-url">API 地址</label><input id="add-provider-base-url" value={draft.baseUrl} onChange={(event) => updateDraft("baseUrl", event.target.value)} spellCheck={false} placeholder="填写服务地址或完整的 /chat/completions 地址" /></div>
          <div className="add-provider-field"><div className="add-provider-model-label"><label htmlFor="add-provider-model">模型名称</label><button ref={modelFetchButtonRef} type="button" className="add-provider-fetch" onClick={() => void fetchModels()} disabled={fetchingModels || !draft.baseUrl.trim()} aria-busy={fetchingModels}>{fetchingModels ? "获取中…" : "获取模型"}</button></div><div className="add-provider-model-list">{(draft.models.length ? draft.models : [draft.model]).map((model, index) => <div className="add-provider-model-row" key={index}><ProviderIcon provider={dialogProvider} /><input id={index === 0 ? "add-provider-model" : undefined} aria-label={index === 0 ? undefined : `模型名称 ${index + 1}`} value={model} onChange={(event) => updateModel(index, event.target.value)} spellCheck={false} placeholder={index === 0 ? "可手动输入，也可点击获取模型" : undefined} />{draft.models.length > 0 && <button type="button" onClick={() => removeModel(index)} aria-label={model ? `移除模型 ${model}` : "移除模型"} title="移除模型">−</button>}</div>)}</div></div>
        </div>
        {notice && <p className="notice add-provider-notice" role="status">{notice}</p>}
      </div>
      <div className="add-provider-actions"><button type="button" className="secondary" onClick={returnToSettings}>取消</button><button className="primary" type="button" onClick={() => void addProvider()} disabled={saving}>{saving ? "添加中…" : "添加接口"}</button></div>
    </div>
    {modelDialogOpen && <AvailableModelsDialog provider={dialogProvider} models={fetchedModels} selectedModels={uniqueModels(draft.models)} isLoading={fetchingModels} fetchError={modelFetchError} closeButtonRef={modelDialogCloseRef} onToggle={toggleFetchedModel} onClose={closeModelDialog} onRetry={() => void fetchModels()} />}
  </section></main>;
}

function App() {
  useEffect(() => {
    const disableDefaultContextMenu = (event: globalThis.MouseEvent) => event.preventDefault();
    document.addEventListener("contextmenu", disableDefaultContextMenu);
    return () => document.removeEventListener("contextmenu", disableDefaultContextMenu);
  }, []);

  let label = "main";
  try {
    label = getCurrentWebviewWindow().label;
  } catch {
    label = new URLSearchParams(window.location.search).get("window") ?? "main";
  }
  if (label === "selection-float") return <SelectionFloat />;
  if (label === "settings") return <SettingsWindow />;
  if (label === "add-provider") return <AddProviderWindow />;
  return <MainWindow />;
}

export default App;
