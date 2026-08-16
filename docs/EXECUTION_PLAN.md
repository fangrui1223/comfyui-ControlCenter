# FR ComfyUI Control Center 执行计划

## 1. 最终目标

基于官方 Comfy Desktop 二次开发一个面向普通用户的 Windows 控制中心，保留官方桌面的安装、启动、更新、快照与 Manager v4 能力，并增加类似成熟启动器的环境管理、插件维护、性能技术栈选择、共享模型映射和可恢复升级体验。

目标不是只服务某两个模型，而是建立一套可持续更新的能力目录，覆盖并持续接纳：Wan Animate、SCAIL2、MiniMax H3、Krea2、FLUX.2 Klein、未来 FLUX.3/后续 FLUX、Qwen Image/视频相关模型及其他新开源模型。

## 2. 已确认的目录结构

| 角色 | 目录 | 规则 |
| --- | --- | --- |
| 控制中心源码 | `D:\FR_AI\FR-ComfyUI-ControlCenter` | Git 项目、开发与构建产物 |
| 现有稳定环境 | `C:\FR_comfyui` | 保持不动，作为回退基线 |
| 共享模型库 | `C:\FR_comfyui\models` | 只共享模型，不共享 Python、节点或配置 |
| 未来主环境 | `C:\FR_comfyui_next` | 由控制中心创建和管理的新技术主环境 |
| 独立缓存 | `C:\FR_comfyui_cache` | 下载、wheel、编译、清单等 FR 管理缓存 |
| 重大版本实验 | `C:\FR_comfyui_lab` | 可丢弃、可重建的验证环境 |

`C:\FR_comfyui_next`、`C:\FR_comfyui_cache` 和 `C:\FR_comfyui_lab` 在 M0 不创建。

## 3. 核心设计原则

1. **官方优先**：优先使用 ComfyUI Core、Comfy Desktop、Manager v4 与模型发布方的正式能力。
2. **新技术优先，但不追版本号**：以 RTX 5090 实测、Blackwell 支持和目标工作流收益为准；预览技术进入 lab，验证通过才晋升主环境。
3. **环境隔离**：stable、next、lab 的 Python、custom nodes、Manager 数据、用户配置和编译缓存绝不混用。
4. **模型单份存储**：模型库保持单一事实来源；标准目录使用 `extra_model_paths.yaml`，非标准插件目录使用受控 junction/symlink 映射。
5. **可恢复事务**：更新前体检和快照，更新中分阶段记录，失败自动回退；禁止半升级环境继续启动。
6. **兼容性数据化**：模型、节点、Python、Torch、CUDA wheel、Triton、SageAttention、xFormers、TensorRT 的约束进入带来源和可信度的版本化目录，而不是散落在 UI 条件判断中。
7. **上游友好**：FR 功能以适配器和独立服务为主，减少对官方核心流程的大面积修改。

## 4. 里程碑

### M0 — 官方基线与可构建工程（已完成）

- 克隆官方 `Comfy-Org/Comfy-Desktop`。
- 将官方远程命名为 `upstream`，记录准确提交与许可证。
- 安装锁定依赖和官方 Windows bootstrap 资源。
- 建立本执行计划、基线、许可证和构建指南。
- 通过类型检查、规范检查、单元测试、集成测试、Windows E2E、生产构建和 Windows NSIS 打包。
- 不创建或修改任何 ComfyUI 运行环境。

### M1 — FR 产品壳与设置模型

- 完成 FR 名称、图标、窗口标题、安装包标识和应用数据目录隔离。
- 建立非技术化首页：环境卡片、健康状态、启动、更新、修复和回退入口。
- 定义 stable/next/lab 配置模型，不自动探测后立即接管现有目录。
- 提供“只读导入现有环境”与明确授权的“纳入管理”两种路径。

### M2 — 环境与路径编排

- 实现目录预检、磁盘空间、权限、长路径、符号链接权限和 NVIDIA 驱动探测。
- 创建 next/lab 时使用 staging 目录，成功后原子切换。
- 将 Python、ComfyUI Core、frontend、Manager、user、custom_nodes、output 和缓存路径分层展示。
- 任何创建动作先生成可审阅的 dry-run 计划。

