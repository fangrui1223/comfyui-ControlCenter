# FR ComfyUI Control Center 用户操作手册 / User Guide

**版本 / Version:** 1.0.39 · M9 bilingual release candidate
**日期 / Date:** 2026-08-16
**适用平台 / Platform:** Windows 11 x64 · NVIDIA RTX 5090 / Blackwell
**文档定位 / Purpose:** 日常操作、环境隔离、模型共享、插件维护、性能选择、更新与恢复。

> **发布状态 / Release status**
> 当前开发机没有 FR 发布者代码签名证书。现有安装包只能作为“内部未签名候选”测试，不能称为可信公开版。正式签名命令已经采用缺证书即失败的门禁；取得 CA 证书或合格的云签名身份后，必须重新构建并验证 Authenticode。
> The current development machine has no FR publisher code-signing certificate. Existing installers are internal unsigned candidates, not trusted public releases. The formal release command now fails closed until a valid signing identity is configured, then verifies Authenticode after packaging.

## 1. 先看结论 / Read this first

FR ComfyUI Control Center 不是把所有 ComfyUI 都塞进一个 Python 环境的“万能启动器”。它用隔离环境保护现有稳定安装，同时给新技术一条可验证的升级路线。

FR ComfyUI Control Center does not combine every ComfyUI workload into one Python environment. It protects the existing stable installation through isolation and gives newer technologies a testable promotion path.

| 角色 / Role | 固定路径 / Path | 主要用途 / Purpose | 控制策略 / Policy |
|---|---|---|---|
| 稳定环境 / Stable | `C:\FR_comfyui` | 现有可信回退基线 / Existing trusted fallback | 只读；不更新、不修复、不迁移 / Read-only; never update, repair, or migrate |
| 新主环境 / Next | `C:\FR_comfyui_next` | Python 3.13 + Torch 2.12.1/cu130 日用新技术主线 / Daily modern stack | 受管；每层独立事务 / Managed; one layer per transaction |
| 实验环境 / Lab | `C:\FR_comfyui_lab` | nightly、SageAttention 3、TensorRT、未来大版本 / Nightly and major experiments | 可丢弃、可重建 / Disposable and rebuildable |
| FR 缓存 / Cache | `C:\FR_comfyui_cache` | 下载、wheel、能力目录、探针日志 / Downloads, wheels, catalogs, probe logs | 不作为可启动环境 / Never launched as an environment |
| 共享模型 / Models | `C:\FR_comfyui\models` | 唯一模型物理来源 / Single physical model source | 不移动、不重命名、不在库内批量建链接 / Never reorganized or bulk-linked internally |

**最重要的安全规则 / Most important rule:** Python、`custom_nodes`、Manager 状态、用户数据和编译缓存绝不跨 stable、next、lab 共享。只有模型库通过显式映射共享。

## 2. 安装与首次启动 / Install and first launch

### 2.1 可信签名版 / Trusted signed build

1. 只从 FR 官方发布位置下载安装包。
2. 右键安装包 → **属性** → **数字签名**，确认签名状态有效、发布者与 FR 的正式发布身份一致。
3. 运行安装包。安装器自动跟随 Windows 显示语言：简体中文系统显示中文，其他系统使用英文。
4. 按需要选择当前用户或所有用户安装，确认目录，等待三个步骤完成：VC++ 运行库、程序文件、清理收尾。
5. 完成页可取消“添加桌面快捷方式”；点击完成后启动控制中心。

Download only from the official FR distribution point. Check **Properties → Digital Signatures** before running. The installer follows the Windows UI language automatically, installs the VC++ runtime when required, writes application files, and optionally creates a desktop shortcut.

### 2.2 当前内部未签名候选 / Current unsigned internal candidate

仅用于本机开发验收。先核对发布记录中的文件名、大小和 SHA-256；不要关闭 SmartScreen、不要把未知证书装入受信任根目录、不要把未签名包转发给其他用户。Windows 阻止运行时，应停止并改用源码态测试或等待正式签名包。

