import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ProviderWrites } from "./providerWrites";
import { useUserPreferences } from "./useUserPreferences";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn().mockResolvedValue(() => {}), label: "settings" }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({ getCurrentWebviewWindow: () => ({ label: mocks.label }) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ onFocusChanged: vi.fn().mockResolvedValue(() => {}) }), cursorPosition: vi.fn() }));
Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
import App from "./App";
afterEach(() => { cleanup(); mocks.listen.mockClear(); mocks.invoke.mockReset(); });
function setup(label = "settings") {
  mocks.label = label;
  mocks.invoke.mockImplementation((command: string) => {
    if (command === "get_enabled_providers") return Promise.resolve(["deepseek"]);
    if (command === "get_provider_config") return Promise.resolve({ vendorName: "Custom", apiKey: "test", baseUrl: "https://example.com", model: "model-a", models: ["model-a"] });
    return Promise.resolve(undefined);
  });
  render(<App />);
}
it("does not subscribe routine saves to navigation or draft replacement", async () => {
  setup();
  await screen.findByDisplayValue("test");
  fireEvent.click(screen.getByRole("button", { name: "偏好设置" }));
  expect(mocks.listen.mock.calls.some(([name]) => name === "provider-config-saved")).toBe(false);
  expect(screen.getByRole("heading", { name: "偏好" })).toBeInTheDocument();
});
it("retains the last saved model and explains how to disable translation", async () => {
  setup();
  fireEvent.click(await screen.findByRole("button", { name: "移除模型 model-a" }));
  expect(screen.getByDisplayValue("model-a")).toBeInTheDocument();
  expect(screen.getByText(/至少保留一个模型/)).toBeInTheDocument();
});
it("background results preserve quick input and collapsed model cards", async () => {
  setup("main");
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("get_enabled_providers", undefined));
  const handler = mocks.listen.mock.calls.find(([name]) => name === "translation-result")![1];
  const batch = { source: "hello", requestId: 1, results: [{ providerId: "deepseek", model: "model-a", translation: null, error: null }] };
  act(() => handler({ payload: batch }));
  fireEvent.click(screen.getByRole("button", { name: /model-a\// }));
  fireEvent.click(screen.getByRole("button", { name: "快速翻译" }));
  fireEvent.change(screen.getByLabelText("输入文本"), { target: { value: "new draft" } });
  act(() => handler({ payload: { ...batch, results: [{ ...batch.results[0], translation: "你好" }] } }));
  expect(screen.getByLabelText("输入文本")).toHaveValue("new draft");
  fireEvent.click(screen.getByRole("button", { name: "返回悬浮翻译" }));
  expect(screen.getByRole("button", { name: /model-a\// })).toHaveAttribute("aria-expanded", "false");
});
it("serializes a deletion behind a save even when that save fails", async () => {
  const writes = new ProviderWrites();
  let reject!: (error: Error) => void;
  const save = writes.run("openai", () => new Promise<void>((_, fail) => { reject = fail; }));
  const remove = vi.fn().mockResolvedValue(undefined);
  const deletion = writes.run("openai", remove);
  await Promise.resolve(); await Promise.resolve();
  expect(remove).not.toHaveBeenCalled();
  reject(new Error("storage failure"));
  await expect(save).rejects.toThrow("storage failure");
  await deletion;
  expect(remove).toHaveBeenCalledOnce();
});

it("coalesces proxy typing and flushes the final value before testing", async () => {
  mocks.invoke.mockImplementation((command: string, args?: { value: string }) => {
    if (command === "get_preferences") return Promise.resolve({ proxyHost: "127.0.0.1" });
    if (command === "set_user_preference") return Promise.resolve({ proxyHost: args?.value });
    return Promise.resolve(undefined);
  });
  const { result } = renderHook(useUserPreferences);
  await act(async () => { await Promise.resolve(); });
  act(() => {
    result.current.setProxyHost("p");
    result.current.setProxyHost("proxy");
    result.current.setProxyHost("proxy.example.com");
  });
  expect(mocks.invoke.mock.calls.filter(([command]) => command === "set_user_preference")).toHaveLength(0);
  await act(async () => result.current.flushPreferenceUpdates());
  expect(mocks.invoke.mock.calls.filter(([command]) => command === "set_user_preference")).toEqual([
    ["set_user_preference", { preference: "proxyHost", value: "proxy.example.com" }],
  ]);
});

it("restores the confirmed toggle state when storage rejects a preference", async () => {
  mocks.invoke.mockImplementation((command: string) => {
    if (command === "get_preferences") return Promise.resolve({ keepOnTop: false });
    if (command === "set_user_preference") return Promise.reject(new Error("storage unavailable"));
    return Promise.resolve(undefined);
  });
  const { result } = renderHook(useUserPreferences);
  await act(async () => { await Promise.resolve(); });
  act(() => result.current.setKeepOnTop(true));
  expect(result.current.keepOnTop).toBe(true);
  await waitFor(() => expect(result.current.keepOnTop).toBe(false));
  expect(result.current.preferencesError).toContain("storage unavailable");
});

it("opens the existing custom slot instead of silently overwriting it", async () => {
  setup();
  await screen.findByRole("button", { name: /Custom/ });
  const add = screen.getByRole("button", { name: /添加自定义供应商/ });
  fireEvent.click(add);
  expect(mocks.invoke.mock.calls.some(([command]) => command === "open_add_provider_window")).toBe(false);
  expect(screen.getByText(/当前支持一个自定义接口/)).toBeInTheDocument();
});

it("does not let an old same-batch snapshot erase completed translations", async () => {
  setup("main");
  await act(async () => { await Promise.resolve(); });
  const handler = mocks.listen.mock.calls.find(([name]) => name === "translation-result")![1];
  const row = { providerId: "deepseek", model: "model-a", translation: null, error: null };
  const pending = { source: "hello", requestId: 10, results: [row] };
  act(() => handler({ payload: { ...pending, results: [{ ...row, translation: "已完成的译文" }] } }));
  act(() => handler({ payload: pending }));
  expect(screen.getAllByText("已完成的译文").length).toBeGreaterThan(0);
  expect(screen.queryByText("翻译中…")).not.toBeInTheDocument();
});

it("keeps healthy quick models when another provider config cannot be read", async () => {
  mocks.label = "main";
  mocks.invoke.mockImplementation((command: string, args?: { provider: string }) => {
    if (command === "get_enabled_providers") return Promise.resolve(["deepseek", "xiaomi"]);
    if (command === "get_provider_config") return args?.provider === "deepseek"
      ? Promise.resolve({ model: "healthy-model", models: ["healthy-model"] })
      : Promise.reject(new Error("broken config"));
    return Promise.resolve(undefined);
  });
  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "快速翻译" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "选择翻译模型" })).toHaveTextContent("healthy-model"));
  fireEvent.click(screen.getByRole("button", { name: "选择翻译模型" }));
  expect(screen.getAllByRole("option")).toHaveLength(1);
  expect(screen.getByText(/1 个供应商配置读取失败/)).toBeInTheDocument();
});

it("ignores an initial preference response older than a change event", async () => {
  let resolve!: (value: unknown) => void;
  const initial = new Promise((done) => { resolve = done; });
  mocks.invoke.mockImplementation((command: string) => command === "get_preferences" ? initial : Promise.resolve());
  const { result } = renderHook(useUserPreferences);
  const handler = mocks.listen.mock.calls.find(([name]) => name === "preferences-changed")![1];
  act(() => handler({ payload: { themeMode: "dark", proxyHost: "new.example.com" } }));
  await act(async () => resolve({ themeMode: "light", proxyHost: "old.example.com" }));
  expect(result.current.themeMode).toBe("dark");
  expect(result.current.proxyHost).toBe("new.example.com");
});

it("validates preference payloads while preserving explicit empty and null values", async () => {
  mocks.invoke.mockImplementation((command: string) => command === "get_preferences"
    ? Promise.resolve({ themeMode: "dark", quickTranslateProvider: "deepseek", proxyBypass: "example.com" })
    : Promise.resolve());
  const { result } = renderHook(useUserPreferences);
  await waitFor(() => expect(result.current.quickTranslateProvider).toBe("deepseek"));
  const handler = mocks.listen.mock.calls.find(([name]) => name === "preferences-changed")![1];
  act(() => handler({ payload: { quickTranslateProvider: null, proxyBypass: "", providerOrder: "invalid", themeMode: "invalid", sourceFontSize: {} } }));
  expect(result.current.quickTranslateProvider).toBeNull();
  expect(result.current.proxyBypass).toBe("");
  expect(result.current.themeMode).toBe("dark");
  expect(Array.isArray(result.current.providerOrder)).toBe(true);
  expect(result.current.sourceFontSize).toBe(14);
});


it("rejects flush after a failed save and recovers after that field is saved", async () => {
  let fail = true;
  mocks.invoke.mockImplementation((command: string, args?: { preference: string; value: string }) => {
    if (command === "get_preferences") return Promise.resolve({ proxyHost: "127.0.0.1" });
    if (command === "set_user_preference") return fail
      ? Promise.reject(new Error("disk full")) : Promise.resolve({ [args!.preference]: args!.value });
    return Promise.resolve(undefined);
  });
  const { result } = renderHook(useUserPreferences);
  await act(async () => { await Promise.resolve(); });
  act(() => result.current.setProxyHost("proxy.example.com"));
  await act(async () => { await expect(result.current.flushPreferenceUpdates()).rejects.toThrow("disk full"); });
  expect(result.current.proxyHost).toBe("127.0.0.1");
  expect(result.current.preferencesError).toContain("disk full");
  fail = false;
  act(() => result.current.setProxyHost("proxy.example.com"));
  await act(async () => { await result.current.flushPreferenceUpdates(); });
  expect(result.current.proxyHost).toBe("proxy.example.com");
  expect(result.current.preferencesError).toBe("");
});
