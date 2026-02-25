# Security Policy

## Supported Versions

Security updates are provided for the latest minor line of `@xyteai/cli` in `0.x`.

- `0.3.x`: supported
- `<0.3.0`: not supported

## Reporting a Vulnerability

Report vulnerabilities privately by emailing `security@xyte.io`.

Include:
- affected version (`npm view @xyteai/cli version` output or package version)
- environment details (OS, Node version)
- clear reproduction steps
- impact assessment

Do not open public issues for undisclosed vulnerabilities.

## Response Expectations

- Initial triage response target: within 3 business days.
- Confirmed vulnerabilities are fixed in the next available patch/minor release.
- Breaking mitigations are called out in `CHANGELOG.md`.

## Release Security Gates

The release process includes:
- CI matrix validation (`typecheck`, `test`, `build`, `npm pack --dry-run`)
- dependency audit (`npm audit --audit-level=high`)
- release SBOM + checksums for tagged builds
