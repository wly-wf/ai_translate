import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let windowLabel = "main";
const invokeMock = vi.hoisted(() => vi.fn());
const startDraggingMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const minimizeMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const onFocusChangedMock = vi.hoisted(() => vi.fn().mockResolvedValue(() => {}));
const cursorPositionMock = vi.hoisted(() => vi.fn().mockResolvedValue({ x: 0, y: 0 }));

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ label: windowLabel }),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ startDragging: startDraggingMock, minimize: minimizeMock, onFocusChanged: onFocusChangedMock }),
  cursorPosition: cursorPositionMock,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));

Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });

import App, { ExpandableText } from "./App";

function mockWindowLabel(label: string) {
  windowLabel = label;
}

describe("App", () => {
  afterEach(cleanup);

  beforeEach(() => {
    mockWindowLabel("main");
    invokeMock.mockReset();
    startDraggingMock.mockClear();
    minimizeMock.mockClear();
    onFocusChangedMock.mockClear();
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

  it("starts dragging only after the title bar is moved", () => {
    render(<App />);

    const titlebar = screen.getByRole("banner");

    fireEvent.mouseDown(titlebar, { button: 0, screenX: 100, screenY: 100 });
    expect(startDraggingMock).not.toHaveBeenCalled();

    fireEvent.mouseMove(window, { screenX: 105, screenY: 100 });
    expect(startDraggingMock).toHaveBeenCalledTimes(1);

    fireEvent.mouseUp(window);
  });

  it("keeps settings out of the title bar", () => {
    render(<App />);

    expect(screen.queryByRole("button", { name: "设置" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "关闭" })).toBeInTheDocument();
  });

  it("minimizes the translation window without hiding its taskbar entry", () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "最小化" }));

    expect(minimizeMock).toHaveBeenCalledTimes(1);
  });

  it("opens the floating translation state by default and keeps quick translation behind its entry", () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: "选中文本开始翻译" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "把文字变成另一种语言" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "快速翻译" }));

    expect(screen.getByText("快速翻译", { exact: true })).toBeInTheDocument();
    expect(screen.queryByText("把文字变成另一种语言")).not.toBeInTheDocument();
    expect(screen.queryByText("直接输入文本即可开始翻译。")).not.toBeInTheDocument();
    expect(screen.queryByText("支持中英文自动识别")).not.toBeInTheDocument();
    expect(screen.queryByText("已接入")).not.toBeInTheDocument();
    expect(screen.getByLabelText("输入文本")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "返回悬浮翻译" }));

    expect(screen.getByRole("heading", { name: "选中文本开始翻译" })).toBeInTheDocument();
    expect(screen.queryByLabelText("输入文本")).not.toBeInTheDocument();
  });

  it("provides a separate settings-window entry point", () => {
    render(<App />);

    expect(screen.getByRole("button", { name: "更多操作" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "厂商接口配置" })).not.toBeInTheDocument();
  });

  it("toggles the translation window pin from the title bar", () => {
    render(<App />);

    const pinButton = screen.getByRole("button", { name: "置顶" });
    expect(pinButton).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(pinButton);

    expect(screen.getByRole("button", { name: "取消置顶" })).toHaveAttribute("aria-pressed", "true");
  });

  it("renders the multi-page settings window", () => {
    mockWindowLabel("settings");
    render(<App />);

    expect(screen.getByRole("heading", { name: "厂商接口配置" })).toBeInTheDocument();
    expect(screen.getAllByText("DeepSeek").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "最小化" }));
    expect(minimizeMock).toHaveBeenCalledTimes(1);
    const apiKeyInput = screen.getByLabelText("API Key");
    expect(apiKeyInput).toHaveAttribute("type", "password");
    fireEvent.click(screen.getByRole("button", { name: "显示 API Key" }));
    expect(apiKeyInput).toHaveAttribute("type", "text");

    fireEvent.click(screen.getByRole("button", { name: /^＋ 添加$/ }));
    expect(screen.getByRole("heading", { name: "添加供应商" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "OpenAI" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("名称")).toHaveValue("OpenAI");
    fireEvent.click(screen.getByRole("tab", { name: "Google" }));
    expect(screen.getByLabelText("Base URL")).toHaveValue("https://generativelanguage.googleapis.com/v1beta");
    fireEvent.click(screen.getAllByRole("button", { name: "关闭添加供应商" })[0]);
    expect(screen.getByRole("heading", { name: "厂商接口配置" })).toBeInTheDocument();

    expect(screen.getAllByRole("button", { name: "测试连接" })).toHaveLength(1);
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

  it("shows an expand arrow when the source is taller than its two-line preview", async () => {
    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const height = this.classList.contains("text-measure") ? 120 : 44;
      return {
        x: 0,
        y: 0,
        width: 420,
        height,
        top: 0,
        right: 420,
        bottom: height,
        left: 0,
        toJSON: () => ({}),
      } as DOMRect;
    });

    try {
      render(<ExpandableText kind="source" text={"这是一段超过两行显示高度的原文内容。".repeat(8)} />);

      const button = await screen.findByRole("button", { name: "展开完整原文" });
      expect(button).toHaveAttribute("aria-expanded", "false");
      fireEvent.click(button);
      expect(button).toHaveAttribute("aria-expanded", "true");
    } finally {
      rectSpy.mockRestore();
    }
  });
});
