# M4 共享模型映射

## 方案结论

共享库保持为唯一物理来源：`C:\FR_comfyui\models`。next 与 lab 不移动、不重命名、不重复下载其中的模型，也不在共享库内部创建任何链接。

映射分两层：

1. Core 标准分类写入 FR 自有 `extra_model_paths.yaml`，启动时用 `--extra-model-paths-config` 显式加载。
2. 非标准分类只有在已安装插件的源码能证明它硬编码访问 `ComfyUI/models/<目录>` 时，才在 **next/lab 的 models 目录内** 建 directory junction；绝不批量 mklink 98 个目录。

这回答了“mklink 行不行”：技术上可行，directory junction 也通常不要求开发者模式，但它应该是插件兼容兜底，不是主映射机制。把所有目录都链接会掩盖插件路径错误、制造目标碰撞，也让卸载/恢复难以审计。

## 自动分类

Control Center 直接解析当前受管 Core 的 `folder_paths.py`，而不是维护一张容易过期的手写列表：

- `folder_names_and_paths[...]` 赋值给出标准 category；
- `map_legacy` 的 `clip → text_encoders`、`unet → diffusion_models` 等别名会合并为同一 logical category；
- 未被 Core 声明的目录标记为 `plugin-verification-required`；
- 文件、现有 reparse point、大小写碰撞或无法读取项标记为 blocked。

扫描不跟随任何链接。清单记录物理路径、逻辑分类、文件数、目录数、字节数、引用环境、警告与扫描错误，供非技术 UI 显示“实际占用”和“哪些环境在使用”。

## Core 映射事务

输出位于：

`C:\FR_comfyui_next\.fr-control-center\model-mappings\`

- `extra_model_paths.yaml`：只含标准/别名分类，`is_default: false`，因此 next 自己的 models 目录仍是默认下载位置，共享 stable 模型不会被节点安装器覆盖。
- `manifest.json`：包含 Core commit、分类、真实源路径、排除项、碰撞、事务号和 SHA-256 摘要。
- `undo.json`：精确列出本事务创建的文件和 junction；撤销只删除清单中仍匹配的 FR 输出。

任何现有同名配置都不会被覆盖。inventory 出现读取错误、计划摘要变化或源目录变成链接时，事务失败关闭。

## 插件专用 junction

每个 junction 计划必须记录：插件 ID、仓库、commit、证明路径用法的源码文件与行号、共享源目录和 next/lab 目标相对路径。执行前再次检查：

- 源是共享库内的物理目录；
- 目标严格位于对应环境的 `ComfyUI/models`；
- 目标不存在，或已经是指向同一源的 FR 映射；
- 不产生路径逃逸、循环或大小写冲突。

插件被停用/退役时只撤销它声明的 junction，不删除共享模型。

