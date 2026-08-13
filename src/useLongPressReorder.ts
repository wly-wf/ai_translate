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
  dragOffsetY: number;
  dragOverlay: {
    top: number;
    left: number;
    width: number;
    height: number;
  } | null;
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
  pointerType: string;
  activeId: ItemId;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  element: HTMLElement;
  phase: "pressing" | "dragging";
  timer: ReturnType<typeof setTimeout>;
  lastOverId: ItemId | null;
  grabOffsetY: number;
  dragOffsetY: number;
  overlayLeft: number;
  overlayWidth: number;
  overlayHeight: number;
  cleanupWindowListeners: () => void;
}

const ITEM_ATTRIBUTE = "data-long-press-reorder-item";
const KEYBOARD_SHORTCUTS = "Space Enter ArrowUp ArrowDown Home End Escape";
const DEFAULT_LONG_PRESS_MS = 180;
const DEFAULT_MOVEMENT_TOLERANCE = 10;

const idleState = <ItemId extends string>(): LongPressReorderState<ItemId> => ({
  phase: "idle",
  activeId: null,
  overId: null,
  dragOffsetY: 0,
  dragOverlay: null,
});

function elementLayoutTop(element: HTMLElement) {
  const visualRect = element.getBoundingClientRect();
  if (element.offsetHeight <= 0) return visualRect.top;

  let top = 0;
  let current: HTMLElement | null = element;
  while (current) {
    top += current.offsetTop;
    current = current.offsetParent as HTMLElement | null;
  }
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    top -= parent.scrollTop;
  }
  return top - window.scrollY;
}

function reorderItemElement(itemId: string) {
  return Array.from(
    document.querySelectorAll<HTMLElement>(`[${ITEM_ATTRIBUTE}]`),
  ).find((element) => element.getAttribute(ITEM_ATTRIBUTE) === itemId) ?? null;
}

