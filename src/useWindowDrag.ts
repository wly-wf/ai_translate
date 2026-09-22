import { getCurrentWindow } from "@tauri-apps/api/window";
import { type MouseEvent, useCallback, useEffect, useRef } from "react";

type WindowDragState = {
  startX: number;
  startY: number;
  started: boolean;
  cleanup: () => void;
};

const INTERACTIVE_SELECTOR = "button, input, textarea, select, a";

export function useWindowDrag() {
  const dragRef = useRef<WindowDragState | null>(null);

  const finishWindowDrag = useCallback(() => {
    dragRef.current?.cleanup();
    dragRef.current = null;
  }, []);

  const beginWindowDrag = useCallback((event: MouseEvent<HTMLElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest(INTERACTIVE_SELECTOR)) return;
    finishWindowDrag();

    let cleanedUp = false;
    const handleMove = (moveEvent: globalThis.MouseEvent) => {
      const drag = dragRef.current;
      if (!drag || drag.started) return;
      const deltaX = moveEvent.screenX - drag.startX;
      const deltaY = moveEvent.screenY - drag.startY;
      if (deltaX * deltaX + deltaY * deltaY < 16) return;
      drag.started = true;
      void getCurrentWindow().startDragging().catch(() => {
        drag.started = false;
      });
    };
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", finishWindowDrag);
    };
    dragRef.current = { startX: event.screenX, startY: event.screenY, started: false, cleanup };
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", finishWindowDrag);
  }, [finishWindowDrag]);

  useEffect(() => finishWindowDrag, [finishWindowDrag]);

  return { beginWindowDrag, finishWindowDrag };
}
