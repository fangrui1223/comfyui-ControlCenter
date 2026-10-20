# 2026-10-20：插件“有本地修改”两类误报

记录日期：2026-10-20，Asia/Shanghai。产品：FR ComfyUI Control Center 1.0.54，Windows。
来源：本次实际排查、隔离回归测试、两次已安装助手补丁及补丁后的只读复核。

## 现象和结论

插件页显示“有本地修改 / 存在未提交的本地修改，请先处理后再更新”，本地/上游提交却相同。
提交相同只能说明分支对比结果，不能单独证明工作区干净，必须继续检查具体文件。

| 插件                                 | 本地及上游提交                             | 证据                                                                  | 原因                                             |
| ------------------------------------ | ------------------------------------------ | --------------------------------------------------------------------- | ------------------------------------------------ |
| `Comfyui_Minimax_h3_latent_Upscaler` | `40316cf008b2fd8663263270669eb4da23f89d2c` | 5 个未跟踪的 `__pycache__/*.cpython-313.pyc`；无已跟踪文件变化        | 缓存被当成需要保护的本地修改                     |
| `ComfyUI-DD-Translation`             | `9cc769b5d5d9fdec4a80533e5d848ec4ff4f4b8a` | 1 个未跟踪的 `__pycache__/__init__.cpython-313.pyc`；无已跟踪文件变化 | 同上                                             |
| `ComfyUI-FeiHou-Toolbox`             | `312c34b23cff890d06ec28a74ed05695ae307ac0` | 普通 Git 状态干净，旧助手却返回 `dirty: true`；索引 LF、工作区 CRLF   | 联网配置隔离同时屏蔽了状态检查需要继承的换行设置 |

插件目录均位于 `C:\FR_comfyui_next\ComfyUI\custom_nodes`。
复核时三个插件都返回 `dirty: false`、ahead/behind 为 0。
这些提交对比来自当时本地已保存的上游引用；复核未 fetch，不能据此断言以后的远端始终没有新提交。

原始截图保存在本机：

`artifacts/` 为 Git 忽略的本机恢复材料，以下截图和备份链接不随源码推送，需在本机工作区查阅。

- [最初两个插件的缓存误报](../../artifacts/plugin-git-inspection-20261020/screenshots/01-python-cache-warning.png)
- [后续飞猴工具箱误报](../../artifacts/plugin-git-inspection-20261020/screenshots/02-feihou-line-endings-warning.png)

## 问题一：未跟踪 Python 缓存

两个插件都没有仓库内 `.gitignore` 来忽略这些缓存。Python Git 助手原来直接使用
`bool(repo.status())`；系统 Git 路径则用整个 porcelain 输出是否为空判定 dirty。
普通加载生成的字节码也因此触发更新保护。

实际缓存：

```text
Comfyui_Minimax_h3_latent_Upscaler/
  __pycache__/__init__.cpython-313.pyc
  nodes/__pycache__/MMH3_Split_Upscale.cpython-313.pyc
  nodes/__pycache__/__init__.cpython-313.pyc
  nodes/__pycache__/minimax_h3_latent_upscaler_2d.cpython-313.pyc
  nodes/__pycache__/minimax_h3_latent_upscaler_3d.cpython-313.pyc

ComfyUI-DD-Translation/
  __pycache__/__init__.cpython-313.pyc
```

修复：只在更新状态判定中跳过**未跟踪、直接位于 `__pycache__` 中的 `.pyc` 文件**。
已跟踪缓存的修改、删除、暂存，以及源码、配置、其他未跟踪文件，仍然触发保护。
系统 Git 使用 `--porcelain=v1 -z --untracked-files=all`，逐文件判断，避免把整个未跟踪目录
或含特殊字符的文件名误归类。两个后端的规则保持一致。

没有删除缓存，没有改写插件 `.gitignore`、用户 Git 配置或源码，也没有关闭未跟踪文件保护。

## 问题二：继承的换行及忽略规则被屏蔽

缓存修复后，用户又报告 `ComfyUI-FeiHou-Toolbox`。这次普通 Git 工作区干净，助手仍为 dirty。
本机 Git 的 `core.autocrlf=true` 来自系统配置 `C:/Program Files/Git/etc/gitconfig`，
不是该插件的本地配置；不能只检查 global 或仓库配置就下结论。

助手在处理联网操作前通过 `harden_pygit2_config()` 屏蔽 SYSTEM/XDG/GLOBAL 搜索路径，
用于避免全局 URL 重写、凭据配置干扰匿名 HTTPS。原先状态查询也沿用了这个配置，
因此将正常 CRLF 工作区和 LF 索引的差异判成了修改。禁用 `core.autocrlf` 的普通 Git 查询
同样能重现这种判定。相同的隔离还可能丢失用户正常的全局忽略规则。

