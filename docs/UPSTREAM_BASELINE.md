# 上游基线记录

## 仓库

- 上游：`https://github.com/Comfy-Org/Comfy-Desktop.git`
- 本地目录：`D:\FR_AI\FR-ComfyUI-ControlCenter`
- 上游远程名：`upstream`
- 本地分支：`main`，跟踪 `upstream/main`
- 基线提交：`1ff443aa6f5e71ac54d7b8b978d206f80c027ac4`
- 基线提交日期：2026-08-15
- 基线提交说明：`chore: bump version to 1.0.39 (#1415)`
- 应用版本：`1.0.39`

M0 没有配置可推送的 FR `origin`，并明确禁止向 `upstream` 推送。后续应由用户创建私有或正式 FR 仓库后再添加 `origin`。

## M0 工具链

- Windows：10.0.26200
- Git：2.52.0.windows.1
- Node.js：22.21.1
- 仓库锁定 pnpm：10.28.1（通过 Corepack）
- Electron：40.4.1
- electron-builder：26.8.1
- Bootstrap Python：3.13.12
- Bootstrap uv：0.11.18
- Bootstrap pygit2：1.19.2
- Visual Studio 2022：17.14.16
- MSVC：14.44.35207
- 新补齐的打包依赖：MSVC v143 14.44 x86/x64 Spectre-mitigated libraries

这里的 Bootstrap Python 是 Desktop 自身安装流程所需资源，不等于未来 `C:\FR_comfyui_next` 的最终 ComfyUI Python/Torch 环境。

## M0 有意修改

除文档和项目规则外，有两处测试隔离修正。

`src/main/auth/firebaseBridge/server.test.ts`：Google OAuth 302 单元测试原来通过 Happy DOM 的 `fetch` 真实访问 Firebase，在代理/离线环境中会超时。现在测试以固定 Firebase 响应替代外网调用，同时继续验证：

- 请求命中 Firebase `accounts:createAuthUri` 接口；
- 路由返回 HTTP 302；
- 跳转目标属于 Google Accounts；
- `client_id` 被正确传递。

这符合上游 `TESTING.md` 对单元测试可模拟外部服务的定义。

`e2e/support/electronHarness.ts`：隔离 E2E profile 默认使用英文，使上游硬编码英文文案的选择器/断言不受宿主 Windows 中文语言影响。测试仍可通过显式 settings seed 覆盖语言。

两处修改都不改变产品运行时代码，也不会改变普通用户默认中文体验。

## M0 验证结果

- `pnpm run typecheck`：通过。
- `pnpm run lint`：通过。
- `pnpm run test`：255 个测试文件、4343 个测试全部通过。
- `pnpm run test:integration`：6 个测试文件、40 个测试全部通过。
- `pnpm run test:e2e:windows`：78 个通过、0 个失败、1 个按条件跳过。
- `pnpm run build`：通过。
- `pnpm run build:win`：通过，生成 Windows x64 NSIS 安装包。

跳过项为 GPU 硬件加速显存测试：当前 Windows PowerShell 无法加载提供 `Get-Counter` 的 `Microsoft.PowerShell.Diagnostics` 模块，官方测试按条件跳过。它不是失败，也不影响应用构建；应在 M7 性能基准阶段补齐模块后运行。

完整 lifecycle 测试会下载约 500 MB 并真实执行安装生命周期，不属于 M0 的无运行环境变更范围，因此未执行。M8 将在合成目录中覆盖此类流程。

## 已知上游警告

- pnpm 11 会提示 `package.json` 中旧 `pnpm.onlyBuiltDependencies` 字段位置已弃用；实际命令由 Corepack 使用仓库锁定的 pnpm 10.28.1，M0 不擅自修改上游配置。
- Vite 报告若干模块同时静态与动态导入，属于上游构建警告，未阻断构建。
- electron-builder 提示 `@electron/rebuild` 与自身能力重复，属于上游依赖提示，M0 不做范围外清理。
