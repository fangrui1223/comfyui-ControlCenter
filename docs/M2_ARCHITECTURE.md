# M2 架构：环境准备与事务底座

## 结论

M2 只把 `next`、`lab` 和 FR 缓存根目录准备成可识别、可恢复的空布局，不下载 Python、Torch、ComfyUI 或节点，也不把空目录显示成可启动环境。候选运行时由 M3 能力探针判定，模型映射由 M4 单独执行。

## 固定边界

| 路径 | M2 权限 | 用途 |
| --- | --- | --- |
| `C:\FR_comfyui` | 保护、只读 | 现有 stable 回退基线 |
| `C:\FR_comfyui\models` | 只引用路径，不扫描、不写入 | M4 才建立共享模型映射 |
| `C:\FR_comfyui_next` | FR 受管、prepared 状态 | 新技术主环境的独立根目录 |
| `C:\FR_comfyui_lab` | FR 受管、prepared 状态 | 重大运行时实验的独立根目录 |
| `C:\FR_comfyui_cache` | FR 受管、不可执行缓存 | 下载、wheel、目录、日志和探针结果；不共享编译扩展缓存 |

`next` 与 `lab` 各自拥有 `.fr-control-center/compiled-cache`，避免 Triton、SageAttention、xFormers、FlashAttention、TensorRT 等二进制产物跨 Python/Torch/CUDA ABI 混用。共享缓存只保存不可变下载物、wheel、能力目录和探针结果。

## 四阶段事务

1. **只读预检**：检查绝对路径、stable/model 路径重叠、目标碰撞、现有数据、FR 所有权标记和磁盘余量。
2. **dry-run**：生成带 SHA-256 摘要、15 分钟有效期和精确动作列表的计划，不创建目标。
3. **原子执行**：先在同卷兄弟 staging 目录写完整布局和所有权标记，再原子重命名为正式路径。
4. **恢复**：执行前在 FR 应用数据下提交事务日志；失败只逆序删除本事务新建且所有权标记、事务号完全匹配的 prepared 根目录。

现有非空目录、链接、不可访问路径、无标记空目录都会失败关闭。Control Center 不会“顺手接管”它们。执行前后目标状态若有变化，摘要或有效期不匹配，也会拒绝写入。

## Prepared 目录内容

- 环境根：事务、日志、快照、staging、环境独占 compiled-cache。
- 缓存根：catalogs、downloads、logs、probes、wheels、事务日志。
- 所有权标记：`.fr-control-center/ownership.json`，记录产品、角色、prepared 状态、创建时间和事务号。

prepared 只代表目录归属和恢复边界已建立，不代表 ComfyUI 已安装或健康。

