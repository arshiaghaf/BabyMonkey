# Local candidate validation

All results below use disposable synthetic users, passkeys, D1, certificates, and fake delivery. No provider resource or real notification was used. The candidate remains local and unpublished. Project source and original artwork now use [MIT](LICENSE); the [artwork record](docs/ARTWORK.md) documents the approved assets. Hosted and platform validation limits remain below.

The table includes inherited product evidence. The final-review correction section below identifies the fresh checks for this final local slice; unrelated inherited suites were not rerun.

## Acceptance evidence

| Check | Result | Reproducible evidence |
| --- | --- | --- |
| Site lint/type/unit | Pass, 93 unit tests | `site`: `npm run lint && npm run typecheck && npm test`; note-only component tests were removed with their components |
| D1 authorization and transaction invariants | Pass, 31 tests | `site`: `npm run test:d1`; invitation rejection/reuse, concurrent claims, pre/post-commit response loss, durable session invalidation, reset/re-enrollment, cardinality and user isolation |
| Fixed signal coordination | Pass | D1 tests exercise confirmed, definitive failure, ambiguous outcome, replay, cooldown, killed notification authority, stale sessions and user isolation |
| Worker-to-Go mTLS boundary | Pass, 5 tests | `site`: `npm run test:relay:local`; synthetic certificates and fake Telegram only |
| Setup and demo safety | Pass, 31 tests; product direct-entry code unchanged | `site`: `npm run test:setup`; redirected ancestor rejection, D1/KV sentinels, occupied-port server receives zero requests, root/path/override/origin rejection; runner lifecycle checks cover normal exit, startup failure/timeout and SIGINT/SIGTERM before readiness and during tests, including uncooperative descendants, zombie rows, and unrelated process/state preservation |
| Complete synthetic demo | Pass, 3 separate Chromium runs on unchanged direct-entry code | `site`: `npm run test:browser:demo`; fresh D1 and exclusive server per outcome; two independent enrollments, cancellation, reuse rejection, sign-out/authentication, zero signal on entry, equal signal authority, honest confirmed/failure/ambiguity presentation, reveal without a send |
| Visual preview | Pass, 25 Chromium checks | `site`: `npm run test:browser:development`; mobile/desktop geometry, keyboard, reduced motion, direct entry and six visual states |
| Actual production runtime | Pass, 3 Chromium checks on unchanged direct-entry code | Build first, then `site`: `npm run test:browser:production`; external synthetic config, offline Wrangler packaging, actual workerd bundle, canonical local HTTPS host mapping, anonymous shell/RSC/media/forged mutation denial, protected media, direct entry without a signal, virtual passkey cancellation/enrollment/authentication/sign-out, definitive failure and response-loss retry |
| Production fake authority exclusion | Pass | Actual bundle returns 404 with either demo flag or localhost production identity; production OpenNext artifact has no executable fake branch markers. Outer guard flag names are expected in the packaged entrypoint |
| Maintenance adapter | Pass, 24 tests | `maintenance/d1-rest-adapter`: `npm run check` |
| Maintenance CLI | Pass, 80 tests plus lint/type/leakage/package checks | `maintenance/maintenance-cli`: `npm run check`; 52 unit, 17 service/stack, 11 attached-TTY; includes committed response loss, delayed commit, provider denial and timeout through the actual adapter/repository/service |
| Relay | Pass | `relay`: `go test -race ./... && go vet ./...` |
| Production build and public artifact audit | Pass | `site`: `npm run build:cloudflare && npm run artifact:check`; all packaged public text checked against protected copy fragments, no public source maps, no fake executable markers, no PNG text/EXIF metadata |

Validation used Node.js 26.10.0 and npm 11.19.1 on macOS with existing local dependency trees, including locally copied dependency material. The advertised Node 22.13 minimum, complete supported-range compatibility, and a clean `npm ci` of this final source were not verified. POSIX process-group runners are macOS-tested; Linux is unverified and Windows runner support is not implemented.

The browser plugin was unavailable; installed Playwright Chromium ran the checks. A temporary mobile production screenshot was visually inspected in the preceding candidate validation; this direct-entry change was checked by browser geometry and focus assertions, but no new manual screenshot inspection was performed. Screenshots and reports are outside the source export and removed after review. Runtime bridge certificates, configuration and D1 are removed by the owned runner.

## Runner lifecycle follow-up

