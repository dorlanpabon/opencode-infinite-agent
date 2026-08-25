# Security policy

## Supported versions

Security fixes are applied to the latest release.

## Reporting

Report vulnerabilities privately through GitHub Security Advisories. Do not include credentials, private prompts, source code, or session transcripts in public issues.

## Security boundaries

- The desktop renderer is sandboxed and has no Node.js access.
- OpenCode connections are limited to loopback addresses.
- Manually attached server credentials are read from the process environment, never stored by the app, and are only sent to the validated local origin.
- The OpenCode Desktop plugin exposes a minimal API on a random `127.0.0.1` port, authenticates every request with a random bearer token, and stores its ephemeral registry with restrictive permissions.
- Automatic permission approval is off by default, restricted to newly created managed sessions, and unavailable when adopting existing OpenCode Desktop sessions.
- Unsigned preview builds may trigger Windows SmartScreen or macOS Gatekeeper. Verify `SHA256SUMS.txt` before installation.

This supervisor can still cause OpenCode to edit files or run commands with the permissions configured in OpenCode. Review the selected workspace and permission mode before starting a run.
