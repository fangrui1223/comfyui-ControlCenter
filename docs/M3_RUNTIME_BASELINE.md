# M3 运行时能力基线（2026-08-16）

## 主环境结论

`Python 3.13 + PyTorch 2.12.1/cu130` 已不再只是推测。ComfyUI 官方 Windows NVIDIA standalone `v0.29.0-env1` 发布了下列完整元组：

| 组件 | 官方 bundle 值 |
| --- | --- |
| Python | 3.13.12 |
| PyTorch | 2.12.1+cu130 |
| torchvision | 0.27.1+cu130 |
| torchaudio | 2.11.0+cu130 |
| ComfyUI bundle core | v0.28.0 / commit `700821e1...` |

因此 `next` 主环境采用官方 bundle 元组，而不是手工拼装 Python 3.13.14 与各包的“最新版本”。Python 补丁升级仍可做，但必须作为独立事务重新跑 ABI、节点和模型能力测试。

RTX 5090 实机只读预检为：SM120、32,607 MiB、驱动 610.47。PyTorch 2.12 官方建议 Blackwell 使用 CUDA 13.0+，Windows 驱动至少 580.88；当前硬件满足门槛。CUDA 12.8 已从 PyTorch 2.12 标准发布矩阵淘汰，不再作为 next 主线。

## 三条通道

| 通道 | 用途 | 规则 |
| --- | --- | --- |
| stable | next 日用主环境 | 只接受官方 tuple、完整 CUDA 张量探针和基础 ComfyUI 启动探针通过的组合 |
| preview | lab 的 PyTorch nightly/cu132 | 事务开始时解析并锁定日期；失败不影响 next |
| experimental | SageAttention3、TensorRT、未来重大 ABI | 必须有来源 commit、独立编译缓存、数值/工作流对比与一键退回 |

## Attention 加速边界

- **PyTorch SDPA** 是零额外二进制依赖的基准线，也是所有结果对比的参照。
- **xFormers** 是一组通用 Transformer/attention 运算库。ComfyUI 能自动选择它，也可用 `--disable-xformers` 排除。0.0.35 官方 CUDA 13.0 wheel 虽声明 PyTorch 2.10+ 稳定 ABI，实机却显示 `cutlassF-blackwell` unavailable，FA3/FA2/普通 CUTLASS 均拒绝 SM120。它已从 next 卸载并标记为 `blocked-on-target`，后续官方 wheel 必须重新通过 dispatch 和数值探针。
- **SageAttention** 是量化 attention 内核。它与 xFormers 解决相似热点，但不是 xFormers 的插件或上下级；二者是可替换后端。SageAttention3 针对 Blackwell，速度优先，但上游明确提示 SageAttention2 更准确，因此默认按工作流启用，不能直接全局替换 Wan/Qwen/Krea/FLUX 的 attention。
- **FlashAttention** 同样是另一套 attention 内核。xFormers 0.0.35 不再自带 FA3，而依赖 PyTorch 索引提供的 wheel。它不是 SageAttention 的前置条件；只在基准比较时作为候选。
- **Triton** 是编译许多 GPU 内核的编译器/语言运行层，不等于某一种 attention。Windows 的 3.7 分支与 PyTorch 2.12 配套，必须锁 `<3.8`，缓存归每个环境所有。
- **TensorRT** 是图/引擎编译与部署体系，不是 ComfyUI 核心依赖。只在明确的 TensorRT 节点/工作流中安装，engine 不跨 TensorRT 版本、环境或 GPU 假定可复用。

## 包版本策略

ComfyUI Core 当前只直接要求 `transformers>=4.50.3`；`diffusers` 与 `accelerate` 不是 Core requirements 的固定依赖。控制中心不会为了追新而在主环境全局强制升级三者：Core bundle、能力配置和节点依赖求解共同决定版本，升级分别快照和测试。

## 实机验收门

`scripts/fr-runtime-probe.py` 在目标 Python 内实际导入 PyTorch，并验证：

1. CUDA 可用、设备是 SM120、wheel 架构列表含目标架构；
2. FP16/BF16 矩阵乘法；
3. FP16/BF16 PyTorch SDPA；
4. FP8 e4m3fn 转换；
5. 峰值显存与环境独占编译缓存路径。

只有所有基础 case 产生有限值且无 CUDA 错误，stable profile 才能从“硬件 eligible”升级为“主环境推荐”。
