import { type MouseEvent, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { SelectionFloat } from "./SelectionFloat";
import selectionFloatIcon from "./assets/selection-float-icon.svg";
import "./App.css";

type Translation = { source: string; translation: string };
const TRANSLATION_MODEL = "deepseek-v4-flash";

const isTauriDesktop = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function nativeInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauriDesktop) {
    throw new Error("当前页面运行在普通浏览器中。请关闭此页面，并使用 `npm.cmd run tauri dev` 打开的 AI Translate 桌面窗口。");
  }
  return invoke<T>(command, args);
}

function App() {
  if (getCurrentWebviewWindow().label === "selection-float") {
    return <SelectionFloat />;
  }

  const [result, setResult] = useState<Translation | null>(null);
  const [text, setText] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [hasApiKey, setHasApiKey] = useState(false);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState("按 Alt + T 翻译剪贴板中的文本");

  useEffect(() => {
    if (!isTauriDesktop) {
      setNotice("当前是普通浏览器预览，无法保存 API Key 或调用翻译。请使用 Tauri 桌面窗口。");
      return;
    }
    void nativeInvoke<boolean>("has_api_key")
      .then(setHasApiKey)
      .catch((error) => setNotice(String(error)));
    const resultListener = listen<Translation>("translation-result", (event) => {
      setResult(event.payload); setLoading(false); setNotice(""); setShowSettings(false);
    });
    const errorListener = listen<string>("translation-error", (event) => { setLoading(false); setNotice(event.payload); });
    const settingsListener = listen("open-settings", () => { setShowSettings(true); setNotice(""); });
    return () => { void resultListener.then((remove) => remove()); void errorListener.then((remove) => remove()); void settingsListener.then((remove) => remove()); };
  }, []);

  async function translate() {
    if (!text.trim()) return;
    setLoading(true); setNotice("");
    try { setResult(await nativeInvoke<Translation>("translate_text", { text })); }
    catch (error) { setNotice(String(error)); }
    finally { setLoading(false); }
  }

  async function saveKey() {
    try {
      await nativeInvoke("save_api_key", { apiKey });
      setApiKey(""); setHasApiKey(true); setNotice("API Key 已安全保存到 Windows 凭据管理器。"); setShowSettings(false);
    } catch (error) { setNotice(String(error)); }
  }

  function dragWindow(event: MouseEvent<HTMLElement>) {
    if ((event.target as HTMLElement).closest("button, input, textarea")) return;
    void getCurrentWindow().startDragging();
  }

  return <main className="app-shell">
    <header className="titlebar" onMouseDown={dragWindow}>
      <div className="brand"><img className="brand-icon" src={selectionFloatIcon} alt="翻译" /></div>
      <div className="window-actions"><button className="icon-button" onClick={() => void nativeInvoke("hide_window")} aria-label="隐藏">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h10" /></svg>
      </button></div>
    </header>
    {showSettings ? <section className="content settings">
      <div className="page-heading"><p className="eyebrow">连接设置</p><h1>DeepSeek 设置</h1><p className="hint">API Key 仅保存到当前 Windows 用户的凭据管理器。</p></div>
      <label className="field-label" htmlFor="deepseek-api-key">DeepSeek API Key</label>
      <input id="deepseek-api-key" value={apiKey} onChange={(event) => setApiKey(event.target.value)} type="password" placeholder="粘贴你的 API Key" autoFocus />
      <p className="field-help">保存后，选中文本即可快速翻译。</p>
      <div className="action-row"><button className="primary" onClick={() => void saveKey()}>保存 API Key</button><button className="secondary" onClick={() => setShowSettings(false)}>返回</button></div>
    </section> : <section className="content">
      {result ? <div className="translation-result">
        <div className="result-card"><div className="result-section"><div className="result-model"><span>翻译模型</span><strong>{TRANSLATION_MODEL}</strong></div><p className="result-label">原文</p><p className="source">{result.source}</p></div><div className="result-divider" /><div className="result-section"><p className="result-label result-label-accent">译文</p><p className={`translation${/[\u3400-\u9fff]/.test(result.source) ? " translation-english" : ""}`}>{result.translation}</p></div></div>
      </div> : <>
        <div className="page-heading"><p className="eyebrow">快速翻译</p><h1>把文字变成另一种语言</h1><p className="hint">选中文本后复制，再按 <kbd>Alt</kbd> + <kbd>T</kbd>；也可以直接输入。</p></div>
        {!hasApiKey && <div className="warning"><span className="warning-icon" aria-hidden="true">!</span><p>请先在系统托盘图标的右键菜单中设置 API Key。</p></div>}
        <div className="input-card"><div className="input-head"><label className="field-label" htmlFor="translation-input">输入文本</label><span className="character-count">{text.length} 字符</span></div>
          <textarea id="translation-input" value={text} onChange={(event) => setText(event.target.value)} placeholder="输入要翻译的文字…" />
          <div className="input-footer"><span className="field-help">支持中英文自动识别</span><button className="primary" disabled={loading || !text.trim()} onClick={() => void translate()}>{loading ? "翻译中…" : "翻译"}</button></div>
        </div>
      </>}{notice && <p className="notice" role="status">{notice}</p>}
    </section>}
  </main>;
}

export default App;