### M3 — 新技术运行时与能力目录

- 首个候选主栈以 `Python 3.13 + Torch 2.12.1/cu130` 作为待验证目标，不在代码中假定其必然兼容全部节点。
- 建立 RTX 5090/Blackwell 实机探针：SM120、BF16/FP8、CUDA runtime、内核加载、显存与 attention 后端。
- 分离 stable、preview、experimental 三个渠道；新 PyTorch/CUDA 先在 lab 验证。
- 对 Triton、SageAttention、xFormers、Flash Attention、TensorRT 等编译扩展记录 ABI 与 wheel 来源。

### M4 — 共享模型映射层

- 扫描 `C:\FR_comfyui\models`，生成只读清单，不移动模型。
- 标准类别生成 `extra_model_paths.yaml`；插件私有类别使用受控目录 junction/symlink。
- 支持插件声明额外模型目录，不依赖一份永远不完整的硬编码列表。
- 映射前检查目标存在、同名冲突、链接环、跨卷能力和权限；提供撤销清单。
- UI 展示真实位置、逻辑位置、占用空间和引用它的环境/插件。

### M5 — 插件与依赖管理

- 在统一 UI 中编排 Manager v4，而不是复制一套互相竞争的节点管理后端。
- 展示插件 Git 来源、提交、分支、更新、Python 依赖、前端扩展、编译扩展和风险等级。
- 批量更新前创建环境快照；逐插件更新并运行导入/启动冒烟测试。
- 支持冻结、忽略、替换和淘汰旧节点；将“不兼容 Python 3.13/新 Torch/新前端”的旧节点隔离到 stable 或 lab。
- 建立替代建议，但绝不未经确认删除插件或用户工作流。

### M6 — 分层更新、快照与回退

- Core、frontend、Manager、Python/Torch 栈、插件、模型清单分别检查和更新。
- 支持版本锁、发布说明、风险提示、下载校验、断点续传和离线包。
- 更新事务包含 before/after 状态、日志、失败恢复和重启验证。
- 对官方 Desktop 上游更新建立可重复的 fetch/rebase-or-merge/测试流程。

### M7 — 模型/工作流性能配置

- 能力目录按模型家族描述文本编码器、VAE、精度、attention、offload、量化和最小/推荐显存。
- 为 Wan Animate、SCAIL2、MiniMax H3、Krea2、FLUX.2 Klein、后续 FLUX、Qwen 系列建立可更新配置模板。
- 同一模型允许质量、均衡、速度三档，不把“最快”与“最稳”混为一谈。
- 基准测试记录冷/热启动、首帧、总耗时、峰值 VRAM/RAM、编译缓存命中和输出一致性。
- 只有通过目标工作流实测的组合才能标记为“主环境推荐”。

### M8 — 安全、E2E、发布与迁移

- 覆盖安装、创建环境、模型映射、节点更新、失败回退和卸载的 Windows E2E。
- 用合成目录和测试模型验证，不读取或改动真实模型库。
- 完成签名、自动更新渠道、许可证/第三方声明、安装包和恢复手册。
- 提供从旧环境的可选迁移向导，默认保持旧环境可启动。

## 5. 每个里程碑的统一验收门

- 用户先确认该里程碑范围，再执行有状态变更。
- `typecheck`、`lint`、单元与相关集成测试通过。
- 对应 Windows 生产构建通过；涉及桌面流程时补 E2E。
- 新增变更有日志、错误提示和恢复路径。
- 不访问或修改范围外的真实 ComfyUI、模型、工作流和用户数据。
- 提供 Git 差异、测试证据和未决风险，再进入下一里程碑。

## 6. M0 之后的决策点

进入 M1 前需确认 FR 的正式产品名、图标/品牌素材、应用数据目录名，以及是否立即创建用户私有 `origin` 仓库。运行时版本和模型支持不在 M1 写死，将在 M3 依据届时官方发布与 RTX 5090 实测确定。
