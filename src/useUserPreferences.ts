import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { isCustomProvider, type ProviderId } from "./providerTypes";

export type ThemeMode = "light" | "dark" | "system";
export type AccentColor = "blue" | "purple" | "green" | "orange" | "rose";
export type ProxyMode = "system" | "disabled" | "custom";
export type ProxyType = "http" | "https" | "socks4" | "socks5";
type UserPreferences = {
  autoSelection: boolean;
  keepOnTop: boolean;
  quickTranslateProvider: ProviderId | null;
  quickTranslateModel: string | null;
  themeMode: ThemeMode;
  accentColor: AccentColor;
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
const DEFAULT_USER_PREFERENCES: UserPreferences = {
  autoSelection: true,
  keepOnTop: false,
  quickTranslateProvider: null,
  quickTranslateModel: null,
  themeMode: "system",
  accentColor: "blue",
  sourceFontSize: 14,
  translationFontSize: 16,
  proxyMode: "disabled",
  proxyUrl: "",
  proxyType: "http",
  proxyHost: "127.0.0.1",
  proxyPort: "7890",
  proxyUsername: "",
  proxyPassword: "",
  proxyBypass: "localhost,127.0.0.1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,::1",
  proxyTestUrl: "https://www.google.com",
  providerOrder: ["deepseek", "xiaomi", "qwen", "zhipu", "moonshot", "openai"],
};

function initialUserPreferences() {
  if (typeof window === "undefined") return DEFAULT_USER_PREFERENCES;
  try {
    const stored = JSON.parse(window.localStorage.getItem("ai-translate-appearance") ?? "null") as Partial<UserPreferences> | null;
    if (!stored) return DEFAULT_USER_PREFERENCES;
    return normalizePreferences({
      themeMode: stored.themeMode, accentColor: stored.accentColor,
      sourceFontSize: stored.sourceFontSize, translationFontSize: stored.translationFontSize,
    }, DEFAULT_USER_PREFERENCES);
  } catch {
    return DEFAULT_USER_PREFERENCES;
  }
}

function appearanceMatches(a: UserPreferences, b: UserPreferences) {
  return a.themeMode === b.themeMode
    && a.accentColor === b.accentColor
    && a.sourceFontSize === b.sourceFontSize
    && a.translationFontSize === b.translationFontSize;
}
export const isTauriDesktop = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const FONT_SIZE_LIMITS = { min: 12, max: 20 };

export function clampFontSize(size: number, limits: { min: number; max: number }) {
  if (!Number.isFinite(size)) return limits.min;
  return Math.min(limits.max, Math.max(limits.min, Math.round(size)));
}

// Validate IPC/cache values before they reach render logic. Empty proxy fields
// and nullable model preferences are meaningful, not missing values.
function normalizePreferences(stored: unknown, base: UserPreferences): UserPreferences {
  const next = { ...base };
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return next;
  const enums: Partial<Record<keyof UserPreferences, readonly string[]>> = {
    themeMode: ["light", "dark", "system"], accentColor: ["blue", "purple", "green", "orange", "rose"],
    proxyMode: ["system", "disabled", "custom"], proxyType: ["http", "https", "socks4", "socks5"],
  };
  for (const [name, value] of Object.entries(stored)) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_USER_PREFERENCES, name)) continue;
    const key = name as keyof UserPreferences;
    let valid = false;
    if (key === "sourceFontSize" || key === "translationFontSize") {
      if (typeof value === "number" && Number.isFinite(value)) next[key] = clampFontSize(value, FONT_SIZE_LIMITS);
      continue;
    }
    if (key === "providerOrder") {
      if (Array.isArray(value) && value.every((id) => typeof id === "string")) next.providerOrder = [...new Set<string>(value)];
      continue;
    }
    if (key === "quickTranslateProvider") valid = value === null || (typeof value === "string" && (DEFAULT_USER_PREFERENCES.providerOrder.includes(value) || isCustomProvider(value)));
    else if (key === "quickTranslateModel") valid = value === null || (typeof value === "string" && value.trim().length > 0);
    else if (enums[key]) valid = typeof value === "string" && enums[key]!.includes(value);
    else valid = typeof value === typeof DEFAULT_USER_PREFERENCES[key];
    if (valid) next[key] = value as never;
  }
  return next;
}

export async function nativeInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauriDesktop()) {
    throw new Error("当前页面运行在普通浏览器中。请关闭此页面，并使用 `npm.cmd run tauri dev` 打开的 AI Translate 桌面窗口。");
  }
  return invoke<T>(command, args);
}

