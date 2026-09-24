import React, { useEffect } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import "./App.css";
import "./dark-theme.css";

const MainWindow = React.lazy(() => import("./MainWindow").then(({ MainWindow }) => ({ default: MainWindow })));
const SettingsWindow = React.lazy(() => import("./SettingsWindow").then(({ SettingsWindow }) => ({ default: SettingsWindow })));
const AddProviderWindow = React.lazy(() => import("./AddProviderWindow").then(({ AddProviderWindow }) => ({ default: AddProviderWindow })));

export function WindowApp() {
  useEffect(() => {
    const disableDefaultContextMenu = (event: globalThis.MouseEvent) => {
      if (!(event.target as HTMLElement).closest("input, textarea, .text-content")) event.preventDefault();
    };
    document.addEventListener("contextmenu", disableDefaultContextMenu);
    return () => document.removeEventListener("contextmenu", disableDefaultContextMenu);
  }, []);

  let label = "main";
  try {
    label = getCurrentWebviewWindow().label;
  } catch {
    label = new URLSearchParams(window.location.search).get("window") ?? "main";
  }
  if (label === "settings") return <SettingsWindow />;
  if (label === "add-provider") return <AddProviderWindow />;
  return <MainWindow />;
}
