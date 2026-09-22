import { version } from "../package.json";
import { isCustomProvider, type SettingsProviderId, type ProviderId } from "./providerTypes";
import { type AccentColor } from "./useUserPreferences";
import bailianIcon from "./assets/providers/bailian.svg";
import deepseekIcon from "./assets/providers/deepseek.svg";
import moonshotIcon from "./assets/providers/moonshot.svg";
import xiaomiMimoIcon from "./assets/providers/xiaomi-mimo.svg";
import zhipuIcon from "./assets/providers/zhipu.svg";

export type SettingsPage = "providers" | "generic" | "preferences" | "proxy" | "about";
export type ProviderTranslationResult = { providerId: ProviderId; model: string; translation?: string | null; error?: string | null };
export type Translation = { source: string; results: ProviderTranslationResult[]; requestId?: number };
export type TranslationError = { requestId: number; message: string };
export type ActiveProviderChanged = { providerId: ProviderId; model: string };
export type TranslationProvider = {
  id: ProviderId;
  vendor: string;
  model: string;
  mark: string;
  enabled: boolean;
};

export type SettingsProvider = {
  id: SettingsProviderId;
  vendor: string;
  model: string;
  baseUrl: string;
  mark: string;
};

export type ProviderDraft = {
  vendorName: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  models: string[];
  saved: boolean;
};

export type ProviderConfigResponse = {
  vendorName?: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  models: string[];
};

export type ConnectionState = {
  providerId: SettingsProviderId | null;
  status: "idle" | "testing" | "success" | "error";
  message: string;
};

export type ModelChoice = {
  id: string;
  providerId: ProviderId;
  model: string;
  vendor: string;
};

export const APP_VERSION = version;
export const NO_ENABLED_PROVIDER_NOTICE = "尚未配置并启用翻译供应商，请先前往设置完成配置。";
export const PROJECT_LINKS = [
  {
    id: "repository",
    title: "GitHub 开源仓库",
    url: "https://github.com/wly-wf/ai_translate",
  },
  {
    id: "issues",
    title: "GitHub Issues",
    url: "https://github.com/wly-wf/ai_translate/issues",
  },
] as const;

export const PROVIDER_IMAGE_ICONS: Partial<Record<SettingsProviderId, { src: string; className: string }>> = {
  deepseek: { src: deepseekIcon, className: "provider-deepseek-mark" },
  xiaomi: { src: xiaomiMimoIcon, className: "provider-mimo-mark" },
  qwen: { src: bailianIcon, className: "provider-bailian-mark" },
  zhipu: { src: zhipuIcon, className: "provider-zhipu-mark" },
  moonshot: { src: moonshotIcon, className: "provider-moonshot-mark" },
};

export const SETTINGS_PROVIDERS: SettingsProvider[] = [
  {
    id: "deepseek",
    vendor: "DeepSeek",
    model: "deepseek-v4-flash",
    baseUrl: "https://api.deepseek.com",
    mark: "D",
  },
  {
    id: "xiaomi",
    vendor: "Xiaomi MiMo",
    model: "mimo-v2.5-pro",
    baseUrl: "https://api.xiaomimimo.com",
    mark: "M",
  },
  {
    id: "qwen",
    vendor: "阿里云百炼",
    model: "qwen-plus",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    mark: "Q",
  },
  {
    id: "zhipu",
    vendor: "智谱开放平台",
    model: "glm-5.2",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    mark: "Z",
  },
  {
    id: "moonshot",
    vendor: "Moonshot",
    model: "kimi-k2.5",
    baseUrl: "https://api.moonshot.cn",
    mark: "K",
  },
];

export const GENERIC_PROVIDERS: SettingsProvider[] = [
  {
    id: "openai",
    vendor: "OpenAI 兼容接口",
    model: "gpt-4o-mini",
    baseUrl: "https://api.openai.com",
    mark: "O",
  },
];

export const ALL_SETTINGS_PROVIDERS = [...SETTINGS_PROVIDERS, ...GENERIC_PROVIDERS];

export function createProviderDrafts(): Record<SettingsProviderId, ProviderDraft> {
  return Object.fromEntries(ALL_SETTINGS_PROVIDERS.map((provider) => [provider.id, {
    vendorName: provider.vendor,
    apiKey: "",
    baseUrl: provider.baseUrl,
    model: "",
    models: [] as string[],
    saved: false,
  }])) as Record<SettingsProviderId, ProviderDraft>;
}

export function uniqueModels(models: string[]) {
  return models.reduce<string[]>((result, model) => {
    const normalized = model.trim();
    if (normalized && !result.includes(normalized)) result.push(normalized);
    return result;
  }, []);
}

export function customProviderMark(name: string, fallback = "供") {
  return Array.from(name.trim())[0] || fallback;
}

