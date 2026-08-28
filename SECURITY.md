# Security Policy

## Supported versions

CoasterWatch is a hobby project with a single maintained line — only the
latest release on the [appstore listing](https://apps.rePebble.com/702bd7b27ec8456280b5ab7a)
and the `master` branch here are supported. There are no older versions
receiving security fixes.

## Scope

CoasterWatch has no backend or server of its own. The phone-side companion
talks directly to [Queue-Times.com](https://queue-times.com/en-US)'s public,
read-only, unauthenticated API, and to the watch itself over Bluetooth via
standard Pebble APIs. It doesn't have user accounts, doesn't collect or
transmit any personal data, and the only sensitive-ish input (GPS location,
used locally to compute distance-to-ride) never leaves the phone/watch pair.

Given that scope, realistic reports are most likely to be about the settings
webview (it renders a self-contained HTML page inside the Pebble mobile
app) or a dependency (`@rebble/clay`, `jsdom` for tests) rather than a
classic client-server vulnerability class.

## Reporting a vulnerability

Please use GitHub's private reporting flow rather than a public issue:

**[Report a vulnerability](https://github.com/chrisc123/coasterwatch/security/advisories/new)**
(Security tab → "Report a vulnerability")

This keeps the report private between you and the maintainer until a fix is
out. For anything that isn't security-sensitive (a bug, a feature request),
please just open a regular [issue](https://github.com/chrisc123/coasterwatch/issues)
instead.

There's no bounty program — this is an unpaid hobby project — but reports
are genuinely appreciated and will get a response.