Use only for controlled local development. Verify the recorded filename, size, and SHA-256. Do not disable SmartScreen, install an unknown root certificate, or redistribute the unsigned build. If Windows blocks it, use source-mode testing or wait for a trusted build.

### 2.3 选择语言 / Choose language

应用首次启动采用 Windows 语言。之后打开 **启动器设置 / Launcher Settings → 常规 / General → 语言 / Language**，选择“简体中文”或“English”；界面即时切换，不需要重装。安装器语言和应用语言相互独立。

The app initially follows Windows. Open **Launcher Settings → General → Language** to switch between Simplified Chinese and English live, without reinstalling. Installer language and application language are independent.

## 3. 首页与实例 / Dashboard and instances

首页上半部分是已经安装或导入的实例，下半部分是 stable、next、lab 三张“环境控制”卡片。

The upper dashboard lists installed or imported instances. The Environment Control cards below represent stable, next, and lab roles.

| 操作 / Action | 含义 / Meaning | 使用时机 / When to use |
|---|---|---|
| 启动 / Launch | 启动选定 ComfyUI / Start the selected ComfyUI | 日常生成前 / Before normal work |
| 管理 / Manage | 打开状态、更新、快照、设置 / Open status, updates, snapshots, settings | 维护实例 / Maintenance |
| 检查修复 / Repair | 进入诊断，不代表自动改依赖 / Open diagnostics; no blanket dependency changes | 启动失败、目录异常 / Startup or folder problems |
| 回滚 / Roll back | 进入快照页选择恢复点 / Choose a restore point | 更新或插件失败 / Failed update or plugin |
| 打开文件夹 / Reveal | 打开实例目录 / Open the instance folder | 查看日志或用户文件 / Inspect logs or user files |

不要在一个 GPU 上无意并行启动多个大模型实例。控制中心默认会给出多实例警告；确认显存和任务确实允许时再继续。

Avoid unintentionally launching multiple large-model instances on one GPU. The launcher warns by default; continue only when the workloads and VRAM budget allow it.

## 4. 登记 stable、next、lab / Register environments

### 4.1 三种登记状态 / Three registration modes

- **未登记 / Unregistered:** 只显示建议路径，不检查磁盘，不读取目录。
- **只读 / Read-only:** 可记录和查看目录状态，但控制中心不得修改目标。
- **已授权管理 / Managed:** 允许后续事务管理该环境，但每次变更仍需预检、日志、快照或恢复点。

### 4.2 推荐登记顺序 / Recommended order

1. 在“稳定环境”卡片选择 `C:\FR_comfyui`，点击 **只读登记**。
2. 不要把 stable 改为“已授权管理”；它是最后回退入口。
3. 在“新主环境”卡片选择 `C:\FR_comfyui_next`，确认目录归属后点击 **授权管理**。
4. 在“实验环境”卡片选择 `C:\FR_comfyui_lab`，只用于可丢弃实验。
5. 如需更换路径，先停止实例，再使用 **更换目录**；**取消登记**只删除控制中心记录，不删除磁盘文件。

Register stable read-only first, next as managed, and lab as managed/disposable. Disconnect removes only Control Center metadata; it never deletes the environment directory.

## 5. 创建新主环境 / Prepare the next environment

推荐主线是 ComfyUI 官方 standalone 已发布并验证过的完整元组，而不是手工拼出一组“看起来最新”的包：

The recommended next baseline follows the complete tuple published by official ComfyUI standalone rather than mixing independently newest packages:

| 组件 / Component | 主环境基线 / Next baseline |
|---|---|
| Python | 3.13.12 |
| PyTorch | 2.12.1+cu130 |
| torchvision | 0.27.1+cu130 |
| torchaudio | 2.11.0+cu130 |
| GPU | RTX 5090, SM120, 32 GB |
| Attention 基准 | PyTorch SDPA |
| Triton | 3.7.x，锁定 `<3.8` / pin `<3.8` |

创建流程必须先产生 dry-run。重点检查目标目录是否为空或已有 FR 所有权标记、与 stable/模型库是否重叠、磁盘空间、写权限和长路径能力。执行时先在同卷 staging 目录写完整布局，通过后原子发布；“prepared”只表示目录边界就绪，不等于 ComfyUI 已安装或健康。

