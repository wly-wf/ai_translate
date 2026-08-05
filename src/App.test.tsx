import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let windowLabel = "main";
const invokeMock = vi.hoisted(() => vi.fn());
const startDraggingMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ label: windowLabel }),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ startDragging: startDraggingMock }),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));

import App from "./App";

function mockWindowLabel(label: string) {
  windowLabel = label;
}

describe("App", () => {
  afterEach(cleanup);

  beforeEach(() => {
    mockWindowLabel("main");
    invokeMock.mockReset();
    startDraggingMock.mockClear();
  });

  it("routes the selection-float window to the translate-selection control", () => {
    mockWindowLabel("selection-float");

    render(<App />);

    const button = screen.getByRole("button", { name: "翻译选中文本" });

    expect(button).toBeInTheDocument();
    expect(button).toHaveClass("selection-float-button");
    expect(button).not.toHaveAttribute("title");
    expect(button.parentElement).not.toHaveClass("selection-float");
    expect(screen.queryByText("快速翻译")).not.toBeInTheDocument();
  });

  it("drags the main window from its title bar without intercepting window actions", () => {
    render(<App />);

    fireEvent.mouseDown(screen.getByRole("banner"));

    expect(startDraggingMock).toHaveBeenCalledTimes(1);
  });

  it("keeps settings out of the title bar", () => {
    render(<App />);

    expect(screen.queryByRole("button", { name: "设置" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "隐藏" })).toBeInTheDocument();
  });

  it("invokes selection translation once while a request is pending", async () => {
    mockWindowLabel("selection-float");
    invokeMock.mockReturnValue(new Promise(() => {}));
    render(<App />);
    const button = screen.getByRole("button", { name: "翻译选中文本" });

    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => expect(button).toBeDisabled());
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("translate_selection_float");
  });

  it("reenables selection translation when the native command reports an error", async () => {
    mockWindowLabel("selection-float");
    invokeMock.mockRejectedValue(new Error("network failed"));
    render(<App />);
    const button = screen.getByRole("button", { name: "翻译选中文本" });

    fireEvent.click(button);

    await waitFor(() => expect(button).toBeEnabled());
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });
});
