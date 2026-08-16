This repository has a zero tolerance policy for flaky tests.

## ComfyUI-Manager is v4 (not the legacy v3 layout)

Installs launched by this app run **Manager v4**: the `comfyui_manager` Python package inside the standalone env, enabled through ComfyUI's `--enable-manager` flag. Do not reason about Manager from the v3 codebase.

- **Source of truth: the `manager-v4` branch** of Comfy-Org/ComfyUI-Manager. The `main` branch (legacy `glob/manager_server.py` layout) does NOT describe what desktop ships - reading it gives wrong answers about security gates, endpoints, and config. A workspace checkout of ComfyUI-Manager is typically on `main`; use `git show origin/manager-v4:<path>` or check out the branch.
- **Per-install config** lives at `<install>/ComfyUI/user/__manager/config.ini`, `[default]` section. The launcher reconciles per-install settings into it on launch (see `src/main/lib/managerConfig.ts`).
- **v4 security model** (differs from v3):
  - Risk levels are subdivided: `block` / `high+` / `high` / `middle+` / `middle`.
  - `network_mode` accepts `public | private | offline | personal_cloud`.
  - With a non-loopback `--listen`, `middle+` actions (e.g. installing node packs) are denied at EVERY `security_level` unless `network_mode = personal_cloud`; `high+` additionally requires `security_level = weak`.
  - `allow_git_url_install` / `allow_pip_install` are independent config flags, gated by the same network-position rule.
- **API is v2**: endpoints live under `/api/v2/...` (e.g. the lifecycle test probes `POST /api/v2/snapshot/remove`).

## FR Control Center project rules

This fork is developed as FR ComfyUI Control Center. Preserve these boundaries unless the user explicitly approves a later milestone that changes them.

- The source checkout is `D:\FR_AI\FR-ComfyUI-ControlCenter`.
- Treat `C:\FR_comfyui` as the user's existing stable installation. Do not update, repair, launch with altered arguments, migrate, rename, or delete it while developing the new control center.
- Treat `C:\FR_comfyui\models` as the shared model library. Do not reorganize model files or create links inside it without an approved migration plan and a dry-run report.
- Reserved future targets are `C:\FR_comfyui_next` for the new main environment, `C:\FR_comfyui_cache` for FR-owned caches, and `C:\FR_comfyui_lab` for disposable major-version experiments. M0 does not create them.
- Never share Python environments, `custom_nodes`, Manager state, configuration, user data, or compiled extension caches between stable, next, and lab installations. Only the model library may be shared through an explicit mapping layer.
- Model mappings must be declarative, auditable, reversible, collision-checked, and dry-run capable. Prefer `extra_model_paths.yaml` for standard ComfyUI model categories and directory junctions/symbolic links only for verified non-standard plugin paths.
- Environment, Core, frontend, Manager, custom-node, and model changes are separate transactions. Every mutating transaction must have preflight checks, logs, failure recovery, and a committed snapshot or restore point where supported.
- Do not silently upgrade Python, PyTorch, CUDA wheels, Triton, SageAttention, xFormers, TensorRT, or compiled custom-node dependencies. Compatibility decisions come from a versioned capability catalog and real hardware probes.
- Never hard-code unverified future model requirements. Wan Animate, SCAIL2, MiniMax H3, Krea2, FLUX.2 Klein, future FLUX generations, and Qwen-family support must be expressed as updateable capability profiles with provenance and confidence.
- Keep upstream changes easy to merge: isolate FR behavior behind small services/adapters and avoid unrelated formatting or broad rewrites of upstream files.
- Do not push to the `upstream` remote. A separate user-owned `origin` is required before publishing FR work.
