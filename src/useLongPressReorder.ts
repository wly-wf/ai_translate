import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEventHandler,
  type MouseEventHandler,
  type PointerEventHandler,
} from "react";

export type ReorderInput = "pointer" | "keyboard";
export type ReorderPhase = "idle" | "pressing" | "dragging" | "keyboard";

export interface ReorderRequest<ItemId extends string> {
  activeId: ItemId;
  overId: ItemId;
  fromIndex: number;
  toIndex: number;
  input: ReorderInput;
}

export interface ReorderInteraction<ItemId extends string> {
  activeId: ItemId;
  input: ReorderInput;
}

export interface UseLongPressReorderOptions<ItemId extends string> {
  items: readonly ItemId[];
  onReorder: (request: ReorderRequest<ItemId>) => void;
  onReorderStart?: (interaction: ReorderInteraction<ItemId>) => void;
  onReorderEnd?: (interaction: ReorderInteraction<ItemId>) => void;
  onReorderCancel?: (interaction: ReorderInteraction<ItemId>) => void;
  getItemLabel?: (itemId: ItemId) => string;
  longPressMs?: number;
  movementTolerance?: number;
  disabled?: boolean;
}

export interface LongPressReorderState<ItemId extends string> {
  phase: ReorderPhase;
  activeId: ItemId | null;
  overId: ItemId | null;
}

export interface LongPressReorderItemProps<ElementType extends HTMLElement> {
  "data-long-press-reorder-item": string;
  "aria-keyshortcuts": string;
  "aria-pressed": boolean;
  tabIndex: number;
  style: CSSProperties;
  onPointerDown: PointerEventHandler<ElementType>;
  onPointerMove: PointerEventHandler<ElementType>;
  onPointerUp: PointerEventHandler<ElementType>;
  onPointerCancel: PointerEventHandler<ElementType>;
  onLostPointerCapture: PointerEventHandler<ElementType>;
  onClickCapture: MouseEventHandler<ElementType>;
  onKeyDown: KeyboardEventHandler<ElementType>;
}

interface PointerSession<ItemId extends string> {
  pointerId: number;
  activeId: ItemId;
  startX: number;
  startY: number;
  element: HTMLElement;
  phase: "pressing" | "dragging";
  timer: ReturnType<typeof setTimeout>;
  lastOverId: ItemId | null;
}

const ITEM_ATTRIBUTE = "data-long-press-reorder-item";
const KEYBOARD_SHORTCUTS = "Space Enter ArrowUp ArrowDown Home End Escape";
const DEFAULT_LONG_PRESS_MS = 350;
const DEFAULT_MOVEMENT_TOLERANCE = 5;

const idleState = <ItemId extends string>(): LongPressReorderState<ItemId> => ({
  phase: "idle",
  activeId: null,
  overId: null,
});

/**
 * Adds long-press pointer sorting and an equivalent keyboard interaction to a
 * dedicated reorder handle. Spread `getItemProps(id)` onto that handle, not the
 * entire row: its `touchAction: "none"` is required to keep Pointer Events from
 * being cancelled by browser panning while a press is pending.
 */