The final follow-up changes only local runner ownership, disposable-state allocation and validation documentation. Focused checks are serialized because the demo owns port 3000. The scratch suite tests both runners with uncooperative descendants, normal completion, startup failure, the actual two-minute startup deadline, and SIGINT/SIGTERM before readiness and during tests. Eight additional actual-runner parent-PID signal checks verified interruption before readiness and after real startup while preserving an unrelated listener and state. The production child also validates its parent-owned directory before writes and keeps runtime temporary files inside that directory.

The preceding candidate validation did not rerun every inherited suite for its runner-only follow-up. This direct-entry snapshot reran site unit, D1, relay-local, adapter, CLI, Go, all three demo outcomes, visual browser, setup/lifecycle, production build/artifact, and production browser checks. Node 22 and a clean dependency installation of this final snapshot remain unrun.

## Direct-entry and harness follow-up

The protected view and inert visual preview now show the monkey immediately. Note-only components, copy, CSS, replay controls, and their tests were removed. The remaining browser checks cover direct entry, no signal before a deliberate tap, display-only reveal, retry, keyboard access, reduced motion, and mobile/desktop fit.

An independent clean-install run of the preceding source snapshot reproduced a macOS `EPERM` on demo-runner cleanup after a passing confirmed browser test. The direct-entry snapshot reproduced it. The runner now checks active members of its own process group instead of treating lingering zombie rows as live work; active processes of another user or an inaccessible live group still fail closed. All three fake demo outcomes and the 21 setup/lifecycle tests passed afterward. The local HTTPS proxy also gained socket-disconnect handling after an `EPIPE` during production browser testing; all three production browser checks passed on rerun. These corrections change only local test infrastructure, not product or provider behavior.

## Consolidated corrections

1. Destructive shared-state reset was removed. Each demo uses a newly owned OS temporary D1; redirected legacy state ancestors are rejected before allocation. Existing D1/KV remain untouched.
2. Both browser runner parents now own separate process groups and disposable root state. SIGINT/SIGTERM cancel startup or test waits; cleanup stops only owned descendants with bounded escalation and removes owned state. A synthetic fixture matrix covers both runners, normal completion, startup failure/timeout and signals before readiness and during tests. SIGKILL/host failure cannot execute cleanup. The server binds before seed/preparation and fails on an occupied port. Browser runs own their server and never reuse an unrelated runtime. Each outcome gets a fresh database; termination cleans that run.
3. The external private-config convention uses absolute checkout paths for the guarded Worker, server-only alias, packaged assets and migrations. Static checking and offline packaging were demonstrated together with synthetic values.
4. Nonobject roots, unsupported environment/build overrides, unguarded assets and mismatched paths fail validation. Only the tested configuration shape is accepted.
5. Runtime identity, outer Worker, setup checker and CLI share canonical HTTPS DNS origin validation. IP, local/reserved, malformed, mixed-case, path/port and inconsistent origins fail before owner mutation.
6. Protected entry and the inert preview now open directly to the monkey. Sentence onboarding, its replay control, and its delay were removed. Original personal copy was checked across exported source, tests, lockfiles, generated artifacts and source maps.
7. The production browser and maintenance integration stack were restored by explicit file selection. Production trust remains canonical; fake transport exists only outside the production artifact. Public artifact auditing covers every protected presentation string/fragment, not just two sentences.
8. TypeScript build caches are ignored and removed. Private planning material remains excluded; subsequent release preparation below records the selected MIT license.

## Privacy and cleanup limits

The private-source comparison found no original personal copy or known operational identifiers in the audited candidate source, tests, lockfiles and generated text. Automatic IP-presence integration and its migration are absent; WebAuthn user-presence verification remains required. The retained migrations are 0001–0005.

Generated server artifacts contain absolute candidate checkout paths from the build tools. The generated `.next` and `.open-next` trees, TypeScript cache, CLI distribution/cache, and synthetic run log were inspected or tested and removed. The ignored local `site/.wrangler` tree was preserved because its prior ownership was not established; it is outside the source snapshot and must remain outside any release artifact. Rebuild from a neutral path and inspect the exact release artifact before publication. Installed dependencies remain ignored local tooling. Private planning material has since been relocated outside the checkout with exact bytes and owner-only permissions preserved, as recorded in the release-preparation section below.

No Git initialization, commit, push, repository/PR creation, deployment, provisioning, hosted validation, live D1 operation or real Telegram request occurred. Real Safari/iPhone, synchronized passkeys, provider configuration, hosted mTLS and delivery, hosted recovery operations and production readiness remain unverified.

## Source snapshot

From the candidate root run `node scripts/source-snapshot.mjs`. It hashes sorted relative POSIX paths; each UTF-8 record is the path, NUL, lowercase SHA-256 of exact file bytes, then LF. SHA-256 of the concatenated records is the source snapshot. Dependency/generated directories, private planning material, TypeScript caches, local JSON configuration and `.DS_Store` are excluded explicitly in the script. The snapshot includes this document and the script itself; no self-referential stored hash is needed.