export function useUserPreferences() {
  const [preferences, setPreferences] = useState<UserPreferences>(initialUserPreferences);
  const [preferencesError, setPreferencesError] = useState("");
  const saveChain = useRef<Promise<unknown>>(Promise.resolve());
  const saveErrors = useRef(new Map<keyof UserPreferences, string>());
  const pendingPreferences = useRef<Partial<UserPreferences>>({});
  const confirmedPreferences = useRef(preferences);
  const preferenceVersions = useRef<Partial<Record<keyof UserPreferences, number>>>({});
  const deferredPreferences = useRef(new Map<keyof UserPreferences, { timer: number; commit: () => void }>());

  function acceptStoredPreferences(stored: unknown) {
    const confirmed = normalizePreferences(stored, confirmedPreferences.current);
    confirmedPreferences.current = confirmed;
    setPreferences((current) => {
      const next = { ...confirmed };
      for (const key of Object.keys(pendingPreferences.current) as (keyof UserPreferences)[]) {
        next[key] = current[key] as never;
      }
      return appearanceMatches(current, next) && JSON.stringify(current) === JSON.stringify(next) ? current : next;
    });
  }

  useEffect(() => {
    if (!isTauriDesktop()) {
      return;
    }
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    let receivedEvent = false;
    const initialVersions = { ...preferenceVersions.current };
    void listen<UserPreferences>("preferences-changed", (event) => {
      if (cancelled) return;
      receivedEvent = true;
      acceptStoredPreferences(event.payload);
    }).then((remove) => {
      if (cancelled) remove();
      else unlisten = remove;
    }).catch(() => undefined);
    void nativeInvoke<UserPreferences>("get_preferences")
      .then((stored) => {
        if (cancelled || receivedEvent) return;
        const untouched = Object.fromEntries(Object.entries(stored ?? {}).filter(([key]) =>
          initialVersions[key as keyof UserPreferences] === preferenceVersions.current[key as keyof UserPreferences]));
        acceptStoredPreferences(untouched);
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
      root.dataset.accent = preferences.accentColor;
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
          accentColor: preferences.accentColor,
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
  }, [preferences.themeMode, preferences.accentColor, preferences.sourceFontSize, preferences.translationFontSize]);

  function flushPreferenceUpdates() {
    for (const { timer, commit } of deferredPreferences.current.values()) {
      window.clearTimeout(timer);
      commit();
    }
    deferredPreferences.current.clear();
    return saveChain.current.then(() => {
      const error = saveErrors.current.values().next().value;
      if (error) throw new Error(error);
    });
  }

  useEffect(() => () => { void flushPreferenceUpdates().catch(() => undefined); }, []);

  function updatePreference<K extends keyof UserPreferences>(preference: K, value: UserPreferences[K]) {
    const version = (preferenceVersions.current[preference] ?? 0) + 1;
    preferenceVersions.current[preference] = version;
    pendingPreferences.current[preference] = value;
    setPreferences((current) => ({ ...current, [preference]: value }));
    if (!isTauriDesktop()) return;
    const commit = () => {
      saveChain.current = saveChain.current
        .catch(() => undefined)
        .then(() => nativeInvoke<UserPreferences>("set_user_preference", { preference, value }))
        .then((saved) => {
          const acknowledged = saved && Object.prototype.hasOwnProperty.call(saved, preference)
            ? normalizePreferences(saved, confirmedPreferences.current)[preference] : value;
          confirmedPreferences.current = { ...confirmedPreferences.current, [preference]: acknowledged };
          if (preferenceVersions.current[preference] !== version) return;
          delete pendingPreferences.current[preference];
          setPreferences((current) => ({ ...current, [preference]: acknowledged }));
          saveErrors.current.delete(preference);
          setPreferencesError([...saveErrors.current.values()].join("; "));
        })
        .catch((error) => {
          if (preferenceVersions.current[preference] !== version) return;
          delete pendingPreferences.current[preference];
          setPreferences((current) => ({ ...current, [preference]: confirmedPreferences.current[preference] }));
          saveErrors.current.set(preference, String(error));
          setPreferencesError([...saveErrors.current.values()].join("; "));
        });
    };
    const previous = deferredPreferences.current.get(preference);
    if (previous) window.clearTimeout(previous.timer);
    if (["proxyHost", "proxyPort", "proxyUsername", "proxyPassword", "proxyBypass", "proxyTestUrl", "proxyUrl"].includes(preference)) {
      const timer = window.setTimeout(() => {
        deferredPreferences.current.delete(preference);
        commit();
      }, 400);
      deferredPreferences.current.set(preference, { timer, commit });
    } else {
      commit();
    }
  }

  return {
    autoSelection: preferences.autoSelection,
    keepOnTop: preferences.keepOnTop,
    quickTranslateProvider: preferences.quickTranslateProvider,
    quickTranslateModel: preferences.quickTranslateModel,
    themeMode: preferences.themeMode,
    accentColor: preferences.accentColor,
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
    setAccentColor: (value: AccentColor) => updatePreference("accentColor", value),
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
    flushPreferenceUpdates,
    preferencesError,
  };
}

