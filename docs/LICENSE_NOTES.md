# 许可证与发布说明

## 上游许可

Comfy Desktop 根目录 `LICENSE` 声明双重许可：

1. GNU Affero General Public License v3.0 or later（AGPL-3.0-or-later）；或
2. 与 Comfy Org 单独签订的商业许可。

本项目目前从官方 Comfy Desktop `1ff443aa6f5e71ac54d7b8b978d206f80c027ac4` 派生。M0 保留上游 `LICENSE`、版权和仓库历史。

## FR 开发规则

- 不删除或改写上游许可证、版权头和第三方声明。
- 新增第三方库、二进制、图标、字体、模型清单或下载源前，记录其许可证、来源和再分发条件。
- 在发布 FR 安装包前生成第三方 notices，并确认 Electron、Python bootstrap、uv、VC Redistributable、ComfyUI、frontend、Manager 与随包资源的分发义务。
- 官方 Comfy/ComfyUI 名称、图标和视觉资产可能涉及商标或品牌规则；FR 对外发布前应完成独立品牌替换与名称审查。
- M1 已用 FR 原创 `assets/FR_ControlCenter.svg` 及其派生 PNG 替换产品壳图标，并把上游仓库入口明确标注为 upstream；产品名仍含 `ComfyUI`，公开发布前必须继续完成名称审查。
- FR 尚未配置自有更新、签名或遥测渠道。M1 工程包不会借用上游 Desktop 的更新/遥测渠道；这些渠道在配置前保持关闭。
- 私有开发不等于自动获得闭源分发权。若不采用 AGPL 对应义务，应在发布前取得适用的商业许可。
- 模型权重与自定义节点拥有各自许可证；控制中心“可下载”不代表允许打包或商业使用。

## 自动生成的生产依赖清单

`resources/THIRD_PARTY_NOTICES.generated.json` 由锁定的 `pnpm-lock.yaml` 和生产依赖树生成，包含生产 npm 包的名称、版本、许可证标识及项目主页；生成过程会剔除本机绝对路径，并以 lockfile SHA-256 绑定输入。安装包将该清单作为独立资源携带。

该清单是可复现的工程证据，不替代各包随附的许可证正文，也不代表 FR 已完成法律、商标、模型权重或商业分发审查。公开发布仍必须完成独立审查、Windows 签名和 FR 自有更新渠道配置。

本文是工程合规清单，不构成法律意见。正式公开发布或商业分发前应进行独立法律审查。
