# AI Translate

## 鼠标选中文本翻译

鼠标选中文本后，应用会显示一个悬浮的翻译按钮。它优先使用 Windows UI Automation 读取选区；如果当前窗口不支持 UI Automation，则使用 `Ctrl + C` 复制作为兜底。由于安全限制，以更高权限运行的（如管理员权限）窗口可能无法获取选区或显示悬浮按钮。

Windows 11 上的轻量级 DeepSeek 快捷翻译工具。使用 Tauri 2、Rust 与 React 构建。

## 已实现

- `Alt + T` 读取系统剪贴板中的纯文本并翻译。
- 鼠标选中文本后显示悬浮翻译按钮；新选区会移动并更新同一个按钮。
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

## Windows 11 手动验收

以下桌面兼容性项目需要在没有其他进程占用 Vite `1420` 端口时运行 `npm.cmd run tauri dev` 验证；当前状态为待验收：

| 场景 | 状态 |
| --- | --- |
| 记事本单行选区 | 待验收 |
| 浏览器文本选区 | 待验收 |
| 跨行选区与最后一行定位 | 待验收 |
| 屏幕边缘位置夹紧 | 待验收 |
| 新选区替换旧选区 | 待验收 |
| 空白点击隐藏悬浮按钮 | 待验收 |
| 点击悬浮按钮翻译并显示结果或错误 | 待验收 |
| `Alt + T` 剪贴板翻译回归 | 待验收 |

管理员权限窗口受 Windows UIPI 限制，只记录实际表现，不作为通过条件。
