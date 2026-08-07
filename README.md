# AI Translate

## 鼠标选中文本翻译

鼠标选中文本后，应用会显示一个悬浮的翻译按钮。它优先使用 Windows UI Automation 读取选区；如果当前窗口不支持 UI Automation，则使用 `Ctrl + C` 复制作为兜底。由于安全限制，以更高权限运行的（如管理员权限）窗口可能无法获取选区或显示悬浮按钮。

Windows 11 上的轻量级多模型翻译工具。使用 Tauri 2、Rust 与 React 构建。

## 已实现

- 鼠标选中文本后显示悬浮翻译按钮；新选区会移动并更新同一个按钮。
- 可在设置中同时启用 DeepSeek、小米 MiMo、Qwen、智谱 GLM、Moonshot Kimi、OpenAI、Google Gemini 或 Anthropic Claude；翻译时会并发请求所有启用模型，哪个模型先完成就先展示哪个结果。翻译请求统一关闭或不启用深度思考，以缩短取词翻译等待时间。
- 无边框、置顶、可隐藏的翻译结果浮窗；可复制译文。
- 手动输入翻译，便于在未复制文本时使用。
- API Key 使用 Windows Credential Manager 保存，不写入项目文件或浏览器本地存储。

## 运行

```powershell
cd D:\AI\ai_project\ai_translate\translator
npm.cmd run tauri dev
```

首次打开后，点击右上角菜单，在“供应商”中保存 API Key、URL 和模型名称，再点击“加入翻译”。可以用相同方式启用多个模型；之后选中文本并点击悬浮翻译按钮，即可同时查看多个模型的译文，也可以从悬浮翻译窗口进入快速翻译并手动输入文本。

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

管理员权限窗口受 Windows UIPI 限制，只记录实际表现，不作为通过条件。
