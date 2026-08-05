import { type MouseEvent, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { siAnthropic, siDeepseek, siGooglegemini, siMoonshotai, siQwen, siZdotai, type SimpleIcon } from "simple-icons";
import { SelectionFloat } from "./SelectionFloat";
import appIcon from "../src-tauri/icons/tray-icon.svg";
import "./App.css";

type ProviderId = "deepseek" | "openai" | "anthropic" | "gemini";
type SettingsProviderId = "deepseek" | "xiaomi" | "qwen" | "zhipu" | "moonshot" | "openai" | "google" | "anthropic";
type GenericProviderId = "openai" | "google" | "anthropic";
type SettingsPage = "providers" | "generic" | "connection" | "general" | "interface" | "about";
type ApiProtocol = "openai" | "google" | "anthropic";
type Translation = { source: string; translation: string; providerId?: ProviderId };

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

const PROVIDER_ICONS: Partial<Record<ProviderId, SimpleIcon>> = {
  deepseek: siDeepseek,
  anthropic: siAnthropic,
  gemini: siGooglegemini,
};

const SETTINGS_PROVIDER_ICONS: Partial<Record<SettingsProviderId, SimpleIcon>> = {
  deepseek: siDeepseek,
  qwen: siQwen,
  moonshot: siMoonshotai,
  anthropic: siAnthropic,
  google: siGooglegemini,
  zhipu: siZdotai,
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
    vendor: "小米 MiMo",
    model: "mimo-v2.5-pro",
    baseUrl: "https://api.xiaomimimo.com/v1",
    protocol: "openai",
    mark: "M",
    accent: "#ff6900",
    summary: "小米 MiMo 开放平台，兼容 OpenAI 接口。",
  },
  {
    id: "qwen",
    vendor: "阿里云 Qwen",
    model: "qwen-plus",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    protocol: "openai",
    mark: "Q",
    accent: "#5b55d6",
    summary: "阿里云百炼兼容模式，支持通义千问。",
  },
  {
    id: "zhipu",
    vendor: "智谱 GLM",
    model: "glm-5.2",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    protocol: "openai",
    mark: "Z",
    accent: "#3478f6",
    summary: "智谱开放平台，兼容 OpenAI SDK。",
  },
  {
    id: "moonshot",
    vendor: "Moonshot Kimi",
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
    model: provider.model,
    saved: false,
  }])) as Record<SettingsProviderId, ProviderDraft>;
}

// Add a provider here when its native request adapter is ready. The result
// window is intentionally driven by this registry instead of vendor names.
const TRANSLATION_PROVIDERS: TranslationProvider[] = [
  {
    id: "deepseek",
    vendor: "DeepSeek",
    model: "deepseek-v4-flash",
    mark: "D",
    accent: "#16a394",
    enabled: true,
    summary: "速度优先，适合日常取词和技术文本。",
  },
  {
    id: "openai",
    vendor: "OpenAI",
    model: "GPT-4.1 mini",
    mark: "O",
    accent: "#4c6fff",
    enabled: false,
    summary: "待接入 OpenAI 接口。",
  },
  {
    id: "anthropic",
    vendor: "Anthropic",
    model: "Claude Sonnet",
    mark: "A",
    accent: "#d27b52",
    enabled: false,
    summary: "待接入 Anthropic 接口。",
  },
  {
    id: "gemini",
    vendor: "Google",
    model: "Gemini Flash",
    mark: "G",
    accent: "#8d68db",
    enabled: false,
    summary: "待接入 Google Gemini 接口。",
  },
];
const AVAILABLE_TRANSLATION_PROVIDERS = TRANSLATION_PROVIDERS.filter((provider) => provider.enabled);

const DEFAULT_PROVIDER_ID: ProviderId = "deepseek";
const isTauriDesktop = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function isMostlyEnglish(value: string) {
  const latinCount = value.match(/[A-Za-z]/g)?.length ?? 0;
  const cjkCount = value.match(/[\u3400-\u9fff]/g)?.length ?? 0;
  return latinCount > cjkCount;
}

