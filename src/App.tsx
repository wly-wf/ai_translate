import { useEffect } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { MainWindow } from "./MainWindow";
import { SettingsWindow } from "./SettingsWindow";
import { AddProviderWindow } from "./AddProviderWindow";
import "./App.css";
import "./dark-theme.css";
export { ExpandableText } from "./sharedUI";

function App() {
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

export default App;
