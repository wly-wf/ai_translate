import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
const App = React.lazy(() => import("./App"));
const Float = React.lazy(() => import("./SelectionFloat").then((module) => ({ default: module.SelectionFloat })));

document.documentElement.dataset.window = "__TAURI_INTERNALS__" in window
  ? getCurrentWebviewWindow().label
  : "main";

try {
  const stored = JSON.parse(window.localStorage.getItem("ai-translate-appearance") ?? "null") as {
    themeMode?: "light" | "dark" | "system";
    accentColor?: "blue" | "purple" | "green" | "orange" | "rose";
    sourceFontSize?: number;
    translationFontSize?: number;
  } | null;
  if (stored) {
    const systemDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
    const mode = stored.themeMode ?? "system";
    const resolved = mode === "system" ? (systemDark ? "dark" : "light") : mode;
    document.documentElement.dataset.theme = resolved;
    document.documentElement.dataset.themeMode = mode;
    document.documentElement.dataset.accent = stored.accentColor ?? "blue";
    document.documentElement.style.colorScheme = resolved;
    if (stored.sourceFontSize) document.documentElement.style.setProperty("--source-font-size", `${stored.sourceFontSize}px`);
    if (stored.translationFontSize) document.documentElement.style.setProperty("--translation-font-size", `${stored.translationFontSize}px`);
  }
} catch {
  // The native preference store will apply the authoritative values on mount.
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <React.Suspense fallback={null}>
      {document.documentElement.dataset.window === "selection-float" ? <Float /> : <App />}
    </React.Suspense>
  </React.StrictMode>,
);
