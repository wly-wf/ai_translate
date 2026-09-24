import { isCustomProvider, type SettingsProviderId, type ProviderId, type GenericProviderId } from "./providerTypes";
import { type ThemeMode, type ProxyType, type ProxyMode, FONT_SIZE_LIMITS, isTauriDesktop, nativeInvoke, useUserPreferences } from "./useUserPreferences";
import { type CSSProperties, useEffect, useLayoutEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { ProviderWrites } from "./providerWrites";
import { useLongPressReorder } from "./useLongPressReorder";
import appIcon from "../src-tauri/icons/tray-icon.svg";
import projectLicense from "../LICENSE?raw";
import providerNotices from "./assets/providers/NOTICE.md?raw";
import { type SettingsPage, type SettingsProvider, type ProviderDraft, type ProviderConfigResponse, type ConnectionState, type ModelChoice, APP_VERSION, PROJECT_LINKS, settingsProvider, SETTINGS_PROVIDERS, GENERIC_PROVIDERS, ALL_SETTINGS_PROVIDERS, createProviderDrafts, uniqueModels, withCustomProviderIdentity, modelsFromConfig, draftFromConfig, modelChoiceKey, orderProviders } from "./providerCatalog";
import { ProviderIcon, ModelPicker, InlineSelect, SegmentedControl, AccentColorPicker, FontSizeStepper, preferenceNoticeMessage, Icon, SearchIcon, ModelAddIcon, ModelRefreshIcon, DeleteIcon, AvailableModelsDialog, SettingsNavIcon, AboutIcon, ApiKeyInput, useDialogLifecycle } from "./sharedUI";
import { useWindowDrag } from "./useWindowDrag";

export function SettingsWindow() {
  const { beginWindowDrag } = useWindowDrag();
  useEffect(() => {
    if (isTauriDesktop()) void nativeInvoke("settings_window_ready").catch((error) => console.error("Settings window ready failed:", error));
  }, []);
  const [autostart, setAutostart] = useState(false);
  const [autostartBusy, setAutostartBusy] = useState(true);
  const [autostartError, setAutostartError] = useState("");
  const [settingsPage, setSettingsPage] = useState<SettingsPage>("providers");
  const [selectedSettingsProviderId, setSelectedSettingsProviderId] = useState<SettingsProviderId>("deepseek");
  const [providerDrafts, setProviderDrafts] = useState<Record<SettingsProviderId, ProviderDraft>>(createProviderDrafts);
  const [connectionState, setConnectionState] = useState<ConnectionState>({ providerId: null, status: "idle", message: "" });
  const {
    quickTranslateProvider, quickTranslateModel,
    themeMode, accentColor, sourceFontSize, translationFontSize, proxyMode, proxyType, proxyHost, proxyPort,
    proxyUsername, proxyPassword, proxyBypass, proxyTestUrl, providerOrder,
    setQuickTranslateProvider, setQuickTranslateModel,
    setThemeMode, setAccentColor, setSourceFontSize, setTranslationFontSize, setProxyMode, setProxyType, setProxyHost,
    setProxyPort, setProxyUsername, setProxyPassword, setProxyBypass, setProxyTestUrl, setProviderOrder,
    flushPreferenceUpdates,
    preferencesError,
  } = useUserPreferences();
  const [notice, setNotice] = useState("");
  const [proxyTestState, setProxyTestState] = useState<{ status: "idle" | "testing" | "success" | "error"; message: string }>({ status: "idle", message: "" });
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
  const [testModels, setTestModels] = useState<Partial<Record<SettingsProviderId, string>>>({});
  const [testModelDialogProviderId, setTestModelDialogProviderId] = useState<SettingsProviderId | null>(null);
  const [testModelDialogSelection, setTestModelDialogSelection] = useState("");
  const [editingModel, setEditingModel] = useState<{ providerId: SettingsProviderId; index: number; value: string } | null>(null);
  const [addingModel, setAddingModel] = useState<{ providerId: SettingsProviderId; value: string } | null>(null);
  const connectionRequestId = useRef(0);
  const modelFetchRequestId = useRef(0);
  const providerWrites = useRef(new ProviderWrites());
  const initialConfigReads = useRef(new Map<SettingsProviderId, Promise<ProviderConfigResponse | null>>());
  const deletedCustomProviders = useRef(new Set<string>());
  const deletingProviders = useRef(new Set<ProviderId>());
  const providerAutoSaveTimers = useRef<Partial<Record<SettingsProviderId, number>>>({});
  const providerAutoSaveRequestIds = useRef<Partial<Record<SettingsProviderId, number>>>({});
  const providerDraftsRef = useRef(providerDrafts);
  const modelFetchButtonRef = useRef<HTMLButtonElement>(null);
  const modelDialogCloseRef = useRef<HTMLButtonElement>(null);
  const testModelButtonRef = useRef<HTMLButtonElement>(null);
  const testModelDialogCloseRef = useRef<HTMLButtonElement>(null);
  const editModelInputRef = useRef<HTMLInputElement>(null);
  const editModelButtonRef = useRef<HTMLButtonElement>(null);
  const providerContextMenuRef = useRef<HTMLDivElement>(null);
  const providerContextMenuActionRef = useRef<HTMLButtonElement>(null);
  const providerOrderPreviewRef = useRef<ProviderId[] | null>(null);
  const providerRowElementsRef = useRef(new Map<ProviderId, HTMLDivElement>());
  const providerRowRectsRef = useRef(new Map<ProviderId, DOMRect>());
  const providerRowAnimationsRef = useRef(new Map<ProviderId, Animation>());
  function readInitialProviderConfig(providerId: SettingsProviderId) {
    const pending = initialConfigReads.current.get(providerId);
    if (pending) return pending;
    const request = nativeInvoke<ProviderConfigResponse | null>("get_provider_config", { provider: providerId });
    initialConfigReads.current.set(providerId, request);
    void request.catch(() => {
      if (initialConfigReads.current.get(providerId) === request) initialConfigReads.current.delete(providerId);
    });
    return request;
  }
  providerDraftsRef.current = providerDrafts;
  useDialogLifecycle(Boolean(testModelDialogProviderId), closeTestModelDialog, testModelDialogCloseRef, testModelButtonRef);
  useDialogLifecycle(Boolean(editingModel || addingModel), closeModelNameDialog, editModelInputRef, editModelButtonRef);

  useEffect(() => {
    const message = preferenceNoticeMessage(preferencesError);
    if (message) setNotice(message);
  }, [preferencesError]);

  useEffect(() => {
    if (settingsPage !== "preferences") return;
    let cancelled = false;
    setAutostartBusy(true);
    setAutostartError("");
    void nativeInvoke<boolean>("get_autostart")
      .then((enabled) => { if (!cancelled) setAutostart(Boolean(enabled)); })
      .catch((error) => { if (!cancelled) setAutostartError(String(error)); })
      .finally(() => { if (!cancelled) setAutostartBusy(false); });
    return () => { cancelled = true; };
  }, [settingsPage]);

  async function updateAutostart(enabled: boolean) {
    setAutostartBusy(true);
    setAutostartError("");
    try {
      setAutostart(await nativeInvoke<boolean>("set_autostart", { enabled }));
    } catch (error) {
      setAutostartError(String(error));
    } finally {
      setAutostartBusy(false);
    }
  }

  useEffect(() => () => {
    Object.values(providerAutoSaveTimers.current).forEach((timer) => {
      if (timer !== undefined) window.clearTimeout(timer);
    });
  }, []);

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
      const config = await readInitialProviderConfig(providerId);
      return config ? [providerId, modelsFromConfig(config)] as const : null;
    })).then((entries) => {
      if (!cancelled) setSettingsEnabledProviderModels(Object.fromEntries(entries.filter((entry): entry is readonly [ProviderId, string[]] => entry !== null && entry[1].length > 0)));
    }).catch((error) => {
      if (!cancelled) setNotice(String(error));
    });
    return () => { cancelled = true; };
  }, [enabledProviderIds]);

  const providerWithCustomName = (provider: SettingsProvider) => {
    const customName = isCustomProvider(provider.id) ? providerDrafts[provider.id]?.vendorName.trim() : "";
    return customName ? withCustomProviderIdentity(provider, customName) : provider;
  };
  const providerCollection = orderProviders(
    [...SETTINGS_PROVIDERS, ...addedGenericProviders.map((id) => settingsProvider(id)!)]
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
  const isProviderPage = settingsPage === "providers" || settingsPage === "generic";
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
    void nativeInvoke<GenericProviderId[]>("get_custom_providers").then((ids) => Promise.all((ids ?? []).filter(isCustomProvider).map(async (id) => {
      const provider = settingsProvider(id)!;
      try {
        const config = await readInitialProviderConfig(provider.id);
        return config ? { provider, config } : null;
      } catch {
        return null;
      }
    }))).then((entries) => {
      if (cancelled) return;
      const configured = entries.filter((entry): entry is NonNullable<typeof entry> => entry !== null && !deletedCustomProviders.current.has(entry.provider.id));
      if (!configured.length) return;
      setAddedGenericProviders((current) => [...new Set([...current, ...configured.map(({ provider }) => provider.id as GenericProviderId)])]);
      setProviderDrafts((drafts) => configured.reduce((nextDrafts, { provider, config }) => ({
        ...nextDrafts,
        [provider.id]: nextDrafts[provider.id]?.saved ? nextDrafts[provider.id] : draftFromConfig(config, provider.vendor),
      }), drafts));
    }).catch((error) => { if (!cancelled) setNotice(String(error)); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!isTauriDesktop()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<string>("provider-config-created", (event) => {
      const provider = isCustomProvider(event.payload) ? settingsProvider(event.payload) : undefined;
      if (!provider) return;
      initialConfigReads.current.delete(provider.id);
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
        setNotice(`${config.vendorName || provider.vendor} 已添加${enabledIds.includes(provider.id) ? "。" : "，尚未启用，可使用开关启用。"}`);
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
    if (providerDraftsRef.current[selectedSettingsProviderId]?.saved) return;
    let cancelled = false;
    const initialDraft = providerDraftsRef.current[selectedSettingsProviderId];
    void readInitialProviderConfig(selectedSettingsProviderId)
      .then((config) => {
        if (cancelled || !config || providerDraftsRef.current[selectedSettingsProviderId] !== initialDraft) return;
        setTestModels((models) => ({ ...models, [selectedSettingsProviderId]: config.model }));
        setProviderDrafts((drafts) => ({
          ...drafts,
          [selectedSettingsProviderId]: draftFromConfig(config, ALL_SETTINGS_PROVIDERS.find((item) => item.id === selectedSettingsProviderId)?.vendor ?? ""),
        }));
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [selectedSettingsProviderId]);

  function switchSettingsPage(page: SettingsPage) {
    setEditingModel(null);
    setAddingModel(null);
    modelFetchRequestId.current += 1;
    setFetchingProviderId(null);
    setProviderContextMenu(null);
    setSettingsPage(page);
    setModelDialogProviderId(null);
    setNotice("");
    if (page === "providers" && !SETTINGS_PROVIDERS.some((provider) => provider.id === selectedSettingsProviderId)) {
      setSelectedSettingsProviderId(SETTINGS_PROVIDERS[0].id);
    }
    if (page === "generic" && !isCustomProvider(selectedSettingsProviderId)) {
      setSelectedSettingsProviderId(GENERIC_PROVIDERS[0].id);
    }
  }

  function selectSettingsProvider(providerId: SettingsProviderId) {
    setEditingModel(null);
    setAddingModel(null);
    connectionRequestId.current += 1;
    modelFetchRequestId.current += 1;
    setProviderContextMenu(null);
    setFetchingProviderId(null);
    setModelDialogProviderId(null);
    setSelectedSettingsProviderId(providerId);
    if (settingsPage === "providers" || settingsPage === "generic") {
      setSettingsPage(isCustomProvider(providerId) ? "generic" : "providers");
    }
    setConnectionState({ providerId: null, status: "idle", message: "" });
    setModelFetchMessage({ providerId: null, message: "" });
    setModelFetchDetail({ providerId: null, message: "" });
    setNotice("");
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
    deletingProviders.current.add(providerId);
    providerAutoSaveRequestIds.current[providerId] = (providerAutoSaveRequestIds.current[providerId] ?? 0) + 1;
    setDeletingProviderId(providerId);
    setNotice("");
    try {
      const providers = await providerWrites.current.run(providerId, () => nativeInvoke<SettingsProviderId[]>("delete_custom_provider", { provider: providerId }));
      deletedCustomProviders.current.add(providerId);
      setEnabledProviderIds(providers ?? []);
      setAddedGenericProviders((current) => current.filter((id) => id !== providerId));
      setProviderDrafts((drafts) => { const next = { ...drafts }; delete next[providerId]; return next; });
      setFetchedModels((current) => { const next = { ...current }; delete next[providerId]; return next; });
      setSettingsEnabledProviderModels((current) => { const next = { ...current }; delete next[providerId]; return next; });
      setTestModels((current) => { const next = { ...current }; delete next[providerId]; return next; });
      if (selectedSettingsProviderId === providerId) {
        setSelectedSettingsProviderId(SETTINGS_PROVIDERS[0].id);
        setSettingsPage("providers");
        setConnectionState({ providerId: null, status: "idle", message: "" });
      }
      setNotice(`${providerName} 已删除。`);
    } catch (error) {
      setNotice(String(error));
    } finally {
      deletingProviders.current.delete(providerId);
      setDeletingProviderId(null);
      setProviderContextMenu(null);
    }
  }

  function closeModelDialog() {
    setModelDialogProviderId(null);
  }

  function closeTestModelDialog() {
    setTestModelDialogProviderId(null);
    setTestModelDialogSelection("");
  }

  function toggleFetchedModel(providerId: SettingsProviderId, model: string) {
    const draft = providerDraftsRef.current[providerId];
    if (draft.models.includes(model) && uniqueModels(draft.models).length === 1) {
      setNotice("至少保留一个模型；如需停止翻译，请关闭供应商开关。");
      return;
    }
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

  function addManualModel(button: HTMLButtonElement) {
    editModelButtonRef.current = button;
    setAddingModel({ providerId: selectedSettingsProviderId, value: "" });
  }

  function updateSelectedModel(index: number, value: string) {
    const providerId = selectedSettingsProviderId;
    const draft = providerDraftsRef.current[providerId];
    const models = draft.models.map((model, modelIndex) => modelIndex === index ? value : model);
    const nextDraft = { ...draft, model: models[0] ?? "", models };
    updateProviderDraft(providerId, nextDraft);
    scheduleProviderAutoSave(providerId, nextDraft);
  }

  function closeModelNameDialog() {
    setEditingModel(null);
    setAddingModel(null);
  }

  function saveModelName() {
    const dialog = editingModel ?? addingModel;
    if (!dialog || dialog.providerId !== selectedSettingsProviderId) return;
    const value = dialog.value.trim();
    if (!value) return;
    if (editingModel) {
      updateSelectedModel(editingModel.index, value);
    } else {
      const draft = providerDraftsRef.current[dialog.providerId];
      const models = [...draft.models, value];
      const nextDraft = { ...draft, model: models[0], models };
      updateProviderDraft(dialog.providerId, nextDraft);
      scheduleProviderAutoSave(dialog.providerId, nextDraft);
    }
    closeModelNameDialog();
  }

  function removeSelectedModel(index: number) {
    const providerId = selectedSettingsProviderId;
    const draft = providerDraftsRef.current[providerId];
    const models = draft.models.filter((_, modelIndex) => modelIndex !== index);
    if (draft.saved && uniqueModels(models).length === 0) {
      setNotice("至少保留一个模型；如需停止翻译，请关闭供应商开关。");
      return;
    }
    const nextDraft = { ...draft, model: models[0] ?? "", models };
    updateProviderDraft(providerId, nextDraft);
    scheduleProviderAutoSave(providerId, nextDraft);
  }

  function providerConfigPayload(provider: SettingsProvider, draft: ProviderDraft, models: string[]) {
    const payload: Record<string, unknown> = { provider: provider.id, apiKey: draft.apiKey, baseUrl: draft.baseUrl, model: models[0], models };
    if (isCustomProvider(provider.id)) payload.vendorName = draft.vendorName;
    return payload;
  }

  function updateProviderDraft(providerId: SettingsProviderId, draft: ProviderDraft) {
    providerDraftsRef.current = { ...providerDraftsRef.current, [providerId]: draft };
    setProviderDrafts((drafts) => ({ ...drafts, [providerId]: draft }));
  }

  function scheduleProviderAutoSave(providerId: SettingsProviderId, draft: ProviderDraft) {
    if (deletingProviders.current.has(providerId)) return;
    const pendingTimer = providerAutoSaveTimers.current[providerId];
    if (pendingTimer !== undefined) window.clearTimeout(pendingTimer);
    const models = uniqueModels(draft.models);
    if (!draft.baseUrl.trim() || !models.length) {
      setNotice("修改尚未保存：请填写接口地址，并至少保留一个有效模型。");
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
    const provider = settingsProvider(providerId);
    if (!provider) return;
    const requestId = (providerAutoSaveRequestIds.current[providerId] ?? 0) + 1;
    providerAutoSaveRequestIds.current[providerId] = requestId;
    try {
      await providerWrites.current.run(provider.id, () => nativeInvoke("save_provider_config", providerConfigPayload(provider, draft, models)));
      initialConfigReads.current.delete(provider.id);
      if (providerAutoSaveRequestIds.current[providerId] !== requestId) return;
      setProviderDrafts((drafts) => ({
        ...drafts,
        [providerId]: { ...drafts[providerId], saved: true },
      }));
      setNotice("");
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
        await providerWrites.current.run(provider.id, () => nativeInvoke("save_provider_config", providerConfigPayload(provider, draft, models)));
        initialConfigReads.current.delete(provider.id);
        setProviderDrafts((drafts) => ({ ...drafts, [provider.id]: { ...drafts[provider.id], model: models[0], models, saved: true } }));
      }
      const providers = await providerWrites.current.run(provider.id, () => nativeInvoke<SettingsProviderId[]>("set_provider_enabled", { provider: provider.id, enabled }));
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
      restoreFocusRef={modelFetchButtonRef}
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
    const showModelEditor = selectedDraft.models.length > 0;
    return <div className="provider-detail-page">
      <h1 className="sr-only">{settingsPage === "generic" ? "通用接口配置" : "厂商接口配置"}</h1>
      <div className="provider-detail-intro">
        <div><h2>{selectedSettingsProvider.vendor}</h2></div>
        <label className="settings-switch" title={isEnabledForTranslation ? "从翻译中移除" : "加入翻译"}><input type="checkbox" checked={isEnabledForTranslation} onChange={(event) => void setSelectedProviderEnabled(event.target.checked)} aria-label="启用此翻译模型" /><span aria-hidden="true" /></label>
      </div>
      <section className="settings-form-card provider-config-card">
        <div className="settings-field-group">
          <div className="settings-label-row"><label className="field-label" htmlFor="provider-api-key">API Key</label><button ref={testModelButtonRef} className="inline-test" type="button" onClick={() => void testConnection()} disabled={connectionState.status === "testing"}><span aria-hidden="true">♡</span>{connectionState.status === "testing" ? "测试中" : "测试连接"}</button></div>
          <ApiKeyInput key={selectedSettingsProvider.id} id="provider-api-key" value={selectedDraft.apiKey} onChange={(value) => updateSelectedDraft("apiKey", value)} placeholder={selectedDraft.saved ? "已保存，留空以保留当前 Key" : ""} />
          {connectionState.providerId === selectedSettingsProvider.id && connectionState.status !== "idle" && <span className={`connection-inline-result connection-field-result ${connectionState.status}`} role="status" title={connectionState.message}>{connectionState.message}</span>}
        </div>
        <div className="settings-field-group"><label className="field-label" htmlFor="provider-base-url">API 地址</label><input id="provider-base-url" value={selectedDraft.baseUrl} onChange={(event) => updateSelectedDraft("baseUrl", event.target.value)} spellCheck={false} placeholder="填写服务地址或完整的 /chat/completions 地址" /></div>
        <div className="model-section provider-model-section">
          <div className="model-section-header">
            <div className="model-section-title"><h3>模型</h3><span>{selectedDraft.models.filter((model) => model.trim()).length}</span></div>
            <div className="model-toolbar">
              <button type="button" aria-label="添加模型" title="添加模型" aria-expanded={Boolean(addingModel)} onClick={(event) => addManualModel(event.currentTarget)}><ModelAddIcon /></button>
              {modelFetchMessage.providerId === selectedSettingsProvider.id && modelFetchMessage.message && <span className="model-fetch-message" role="status" title={modelFetchMessage.message}><span className="model-fetch-message-icon" aria-hidden="true">!</span><span>{modelFetchMessage.message}</span></span>}
              <button ref={modelFetchButtonRef} className="fetch-models" type="button" onClick={() => void fetchProviderModels()} disabled={isFetchingModels} aria-busy={isFetchingModels}><ModelRefreshIcon /><span>获取</span></button>
            </div>
          </div>
          {showModelEditor && <div className="model-group">
            <div className="model-group-heading"><strong>{selectedSettingsProvider.vendor}</strong></div>
            {selectedDraft.models.map((model, index) => <div className="model-row" key={index}><ProviderIcon provider={selectedSettingsProvider} /><span className="model-name">{model}</span><button type="button" className="model-edit-button" onClick={(event) => { editModelButtonRef.current = event.currentTarget; setEditingModel({ providerId: selectedSettingsProvider.id, index, value: model }); }} aria-label={`编辑模型 ${model}`} title="编辑模型"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 20 4.2-1 10.6-10.6a2 2 0 0 0-2.8-2.8L5.4 16.2 4 20Z" /><path d="m14.5 7.5 2.8 2.8" /></svg></button><button type="button" className="model-remove-button" onClick={() => removeSelectedModel(index)} aria-label={`移除模型 ${model}`} title="移除模型">−</button></div>)}
          </div>}
        </div>
      </section>
    </div>;
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
          <div className="appearance-setting-row"><div><strong>颜色模式</strong></div><SegmentedControl ariaLabel="颜色模式" value={themeMode} options={[{ value: "light", label: "浅色", icon: "light" }, { value: "dark", label: "深色", icon: "dark" }, { value: "system", label: "跟随系统", icon: "system" }]} onChange={(value) => setThemeMode(value as ThemeMode)} /></div>
          <div className="accent-color-setting-row"><div><strong>主题色</strong></div><AccentColorPicker value={accentColor} onChange={setAccentColor} /></div>
        </div>
      </section>
      <section className="preferences-section" aria-labelledby="preferences-font-title">
        <header className="preferences-section-heading"><h2 id="preferences-font-title">字体</h2></header>
        <div className="preferences-section-rows">
          <div className="font-size-setting-row"><div><strong>原文字号</strong></div><FontSizeStepper ariaLabel="原文字号" value={sourceFontSize} limits={FONT_SIZE_LIMITS} onChange={setSourceFontSize} /></div>
          <div className="font-size-setting-row"><div><strong>译文字号</strong></div><FontSizeStepper ariaLabel="译文字号" value={translationFontSize} limits={FONT_SIZE_LIMITS} onChange={setTranslationFontSize} /></div>
        </div>
      </section>
      <section className="preferences-section preferences-secondary-section" aria-labelledby="preferences-other-title">
        <header className="preferences-section-heading"><h2 id="preferences-other-title">其他</h2></header>
        <div className="preferences-section-rows"><div className="preference-setting-row"><div><strong>启动时自动运行</strong></div><label className="settings-switch"><input aria-label="启动时自动运行" type="checkbox" checked={autostart} disabled={autostartBusy} onChange={(event) => void updateAutostart(event.target.checked)} /><span aria-hidden="true" /></label></div></div>
        {autostartError && <p className="notice" role="alert">{autostartError}</p>}
      </section>
    </div>;
  }

  function renderQuickModelTrigger(choices: ModelChoice[]) {
    const selectedChoice = choices.find((choice) => choice.providerId === quickTranslateProvider && (choice.model === quickTranslateModel || quickTranslateModel === null)) ?? null;
    return <ModelPicker
      value={selectedChoice?.id ?? null}
      choices={choices}
      ariaLabel="设置默认快速翻译模型"
      onChange={(choice) => {
        setQuickTranslateProvider(choice.providerId);
        setQuickTranslateModel(choice.model);
      }}
    />;
  }

  function renderProxyPage() {
    const proxyEnabled = proxyMode === "custom";
    const proxyActive = proxyMode !== "disabled";
    const proxyModeLabels: Record<ProxyMode, string> = { disabled: "直连", system: "环境变量代理", custom: "自定义代理" };
    const proxyTypeLabels: Record<ProxyType, string> = { http: "HTTP", https: "HTTPS", socks4: "SOCKS4", socks5: "SOCKS5" };
    const testProxy = async () => {
      if (!proxyActive || !proxyTestUrl.trim()) return;
      setProxyTestState({ status: "testing", message: "正在测试代理连接…" });
      try {
        await flushPreferenceUpdates();
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
          <div className="proxy-form-row"><span>连接方式</span><InlineSelect showCheck={false} ariaLabel="代理模式" value={proxyModeLabels[proxyMode]} options={Object.values(proxyModeLabels)} onChange={(label) => setProxyMode((Object.keys(proxyModeLabels) as ProxyMode[]).find((mode) => proxyModeLabels[mode] === label) ?? "disabled")} /></div>
          <div className="proxy-form-row"><span>代理类型</span><InlineSelect showCheck={false} ariaLabel="代理类型" value={proxyTypeLabels[proxyType]} options={Object.values(proxyTypeLabels)} disabled={!proxyEnabled} onChange={(label) => setProxyType((Object.keys(proxyTypeLabels) as ProxyType[]).find((type) => proxyTypeLabels[type] === label) ?? "http")} /></div>
          <label className="proxy-form-row"><span>服务器地址</span><input aria-label="服务器地址" value={proxyHost} disabled={!proxyEnabled} onChange={(event) => setProxyHost(event.target.value)} placeholder="127.0.0.1" spellCheck={false} /></label>
          <label className="proxy-form-row"><span>端口</span><input aria-label="端口" inputMode="numeric" value={proxyPort} disabled={!proxyEnabled} onChange={(event) => setProxyPort(event.target.value.replace(/\D/g, ""))} placeholder="7890" /></label>
          <label className="proxy-form-row"><span>用户名</span><input aria-label="代理用户名" value={proxyUsername} disabled={!proxyEnabled} onChange={(event) => setProxyUsername(event.target.value)} placeholder="可选" autoComplete="off" /></label>
          <label className="proxy-form-row"><span>密码</span><input aria-label="代理密码" type="password" value={proxyPassword} disabled={!proxyEnabled} onChange={(event) => setProxyPassword(event.target.value)} placeholder="可选" autoComplete="new-password" /></label>
          <label className="proxy-form-row proxy-bypass-row"><span>代理绕过</span><textarea aria-label="代理绕过地址" value={proxyBypass} disabled={!proxyEnabled} onChange={(event) => setProxyBypass(event.target.value)} spellCheck={false} /></label>
          <p className="proxy-priority-note">{proxyMode === "custom" ? "适用于 Clash、Mihomo 等本地代理；常见配置为 HTTP、127.0.0.1、7890。" : proxyMode === "system" ? "使用 HTTP_PROXY、HTTPS_PROXY、ALL_PROXY 等系统环境代理设置。" : "所有模型请求直接连接，不使用 HTTP 代理。"}</p>
        </div>
      </section>
      <section className="proxy-test-panel" aria-label="代理连接测试">
        <label className="proxy-test-url"><span>连接测试</span><input aria-label="代理测试地址" value={proxyTestUrl} disabled={!proxyActive} onChange={(event) => setProxyTestUrl(event.target.value)} spellCheck={false} /></label>
        <button type="button" onClick={() => void testProxy()} disabled={!proxyActive || proxyTestState.status === "testing"}>{proxyTestState.status === "testing" ? "测试中…" : "测试"}</button>
        {proxyTestState.status !== "idle" && <p className={`proxy-test-result ${proxyTestState.status}`} role="status">{proxyTestState.message}</p>}
      </section>
    </div>;
  }

  function renderAboutPage() {
    return <div className="settings-page-view about-page">
      <header className="about-brand"><img src={appIcon} alt="" /><div><h1>AI Translate</h1><p>轻量、快速的 Windows 桌面翻译工具</p></div></header>
      <div className="about-info-list" aria-label="软件信息">
        <div className="about-info-row"><span className="about-link-icon" aria-hidden="true"><AboutIcon name="version" /></span><strong>版本</strong><span className="about-info-value">v{APP_VERSION} · 开发预览版</span></div>
        {PROJECT_LINKS.map((link) => <div className="about-info-row" key={link.id}><span className="about-link-icon" aria-hidden="true"><AboutIcon name={link.id === "repository" ? "github" : "issues"} /></span><strong>{link.title}</strong>{link.url ? <a className="about-link-action" href={link.url} target="_blank" rel="noreferrer">{link.url}</a> : <span className="about-pending-badge">待配置</span>}</div>)}
      </div>
      <details className="about-licenses">
        <summary>开源许可与第三方声明</summary>
        <pre>{projectLicense}{"\n\n"}{providerNotices}</pre>
      </details>
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

  function renderEditModelDialog() {
    const dialog = editingModel ?? addingModel;
    if (!dialog) return null;
    const title = editingModel ? "编辑模型名称" : "新增模型";
    return <>
      <button type="button" className="model-dialog-backdrop" aria-label={`关闭${title}窗口`} onClick={closeModelNameDialog} />
      <form className="model-dialog-card edit-model-dialog-card" role="dialog" aria-modal="true" aria-labelledby="edit-model-dialog-title" onSubmit={(event) => { event.preventDefault(); saveModelName(); }}>
        <header className="model-dialog-header"><div className="model-dialog-heading"><h2 id="edit-model-dialog-title">{title}</h2></div><button type="button" className="model-dialog-close" onClick={closeModelNameDialog} aria-label={`关闭${title}窗口`} title="关闭"><Icon name="close" /></button></header>
        <div className="edit-model-dialog-content"><label htmlFor="edit-model-name">模型名称</label><input ref={editModelInputRef} id="edit-model-name" value={dialog.value} onChange={(event) => editingModel ? setEditingModel({ ...editingModel, value: event.target.value }) : setAddingModel({ ...addingModel!, value: event.target.value })} spellCheck={false} /></div>
        <footer className="model-dialog-footer"><button type="button" className="test-model-dialog-cancel" onClick={closeModelNameDialog}>取消</button><button type="submit" disabled={!dialog.value.trim()}>保存</button></footer>
      </form>
    </>;
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

  return <main className="app-shell settings-window-shell"><section className={`settings-shell settings-shell-${isProviderPage ? "providers" : "single"}`}><div className="settings-topbar" onMouseDown={beginWindowDrag}><div className="settings-brand settings-brand-top"><img src={appIcon} alt="AI Translate 图标" /><div><strong>AI Translate</strong></div></div><div className="settings-window-actions"><button type="button" className="settings-window-button settings-minimize-button" onClick={() => void nativeInvoke<void>("minimize_window").catch(() => undefined)} aria-label="最小化" title="最小化"><Icon name="minimize" /></button><button type="button" className="settings-close-button" onClick={() => void nativeInvoke("hide_settings_window")} aria-label="关闭设置" title="关闭设置"><Icon name="close" /></button></div></div><aside className="settings-nav-panel"><div className="settings-brand" onMouseDown={beginWindowDrag}><img src={appIcon} alt="AI Translate 图标" /><div><strong>AI Translate</strong><small>设置中心</small></div></div><nav className="settings-primary-nav" aria-label="设置分类"><button type="button" className={activeNavPage === "preferences" ? "is-active" : ""} onClick={() => switchSettingsPage("preferences")}><SettingsNavIcon name="preferences" />偏好设置</button><button type="button" className={activeNavPage === "providers" ? "is-active" : ""} onClick={() => switchSettingsPage("providers")}><SettingsNavIcon name="providers" />供应商</button><button type="button" className={activeNavPage === "proxy" ? "is-active" : ""} onClick={() => switchSettingsPage("proxy")}><SettingsNavIcon name="proxy" />网络代理</button><button type="button" className={activeNavPage === "about" ? "is-active" : ""} onClick={() => switchSettingsPage("about")}><SettingsNavIcon name="about" />关于</button></nav></aside>{isProviderPage && renderProviderColumn()}<section className="settings-main">{settingsPage === "preferences" ? renderPreferencesPage() : settingsPage === "proxy" ? renderProxyPage() : settingsPage === "about" ? renderAboutPage() : renderProviderDetails()}{notice && <p className="notice" role="status">{notice}</p>}</section>{renderModelDialog()}{renderEditModelDialog()}{renderProviderContextMenu()}</section></main>;
}

