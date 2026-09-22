import type { SettingsProviderId } from "./providerTypes";
import { type ThemeMode, type AccentColor, clampFontSize, nativeInvoke } from "./useUserPreferences";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { type SettingsProvider, type ModelChoice, PROVIDER_IMAGE_ICONS, withCustomProviderIdentity, translationProvider, ACCENT_COLOR_OPTIONS } from "./providerCatalog";

// GitHub mark from Simple Icons 16.28.0 (CC0-1.0).
const GITHUB_ICON_PATH = "M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12";

export function ProviderIcon({ provider }: { provider: { id: string; mark: string } }) {
  const imageIcon = PROVIDER_IMAGE_ICONS[provider.id as SettingsProviderId];
  if (imageIcon) {
    return <span className={`provider-mark provider-brand-mark ${imageIcon.className}`} aria-hidden="true"><img className="provider-brand-image" src={imageIcon.src} alt="" /></span>;
  }
  return <span className="provider-mark provider-custom-mark" aria-hidden="true">{provider.mark}</span>;
}

function useDismissiblePopover(open: boolean, close: () => void) {
  const rootRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: globalThis.MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) closeRef.current();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeRef.current();
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return rootRef;
}

export function useDialogLifecycle(open: boolean, onClose: () => void, initialFocusRef: RefObject<HTMLElement | null>, restoreFocusRef?: RefObject<HTMLElement | null>) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const focusFrame = window.requestAnimationFrame(() => initialFocusRef.current?.focus());
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", closeOnEscape);
      if (restoreFocusRef) window.requestAnimationFrame(() => restoreFocusRef.current?.focus());
    };
  }, [open, initialFocusRef, restoreFocusRef]);
}

export function ApiKeyInput({ id, value, onChange, placeholder = "", required = false }: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  required?: boolean;
}) {
  const [visible, setVisible] = useState(false);
  return <div className="api-key-input-wrap">
    <input id={id} value={value} onChange={(event) => onChange(event.target.value)} type={visible ? "text" : "password"} autoComplete="off" placeholder={placeholder} required={required} />
    <button type="button" className="api-key-toggle" onClick={() => setVisible((current) => !current)} aria-label={visible ? "隐藏 API Key" : "显示 API Key"} title={visible ? "隐藏 API Key" : "显示 API Key"}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.4-5.5 9.5-5.5 9.5 5.5 9.5 5.5-3.4 5.5-9.5 5.5S2.5 12 2.5 12Z" /><circle cx="12" cy="12" r="2.5" /></svg></button>
  </div>;
}

export function ModelPicker({ value, choices, onChange, ariaLabel, disabled = false }: { value: string | null; choices: ModelChoice[]; onChange: (choice: ModelChoice) => void; ariaLabel: string; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const rootRef = useDismissiblePopover(open, () => setOpen(false));
  const selectedChoice = choices.find((choice) => choice.id === value) ?? null;
  const providerForChoice = (choice: ModelChoice) => {
    const provider = translationProvider(choice.providerId);
    return provider ? withCustomProviderIdentity(provider, choice.vendor) : provider;
  };
  const selectedProvider = selectedChoice ? providerForChoice(selectedChoice) : null;

  return <div className={`model-picker${open ? " is-open" : ""}`} ref={rootRef}>
    <button className="model-picker-trigger" type="button" aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((current) => !current)} disabled={disabled || choices.length === 0}>
      {selectedProvider ? <ProviderIcon provider={selectedProvider} /> : <span className="model-picker-placeholder-icon" aria-hidden="true">◇</span>}
      <span className="model-picker-value">{selectedChoice && selectedProvider ? <strong>{selectedChoice.model}/{selectedProvider.vendor}</strong> : <strong>未设置默认模型</strong>}</span>
    </button>
    {open && <div className="model-picker-menu" role="listbox" aria-label={ariaLabel}>{choices.map((choice) => { const provider = providerForChoice(choice); if (!provider) return null; const selected = choice.id === value; return <button className={`model-picker-option${selected ? " is-selected" : ""}`} type="button" role="option" aria-selected={selected} key={choice.id} onClick={() => { onChange(choice); setOpen(false); }}><ProviderIcon provider={provider} /><span><strong>{choice.model}/{provider.vendor}</strong></span>{selected && <span className="model-picker-selected-dot" aria-hidden="true" />}</button>; })}</div>}
  </div>;
}

export function InlineSelect({ value, options, onChange, ariaLabel, disabled = false, showCheck = true }: { value: string; options: string[]; onChange: (value: string) => void; ariaLabel: string; disabled?: boolean; showCheck?: boolean }) {
  const [open, setOpen] = useState(false);
  const rootRef = useDismissiblePopover(open, () => setOpen(false));

  return <div className={`inline-select${open ? " is-open" : ""}`} ref={rootRef}>
    <button className="inline-select-trigger" type="button" role="combobox" aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={open} disabled={disabled} onClick={() => setOpen((current) => !current)}>
      <span>{value}</span><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
    </button>
    {open && <div className="inline-select-menu" role="listbox" aria-label={ariaLabel}>{options.map((option) => <button className={`inline-select-option${option === value ? " is-selected" : ""}`} type="button" role="option" aria-selected={option === value} key={option} onClick={() => { onChange(option); setOpen(false); }}><span>{option}</span>{showCheck && option === value && <span className="inline-select-check" aria-hidden="true">✓</span>}</button>)}</div>}
  </div>;
}

