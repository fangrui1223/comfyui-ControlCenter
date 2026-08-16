# M9 — Windows signing and bilingual delivery

## Current state

- The application UI ships complete English (`locales/en.json`) and Simplified Chinese (`locales/zh.json`) message trees. The first launch follows the Windows language; **Settings → Language** switches live without reinstalling.
- The Windows NSIS installer now includes `en_US` and `zh_CN`. It follows the Windows display language automatically. Standard pages and every FR-owned progress, warning, and shortcut string are bilingual.
- The current development machine has Microsoft SignTool but no trusted code-signing certificate/private key in the Current User or Local Machine certificate stores. A trusted public-release signature therefore cannot be created until a publisher identity is supplied.

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
$env:CSC_NAME = 'FR AI'
pnpm run build:win:signed
```

The signed command performs three mandatory gates:

1. Refuses to start without complete signing identity configuration.
2. Builds with electron-builder `forceCodeSigning=true`, so an unsigned artifact fails the build.
3. Uses Windows Authenticode verification on both the packaged application and final installer; anything other than `Valid` fails the release.

The ordinary `pnpm run build:win` remains available for internal unsigned test candidates and is never presented as a trusted public release.

## M9 acceptance result

- Full unit suite: 266 files / 4,398 tests passed with zero retries.
- Integration suite: 7 files / 46 tests passed with zero retries.
- Node, renderer, E2E and integration TypeScript checks passed; ESLint and Prettier checks passed.
- Production Electron build and bilingual NSIS installer build passed.
- The signed-release preflight correctly refused to run because this machine has no usable code-signing certificate. The post-build verifier correctly rejected the internal installer and packaged app as `NotSigned`.
- The final internal bilingual installer is `dist/FR-ComfyUI-ControlCenter-1.0.39-win-x64.exe`, SHA-256 `89D75D0030B6096738DE48AE66F461B26EA5EB19CBB29D5209628BAA8E83158E`.
- The 16-page bilingual guide is `dist/docs/FR-ComfyUI-ControlCenter-User-Guide.zh-CN.en.docx`, SHA-256 `910C9D9F7037E0A0D01D6FCC4B4904E57529C3B7B291751D63D89F24863EDB12`; all pages were rendered and visually inspected.
- No stable installation or shared model library was read, modified, launched, migrated, linked, or reorganized during M9.

## References

- Microsoft: [Smart App Control and SmartScreen reputation](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)
- Microsoft: [SignTool](https://learn.microsoft.com/en-us/windows/win32/seccrypto/signtool)
- electron-builder: [Code signing](https://www.electron.build/docs/features/code-signing/)
- electron-builder: [NSIS options](https://www.electron.build/docs/api/electron-builder.interface.nsisoptions/)
