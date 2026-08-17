# M9 — Windows signing and bilingual delivery

## Current state

- The application UI ships complete English (`locales/en.json`) and Simplified Chinese (`locales/zh.json`) message trees. The first launch follows the Windows language; **Settings → Language** switches live without reinstalling.
- The Windows NSIS installer now includes `en_US` and `zh_CN`. It follows the Windows display language automatically. Standard pages and every FR-owned progress, warning, and shortcut string are bilingual.
- The current development machine has a non-exportable self-signed code-signing key in `CurrentUser\My`, with its public certificate trusted in `CurrentUser\Root` and `CurrentUser\TrustedPublisher`. It enables a durable local build for this Windows user, but it is not a public-release publisher identity.

## Why no self-signed public build

A self-signed certificate is useful only for a controlled test fleet after its root certificate has been installed on every machine. Microsoft states that self-signed applications receive the same SmartScreen treatment as unsigned applications. Installing a new trusted root also changes the Windows trust store and must remain an explicit administrator decision.

For public delivery, use one of:

1. A CA-issued OV or EV code-signing certificate (PFX/hardware-backed provider).
2. Microsoft Artifact Signing, where the publisher and region are eligible.
3. Microsoft Store distribution.

A valid signature identifies the publisher and protects file integrity, but Microsoft notes that even a new OV/EV certificate can initially encounter an “unrecognized app” reputation warning.

## Fail-closed signed build

Secrets are never stored in the repository. Configure one supported provider in the release shell, then run `pnpm run build:win:signed`.

### PFX/PKCS#12

```powershell
$env:WIN_CSC_LINK = 'C:\secure\FR-AI-Code-Signing.pfx'
$env:WIN_CSC_KEY_PASSWORD = '<from a secret manager>'
pnpm run build:win:signed
```

### Certificate already installed in Windows

```powershell
$env:CSC_NAME = 'FR ComfyUI Control Center Local Signing'
pnpm run build:win:signed
```

The signed command performs four mandatory gates:

1. Refuses to start without complete signing identity configuration.
2. Builds with electron-builder `forceCodeSigning=true`; `CSC_NAME` is converted to the explicit Windows certificate-store selector, so an unsigned artifact fails the build.
3. Verifies the packaged `app.asar` contains the complete production dependency closure required by `electron-updater` and `@todesktop/runtime`.
4. Uses Windows Authenticode verification on both the packaged application and final installer; anything other than `Valid` fails the release.

The ordinary `pnpm run build:win` remains available for internal unsigned test candidates and is never presented as a trusted public release.

## M9 acceptance result

- Full unit suite: 267 files / 4,410 tests passed with zero retries.
- Integration suite: 7 files / 46 tests passed with zero retries.
- Node, renderer, E2E and integration TypeScript checks passed; ESLint and Prettier checks passed.
- Production Electron build and bilingual NSIS installer build passed.
- The packaged updater dependency closure passed, and the signed unpacked application passed an isolated real-startup smoke in the current user's desktop context (`panel.html`, `comfyTitleBar.html`, and `comfyTitlePopup.html`).
- The local certificate-store build completed with `forceCodeSigning=true`. Both the packaged application and NSIS installer verify as `Valid`, signed by `CN=FR ComfyUI Control Center Local Signing` (thumbprint `E6582CA50AB31CECA76447AF047DE244C42E077B`) with a DigiCert SHA-256 timestamp.
- `1.0.39` had an incomplete pnpm runtime dependency closure (`fs-extra` and related updater dependencies), which could prevent startup. `1.0.40` promotes that closure to explicit production dependencies and blocks future packages that omit it. `1.0.41` restores the tray-resident lifecycle with bilingual close behavior and managed stop-all exit.
- Manual Windows acceptance on 2026-08-17 confirmed that X hides the installed `1.0.41` application when **When app is closed** is set to tray. The explicit quit preference intentionally overrides that default and performs managed stop-all exit.
- The final locally signed bilingual installer is `dist/FR-ComfyUI-ControlCenter-1.0.41-win-x64.exe`, SHA-256 `2213F79517E69EC15B002275ECE978D6806874492B18B6997FA0816151CC5502`.
- The final bilingual guide is maintained in `docs/USER_GUIDE.zh-CN.en.md` and generated to `dist/docs/FR-ComfyUI-ControlCenter-User-Guide.zh-CN.en.docx`, SHA-256 `8D11C45757D9F725F3EB23AB8AF10F9500D9BBF0BBA45A11E5955C72B4C5FB4C`. The generated document passed structural re-open validation (152 paragraphs and 8 tables).
- No stable installation or shared model library was read, modified, launched, migrated, linked, or reorganized during M9.

## References

- Microsoft: [Smart App Control and SmartScreen reputation](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)
- Microsoft: [SignTool](https://learn.microsoft.com/en-us/windows/win32/seccrypto/signtool)
- electron-builder: [Code signing](https://www.electron.build/docs/features/code-signing/)
- electron-builder: [NSIS options](https://www.electron.build/docs/api/electron-builder.interface.nsisoptions/)
