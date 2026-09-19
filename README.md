# AI Translate

面向 Windows 11 的桌面 AI 翻译工具。选中文本后点击悬浮按钮，即可查看多个模型的翻译结果；也可以手动输入文本，使用快速翻译。

基于 **Tauri 2 · Rust · React 19 · TypeScript** 构建，支持自备 API Key 和 OpenAI 兼容接口。

## 功能

- **划词翻译**：选中文本后显示悬浮按钮，点击发起翻译，可通过托盘菜单开关。
- **多模型对照**：同时启用多个供应商和模型，各模型完成后独立展示结果，最多并发请求 4 个模型。
- **快速翻译**：手动输入文本，并可设置默认模型。
- **供应商管理**：配置密钥、接口地址和模型，支持获取模型列表、测试连接、启停与排序。
- **自定义接口**：添加多个 OpenAI 兼容供应商，独立管理配置。
- **外观与网络**：浅色、深色及跟随系统主题，主题色、字号、置顶、开机启动和代理设置。
- **本地凭据存储**：API Key 通过 Windows Credential Manager 保存，不写入项目文件或浏览器本地存储。

## 支持的服务

| 类型 | 供应商 / 协议 |
| --- | --- |
| 内置供应商 | DeepSeek、Xiaomi MiMo、阿里云百炼、智谱开放平台、Moonshot |
| 自定义供应商 | 兼容 OpenAI Chat Completions 协议的服务 |

需要自行准备服务商的 API Key，接口调用费用由对应服务商收取。Gemini、Claude 原生协议目前未接入；如需使用，需通过兼容网关。

## 开始使用

1. 启动桌面程序，通过托盘右键菜单进入设置。
2. 打开「供应商」，选择内置供应商，或点击「添加自定义供应商」。
3. 填写 API Key、API 地址和模型名称；支持的服务可通过「获取」读取模型列表，也可手动添加。
4. 使用「测试连接」确认配置，再打开供应商右上角的开关，将其加入翻译。
5. 在其他应用中选中文本，点击悬浮翻译按钮；也可从翻译窗口进入快速翻译并手动输入。

可以同时启用多个供应商。模型列表需要至少保留一个已配置模型；如需停止调用某个供应商，请关闭其开关。

## 本地开发

### 环境

- Windows 11。目前实现依赖 Windows API，尚未支持 macOS / Linux。
- Node.js 22.12 或更高版本及 npm。
- Rust stable 和对应的本机构建工具链；使用 MSVC 时需要 Visual Studio Build Tools 的 C++ 桌面开发工具及 Windows SDK。
- Microsoft Edge WebView2 Runtime。
- Git。

### 安装与启动

```powershell
git clone https://github.com/wly-wf/ai_translate.git
cd ai_translate
npm ci
npm run tauri dev
```

开发服务器使用 `1420` 端口，启动前请确认端口未被占用。PowerShell 如限制执行 npm 脚本，可将命令中的 `npm` 替换为 `npm.cmd`。

`npm run dev` 仅启动浏览器界面预览。划词、凭据保存和翻译等桌面功能需要通过 `npm run tauri dev` 运行。

### 构建可执行程序

```powershell
npm run tauri -- build --no-bundle
```

默认构建输出为 `src-tauri/target/release/translator.exe`。运行环境需要安装 WebView2 Runtime。

如需生成安装包，使用支持对应打包目标的 Windows 工具链运行：

```powershell
npm run tauri -- build
```

安装包输出到 `src-tauri/target/release/bundle/`。首次打包可能需要下载打包工具。

### 检查与测试

```powershell
npm test -- --run
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
```

真实 API 回归测试默认标记为忽略，不随普通测试执行；显式运行它们会使用本机已保存的凭据并产生 API 调用。

## 项目结构

```text
src/
  MainWindow.tsx          翻译结果与快速翻译
  SettingsWindow.tsx      供应商、偏好和代理设置
  AddProviderWindow.tsx   自定义供应商窗口
  SelectionFloat.tsx      划词悬浮按钮
  sharedUI.tsx            共享界面组件
src-tauri/
  src/                   窗口、取词、凭据、网络与翻译逻辑
  tauri.conf.json         桌面应用与打包配置
```

`docs/` 用于本地工作文档，已加入 `.gitignore`，不纳入后续提交。

## 数据与行为说明

- 发起翻译时，待翻译文本会发送到你配置并启用的服务商。请按对应服务的数据政策选择接口。
- 取词优先使用 Windows UI Automation；目标控件不提供可用选区时，在符合条件的场景下临时使用 `Ctrl+C` 读取文本，并尝试安全恢复原剪贴板。
- 新翻译批次会取消旧批次的本地任务；服务端已经收到的请求不保证被取消。
- 对 DeepSeek、Xiaomi MiMo 和阿里云百炼的翻译请求会发送关闭思考的参数，其他服务使用供应商默认行为。
- 英文译文发现未允许的中文残留时，最多额外调用一次模型进行纠正。这项检查不保证翻译语义完全准确。

## 当前限制与常见问题

**选中文本后没有出现按钮？**

先确认托盘菜单中的划词翻译已开启。取词效果取决于目标应用的文本可访问性；图片、画布、部分编辑器、终端和高权限窗口可能无法获取选区。目前不支持截图 OCR，可使用快速翻译手动输入。

**接口能访问，但测试连接或获取模型失败？**

检查密钥、模型权限、地址和代理配置。API 请求不跟随重定向，请填写最终接口地址；部分兼容服务不支持列出模型，可手动填写模型名称。

**代理已打开，但应用仍无法连接？**

在「网络代理」中检查所选模式。「系统」模式读取 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY` 等环境代理配置；也可以选择自定义代理并测试连接。

**启动后找不到窗口？**

应用使用系统托盘入口；检查任务栏的隐藏图标区域。应用按单实例运行，重复启动不会创建第二个独立实例。

## 反馈与贡献

欢迎通过 [Issues](https://github.com/wly-wf/ai_translate/issues) 提交问题或建议，也欢迎提交 Pull Request。

报告问题时请提供 Windows 版本、复现步骤、预期与实际表现，以及必要的截图。提交截图或日志前请移除 API Key、代理密码和私人文本。修改代码后请运行相关检查；涉及划词或窗口交互的修改，还需要在 Windows 桌面进行手动验证。

## 许可证

仓库目前尚未配置 `LICENSE` 文件，许可证待维护者确定。
