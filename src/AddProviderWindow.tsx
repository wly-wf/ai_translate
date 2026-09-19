import type { SettingsProviderId } from "./providerTypes";
import { nativeInvoke, useUserPreferences } from "./useUserPreferences";
import { type MouseEvent, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { type ProviderDraft, GENERIC_PROVIDERS, createProviderDrafts, uniqueModels, withCustomProviderIdentity } from "./providerCatalog";
import { ProviderIcon, Icon, AvailableModelsDialog } from "./sharedUI";

export function AddProviderWindow() {
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
    // The HTML load event can precede this lazy-loaded form's first commit.
    void nativeInvoke("add_provider_window_ready").catch((error) => setNotice(String(error)));
  }, []);

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
      const models = await nativeInvoke<string[]>("fetch_provider_models", { provider: provider.id, apiKey: draft.apiKey, baseUrl: draft.baseUrl, useStoredKey: false });
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
      await nativeInvoke("create_custom_provider", { vendorName: draft.vendorName, apiKey: draft.apiKey, baseUrl: draft.baseUrl, model: configuredModels[0], models: configuredModels });
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