export function withCustomProviderIdentity<T extends { vendor: string; mark: string }>(provider: T, name: string): T {
  const vendor = name.trim();
  return {
    ...provider,
    vendor: vendor || provider.vendor,
    mark: customProviderMark(vendor),
  };
}

export function modelsFromConfig(config: Pick<ProviderConfigResponse, "model" | "models">) {
  return uniqueModels(config.models?.length ? config.models : [config.model]);
}

export function draftFromConfig(config: ProviderConfigResponse, fallbackVendor = ""): ProviderDraft {
  const models = modelsFromConfig(config);
  return { vendorName: config.vendorName?.trim() || fallbackVendor, apiKey: config.apiKey, baseUrl: config.baseUrl, model: models[0] ?? "", models, saved: true };
}

export function translationResultKey(result: Pick<ProviderTranslationResult, "providerId" | "model">) {
  return `${result.providerId}\u0000${result.model}`;
}

export function modelChoiceKey(providerId: ProviderId, model: string) {
  return `${providerId}\u0000${model}`;
}

export const TRANSLATION_PROVIDERS: TranslationProvider[] = ALL_SETTINGS_PROVIDERS.map((provider) => ({
  ...provider,
  enabled: true,
}));
export const AVAILABLE_TRANSLATION_PROVIDERS = TRANSLATION_PROVIDERS.filter((provider) => provider.enabled);

export const DEFAULT_PROVIDER_ID: ProviderId = "deepseek";
export const ACCENT_COLOR_OPTIONS: { value: AccentColor; label: string }[] = [
  { value: "blue", label: "蓝色" },
  { value: "purple", label: "紫色" },
  { value: "green", label: "绿色" },
  { value: "orange", label: "橙色" },
  { value: "rose", label: "玫红" },
];

export function orderedProviderIds(order: readonly string[], availableIds: readonly ProviderId[]) {
  const available = new Set<string>(availableIds);
  const result = order.filter((providerId): providerId is ProviderId => available.has(providerId));
  for (const providerId of availableIds) {
    if (!result.includes(providerId)) result.push(providerId);
  }
  return result;
}

export function orderProviders<T extends { id: ProviderId }>(providers: readonly T[], order: readonly string[]) {
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  return orderedProviderIds(order, providers.map((provider) => provider.id))
    .map((providerId) => byId.get(providerId))
    .filter((provider): provider is T => Boolean(provider));
}

export function orderProviderResults<T extends { providerId: ProviderId }>(results: readonly T[], order: readonly string[]) {
  const rank = new Map(order.map((providerId, index) => [providerId, index]));
  return results
    .map((result, index) => ({ result, index }))
    .sort((left, right) => (rank.get(left.result.providerId) ?? Number.MAX_SAFE_INTEGER)
      - (rank.get(right.result.providerId) ?? Number.MAX_SAFE_INTEGER) || left.index - right.index)
    .map(({ result }) => result);
}

export function containsCjk(value: string) {
  return /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(value);
}

export function translationLanguageClass(source: string) {
  // The native translation target uses the same direction rule: any CJK in
  // the source translates to English; otherwise the target is Chinese. Base
  // typography on that direction instead of acronyms inside the translation.
  return containsCjk(source)
    ? "translation-english"
    : "translation-chinese";
}

export function normalizeSourceText(value: string) {
  const normalized = value.replace(/\r\n?/g, "\n");
  if (containsCjk(normalized)) return normalized;

  // PDF and document UIA providers often expose visual line wrapping as hard
  // newlines. Reflow those English soft wraps for this narrower window while
  // retaining blank-line paragraph boundaries from the source document.
  return normalized
    .split(/\n[\t ]*\n+/)
    .map((paragraph) => paragraph
      .replace(/[\t ]*\n[\t ]*(?=(?:[•●▪◦‣⁃]\s+|[-*+]\s+|\d+[.)]\s+))/g, "\n")
      .replace(/[\t ]*\n(?![•●▪◦‣⁃]|[-*+]\s|\d+[.)]\s)[\t ]*/g, " ")
      .replace(/[\t ]+/g, " ")
      .trim())
    .filter(Boolean)
    .join("\n\n");
}


// Custom instances share protocol defaults, never their saved configuration.
export function settingsProvider(id: ProviderId): SettingsProvider | undefined {
  return ALL_SETTINGS_PROVIDERS.find((provider) => provider.id === id)
    ?? (isCustomProvider(id) ? { ...GENERIC_PROVIDERS[0], id } : undefined);
}
export function translationProvider(id: ProviderId): TranslationProvider | undefined {
  const provider = settingsProvider(id);
  return provider ? { ...provider, enabled: true } : undefined;
}
