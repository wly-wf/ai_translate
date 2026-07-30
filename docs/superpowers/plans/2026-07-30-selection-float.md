# 选中文本翻译浮标 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Windows 11 上为鼠标选中文本显示持续存在、可移动并可触发翻译的浮标。

**Architecture:** 将平台无关的浮标状态拆为可单测的 Rust 状态机；Windows 层负责鼠标抬起事件、UI Automation 和剪贴板兜底；Tauri 创建独立浮标 Webview 窗口，React 按窗口标签渲染浮标或既有结果界面。原有 `translate_and_display` 是唯一的翻译入口。

**Tech Stack:** Tauri 2、Rust、`windows` crate、React 19、TypeScript、现有 DeepSeek API 与 Tauri clipboard/global-shortcut 插件。

## Global Constraints

- 仅支持 Windows 桌面端；不实现 OCR、翻译历史或多服务商。
- 浮标不会因超时消失；仅普通点击且没有有效新选区时隐藏。
- 新选区必须替换文本并移动同一个浮标。
- 优先 UI Automation，失败才使用 `Ctrl+C` 和纯文本剪贴板兜底。
- 单次文本最多 12,000 字符；不满足时不显示浮标。
- 既有 `Alt + T` 取词翻译必须保持可用。
- 管理员权限窗口不作为兼容性验收条件。

---

## File Structure

- Create: `src-tauri/src/selection_state.rs` — 与 Windows API 解耦的浮标状态机及单元测试。
- Create: `src-tauri/src/windows_selection.rs` — UI Automation 取词、矩形读取和剪贴板兜底。
- Create: `src-tauri/src/mouse_hook.rs` — `WH_MOUSE_LL` 鼠标抬起事件和后台消息循环。
- Create: `src/SelectionFloat.tsx` — 标签为 `selection-float` 时渲染的浮标按钮。
- Modify: `src-tauri/Cargo.toml` — 添加直接使用的 `windows` crate feature。
- Modify: `src-tauri/src/lib.rs` — 创建浮标窗口、连接状态机/鼠标服务、暴露浮标点击命令。
- Modify: `src/App.tsx` — 按当前窗口标签选择渲染浮标或主结果窗口。
- Modify: `src/App.css` — 主窗口样式与浮标样式隔离。
- Modify: `src-tauri/capabilities/default.json` — 允许 `main` 与 `selection-float` 使用所需窗口和 invoke 权限。
- Modify: `README.md` — 说明选区浮标的兼容范围与手动验证方法。

## Task 1: 可测试的浮标状态机

**Files:**
- Create: `src-tauri/src/selection_state.rs`
- Modify: `src-tauri/src/lib.rs:1-12`

**Interfaces:**
- Produces: `pub struct Selection { pub text: String, pub anchor: Anchor, pub generation: u64 }`。
- Produces: `pub struct Anchor { pub x: i32, pub y: i32 }`。
- Produces: `pub enum StateChange { Show(Selection), Hide, Unchanged }`。
- Produces: `pub struct SelectionController` with `replace_selection`, `clear_after_plain_click`, and `take_for_translation`.

- [ ] **Step 1: 写入失败单测**

```rust
#[test]
fn new_selection_replaces_visible_selection() {
    let mut controller = SelectionController::default();
    controller.replace_selection("first".into(), Anchor { x: 1, y: 1 });
    let change = controller.replace_selection("second".into(), Anchor { x: 2, y: 2 });

    assert_eq!(change, StateChange::Show(Selection {
        text: "second".into(), anchor: Anchor { x: 2, y: 2 }, generation: 2,
    }));
}

#[test]
fn plain_click_hides_visible_float_but_clicking_float_does_not() {
    let mut controller = visible_controller("selected");
    assert_eq!(controller.clear_after_plain_click(false), StateChange::Hide);

    let mut controller = visible_controller("selected");
    assert_eq!(controller.clear_after_plain_click(true), StateChange::Unchanged);
}

#[test]
fn float_click_returns_exact_saved_text_once() {
    let mut controller = visible_controller("selected");
    assert_eq!(controller.take_for_translation(), Some("selected".into()));
    assert_eq!(controller.take_for_translation(), None);
}
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cargo test selection_state --lib`

Expected: FAIL，提示 `selection_state` 或 `SelectionController` 未定义。

- [ ] **Step 3: 实现最小状态机**

