# M7 — 模型能力与性能配置

## 结论

M7 已把“Core 有节点”“共享库有文件”“插件已满足”“目标工作流已实测”拆成四个独立门槛。文件齐全只表示 `ready`，不会自动产生“主环境推荐”标签。质量、均衡、速度档位只有在同一运行时、Core 提交、GPU 和工作流身份下完成冷/热启动、首个输出、总耗时、峰值显存/内存、编译缓存和输出对比后才能晋升。

版本化事实来源：

- `resources/fr-model-capabilities.v1.json`：官方来源、Core 源码标记、模型文件组、插件边界和启动档位。
- `resources/fr-model-performance-profiles.v1.json`：质量/均衡/速度、精度、步数、attention、offload 与显存证据。
- `scripts/fr-probe-model-capabilities.mjs`：不打开模型内容、不跟随 reparse point 的只读扫描器。
- `src/main/lib/frModelCapabilities.ts`：应用侧判定及工作流基准晋升门。

## RTX 5090 主环境性能基线

日用 `next-daily-performance`：

```text
--enable-triton-backend
--use-pytorch-cross-attention
--disable-xformers
```

保留自动 DynamicVRAM。实机快速启动确认 Triton 3.7.1 启用、PyTorch attention 被选中、RTX 5090 为 32,607 MiB、DynamicVRAM 已启用。`xFormers 0.0.35/cu130` 仍因实机 SM120 attention dispatch 失败而禁用。

`next-same-seed-comparison` 只在结果比较时增加 `--disable-dynamic-vram`，不作为日用设置。SageAttention 3 只存在于 `lab-sageattention3-blackwell`，必须固定源码提交并逐工作流比较速度、显存和输出；它与 xFormers 是竞争 attention 后端，不是上下级依赖。Triton 是内核编译/执行层，也不等于 SageAttention 或 xFormers。

## 共享库只读结果

扫描 `C:\FR_comfyui\models` 共 2,044 个文件，未跟随链接，未移动、重命名、下载或写入任何模型。

| 能力 | 当前状态 | 说明 |
| --- | --- | --- |
| Krea 2 Turbo | `ready` | Turbo diffusion、Qwen3-VL-4B、Qwen Image VAE 已齐 |
| Wan 2.2 Animate | `ready` | FP8 diffusion、UMT5、CLIP Vision、Wan VAE 已齐；完整姿态预处理可选择性安装 `comfyui_controlnet_aux` |
| SCAIL-2 | `ready` | diffusion、UMT5、CLIP Vision、Wan VAE、SAM 3.1、DPO LoRA 已找到；Core 已含 SCAIL/SAM 节点 |
| FLUX.2 Klein 9B | `ready` | 多个 9B 变体、Qwen3 8B、FLUX.2 VAE 已齐 |
| Qwen Image Edit 2511 | `ready` | FP8mixed diffusion、Qwen 2.5 VL 7B、Qwen Image VAE 已齐 |
| MiniMax H3 | `missing-models` | diffusion、Qwen3-VL-32B H3 encoder、video VAE、audio VAE 四组均缺；Core 原生支持已确认 |
| Krea 2 RAW | `partial` | 只缺 RAW diffusion |
| Wan Animate 2 | `partial` | 只缺新的 `wan_animate_2` diffusion；旧 Wan 2.2 Animate 权重不可冒充 |
| FLUX.2 Klein 4B | `partial` | 缺 4B diffusion 与准确的 Qwen3 4B encoder |
| Qwen Image 2512 | `partial` | 缺 2512 diffusion |
| Qwen Image Layered | `partial` | 缺 Layered diffusion 与专用 Layered VAE |
| Qwen3 TTS | `plugin-required` | 非标准模型目录已有文件，但 pinned Core 不原生支持；先验证并清洁安装插件，再决定映射 |
| FLUX.3 | `api-only` | 当前 Core 有官方 BFL T2V/I2V API 节点；不等同于本地权重支持 |
| FLUX.3 本地/开源 | `future-unverified` | 不编造文件名、Python/Torch 或显存要求；官方发布后新建 catalog revision 并先进入 lab |

## 质量、均衡、速度

每个能力都有三个显式档位，但不会强行制造不存在的档位：

- Krea 2：RAW 52 步为训练/最高可塑性，Turbo 8 步的 FP8/MXFP8 为均衡候选，INT8 ConvRot 为速度候选。
- Wan/SCAIL：FP16/BF16、FP8/MXFP8、INT8/蒸馏分别测试；视频长度、分辨率、参考数和预处理必须进入基准身份。
- FLUX.2 Klein：9B base/BF16 为质量，9B FP8 distilled 为均衡，4B distilled 为明确的速度配置，不能把 4B 的画质变化隐藏在“加速开关”后。
- Qwen Image：BF16 对比、FP8 日用、Lightning/蒸馏速度必须是不同工作流；Layered 使用专用 VAE，不能复用普通 Qwen Image VAE。
- H3：当前官方本地工作流使用 INT8 ConvRot diffusion；其他精度只有在官方文件和工作流存在后才进入候选。
- FLUX.3 API：档位由 API 参数和服务端实现决定，本机 attention/offload 参数不适用。

除 FLUX.2 Klein 4B 官方示例约 8.4 GB 的观测值外，目录不把单次观测伪装成普适最低显存。其余 minimum/recommended VRAM 保持 `null`，等待真实目标工作流数据。

## 可舍弃或延后节点

- 旧 `ComfyUI-Manager` 节点：由 Manager v4 独立包取代。
- 大型 Wan wrapper：当 Core 已有 Wan Animate/Wan Animate 2 节点时默认不迁移；只补确实缺少的预处理能力。
- `ComfyUI-SCAIL-Pose`：Core 已含 SCAIL-2 colored mask 和 SAM 3 路径，默认继续 hold-back。
- 旧显存清理/预留节点：与 Core DynamicVRAM/Control Center 资源策略重叠，保留在 stable 回退环境。
- 旧 Qwen 全家桶：对 Core 原生 Qwen Image 不迁移；Qwen3 TTS 是独立插件事务，先做 Python 3.13 和依赖验证。
- 任何把 xFormers、SageAttention、TensorRT 或编译缓存带入新环境的旧节点：必须清洁安装并在 lab 通过 ABI 与工作流门。

## 尚未标记“主环境推荐”的原因

本轮通过的是 Core/Manager/模型映射启动链路，不是实际生成工作流。基准记录目前为 0，所以 42 个质量/均衡/速度档位全部保持非推荐。这是有意的 fail-closed 行为；后续实际工作流测试可逐项晋升，不需要改变判定代码。