修复：

1. 助手在隔离配置前保存原搜索路径。
2. 联网仓库继续使用隔离后的配置。
3. 仅在本地状态查询期间恢复原 SYSTEM/XDG/GLOBAL 路径，重新以只读方式打开仓库，
   避免复用联网仓库缓存的配置。
4. `finally` 中恢复隔离路径；该作用域内不 fetch、不 checkout、不调用外部 Git、不写配置。
5. `open_repo(..., read_only=True)` 跳过通用打开流程中的目录补齐和 `core.symlinks` 写入。
6. 保留第一次修复的缓存过滤规则。

没有用统一改换行、`git reset`、`git clean` 或修改全局 `core.autocrlf` 来消除提示。

## 源码位置和回归覆盖

| 文件                                                                                                               | 职责                                                                      |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| [lib/git_operations.py](../../lib/git_operations.py)                                                               | Python dirty 判定、`inspect_worktree_status`、配置作用域和只读打开        |
| [src/main/lib/git.ts](../../src/main/lib/git.ts)                                                                   | 系统 Git 缓存过滤及 NUL 分隔的状态解析                                    |
| [src/main/lib/git.test.ts](../../src/main/lib/git.test.ts)                                                         | 缓存与真实修改分类、特殊文件名、Git 回退等单元回归                        |
| [src/main/lib/gitUpdateInspection.integration.test.ts](../../src/main/lib/gitUpdateInspection.integration.test.ts) | 两后端、继承配置、真实修改、暂存重命名、长路径及元数据不变的真实 Git 回归 |

已执行的验证按修复阶段分别保留，部分用例重复运行，数字不能相加当成独立测试总量：

| 阶段             | 执行结果                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------- |
| 缓存修复         | 185 项相关单元测试、4 项 Git 集成测试通过；四组类型检查、针对性 ESLint/Prettier、whitespace 检查、生产构建通过      |
| 继承配置补充修复 | 140 项相关单元测试、6 项 Git 集成测试通过；集成测试类型检查、针对性 ESLint/Prettier 和 whitespace 检查通过          |
| 最终已安装助手   | 使用 `C:\FR_comfyui_next\standalone-env\python.exe` 复核三个插件，均为 clean；各插件 HEAD/index/config 哈希前后相同 |

第二阶段只改 Python 助手及测试，没有再次执行完整生产构建或生成新安装包。
测试先在隔离仓库复现失败，再修复；没有用自动重试掩盖测试失败。

回归测试复跑入口（在项目根目录）：

```powershell
corepack pnpm exec vitest run src/main/lib/git.test.ts src/main/lib/pluginUpdates.test.ts src/main/lib/pluginUpdateInventory.test.ts
corepack pnpm exec vitest run -c vitest.integration.config.ts src/main/lib/gitUpdateInspection.integration.test.ts
corepack pnpm run typecheck:integration
```

Git 集成测试需要可用的系统 Git 和带 `pygit2` 的测试 Python，可用 `FR_TEST_PYTHON`
指定解释器；不要把这些 Git 用例的结果等同于所有 Python 依赖/Manager 测试都通过。

## 实际生效范围和待后续交付项

本次已安装文件是：

```text
C:\Users\fangr\AppData\Local\Programs\FR ComfyUI Control Center\resources\lib\git_operations.py
```

| 层级                        | 当时状态                                          |
| --------------------------- | ------------------------------------------------- |
| Python 助手源码             | 包含两次修复                                      |
| 系统 Git 路径源码           | 包含缓存修复                                      |
| 已安装 Python 助手          | 两次补丁均已同步，最终 SHA-256 见下方             |
| 已安装 `resources/app.asar` | 没有替换，其中的系统 Git 回退路径还未收到缓存修复 |
| 安装包/发布                 | 本次没有打新安装包、没有发布、没有提升产品版本    |

三个报告的插件在当前实际 Python 助手中均检查成功，因此无需重启，插件页重新检查即可
绕过旧库存缓存（缓存 TTL 为 5 分钟）。**不能把这个结论扩展为所有已安装后端均已更新。**
以后重新打包应检查系统 Git 修复进入新 `app.asar`，并确认新安装包保留最新助手；
仅有源码修改或开发构建成功不足以证明当前安装已生效。

## 备份、哈希和回滚

两次事务的本机记录：

- [缓存修复说明与备份目录](../../artifacts/python-cache-fix-20261020/README.md)，
  [事务清单](../../artifacts/python-cache-fix-20261020/manifest.json)。
- [配置继承修复说明与备份目录](../../artifacts/git-inspection-config-fix-20261020/README.md)，
  [事务清单](../../artifacts/git-inspection-config-fix-20261020/manifest.json)。