Environment creation must produce a dry run first. It checks collisions, ownership, disk space, permissions, and long-path capability, builds into a same-volume staging directory, and publishes atomically. “Prepared” means only that ownership and recovery boundaries exist.

## 6. 共享模型库 / Shared model library

### 6.1 默认方法 / Default method

共享模型库固定为 `C:\FR_comfyui\models`。标准 ComfyUI 分类通过 FR 自有 `extra_model_paths.yaml` 映射，并在启动时用 `--extra-model-paths-config` 显式加载。next 自己的 `models` 仍是默认下载位置，避免 Manager 或节点安装器覆盖 stable 的共享模型。

The shared library stays at `C:\FR_comfyui\models`. Standard categories are referenced from an FR-owned `extra_model_paths.yaml`; next keeps its own models folder as the default write target.

### 6.2 什么时候用 junction/mklink / When junctions are appropriate

只有插件源码能证明它硬编码访问 `ComfyUI/models/<专用目录>` 时，才在 next 或 lab 的 `models` 目录创建受控 directory junction。每个链接必须记录插件、commit、源路径、目标路径、证据和撤销动作。不要把共享库的所有子目录批量 `mklink`；那会掩盖碰撞、链接环和错误插件假设。

Use a directory junction only when a verified plugin hard-codes a non-standard `ComfyUI/models/<folder>` path. Never bulk-link the entire shared model tree.

### 6.3 映射前后检查 / Mapping checklist

- dry-run 中没有文件、reparse point、大小写碰撞或无法读取项。
- 源目录是共享库中的真实物理目录，目标严格位于 next/lab。
- `manifest.json` 和 `undo.json` 已生成，SHA-256 与执行计划一致。
- 撤销只删除 FR 创建且仍匹配清单的 YAML/链接，不碰模型文件。

## 7. 插件与 Manager v4 / Plugins and Manager v4

本项目使用 standalone 环境里的 `comfyui_manager` v4 包，通过 `--enable-manager` 启用，接口是 `/api/v2/...`。不要安装 legacy v3 的 `ComfyUI-Manager` 自定义节点目录，也不要用 v3 的配置或 API 文档判断行为。

This project uses the standalone `comfyui_manager` v4 package enabled by `--enable-manager`, with `/api/v2/...` endpoints. Do not install or reason from the legacy v3 custom-node layout.

### 7.1 next 默认安全设置 / Default next security

| 设置 / Setting | 默认值 / Default | 含义 / Meaning |
|---|---|---|
| `security_level` | `normal` | 允许本地注册节点包事务，阻止高风险未注册来源 / Allow normal local registry operations, block higher-risk sources |
| `network_mode` | `public` | 使用公开节点注册表 / Use public registry |
| `allow_git_url_install` | `false` | 禁止任意 Git URL 安装 / Block arbitrary Git URL installs |
| `allow_pip_install` | `false` | 禁止独立 pip 入口 / Block standalone pip installs |
| Listener | `127.0.0.1` | 仅本机访问 / Local machine only |

把 ComfyUI 暴露到非回环 `--listen` 后，Manager v4 会额外阻止安装动作。只有自己控制的远程机器且理解风险时，才考虑 `personal_cloud`；公共/共享主机不应放宽。

### 7.2 插件迁移 / Plugin migration

不要复制 stable 的整个 `custom_nodes`。对每个插件执行：只读清单 → 默认 hold-back → 从 CNR 或固定 commit 清洁安装 → Python 3.13 导入 → ComfyUI 启动 → 代表性工作流 → 激活或隔离。编译型插件还必须通过 RTX 5090/SM120 和目标 ABI 探针。

Never copy the complete stable `custom_nodes`. Reinstall each selected plugin cleanly from a declared identity or pinned revision, then pass Python import, ComfyUI startup, and representative workflow gates.

### 7.3 可优先舍弃的旧节点 / Older nodes to sacrifice first

