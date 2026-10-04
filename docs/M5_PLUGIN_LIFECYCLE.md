# M5 — Manager v4 and plugin lifecycle

## Outcome

The next environment uses the `comfyui_manager` v4 package shipped by the official standalone environment. It does not copy the legacy Manager custom-node directory and does not bulk-copy the stable installation's custom nodes.

The migration strategy is **clean-room selective reinstall**:

1. Inventory the stable `custom_nodes` directory read-only.
2. Hold every plugin back by default.
3. Reinstall a plugin from a declared CNR identity or pinned repository revision.
4. Snapshot before each plugin transaction.
5. Run Python 3.13 import, startup and representative-workflow gates.
6. Activate only after the transaction commits; otherwise quarantine or roll back.

## Manager v4 security baseline

The managed next environment is local-only by default:

- `security_level = normal`
- `network_mode = public`
- `allow_git_url_install = false`
- `allow_pip_install = false`
- launch listener: `127.0.0.1`

Registry node-pack installs are a `middle+` action and are permitted at this local listener under `normal`. Direct Git URL and standalone pip surfaces remain disabled by their independent flags. A future non-loopback listener must not inherit local mutation rights: `middle+` remains denied unless `network_mode = personal_cloud`, while `high+` also requires `weak`.

The Control Center policy mirror follows the installed Manager v4 source and is tested as a pure function. Runtime probing uses `/api/v2/...`; the legacy v3 API/layout is not used.

## Lifecycle states

- `held-back`: visible in the stable inventory, absent from next.
- `active`: passed all declared gates in next.
- `frozen`: active but excluded from bulk update.
- `quarantined`: failed import/startup/workflow gates.
- `replaced`: superseded by Manager v4 or a Core feature.
- `retired`: intentionally sacrificed because it is redundant, unmaintained or not required.

VRAM cleanup/reservation plugins are retirement candidates because the next baseline already uses current Core VRAM management. TensorRT, llama-cpp, Flash/Sage/xFormers and other compiled-dependency plugins are never copied from Stable. They require an explicit compatibility decision against the target runtime.

## Compiled-dependency update fast path

An already-active Next/Lab plugin that declares compiled dependencies remains excluded from the normal bulk-update checkbox. Its independent **compatibility update** entry performs a read-only preflight before any mutation:

1. stage the exact CNR version or Git commit in an OS temporary directory;
2. statically compare top-level requirement declarations, `pyproject.toml`, install/startup hooks and native binary files without importing target code;
3. fingerprint active Python architecture/version, Torch/CUDA, NumPy and installed compiled packages;
4. evaluate the actual per-install Manager v4 `config.ini`, launch listener and source-specific risk level;
5. issue a digest-bound plan. Any target or environment change invalidates that plan.

The phase-one fast path is eligible only when the existing environment already satisfies the target declarations and the target does not change protected runtime packages, dependency declarations, hooks or native binaries. A changed protected Python/Torch/CUDA/NumPy/accelerator stack is blocked. Other declaration, hook or native-file changes require review/Lab validation rather than silent installation.

Execution still goes through Manager v4, but with `no_deps=True` and without invoking the returned post-install callback. This is necessary because Manager v4 can return `install.py` as post-install work even when dependency installation is disabled. The Control Center therefore commits only the exact source switch and never runs plugin install code during preflight.

## Recovery boundary

Stable plugins remain untouched and therefore remain the recovery source. The next environment has independent `custom_nodes`, Manager config/state, user data and Python packages. Removing or quarantining a plugin in next cannot affect stable.
