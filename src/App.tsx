import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./App.css";

type Translation = { source: string; translation: string };

const isTauriDesktop = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function nativeInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauriDesktop) {
    throw new Error("当前页面运行在普通浏览器中。请关闭此页面，并使用 `npm.cmd run tauri dev` 打开的 AI Translate 桌面窗口。");
  }
  return invoke<T>(command, args);
}

function App() {
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
    return () => { void resultListener.then((remove) => remove()); void errorListener.then((remove) => remove()); };
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

  async function copy() {
    if (!result) return;
    try {
      await nativeInvoke("copy_text", { text: result.translation });
      setNotice("译文已复制。");
    } catch (error) {
      setNotice(String(error));
    }
  }

  return <main className="app-shell">
    <header className="titlebar" data-tauri-drag-region>
      <div className="brand" data-tauri-drag-region><span>✦</span> AI Translate</div>
      <div className="window-actions"><button className="icon-button" onClick={() => setShowSettings((value) => !value)} aria-label="设置">⚙</button><button className="icon-button" onClick={() => void nativeInvoke("hide_window")} aria-label="隐藏">—</button></div>
    </header>
    {showSettings ? <section className="content settings">
      <h1>DeepSeek 设置</h1><p>Key 仅保存到当前 Windows 用户的凭据管理器。</p>
      <input value={apiKey} onChange={(event) => setApiKey(event.target.value)} type="password" placeholder="DeepSeek API Key" autoFocus />
      <button className="primary" onClick={() => void saveKey()}>保存 API Key</button><button className="secondary" onClick={() => setShowSettings(false)}>返回</button>
    </section> : <section className="content">
      {result ? <><div className="label">原文</div><p className="source">{result.source}</p><div className="label">译文</div><p className="translation">{result.translation}</p><button className="primary" onClick={() => void copy()}>复制译文</button></> : <>
        <h1>快速翻译</h1><p className="hint">选中文本后复制，再按 <kbd>Alt</kbd> + <kbd>T</kbd>。</p>{!hasApiKey && <p className="warning">请先点击右上角设置 API Key。</p>}
        <textarea value={text} onChange={(event) => setText(event.target.value)} placeholder="或在这里输入要翻译的文字" /><button className="primary" disabled={loading || !text.trim()} onClick={() => void translate()}>{loading ? "翻译中…" : "翻译"}</button>
      </>}{notice && <p className="notice">{notice}</p>}
    </section>}
  </main>;
}

export default App;