```rust
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Anchor { pub x: i32, pub y: i32 }

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Selection { pub text: String, pub anchor: Anchor, pub generation: u64 }

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StateChange { Show(Selection), Hide, Unchanged }

#[derive(Default)]
pub struct SelectionController { current: Option<Selection>, next_generation: u64 }

impl SelectionController {
    pub fn replace_selection(&mut self, text: String, anchor: Anchor) -> StateChange {
        self.next_generation += 1;
        let selection = Selection { text, anchor, generation: self.next_generation };
        self.current = Some(selection.clone());
        StateChange::Show(selection)
    }

    pub fn clear_after_plain_click(&mut self, clicked_float: bool) -> StateChange {
        if clicked_float || self.current.is_none() {
            StateChange::Unchanged
        } else {
            self.current = None;
            StateChange::Hide
        }
    }

    pub fn take_for_translation(&mut self) -> Option<String> {
        self.current.take().map(|selection| selection.text)
    }
}

#[cfg(test)]
fn visible_controller(text: &str) -> SelectionController {
    let mut controller = SelectionController::default();
    controller.replace_selection(text.to_owned(), Anchor { x: 0, y: 0 });
    controller
}
```

- [ ] **Step 4: 运行状态机测试**

Run: `cargo test selection_state --lib`

Expected: PASS，3 个测试全部通过。

- [ ] **Step 5: 提交状态机**

```powershell
git add src-tauri/src/selection_state.rs src-tauri/src/lib.rs
git commit -m "feat: add selection float state machine"
```

## Task 2: Windows 选区获取与鼠标抬起服务