export function useLongPressReorder<ItemId extends string>({
  items,
  onReorder,
  onReorderStart,
  onReorderEnd,
  onReorderCancel,
  getItemLabel = (itemId) => itemId,
  longPressMs = DEFAULT_LONG_PRESS_MS,
  movementTolerance = DEFAULT_MOVEMENT_TOLERANCE,
  disabled = false,
}: UseLongPressReorderOptions<ItemId>) {
  const [state, setState] = useState<LongPressReorderState<ItemId>>(idleState);
  const [announcement, setAnnouncement] = useState("");
  const pointerSessionRef = useRef<PointerSession<ItemId> | null>(null);
  const keyboardActiveRef = useRef<ItemId | null>(null);
  const suppressedClickRef = useRef<ItemId | null>(null);
  const clickResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  const latestRef = useRef({
    items,
    onReorder,
    onReorderStart,
    onReorderEnd,
    onReorderCancel,
    getItemLabel,
    longPressMs,
    movementTolerance,
    disabled,
  });
  latestRef.current = {
    items,
    onReorder,
    onReorderStart,
    onReorderEnd,
    onReorderCancel,
    getItemLabel,
    longPressMs,
    movementTolerance,
    disabled,
  };

  const releasePointer = useCallback((session: PointerSession<ItemId>) => {
    try {
      if (session.element.hasPointerCapture?.(session.pointerId)) {
        session.element.releasePointerCapture(session.pointerId);
      }
    } catch {
      // The browser may already have implicitly released a cancelled pointer.
    }
  }, []);

  const clearPointerSession = useCallback(
    (notifyCancel: boolean) => {
      const session = pointerSessionRef.current;
      if (!session) return;

      pointerSessionRef.current = null;
      clearTimeout(session.timer);
      releasePointer(session);
      if (notifyCancel && session.phase === "dragging") {
        latestRef.current.onReorderCancel?.({
          activeId: session.activeId,
          input: "pointer",
        });
      }
      if (mountedRef.current) setState(idleState);
    },
    [releasePointer],
  );

  const requestMove = useCallback(
    (activeId: ItemId, overId: ItemId, input: ReorderInput) => {
      const currentItems = latestRef.current.items;
      const fromIndex = currentItems.indexOf(activeId);
      const toIndex = currentItems.indexOf(overId);
      if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return false;

      latestRef.current.onReorder({ activeId, overId, fromIndex, toIndex, input });
      setAnnouncement(
        `${latestRef.current.getItemLabel(activeId)} 已移动到第 ${toIndex + 1} 项，共 ${currentItems.length} 项。`,
      );
      return true;
    },
    [],
  );

  const targetItemAtPoint = useCallback((clientX: number, clientY: number) => {
    const hit = document.elementFromPoint?.(clientX, clientY);
    const item = hit?.closest<HTMLElement>(`[${ITEM_ATTRIBUTE}]`);
    const itemId = item?.getAttribute(ITEM_ATTRIBUTE) as ItemId | null;
    return itemId && latestRef.current.items.includes(itemId) ? itemId : null;
  }, []);

  const suppressNextClick = useCallback((itemId: ItemId) => {
    suppressedClickRef.current = itemId;
    if (clickResetTimerRef.current) clearTimeout(clickResetTimerRef.current);
    clickResetTimerRef.current = setTimeout(() => {
      if (suppressedClickRef.current === itemId) suppressedClickRef.current = null;
      clickResetTimerRef.current = null;
    }, 0);
  }, []);

  const getItemProps = useCallback(
    <ElementType extends HTMLElement = HTMLElement>(
      itemId: ItemId,
    ): LongPressReorderItemProps<ElementType> => {
      const onPointerDown: PointerEventHandler<ElementType> = (event) => {
        if (
          latestRef.current.disabled ||
          pointerSessionRef.current ||
          keyboardActiveRef.current ||
          !event.isPrimary ||
          event.button !== 0
        ) {
          return;
        }

        const element = event.currentTarget;
        try {
          element.setPointerCapture(event.pointerId);
        } catch {
          return;
        }

        const session: PointerSession<ItemId> = {
          pointerId: event.pointerId,
          activeId: itemId,
          startX: event.clientX,
          startY: event.clientY,
          element,
          phase: "pressing",
          timer: 0 as unknown as ReturnType<typeof setTimeout>,
          lastOverId: itemId,
        };
        session.timer = setTimeout(() => {
          if (pointerSessionRef.current !== session || latestRef.current.disabled) return;
          session.phase = "dragging";
          setState({ phase: "dragging", activeId: itemId, overId: itemId });
          setAnnouncement(
            `${latestRef.current.getItemLabel(itemId)} 已抓取。使用指针拖动，松开以放置。`,
          );
          latestRef.current.onReorderStart?.({ activeId: itemId, input: "pointer" });
        }, Math.max(0, latestRef.current.longPressMs));
        pointerSessionRef.current = session;
        setState({ phase: "pressing", activeId: itemId, overId: itemId });
      };

      const onPointerMove: PointerEventHandler<ElementType> = (event) => {
        const session = pointerSessionRef.current;
        if (!session || session.pointerId !== event.pointerId) return;

        if (session.phase === "pressing") {
          const deltaX = event.clientX - session.startX;
          const deltaY = event.clientY - session.startY;
          const tolerance = Math.max(0, latestRef.current.movementTolerance);
          if (deltaX * deltaX + deltaY * deltaY > tolerance * tolerance) {
            clearPointerSession(false);
          }
          return;
        }

        event.preventDefault();
        const overId = targetItemAtPoint(event.clientX, event.clientY);
        if (!overId || overId === session.lastOverId) return;
        session.lastOverId = overId;
        setState({ phase: "dragging", activeId: session.activeId, overId });
        requestMove(session.activeId, overId, "pointer");
      };

      const onPointerUp: PointerEventHandler<ElementType> = (event) => {
        const session = pointerSessionRef.current;
        if (!session || session.pointerId !== event.pointerId) return;

        const wasDragging = session.phase === "dragging";
        const activeId = session.activeId;
        if (wasDragging) {
          event.preventDefault();
          suppressNextClick(activeId);
        }
        clearPointerSession(false);
        if (wasDragging) {
          latestRef.current.onReorderEnd?.({ activeId, input: "pointer" });
          setAnnouncement(`${latestRef.current.getItemLabel(activeId)} 已放置。`);
        }
      };

      const cancelPointer: PointerEventHandler<ElementType> = (event) => {
        const session = pointerSessionRef.current;
        if (session?.pointerId === event.pointerId) clearPointerSession(true);
      };

      const onClickCapture: MouseEventHandler<ElementType> = (event) => {
        if (suppressedClickRef.current !== itemId) return;
        suppressedClickRef.current = null;
        if (clickResetTimerRef.current) clearTimeout(clickResetTimerRef.current);
        clickResetTimerRef.current = null;
        event.preventDefault();
        event.stopPropagation();
      };

      const onKeyDown: KeyboardEventHandler<ElementType> = (event) => {
        if (latestRef.current.disabled) return;
        const activeId = keyboardActiveRef.current;

        if (!activeId && (event.key === " " || event.key === "Enter")) {
          event.preventDefault();
          keyboardActiveRef.current = itemId;
          setState({ phase: "keyboard", activeId: itemId, overId: itemId });
          setAnnouncement(
            `${latestRef.current.getItemLabel(itemId)} 已抓取。使用方向键移动，空格或回车放置，Esc 取消。`,
          );
          latestRef.current.onReorderStart?.({ activeId: itemId, input: "keyboard" });
          return;
        }
        if (!activeId) return;

        if (event.key === "Escape") {
          event.preventDefault();
          keyboardActiveRef.current = null;
          setState(idleState);
          setAnnouncement(`${latestRef.current.getItemLabel(activeId)} 的排序已取消。`);
          latestRef.current.onReorderCancel?.({ activeId, input: "keyboard" });
          return;
        }
        if (event.key === " " || event.key === "Enter") {
          event.preventDefault();
          keyboardActiveRef.current = null;
          setState(idleState);
          setAnnouncement(`${latestRef.current.getItemLabel(activeId)} 已放置。`);
          latestRef.current.onReorderEnd?.({ activeId, input: "keyboard" });
          return;
        }

        const currentItems = latestRef.current.items;
        const activeIndex = currentItems.indexOf(activeId);
        if (activeIndex < 0) return;
        let targetIndex = activeIndex;
        if (event.key === "ArrowUp") targetIndex = Math.max(0, activeIndex - 1);
        else if (event.key === "ArrowDown") {
          targetIndex = Math.min(currentItems.length - 1, activeIndex + 1);
        } else if (event.key === "Home") targetIndex = 0;
        else if (event.key === "End") targetIndex = currentItems.length - 1;
        else return;

        event.preventDefault();
        const overId = currentItems[targetIndex];
        if (!overId) return;
        setState({ phase: "keyboard", activeId, overId });
        requestMove(activeId, overId, "keyboard");
      };

      return {
        [ITEM_ATTRIBUTE]: itemId,
        "aria-keyshortcuts": KEYBOARD_SHORTCUTS,
        "aria-pressed": state.activeId === itemId && state.phase !== "pressing",
        tabIndex: disabled ? -1 : 0,
        // Apply these props to a small handle so touch zoom remains available
        // elsewhere in the view while the browser leaves this gesture to us.
        style: { touchAction: "none", userSelect: "none" },
        onPointerDown,
        onPointerMove,
        onPointerUp,
        onPointerCancel: cancelPointer,
        onLostPointerCapture: cancelPointer,
        onClickCapture,
        onKeyDown,
      };
    },
    [clearPointerSession, disabled, requestMove, state, suppressNextClick, targetItemAtPoint],
  );

  useEffect(() => {
    if (!disabled) return;
    clearPointerSession(true);
    const activeId = keyboardActiveRef.current;
    keyboardActiveRef.current = null;
    if (activeId) {
      latestRef.current.onReorderCancel?.({ activeId, input: "keyboard" });
      setState(idleState);
    }
  }, [clearPointerSession, disabled]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const session = pointerSessionRef.current;
      if (session) {
        pointerSessionRef.current = null;
        clearTimeout(session.timer);
        releasePointer(session);
        if (session.phase === "dragging") {
          latestRef.current.onReorderCancel?.({
            activeId: session.activeId,
            input: "pointer",
          });
        }
      }
      const keyboardActive = keyboardActiveRef.current;
      if (keyboardActive) {
        latestRef.current.onReorderCancel?.({
          activeId: keyboardActive,
          input: "keyboard",
        });
      }
      if (clickResetTimerRef.current) clearTimeout(clickResetTimerRef.current);
    };
  }, [releasePointer]);

  return {
    state,
    announcement,
    liveRegionProps: {
      "aria-live": "polite" as const,
      "aria-atomic": true,
      children: announcement,
    },
    getItemProps,
  };
}
