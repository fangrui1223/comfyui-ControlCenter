# M9 packaged startup dependency fix — completed evidence

**Completed at:** 2026-08-16 20:43 Asia/Shanghai

**Result:** `1.0.40` is the verified local-current-user release candidate. Do not use the broken `1.0.39` package.

## User-visible failure

- Installed path: `C:\Users\fangr\AppData\Local\Programs\FR ComfyUI Control Center`
- Installed version at report time: locally signed `1.0.39`
- First startup error: `Cannot find module 'fs-extra'`
- The installation path is correct. The failure is in the packaged Node dependency closure.

## Confirmed root cause

`electron-updater` and `@todesktop/runtime` are packaged, but electron-builder's pnpm dependency collection omitted several nested CommonJS runtime dependencies from `app.asar`. The source-mode application therefore works while the installed application fails before the main window is created.

The old installed Control Center processes from the failed startup were closed by exact executable path. No ComfyUI, Python, stable, Next, model, or user workflow process/data was changed.

## Completed repair

- Bumped the repair candidate to `1.0.40` so it cannot be confused with broken `1.0.39`.
- Added all resolved direct production dependencies necessary for the updater/runtime closure, including `fs-extra`, `builder-util-runtime`, `js-yaml`, `lazy-val`, `lodash.escaperegexp`, `lodash.isequal`, `tiny-typed-emitter`, and their required leaf packages.
- Added direct development dependency `@electron/asar@3.4.1` for package inspection.
- Added `scripts/fr-verify-packaged-runtime.mjs` and declarations.
- Added unit coverage in `src/main/lib/frPackagedRuntime.test.ts`.
- Added `scripts/fr-smoke-packaged-windows.mjs` and the `smoke:win:packaged` command.
- The package gate now recursively walks the production dependency closure rooted at `@todesktop/runtime` and `electron-updater`.

## Final evidence

- Original `1.0.39` package gate correctly failed for missing `fs-extra` and related nested packages.
- The original `1.0.39` failure was reproduced and diagnosed. A second missing dependency was also observed:
  - `Cannot find module 'builder-util-runtime'`
  - require stack begins in `electron-updater/out/AppUpdater.js`

## Final release gates

- Full unit suite: 267 files / 4,403 tests passed with zero retries; typecheck, ESLint, and Prettier all passed.
- `node scripts/fr-verify-packaged-runtime.mjs` passed: the updater dependency closure is present in `app.asar`.
- The signed `1.0.40` package passed an isolated startup smoke in the current user's desktop context: `panel.html`, `comfyTitleBar.html`, and `comfyTitlePopup.html` loaded.
- The unpacked application and NSIS installer both verified as Authenticode `Valid` under `CN=FR ComfyUI Control Center Local Signing` (thumbprint `E6582CA50AB31CECA76447AF047DE244C42E077B`).
- Final installer: `dist\FR-ComfyUI-ControlCenter-1.0.40-win-x64.exe`; SHA-256 `1D4961A7C5563ADC77CF18ACF0351504155AD5B641D353BF2AC37F5BA7DC4E5B`.

The user may now replace installed `1.0.39` with the final `1.0.40` installer. This replacement changes only the Control Center application; it does not alter any ComfyUI installation, Python environment, plugin directory, model directory, or workflow.

## Preserved diagnostics

Failed isolated smoke profiles were intentionally preserved under:

```text
C:\Users\fangr\AppData\Local\Temp\fr-control-center-packaged-smoke-*
C:\Users\fangr\AppData\Local\Temp\comfyui-launcher-e2e-*
```

They contain synthetic isolated test state only, not the user's real Control Center or ComfyUI data.
