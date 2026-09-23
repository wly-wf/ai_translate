import { mergeTranslationSnapshot } from "./translationSnapshots";
import type { ProviderId } from "./providerTypes";
import { isTauriDesktop, nativeInvoke, useUserPreferences } from "./useUserPreferences";
import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { cursorPosition, getCurrentWindow } from "@tauri-apps/api/window";
import appIcon from "../src-tauri/icons/tray-icon.svg";
import { type Translation, type TranslationError, type ActiveProviderChanged, type ProviderConfigResponse, translationProvider, NO_ENABLED_PROVIDER_NOTICE, SETTINGS_PROVIDERS, withCustomProviderIdentity, modelsFromConfig, translationResultKey, modelChoiceKey, AVAILABLE_TRANSLATION_PROVIDERS, DEFAULT_PROVIDER_ID, orderedProviderIds, orderProviderResults, containsCjk, translationLanguageClass, normalizeSourceText } from "./providerCatalog";
import { ProviderIcon, ModelPicker, preferenceNoticeMessage, Icon, ProviderSetupNotice, ExpandableText, QuickTranslateIcon, ReturnToFloatIcon, ModelRefreshIcon } from "./sharedUI";
import { useWindowDrag } from "./useWindowDrag";

export function MainWindow() {
  const [result, setResult] = useState<Translation | null>(null);
  const [text, setText] = useState("");
  const { keepOnTop, quickTranslateProvider, quickTranslateModel, providerOrder, setKeepOnTop, preferencesError } = useUserPreferences();
  const [hasApiKey, setHasApiKey] = useState(false);
  const [activeProviderId, setActiveProviderId] = useState<ProviderId>(DEFAULT_PROVIDER_ID);
  const [activeProviderModel, setActiveProviderModel] = useState(SETTINGS_PROVIDERS[0].model);
  const [enabledProviderIds, setEnabledProviderIds] = useState<ProviderId[]>([]);
  const [enabledProviderModels, setEnabledProviderModels] = useState<Partial<Record<ProviderId, string[]>>>({});
  const [enabledProviderNames, setEnabledProviderNames] = useState<Partial<Record<ProviderId, string>>>({});
  const [quickTranslateProviderId, setQuickTranslateProviderId] = useState<ProviderId>(DEFAULT_PROVIDER_ID);
  const [quickTranslateModelName, setQuickTranslateModelName] = useState(SETTINGS_PROVIDERS[0].model);
  const [loading, setLoading] = useState(false);
  const [refreshingResultKey, setRefreshingResultKey] = useState<string | null>(null);
  const [expandedProviderIds, setExpandedProviderIds] = useState<string[]>([DEFAULT_PROVIDER_ID]);
  const [showQuickTranslate, setShowQuickTranslate] = useState(false);
  const [notice, setNotice] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const latestRequestId = useRef(0);
  const providerLoadVersion = useRef(0);
  const snapshotRef = useRef<Translation | null>(null);
  const displayedRequestId = useRef<number | undefined>(undefined);
  const latestTranslationAttempt = useRef(0);
  const preserveExpandedOnRefresh = useRef(false);
  const { beginWindowDrag, finishWindowDrag } = useWindowDrag();
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
            if (!snapshot || (snapshot.requestId ?? 0) < latestRequestId.current) return;
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
    const isNewRequest = displayedRequestId.current !== snapshot.requestId;
    if (!acceptRequest(snapshot.requestId)) return;
    const merged = mergeTranslationSnapshot(snapshotRef.current, snapshot);
    if (merged === snapshotRef.current) return;
    snapshotRef.current = merged;
    const orderedSnapshot = { ...merged, results: orderProviderResults(merged.results, providerOrderRef.current) };
    const providerId = orderedSnapshot.results[0]?.providerId ?? DEFAULT_PROVIDER_ID;
    setActiveProviderId(providerId);
    if (orderedSnapshot.results[0]?.model) setActiveProviderModel(orderedSnapshot.results[0].model);
    setResult(orderedSnapshot);
    if (isNewRequest) {
      if (!preserveExpandedOnRefresh.current) setExpandedProviderIds(orderedSnapshot.results.map(translationResultKey));
      preserveExpandedOnRefresh.current = false;
      setShowQuickTranslate(false);
      displayedRequestId.current = snapshot.requestId;
    }
    setLoading(translationIsPending(orderedSnapshot));
    setNotice("");
  }

  async function loadEnabledProviders(providerIds: ProviderId[]) {
    const version = ++providerLoadVersion.current;
    const orderedIds = orderedProviderIds(providerOrderRef.current, providerIds);
    setEnabledProviderIds(orderedIds);
    const loaded = await Promise.allSettled(orderedIds.map(async (providerId) => {
      const config = await nativeInvoke<ProviderConfigResponse | null>("get_provider_config", { provider: providerId });
      return [providerId, config ? modelsFromConfig(config) : [], config?.vendorName?.trim()] as const;
    }));
    if (version !== providerLoadVersion.current) return;
    const entries = loaded.flatMap((entry) => entry.status === "fulfilled" ? [entry.value] : []);
    const failed = loaded.filter((entry) => entry.status === "rejected").length;
    if (failed) setNotice(`${failed} 个供应商配置读取失败，其余模型仍可使用。`);
    setEnabledProviderModels(Object.fromEntries(entries.flatMap(([providerId, models]) => models.length ? [[providerId, models]] : [])));
    setEnabledProviderNames(Object.fromEntries(entries.flatMap(([providerId, , vendorName]) => vendorName ? [[providerId, vendorName]] : [])));
    setHasApiKey(entries.some(([, models]) => models.length > 0));
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
      void loadEnabledProviders(enabled).catch((error) => setNotice(String(error)));
    });
    void nativeInvoke<Translation | null>("get_latest_translation")
      .then((snapshot) => {
        if (snapshot) applyTranslationSnapshot(snapshot);
      })
      .catch(() => undefined);
    return () => {
      providerLoadVersion.current += 1;
      finishWindowDrag();
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
    let disposed = false;
    let pending = false;
    const timer = window.setInterval(() => {
      if (pending) return;
      pending = true;
      void nativeInvoke<Translation | null>("get_latest_translation")
        .then((snapshot) => {
          if (disposed || !snapshot || snapshot.requestId !== result.requestId) return;
          applyTranslationSnapshot(snapshot);
        })
        .catch(() => undefined)
        .finally(() => { pending = false; });
    }, 1500);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [result]);

  useEffect(() => {
    const message = preferenceNoticeMessage(preferencesError);
    if (message) setNotice(message);
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
    if (!text.trim()) return;
    if (quickTranslateChoices.length === 0) {
      setNotice(NO_ENABLED_PROVIDER_NOTICE);
      return;
    }
    const attempt = latestTranslationAttempt.current + 1;
    latestTranslationAttempt.current = attempt;
    setLoading(true);
    setNotice("");
    setExpandedProviderIds(enabledProviderIds);
    try {
      const translated = await nativeInvoke<Translation>("translate_text", { text, provider: quickTranslateProviderId, model: quickTranslateModelName });
      if (attempt !== latestTranslationAttempt.current || !acceptRequest(translated.requestId)) return;
      applyTranslationSnapshot(translated);
    } catch (error) {
      // Superseded requests must not change the new batch's loading/error state.
      if (attempt === latestTranslationAttempt.current && !String(error).includes("已被更新的请求替代")) {
        setNotice(String(error));
        setLoading(false);
      }
    }
  }

  async function refreshModel(providerId: ProviderId, model: string) {
    if (!result?.requestId || loading || refreshingResultKey) return;
    const resultKey = translationResultKey({ providerId, model });
    setRefreshingResultKey(resultKey);
    preserveExpandedOnRefresh.current = true;
    setNotice("");
    try {
      const translated = await nativeInvoke<Translation>("retranslate_model", { requestId: result.requestId, provider: providerId, model });
      applyTranslationSnapshot(translated);
    } catch (error) {
      preserveExpandedOnRefresh.current = false;
      if (!String(error).includes("已被更新的请求替代")) setNotice(String(error));
    } finally {
      setRefreshingResultKey(null);
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
    const provider = translationProvider(providerId);
    const vendorName = enabledProviderNames[providerId];
    return provider && vendorName ? withCustomProviderIdentity(provider, vendorName) : provider;
  };
  const activeProviderDefinition = runtimeProvider(activeProviderId) ?? AVAILABLE_TRANSLATION_PROVIDERS[0];
  const activeProvider = { ...activeProviderDefinition, model: enabledProviderModels[activeProviderId]?.[0] ?? activeProviderModel ?? activeProviderDefinition.model };
  const quickTranslateChoices = enabledProviderIds.flatMap((providerId) => {
    const provider = runtimeProvider(providerId);
    return provider ? (enabledProviderModels[providerId] ?? []).map((model) => ({ id: modelChoiceKey(providerId, model), providerId, model, vendor: provider.vendor })) : [];
  });
  return <main className="app-shell">
    <header className="titlebar" onMouseDown={beginWindowDrag} onMouseUp={finishWindowDrag}>
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
        {!hasApiKey && <ProviderSetupNotice onOpenError={setNotice} />}
        <div className="quick-model-picker"><ModelPicker value={modelChoiceKey(quickTranslateProviderId, quickTranslateModelName)} choices={quickTranslateChoices} onChange={(choice) => { setQuickTranslateProviderId(choice.providerId); setQuickTranslateModelName(choice.model); }} ariaLabel="选择翻译模型" disabled={!quickTranslateChoices.length} /></div>
        <div className="input-card">
          <textarea ref={inputRef} id="translation-input" aria-label="输入文本" className={`${text.trim() && !containsCjk(text) ? "is-english" : "is-chinese"}${/[A-Za-z]/.test(text) ? " is-mixed-language" : ""}`} value={text} onChange={(event) => setText(event.target.value)} placeholder="输入要翻译的内容…" />
        </div>
        <div className="quick-translate-action"><span className="character-count">{text.length} 字符</span><button className="primary" disabled={loading || !text.trim()} onClick={() => void translate()}>{loading ? "翻译中…" : "翻译"}</button></div>
      </div> : result ? <div className="translation-result">
        <div className="provider-list">
          {result.results.map((providerResult) => {
            const providerDefinition = runtimeProvider(providerResult.providerId) ?? activeProvider;
            const provider = { ...providerDefinition, model: providerResult.model || providerDefinition.model };
            const resultKey = translationResultKey(providerResult);
            const isOpen = expandedProviderIds.includes(resultKey);
            return <article className={`provider-card ${isOpen ? "is-open" : "is-closed"} is-active`} key={resultKey}>
              <div className="provider-card-header">
                <button className="provider-header" onClick={() => setExpandedProviderIds((ids) => isOpen ? ids.filter((id) => id !== resultKey) : [...ids, resultKey])} aria-expanded={isOpen}>
                  <ProviderIcon provider={provider} />
                  <span className="provider-heading"><strong>{provider.model}/{provider.vendor}</strong></span>
                </button>
                <button className="provider-refresh-button" type="button" onClick={() => void refreshModel(providerResult.providerId, providerResult.model)} disabled={loading || Boolean(refreshingResultKey)} aria-label={`重新翻译 ${provider.vendor} 的 ${provider.model}`} title="重新翻译"><ModelRefreshIcon /></button>
                <button className="provider-collapse-button" type="button" onClick={() => setExpandedProviderIds((ids) => isOpen ? ids.filter((id) => id !== resultKey) : [...ids, resultKey])} aria-label={`${isOpen ? "收起" : "展开"} ${provider.vendor} 的 ${provider.model}`} aria-expanded={isOpen}><Icon name="chevron" /></button>
              </div>
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
        <h1>选中文本即可翻译</h1>
        <p className="hint">点击选区旁的悬浮按钮开始翻译</p>
      </div>}{notice && !(showQuickTranslate && !hasApiKey && notice === NO_ENABLED_PROVIDER_NOTICE) && (notice === NO_ENABLED_PROVIDER_NOTICE
        ? <ProviderSetupNotice onOpenError={setNotice} />
        : <p className="notice" role="status">{notice}</p>)}
    </section>
  </main>;
}

