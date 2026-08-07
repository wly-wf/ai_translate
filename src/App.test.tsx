import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let windowLabel = "main";
const invokeMock = vi.hoisted(() => vi.fn());
const startDraggingMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const onFocusChangedMock = vi.hoisted(() => vi.fn().mockResolvedValue(() => {}));
const cursorPositionMock = vi.hoisted(() => vi.fn().mockResolvedValue({ x: 0, y: 0 }));

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ label: windowLabel }),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ startDragging: startDraggingMock, onFocusChanged: onFocusChangedMock }),
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
    invokeMock.mockReset().mockResolvedValue(undefined);
    startDraggingMock.mockClear();
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

    expect(invokeMock).toHaveBeenCalledWith("minimize_window", undefined);
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
    expect(document.querySelector(".content")).toHaveClass("quick-content");

    fireEvent.click(screen.getByRole("button", { name: "返回悬浮翻译" }));

    expect(screen.getByRole("heading", { name: "选中文本开始翻译" })).toBeInTheDocument();
    expect(screen.queryByLabelText("输入文本")).not.toBeInTheDocument();
    expect(document.querySelector(".content")).not.toHaveClass("quick-content");
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
    const xiaomiButton = screen.getByRole("button", { name: /Xiaomi MiMo/ });
    const bailianButton = screen.getByRole("button", { name: /阿里云百炼/ });
    const zhipuButton = screen.getByRole("button", { name: /智谱开放平台/ });
    expect(screen.getByRole("button", { name: /Moonshot/ })).toBeInTheDocument();
    expect(xiaomiButton.querySelector(".provider-mimo-mark .provider-brand-image")).not.toBeNull();
    expect(bailianButton.querySelector(".provider-bailian-mark .provider-brand-image")).not.toBeNull();
    expect(zhipuButton.querySelector(".provider-zhipu-mark .provider-brand-image")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "最小化" }));
    expect(invokeMock).toHaveBeenCalledWith("minimize_window", undefined);
    const apiKeyInput = screen.getByLabelText("API Key");
    expect(apiKeyInput).toHaveAttribute("type", "password");
    fireEvent.click(screen.getByRole("button", { name: "显示 API Key" }));
    expect(apiKeyInput).toHaveAttribute("type", "text");
    expect(screen.queryByLabelText("模型名称")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "添加模型" }));
    expect(screen.getByLabelText("模型名称")).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "移除模型" }));
    expect(screen.queryByLabelText("模型名称")).not.toBeInTheDocument();

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

  it("uses green and gray dots for enabled provider status", async () => {
    mockWindowLabel("settings");
    invokeMock.mockImplementation((command: string) => {
      if (command === "get_enabled_providers") return Promise.resolve(["deepseek", "xiaomi"]);
      return Promise.resolve(undefined);
    });
    const { container } = render(<App />);

    await waitFor(() => expect(container.querySelectorAll(".provider-list-status-dot.is-enabled")).toHaveLength(2));
    expect(container.querySelectorAll(".provider-list-status-dot:not(.is-enabled)")).toHaveLength(3);
    expect(screen.queryByText("翻译中")).not.toBeInTheDocument();
    expect(screen.queryByText("未配置")).not.toBeInTheDocument();
  });

  it("adds another provider to the enabled translation models", async () => {
    mockWindowLabel("settings");
    invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === "get_enabled_providers") return Promise.resolve(["deepseek"]);
      if (command === "get_provider_config" && args?.provider === "deepseek") {
        return Promise.resolve({ apiKey: "saved", baseUrl: "https://api.deepseek.com", model: "deepseek-v4-flash" });
      }
      if (command === "set_provider_enabled") return Promise.resolve(["deepseek", "xiaomi"]);
      return Promise.resolve(undefined);
    });
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: /Xiaomi MiMo/ }));
    fireEvent.change(screen.getByLabelText("API Key"), { target: { value: "mimo-key" } });
    fireEvent.click(screen.getByRole("button", { name: "添加模型" }));
    fireEvent.change(screen.getByLabelText("模型名称"), { target: { value: "mimo-v2.5-pro" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "启用此翻译模型" }));

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("set_provider_enabled", { provider: "xiaomi", enabled: true }));
    expect(invokeMock).toHaveBeenCalledWith("save_provider_config", {
      provider: "xiaomi",
      apiKey: "mimo-key",
      baseUrl: "https://api.xiaomimimo.com/v1",
      model: "mimo-v2.5-pro",
    });
    expect(screen.queryByText(/与其他启用模型同时返回结果/)).not.toBeInTheDocument();
    expect(screen.queryByText(/已加入翻译/)).not.toBeInTheDocument();
  });

  it("fetches provider models and selects one from the returned list", async () => {
    mockWindowLabel("settings");
    invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === "get_enabled_providers") return Promise.resolve(["deepseek"]);
      if (command === "get_provider_config" && args?.provider === "deepseek") {
        return Promise.resolve({ apiKey: "saved-key", baseUrl: "https://api.deepseek.com", model: "deepseek-v4-flash" });
      }
      if (command === "fetch_provider_models") return Promise.resolve(["deepseek-chat", "deepseek-reasoner"]);
      return Promise.resolve(undefined);
    });
    render(<App />);

    await waitFor(() => expect(screen.getByLabelText("API Key")).toHaveValue("saved-key"));
    fireEvent.click(screen.getByRole("button", { name: "获取" }));

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("fetch_provider_models", {
      provider: "deepseek",
      apiKey: "saved-key",
      baseUrl: "https://api.deepseek.com",
    }));
    const modelOption = await screen.findByRole("option", { name: "deepseek-chat" });
    fireEvent.click(modelOption);
    expect(screen.getByLabelText("模型名称")).toHaveValue("deepseek-chat");
    expect(screen.queryByText(/已获取.*模型/)).not.toBeInTheDocument();
  });

  it("shows model fetch errors beside the fetch button", async () => {
    mockWindowLabel("settings");
    invokeMock.mockImplementation((command: string) => {
      if (command === "get_enabled_providers") return Promise.resolve([]);
      if (command === "get_provider_config") return Promise.resolve(null);
      if (command === "fetch_provider_models") return Promise.reject("请先保存 qwen 的 API Key。");
      return Promise.resolve(undefined);
    });
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: /阿里云百炼/ }));
    fireEvent.click(screen.getByRole("button", { name: "获取" }));

    const message = await screen.findByRole("status");
    const fetchButton = screen.getByRole("button", { name: "获取" });
    expect(message).toHaveClass("model-fetch-message");
    expect(message).toHaveTextContent("请先保存 阿里云百炼 的 API Key。");
    expect(message.closest(".model-toolbar")).not.toBeNull();
    expect(message.compareDocumentPosition(fetchButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows connection latency beside the test button", async () => {
    mockWindowLabel("settings");
    invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === "get_enabled_providers") return Promise.resolve(["deepseek"]);
      if (command === "get_provider_config" && args?.provider === "deepseek") {
        return Promise.resolve({ apiKey: "saved-key", baseUrl: "https://api.deepseek.com", model: "deepseek-chat" });
      }
      if (command === "test_provider_connection") {
        return Promise.resolve({ latencyMs: 42, message: "连接成功" });
      }
      return Promise.resolve(undefined);
    });
    render(<App />);

    await waitFor(() => expect(screen.getByLabelText("API Key")).toHaveValue("saved-key"));
    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));

    const status = await screen.findByText("连接成功 · 42 ms");
    expect(status).toHaveClass("connection-inline-result", "success");
    expect(status.closest(".settings-label-row")).not.toBeNull();
    expect(document.querySelector(".provider-detail-panel > .connection-result")).toBeNull();
  });

  it("uses the model selected from the quick translation picker", async () => {
    invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === "get_enabled_providers") return Promise.resolve(["deepseek", "xiaomi"]);
      if (command === "get_preferences") return Promise.resolve({ autoSelection: true, keepOnTop: false, quickTranslateProvider: "deepseek" });
      if (command === "get_provider_config") {
        return Promise.resolve(args?.provider === "xiaomi"
          ? { apiKey: "saved", baseUrl: "https://api.xiaomimimo.com/v1", model: "mimo-v2.5-pro" }
          : { apiKey: "saved", baseUrl: "https://api.deepseek.com", model: "deepseek-v4-flash" });
      }
      if (command === "translate_text") return Promise.resolve({
        source: "hello",
        requestId: 7,
        results: [
          { providerId: "xiaomi", model: "mimo-v2.5-pro", translation: "您好" },
        ],
      });
      return Promise.resolve(undefined);
    });
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "快速翻译" }));
    const modelPicker = screen.getByRole("button", { name: "选择翻译模型" });
    await waitFor(() => expect(modelPicker).toHaveTextContent("deepseek-v4-flash"));
    fireEvent.click(modelPicker);
    fireEvent.click(await screen.findByRole("option", { name: /mimo-v2.5-pro.*Xiaomi MiMo/ }));
    expect(screen.queryByText("设为默认快速翻译模型")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("输入文本"), { target: { value: "hello" } });
    expect(screen.getByLabelText("输入文本")).toHaveClass("is-mixed-language");
    fireEvent.click(screen.getByRole("button", { name: "翻译" }));

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("translate_text", { text: "hello", provider: "xiaomi" }));
    expect(screen.getByText("mimo-v2.5-pro/Xiaomi MiMo")).toBeInTheDocument();
    expect(screen.getAllByText("您好")[0]).toBeInTheDocument();
  });

  it("sets the default quick translation model from general settings", async () => {
    mockWindowLabel("settings");
    invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === "get_enabled_providers") return Promise.resolve(["deepseek", "xiaomi"]);
      if (command === "get_preferences") return Promise.resolve({ autoSelection: true, keepOnTop: false, quickTranslateProvider: "deepseek" });
      if (command === "get_provider_config") {
        return Promise.resolve(args?.provider === "xiaomi"
          ? { apiKey: "saved", baseUrl: "https://api.xiaomimimo.com/v1", model: "mimo-v2.5-pro" }
          : { apiKey: "saved", baseUrl: "https://api.deepseek.com", model: "deepseek-v4-flash" });
      }
      return Promise.resolve(undefined);
    });
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "通用设置" }));
    const defaultPicker = screen.getByRole("button", { name: "设置默认快速翻译模型" });
    await waitFor(() => expect(defaultPicker).toHaveTextContent("deepseek-v4-flash"));
    fireEvent.click(defaultPicker);
    fireEvent.click(await screen.findByRole("option", { name: /mimo-v2.5-pro.*Xiaomi MiMo/ }));

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("save_preferences", {
      autoSelection: true,
      keepOnTop: false,
      quickTranslateProvider: "xiaomi",
    }));
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
