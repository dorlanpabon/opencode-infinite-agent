# Security policy

## Supported versions

Security fixes are applied to the latest release.

## Reporting

Report vulnerabilities privately through GitHub Security Advisories. Do not include credentials, private prompts, source code, or session transcripts in public issues.

## Security boundaries

- The desktop renderer is sandboxed and has no Node.js access.
- OpenCode connections are limited to loopback addresses.
- Server credentials are read from the process environment, never stored by the app, and are only sent to the validated local origin.
- Automatic permission approval is off by default and is restricted to the managed session.
- Unsigned preview builds may trigger Windows SmartScreen or macOS Gatekeeper. Verify `SHA256SUMS.txt` before installation.

This supervisor can still cause OpenCode to edit files or run commands with the permissions configured in OpenCode. Review the selected workspace and permission mode before starting a run.