## Setup documentation follow-up

The direct-entry implementation snapshot passed the product checks listed above. This follow-up added two separate relay setup helpers; `python3 -m unittest discover -s relay/ops -p 'test_install_helpers.py'` passed twenty synthetic tests. They cover echo-disabled pseudoterminal input typed on prompt flush, echo restoration after prompt failure, fake Bot API data, private chat selection, atomic credentials, deny-all replacement precondition, TLS configuration, lineage and trust checks, unrelated-lineage exclusion, stopped/active installation, a start command that returns success while the service is inactive, successful old-pair rollback, failed rollback retaining marker and backups, both-backup preflight before stopping service, and interrupted first-install/renewal recovery. The tests use temporary files, generated synthetic certificates, and a stub service. They make no real Bot API request or systemd change. A synthetic client CA/leaf generated with the guide's illustrative OpenSSL commands passed `openssl verify -purpose sslclient`; this does not validate Cloudflare upload or hosted TLS. Provider documentation was reviewed, but no hosted command, real Bot API call, Certbot hook, migration, or deployment was executed.

During this helper follow-up, `go test ./...` passed in `relay/`, `sh -n relay/ops/babymonkey-certbot-deploy-hook` passed, and all 21 shell examples in `docs/SETUP.md` parsed with `sh -n`. `npm run test:setup` passed all 21 tests with local loopback enabled. No Go or site runtime file changed after those runs. The restricted sandbox first blocked the suite's `127.0.0.1` listener with `EPERM`; the same suite then passed unchanged with loopback access. The other inherited product suites above were passed on the earlier direct-entry snapshot and were not rerun for these isolated setup-helper changes.

The guide now documents the attached-TTY credential installer and regular-file server TLS installer/deploy hook. Its first-install preflight precedes mutation; it specifies client-CA transfer, initial Certbot issuance, renewal scheduling checks, the remote-D1 migration return point, deny-all first start, exact-leaf opening, and deny-all/stop recovery. Both helpers and the sequence require owner review on the actual host, and unattended renewal has not been observed. Source and original artwork licensing have since been recorded under MIT in the release-preparation section below.

## Final-review correction slice — September 29, 2026

The starting source snapshot was 225 files / `578cbbbf742b86b883a588431d0e132c4043c7c2cea0532712c58a2bcb9d8144`. Three independently reproduced defects were corrected together:

- The Go allowlist writer emits canonical `[]` for both nil and empty deny-all inputs. A Go regression executes the real Python credential helper's `deny_all` check against writer-produced bytes; the two-leaf capacity, lowercase fingerprint, duplicate, caller-slice, atomic replacement and owner-only file bounds remain covered.
- The guide's first-install user/group checks use explicit conditional failure. `relay/ops/test_setup_preflight.py` extracts and executes the actual documented shell block with stub commands and redirected synthetic paths. Ten cases cover clean startup, existing user/group/service, a failed service inspection, each of four occupied paths and a dangling symlink; every refusal precedes a stub mutation marker. No host user, unit, path or service is changed.
- Every Playwright config now allocates an exclusive OS temporary results root before output clearing, including direct invocation. The allocator captures its own filesystem identity, accepts no environment-supplied deletion path and bounds its filesystem-only cleanup subprocess to five seconds. That subprocess has a separate process group so the existing runner's group shutdown cannot interrupt result cleanup. Ten real-Playwright synthetic checks cover all three configs on normal exit/SIGINT/SIGTERM, unrelated sentinel preservation and concurrent allocation/isolation. The nine single-run cases verify all announced roots disappear; the concurrent case verifies stopping one run preserves the other's root, then verifies its cleanup.

Fresh validation on Node 26.10.0/npm 11.19.1/macOS with existing dependencies:

| Check | Result |
| --- | --- |
| `relay`: `go test -race ./... && go vet ./...` | Pass, including real writer-to-helper interoperability |
| Root: `python3 -B -m unittest discover -s relay/ops -p 'test_*.py'` | Pass, 21 tests including the ten-case extracted preflight |
| `site`: `npm run lint && npm run typecheck` | Pass |
| `site`: `npm run test:setup` | Pass, 31 tests; actual two-minute startup timeout and bounded owned cleanup included |
| `site`: `npm run build:cloudflare && npm run artifact:check` | Pass |
| `site`: `npm run test:browser:production` | Pass, 3 actual local workerd/Chromium tests |
| `site`: `npm run test:browser:demo` | Pass, one Chromium test for each of confirmed, definitive-failure and ambiguous fake outcomes |
| `site`: `npm run test:browser:development` | Pass, 25 Chromium checks |