- [结构化验证记录](../evidence/2026-10-20_PLUGIN_GIT_INSPECTION_FIX.json)。

SHA-256 链（备份文件与候选文件已重新核对）：

```text
原已安装助手：
11e2317f0841d1b1befd7f43d2a4bfdbb092019f501ef422e6df7be455e12a27

仅缓存修复后 = 第二次补丁的备份：
d6de4494e0dc2b135db3a589be1b2c0e1d50d5b7974305800b553e47d81f7721

最终助手（缓存 + 配置继承）：
17c3d14292579731ea234a5c4b6979e74402af6aecc2057c5cf79f5d68b41a73
```

以下是恢复操作说明，记录阶段未执行回滚。需要回退时，先退第二次补丁：

```powershell
node artifacts/git-inspection-config-fix-20261020/deploy-helper.cjs rollback
```

这会恢复到“仅缓存修复”的版本；仅当还需要撤销第一次修复时，再执行：

```powershell
node artifacts/python-cache-fix-20261020/deploy-helper.cjs rollback
```

脚本先核对当前目标与备份哈希，不匹配时拒绝覆盖。程序已升级或助手已被其他变更替换时，
必须重新核对，不能强制复制旧文件。此次未触及 Stable、共享模型、插件源码、Python 依赖、
用户配置，也未停止或启动任何 ComfyUI/控制中心进程。

## 防止再次犯错

1. **看到 dirty 先查文件。** 分别检查已跟踪修改、暂存、未跟踪文件和忽略规则；提交相同不等于工作区无修改。
2. **不要把生成物和真实改动混为一谈。** 只过滤确定的未跟踪缓存，不放宽所有未跟踪文件，也不忽略已跟踪 `.pyc` 的变化。
3. **检查配置来源。** 状态解释需要考虑 SYSTEM/XDG/GLOBAL/仓库及属性规则，不能把联网配置隔离直接套到本地文件比较。
4. **验证真实执行路径。** 最初只用仓库 bootstrap Python 验证助手不足以代表实例配置；最终需使用实例 standalone Python 与已安装助手，并记录哈希。
5. **两个后端都要覆盖。** 一个助手修复不代表系统 Git 回退路径、`app.asar` 或安装包已更新。
6. **只读包括 Git 元数据。** status 探测不能借打开仓库之机修复目录或写 `core.symlinks`；保留 HEAD/index/config 前后哈希。
7. **构造准确的换行测试。** CRLF 场景从正常 CRLF 工作区建立索引，再保持内容不变复查。把 LF 工作区直接改成 CRLF 可能先触发 Git 索引/状态差异，测试前应确认普通 Git 判定本身是 clean。
8. **区分沙箱问题与产品问题。** 本次沙箱曾阻止 libgit2 解析临时仓库，以及 Vite 替换旧 `out/` chunk；保持相同测试/构建，用范围明确的执行权限完成验证，没有改产品逻辑掩盖权限错误。
9. **交付前核对部署层级。** 本次本机签名预检没有找到配置的签名身份，没有继续生成或宣称已交付签名包。后续按构建说明验证签名、安装包内容和实际安装。
10. **补丁保留可逆链。** 源码、已安装文件、备份、清单、测试结果分别记录；新补丁的 before 哈希必须接上旧补丁的 after 哈希。

## 以后再次出现时的只读排查入口

先针对报错插件执行；不要直接运行 reset、clean、安装或更新操作：

```powershell
$pluginRoot = 'C:\FR_comfyui_next\ComfyUI\custom_nodes\ComfyUI-FeiHou-Toolbox'
git --no-optional-locks -c core.fsmonitor=false -c core.quotepath=false -C $pluginRoot status --short --untracked-files=all
git --no-optional-locks -c core.fsmonitor=false -C $pluginRoot diff --no-ext-diff --no-textconv --stat
git --no-optional-locks -c core.fsmonitor=false -C $pluginRoot diff --cached --no-ext-diff --no-textconv --stat
git --no-optional-locks -C $pluginRoot ls-files --eol
git --no-optional-locks -C $pluginRoot config --show-origin --get core.autocrlf
```

确认助手具备本记录的只读修复、目标为已授权检查的实例后，再用该实例实际解释器比较结果：

```powershell
& 'C:\FR_comfyui_next\standalone-env\python.exe' -B 'C:\Users\fangr\AppData\Local\Programs\FR ComfyUI Control Center\resources\lib\git_operations.py' inspect-update $pluginRoot
```

该命令不带 `fetch`，不导入插件代码。输出和原生 Git 不一致时，先查后端、解释器、配置来源、
路径和库存缓存；不能直接把用户的真实文件当成可丢弃内容。
