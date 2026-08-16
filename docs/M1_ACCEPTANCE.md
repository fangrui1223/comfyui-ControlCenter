# M1 验收记录

## 1. 验收结论

M1“FR 产品壳与设置模型”已完成并通过 Windows 工程验收。实现没有创建或修改任何 ComfyUI 运行环境，也没有读取、整理或映射真实共享模型库。

## 2. 功能验收

| 验收项 | 结果 | 证据摘要 |
| --- | --- | --- |
| FR 产品名、图标、窗口标题 | 通过 | 构建后 EXE 的 ProductName/FileDescription 均为 `FR ComfyUI Control Center` |
| 安装包和应用 ID 隔离 | 通过 | `ai.fr.comfyui.controlcenter`；FR 命名 NSIS 产物 |
| 应用数据目录隔离 | 通过 | 早期 bootstrap 设置 FR userData；E2E 验证未创建上游 profile |
| stable/next/lab 卡片 | 通过 | 首页 E2E 验证三卡均从“未注册/未探测”开始 |
| 只读/受管路径 | 通过 | 单元测试覆盖注册、授权时间、冲突和断开行为 |
| 建议路径不自动探测 | 通过 | 未注册 profile 测试断言不会调用文件系统探针 |
| 不自动接管 stable | 通过 | 注册只能由显式目录选择触发；断开不删除目录 |
| 首页安全入口 | 通过 | 更新/修复/回退只进入对应管理页，不直接执行事务 |
| FR 自更新失败关闭 | 通过 | 未配置 FR 渠道时 UI 不提供自更新动作，IPC 返回 unavailable |
| 上游遥测关闭 | 通过 | 没有 FR 通道时禁用 PostHog/Datadog 初始化 |
| Windows 安装包 | 通过 | `FR-ComfyUI-ControlCenter-1.0.39-win-x64.exe` |

## 3. 自动化结果

| 门禁 | 结果 |
| --- | --- |
| TypeScript/Vue 类型检查 | 通过 |
| ESLint | 通过 |
| Prettier | 通过 |
| 单元测试 | 257 个文件、4351 个测试全部通过 |
| 集成测试 | 6 个文件、40 个测试全部通过 |
| Windows E2E | 80 个通过、0 个失败、1 个按条件跳过 |
| 生产构建 | 通过 |
| Windows x64 NSIS 打包 | 通过 |

Windows E2E 的跳过项是上游 GPU 显存计数测试：当前 PowerShell 无法加载提供 `Get-Counter` 的 `Microsoft.PowerShell.Diagnostics` 模块。它不是失败；M7 做 RTX 5090 性能基准前需补齐并重新执行。

验收期间发现下载抽屉首次打开会在负载下短暂显示 396px 临时高度。产品逻辑已改为在首显前等待渲染器给出真实内容高度，并保留 250ms 故障兜底。相关 11 项 E2E 连续三轮全部通过，之后完整 Windows 回归通过。

## 4. 安装包证据

| 项目 | 值 |
| --- | --- |
| 文件 | `dist\FR-ComfyUI-ControlCenter-1.0.39-win-x64.exe` |
| 大小 | 173.45 MiB |
| SHA-256 | `CB5463C470F80F39B3A11CF590BB205FAD8678D721D99179D62D2367D1E95F23` |
| 解包 EXE | `dist\win-unpacked\FR ComfyUI Control Center.exe` |
| ProductName | `FR ComfyUI Control Center` |
| CompanyName | `FR AI` |

M0 的旧 `Comfy-Desktop-*` 生成包和旧 `latest.yml` 已从 `dist` 清理，避免误用；它们均是可重建的构建产物。

## 5. 真实目录边界

验收结束时：

- `C:\FR_comfyui_next`：不存在；
- `C:\FR_comfyui_cache`：不存在；
- `C:\FR_comfyui_lab`：不存在；
- `C:\FR_comfyui`：未启动、未更新、未修复、未迁移、未重命名、未删除；
- `C:\FR_comfyui\models`：未扫描、未写入、未创建链接。

所有桌面 E2E 均使用 `%TEMP%\comfyui-launcher-e2e-*` 下的合成 profile。

## 6. 未决事项

- 当前没有用户自有 FR `origin`，本阶段只做本地提交，不推送上游。
- 当前没有 FR 自动更新服务、代码签名证书或遥测后端；相关功能保持关闭。
- 安装包是工程验收包，不等于可公开发布版本；公开发布前需完成商标、许可证、第三方 notices 和签名审查。
- M2 才能生成 next/lab 的 dry-run 创建计划；M3 才能实测并决定 Python 3.13、Torch 2.12.1/cu130 以及注意力/编译扩展组合。