The first new ownership-test attempt exposed a SIGTERM race between group shutdown and filesystem cleanup; the cleanup subprocess's separate group corrected it. All ten ownership cases then passed independently and again inside the complete 31-test setup suite. Three uniquely identified synthetic fixture roots from that first attempt were inspected and removed. Passing corrected browser runs removed their owned result roots and runtime scratch. A read-only before/after comparison of the three legacy shared output directories found their currently observed state unchanged by the fresh full browser runs; no legacy shared directory was removed. Worker 5's earlier production invocation may have cleared unknown prior contents. No earlier preservation or recovery is claimed.

Generated `.next`, `.open-next` and TypeScript build cache from these fresh runs were removed after validation. The prior-ownership `.wrangler` tree and installed dependencies remain preserved and excluded; the private planning file remains mode 600 and byte-identical. No private-repository edit, Git initialization/commit, publication, provider/VPS/systemd operation, real D1 test data or real Telegram call occurred. Product authorization, direct monkey entry/no automatic send, fixed signal, mTLS relay and credential custody are unchanged.

Site unit/D1/Worker-to-relay, maintenance adapter and CLI results remain inherited from the preceding direct-entry validation, not fresh runs in this slice. Node 22, a clean installation of these exact final bytes, Linux/Windows, real Safari/iPhone/synchronized passkeys and hosted operations remain unverified. The Browser plugin was unavailable, so the installed Playwright suites were used; no new manual Chrome or screenshot review occurred. Worker 5 subsequently accepted the complete corrected 230-file snapshot `bd9cf71030fa4e418234cb6e7326725a29a79a260e4398e02718fd2154259164` with no actionable findings. The following release-preparation slice changes only documentation and licensing; the lead still reviews its exact diff before staging and publication. Use the source-snapshot script for the exact final digest, since this validation document is itself hashed.

## MIT release preparation — September 29, 2026

After Worker 5 accepted the corrected 230-file engineering snapshot, the owner selected MIT with `Copyright (c) 2026 arshiaghaf` and approved release of the original project artwork under the same license. `LICENSE` contains the standard MIT text; `docs/ARTWORK.md` records the existing original Image Gen provenance and SHA-256 of all eleven included PNGs. Third-party dependencies retain their own license terms. README contains the owner's exact approved short origin note, with no identifying relationship details.

Only these seven release files changed or were added in this slice:

- `LICENSE`
- `docs/ARTWORK.md`
- `README.md`
- `docs/SETUP.md`
- `AGENT_SETUP_PROMPT.md`
- `EXPORT_INVENTORY.md`
- `VALIDATION.md`

Every runtime, test, configuration, dependency manifest/lockfile and artwork byte matches the accepted engineering snapshot. The private planning note was relocated into a durable owner-only directory outside both repositories, with exact bytes preserved, mode-700 parent and mode-600 file. It is absent from the candidate; its ignore and snapshot exclusions remain as protection. Five verified integrated Worker 4 draft files were preserved as owner-only audit evidence outside the export, then their disposable temporary copies and two empty directories were removed. This slice's temporary check script was removed after its sanitized results were preserved privately.

Fresh release checks passed: standard MIT body and attribution; exact single README origin paragraph; balanced Markdown fences and 25 local links; all 21 shell examples parsed; unchanged runtime/artwork byte comparison; 48 known non-placeholder private operational identifiers with zero source matches; zero private identity/domain/path markers after excluding the explicitly approved public handle; no complete private-key blocks; and no PNG text/EXIF metadata. All eleven artwork hashes match the provenance inventory. No product suites were rerun for this documentation/license-only change.

Existing dependency trees, uncertain prior-ownership `.wrangler` state and legacy shared browser-result directories were preserved. Older review copies, summaries and a screenshot whose deletion ownership was not established in this slice remain outside the export for lead judgment. Prior shared-output preservation uncertainty is unchanged. Durable private planning and audit evidence are retained intentionally.

The candidate remains a separate local directory without Git initialization. The lead reviews the exact documentation diff and owns subsequent export staging and GitHub naming/publication. No repository rename/create/push, provider or production action occurred here. Hosted setup/live delivery/renewal, real Safari/iPhone and synchronized passkeys, Linux/Windows owner tooling, and the declared Node 22 minimum remain unverified. Use `node scripts/source-snapshot.mjs` for the exact new digest; this document is itself included.
