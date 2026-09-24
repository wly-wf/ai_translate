# AI Translate

面向 Windows 11 的开源桌面 AI 翻译工具。选中文本后点击悬浮按钮，即可查看多个模型的翻译结果；也可以手动输入文本，使用快速翻译。

基于 **Tauri 2 · Rust · React 19 · TypeScript** 构建，支持自备 API Key 和 OpenAI 兼容接口。

> Windows 免安装版以 ZIP 压缩包在 [Releases](https://github.com/wly-wf/ai_translate/releases) 发布。本项目不提供 API Key 或免费模型额度。

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

## 获取与使用

应用依赖 Microsoft Edge WebView2 Runtime。Windows 11 通常已包含该组件；如果启动时提示缺失，请安装 [WebView2 Runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/)。

从 Releases 下载 Windows x64 免安装版 ZIP，解压到任意目录，保持 `translator.exe` 和 `WebView2Loader.dll` 在同一目录，然后双击 EXE 运行。程序不会创建安装目录或开始菜单快捷方式，会常驻系统托盘；左键点击托盘图标打开快速翻译，右键点击进入设置或退出。

首次使用：

1. 通过托盘右键菜单打开「设置」，进入「供应商」。
2. 选择内置供应商，或点击「添加自定义供应商」。填写 API Key、API 地址和至少一个模型名称。部分服务支持「获取」模型列表，也可手动填写。
3. 使用「测试连接」确认配置，然后打开供应商右上角的开关。
4. 在其他应用中选中文本并点击悬浮按钮，或左键点击托盘图标手动输入文本。

可以同时启用多个供应商。模型列表需要至少保留一个已配置模型；如需停止调用某个供应商，请关闭其开关。

## 本地开发

### 环境

- Windows 11。目前实现依赖 Windows API，尚未支持 macOS / Linux。
- Node.js 22.12 或更高版本及 npm。
- Rust stable 和对应的本机构建工具链；使用 MSVC 时需要 Visual Studio Build Tools 的 C++ 桌面开发工具及 Windows SDK。
- Microsoft Edge WebView2 Runtime。
- Git。

### 从源码运行

```powershell
git clone https://github.com/wly-wf/ai_translate.git
cd ai_translate
npm ci
npm run tauri -- dev
```

开发服务器使用 `1420` 端口，启动前请确认端口未被占用。PowerShell 如限制执行 npm 脚本，可将命令中的 `npm` 替换为 `npm.cmd`。

`npm run dev` 仅启动浏览器界面预览。划词、凭据保存和翻译等桌面功能需要通过 `npm run tauri dev` 运行。

### 构建可执行程序

```powershell
npm run tauri -- build --no-bundle
```

当前 GNU 工具链的构建结果位于 `src-tauri/target/release/`。发布时将 `translator.exe` 与同目录的 `WebView2Loader.dll` 放入同一个 ZIP；解压后保持两个文件在同一目录。只复制 EXE 会因缺少 DLL 而无法启动。当前配置不生成安装包。目标系统仍需 Microsoft Edge WebView2 Runtime。

默认构建未进行 Windows 代码签名，下载后可能出现发布者或 SmartScreen 提示。如需签名，请参考 [Tauri 的 Windows 签名说明](https://v2.tauri.app/distribute/sign/windows/)，并在签名后计算最终文件的哈希。程序内「关于」页面包含开源许可和第三方图标声明。

### 检查与测试

```powershell
npm test -- --run
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
```

真实 API 回归测试默认标记为忽略，不随普通测试执行；显式运行它们会使用本机已保存的凭据并产生 API 调用及可能的费用。发布前还应在干净的 Windows 11 环境中手动验证首次运行、退出、托盘、划词、设置保存及至少一个实际服务商的翻译。

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

- 发起翻译时，待翻译文本会发送到你配置并启用的服务商；服务商可能收费并按自己的政策处理数据。不要翻译不希望发送给该服务商的敏感文本。
- API Key、代理凭据及设置保存在 Windows Credential Manager 中；WebView 的本地存储仅缓存外观设置。卸载应用不一定清除 Windows 中已保存的凭据。
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

**首次打开设置比启动慢？**

设置窗口在首次打开时创建，后续打开会复用，以减少程序空闲时的资源占用。

## 反馈与贡献

欢迎通过 [Issues](https://github.com/wly-wf/ai_translate/issues) 提交问题或建议，也欢迎提交 Pull Request。提交前请先查看是否已有相同问题，并描述复现步骤与预期行为。

报告问题时请提供 Windows 版本、应用版本、复现步骤、预期与实际表现，以及必要的截图。提交截图或日志前请移除 API Key、代理密码和私人文本。修改代码后请运行相关检查；涉及划词或窗口交互的修改，还需要在 Windows 桌面进行手动验证。

## 发布维护者检查

1. 同步 `package.json`、`src-tauri/Cargo.toml` 与 `src-tauri/tauri.conf.json` 中的版本号。
2. 运行上面的自动化检查，并在干净的 Windows 11 环境中验证可执行文件及主要功能。
3. 构建便携版 ZIP，并在解压后的目录验证启动及主要功能；如使用代码签名，先签署 EXE，再重新生成 ZIP 并计算最终 ZIP 的 SHA-256 哈希。
4. 在 [Releases](https://github.com/wly-wf/ai_translate/releases) 发布 ZIP、版本说明和已知限制。此仓库目前没有配置自动更新，后续版本需要手动下载替换。

## 许可证

本项目源代码采用 [MIT 许可证](LICENSE)。供应商名称和标识属于各自权利人；项目内供应商图标的来源见 [图标声明](src/assets/providers/NOTICE.md)，不因本项目采用 MIT 许可证而改变其原有权利归属。
