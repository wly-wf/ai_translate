import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import selectionFloatIcon from "../src-tauri/icons/tray-icon.svg";

const nativeInvoke = invoke;

export function SelectionFloat() {
  const [translating, setTranslating] = useState(false);
  const [visible, setVisible] = useState(false);
  const [appearanceCycle, setAppearanceCycle] = useState(0);

  useEffect(() => {
    const showListener = listen<{ generation: number }>("selection-float:show", () => {
      setTranslating(false);
      setVisible(true);
      // Remount the animated layer for every selection, including when the
      // native window is already visible and only moves to a new anchor.
      setAppearanceCycle((cycle) => cycle + 1);
    });
    const hideListener = listen("selection-float:hide", () => {
      setTranslating(false);
      setVisible(false);
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
      key={appearanceCycle}
      className={`selection-float-button${visible ? " is-visible" : ""}`}
      type="button"
      aria-label="翻译选中文本"
      disabled={translating}
      onClick={() => void translateSelection()}
    >
      <span className="selection-float-pop" aria-hidden="true">
        <img className="selection-float-icon" src={selectionFloatIcon} alt="" />
      </span>
    </button>
  );
}