- legacy `ComfyUI-Manager` v3 自定义节点。
- Core 已覆盖能力的大型 Wan wrapper；只保留真正缺少的预处理。
- `ComfyUI-SCAIL-Pose`，当 Core 的 SCAIL-2/SAM 路径已经满足需求。
- 与 DynamicVRAM 重叠的旧显存清理/预留节点。
- 只为 Core 原生 Qwen Image 重复功能的旧 Qwen 全家桶。
- 携带旧 xFormers、SageAttention、TensorRT 或编译缓存的节点。

Retire redundant, unmaintained, or ABI-bound plugins first. Keep them in stable as fallback rather than copying them into next.

## 8. Attention、Triton 与性能 / Attention, Triton, and performance

### 8.1 SageAttention 与 xFormers 的关系 / SageAttention vs xFormers

二者都可以加速 attention 热点，但互为候选后端，不是上下级，也不需要同时安装。

Both accelerate attention workloads, but they are alternative backends, not parent/child dependencies and not a required pair.

| 技术 / Technology | 作用 / Role | next 策略 / Next policy |
|---|---|---|
| PyTorch SDPA | 官方 PyTorch attention 基准 / Reference backend | 默认基准，零额外二进制依赖 / Default reference |
| xFormers | 通用 Transformer/attention 算子集合 / General operator library | 0.0.35/cu130 在当前 SM120 dispatch 失败，禁用 / Disabled after SM120 dispatch failure |
| SageAttention 3 | 面向 Blackwell 的量化 attention / Blackwell-oriented quantized attention | 只在 lab 按工作流对比；可能改变数值 / Lab-only per-workflow comparison |
| FlashAttention | 另一套 attention 内核 / Another attention kernel family | 独立候选，不是 Sage 前置 / Independent candidate |
| Triton | GPU 内核编译/运行层 / GPU kernel language/runtime | 3.7.x；每环境独立缓存 / 3.7.x with per-environment cache |
| TensorRT | 图/引擎编译部署体系 / Engine compilation/deployment | 仅明确工作流，engine 不跨环境复用 / Explicit workflows only |

### 8.2 RTX 5090 日用参数 / RTX 5090 daily profile

```text
--enable-triton-backend
--use-pytorch-cross-attention
--disable-xformers
```

保持 DynamicVRAM 自动管理。做同种子数值对比时才临时加入 `--disable-dynamic-vram`。SageAttention 3 和 TensorRT 先进入 lab；只有同一模型、工作流、分辨率、步数和种子的速度、峰值显存与输出比较通过后，才晋升 next。

Keep DynamicVRAM enabled for daily work. Use lab for SageAttention 3 and TensorRT, then promote only after controlled performance and output comparisons.

## 9. 模型能力与档位 / Model capability profiles

“Core 有节点”“模型文件齐全”“插件依赖满足”“工作流实测通过”是四个不同门槛。文件 `ready` 不等于已经获得“主环境推荐”。

Core support, model-file readiness, plugin readiness, and tested workflow performance are four separate gates. A `ready` file set is not automatically a recommended daily profile.

| 模型 / Model | 2026-08-16 状态 / Status | 使用建议 / Guidance |
|---|---|---|
| Krea 2 Turbo | ready | 8-step 日用候选；RAW 仍缺 diffusion / Daily candidate; RAW diffusion still missing |
| Wan 2.2 Animate | ready | Core 原生优先；姿态预处理按需补 / Prefer native Core; add pose preprocessing only if needed |
| Wan Animate 2 | partial | 不把旧 2.2 权重冒充新 diffusion / Do not substitute old 2.2 weights |
| SCAIL-2 | ready | Core SCAIL/SAM 路径优先 / Prefer native Core SCAIL/SAM path |
| FLUX.2 Klein 9B | ready | 质量、均衡、速度工作流分别标记 / Keep quality/balanced/speed explicit |
| FLUX.2 Klein 4B | partial | 缺准确 4B diffusion/encoder / Missing exact 4B set |
| Qwen Image Edit 2511 | ready | FP8mixed 日用候选 / FP8mixed daily candidate |
| MiniMax H3 | missing-models | Core 已支持，但四组本地模型缺失 / Core supported; four local groups missing |
| Qwen3 TTS | plugin-required | 独立插件事务，先验证 Python 3.13 / Separate plugin transaction |
| FLUX.3 API | api-only | 本机 attention 参数不适用于服务端 / Local attention settings do not control server |
| FLUX.3 本地 / Local | future-unverified | 不预设文件名和版本；先进入 lab / No invented requirements; lab first |

