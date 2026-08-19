import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import {
  useLongPressReorder,
  type ReorderInteraction,
  type ReorderRequest,
} from "./useLongPressReorder";

type ItemId = "alpha" | "beta" | "gamma";

interface HarnessProps {
  onReorder?: (request: ReorderRequest<ItemId>) => void;
  onStart?: (interaction: ReorderInteraction<ItemId>) => void;
  onEnd?: (interaction: ReorderInteraction<ItemId>) => void;
  onCancel?: (interaction: ReorderInteraction<ItemId>) => void;
  onItemClick?: (itemId: ItemId) => void;
}

function Harness({ onReorder = () => {}, onStart, onEnd, onCancel, onItemClick }: HarnessProps) {
  const [items, setItems] = useState<readonly ItemId[]>(["alpha", "beta", "gamma"]);
  const reorder = useLongPressReorder({
    items,
    onReorder: (request) => {
      setItems((current) => {
        const next = [...current];
        const [moved] = next.splice(request.fromIndex, 1);
        if (moved) next.splice(request.toIndex, 0, moved);
        return next;
      });
      onReorder(request);
    },
    onReorderStart: onStart,
    onReorderEnd: onEnd,
    onReorderCancel: onCancel,
    getItemLabel: (itemId) => `项目 ${itemId}`,
    longPressMs: 180,
    movementTolerance: 10,
  });

  return (
    <>
      <div role="status" {...reorder.liveRegionProps} />
      <span data-testid="phase">{reorder.state.phase}</span>
      <span data-testid="drag-offset">{reorder.state.dragOffsetY}</span>
      <span data-testid="drag-overlay-top">{reorder.state.dragOverlay?.top ?? ""}</span>
      <span data-testid="drag-overlay-left">{reorder.state.dragOverlay?.left ?? ""}</span>
      <span data-testid="drag-overlay-width">{reorder.state.dragOverlay?.width ?? ""}</span>
      <span data-testid="drag-overlay-height">{reorder.state.dragOverlay?.height ?? ""}</span>
      {items.map((itemId) => (
        <button
          key={itemId}
          type="button"
          {...reorder.getItemProps<HTMLButtonElement>(itemId)}
          onClick={() => onItemClick?.(itemId)}
        >
          {itemId}
        </button>
      ))}
    </>
  );
}

