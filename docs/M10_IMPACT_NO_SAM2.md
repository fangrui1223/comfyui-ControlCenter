# M10: Impact Pack without SAM2

## Scope

This policy applies only to `C:\FR_comfyui_next`. Stable `C:\FR_comfyui` is not changed.

Impact Pack contains many non-SAM2 nodes (detailer, SEGS, masks, samplers, and utility nodes), while its SAM2 video detector requires the separate `sam2` Python package. The FR policy blocks only the `sam2` pip package through ComfyUI-Manager v4's per-install `pip_blacklist.list`.

## Expected behavior

- Impact Pack's ordinary nodes can load and be used.
- `SAM2 Video Detector (SEGS)` and other SAM2-specific paths are intentionally unavailable.
- SAM3/SAM3.1 nodes remain separate and are not presented as a SAM2 replacement.
- Normal plugin package upgrades do not overwrite the policy because it is stored under the installation's `ComfyUI/user/__manager` directory. A full environment recreation or deletion of the Manager user directory requires reapplying the policy.

## Apply

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\fr-configure-impact-no-sam2.ps1 -InstallRoot C:\FR_comfyui_next
```

The script writes:

- `C:\FR_comfyui_next\ComfyUI\user\__manager\pip_blacklist.list`
- `C:\FR_comfyui_next\.fr-control-center\policies\impact-pack-no-sam2.json`

## Rollback

Remove only the `sam2` line from `pip_blacklist.list`, then install SAM2 separately and restart Next. Do not modify Stable or the shared model library.
