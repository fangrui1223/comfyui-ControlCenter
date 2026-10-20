# 2026-10-20：已满足的依赖仍被交给 wheel 解析器

发现阶段：准备提交当前 1.0.54 源码，执行完整集成测试。
环境：Windows；测试 Python 为 `C:\FR_comfyui_next\standalone-env\python.exe`，
离线测试 uv 为仓库 `bootstrap-python/win-x64/uv.exe`，版本 0.11.18。
没有升级解释器、uv 或任何实际环境依赖。

## 现象与原因

`test_satisfied_existing_packages_produce_no_install_plan` 稳定失败：请求
`existing>=1`，已安装版本为 `2`，预期不产生安装计划；离线 wheelhouse 为空时，
uv 却报 `existing was not found in the provided package locations`。

`resolve_wheels` 把已满足的包写入 `--excludes`，同时仍把它作为顶层输入传给
`uv pip compile`。`--excludes` 省略其输出，不等于跳过显式顶层输入的候选解析；
因此仍要求本不需要的索引/wheel 候选。此问题发生在解析计划阶段，测试没有修改实际环境。

## 修复和保留的保护

[lib/plugin_dependency_plan.py](../../lib/plugin_dependency_plan.py) 只把当前没有保留的顶层需求
传给 uv；无此类输入时跳过该轮外部解析。后续仍遍历已安装分发包的依赖元数据和已选择的
extras，把缺失的传递需求补入下一轮。不能简单地因为顶层版本满足就直接返回空计划。

保护栈约束、已有使用方约束、wheel 哈希/兼容标签校验、URL 限制和依赖闭包验证继续生效。
补充回归位于
[test_plugin_dependency_plan.py](../../src/main/lib/__fixtures__/test_plugin_dependency_plan.py)：

- 已满足包无需索引候选，返回原包版本和空变更计划。
- 已满足和新增的顶层需求混合时，只解析新增包。
- 保留的顶层包选择某个 extra 时，仍解析该 extra 缺失的依赖，未选择的 extra 不进入计划。

修复后 Python 离线依赖回归 23 项全部通过，包括已有回退解析、受保护栈、冲突、wheel
标签/哈希和临时 venv 的真实离线安装用例。测试只使用临时目录和临时环境。
提交前全量复核结果另见 [1.0.54 源码检查记录](../evidence/1.0.54_SOURCE_CHECKPOINT.md)。

## 生效范围与回退

这是源码和测试的修复，将随本次 Git 提交推送；没有改写当前已安装控制中心的
`plugin_dependency_plan.py`，也没有重新打包。源码版本可通过 Git 提交/父提交对比和回退；
不要把源码测试通过描述为当前安装的解析器已经替换。

## 防复发

1. 区分解析器的“从输出排除”和“不参与候选解析”，不能根据参数名称推断实际语义。
2. 用空 wheelhouse 覆盖“已满足且无需下载”的情况，不能只测试存在候选 wheel 的情况。
3. 省略已满足顶层输入时仍需遍历元数据、extras 和传递闭包，不能跳过安全验证。
4. 全量检查发现失败时先复现并记录原因，修复后再提交；不能重试到通过或把失败称为偶发。