**Files:**
- Create: `src-tauri/src/windows_selection.rs`
- Create: `src-tauri/src/mouse_hook.rs`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/lib.rs:1-12`

**Interfaces:**
- Consumes: `selection_state::Anchor`。
- Produces: `pub struct CapturedSelection { pub text: String, pub anchor: Anchor }`。
- Produces: `pub fn capture_selection(point: POINT) -> Result<Option<CapturedSelection>, CaptureError>`。
- Produces: `pub fn start_mouse_hook(on_mouse_up: impl Fn(POINT) + Send + Sync + 'static) -> Result<(), HookError>`。

- [ ] **Step 1: 添加直接依赖并写捕获选择的失败测试桩**

在 `Cargo.toml` 添加：

```toml
windows = { version = "0.61", features = [
  "Win32_Foundation",
  "Win32_System_Com",
  "Win32_UI_Accessibility",
  "Win32_UI_Input_KeyboardAndMouse",
  "Win32_UI_WindowsAndMessaging"
] }
```

在 `windows_selection.rs` 添加 Windows-only 测试桩，验证空结果不会产生浮标输入：

```rust
#[test]
fn empty_selection_is_not_a_capture() {
    assert!(CapturedSelection::from_parts("  ".into(), vec![]).is_none());
}
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cargo test empty_selection_is_not_a_capture --lib`

Expected: FAIL，提示 `CapturedSelection` 未定义。

- [ ] **Step 3: 实现 UI Automation 优先捕获**

实现 `capture_selection`：初始化 COM，使用鼠标坐标取得 UI Automation 元素，读取 `IUIAutomationTextPattern::GetSelection`，以 `GetText` 获取文本、以 `GetBoundingRectangles` 获取矩形；丢弃空文本、不可见矩形及超过 12,000 字符的结果。最后一个有效矩形的 `(left + width, top)` 作为 `Anchor`。

在不支持 TextPattern 时调用 `copy_fallback`：记录 `GetClipboardSequenceNumber` 和纯文本快照，使用 `SendInput` 发送 Ctrl+C，短暂重试读取新文本；仅当序列号仍是本次复制后的值时恢复原纯文本。失败返回 `Ok(None)`，不显示错误窗口。

- [ ] **Step 4: 实现全局鼠标事件**

在专用线程安装 `WH_MOUSE_LL`，仅在 `WM_LBUTTONUP` 将 `MSLLHOOKSTRUCT.pt` 交给回调。回调通过 `tauri::async_runtime::spawn` 等待 120 ms 后调用 `capture_selection`；不要在 hook 回调内运行 COM 或网络操作。

```rust
if wparam.0 as u32 == WM_LBUTTONUP {
    let point = unsafe { (*(lparam.0 as *const MSLLHOOKSTRUCT)).pt };
    callback(point);
}
```

- [ ] **Step 5: 运行测试与编译检查**

Run: `cargo test --lib`

Expected: PASS。

Run: `cargo check`

Expected: PASS。

- [ ] **Step 6: 提交 Windows 捕获服务**

```powershell
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/windows_selection.rs src-tauri/src/mouse_hook.rs src-tauri/src/lib.rs
git commit -m "feat: capture text selections on Windows"
```

## Task 3: 独立浮标窗口与 React 渲染

**Files:**
- Create: `src/SelectionFloat.tsx`
- Modify: `src/App.tsx`
- Modify: `src/App.css`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/capabilities/default.json`

**Interfaces:**
- Consumes: Rust event `selection-float:show` with `{ generation: number }` and `selection-float:hide`。
- Consumes: Rust command `translate_selection_float()`。
- Produces: `SelectionFloat` React component that invokes `translate_selection_float` once per click.
- Produces: `show_float(anchor: Anchor, generation: u64)` and `hide_float()` in Rust.

- [ ] **Step 1: 写前端窗口路由的失败测试**

添加 `src/App.test.tsx`，mock `getCurrentWebviewWindow`，验证标签为 `selection-float` 时不渲染“快速翻译”文本而渲染可访问名称为“翻译选中文本”的按钮：

```tsx
it("renders the float for the selection-float window", () => {
  mockWindowLabel("selection-float");
  render(<App />);
  expect(screen.getByRole("button", { name: "翻译选中文本" })).toBeInTheDocument();
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npm.cmd test -- --run src/App.test.tsx`

Expected: FAIL，因为测试脚本、`SelectionFloat` 或窗口标签路由尚不存在。

- [ ] **Step 3: 添加前端测试运行器并实现窗口路由**

添加 Vitest、Testing Library 和 `test` 脚本；创建 `SelectionFloat.tsx`。它只显示一个图标按钮，点击时禁用自身并调用：

```ts
await nativeInvoke("translate_selection_float");
```

在 `App.tsx` 读取当前 Webview 窗口标签；当标签为 `selection-float` 时仅渲染 `<SelectionFloat />`，否则保留现有主窗口。

- [ ] **Step 4: 创建与控制浮标窗口**

在 `run().setup` 用 `WebviewWindowBuilder` 创建标签 `selection-float` 的窗口：初始隐藏、无装饰、透明、置顶、跳过任务栏、固定约 36×36 px。为其加载同一前端资源，并通过标签渲染浮标组件。

`show_float` 应先设置位置再 `show()`；`hide_float` 调用 `hide()`。依据监视器工作区夹紧 `(anchor.x + 8, anchor.y - 8)`，避免窗口右侧或上侧溢出。

- [ ] **Step 5: 运行前端测试与生产构建**

Run: `npm.cmd test -- --run`

Expected: PASS。

Run: `npm.cmd run build`

Expected: PASS。

- [ ] **Step 6: 提交浮标窗口**

```powershell
git add package.json package-lock.json src/App.tsx src/App.css src/SelectionFloat.tsx src/App.test.tsx src-tauri/src/lib.rs src-tauri/capabilities/default.json
git commit -m "feat: add selection float window"
```

## Task 4: 连接状态机、翻译命令与回归验收

**Files:**
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/mouse_hook.rs`
- Modify: `README.md`

**Interfaces:**
- Consumes: `start_mouse_hook`, `capture_selection`, `SelectionController`, `show_float`, `hide_float`。
- Produces: `#[tauri::command] async fn translate_selection_float(app: AppHandle) -> Result<(), String>`。

- [ ] **Step 1: 写命令行为的失败单测**

将处理逻辑抽到 `handle_mouse_up(controller, captured, clicked_float)` 并测试：

```rust
#[test]
fn plain_click_after_a_visible_selection_hides_the_float() {
    let mut controller = visible_controller("one");
    assert_eq!(handle_mouse_up(&mut controller, None, false), StateChange::Hide);
}

#[test]
fn replacement_selection_keeps_the_float_visible() {
    let mut controller = visible_controller("one");
    let captured = CapturedSelection { text: "two".into(), anchor: Anchor { x: 20, y: 30 } };
    assert!(matches!(handle_mouse_up(&mut controller, Some(captured), false), StateChange::Show(_)));
}
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cargo test handle_mouse_up --lib`

Expected: FAIL，提示处理函数尚未定义。

- [ ] **Step 3: 连接事件与翻译**

用 `Mutex<SelectionController>` 管理应用状态。鼠标事件调用 `handle_mouse_up`：`Show` 时保存新文本并显示/移动浮标，`Hide` 时隐藏浮标，`Unchanged` 不操作。

`translate_selection_float` 从状态机 `take_for_translation()` 取出文本；无文本时返回 `Err("没有待翻译的选中文本。")`。有文本时先隐藏浮标，再调用既有 `translate_and_display(app, text)`。不得从浮标窗口重新读取剪贴板或 UI Automation。

- [ ] **Step 4: 运行 Rust 自动测试**

Run: `cargo test --lib`

Expected: PASS，状态机与集成处理测试全部通过。

- [ ] **Step 5: 手动验收与更新 README**

关闭现有开发实例后运行 `npm.cmd run tauri dev`，依次验证：

1. 在记事本选择文字，浮标出现。
2. 保持不动 10 秒，浮标仍显示。
3. 选择另一段文字，浮标移动。
4. 点击浮标，显示正确译文。
5. 点击空白和切换应用，浮标消失。
6. 复制文字并按 `Alt + T`，既有翻译路径仍可用。

在 README 记录：优先 UI Automation、复制兜底，以及管理员权限窗口可能不支持。

- [ ] **Step 6: 执行最终构建与提交**

Run: `npm.cmd run build`

Expected: PASS。

Run: `cargo build`

Expected: PASS。

```powershell
git add README.md src-tauri/src/lib.rs src-tauri/src/mouse_hook.rs
git commit -m "feat: translate selected text from float"
```
