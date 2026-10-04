# Windows 构建指南

## 1. 前提

- Windows x64
- Git
- Node.js 22.x
- Corepack
- Visual Studio 2022 / Build Tools，含：
  - MSVC v143 x86/x64 工具
  - Windows SDK
  - 与当前 MSVC 对应的 x86/x64 Spectre-mitigated libraries
- 能访问 npm、GitHub Release、Microsoft VC Redistributable 下载地址

本机 M0 使用 VS 2022 17.14、MSVC 14.44；对应 Spectre 组件 ID 为：

```text
Microsoft.VisualStudio.Component.VC.14.44.17.14.x86.x64.Spectre
```

其他 MSVC 版本应选择与其版本匹配的组件，不能机械复用此 ID。

## 2. 首次准备

在项目根目录执行：

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm run bootstrap:fetch -- --platform win-x64
```

`bootstrap:fetch` 使用官方预构建资源，得到 Desktop 安装器使用的 bootstrap Python、uv 和 pygit2。它不会创建 `C:\FR_comfyui_next`。

## 3. 日常质量检查

插件依赖解析测试需要完整 Python 标准库和 `packaging`；真实 Git 集成测试还需要
`pygit2`。使用独立测试解释器，并通过 `FR_TEST_PYTHON` 指定其绝对路径；通过
`FR_TEST_UV` 指定 uv 可执行文件。测试仅操作合成目录，不安装或更新真实 ComfyUI。
发行包中的裁剪版 bootstrap Python 不适合执行这些 unittest 用例。

```powershell
$env:FR_TEST_PYTHON = '<完整测试 Python 的绝对路径>'
$env:FR_TEST_UV = '<uv.exe 的绝对路径>'
corepack pnpm run typecheck
corepack pnpm run lint
corepack pnpm run test
corepack pnpm run test:integration
corepack pnpm run build
```

仓库采用零容忍 flaky test 规则。失败时应定位原因，不能用重试掩盖。

## 4. Windows 安装包

```powershell
corepack pnpm run build:win
```

产物位于 `dist`。FR 配置生成 `FR-ComfyUI-ControlCenter-<version>-win-x64.exe`、对应 blockmap 和 `win-unpacked` 目录。未配置 FR 发布渠道时不会发布或上传产物。

electron-builder 的签名工具压缩包包含符号链接。满足以下任一条件即可：

- Windows 已启用开发者模式，允许普通用户创建符号链接；或
- 在管理员终端执行 `build:win`。

M0 为避免改变全局开发者设置，采用管理员终端完成打包。日常 `typecheck`、`lint`、测试和普通生产构建不需要管理员权限。

## 5. 常见故障

### MSB8040 / Spectre-mitigated libraries required

原因：`node-pty` 原生模块启用了 Spectre 缓解，但 Visual Studio 仅安装了普通 MSVC 库。安装与当前 MSVC 小版本对应的 x86/x64 Spectre 库后重建。不要通过关闭依赖的 Spectre 选项来掩盖缺失工具链。

### Cannot create symbolic link / 客户端没有所需权限

原因：electron-builder 解压 winCodeSign 工具时需要创建符号链接。启用 Windows 开发者模式，或仅让安装包构建在管理员终端运行。

### bootstrap 下载长时间为 0

优先使用官方预构建命令：

```powershell
corepack pnpm run bootstrap:fetch -- --platform win-x64
```

不要把下载失败误判为 Python 或项目源码问题。

### pnpm 版本漂移

始终以 `corepack pnpm` 调用，遵守 `package.json` 的 `packageManager` 版本；不要用全局 pnpm 更新锁文件。

## 6. 边界

构建过程不得把测试配置、bootstrap 资源或应用数据写入 `C:\FR_comfyui`。任何涉及 `C:\FR_comfyui_next`、共享模型映射或真实用户数据的测试，必须等对应里程碑批准并使用 dry-run/合成目录。