export function SegmentedControl({ value, options, onChange, ariaLabel }: {
  value: string;
  options: { value: string; label: string; icon?: ThemeMode }[];
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
    >{option.icon && <ThemeModeIcon mode={option.icon} />}{option.label}</button>)}
  </div>;
}

export function ThemeModeIcon({ mode }: { mode: ThemeMode }) {
  const paths: Record<ThemeMode, React.ReactNode> = {
    light: <><circle cx="8" cy="8" r="2.5" /><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6 13 13M13 3l-1.4 1.4M4.4 11.6 3 13" /></>,
    dark: <path d="M8 2a4 4 0 0 0 6 6 6 6 0 1 1-6-6Z" />,
    system: <><rect x="1.5" y="2.5" width="13" height="9" rx="1.5" /><path d="M5.5 14h5M8 11.5V14" /></>,
  };
  return <svg className="theme-mode-icon" viewBox="0 0 16 16" aria-hidden="true">{paths[mode]}</svg>;
}

export function AccentColorPicker({ value, onChange }: { value: AccentColor; onChange: (value: AccentColor) => void }) {
  return <div className="accent-color-picker" role="radiogroup" aria-label="主题色">
    {ACCENT_COLOR_OPTIONS.map((option) => <button
      className={value === option.value ? "is-selected" : ""}
      data-accent-value={option.value}
      key={option.value}
      type="button"
      role="radio"
      aria-checked={value === option.value}
      aria-label={option.label}
      title={option.label}
      onClick={() => onChange(option.value)}
    ><span aria-hidden="true" /></button>)}
  </div>;
}

// Stays inside the native store's accepted ranges (12–24 and 12–28 in
// src-tauri/src/lib.rs) so the UI can never submit a value the backend rejects.
export function FontSizeStepper({ value, limits, onChange, ariaLabel }: {
  value: number;
  limits: { min: number; max: number };
  onChange: (size: number) => void;
  ariaLabel: string;
}) {
  const size = clampFontSize(value, limits);

  function applySize(next: number) {
    const clamped = clampFontSize(next, limits);
    if (clamped !== size) onChange(clamped);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const keyTargets: Record<string, number> = {
      ArrowUp: size + 1,
      ArrowRight: size + 1,
      ArrowDown: size - 1,
      ArrowLeft: size - 1,
      PageUp: size + 2,
      PageDown: size - 2,
      Home: limits.min,
      End: limits.max,
    };
    if (keyTargets[event.key] === undefined) return;
    event.preventDefault();
    applySize(keyTargets[event.key]);
  }

  return <div
    className="font-size-stepper"
    role="spinbutton"
    aria-label={ariaLabel}
    aria-valuemin={limits.min}
    aria-valuemax={limits.max}
    aria-valuenow={size}
    aria-valuetext={`${size} 像素`}
    aria-disabled={false}
    tabIndex={0}
    onKeyDown={handleKeyDown}
  >
    <span className="font-size-stepper-value" aria-hidden="true">{size}<small>px</small></span>
    <span className="font-size-stepper-buttons">
      <button type="button" tabIndex={-1} aria-label={`增大${ariaLabel}`} title={`增大${ariaLabel}`} disabled={size >= limits.max} onClick={() => applySize(size + 1)}>
        <svg viewBox="0 0 12 8" aria-hidden="true"><path d="M1 6.4 6 1.6l5 4.8" /></svg>
      </button>
      <button type="button" tabIndex={-1} aria-label={`减小${ariaLabel}`} title={`减小${ariaLabel}`} disabled={size <= limits.min} onClick={() => applySize(size - 1)}>
        <svg viewBox="0 0 12 8" aria-hidden="true"><path d="M1 1.6 6 6.4l5-4.8" /></svg>
      </button>
    </span>
  </div>;
}

// Translate native validation failures into an actionable save/rollback notice.
export function preferenceNoticeMessage(error: string) {
  return error.includes("must be") ? "设置未保存，已恢复之前的值，请重试。" : error;
}

export function Icon({ name }: { name: "menu" | "close" | "chevron" | "pin" | "minimize" }) {
  const paths: Record<string, React.ReactNode> = {
    menu: <path d="M3 5h12M3 9h12M3 13h12" />,
    close: <path d="m3 3 12 12M15 3 3 15" />,
    chevron: <path d="m3 6 5 5 5-5" />,
    pin: <><path d="M5 3.5h8M6 3.5v5.2l-2.8 3.1h11.6L12 8.7V3.5M9 11.8v4.7" /></>,
    minimize: <path d="M3 9h12" />,
  };

  return <svg className={`ui-icon ui-icon-${name}`} viewBox="0 0 18 18" aria-hidden="true">{paths[name]}</svg>;
}

