# Security Policy

## Supported Versions

Only the latest minor release is supported. Halo is young and moves fast; please upgrade (`halo upgrade`) before reporting.

## Reporting a Vulnerability

Please report privately via [GitHub's private vulnerability reporting](https://github.com/turmind/halo-agent/security/advisories/new) on this repository (`turmind/halo-agent`) instead of opening a public issue.

## Response Expectations

There's no SLA, but security reports get priority over feature work.

## Known Boundaries

- The OS sandbox (bubblewrap on Linux, Seatbelt on macOS) limits writes and hides credential paths in `workspace` / `readonly` sessions; it does not isolate the network, and the rest of the host filesystem stays readable.
- Windows has no sandbox: a `workspace` session is effectively `full`, and `readonly` can read any path the halo process can.
- The admin is single-tenant and serves plain HTTP on all interfaces; holding the admin cookie means full control of the server. Put it behind a firewall, VPN, SSH tunnel or a TLS reverse proxy.
- Preview extensions run same-origin with the admin and are trusted like skills — install only ones you trust.

See [Status & Limitations](README.md#status--limitations) for the full threat model.