function ProviderIcon({ provider }: { provider: { id: string; mark: string; accent: string } }) {
  if (provider.id === "xiaomi") {
    return <span className="provider-mark provider-mimo-mark" aria-label="Xiaomi MiMo" title="Xiaomi MiMo">MiMo</span>;
  }
  const icon = PROVIDER_ICONS[provider.id as ProviderId] ?? SETTINGS_PROVIDER_ICONS[provider.id as SettingsProviderId];
  return <span className={`provider-mark${icon ? " provider-brand-mark" : ""}`} style={icon ? { color: `#${icon.hex}` } : { backgroundColor: provider.accent }} aria-hidden="true">
    {icon ? <svg className="provider-icon" viewBox="0 0 24 24"><path d={icon.path} /></svg> : provider.mark}
  </span>;
}

async function nativeInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauriDesktop) {
    throw new Error("当前页面运行在普通浏览器中。请关闭此页面，并使用 `npm.cmd run tauri dev` 打开的 AI Translate 桌面窗口。");
  }
  return invoke<T>(command, args);
}

function Icon({ name }: { name: "menu" | "close" | "chevron" }) {
  const paths: Record<string, React.ReactNode> = {
    menu: <path d="M3 5h10M3 10h10M3 15h10" />,
    close: <path d="m3 3 12 12M15 3 3 15" />,
    chevron: <path d="m3 6 5 5 5-5" />,
  };

  return <svg className={`ui-icon ui-icon-${name}`} viewBox="0 0 18 18" aria-hidden="true">{paths[name]}</svg>;
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
  const [autoSelection, setAutoSelection] = useState(true);
  const [keepOnTop, setKeepOnTop] = useState(true);
  const [hasApiKey, setHasApiKey] = useState(false);
  const [loading, setLoading] = useState(false);
  const [expandedProviderId, setExpandedProviderId] = useState<ProviderId | null>(DEFAULT_PROVIDER_ID);
  const [notice, setNotice] = useState("按 Alt + T 翻译剪贴板中的文本");
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!isTauriDesktop) {
      setNotice("当前是普通浏览器预览，无法保存 API Key 或调用翻译。请使用 Tauri 桌面窗口。");
      return;
    }
    void nativeInvoke<boolean>("has_api_key")
      .then(setHasApiKey)
      .catch((error) => setNotice(String(error)));
    const resultListener = listen<Translation>("translation-result", (event) => {
      const providerId = event.payload.providerId ?? DEFAULT_PROVIDER_ID;
      setResult({ ...event.payload, providerId });
      setExpandedProviderId(providerId);
      setLoading(false);
      setNotice("");
      setShowSettings(false);
    });
    const errorListener = listen<string>("translation-error", (event) => { setLoading(false); setNotice(event.payload); });
    const settingsListener = listen("open-settings", () => { switchSettingsPage("providers"); setShowSettings(true); setNotice(""); });
    return () => {
      void resultListener.then((remove) => remove());
      void errorListener.then((remove) => remove());
      void settingsListener.then((remove) => remove());
    };
  }, []);

  async function translate() {
    if (!text.trim()) return;
    setLoading(true);
    setNotice("");
    setExpandedProviderId(DEFAULT_PROVIDER_ID);
    try {
      const translated = await nativeInvoke<Translation>("translate_text", { text });
      setResult({ ...translated, providerId: DEFAULT_PROVIDER_ID });
    } catch (error) {
      setNotice(String(error));
    } finally {
      setLoading(false);
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

  function dragWindow(event: MouseEvent<HTMLElement>) {
    if ((event.target as HTMLElement).closest("button, input, textarea")) return;
    void getCurrentWindow().startDragging();
  }

  const activeProvider = AVAILABLE_TRANSLATION_PROVIDERS.find((provider) => provider.id === (result?.providerId ?? DEFAULT_PROVIDER_ID)) ?? AVAILABLE_TRANSLATION_PROVIDERS[0];
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
      <div className="settings-page-heading"><div><p className="eyebrow">偏好</p><h1>界面与快捷键</h1></div></div>
      <p className="settings-description">调整悬浮翻译窗口的行为。快捷键目前固定为 Alt + T。</p>
      <div className="preference-list">
        <label className="preference-row"><span><strong>选中文本自动显示悬浮按钮</strong><small>鼠标完成选区后显示翻译入口</small></span><input type="checkbox" checked={autoSelection} onChange={(event) => setAutoSelection(event.target.checked)} /></label>
        <label className="preference-row"><span><strong>翻译窗口保持置顶</strong><small>结果窗口不会被其他窗口遮挡</small></span><input type="checkbox" checked={keepOnTop} onChange={(event) => setKeepOnTop(event.target.checked)} /></label>
        <div className="preference-row shortcut-row"><span><strong>全局翻译快捷键</strong><small>复制文本后快速打开翻译结果</small></span><kbd>Alt + T</kbd></div>
      </div>
      <div className="settings-info-card"><strong>接口扩展</strong><p>新增厂商时，请先在对应页面填写 Base URL、模型和 API Key，再用连接测试确认配置可用。</p></div>
    </>;
  }

  return <main className="app-shell">
    <header className="titlebar" onMouseDown={dragWindow}>
      <div className="titlebar-start">
        <img className="app-icon" src={appIcon} alt="AI Translate 翻译图标" />
        <span className="app-name">AI Translate</span>
      </div>
      <div className="titlebar-actions">
        <button className="titlebar-icon-button" onClick={() => void nativeInvoke("open_settings_window").catch((error) => setNotice(String(error)))} aria-label="更多操作">
          <Icon name="menu" />
        </button>
        <button className="titlebar-icon-button titlebar-close" onClick={() => void nativeInvoke("hide_window")} aria-label="隐藏">
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
          <button aria-label="界面与快捷键" className={settingsPage === "general" ? "is-active" : ""} onClick={() => switchSettingsPage("general")}><span aria-hidden="true">⚙</span>界面与快捷键</button>
        </nav>
        <button className="settings-back" onClick={() => setShowSettings(false)}>← 返回翻译</button>
      </aside>
      <div className="settings-main">
        {settingsPage === "connection" ? renderConnectionPage() : settingsPage === "general" ? renderGeneralPage() : settingsPage === "providers" || settingsPage === "generic" ? renderProviderSettingsWithKey() : renderProviderSettings()}
        {notice && <p className="notice" role="status">{notice}</p>}
      </div>
    </section> : <section className="content">
      {result ? <div className="translation-result">
        <div className="provider-list">
          {AVAILABLE_TRANSLATION_PROVIDERS.map((provider) => {
            const isOpen = expandedProviderId === provider.id;
            const isActive = provider.id === activeProvider.id;
            return <article className={`provider-card ${isOpen ? "is-open" : "is-closed"} ${isActive ? "is-active" : ""}`} key={provider.id}>
              <button className="provider-header" onClick={() => setExpandedProviderId(isOpen ? null : provider.id)} aria-expanded={isOpen}>
                <ProviderIcon provider={provider} />
                <span className="provider-heading"><strong>{provider.model}/{provider.vendor}</strong></span>
                <Icon name="chevron" />
              </button>
              {isOpen && <div className="provider-body">
                {provider.enabled && isActive ? <>
                  <div className="text-line"><p className="source">{result.source}</p></div>
                  <div className="text-line translation-line"><p className={`translation${isMostlyEnglish(result.translation) ? " translation-english" : ""}`}>{result.translation}</p></div>
                </> : <div className="provider-placeholder"><span className="placeholder-dot" />{provider.summary}</div>}
              </div>}
            </article>;
          })}
        </div>
      </div> : <>
        <div className="page-heading"><p className="eyebrow">快速翻译</p><h1>把文字变成另一种语言</h1><p className="hint">选中文本后复制，再按 <kbd>Alt</kbd> + <kbd>T</kbd>；也可以直接输入。</p></div>
        {!hasApiKey && <div className="warning"><span className="warning-icon" aria-hidden="true">!</span><p>请先在系统托盘图标的右键菜单中设置 DeepSeek API Key。</p></div>}
        <div className="model-strip"><ProviderIcon provider={activeProvider} /><span><strong>{activeProvider.model}/{activeProvider.vendor}</strong></span><span className="provider-status ready">已接入</span></div>
        <div className="input-card"><div className="input-head"><label className="field-label" htmlFor="translation-input">输入文本</label><span className="character-count">{text.length} 字符</span></div>
          <textarea ref={inputRef} id="translation-input" value={text} onChange={(event) => setText(event.target.value)} placeholder="输入要翻译的文字…" />
          <div className="input-footer"><span className="field-help">支持中英文自动识别</span><button className="primary" disabled={loading || !text.trim()} onClick={() => void translate()}>{loading ? "翻译中…" : "翻译"}</button></div>
        </div>
      </>}{notice && <p className="notice" role="status">{notice}</p>}
    </section>}
  </main>;
}

