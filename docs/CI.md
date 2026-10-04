# Continuous integration

The `CI` workflow runs on every pull request targeting `main`, every push to
`main`, and manual dispatch. All five jobs run on every change, including
documentation and dependency updates, so their status names can be required
without path-filtered checks staying pending.

Independent demo/preview browser suites and the renewal-hook syntax check still
run after an earlier test fails. Earlier failures keep their job red.

| Stable check name | Coverage |
| --- | --- |
| `Site checks` | ESLint, TypeScript, unit tests, local D1 migrations and authorization tests, synthetic Worker-to-Go mTLS, setup and runner lifecycle tests |
| `Cloudflare build and browsers` | Next build through OpenNext, Cloudflare Worker build, artifact privacy checks, Chromium against local production workerd/D1, all three fake demo outcomes, development preview |
| `D1 adapter checks` | ESLint, TypeScript, adapter and repository contract tests |
| `Maintenance CLI checks` | ESLint, TypeScript, unit and integration tests, actual macOS attached-TTY lifecycle tests, source leakage audit, bundle build and package dry run |
| `Relay and setup helpers` | Go race tests, vet, command builds, synthetic Python installer/preflight tests, certificate renewal hook syntax |

Node.js is pinned to 24.21.0 (LTS) in CI and `.node-version`; all three npm
packages require Node >=24.21.0 and use `@types/node` 24.19.1. Go is pinned to 1.27.1, and Python to 3.14.8.
GitHub Actions are pinned to immutable release commit SHAs. npm downloads are
cached by the relevant lockfile; Go caches are keyed from `relay/go.mod` (the
relay has no external modules or `go.sum`). Installs use `npm ci` and do not
rewrite lockfiles. The site relay harness reuses a warmed Go build cache to
avoid spending its startup deadline compiling the standard library.

Linux jobs use Ubuntu 24.04. The CLI runs on macOS 15 because its attached-TTY
tests require `/usr/bin/expect` and otherwise skip on Linux. CI does not establish
Linux CLI support, native Windows support, real
Safari/iPhone passkeys, or hosted production behavior.

The workflow grants only `contents: read`, does not persist checkout credentials,
uses no production secrets, and never deploys or changes repository settings.
Production browser tests use offline Wrangler packaging and local synthetic
bindings with outbound networking blocked. D1 and relay tests use disposable
state and fake delivery; no real Telegram request is sent. Browser packages and
dependencies are downloaded during installation. Build output, synthetic state,
and browser logs are not uploaded as workflow artifacts.

Require all five check names above when configuring main protection. Choose
the GitHub Actions app as their source and verify actual successful runs first.
This workflow itself does not configure branch protection or merge policies.