每个模型的质量/均衡/速度档必须显式记录精度、量化、步数、attention、offload、冷/热启动、首输出、总耗时、峰值 VRAM/RAM 和输出比较。速度档导致的画质变化不能隐藏成普通“加速开关”。

Every profile must record precision, quantization, steps, attention, offload, cold/warm times, first output, total time, VRAM/RAM peaks, and output comparison. Quality trade-offs must stay visible.

## 10. 更新、快照与回退 / Updates, snapshots, and rollback

### 10.1 一次只更新一层 / One layer per transaction

Core、frontend、Manager、runtime、插件、模型映射是六个独立事务。更新前停止实例，创建恢复点，确认 Core 工作树干净，再执行目标层。不要在一次操作中顺带升级 Torch、Manager 和所有插件。

Core, frontend, Manager, runtime, plugins, and model mappings are separate transactions. Stop the instance and create a restore point before changing one layer.

### 10.2 图形界面操作 / UI workflow

1. 首页选中实例 → **管理**。
2. 在 **状态 / About** 记录当前版本和路径。
3. 在 **快照 / Snapshots** 创建或确认最近恢复点。
4. 在 **更新 / Update** 查看目标版本和更新说明。
5. 停止运行中的实例，再开始更新。
6. 更新完成后检查启动日志、Manager v4 `/api/v2`、GPU/attention 探针和代表性工作流。
7. 失败时回到 **快照**，只恢复发生变化的层；不要改 stable。

### 10.3 Runtime 更新 / Runtime update

运行时不得在活动 Python 目录中原地混装。构建完整 staged runtime，通过 SM120、FP16/BF16 matmul、SDPA、FP8 和 ComfyUI 启动探针后，再原子切换；失败则回到上一完整 runtime 目录。

Never mix wheels in the live Python directory. Stage a complete runtime, pass hardware/numerical/startup probes, then switch atomically.

## 11. 故障处理 / Troubleshooting

| 现象 / Symptom | 首要检查 / First check | 正确处理 / Correct response |
|---|---|---|
| 安装器被 SmartScreen 阻止 | 数字签名与 SHA-256 / Signature and hash | 未签名内部包不要绕过；等待可信包 / Do not bypass for unsigned candidate |
| 启动即崩溃 | 终端日志、VC++ 运行库、最后导入包 / Terminal, VC++ runtime, last imported package | 先保留现场，再隔离目标插件 / Preserve evidence, quarantine target plugin |
| CUDA/SM120 不支持 | Torch wheel 架构、驱动、探针 / Wheel arch, driver, probe | 回退完整 runtime；不在原环境乱换 wheel / Restore whole runtime |
| xFormers 报 no operator | attention dispatch / Dispatch result | 保持 `--disable-xformers`，用 SDPA / Keep xFormers disabled |
| 模型找不到 | YAML 清单、category、插件专用路径 / Manifest and categories | 先 dry-run 修映射；不搬模型 / Repair mapping, do not move models |
| Manager 安装被拒绝 | v4 `security_level`、`network_mode`、`--listen` / v4 security and listener | 不用 v3 教程；恢复本机监听或审查策略 / Use v4 rules |
| 节点更新后失败 | 插件 commit、依赖锁、启动日志 / Plugin revision and logs | 隔离/回退单个插件 / Roll back one plugin |
| 显存突然升高 | 工作流身份、分辨率、帧数、offload、并行实例 / Workflow identity and concurrent instances | 与同一基准比较；停止无关实例 / Compare like-for-like |

收集证据时至少保存：时间、环境角色、Core commit、Python/Torch/CUDA、GPU、启动参数、目标工作流、插件 commit、失败阶段和完整日志。先诊断再修改，避免覆盖故障现场。

