import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let windowLabel = "main";
const invokeMock = vi.hoisted(() => vi.fn());
const startDraggingMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const onFocusChangedMock = vi.hoisted(() => vi.fn().mockResolvedValue(() => {}));
const cursorPositionMock = vi.hoisted(() => vi.fn().mockResolvedValue({ x: 0, y: 0 }));
const listenMock = vi.hoisted(() => vi.fn().mockResolvedValue(() => {}));

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ label: windowLabel }),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ startDragging: startDraggingMock, onFocusChanged: onFocusChangedMock }),
  cursorPosition: cursorPositionMock,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));

Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });

import App, { ExpandableText } from "./App";

function mockWindowLabel(label: string) {
  windowLabel = label;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("App", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    mockWindowLabel("main");
    window.localStorage.removeItem("ai-translate-appearance");
    delete document.documentElement.dataset.theme;
    delete document.documentElement.dataset.themeMode;
    document.documentElement.style.removeProperty("--source-font-size");
    document.documentElement.style.removeProperty("--translation-font-size");
    invokeMock.mockReset().mockResolvedValue(undefined);
    startDraggingMock.mockClear();
    onFocusChangedMock.mockClear();
    listenMock.mockClear();
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

  it("restarts the selection-float entrance animation for every native show event", () => {
    mockWindowLabel("selection-float");
    render(<App />);

    const initialButton = screen.getByRole("button", { name: "翻译选中文本" });
    expect(initialButton).toHaveClass("is-visible");
    const showHandler = listenMock.mock.calls.find(([eventName]) => eventName === "selection-float:show")?.[1];
    expect(showHandler).toBeTypeOf("function");

    act(() => showHandler({ payload: { generation: 1 } }));
    const firstAnimatedButton = screen.getByRole("button", { name: "翻译选中文本" });
    expect(firstAnimatedButton).toHaveClass("is-visible");
    expect(firstAnimatedButton).not.toBe(initialButton);

    act(() => showHandler({ payload: { generation: 2 } }));
    expect(screen.getByRole("button", { name: "翻译选中文本" })).not.toBe(firstAnimatedButton);
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

    expect(screen.getByRole("heading", { name: "选中文本即可翻译" })).toBeInTheDocument();
    expect(screen.getByText("点击选区旁的悬浮按钮开始翻译")).toBeInTheDocument();
    expect(screen.queryByText("悬浮翻译", { exact: true })).not.toBeInTheDocument();
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

    expect(screen.getByRole("heading", { name: "选中文本即可翻译" })).toBeInTheDocument();
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
    const settingsNav = screen.getByRole("navigation", { name: "设置分类" });
    expect(within(settingsNav.parentElement as HTMLElement).queryByRole("heading", { name: "设置" })).not.toBeInTheDocument();
    expect(within(settingsNav).getAllByRole("button").map((button) => button.textContent)).toEqual([
      "偏好设置", "供应商", "网络代理", "关于",
    ]);
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
    expect(screen.queryByText("API Key（可选）")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "显示 API Key" }));
    expect(apiKeyInput).toHaveAttribute("type", "text");
    expect(screen.queryByLabelText("模型名称")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "添加模型" }));
    expect(screen.getByLabelText("模型名称")).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "移除模型" }));
    expect(screen.queryByLabelText("模型名称")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "＋ 添加自定义供应商" }));
    expect(invokeMock).toHaveBeenCalledWith("open_add_provider_window", undefined);
    expect(screen.getByRole("heading", { name: "厂商接口配置" })).toBeInTheDocument();

    expect(screen.getAllByRole("button", { name: "测试连接" })).toHaveLength(1);
  });

  it("renders the about page information and project links", () => {
    mockWindowLabel("settings");
    const { container } = render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "关于" }));

    const brand = container.querySelector(".about-brand");
    expect(brand).toHaveTextContent("AI Translate");
    expect(screen.getByRole("heading", { level: 1, name: "AI Translate" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "软件介绍" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "版本与更新" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "开源与反馈" })).not.toBeInTheDocument();
    expect(screen.getByText(/v0\.1\.0/)).toBeInTheDocument();
    expect(screen.queryByText("Windows")).not.toBeInTheDocument();
    expect(screen.getByText("GitHub 开源仓库")).toBeInTheDocument();
    expect(screen.getByText("GitHub Issues")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "暂不可用" })).toBeDisabled();
    const repositoryLink = screen.getByRole("link", { name: /https:\/\/github\.com\/wly-wf\/ai_translate$/ });
    const issuesLink = screen.getByRole("link", { name: /https:\/\/github\.com\/wly-wf\/ai_translate\/issues$/ });
    expect(repositoryLink).toHaveAttribute("href", "https://github.com/wly-wf/ai_translate");
    expect(issuesLink).toHaveAttribute("href", "https://github.com/wly-wf/ai_translate/issues");
  });

  it("renders add-provider in its own window with a unified close action", () => {
    mockWindowLabel("add-provider");
    render(<App />);

    expect(screen.getByRole("heading", { name: "添加自定义供应商" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "返回设置" })).not.toBeInTheDocument();
    expect(screen.queryByText("AI Translate")).not.toBeInTheDocument();
    expect(screen.getByText("OpenAI 兼容接口")).toBeInTheDocument();
    expect(screen.getByLabelText("供应商名称")).toHaveValue("");
    expect(screen.getByLabelText("供应商名称")).toHaveAttribute("placeholder", "供应商名称");
    expect(screen.getByLabelText("API Key")).toBeRequired();
    expect(screen.getByLabelText("API Key")).toHaveAttribute("placeholder", "");
    expect(screen.queryByText("API Key（可选）")).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Google" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Claude" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("API 路径")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("添加后启用")).not.toBeInTheDocument();
    expect(screen.getByLabelText("模型名称")).toBeInTheDocument();
    expect(screen.queryByLabelText("名称")).not.toBeInTheDocument();
    expect(screen.getByLabelText("API 地址")).toHaveValue("https://api.openai.com");
    fireEvent.click(screen.getByRole("button", { name: "关闭添加自定义供应商" }));
    expect(invokeMock).toHaveBeenCalledWith("return_to_settings_window", undefined);
  });

  it("uses the shared model manager when adding a custom provider", async () => {
    mockWindowLabel("add-provider");
    invokeMock.mockImplementation((command: string) => {
      if (command === "fetch_provider_models") return Promise.resolve(["agnes-2.0-flash", "agnes-2.5-pro"]);
      return Promise.resolve(undefined);
    });
    render(<App />);

    fireEvent.change(screen.getByLabelText("供应商名称"), { target: { value: "modelscope" } });
    fireEvent.change(screen.getByLabelText("API Key"), { target: { value: "modelscope-key" } });
    expect(document.querySelector(".add-provider-model-row .provider-mark")).toHaveTextContent("m");
    expect(document.querySelector(".add-provider-model-row .provider-mark")).toHaveClass("provider-custom-mark");

    fireEvent.click(screen.getByRole("button", { name: "获取模型" }));

    const dialog = await screen.findByRole("dialog", { name: "modelscope 可用模型" });
    expect(within(dialog).queryByRole("combobox")).not.toBeInTheDocument();
    fireEvent.click(await within(dialog).findByRole("button", { name: "添加模型 agnes-2.0-flash" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "添加模型 agnes-2.5-pro" }));
    expect(screen.getByLabelText("模型名称")).toHaveValue("agnes-2.0-flash");
    expect(screen.getByLabelText("模型名称 2")).toHaveValue("agnes-2.5-pro");
    fireEvent.click(within(dialog).getByRole("button", { name: "完成" }));

    fireEvent.click(screen.getByRole("button", { name: "添加接口" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("save_provider_config", {
      provider: "openai",
      vendorName: "modelscope",
      apiKey: "modelscope-key",
      baseUrl: "https://api.openai.com",
      model: "agnes-2.0-flash",
      models: ["agnes-2.0-flash", "agnes-2.5-pro"],
    }));
  });

  it("preserves the case of a custom provider's first-character icon", () => {
    mockWindowLabel("add-provider");
    render(<App />);

    fireEvent.change(screen.getByLabelText("供应商名称"), { target: { value: "Agnes" } });

    expect(document.querySelector(".add-provider-model-row .provider-mark")).toHaveTextContent("A");
  });

  it("requires a provider name and API Key before adding a custom provider", async () => {
    mockWindowLabel("add-provider");
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "添加接口" }));
    expect(screen.getByRole("status")).toHaveTextContent("请填写供应商名称。");

    fireEvent.change(screen.getByLabelText("供应商名称"), { target: { value: "modelscope" } });
    fireEvent.click(screen.getByRole("button", { name: "添加接口" }));
    expect(screen.getByRole("status")).toHaveTextContent("请填写 API Key。");
    expect(invokeMock).not.toHaveBeenCalledWith("save_provider_config", expect.anything());
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

  it("persists provider reordering directly from the provider row", async () => {
    mockWindowLabel("settings");
    invokeMock.mockImplementation((command: string) => {
      if (command === "get_enabled_providers") return Promise.resolve(["deepseek", "xiaomi"]);
      if (command === "get_preferences") return Promise.resolve({
        providerOrder: ["deepseek", "xiaomi", "qwen", "zhipu", "moonshot"],
      });
      return Promise.resolve(undefined);
    });
    render(<App />);

    const providerList = screen.getByRole("navigation", { name: "供应商列表" });
    const deepSeekRow = await within(providerList).findByRole("button", { name: /DeepSeek/ });
    expect(screen.queryByText("按住手柄拖动排序")).not.toBeInTheDocument();
    expect(document.querySelector(".provider-reorder-handle")).not.toBeInTheDocument();
    fireEvent.keyDown(deepSeekRow, { key: " " });
    fireEvent.keyDown(deepSeekRow, { key: "ArrowDown" });
    fireEvent.keyDown(deepSeekRow, { key: "Enter" });

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("set_user_preference", {
      preference: "providerOrder",
      value: ["xiaomi", "deepseek", "qwen", "zhipu", "moonshot"],
    }));
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
      baseUrl: "https://api.xiaomimimo.com",
      model: "mimo-v2.5-pro",
      models: ["mimo-v2.5-pro"],
    });
    expect(screen.queryByText(/与其他启用模型同时返回结果/)).not.toBeInTheDocument();
    expect(screen.queryByText(/已加入翻译/)).not.toBeInTheDocument();
  });

  it("allows the last enabled provider to be turned off", async () => {
    mockWindowLabel("settings");
    invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === "get_enabled_providers") return Promise.resolve(["deepseek"]);
      if (command === "get_provider_config" && args?.provider === "deepseek") {
        return Promise.resolve({ apiKey: "saved", baseUrl: "https://api.deepseek.com", model: "deepseek-v4-flash", models: ["deepseek-v4-flash"] });
      }
      if (command === "get_provider_config") return Promise.resolve(null);
      if (command === "set_provider_enabled") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
    render(<App />);

    const enabledSwitch = screen.getByRole("checkbox", { name: "启用此翻译模型" });
    await waitFor(() => expect(enabledSwitch).toBeChecked());
    fireEvent.click(enabledSwitch);

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("set_provider_enabled", { provider: "deepseek", enabled: false }));
    await waitFor(() => expect(enabledSwitch).not.toBeChecked());
  });

  it("automatically saves valid provider edits without a save button or success notice", async () => {
    mockWindowLabel("settings");
    invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === "get_enabled_providers") return Promise.resolve(["deepseek"]);
      if (command === "get_provider_config" && args?.provider === "deepseek") {
        return Promise.resolve({ apiKey: "saved-key", baseUrl: "https://api.deepseek.com", model: "deepseek-v4-flash", models: ["deepseek-v4-flash"] });
      }
      if (command === "get_provider_config") return Promise.resolve(null);
      return Promise.resolve(undefined);
    });
    render(<App />);

    await waitFor(() => expect(screen.getByLabelText("API 地址")).toHaveValue("https://api.deepseek.com"));
    expect(screen.queryByRole("button", { name: "保存配置" })).not.toBeInTheDocument();
    invokeMock.mockClear();
    fireEvent.change(screen.getByLabelText("API 地址"), { target: { value: "https://api.deepseek.example.com" } });

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("save_provider_config", {
      provider: "deepseek",
      apiKey: "saved-key",
      baseUrl: "https://api.deepseek.example.com",
      model: "deepseek-v4-flash",
      models: ["deepseek-v4-flash"],
    }), { timeout: 2000 });
    expect(screen.getByLabelText("API 地址")).toHaveValue("https://api.deepseek.example.com");
    expect(screen.queryByText("保存成功")).not.toBeInTheDocument();
  });

  it("shows a red delete menu only for user-added providers and removes their configuration", async () => {
    mockWindowLabel("settings");
    invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === "get_enabled_providers") return Promise.resolve(["deepseek", "openai"]);
      if (command === "get_provider_config" && args?.provider === "openai") {
        return Promise.resolve({ vendorName: "魔搭社区", apiKey: "saved", baseUrl: "https://example.com", model: "demo-model", models: ["demo-model"] });
      }
      if (command === "get_provider_config") return Promise.resolve(null);
      if (command === "delete_custom_provider") return Promise.resolve(["deepseek"]);
      return Promise.resolve(undefined);
    });
    render(<App />);

    const customProvider = await screen.findByRole("button", { name: /魔搭社区/ });
    const builtInContextMenuEvent = new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 100, clientY: 100 });
    screen.getByRole("button", { name: /DeepSeek/ }).dispatchEvent(builtInContextMenuEvent);
    expect(builtInContextMenuEvent.defaultPrevented).toBe(true);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    fireEvent.contextMenu(customProvider, { clientX: 220, clientY: 260 });
    const menu = screen.getByRole("menu", { name: "魔搭社区 操作" });
    const deleteAction = within(menu).getByRole("menuitem", { name: "删除供应商 魔搭社区" });
    expect(deleteAction).toHaveClass("provider-context-menu-delete");
    fireEvent.click(deleteAction);

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("delete_custom_provider", { provider: "openai" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /魔搭社区/ })).not.toBeInTheDocument());
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("fetches provider models and selects one from the returned list", async () => {
    mockWindowLabel("settings");
    const modelRequest = deferred<string[]>();
    invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === "get_enabled_providers") return Promise.resolve(["deepseek"]);
      if (command === "get_provider_config" && args?.provider === "deepseek") {
        return Promise.resolve({ apiKey: "saved-key", baseUrl: "https://api.deepseek.com", model: "deepseek-v4-flash" });
      }
      if (command === "fetch_provider_models") return modelRequest.promise;
      return Promise.resolve(undefined);
    });
    render(<App />);

    await waitFor(() => expect(screen.getByLabelText("API Key")).toHaveValue("saved-key"));
    fireEvent.click(screen.getByRole("button", { name: "获取" }));

    const dialog = await screen.findByRole("dialog", { name: "DeepSeek 可用模型" });
    expect(dialog).toHaveClass("model-dialog-card");
    expect(screen.getByRole("status", { name: "正在获取 DeepSeek 模型" })).toHaveTextContent("正在获取模型");
    expect(screen.getByRole("button", { name: "获取" })).toBeDisabled();
    expect(screen.queryByText("获取中…")).not.toBeInTheDocument();

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("fetch_provider_models", {
      provider: "deepseek",
      apiKey: "saved-key",
      baseUrl: "https://api.deepseek.com",
    }));
    modelRequest.resolve(["deepseek-chat", "deepseek-reasoner"]);
    await waitFor(() => expect(screen.getByRole("button", { name: "添加模型 deepseek-chat" })).toBeInTheDocument());
    expect(dialog).not.toHaveTextContent("模型目录");
    expect(dialog).not.toHaveTextContent("已获取 2 个可用模型");
    expect(document.querySelector(".fetched-model-list")).toBeNull();
    const addModelButton = await screen.findByRole("button", { name: "添加模型 deepseek-chat" });
    expect(addModelButton.closest(".model-dialog-card")).toBe(dialog);
    expect(addModelButton.closest(".model-dialog-option")).toHaveTextContent("deepseek-chat");
    expect(addModelButton.closest(".model-dialog-option")?.querySelector("small")).toBeNull();
    expect(dialog.querySelector(".model-dialog-check")).toBeNull();
    expect(dialog.querySelector(".is-selected")).toBeNull();
    fireEvent.click(addModelButton);
    expect(screen.getAllByLabelText("模型名称").map((input) => (input as HTMLInputElement).value)).toEqual([
      "deepseek-v4-flash",
      "deepseek-chat",
    ]);
    fireEvent.click(screen.getByRole("button", { name: "添加模型 deepseek-reasoner" }));
    expect(screen.getAllByLabelText("模型名称").map((input) => (input as HTMLInputElement).value)).toEqual([
      "deepseek-v4-flash",
      "deepseek-chat",
      "deepseek-reasoner",
    ]);
    const removeModelButton = dialog.querySelector<HTMLButtonElement>('[aria-label="移除模型 deepseek-chat"]');
    expect(removeModelButton).not.toBeNull();
    fireEvent.click(removeModelButton!);
    expect(screen.getAllByLabelText("模型名称").map((input) => (input as HTMLInputElement).value)).toEqual([
      "deepseek-v4-flash",
      "deepseek-reasoner",
    ]);
    expect(screen.getByRole("button", { name: "添加模型 deepseek-chat" })).toBeInTheDocument();
    expect(dialog).toBeInTheDocument();
    expect(document.querySelector(".model-fetch-message")).toBeNull();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "DeepSeek 可用模型" })).not.toBeInTheDocument());
  });

  it("shows a concise model fetch error beside the fetch button", async () => {
    mockWindowLabel("settings");
    invokeMock.mockImplementation((command: string) => {
      if (command === "get_enabled_providers") return Promise.resolve([]);
      if (command === "get_provider_config") return Promise.resolve(null);
      if (command === "fetch_provider_models") return Promise.reject("请先保存 qwen 的 API Key。");
      return Promise.resolve(undefined);
    });
    const { container } = render(<App />);

    fireEvent.click(screen.getByRole("button", { name: /阿里云百炼/ }));
    fireEvent.click(screen.getByRole("button", { name: "获取" }));

    await waitFor(() => expect(container.querySelector(".model-fetch-message")).toHaveTextContent("获取模型列表失败"));
    const message = container.querySelector<HTMLElement>(".model-fetch-message");
    const fetchButton = screen.getByRole("button", { name: "获取" });
    expect(message).toHaveClass("model-fetch-message");
    expect(message).toHaveTextContent("获取模型列表失败");
    expect(message?.closest(".model-toolbar")).not.toBeNull();
    expect(message && (message.compareDocumentPosition(fetchButton) & Node.DOCUMENT_POSITION_FOLLOWING)).toBeTruthy();
    const dialog = screen.getByRole("dialog", { name: "阿里云百炼 可用模型" });
    expect(within(dialog).getByRole("alert")).toHaveTextContent("请先保存 阿里云百炼 的 API Key。");
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
    const testModelDialog = await screen.findByRole("dialog", { name: "请选择要检测的模型" });
    fireEvent.click(within(testModelDialog).getByRole("combobox", { name: "选择测试模型" }));
    fireEvent.click(within(testModelDialog).getByRole("option", { name: "deepseek-chat" }));
    fireEvent.click(within(testModelDialog).getByRole("button", { name: "测试连接" }));

    const status = await screen.findByText("连接成功 · 42 ms");
    expect(status).toHaveClass("connection-inline-result", "success");
    expect(status.closest(".settings-field-group")).not.toBeNull();
    expect(status.closest(".settings-label-row")).toBeNull();
    expect(document.querySelector(".provider-detail-panel > .connection-result")).toBeNull();
  });

  it("ignores stale connection-test responses after switching providers", async () => {
    mockWindowLabel("settings");
    const deepseekRequest = deferred<{ latencyMs: number; message: string }>();
    const xiaomiRequest = deferred<{ latencyMs: number; message: string }>();
    invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === "get_enabled_providers") return Promise.resolve(["deepseek", "xiaomi"]);
      if (command === "get_provider_config") {
        if (args?.provider === "deepseek") return Promise.resolve({ apiKey: "saved", baseUrl: "https://api.deepseek.com", model: "deepseek-chat" });
        if (args?.provider === "xiaomi") return Promise.resolve({ apiKey: "saved", baseUrl: "https://api.xiaomimimo.com/v1", model: "mimo-v2.5-pro" });
        return Promise.resolve(null);
      }
      if (command === "test_provider_connection") {
        return args?.provider === "xiaomi" ? xiaomiRequest.promise : deepseekRequest.promise;
      }
      return Promise.resolve(undefined);
    });
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
    const deepseekTestDialog = await screen.findByRole("dialog", { name: "请选择要检测的模型" });
    fireEvent.click(within(deepseekTestDialog).getByRole("button", { name: "测试连接" }));
    fireEvent.click(screen.getByRole("button", { name: /Xiaomi MiMo/ }));
    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
    const xiaomiTestDialog = await screen.findByRole("dialog", { name: "请选择要检测的模型" });
    fireEvent.click(within(xiaomiTestDialog).getByRole("button", { name: "测试连接" }));

    xiaomiRequest.resolve({ latencyMs: 20, message: "Xiaomi ok" });
    expect(await screen.findByText("Xiaomi ok · 20 ms")).toBeInTheDocument();
    deepseekRequest.resolve({ latencyMs: 80, message: "DeepSeek stale" });
    await waitFor(() => expect(screen.getByText("Xiaomi ok · 20 ms")).toBeInTheDocument());
    expect(screen.queryByText(/DeepSeek stale/)).not.toBeInTheDocument();
  });

  it("keeps the current model fetch busy when an older request finishes", async () => {
    mockWindowLabel("settings");
    const deepseekRequest = deferred<string[]>();
    const xiaomiRequest = deferred<string[]>();
    invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === "get_enabled_providers") return Promise.resolve(["deepseek", "xiaomi"]);
      if (command === "get_provider_config") return Promise.resolve(null);
      if (command === "fetch_provider_models") {
        return args?.provider === "xiaomi" ? xiaomiRequest.promise : deepseekRequest.promise;
      }
      return Promise.resolve(undefined);
    });
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "获取" }));
    fireEvent.click(screen.getByRole("button", { name: /Xiaomi MiMo/ }));
    fireEvent.click(screen.getByRole("button", { name: "获取" }));

    deepseekRequest.resolve(["deepseek-chat"]);
    await waitFor(() => expect(screen.getByRole("button", { name: "获取" })).toBeDisabled());
    xiaomiRequest.resolve(["mimo-v2.5-pro"]);
    expect(await screen.findByRole("button", { name: "添加模型 mimo-v2.5-pro" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "添加模型 deepseek-chat" })).not.toBeInTheDocument();
  });

  it("uses the model selected from the quick translation picker", async () => {
    invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === "get_enabled_providers") return Promise.resolve(["deepseek", "xiaomi"]);
      if (command === "get_preferences") return Promise.resolve({ autoSelection: true, keepOnTop: false, quickTranslateProvider: "deepseek", quickTranslateModel: "deepseek-v4-flash" });
      if (command === "get_provider_config") {
        return Promise.resolve(args?.provider === "xiaomi"
          ? { apiKey: "saved", baseUrl: "https://api.xiaomimimo.com/v1", model: "mimo-v2.5-pro", models: ["mimo-v2.5-pro", "mimo-v3"] }
          : { apiKey: "saved", baseUrl: "https://api.deepseek.com", model: "deepseek-v4-flash" });
      }
      if (command === "translate_text") return Promise.resolve({
        source: "hello",
        requestId: 7,
        results: [
          { providerId: "xiaomi", model: "mimo-v3", translation: "您好" },
        ],
      });
      return Promise.resolve(undefined);
    });
    const { container } = render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "快速翻译" }));
    const modelPicker = screen.getByRole("button", { name: "选择翻译模型" });
    await waitFor(() => expect(modelPicker).toHaveTextContent("deepseek-v4-flash"));
    fireEvent.click(modelPicker);
    fireEvent.click(await screen.findByRole("option", { name: /mimo-v3.*Xiaomi MiMo/ }));
    expect(screen.queryByText("设为默认快速翻译模型")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("输入文本"), { target: { value: "hello" } });
    expect(screen.getByLabelText("输入文本")).toHaveClass("is-mixed-language");
    fireEvent.click(screen.getByRole("button", { name: "翻译" }));

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("translate_text", { text: "hello", provider: "xiaomi", model: "mimo-v3" }));
    expect(screen.getByText("mimo-v3/Xiaomi MiMo")).toBeInTheDocument();
    expect(screen.getAllByText("您好")[0]).toBeInTheDocument();
    expect(container.querySelector(".translation:not(.text-measure)")).toHaveClass("translation-chinese");
  });

  it("sets the default quick translation model from its floating selection panel", async () => {
    mockWindowLabel("settings");
    invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === "get_enabled_providers") return Promise.resolve(["deepseek", "xiaomi"]);
      if (command === "get_preferences") return Promise.resolve({ autoSelection: true, keepOnTop: false, quickTranslateProvider: "deepseek" });
      if (command === "get_provider_config") {
        return Promise.resolve(args?.provider === "xiaomi"
          ? { apiKey: "saved", baseUrl: "https://api.xiaomimimo.com/v1", model: "mimo-v2.5-pro" }
          : { apiKey: "saved", baseUrl: "https://api.deepseek.com", model: "deepseek-v4-flash", models: ["deepseek-v4-flash", "deepseek-reasoner"] });
      }
      return Promise.resolve(undefined);
    });
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "偏好设置" }));
    const defaultModelEntry = screen.getByRole("button", { name: "设置默认快速翻译模型" });
    await waitFor(() => expect(defaultModelEntry).toHaveTextContent("deepseek-v4-flash"));
    fireEvent.click(defaultModelEntry);
    expect(screen.getByRole("heading", { name: "偏好" })).toBeInTheDocument();
    const modelDialog = screen.getByRole("dialog", { name: "选择默认模型" });
    expect(screen.queryByRole("listbox", { name: "设置默认快速翻译模型" })).not.toBeInTheDocument();
    const configuredModels = within(modelDialog).getByRole("list", { name: "已配置模型" });
    expect(within(configuredModels).getByRole("button", { name: /deepseek-v4-flash.*DeepSeek/ })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(within(configuredModels).getByRole("button", { name: /deepseek-reasoner.*DeepSeek/ }));

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("set_user_preference", {
      preference: "quickTranslateModel",
      value: "deepseek-reasoner",
    }));
    expect(screen.queryByRole("dialog", { name: "选择默认模型" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "设置默认快速翻译模型" })).toHaveTextContent("deepseek-reasoner");
  });

  it("updates color mode and translation font sizes from interface settings", async () => {
    mockWindowLabel("settings");
    invokeMock.mockImplementation((command: string) => {
      if (command === "get_enabled_providers") return Promise.resolve([]);
      if (command === "get_preferences") return Promise.resolve({
        autoSelection: true,
        keepOnTop: false,
        quickTranslateProvider: null,
        themeMode: "system",
        sourceFontSize: 14,
        translationFontSize: 16,
        proxyMode: "system",
        proxyUrl: "",
      });
      return Promise.resolve(undefined);
    });
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "偏好设置" }));
    expect(screen.queryByText("外观与行为")).not.toBeInTheDocument();
    expect(screen.queryByText("集中管理默认模型、颜色模式、翻译文字大小和窗口交互方式。")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "偏好设置" })).toHaveClass("sr-only");
    expect(screen.getByRole("heading", { level: 2, name: "偏好" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "字体" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "其他" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "选中文本自动显示悬浮按钮" })).toBeChecked();
    expect(screen.queryByText("“跟随系统”会在 Windows 外观变化时自动切换")).not.toBeInTheDocument();
    expect(screen.queryByText("翻译结果中原文的显示大小")).not.toBeInTheDocument();
    expect(screen.queryByText("鼠标完成选区后显示翻译入口")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "深色" }));
    fireEvent.change(screen.getByLabelText("原文字号"), { target: { value: "18" } });
    fireEvent.change(screen.getByLabelText("译文字号"), { target: { value: "20" } });

    await waitFor(() => expect(document.documentElement).toHaveAttribute("data-theme", "dark"));
    expect(document.documentElement.style.getPropertyValue("--source-font-size")).toBe("18px");
    expect(document.documentElement.style.getPropertyValue("--translation-font-size")).toBe("20px");
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("set_user_preference", { preference: "translationFontSize", value: 20 }));
  });

  it("keeps system color mode synchronized with operating-system changes", async () => {
    mockWindowLabel("settings");
    let systemDark = false;
    let themeListener: ((event: MediaQueryListEvent) => void) | undefined;
    const mediaQuery = {
      get matches() { return systemDark; },
      media: "(prefers-color-scheme: dark)",
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn((_type: string, listener: (event: MediaQueryListEvent) => void) => {
        themeListener = listener;
      }),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(() => true),
    } as unknown as MediaQueryList;
    vi.stubGlobal("matchMedia", vi.fn(() => mediaQuery));
    invokeMock.mockImplementation((command: string) => {
      if (command === "get_enabled_providers") return Promise.resolve([]);
      if (command === "get_preferences") return Promise.resolve({
        themeMode: "system",
        sourceFontSize: 14,
        translationFontSize: 16,
      });
      return Promise.resolve(undefined);
    });

    render(<App />);

    await waitFor(() => expect(document.documentElement).toHaveAttribute("data-theme", "light"));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("set_window_appearance", {
      dark: false,
      followSystem: true,
    }));

    systemDark = true;
    act(() => themeListener?.({ matches: true } as MediaQueryListEvent));

    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("set_window_appearance", {
      dark: true,
      followSystem: true,
    }));
  });

  it("configures a custom network proxy from its own settings page", async () => {
    mockWindowLabel("settings");
    invokeMock.mockImplementation((command: string) => {
      if (command === "get_enabled_providers") return Promise.resolve([]);
      if (command === "get_preferences") return Promise.resolve({ proxyMode: "system", proxyUrl: "" });
      if (command === "test_proxy_connection") return Promise.resolve("连接成功（HTTP 200）");
      return Promise.resolve(undefined);
    });
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "网络代理" }));
    expect(screen.queryByRole("heading", { level: 1, name: "网络代理" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "代理设置" })).toBeInTheDocument();
    const enabledSwitch = screen.getByRole("checkbox", { name: "启动代理" }) as HTMLInputElement;
    expect(enabledSwitch).not.toBeChecked();
    fireEvent.click(enabledSwitch);
    const proxyHostInput = screen.getByLabelText("服务器地址");
    expect(proxyHostInput).toBeEnabled();
    fireEvent.change(proxyHostInput, { target: { value: "proxy.example.com" } });
    fireEvent.change(screen.getByLabelText("端口"), { target: { value: "8443" } });
    fireEvent.change(screen.getByLabelText("代理绕过地址"), { target: { value: "localhost,127.0.0.1" } });

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("set_user_preference", { preference: "proxyMode", value: "custom" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("set_user_preference", { preference: "proxyHost", value: "proxy.example.com" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("set_user_preference", { preference: "proxyPort", value: "8443" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("set_user_preference", { preference: "proxyBypass", value: "localhost,127.0.0.1" }));
    const testButton = screen.getByRole("button", { name: "测试" });
    if (!enabledSwitch.checked) fireEvent.click(enabledSwitch);
    await waitFor(() => expect(testButton).toBeEnabled());
    fireEvent.click(testButton);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("test_proxy_connection", { url: "https://www.google.com" }));
    expect(await screen.findByText("连接成功（HTTP 200）")).toBeInTheDocument();
  });

  it("prompts the user to configure a provider when none is enabled", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "get_enabled_providers") return Promise.resolve([]);
      if (command === "get_preferences") return Promise.resolve({ autoSelection: true, keepOnTop: false, quickTranslateProvider: null });
      return Promise.resolve(undefined);
    });
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "快速翻译" }));
    fireEvent.change(screen.getByLabelText("输入文本"), { target: { value: "hello" } });
    const translateButton = screen.getByRole("button", { name: "翻译" });

    await waitFor(() => expect(translateButton).toBeEnabled());
    fireEvent.click(translateButton);
    expect(invokeMock).not.toHaveBeenCalledWith("translate_text", expect.anything());
    expect(screen.getByText("需要配置翻译供应商")).toBeInTheDocument();
    expect(screen.getByText("添加并启用供应商后即可开始翻译")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /前往设置/ }));
    expect(invokeMock).toHaveBeenCalledWith("open_settings_window", undefined);
  });

  it("shows an actionable provider setup notice after selection translation fails", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "get_enabled_providers") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
    render(<App />);
    const errorHandler = listenMock.mock.calls.find(([eventName]) => eventName === "translation-error")?.[1];

    act(() => errorHandler({
      payload: {
        requestId: 1,
        message: "尚未配置并启用翻译供应商，请先前往设置完成配置。",
      },
    }));

    expect(screen.getByText("需要配置翻译供应商")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /前往设置/ })).toBeInTheDocument();
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

  it("accepts another selected-text translation after a successful request", async () => {
    mockWindowLabel("selection-float");
    invokeMock.mockResolvedValue(undefined);
    render(<App />);
    const showHandler = listenMock.mock.calls.find(([eventName]) => eventName === "selection-float:show")?.[1];

    fireEvent.click(screen.getByRole("button", { name: "翻译选中文本" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "翻译选中文本" })).toBeDisabled());

    act(() => showHandler({ payload: { generation: 2 } }));
    const secondButton = screen.getByRole("button", { name: "翻译选中文本" });
    expect(secondButton).toBeEnabled();
    fireEvent.click(secondButton);

    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(2));
    expect(invokeMock).toHaveBeenNthCalledWith(1, "translate_selection_float");
    expect(invokeMock).toHaveBeenNthCalledWith(2, "translate_selection_float");
  });

  it("shows the known source text while the provider translation is pending", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "get_enabled_providers") return Promise.resolve(["deepseek"]);
      if (command === "get_latest_translation") return Promise.resolve({
        source: "Known source text",
        requestId: 12,
        results: [{ providerId: "deepseek", model: "deepseek-v4-flash" }],
      });
      return Promise.resolve(undefined);
    });

    const { container } = render(<App />);

    await waitFor(() => {
      expect(container.querySelector(".source:not(.text-measure)")).toHaveTextContent("Known source text");
    });
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("翻译中…");
    expect(container.querySelector(".provider-body")).toHaveAttribute("aria-busy", "true");
    expect(container.querySelector(".translation-line")).toContainElement(status);
    expect(container.querySelector(".translation-reveal")).not.toBeInTheDocument();

    const resultHandler = listenMock.mock.calls.find(([eventName]) => eventName === "translation-result")?.[1];
    act(() => resultHandler({
      payload: {
        source: "Known source text",
        requestId: 12,
        results: [{ providerId: "deepseek", model: "deepseek-v4-flash", translation: "已完成的翻译" }],
      },
    }));

    const reveal = await waitFor(() => {
      const element = container.querySelector(".translation-reveal");
      expect(element).toHaveTextContent("已完成的翻译");
      return element;
    });
    expect(reveal?.querySelector(".translation-reveal-inner")).toBeInTheDocument();
  });

  it("renders translation cards in the persisted provider order", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "get_preferences") return Promise.resolve({
        providerOrder: ["xiaomi", "deepseek"],
      });
      if (command === "get_enabled_providers") return Promise.resolve(["xiaomi", "deepseek"]);
      if (command === "get_provider_config") return Promise.resolve(null);
      if (command === "get_latest_translation") return Promise.resolve({
        source: "hello",
        requestId: 18,
        results: [
          { providerId: "deepseek", model: "deepseek-v4-flash", translation: "深度求索" },
          { providerId: "xiaomi", model: "mimo-v2.5-pro", translation: "小米" },
        ],
      });
      return Promise.resolve(undefined);
    });
    const { container } = render(<App />);

    await waitFor(() => expect(
      Array.from(container.querySelectorAll(".provider-heading strong")).map((node) => node.textContent),
    ).toEqual([
      "mimo-v2.5-pro/Xiaomi MiMo", "deepseek-v4-flash/DeepSeek",
    ]));
  });

  it("renders a custom provider name beside its model in the translation window", async () => {
    invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === "get_enabled_providers") return Promise.resolve(["openai"]);
      if (command === "get_provider_config" && args?.provider === "openai") {
        return Promise.resolve({
          vendorName: "Agnes",
          apiKey: "saved",
          baseUrl: "https://example.com/v1",
          model: "agnes-2.5-flash",
          models: ["agnes-2.5-flash"],
        });
      }
      if (command === "get_latest_translation") return Promise.resolve({
        source: "hello",
        requestId: 19,
        results: [{ providerId: "openai", model: "agnes-2.5-flash", translation: "你好" }],
      });
      return Promise.resolve(undefined);
    });
    render(<App />);

    expect(await screen.findByText("agnes-2.5-flash/Agnes")).toBeInTheDocument();
    expect(screen.queryByText("agnes-2.5-flash/OpenAI 兼容接口")).not.toBeInTheDocument();
  });

  it("preserves captured source line breaks instead of merging them into a paragraph", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "get_enabled_providers") return Promise.resolve(["deepseek"]);
      if (command === "get_latest_translation") return Promise.resolve({
        source: "第一项\r\n第二项\r第三项",
        requestId: 13,
        results: [{ providerId: "deepseek", model: "deepseek-v4-flash", translation: "First\nSecond\nThird" }],
      });
      return Promise.resolve(undefined);
    });

    const { container } = render(<App />);

    await waitFor(() => {
      const sourceParagraphs = Array.from(container.querySelectorAll(".source:not(.text-measure) .text-paragraph"));
      expect(sourceParagraphs.map((paragraph) => paragraph.textContent)).toEqual(["第一项", "第二项", "第三项"]);
      expect(container.querySelectorAll(".translation:not(.text-measure) .text-paragraph")).toHaveLength(3);
      expect(container.querySelector(".translation:not(.text-measure)")).toHaveClass("translation-english");
    });
  });

  it("reflows English UIA soft wraps while preserving real paragraph breaks", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "get_enabled_providers") return Promise.resolve(["deepseek"]);
      if (command === "get_latest_translation") return Promise.resolve({
        source: "Hardware, IP, and Platform Development: Creating the PL IP blocks\r\nfor the hardware platform\r\n\r\nTopics in this document\rthat apply to this design process include:",
        requestId: 14,
        results: [{ providerId: "deepseek", model: "deepseek-v4-flash", translation: "硬件、IP 与平台开发。" }],
      });
      return Promise.resolve(undefined);
    });

    const { container } = render(<App />);

    await waitFor(() => {
      const sourceParagraphs = Array.from(container.querySelectorAll(".source:not(.text-measure) .text-paragraph"));
      expect(sourceParagraphs.map((paragraph) => paragraph.textContent)).toEqual([
        "Hardware, IP, and Platform Development: Creating the PL IP blocks for the hardware platform",
        "Topics in this document that apply to this design process include:",
      ]);
    });
  });

  it("preserves English list item line breaks while reflowing wrapped item text", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "get_enabled_providers") return Promise.resolve(["deepseek"]);
      if (command === "get_latest_translation") return Promise.resolve({
        source: "Updates:\r\n• Added Volcengine text-to-speech support.\r\n• Added support for reading AGENTS.md in workspaces.\r\n• Added support for DeepSeek Flash.\r\n• Clarified that regenerating a message clears subsequent messages, and fixed compatibility issues with some\r\nservices.",
        requestId: 15,
        results: [{ providerId: "deepseek", model: "deepseek-v4-flash", translation: "更新内容" }],
      });
      return Promise.resolve(undefined);
    });

    const { container } = render(<App />);

    await waitFor(() => {
      const sourceParagraphs = Array.from(container.querySelectorAll(".source:not(.text-measure) .text-paragraph"));
      expect(sourceParagraphs.map((paragraph) => paragraph.textContent)).toEqual([
        "Updates:",
        "• Added Volcengine text-to-speech support.",
        "• Added support for reading AGENTS.md in workspaces.",
        "• Added support for DeepSeek Flash.",
        "• Clarified that regenerating a message clears subsequent messages, and fixed compatibility issues with some services.",
      ]);
    });
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
      expect(button).not.toHaveAttribute("title");
      fireEvent.click(button);
      expect(button).toHaveAttribute("aria-expanded", "true");
      expect(button).not.toHaveAttribute("title");
    } finally {
      rectSpy.mockRestore();
    }
  });
});