function LegacySettingsWindow() {
  const [settingsPage, setSettingsPage] = useState<SettingsPage>("providers");
  const [selectedSettingsProviderId, setSelectedSettingsProviderId] = useState<SettingsProviderId>("deepseek");
  const [providerDrafts, setProviderDrafts] = useState<Record<SettingsProviderId, ProviderDraft>>(createProviderDrafts);
  const [connectionState, setConnectionState] = useState<ConnectionState>({ providerId: null, status: "idle", message: "" });
  const [autoSelection, setAutoSelection] = useState(true);
  const [keepOnTop, setKeepOnTop] = useState(true);
  const [notice, setNotice] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [providerSearch, setProviderSearch] = useState("");
  const [enabledProviders, setEnabledProviders] = useState<Partial<Record<SettingsProviderId, boolean>>>({ deepseek: true });

  const selectedSettingsProvider = ALL_SETTINGS_PROVIDERS.find((provider) => provider.id === selectedSettingsProviderId) ?? SETTINGS_PROVIDERS[0];
  const selectedDraft = providerDrafts[selectedSettingsProvider.id];
  const settingsCollection = settingsPage === "generic" ? GENERIC_PROVIDERS : SETTINGS_PROVIDERS;
  const filteredProviders = settingsCollection.filter((provider) => {
    const query = providerSearch.trim().toLowerCase();
    return !query || `${provider.vendor} ${provider.model}`.toLowerCase().includes(query);
  });

  useEffect(() => {
    if (!isTauriDesktop) return;
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
      <div className="settings-page-heading"><div><p className="eyebrow">偏好</p><h1>界面与快捷键</h1></div></div>
      <p className="settings-description">调整悬浮翻译窗口的行为。全局快捷键目前固定为 Alt + T。</p>
      <div className="preference-list">
        <label className="preference-row"><span><strong>选中文本自动显示悬浮按钮</strong><small>鼠标完成选区后显示翻译入口</small></span><input type="checkbox" checked={autoSelection} onChange={(event) => setAutoSelection(event.target.checked)} /></label>
        <label className="preference-row"><span><strong>翻译窗口保持置顶</strong><small>结果窗口不会被其他窗口遮挡</small></span><input type="checkbox" checked={keepOnTop} onChange={(event) => setKeepOnTop(event.target.checked)} /></label>
        <div className="preference-row shortcut-row"><span><strong>全局翻译快捷键</strong><small>复制文本后快速打开翻译结果</small></span><kbd>Alt + T</kbd></div>
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
      <div className="provider-panel-footer"><button type="button" className={settingsPage === "connection" ? "is-active" : ""} onClick={() => setSettingsPage("connection")}><span aria-hidden="true">◌</span>连接测试</button><button type="button" className={settingsPage === "general" ? "is-active" : ""} onClick={() => setSettingsPage("general")}><span aria-hidden="true">⚙</span>界面与快捷键</button><button type="button" className="provider-add-button" onClick={() => setNotice("请从列表中选择一个供应商进行配置。")}>＋ 添加</button></div>
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
  const [autoSelection, setAutoSelection] = useState(true);
  const [keepOnTop, setKeepOnTop] = useState(true);
  const [notice, setNotice] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [providerSearch, setProviderSearch] = useState("");
  const [enabledProviders, setEnabledProviders] = useState<Partial<Record<SettingsProviderId, boolean>>>({ deepseek: true });
  const [addedGenericProviders, setAddedGenericProviders] = useState<GenericProviderId[]>([]);
  const [isAddingProvider, setIsAddingProvider] = useState(false);
  const [addProviderId, setAddProviderId] = useState<GenericProviderId>("openai");
  const [addProviderName, setAddProviderName] = useState(GENERIC_PROVIDERS[0].vendor);
  const [useResponsesApi, setUseResponsesApi] = useState(false);

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
    if (!isTauriDesktop) return;
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
    if (!isTauriDesktop) return;
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
    if (!draft.apiKey.trim() || !draft.baseUrl.trim() || !draft.model.trim()) {
      setNotice("请填写 API Key、Base URL 和模型名称。");
      return;
    }
    try {
      await nativeInvoke("save_provider_config", { provider: provider.id, apiKey: draft.apiKey, baseUrl: draft.baseUrl, model: draft.model });
      setAddedGenericProviders((providers) => providers.includes(provider.id as GenericProviderId) ? providers : [...providers, provider.id as GenericProviderId]);
      setSelectedSettingsProviderId(provider.id);
      setEnabledProviders((providers) => ({ ...providers, [provider.id]: true }));
      setProviderDrafts((drafts) => ({ ...drafts, [provider.id]: { ...drafts[provider.id], saved: true } }));
      setIsAddingProvider(false);
      setNotice(`${addProviderName || provider.vendor} 已添加并启用。`);
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
    return <div className="provider-detail-page">
      <h1 className="sr-only">{settingsPage === "generic" ? "通用接口配置" : "厂商接口配置"}</h1>
      <div className="provider-detail-intro">
        <div><h2>{selectedSettingsProvider.vendor}</h2></div>
        <label className="settings-switch" title={isEnabled ? "停用当前接口" : "启用当前接口"}><input type="checkbox" checked={isEnabled} onChange={(event) => setEnabledProviders((providers) => ({ ...providers, [selectedSettingsProvider.id]: event.target.checked }))} /><span aria-hidden="true" /></label>
      </div>
      <section className="settings-form-card provider-config-card">
        <div className="settings-field-group"><div className="settings-label-row"><label className="field-label" htmlFor="provider-api-key">API Key</label><button className="inline-test" type="button" onClick={() => void testConnection()} disabled={connectionState.status === "testing"}><span aria-hidden="true">♡</span>{connectionState.status === "testing" ? "测试中" : "测试连接"}</button></div><div className="api-key-input-wrap"><input id="provider-api-key" value={selectedDraft.apiKey} onChange={(event) => updateSelectedDraft("apiKey", event.target.value)} type={showApiKey ? "text" : "password"} placeholder={selectedDraft.saved ? "已保存，留空以保留当前 Key" : "粘贴 API Key"} /><button type="button" className="api-key-toggle" onClick={() => setShowApiKey((visible) => !visible)} aria-label={showApiKey ? "隐藏 API Key" : "显示 API Key"} title={showApiKey ? "隐藏 API Key" : "显示 API Key"}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.4-5.5 9.5-5.5 9.5 5.5 9.5 5.5-3.4 5.5-9.5 5.5S2.5 12 2.5 12Z" /><circle cx="12" cy="12" r="2.5" /></svg></button></div></div>
        <div className="settings-field-group"><label className="field-label" htmlFor="provider-base-url">URL</label><input id="provider-base-url" value={selectedDraft.baseUrl} onChange={(event) => updateSelectedDraft("baseUrl", event.target.value)} spellCheck={false} /></div>
        <div className="settings-field-group"><label className="field-label" htmlFor="provider-api-path">API 路径</label><input id="provider-api-path" value={apiPath} readOnly spellCheck={false} /></div>
        <div className="model-section provider-model-section"><div className="model-section-header"><div className="model-section-title"><h3>模型</h3><span>{selectedDraft.model ? "1" : "0"}</span></div><div className="model-toolbar"><button type="button" aria-label="添加模型" title="添加模型"><ModelAddIcon /></button><button className="fetch-models" type="button" onClick={() => setNotice("模型列表刷新功能暂未接入，当前使用手动填写的模型。")}><ModelRefreshIcon /><span>获取</span></button></div></div><div className="model-group"><div className="model-group-heading"><strong>{selectedSettingsProvider.vendor}</strong></div><div className="model-row"><ProviderIcon provider={selectedSettingsProvider} /><label className="model-input-label" htmlFor="provider-model"><span className="sr-only">模型名称</span><input id="provider-model" value={selectedDraft.model} onChange={(event) => updateSelectedDraft("model", event.target.value)} spellCheck={false} /></label><button type="button" className="model-remove-button" onClick={() => updateSelectedDraft("model", "")} aria-label="移除模型" title="移除模型">−</button></div></div></div>
      </section>
      <div className="provider-detail-footer"><div className="action-row settings-actions"><button className="primary" onClick={() => void saveProviderConfig()}>保存配置</button></div></div>
      {connectionState.providerId === selectedSettingsProvider.id && connectionState.status !== "idle" && <p className={`connection-result ${connectionState.status}`} role="status">{connectionState.message}</p>}
    </div>;
  }

  function renderConnectionPage() {
    return <div className="settings-page-view"><div className="settings-page-heading"><div><p className="settings-page-eyebrow">连通性</p><h1>连接测试</h1></div><span className="settings-page-meta">实时请求</span></div><p className="settings-description">选择一个已配置的接口，发送最小测试请求，确认地址、密钥和模型都可用。</p><div className="connection-selector-card"><label className="field-label" htmlFor="connection-provider">测试接口</label><select id="connection-provider" value={selectedSettingsProvider.id} onChange={(event) => selectSettingsProvider(event.target.value as SettingsProviderId)}><optgroup label="AI 提供商">{SETTINGS_PROVIDERS.map((provider) => <option value={provider.id} key={provider.id}>{provider.vendor} · {provider.model}</option>)}</optgroup><optgroup label="通用接口">{GENERIC_PROVIDERS.map((provider) => <option value={provider.id} key={provider.id}>{provider.vendor} · {provider.model}</option>)}</optgroup></select><div className="connection-summary"><ProviderIcon provider={selectedSettingsProvider} /><div><strong>{selectedSettingsProvider.vendor}</strong><span>{selectedDraft.baseUrl}</span><span>{selectedDraft.model}</span></div></div>{connectionState.providerId === selectedSettingsProvider.id && connectionState.status !== "idle" && <p className={`connection-result ${connectionState.status}`} role="status">{connectionState.message}</p>}<button className="primary connection-test-button" onClick={() => void testConnection()} disabled={connectionState.status === "testing"}>{connectionState.status === "testing" ? "正在测试…" : "开始测试连接"}</button></div><div className="connection-note"><span className="note-mark">i</span><p>测试只发送一条最小请求，不会触发翻译，也不会保存明文 API Key。</p></div></div>;
  }

  function renderCommonPage() {
    return <div className="settings-page-view"><div className="settings-page-heading"><div><p className="settings-page-eyebrow">偏好</p><h1>通用设置</h1></div></div><p className="settings-description">管理应用的基础行为与默认工作方式。</p><section className="placeholder-settings-card"><div className="placeholder-setting-row"><div><strong>启动时自动运行</strong><small>随 Windows 启动 AI Translate</small></div><span className="placeholder-badge">即将支持</span></div><div className="placeholder-setting-row"><div><strong>默认目标语言</strong><small>自动识别并翻译为指定语言</small></div><span className="placeholder-value">自动识别</span></div><div className="placeholder-setting-row"><div><strong>配置同步</strong><small>在设备之间同步供应商配置</small></div><span className="placeholder-badge">即将支持</span></div></section><div className="settings-info-card"><strong>功能占位说明</strong><p>当前未接入后端的选项会保留在这里，后续接入后不会改变现有供应商配置。</p></div></div>;
  }

  function renderInterfacePage() {
    return <div className="settings-page-view"><div className="settings-page-heading"><div><p className="settings-page-eyebrow">外观与交互</p><h1>界面设置</h1></div></div><p className="settings-description">调整悬浮按钮和翻译结果窗口的显示方式。</p><section className="interface-settings-card"><label className="preference-row"><span><strong>选中文本自动显示悬浮按钮</strong><small>鼠标完成选区后显示翻译入口</small></span><input type="checkbox" checked={autoSelection} onChange={(event) => setAutoSelection(event.target.checked)} /></label><label className="preference-row"><span><strong>翻译窗口保持置顶</strong><small>结果窗口不会被其他窗口遮挡</small></span><input type="checkbox" checked={keepOnTop} onChange={(event) => setKeepOnTop(event.target.checked)} /></label><div className="preference-row shortcut-row"><span><strong>全局翻译快捷键</strong><small>复制文本后快速打开翻译结果</small></span><kbd>Alt + T</kbd></div><div className="placeholder-setting-row"><div><strong>主题与字体</strong><small>主题切换和字体大小设置</small></div><span className="placeholder-badge">即将支持</span></div></section></div>;
  }

  function renderAboutPage() {
    return <div className="settings-page-view about-page"><div className="about-brand"><img src={appIcon} alt="AI Translate 图标" /><div><p className="settings-page-eyebrow">AI Translate</p><h1>关于</h1><p>轻量、快速的桌面翻译工具。</p></div></div><section className="about-card"><div><span>当前版本</span><strong>0.1.0</strong></div><div><span>翻译引擎</span><strong>DeepSeek</strong></div><div><span>全局快捷键</span><strong>Alt + T</strong></div></section><div className="settings-info-card"><strong>更多信息</strong><p>更新日志、反馈入口和自动更新功能将在后续版本接入。</p></div></div>;
  }

  function renderAddProviderPage() {
    const apiPath = addProviderDefinition.protocol === "google" ? "/models/{model}:generateContent" : addProviderDefinition.protocol === "anthropic" ? "/messages" : useResponsesApi ? "/responses" : "/chat/completions";
    const draft = providerDrafts[addProviderId];
    const tabLabels: Record<GenericProviderId, string> = { openai: "OpenAI", google: "Google", anthropic: "Claude" };
    return <section className="settings-add-provider-page" aria-labelledby="add-provider-title"><div className="settings-topbar" onMouseDown={dragWindow}><div className="settings-brand settings-brand-top"><img src={appIcon} alt="AI Translate 图标" /><div><strong>AI Translate</strong></div></div><button type="button" className="settings-close-button" onClick={closeAddProvider} aria-label="关闭添加供应商" title="关闭添加供应商"><Icon name="close" /></button></div>
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
      <nav className="provider-list-nav" aria-label="供应商列表">{filteredProviders.map((provider) => { const enabled = enabledProviders[provider.id] ?? providerDrafts[provider.id].saved; return <button type="button" className={`provider-list-item ${provider.id === selectedSettingsProvider.id ? "is-selected" : ""}`} key={provider.id} onClick={() => selectSettingsProvider(provider.id)}><ProviderIcon provider={provider} /><span className="provider-list-copy"><strong>{provider.vendor}</strong></span><span className={`provider-list-status ${enabled ? "is-enabled" : ""}`}>{enabled ? "启用" : "禁用"}</span></button>; })}</nav>
      <div className="provider-column-footer"><button type="button" className="provider-add-button" onClick={() => openAddProvider()}>＋ 添加</button></div>
    </aside>;
  }

  if (isAddingProvider) {
    return <main className="app-shell settings-window-shell"><section className="settings-add-provider-shell">{renderAddProviderPage()}</section></main>;
  }

  return <main className="app-shell settings-window-shell"><section className={`settings-shell settings-shell-${isProviderPage ? "providers" : "single"}`}><div className="settings-topbar" onMouseDown={dragWindow}><div className="settings-brand settings-brand-top"><img src={appIcon} alt="AI Translate 图标" /><div><strong>AI Translate</strong></div></div><button type="button" className="settings-close-button" onClick={() => void nativeInvoke("hide_settings_window")} aria-label="关闭设置" title="关闭设置"><Icon name="close" /></button></div><aside className="settings-nav-panel"><div className="settings-brand" onMouseDown={dragWindow}><img src={appIcon} alt="AI Translate 图标" /><div><strong>AI Translate</strong><small>设置中心</small></div></div><nav className="settings-primary-nav" aria-label="设置分类"><button type="button" className={activeNavPage === "general" ? "is-active" : ""} onClick={() => switchSettingsPage("general")}><SettingsNavIcon name="general" />通用设置</button><button type="button" className={activeNavPage === "interface" ? "is-active" : ""} onClick={() => switchSettingsPage("interface")}><SettingsNavIcon name="interface" />界面设置</button><button type="button" className={activeNavPage === "providers" ? "is-active" : ""} onClick={() => switchSettingsPage("providers")}><SettingsNavIcon name="providers" />供应商</button><button type="button" className={activeNavPage === "about" ? "is-active" : ""} onClick={() => switchSettingsPage("about")}><SettingsNavIcon name="about" />关于</button></nav></aside>{isProviderPage && renderProviderColumn()}<section className="settings-main">{settingsPage === "connection" ? renderConnectionPage() : settingsPage === "general" ? renderCommonPage() : settingsPage === "interface" ? renderInterfacePage() : settingsPage === "about" ? renderAboutPage() : renderProviderDetails()}{notice && <p className="notice" role="status">{notice}</p>}</section></section></main>;
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
