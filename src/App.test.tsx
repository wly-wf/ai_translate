import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

let windowLabel = "main";

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ label: windowLabel }),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));

import App from "./App";

function mockWindowLabel(label: string) {
  windowLabel = label;
}

describe("App", () => {
  beforeEach(() => {
    mockWindowLabel("main");
  });

  it("routes the selection-float window to the translate-selection control", () => {
    mockWindowLabel("selection-float");

    render(<App />);

    expect(screen.getByRole("button", { name: "翻译选中文本" })).toBeInTheDocument();
    expect(screen.queryByText("快速翻译")).not.toBeInTheDocument();
  });
});
