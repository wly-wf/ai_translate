# AI Translate

## 鼠标选中文本翻译

鼠标选中文本后，应用会显示一个悬浮的翻译按钮。它优先使用 Windows UI Automation 读取选区；如果当前窗口不支持 UI Automation，则使用 `Ctrl + C` 复制作为兜底。由于安全限制，以更高权限运行的（如管理员权限）窗口可能无法获取选区或显示悬浮按钮。

Windows 11 上的轻量级 DeepSeek 快捷翻译工具。使用 Tauri 2、Rust 与 React 构建。

## 已实现

- `Alt + T` 读取系统剪贴板中的纯文本并翻译。
- 调用 DeepSeek `deepseek-v4-flash`，关闭 thinking 以缩短取词翻译等待时间。
- 无边框、置顶、可隐藏的翻译结果浮窗；可复制译文。
- 手动输入翻译，便于在未复制文本时使用。
- API Key 使用 Windows Credential Manager 保存，不写入项目文件或浏览器本地存储。

## 运行

```powershell
cd D:\AI\ai_project\ai_translate\translator
npm.cmd run tauri dev
```

首次打开后，点击右上角齿轮图标保存 DeepSeek API Key。之后复制任意文本并按 `Alt + T` 即可翻译。

## 验证

```powershell
npm.cmd run build
cd src-tauri
cargo check
```

## 下一阶段

“鼠标选中后显示翻译按钮”尚未实现。它需要 Windows UI Automation 与鼠标事件处理，且应以可选增强方式实现：只有成功获得选区文本和位置时才显示按钮，失败时继续保留快捷键路径。
