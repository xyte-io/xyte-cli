# Windows Installer

Use the Windows installer when you want Xyte CLI to feel like a normal Windows tool: no separate Node.js install, no `npx`, and a stable `xyte-cli` command on `PATH`.

The MSI does not replace the Node/npm install path. `npm install -g @xyteai/cli@latest` and `npx -y @xyteai/cli@latest ...` remain supported for developers, CI, and agent environments that already manage Node.js.

## What the MSI installs

The MSI installs into `C:\Program Files\Xyte CLI`:

- `xyte-cli.cmd`
- a bundled Windows x64 Node.js runtime
- built CLI files under `dist`
- production `node_modules`
- shipped agent skills and JSON schemas
- `install-channel.json`, which marks this install as the `windows-msi` update channel
- `scripts\configure-xyte-cli.ps1`, the post-install setup and migration assistant

The installer adds `C:\Program Files\Xyte CLI` to the machine `PATH` and creates Start Menu shortcuts:

- **Configure Xyte CLI**: checks migration, asks for API-key setup, and verifies readiness
- **Xyte CLI PowerShell**: opens PowerShell with a quick CLI/version diagnostic

For an interactive first install, the MSI launches **Configure Xyte CLI** at the end of the install. Silent deployments do not launch an interactive prompt; run the assistant in the signed-in user's context after installation.

## Fresh install

1. Download `XyteCLI-<version>-win-x64.msi` from the GitHub release.
2. Install it normally.
3. When **Configure Xyte CLI** opens, follow the prompts for npm migration and setup.
4. When prompted, paste the API key into the CLI prompt. The prompt hides input.

If the assistant was skipped or closed, open **Configure Xyte CLI** from the Start Menu.

The API key is not passed through MSI properties. It is handled by `xyte-cli setup run`, which uses Windows DPAPI when native secure storage is available.

After setup:

```powershell
xyte-cli doctor environment --format json
xyte-cli setup status --field tenantId
```

## Migrate from npm or npx

Existing configuration and API keys live under the same user profile locations, so replacing a previous command-line install does not require creating a new key.

After installing the MSI, run **Configure Xyte CLI**. It checks:

- which `xyte-cli` commands are visible on `PATH`
- whether `npm list -g @xyteai/cli --depth=0` finds a previous global install
- whether the Windows installer command or npm command will win on `PATH`

If it finds a global npm install and you want the MSI to be the only local update channel, accept the prompt to remove it:

```powershell
npm uninstall -g @xyteai/cli
```

If you intentionally keep the npm global install, verify which command wins on `PATH` and update through that channel. Then open a new PowerShell window and verify:

```powershell
Get-Command xyte-cli -All
xyte-cli upgrade --check --format json
```

The upgrade check should report:

```json
{
  "installChannel": "windows-msi",
  "recommendedCommand": "winget upgrade --id Xyte.XyteCLI --exact"
}
```

If a user only used `npx -y @xyteai/cli@latest ...`, there is usually nothing to uninstall. The MSI command becomes the durable local command, while `npx` remains available for one-off latest-version runs.

## Enterprise or Intune install

Silent install:

```powershell
msiexec /i XyteCLI-<version>-win-x64.msi /qn /norestart
```

Run setup after install in the signed-in user's context, not as a machine-wide MSI property:

```powershell
& "$env:ProgramFiles\Xyte CLI\scripts\configure-xyte-cli.ps1" `
  -Tenant "<tenant-id>" `
  -KeyFile "<path-outside-workspace>" `
  -AssumeYes `
  -NonInteractive
```

For Intune detection, check that this file exists:

```powershell
$env:ProgramFiles\Xyte CLI\xyte-cli.cmd
```

For readiness detection after user setup:

```powershell
xyte-cli setup status --tenant <tenant-id> --field tenantId
```

## Updates

The MSI install is a separate update channel from npm. A Windows installer deployment should update with WinGet or a newer MSI. Node-based installs should keep using `npm install -g @xyteai/cli@latest` or `npx -y @xyteai/cli@latest ...`.

Check:

```powershell
xyte-cli upgrade --check --format text
```

Apply through WinGet:

```powershell
winget upgrade --id Xyte.XyteCLI --exact
```

When WinGet is not available, download the newer MSI and run:

```powershell
msiexec /i XyteCLI-<new-version>-win-x64.msi /qn /norestart
```

The MSI uses a stable `UpgradeCode`, so newer MSI versions replace older MSI versions.

Release packaging generates WinGet manifest YAML under `artifacts/windows-installer/winget`. After the signed MSI is published to the GitHub release, submit those manifests to the WinGet package repository for `Xyte.XyteCLI`.

## Build from this repo

On Windows:

```powershell
npm ci
dotnet tool install --global wix --version 7.0.0
npm run package:windows-msi -- --out-dir artifacts/windows-installer
```

The packaging script invokes WiX with `-acceptEula wix7`, matching the WiX 7 Open Source Maintenance Fee EULA gate. WiX MSI compilation is supported on Windows runners; use `--skip-msi` on other platforms for metadata-only packaging checks.

For a metadata-only validation:

```powershell
npm run validate:windows-packaging
```