/**
 * Adds long-press pointer sorting and an equivalent keyboard interaction to an
 * interactive list item. Spread `getItemProps(id)` onto the item's primary
 * button so an ordinary click is preserved until the long-press activates.
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
  const handledWindowPointerEventsRef = useRef(new WeakSet<Event>());
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
      session.cleanupWindowListeners();
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
    const orderedItems = latestRef.current.items;
    const candidates = Array.from(
      document.querySelectorAll<HTMLElement>(`[${ITEM_ATTRIBUTE}]`),
    ).map((element) => {
      const visualRect = element.getBoundingClientRect();
      return {
        id: element.getAttribute(ITEM_ATTRIBUTE) as ItemId | null,
        rect: {
          top: elementLayoutTop(element),
          left: visualRect.left,
          right: visualRect.right,
          width: visualRect.width,
          height: element.offsetHeight || visualRect.height,
        },
      };
    }).filter((candidate): candidate is {
      id: ItemId;
      rect: { top: number; left: number; right: number; width: number; height: number };
    } => (
      Boolean(candidate.id)
      && orderedItems.includes(candidate.id as ItemId)
      && candidate.rect.height > 0
      && candidate.rect.width > 0
    )).sort((left, right) => left.rect.top - right.rect.top);

    if (candidates.length) {
      const left = Math.min(...candidates.map((candidate) => candidate.rect.left));
      const right = Math.max(...candidates.map((candidate) => candidate.rect.right));
      if (clientX >= left - 48 && clientX <= right + 48) {
        return candidates.reduce((closest, candidate) => {
          const closestDistance = Math.abs(clientY - (closest.rect.top + closest.rect.height / 2));
          const candidateDistance = Math.abs(clientY - (candidate.rect.top + candidate.rect.height / 2));
          return candidateDistance < closestDistance ? candidate : closest;
        }).id;
      }
    }

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

  const updateDragOffset = useCallback((session: PointerSession<ItemId>) => {
    if (pointerSessionRef.current !== session || session.phase !== "dragging") return;
    const dragOffsetY = session.currentY - session.grabOffsetY - elementLayoutTop(session.element);
    const dragOverlay = {
      top: session.currentY - session.grabOffsetY,
      left: session.overlayLeft,
      width: session.overlayWidth,
      height: session.overlayHeight,
    };
    session.dragOffsetY = dragOffsetY;
    setState((current) => current.phase === "dragging" && current.activeId === session.activeId
      ? { ...current, dragOffsetY, dragOverlay }
      : current);
  }, []);

  const dragOffsetForTarget = useCallback((session: PointerSession<ItemId>, targetId: ItemId) => {
    const target = reorderItemElement(targetId);
    return target
      ? session.currentY - session.grabOffsetY - elementLayoutTop(target)
      : session.dragOffsetY;
  }, []);

  const movePointerSession = useCallback((
    pointerId: number,
    clientX: number,
    clientY: number,
    preventDefault: () => void,
  ) => {
    const session = pointerSessionRef.current;
    if (!session || session.pointerId !== pointerId) return;
    session.currentX = clientX;
    session.currentY = clientY;

    if (session.phase === "pressing") {
      const deltaX = clientX - session.startX;
      const deltaY = clientY - session.startY;
      const tolerance = Math.max(0, latestRef.current.movementTolerance);
      // A mouse user naturally starts moving just before the long-press
      // timer fires. Keep that intent alive; touch/pen still cancel so a
      // vertical gesture remains available to the surrounding scroller.
      if (
        session.pointerType !== "mouse"
        && deltaX * deltaX + deltaY * deltaY > tolerance * tolerance
      ) {
        clearPointerSession(false);
      }
      return;
    }

    preventDefault();
    updateDragOffset(session);
    const overId = targetItemAtPoint(clientX, clientY);
    if (!overId || overId === session.lastOverId) return;
    session.lastOverId = overId;
    const nextDragOffsetY = overId === session.activeId
      ? session.dragOffsetY
      : dragOffsetForTarget(session, overId);
    const moved = requestMove(session.activeId, overId, "pointer");
    if (moved) session.dragOffsetY = nextDragOffsetY;
    setState(() => ({
      phase: "dragging",
      activeId: session.activeId,
      overId,
      dragOffsetY: session.dragOffsetY,
      dragOverlay: {
        top: session.currentY - session.grabOffsetY,
        left: session.overlayLeft,
        width: session.overlayWidth,
        height: session.overlayHeight,
      },
    }));
  }, [
    clearPointerSession,
    dragOffsetForTarget,
    requestMove,
    targetItemAtPoint,
    updateDragOffset,
  ]);

  const finishPointerSession = useCallback((pointerId: number, preventDefault: () => void) => {
    const session = pointerSessionRef.current;
    if (!session || session.pointerId !== pointerId) return;

    const wasDragging = session.phase === "dragging";
    const activeId = session.activeId;
    if (wasDragging) {
      preventDefault();
      suppressNextClick(activeId);
    }
    clearPointerSession(false);
    if (wasDragging) {
      latestRef.current.onReorderEnd?.({ activeId, input: "pointer" });
      setAnnouncement(`${latestRef.current.getItemLabel(activeId)} 已放置。`);
    }
  }, [clearPointerSession, suppressNextClick]);

  const cancelPointerSession = useCallback((pointerId: number) => {
    const session = pointerSessionRef.current;
    if (session?.pointerId === pointerId) clearPointerSession(true);
  }, [clearPointerSession]);

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

        const elementRect = element.getBoundingClientRect();
        const session: PointerSession<ItemId> = {
          pointerId: event.pointerId,
          pointerType: event.pointerType,
          activeId: itemId,
          startX: event.clientX,
          startY: event.clientY,
          currentX: event.clientX,
          currentY: event.clientY,
          element,
          phase: "pressing",
          timer: 0 as unknown as ReturnType<typeof setTimeout>,
          lastOverId: itemId,
          grabOffsetY: event.clientY - elementRect.top,
          dragOffsetY: 0,
          overlayLeft: elementRect.left,
          overlayWidth: elementRect.width,
          overlayHeight: elementRect.height,
          cleanupWindowListeners: () => {},
        };
        const handleWindowPointerMove = (windowEvent: globalThis.PointerEvent) => {
          handledWindowPointerEventsRef.current.add(windowEvent);
          movePointerSession(
            windowEvent.pointerId,
            windowEvent.clientX,
            windowEvent.clientY,
            () => windowEvent.preventDefault(),
          );
        };
        const handleWindowPointerUp = (windowEvent: globalThis.PointerEvent) => {
          handledWindowPointerEventsRef.current.add(windowEvent);
          finishPointerSession(windowEvent.pointerId, () => windowEvent.preventDefault());
        };
        const handleWindowPointerCancel = (windowEvent: globalThis.PointerEvent) => {
          handledWindowPointerEventsRef.current.add(windowEvent);
          cancelPointerSession(windowEvent.pointerId);
        };
        window.addEventListener("pointermove", handleWindowPointerMove, true);
        window.addEventListener("pointerup", handleWindowPointerUp, true);
        window.addEventListener("pointercancel", handleWindowPointerCancel, true);
        session.cleanupWindowListeners = () => {
          window.removeEventListener("pointermove", handleWindowPointerMove, true);
          window.removeEventListener("pointerup", handleWindowPointerUp, true);
          window.removeEventListener("pointercancel", handleWindowPointerCancel, true);
        };
        session.timer = setTimeout(() => {
          if (pointerSessionRef.current !== session || latestRef.current.disabled) return;
          session.phase = "dragging";
          const overId = targetItemAtPoint(session.currentX, session.currentY) ?? itemId;
          session.lastOverId = overId;
          updateDragOffset(session);
          setAnnouncement(
            `${latestRef.current.getItemLabel(itemId)} 已抓取。使用指针拖动，松开以放置。`,
          );
          latestRef.current.onReorderStart?.({ activeId: itemId, input: "pointer" });
          const nextDragOffsetY = overId !== itemId
            ? dragOffsetForTarget(session, overId)
            : session.dragOffsetY;
          const moved = overId !== itemId && requestMove(itemId, overId, "pointer");
          if (moved) {
            session.dragOffsetY = nextDragOffsetY;
          }
          setState({
            phase: "dragging",
            activeId: itemId,
            overId,
            dragOffsetY: session.dragOffsetY,
            dragOverlay: {
              top: session.currentY - session.grabOffsetY,
              left: session.overlayLeft,
              width: session.overlayWidth,
              height: session.overlayHeight,
            },
          });
        }, Math.max(0, latestRef.current.longPressMs));
        pointerSessionRef.current = session;
        setState({ phase: "pressing", activeId: itemId, overId: itemId, dragOffsetY: 0, dragOverlay: null });
      };

      const onPointerMove: PointerEventHandler<ElementType> = (event) => {
        if (handledWindowPointerEventsRef.current.has(event.nativeEvent)) return;
        movePointerSession(event.pointerId, event.clientX, event.clientY, () => event.preventDefault());
      };

      const onPointerUp: PointerEventHandler<ElementType> = (event) => {
        if (handledWindowPointerEventsRef.current.has(event.nativeEvent)) return;
        finishPointerSession(event.pointerId, () => event.preventDefault());
      };

      const cancelPointer: PointerEventHandler<ElementType> = (event) => {
        if (handledWindowPointerEventsRef.current.has(event.nativeEvent)) return;
        cancelPointerSession(event.pointerId);
      };

      // A keyed React list can temporarily release capture when the active
      // element is moved downward in the DOM. Window listeners keep the same
      // pointer session alive until pointerup/pointercancel completes it.
      const onLostPointerCapture: PointerEventHandler<ElementType> = (event) => {
        const session = pointerSessionRef.current;
        if (session?.pointerId === event.pointerId && session.phase === "pressing") {
          cancelPointerSession(event.pointerId);
        }
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
          setState({ phase: "keyboard", activeId: itemId, overId: itemId, dragOffsetY: 0, dragOverlay: null });
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
        setState({ phase: "keyboard", activeId, overId, dragOffsetY: 0, dragOverlay: null });
        requestMove(activeId, overId, "keyboard");
      };

      return {
        [ITEM_ATTRIBUTE]: itemId,
        "aria-keyshortcuts": KEYBOARD_SHORTCUTS,
        "aria-pressed": state.activeId === itemId && state.phase !== "pressing",
        tabIndex: disabled ? -1 : 0,
        // Keep the pending long-press in the Pointer Events stream until the
        // user either releases for a normal click or starts reordering.
        style: { touchAction: "none", userSelect: "none" },
        onPointerDown,
        onPointerMove,
        onPointerUp,
        onPointerCancel: cancelPointer,
        onLostPointerCapture,
        onClickCapture,
        onKeyDown,
      };
    },
    [
      cancelPointerSession,
      disabled,
      dragOffsetForTarget,
      finishPointerSession,
      movePointerSession,
      requestMove,
      state,
      targetItemAtPoint,
      updateDragOffset,
    ],
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
        session.cleanupWindowListeners();
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
