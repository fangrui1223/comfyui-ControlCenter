# M8 Windows 发布验收

## 发布级别

M8 的工程目标是生成一个可在本机验收的 **内部未签名候选包**。只有单元、集成、Windows E2E、生产构建、安装包哈希和恢复手册全部通过，才允许进入该级别。

以下事项属于公开发布硬门槛，在全部完成前不得把安装包称为正式公开版：

- AGPL/商业许可、名称、商标和第三方分发义务完成独立审查；
- 配置 FR 自有 Windows 代码签名证书和发布者名称；
- 配置 FR 自有更新源，确认不会借用 upstream 发布通道；
- 配置用户所有的 `origin`，并保护 `upstream` 不可误推；
- 对生成的生产依赖清单及随包许可证正文完成发布审计。

## 可复现证据

- `resources/THIRD_PARTY_NOTICES.generated.json`：生产 npm 依赖与许可证清单，绑定 lockfile SHA-256。
- `docs/M8_RECOVERY_MIGRATION.md`：分层回退、源环境保护、迁移与卸载规则。
- `docs/evidence/M8_ACCEPTANCE.json`：测试、构建、安装包摘要与公开发布阻断项。

安装包使用 `FR-ComfyUI-ControlCenter-<version>-win-x64.exe` 命名。M8 禁用自动证书发现，未签名状态是显式、可审计的内部候选属性，不是公开发布能力。

## 2026-08-16 实机结果

- 产物：`dist/FR-ComfyUI-ControlCenter-1.0.39-win-x64.exe`
- 大小：181,901,156 bytes
- SHA-256：`C0A2140450988C0B24D587E49BC3D3F19E3B68DBA73F532252B6FAD1FFAAA3F3`
- Authenticode：`NotSigned`
- 单元测试：264 文件、4,391 项通过
- 集成测试：7 文件、46 项通过
- Windows E2E：80 项通过、1 项因主机缺少 PowerShell GPU 性能计数器模块而明确跳过、0 项失败
- 生产构建与 NSIS：通过
- 第三方清单：已随 `win-unpacked/resources` 携带，源文件和打包文件 SHA-256 均为 `3889AA4385262F5B8989197E43644B4FD6554D16F81735DF58A229C5296B2FAB`
- 发布文件选择：确认没有打包 `.pnpm-store`

当前受管 Windows 主机会放行哈希未改变的官方 Electron 测试二进制，但会冻结构建后修改过资源的未签名 EXE。因此源码态完整 Electron E2E 已通过，而打包后启动冒烟被主机未签名执行策略阻断。该限制不改写为测试通过；安装包保持“内部未签名候选”，配置有效 FR 证书后必须重新执行打包后启动与安装/卸载冒烟。

仓库已将 `upstream` 的 push URL 设为 `DISABLED`，保留官方 fetch；用户所有的 `origin` 尚未配置，因而公开发布仍被阻断。
