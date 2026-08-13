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
  const [items] = useState<readonly ItemId[]>(["alpha", "beta", "gamma"]);
  const reorder = useLongPressReorder({
    items,
    onReorder,
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
    vi.spyOn(alpha, "getBoundingClientRect").mockReturnValue(rect(0));
    vi.spyOn(beta, "getBoundingClientRect").mockReturnValue(rect(50));
    vi.spyOn(gamma, "getBoundingClientRect").mockReturnValue(rect(100));

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