describe("useLongPressReorder", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperties(HTMLElement.prototype, {
      setPointerCapture: { configurable: true, value: vi.fn() },
      hasPointerCapture: { configurable: true, value: vi.fn(() => true) },
      releasePointerCapture: { configurable: true, value: vi.fn() },
    });
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => null),
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("activates only after the long-press threshold and reorders over another item", () => {
    const onReorder = vi.fn();
    const onStart = vi.fn();
    render(<Harness onReorder={onReorder} onStart={onStart} />);
    const alpha = screen.getByRole("button", { name: "alpha" });
    const beta = screen.getByRole("button", { name: "beta" });
    vi.mocked(document.elementFromPoint).mockReturnValue(beta);

    fireEvent.pointerDown(alpha, {
      pointerId: 7,
      pointerType: "mouse",
      isPrimary: true,
      button: 0,
      clientX: 10,
      clientY: 10,
    });
    expect(screen.getByTestId("phase").textContent).toBe("pressing");

    act(() => vi.advanceTimersByTime(179));
    expect(onStart).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onStart).toHaveBeenCalledWith({ activeId: "alpha", input: "pointer" });

    fireEvent.pointerMove(alpha, { pointerId: 7, clientX: 20, clientY: 20 });
    expect(onReorder).toHaveBeenCalledWith({
      activeId: "alpha",
      overId: "beta",
      fromIndex: 0,
      toIndex: 1,
      input: "pointer",
    });
  });

  it("keeps a mouse long-press active when the pointer starts moving early", () => {
    const onStart = vi.fn();
    render(<Harness onStart={onStart} />);
    const alpha = screen.getByRole("button", { name: "alpha" });

    fireEvent.pointerDown(alpha, {
      pointerId: 3,
      pointerType: "mouse",
      isPrimary: true,
      button: 0,
      clientX: 10,
      clientY: 10,
    });
    fireEvent.pointerMove(alpha, { pointerId: 3, clientX: 16, clientY: 10 });
    act(() => vi.advanceTimersByTime(180));

    expect(screen.getByTestId("phase").textContent).toBe("dragging");
    expect(onStart).toHaveBeenCalledWith({ activeId: "alpha", input: "pointer" });
  });

  it("still cancels touch long-press intent when the user scrolls", () => {
    const onStart = vi.fn();
    render(<Harness onStart={onStart} />);
    const alpha = screen.getByRole("button", { name: "alpha" });

    fireEvent.pointerDown(alpha, {
      pointerId: 4,
      pointerType: "touch",
      isPrimary: true,
      button: 0,
      clientX: 10,
      clientY: 10,
    });
    fireEvent.pointerMove(alpha, { pointerId: 4, clientX: 10, clientY: 24 });
    act(() => vi.advanceTimersByTime(300));

    expect(screen.getByTestId("phase").textContent).toBe("idle");
    expect(onStart).not.toHaveBeenCalled();
  });

  it("preserves an ordinary click released before the activation delay", () => {
    const onItemClick = vi.fn();
    render(<Harness onItemClick={onItemClick} />);
    const alpha = screen.getByRole("button", { name: "alpha" });

    fireEvent.pointerDown(alpha, {
      pointerId: 5,
      pointerType: "mouse",
      isPrimary: true,
      button: 0,
      clientX: 10,
      clientY: 10,
    });
    act(() => vi.advanceTimersByTime(100));
    fireEvent.pointerUp(alpha, { pointerId: 5, clientX: 10, clientY: 10 });
    fireEvent.click(alpha);

    expect(screen.getByTestId("phase").textContent).toBe("idle");
    expect(onItemClick).toHaveBeenCalledWith("alpha");
  });

  it("moves downward by list-row geometry even between elements", () => {
    const onReorder = vi.fn();
    render(<Harness onReorder={onReorder} />);
    const alpha = screen.getByRole("button", { name: "alpha" });
    const beta = screen.getByRole("button", { name: "beta" });
    const gamma = screen.getByRole("button", { name: "gamma" });
    const rect = (top: number) => ({
      top,
      bottom: top + 40,
      left: 0,
      right: 200,
      width: 200,
      height: 40,
      x: 0,
      y: top,
      toJSON: () => ({}),
    } as DOMRect);
    const itemTop = (element: HTMLElement) => Array.from(
      document.querySelectorAll<HTMLElement>("[data-long-press-reorder-item]"),
    ).indexOf(element) * 50;
    vi.spyOn(alpha, "getBoundingClientRect").mockImplementation(() => rect(itemTop(alpha)));
    vi.spyOn(beta, "getBoundingClientRect").mockImplementation(() => rect(itemTop(beta)));
    vi.spyOn(gamma, "getBoundingClientRect").mockImplementation(() => rect(itemTop(gamma)));

    fireEvent.pointerDown(alpha, {
      pointerId: 9,
      pointerType: "mouse",
      isPrimary: true,
      button: 0,
      clientX: 20,
      clientY: 20,
    });
    act(() => vi.advanceTimersByTime(180));
    fireEvent.pointerMove(alpha, { pointerId: 9, clientX: 20, clientY: 118 });

    expect(onReorder).toHaveBeenCalledWith({
      activeId: "alpha",
      overId: "gamma",
      fromIndex: 0,
      toIndex: 2,
      input: "pointer",
    });
  });

  it("keeps the drag overlay inside the first and last list rows", () => {
    const onReorder = vi.fn();
    render(<Harness onReorder={onReorder} />);
    const alpha = screen.getByRole("button", { name: "alpha" });
    const beta = screen.getByRole("button", { name: "beta" });
    const gamma = screen.getByRole("button", { name: "gamma" });
    const rect = (top: number) => ({
      top,
      bottom: top + 40,
      left: 0,
      right: 200,
      width: 200,
      height: 40,
      x: 0,
      y: top,
      toJSON: () => ({}),
    } as DOMRect);
    const itemTop = (element: HTMLElement) => Array.from(
      document.querySelectorAll<HTMLElement>("[data-long-press-reorder-item]"),
    ).indexOf(element) * 50;
    vi.spyOn(alpha, "getBoundingClientRect").mockImplementation(() => rect(itemTop(alpha)));
    vi.spyOn(beta, "getBoundingClientRect").mockImplementation(() => rect(itemTop(beta)));
    vi.spyOn(gamma, "getBoundingClientRect").mockImplementation(() => rect(itemTop(gamma)));

    fireEvent.pointerDown(alpha, {
      pointerId: 12,
      pointerType: "mouse",
      isPrimary: true,
      button: 0,
      clientX: 20,
      clientY: 20,
    });
    act(() => vi.advanceTimersByTime(180));
    fireEvent.pointerMove(alpha, { pointerId: 12, clientX: 20, clientY: 2_000 });
    expect(screen.getByTestId("drag-overlay-top").textContent).toBe("100");

    fireEvent.pointerMove(alpha, { pointerId: 12, clientX: 20, clientY: 3_000 });
    expect(screen.getByTestId("drag-overlay-top").textContent).toBe("100");
    expect(onReorder).toHaveBeenCalledTimes(1);

    fireEvent.pointerUp(alpha, { pointerId: 12, clientX: 20, clientY: 3_000 });
    fireEvent.pointerDown(alpha, {
      pointerId: 13,
      pointerType: "mouse",
      isPrimary: true,
      button: 0,
      clientX: 20,
      clientY: 120,
    });
    act(() => vi.advanceTimersByTime(180));
    fireEvent.pointerMove(alpha, { pointerId: 13, clientX: 20, clientY: -2_000 });
    expect(screen.getByTestId("drag-overlay-top").textContent).toBe("0");
  });

  it("keeps the dragged row at the same screen position while crossing a slot", () => {
    render(<Harness />);
    const alpha = screen.getByRole("button", { name: "alpha" });
    const beta = screen.getByRole("button", { name: "beta" });
    const gamma = screen.getByRole("button", { name: "gamma" });
    const rect = (top: number) => ({
      top,
      bottom: top + 40,
      left: 0,
      right: 200,
      width: 200,
      height: 40,
      x: 0,
      y: top,
      toJSON: () => ({}),
    } as DOMRect);
    const itemTop = (element: HTMLElement) => Array.from(
      document.querySelectorAll<HTMLElement>("[data-long-press-reorder-item]"),
    ).indexOf(element) * 50;
    vi.spyOn(alpha, "getBoundingClientRect").mockImplementation(() => rect(itemTop(alpha)));
    vi.spyOn(beta, "getBoundingClientRect").mockImplementation(() => rect(itemTop(beta)));
    vi.spyOn(gamma, "getBoundingClientRect").mockImplementation(() => rect(itemTop(gamma)));

    fireEvent.pointerDown(alpha, {
      pointerId: 11,
      pointerType: "mouse",
      isPrimary: true,
      button: 0,
      clientX: 20,
      clientY: 20,
    });
    act(() => vi.advanceTimersByTime(180));
    fireEvent.pointerMove(alpha, { pointerId: 11, clientX: 20, clientY: 60 });

    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "beta", "alpha", "gamma",
    ]);
    expect(screen.getByTestId("drag-offset").textContent).toBe("-10");
    expect(screen.getByTestId("drag-overlay-top").textContent).toBe("40");
    expect(screen.getByTestId("drag-overlay-left").textContent).toBe("0");
    expect(screen.getByTestId("drag-overlay-width").textContent).toBe("200");
    expect(screen.getByTestId("drag-overlay-height").textContent).toBe("40");
  });

  it("continues moving downward after React reorders the captured item", () => {
    render(<Harness />);
    const alpha = screen.getByRole("button", { name: "alpha" });
    const beta = screen.getByRole("button", { name: "beta" });
    const gamma = screen.getByRole("button", { name: "gamma" });

    fireEvent.pointerDown(alpha, {
      pointerId: 10,
      pointerType: "mouse",
      isPrimary: true,
      button: 0,
      clientX: 20,
      clientY: 20,
    });
    act(() => vi.advanceTimersByTime(180));

    vi.mocked(document.elementFromPoint).mockReturnValue(beta);
    fireEvent.pointerMove(alpha, { pointerId: 10, clientX: 20, clientY: 70 });
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "beta", "alpha", "gamma",
    ]);

    fireEvent.lostPointerCapture(alpha, { pointerId: 10 });
    vi.mocked(document.elementFromPoint).mockReturnValue(gamma);
    fireEvent.pointerMove(window, { pointerId: 10, clientX: 20, clientY: 120 });

    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "beta", "gamma", "alpha",
    ]);
    expect(screen.getByTestId("drag-offset").textContent).toBe("100");
  });

  it("suppresses the synthetic click after a completed pointer drag", () => {
    const onEnd = vi.fn();
    const onItemClick = vi.fn();
    render(<Harness onEnd={onEnd} onItemClick={onItemClick} />);
    const alpha = screen.getByRole("button", { name: "alpha" });

    fireEvent.pointerDown(alpha, {
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
      button: 0,
      clientX: 10,
      clientY: 10,
    });
    act(() => vi.advanceTimersByTime(180));
    fireEvent.pointerUp(alpha, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.click(alpha);

    expect(onEnd).toHaveBeenCalledWith({ activeId: "alpha", input: "pointer" });
    expect(onItemClick).not.toHaveBeenCalled();
  });

  it("cleans up and reports pointer cancellation", () => {
    const onCancel = vi.fn();
    render(<Harness onCancel={onCancel} />);
    const alpha = screen.getByRole("button", { name: "alpha" });

    fireEvent.pointerDown(alpha, {
      pointerId: 8,
      pointerType: "mouse",
      isPrimary: true,
      button: 0,
      clientX: 10,
      clientY: 10,
    });
    act(() => vi.advanceTimersByTime(180));
    fireEvent.pointerCancel(alpha, { pointerId: 8 });

    expect(onCancel).toHaveBeenCalledWith({ activeId: "alpha", input: "pointer" });
    expect(screen.getByTestId("phase").textContent).toBe("idle");
  });

  it("offers grab, arrow movement, drop, and cancellation from the keyboard", () => {
    const onReorder = vi.fn();
    const onEnd = vi.fn();
    const onCancel = vi.fn();
    render(<Harness onReorder={onReorder} onEnd={onEnd} onCancel={onCancel} />);
    const beta = screen.getByRole("button", { name: "beta" });

    fireEvent.keyDown(beta, { key: " " });
    fireEvent.keyDown(beta, { key: "ArrowDown" });
    expect(onReorder).toHaveBeenCalledWith({
      activeId: "beta",
      overId: "gamma",
      fromIndex: 1,
      toIndex: 2,
      input: "keyboard",
    });
    expect(screen.getByRole("status").textContent).toContain("项目 beta 已移动到第 3 项");

    fireEvent.keyDown(beta, { key: "Enter" });
    expect(onEnd).toHaveBeenCalledWith({ activeId: "beta", input: "keyboard" });

    fireEvent.keyDown(beta, { key: " " });
    fireEvent.keyDown(beta, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledWith({ activeId: "beta", input: "keyboard" });
  });
});
