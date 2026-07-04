# Security Policy

## Supported Versions

Only the latest minor release is supported. Halo is pre-1.0 and moves fast; please upgrade (`halo upgrade`) before reporting.

## Reporting a Vulnerability

Please report privately via [GitHub's private vulnerability reporting](https://github.com/turmind/halo-agent/security/advisories/new) on this repository (`turmind/halo-agent`) instead of opening a public issue.

## Response Expectations

There's no SLA, but security reports get priority over feature work.

## Known Boundaries

The bubblewrap sandbox isolates the filesystem, not the network — code running inside it can still make outbound connections. See [Status & Limitations](README.md#status--limitations) for the full threat model.