export function ProviderSetupNotice({ onOpenError }: { onOpenError: (message: string) => void }) {
  const openSettings = () => {
    void nativeInvoke("open_settings_window").catch((error) => onOpenError(String(error)));
  };

  return <div className="provider-setup-notice" role="status">
    <span className="provider-setup-notice-icon" aria-hidden="true">!</span>
    <span className="provider-setup-notice-copy">
      <strong>需要配置翻译供应商</strong>
      <span>添加并启用供应商后即可开始翻译</span>
    </span>
    <button type="button" onClick={openSettings}>前往设置<span aria-hidden="true">→</span></button>
  </div>;
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

export function QuickTranslateIcon() {
  return <svg className="quick-translate-icon" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M5.25 5.5h9.1a3 3 0 0 1 3 3v3.9a3 3 0 0 1-3 3H9.7l-3.55 2.9v-2.95a3 3 0 0 1-1.9-2.8V8.5a3 3 0 0 1 3-3Z" />
    <path d="M7.45 9.15h4.55M9.72 7.85v2.6M7.45 11.65h3.05" />
    <path className="quick-translate-spark" d="m18.1 3.15.62 1.82 1.83.62-1.83.62-.62 1.83-.62-1.83-1.83-.62 1.83-.62.62-1.82Z" />
  </svg>;
}

export function ReturnToFloatIcon() {
  return <svg className="quick-translate-icon" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12.75 5.25h5.5a2 2 0 0 1 2 2v9.5a2 2 0 0 1-2 2h-5.5" />
    <path d="m10.5 8.5-3.5 3.5 3.5 3.5M7.25 12h9" />
    <path d="M4 5.25v13.5" />
  </svg>;
}

export function SearchIcon({ className = "provider-search-icon" }: { className?: string }) {
  return <svg className={className} viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m15.5 15.5 4.5 4.5" /></svg>;
}

export function ModelAddIcon() {
  return <svg className="model-toolbar-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>;
}

export function ModelRefreshIcon() {
  return <svg className="model-toolbar-icon model-refresh-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0 1.1 4.6" /><path d="M20 5v6h-6" /></svg>;
}

export function DeleteIcon() {
  return <svg className="provider-context-menu-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 7h15M9 7V4.5h6V7M7 7l.7 12h8.6L17 7M10 10.5v5M14 10.5v5" /></svg>;
}

export function AvailableModelsDialog({ provider, models, selectedModels, isLoading, fetchError, closeButtonRef, restoreFocusRef, onToggle, onClose, onRetry }: {
  provider: SettingsProvider;
  models: string[];
  selectedModels: string[];
  isLoading: boolean;
  fetchError: string;
  closeButtonRef: React.RefObject<HTMLButtonElement | null>;
  restoreFocusRef: React.RefObject<HTMLButtonElement | null>;
  onToggle: (model: string) => void;
  onClose: () => void;
  onRetry: () => void;
}) {
  useDialogLifecycle(true, onClose, closeButtonRef, restoreFocusRef);

  return <>
    <button type="button" className="model-dialog-backdrop" aria-label="关闭可用模型窗口" onClick={onClose} />
    <div className="model-dialog-card" role="dialog" aria-modal="true" aria-label={`${provider.vendor} 可用模型`}>
      <header className="model-dialog-header">
        <div className="model-dialog-heading">
          <h2>{provider.vendor}模型</h2>
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
                  <ProviderIcon provider={provider} />
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

export function SettingsNavIcon({ name }: { name: "preferences" | "providers" | "proxy" | "about" }) {
  const paths = {
    preferences: <><path d="M4 6h16M4 12h16M4 18h16" /><circle cx="9" cy="6" r="1.7" /><circle cx="15" cy="12" r="1.7" /><circle cx="11" cy="18" r="1.7" /></>,
    providers: <><rect x="4" y="4" width="7" height="7" rx="1.2" /><rect x="13" y="13" width="7" height="7" rx="1.2" /><path d="M11 7.5h2M16.5 11v2" /></>,
    proxy: <><circle cx="6" cy="12" r="2.5" /><circle cx="18" cy="6" r="2.5" /><circle cx="18" cy="18" r="2.5" /><path d="m8.3 10.9 7.4-3.8M8.3 13.1l7.4 3.8" /></>,
    about: <><circle cx="12" cy="12" r="8.5" /><path d="M12 10v6M12 7.5v.01" /></>,
  };
  return <svg className="settings-nav-icon" viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>;
}

export function AboutIcon({ name }: { name: "version" | "github" | "issues" }) {
  if (name === "github") {
    return <svg className="about-icon about-icon-github" viewBox="0 0 24 24" aria-hidden="true"><path d={GITHUB_ICON_PATH} /></svg>;
  }
  const paths: Record<Exclude<typeof name, "github">, React.ReactNode> = {
    version: <><path d="M12 3.5a8.5 8.5 0 1 0 8.5 8.5" /><path d="M20.5 5v7h-7" /></>,
    issues: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5v5.5M12 16.5v.01" /></>,
  };
  return <svg className="about-icon" viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>;
}