## 12. 卸载与数据保留 / Uninstall and data retention

卸载 FR ComfyUI Control Center 默认只移除控制中心程序，不删除 stable、next、lab、cache 或共享模型。未来若提供“删除 FR 管理数据”，也必须先显示 dry-run，只允许处理带 FR 所有权标记的 next/lab/cache。`C:\FR_comfyui` 和 `C:\FR_comfyui\models` 在所有模式下都是硬保护目标。

Uninstalling the Control Center removes the application only. Stable, next, lab, cache, and shared models remain. Stable and the shared model library are hard-protected in every cleanup mode.

## 13. 发布者签名操作 / Publisher signing procedure

本节只供 FR 发布维护者。不要把证书或密码写入仓库。

For FR release maintainers only. Never commit the certificate or password.

### 13.1 PFX 证书 / PFX certificate

```powershell
$env:WIN_CSC_LINK = 'C:\secure\FR-AI-Code-Signing.pfx'
$env:WIN_CSC_KEY_PASSWORD = '<secret manager value>'
pnpm run build:win:signed
```

### 13.2 Windows 证书库 / Windows certificate store

```powershell
$env:CSC_NAME = 'FR AI'
pnpm run build:win:signed
```

正式命令会在三处失败关闭：缺少身份配置、electron-builder 未签名、最终应用或安装包 Authenticode 状态不是 `Valid`。自签名只适用于显式管理的内网测试机，且不会解决公开 SmartScreen 信誉问题。

The signed release command fails closed on missing identity, unsigned packaging, or a final Authenticode status other than `Valid`. Self-signing is limited to explicitly managed test machines and does not solve public SmartScreen reputation.

## 14. 日常操作清单 / Daily checklist

**生成前 / Before generation**

- 确认启动的是 next，而不是 lab 或误改的 stable。
- 确认 GPU 没有无意并行的大实例。
- 确认目标模型能力是 ready，工作流档位与精度明确。
- 首次运行新节点/新 attention 时先用小工作流。

**维护前 / Before maintenance**

- 停止目标实例，记录版本和日志。
- 创建恢复点；一次只改一层。
- 插件使用固定来源，编译型依赖先去 lab。
- 模型映射先 dry-run，绝不整理共享库。

**故障后 / After a failure**

- 不清缓存、不批量升级、不覆盖日志。
- 隔离发生变化的层并回退。
- stable 保持不动，必要时作为独立回退入口。
- 只有完整门禁通过后才把 lab 结果晋升 next。

## 15. 术语速查 / Glossary

| 术语 / Term | 简明解释 / Plain-language meaning |
|---|---|
| ABI | Python/Torch/CUDA 与编译扩展必须匹配的二进制接口 / Binary compatibility boundary |
| SDPA | PyTorch 自带的 scaled dot-product attention / PyTorch built-in attention baseline |
| DynamicVRAM | ComfyUI 动态管理显存的机制 / Dynamic VRAM management |
| staging | 正式切换前的完整候选目录 / Complete candidate directory before activation |
| dry-run | 只生成动作、风险、碰撞和撤销计划，不写目标 / Plan-only pass with no target mutation |
| restore point | 更新前可验证的回退状态 / Verified pre-change state |
| junction | Windows 目录级映射；仅作非标准插件兼容兜底 / Windows directory mapping for verified plugin exceptions |
| capability profile | 带来源、版本、文件、依赖和性能证据的模型能力记录 / Versioned model capability record |

## 官方参考 / Official references

- Microsoft SmartScreen reputation: https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation
- Microsoft SignTool: https://learn.microsoft.com/en-us/windows/win32/seccrypto/signtool
- electron-builder code signing: https://www.electron.build/docs/features/code-signing/
- electron-builder NSIS options: https://www.electron.build/docs/api/electron-builder.interface.nsisoptions/

---

**维护说明 / Maintenance note:** 本手册描述 M9 源码状态。模型、驱动、PyTorch、ComfyUI 和插件要求会变化；更新 capability catalog 后，应同步修订版本、日期与已验证状态，不把未来假设写成事实。
