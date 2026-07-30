# 单一小浮标 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将选中文本浮标改为无外层容器的 24 × 24 圆形单图标。

**Architecture:** 前端 `SelectionFloat` 仅渲染其可点击按钮，CSS 直接定义该按钮的圆形视觉。Rust 使用同一 24 像素常量创建浮标窗口并钳制位置，使窗口、视觉和鼠标命中区域一致。

**Tech Stack:** React 19、TypeScript、Vitest、Tauri 2、Rust。

## Global Constraints

- 浮标窗口与按钮均为 `24 × 24` 逻辑像素。
- 删除当前 `36 × 36` 外层容器和其深色背景。
- 保留翻译点击、显示/隐藏、移动规则与 Alt+T 行为。
- 不增加依赖；保持 Windows 11 与 Tauri 2 支持。

---

### Task 1: 单一圆形浮标

**Files:**
- Modify: `src/App.test.tsx`
- Modify: `src/SelectionFloat.tsx`
- Modify: `src/App.css`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `SelectionFloat` 的 `translate_selection_float` 命令和 `FLOAT_SIZE` 位置钳制逻辑。
- Produces: 仅一个具有 `selection-float-button` 类的按钮；该按钮仍调用 `translate_selection_float`。

- [ ] **Step 1: 写入失败测试，断言浮标视图没有包装容器**

在 `src/App.test.tsx` 的浮标路由测试中加入：

```tsx
const button = screen.getByRole("button", { name: "翻译选中文本" });
expect(button).toHaveClass("selection-float-button");
expect(button.parentElement?.classList.contains("selection-float")).toBe(false);
```

- [ ] **Step 2: 运行测试，确认旧实现失败**

运行：`npm.cmd test -- --run src/App.test.tsx`

预期：新断言失败，因为旧按钮的父元素拥有 `selection-float` 类。

- [ ] **Step 3: 实现最小改动**

将 `SelectionFloat` 返回的外层 `<div className="selection-float">` 删除，使按钮成为唯一根元素；删除 `.selection-float` 样式，并将 `.selection-float-button` 设为：

```css
width: 24px;
height: 24px;
border-radius: 50%;
```

保留图标颜色、渐变、阴影、悬停亮度和禁用态。把 `src-tauri/src/lib.rs` 的 `const FLOAT_SIZE: i32` 从 `36` 改为 `24`。

- [ ] **Step 4: 运行针对性与完整验证**

运行：

```powershell
npm.cmd test -- --run
npm.cmd run build
cargo test --all-targets
cargo check
cargo build
git diff --check
```

预期：前端 3 个及以上测试、Rust 测试、构建和空白检查均成功。

- [ ] **Step 5: 提交**

```powershell
git add src/App.test.tsx src/SelectionFloat.tsx src/App.css src-tauri/src/lib.rs
git commit -m "feat: compact selection float to a single icon"
```
