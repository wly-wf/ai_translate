import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import selectionFloatIcon from "../src-tauri/icons/tray-icon.svg";

const nativeInvoke = invoke;

export function SelectionFloat() {
  const [translating, setTranslating] = useState(false);

  useEffect(() => {
    const showListener = listen<{ generation: number }>("selection-float:show", () => {
      setTranslating(false);
    });
    const hideListener = listen("selection-float:hide", () => {
      setTranslating(false);
    });

    return () => {
      void showListener.then((remove) => remove());
      void hideListener.then((remove) => remove());
    };
  }, []);

  async function translateSelection() {
    setTranslating(true);
    try {
      await nativeInvoke("translate_selection_float");
    } catch {
      setTranslating(false);
    }
  }

  return (
    <button
      className="selection-float-button"
      type="button"
      aria-label="翻译选中文本"
      disabled={translating}
      onClick={() => void translateSelection()}
    >
      <img className="selection-float-icon" src={selectionFloatIcon} alt="" />
    </button>
  );
}
