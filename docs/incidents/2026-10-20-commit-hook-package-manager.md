# 2026-10-20：提交钩子调用了不同的 pnpm

## 现象

1.0.54 的类型检查、Lint、格式检查、单元及集成测试已通过，首次 `git commit` 在
pre-commit 钩子中失败。钩子原先运行 `npm run typecheck`，该脚本再调用 PATH 中的
`pnpm`。此终端的 PATH 指向 Codex runtime 的 fallback pnpm，而不是 Corepack 为仓库
`packageManager` 选择的版本；它开始依赖状态检查并尝试执行 `install`，随后报：

```text
ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY
Aborted removal of modules directory due to no TTY
```

`corepack pnpm --version` 已确认仓库指定版本为 `10.28.1`。首次失败没有创建提交，
`pnpm-lock.yaml` 未发生变化，检查用的现有 node_modules 仍在。

## 修复

[.husky/pre-commit](../../.husky/pre-commit) 的三条命令统一改为：

```sh
corepack pnpm run typecheck
corepack pnpm run lint
corepack pnpm run format:check
```

保留全部提交检查，通过实际提交执行修正后的钩子。没有使用 `--no-verify`、
禁用 Husky、强制重装 node_modules、设置确认清除的开关或更新全局 pnpm 来绕过问题。

## 防复发

- 手工验证、Git 钩子和自动化入口统一使用仓库锁定的包管理器。
- 预检通过、钩子却失败时，先核对实际可执行路径和版本，不能立即认定源码检查不稳定。
- 不要按错误提示盲目设置 `CI=true` 或允许清除依赖目录；先确认它为何开始安装。
- 失败的提交尝试不是成功提交；提交哈希和远端状态必须在操作后核对。

本次只改项目钩子，没有修改用户全局 PATH、Node/pnpm 安装或 ComfyUI 环境。
