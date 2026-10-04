# Set up BabyMonkey

This guide starts with a harmless local demo and then maps an owner-reviewed hosted installation. The hosted path is **a manual plan, not a completed validation of this skeleton**. The private credential and TLS helpers have synthetic local tests, but have not run on a VPS or with a real bot or certificate. Commands below assume a macOS owner computer, an Ubuntu VPS with `systemd`, and a checkout of this skeleton. Linux owner terminals may work, but the maintenance CLI's attached-TTY tests ran on macOS; its optional clipboard feature is macOS-only. Native Windows is unsupported by the CLI and local demo runners.

## 1. Know what you are setting up

There are exactly two equal product users and one deliberate monkey action. Each user has one stable account slot, one registered passkey credential, and a private invitation for first enrollment. Neither product user can administer the app. The owner separately uses a local, interactive maintenance CLI for invitations, resets, session revocation, and the notification switch.

| Piece | What it does | Where it runs |
| --- | --- | --- |
| Browser and passkey | Opens a private invitation, authenticates, and taps the one monkey | Each user's browser and authenticator |
| Cloudflare Worker, OpenNext, D1 | Serves the app, verifies passkeys and sessions, tracks bounded signal state | Your Cloudflare account and app hostname |
| Go relay | Accepts only the fixed operation from an exact client certificate and calls Telegram | Your isolated VPS and separate DNS-only hostname |
| Owner CLI | Creates invitations and changes narrowly defined authorization state | Your own attached terminal, outside the app |

The Worker has **no Telegram token, destination, or message configuration**. Only the relay's owner-only file has those values. D1 starts with notifications disabled. A confirmed result means Telegram accepted a send request, not that the recipient saw it. A timeout can be ambiguous; a later deliberate attempt may duplicate a notification. The app has no signal history, message choices, freeform input, or automatic alerting.

Before creating resources, choose and write down privately:

1. One permanent app hostname under a Cloudflare-managed active zone, for example `monkey.your-domain.tld`. Its RP ID is that hostname and its exact origin is `https://monkey.your-domain.tld`. **Finish this choice before either person enrolls a passkey.** A later change may require reset and re-enrollment.
2. A separate relay hostname, for example `relay.your-domain.tld`, pointing straight to the VPS with a **DNS-only** record. Cloudflare-proxied relay traffic cannot use the Worker mTLS binding.
3. A Cloudflare account, a new dedicated D1 database, and a distinct Worker name; an isolated Ubuntu VPS with an administrator login; a new Telegram bot and one private destination; and a private folder on the owner computer for Wrangler config and client-certificate material.
4. Whether the hosted setup is authorized to create paid resources, change DNS, install a service, deploy the Worker, enable notifications, and make a real send. These are separate actions. The guide's local demo does none of them.

Never paste API tokens, bot tokens, invitation links, chat IDs, private keys, or credential-file contents into chat, Git, an issue, shell arguments, or logs. Public repository commits can reveal even protected application copy. Keep owner wording and configuration in a private deployment path.

Project source and the included original monkey artwork use the [MIT license](../LICENSE), attributed to `2026 arshiaghaf`. See the [artwork provenance and exact asset inventory](ARTWORK.md). Third-party dependencies retain their own license terms.

## 2. Try it locally first

Install Node.js **24.21 or newer**, npm, and a current browser. The root `.node-version` pins 24.21.0, matching CI; upgrade Node 22 before installing dependencies. This requirement covers local tooling and builds, while Cloudflare Workers use the supplied compatibility settings. The optional browser suite needs Chromium (`npx playwright install chromium`). Go 1.25+ is needed for relay checks, not this first demo.

In a terminal, change to this checkout's `site` directory:

```sh
cd site
npm ci
npm run demo
```

Expected: the terminal announces `http://localhost:3000` and displays **two different synthetic invitation URLs**. Open them in separate browser profiles and deliberately confirm each passkey prompt; each authorized page opens directly to the monkey without sending a signal. This run uses a disposable local D1 and a **confirmed fake**, with no Telegram or Cloudflare call. Stop with Ctrl-C and check that the process and disposable state actually exit. If cleanup reports an error, preserve it and do not delete unrelated processes or state. If port 3000 is occupied, startup stops before creating its D1; free the port or stop the process you own. `npm run demo:failure` and `npm run demo:ambiguous` each create a fresh fake run. Do not use their invitation URLs after termination.

For an automated local exercise, from `site/` run `npx playwright install chromium` once if Chromium is missing, then `npm run test:browser:demo`. The browser run verified two synthetic users, no signal on entry, and all three fake outcomes. On Linux it remains unverified; on native Windows the runner's POSIX process-group control is not implemented. `npm run dev` is only an inert visual preview. All three Playwright configs allocate exclusive, mode-700 OS temporary result roots before Playwright can clear output. This also applies to direct config invocations; no environment-supplied cleanup path is accepted. Each config process removes only its captured root on exit, including handled SIGINT/SIGTERM, using an identity-checked filesystem cleanup subprocess with a five-second deadline. Results, traces and screenshots are disposable and removed at exit. A cleanup failure reports that run's exact root for owner inspection; do not remove an unknown directory. SIGKILL or host failure can leave owned scratch behind. The demo and production runners retain their existing owned-runtime cleanup.

## 3. Prepare private owner files and the Cloudflare database

**Hosted stop point:** the commands in steps 3–8 are an unrun owner plan. Review the private credential installer, TLS hook, host paths, and the license and artwork record before using them. A local pass does not establish hosted safety. Resource creation, migrations, DNS/certificates, deployment, and a real send each need their own owner authorization.

For hosted setup, install Go 1.25+ on the Ubuntu VPS from the [official Go installation guide](https://go.dev/doc/install), and install `git`, `openssl`, `python3`, and Certbot using your OS's supported packages. Check `go version`, `openssl version`, `python3 --version`, and `certbot --version`; stop if any command is missing. On the owner computer, use `node --version` and `npm --version` to confirm the site runtime. Select a VPS architecture supported by the Go release and keep its package and firewall maintenance under your control.

On the owner computer, from `site/`, build the production-shaped artifact first:

```sh
cd site
npm ci
npm run build:cloudflare
npm run artifact:check
```

Expected: an `.open-next/assets` directory and an artifact-check success message. This is local packaging, not deployment. The protected monkey artwork is packaged separately from public assets.

Create a **private** directory outside the public checkout, mode 700, then copy `site/wrangler.production.example.jsonc` there as a `.json` file. Edit it with a local editor. Replace every `REPLACE_...` value. The four paths using `REPLACE_SITE_DIRECTORY` must use the **absolute path to this checkout's `site` directory**; the checker compares them to the actual files and generated assets. Set exactly one custom-domain route, the same hostname in `BABYMONKEY_RP_ID` and `BABYMONKEY_ORIGIN`, and a distinct HTTPS relay origin. Preserve `workers_dev: false`, `preview_urls: false`, `upload_source_maps: false`, `DB`, `BABYMONKEY_RELAY_MTLS`, and the provided compatibility settings. Do not add preview routes or demo flags. Keep this private file mode 600. If you move the checkout, update its absolute paths and check again.

Sign in to Cloudflare with Wrangler from `site/` using `npx wrangler login` in the owner's browser, or use an owner-controlled provider authentication method. The following commands use your private config path; substitute it **only with a path**, never a token. Before running them, confirm the account and database name are yours and that the name is unused:

```sh
cd site
npx wrangler d1 create YOUR_NEW_DATABASE_NAME
```

Expected: Wrangler reports the new D1 UUID and binding information. Insert the UUID and name into the private config's single `d1_databases` entry. The repository contains five ordered files in `site/migrations/0001...0005`; create no extra migration for a fresh install. Run the static check once the mTLS certificate ID and maintenance identifiers are also filled in (steps 5–6). For now, record the database ID privately. Before live enrollment, arrange an owner-controlled D1 backup and test restoration with **synthetic** data; do not test restores on enrolled users.

**Return to this database after completing the private Wrangler config in step 5.** Step 6 lists and applies migrations 0001–0005 before the maintenance CLI reads status or the Worker is deployed. Do not apply them against a placeholder config or a different D1.

## 4. Prepare the separate relay host

The relay needs inbound TCP 443 for its own trusted TLS server certificate and TCP 80 for HTTP-01 certificate issuance and renewal. Retain SSH administration. Inspect current listeners and firewall rules first; do not overwrite rules for other services. The app's custom domain is on Cloudflare, while the relay's A/AAAA record points to the VPS **without Cloudflare proxying**. Confirm DNS before requesting the server certificate.

On the Ubuntu VPS, after installing Go 1.25+ and Certbot and placing a clean source checkout at `/opt/babymonkey-src` (replace this path with the actual verified checkout), **inspect before the first mutation**. Confirm the proposed user, group, service name, and paths are unused; if any exists, stop and follow an owner-reviewed existing-installation procedure instead of running the first-install block. This read-only preflight must pass before `useradd`, `install -d`, symlink creation, or unit installation:

```sh
sudo sh -c '
  set -eu
  if getent passwd babymonkey-relay >/dev/null; then
    echo "Existing relay user; stop and inspect" >&2
    exit 1
  fi
  if getent group babymonkey-relay >/dev/null; then
    echo "Existing relay group; stop and inspect" >&2
    exit 1
  fi
  unit_state=$(systemctl show --property=LoadState --value babymonkey-relay.service)
  [ "$unit_state" = not-found ]
  for path in /opt/babymonkey-relay /etc/babymonkey-relay /var/lib/babymonkey-relay /etc/systemd/system/babymonkey-relay.service; do
    if [ -e "$path" ] || [ -L "$path" ]; then
      echo "Existing relay path; stop and inspect: $path" >&2
      exit 1
    fi
  done
'
```

Only for a clean first install, run the following commands in order and stop on the first failure. Use an exclusive build directory rather than a shared `/tmp` filename:

```sh
sudo useradd --system --user-group --home /var/lib/babymonkey-relay --shell /usr/sbin/nologin babymonkey-relay
sudo install -d -o root -g root -m 755 /opt/babymonkey-relay/releases/v1
sudo install -d -o root -g babymonkey-relay -m 750 /etc/babymonkey-relay /etc/babymonkey-relay/tls
sudo install -d -o babymonkey-relay -g babymonkey-relay -m 700 /var/lib/babymonkey-relay
cd /opt/babymonkey-src/relay
go test ./...
build_dir=$(mktemp -d)
go build -o "$build_dir/babymonkey-relay" ./cmd/babymonkey-relay
go build -o "$build_dir/babymonkey-relay-allowlist" ./cmd/babymonkey-relay-allowlist
sudo install -o root -g root -m 755 "$build_dir/babymonkey-relay" /opt/babymonkey-relay/releases/v1/babymonkey-relay
sudo install -o root -g root -m 755 "$build_dir/babymonkey-relay-allowlist" /opt/babymonkey-relay/releases/v1/babymonkey-relay-allowlist
sudo install -o root -g root -m 755 ops/install_credentials.py /opt/babymonkey-relay/releases/v1/install_credentials.py
sudo install -o root -g root -m 755 ops/install_tls.py /opt/babymonkey-relay/releases/v1/install_tls.py
sudo ln -s /opt/babymonkey-relay/releases/v1 /opt/babymonkey-relay/current
sudo install -o babymonkey-relay -g babymonkey-relay -m 600 config/relay.example.json /etc/babymonkey-relay/relay.json
sudo install -o babymonkey-relay -g babymonkey-relay -m 600 config/allowlist.deny-all.json /etc/babymonkey-relay/allowlist.json
sudo install -o babymonkey-relay -g babymonkey-relay -m 600 config/replay-state.initial.json /var/lib/babymonkey-relay/replay.json
sudo install -o root -g root -m 644 ops/babymonkey-relay.service /etc/systemd/system/babymonkey-relay.service
sudo systemctl daemon-reload
```

Expected: relay tests pass, two binaries and the private installers exist under the release, the allowlist is empty, and the relay unit is installed but **not started**. Confirm `getent passwd babymonkey-relay` and `getent group babymonkey-relay` have the same name and that `systemctl is-enabled babymonkey-relay.service` does not report enabled. Remove only the two binaries from the recorded `build_dir` and remove that empty directory after verifying their installed copies; do not remove an unidentified temporary directory. These are first-install commands, not an update script. The root-owned `/etc/babymonkey-relay` directories prevent the relay user from swapping paths used by root-run installers. The relay refuses files readable by others, symlinks in place of its owner-only regular files, malformed JSON, and missing TLS or credentials.

The later owner setup uses a **new** Telegram bot created through [@BotFather's `/newbot`](https://core.telegram.org/bots/features#creating-a-new-bot); no other project's bot is reused. After the intended recipient sends `/start` in a private chat, Telegram's [`getUpdates` method](https://core.telegram.org/bots/api#getupdates) can identify that chat without sending a bot message. From an attached VPS terminal, after reviewing the script and confirming the bot has no webhook, run:

```sh
sudo /usr/bin/python3 /opt/babymonkey-relay/current/install_credentials.py install
```

The helper reads the token without echo from `/dev/tty`, makes one bounded HTTPS `getUpdates` request with no proxy or offset, accepts exactly one distinct private `/start` chat, and requires `INSTALL` confirmation without displaying the destination. It does not call `sendMessage`. It atomically creates `/etc/babymonkey-relay/credentials.json` as a regular mode-600 file owned by `babymonkey-relay`; an existing file causes refusal. A webhook, pending-update overflow, missing or multiple eligible chats, malformed response, or uncertain recipient requires private owner resolution before retry. If the helper fails during installation, inspect the credential file's presence, owner, and mode privately before rerunning; a final filesystem-sync failure may leave the file installed. `getUpdates` can have Bot API queue effects; review its current behavior before use. Do not put the token in a browser URL, `curl` command, shell history, chat, or temporary plaintext command file. The source owns the one generic fixed message; editing it is a source review, not an in-product choice.

For **replacement**, first disable notifications with maintenance CLI option `7` and verify the disabled revision/status there; set the relay allowlist to deny-all; stop the relay; inspect the existing credential file metadata. The helper cannot itself prove D1 disabled. Then run `sudo /usr/bin/python3 /opt/babymonkey-relay/current/install_credentials.py replace` from an attached terminal, type `REPLACE` after those checks, provide the new token, and type `INSTALL` after privately checking the recipient. Leave notifications disabled and allowlist deny-all until the full relay `-check`, restart, and exact client-certificate checks pass. A credential replacement is not a bot-token revocation; revoke the old token separately in BotFather if needed. Do not disclose the token, chat ID, or Bot API response in reports.

Leave the relay **stopped** at this point. Install its client CA, trusted server certificate, and reviewed renewal procedure in step 5 before starting the service. Verify the service remains stopped and start it only with deny-all after the full check passes. Keep logs coarse; never log request headers, Telegram responses, credentials, or destinations.

## 5. Give the Worker an exact mTLS identity

Use a **private, owner-controlled CA and client certificate** for this Worker. Keep the CA private key and client private key outside the public checkout with restricted permissions. The relay receives only the CA certificate, so it can verify the client chain; the allowlist also pins the **exact leaf certificate's SHA-256 DER fingerprint**. Cloudflare receives the client certificate and key through its mTLS certificate upload. Follow [Cloudflare's current Worker mTLS binding guide](https://developers.cloudflare.com/workers/runtime-apis/bindings/mtls/) and verify supported certificate format, expiry, and API-token permissions before issuing the cert. A provider API token for upload needs `SSL and Certificates Edit`; an interactive Wrangler login may supply it. The following self-managed CA/client commands are an **illustrative, unhosted example** to review on the owner's platform, from an owner-only private directory **outside the checkout**:

```sh
umask 077
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out client-ca.key
openssl req -new -x509 -sha256 -days 3650 -key client-ca.key -out client-ca.pem -subj '/CN=BabyMonkey private client CA'
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out client.key
openssl req -new -key client.key -out client.csr -subj '/CN=BabyMonkey Worker client'
printf 'basicConstraints=CA:FALSE\nkeyUsage=digitalSignature\nextendedKeyUsage=clientAuth\n' > client.ext
openssl x509 -req -sha256 -days 365 -in client.csr -CA client-ca.pem -CAkey client-ca.key -CAcreateserial -extfile client.ext -out client.pem
openssl verify -CAfile client-ca.pem -purpose sslclient client.pem
openssl x509 -in client.pem -outform DER | openssl dgst -sha256
```

Expected: `client.pem: OK`, followed by a SHA-256 digest. Only its 64 lowercase hexadecimal characters go into the allowlist. Protect and back up the private keys, note certificate expiry, and plan rotation before expiry. The commands should print no secret key or token. The `.csr`, `.ext`, and generated serial file remain in the owner-only directory too.

From `site/` on the owner computer, with private certificate/key file paths already created by a reviewed OpenSSL procedure:

```sh
cd site
npx wrangler mtls-certificate upload --cert /ABSOLUTE/PRIVATE/client.pem --key /ABSOLUTE/PRIVATE/client.key --name babymonkey-relay-client
```

Expected: Cloudflare prints a **certificate ID**, not a private key. Put that ID into `mtls_certificates[0].certificate_id` in the private Wrangler config. Keep `client-ca.key` and `client.key` on the owner computer. For a **first install only**, transfer the public CA certificate from the owner-only directory over the existing SSH connection to a newly checked owner-home path on the VPS. Substitute your actual user, host, and private file path; never transfer the CA private key:

```sh
openssl x509 -in /ABSOLUTE/PRIVATE/client-ca.pem -outform DER | openssl dgst -sha256
ssh VPS_USER@VPS_HOST 'test ! -e "$HOME/babymonkey-client-ca.pem" && test ! -L "$HOME/babymonkey-client-ca.pem"'
scp -p /ABSOLUTE/PRIVATE/client-ca.pem VPS_USER@VPS_HOST:babymonkey-client-ca.pem
```

On the VPS, compare the certificate's SHA-256 DER digest to the owner-computer result, then install it only if the destination is absent. Verify that the relay account can read it, and remove only the named transfer copy:

```sh
openssl x509 -in "$HOME/babymonkey-client-ca.pem" -outform DER | openssl dgst -sha256
sudo test ! -e /etc/babymonkey-relay/client-ca.pem && sudo test ! -L /etc/babymonkey-relay/client-ca.pem && sudo install -o babymonkey-relay -g babymonkey-relay -m 600 "$HOME/babymonkey-client-ca.pem" /etc/babymonkey-relay/client-ca.pem
sudo -u babymonkey-relay openssl x509 -in /etc/babymonkey-relay/client-ca.pem -noout -subject
rm "$HOME/babymonkey-client-ca.pem"
```

If either digest differs or either destination already exists, stop and inspect; do not overwrite it. On an existing installation, plan certificate overlap before replacing the active CA.

The relay requires regular mode-600 server certificate and key files; Certbot's `live/` entries are symlinks. On the documented Ubuntu path, inspect `sudo certbot certificates`, the DNS-only relay record, inbound port 80, `sudo ss -ltnp` for any existing listener, and any pre-existing Certbot hooks that might run during issuance. **Do not stop an unrelated service to free port 80.** For a new, unused exact relay hostname and a free port 80, the reviewed initial issuance command is:

```sh
sudo test ! -e /etc/letsencrypt/live/relay.your-domain.tld && sudo test ! -L /etc/letsencrypt/live/relay.your-domain.tld && sudo certbot certonly --standalone --preferred-challenges http --cert-name relay.your-domain.tld -d relay.your-domain.tld
sudo certbot certificates
```

Certbot's [standalone authenticator](https://eff-certbot.readthedocs.io/en/stable/using.html#standalone) needs inbound port 80; `certonly` obtains a certificate without installing it into another server. Confirm Certbot reports the **exact** certificate name and `/etc/letsencrypt/live/relay.your-domain.tld` lineage. If a lineage already exists, stop and inspect rather than creating or replacing it. This issuance and its DNS validation have **not** been run for the OSS candidate.

Copy the nonsecret `relay/config/tls-install.example.json` to `/etc/babymonkey-relay/tls-install.json` as **root-owned mode 600**, and privately edit its `hostname` and `lineage` to the exact DNS-only relay hostname and `/etc/letsencrypt/live/<same-hostname>`. Confirm the client CA, credentials, deny-all allowlist, and replay files exist so the relay's complete `-check` can pass. The directory `/etc/babymonkey-relay/tls` must be root-owned, group `babymonkey-relay`, mode 750; the installed cert and key become relay-owned mode 600. Review and then run:

```sh
sudo test ! -e /etc/babymonkey-relay/tls-install.json && sudo test ! -L /etc/babymonkey-relay/tls-install.json && sudo install -o root -g root -m 600 /opt/babymonkey-src/relay/config/tls-install.example.json /etc/babymonkey-relay/tls-install.json
sudoedit /etc/babymonkey-relay/tls-install.json
sudo /usr/bin/python3 /opt/babymonkey-relay/current/install_tls.py --install
sudo -u babymonkey-relay /opt/babymonkey-relay/current/babymonkey-relay -config /etc/babymonkey-relay/relay.json -check
```

The installer accepts only the configured Certbot lineage, resolves its `live/` links inside the matching `archive/` directory, checks root ownership and private-key permissions, verifies the matching key, hostname, validity window, and system-trusted server chain, then copies a pair as regular private files. It serializes runs, records a private rollback marker before replacement, touches only `babymonkey-relay.service`, and preserves a deliberately stopped service. On a failed validation, the prior pair remains. On a failed install, service check, or immediate post-start health check, it attempts to restore the prior pair and active/stopped state. If restoration cannot establish the previous active state, the rollback marker and backups remain for owner recovery. If the process was interrupted and `.install-transaction` remains under the TLS directory, inspect service/file state and run `sudo /usr/bin/python3 /opt/babymonkey-relay/current/install_tls.py --recover`; do not hand-edit one file of the pair or enable notifications before recovery and the full relay check. A malformed or incomplete marker requires owner inspection.

After reviewing the VPS's Certbot renewal configuration and scheduler, install the repository's deploy hook as a root-owned executable:

```sh
sudo test ! -e /etc/letsencrypt/renewal-hooks/deploy/babymonkey-relay-tls && sudo test ! -L /etc/letsencrypt/renewal-hooks/deploy/babymonkey-relay-tls && sudo install -o root -g root -m 755 /opt/babymonkey-src/relay/ops/babymonkey-certbot-deploy-hook /etc/letsencrypt/renewal-hooks/deploy/babymonkey-relay-tls
sudo certbot renew --dry-run --run-deploy-hooks --cert-name relay.your-domain.tld
```

Replace the example cert name with the exact selected lineage name. Inspect any pre-existing hook path before installation; do not overwrite another owner's hook. The global hook ignores unrelated lineages without touching their files or services. [Certbot documents](https://eff-certbot.readthedocs.io/en/stable/man/certbot.html) that this dry run calls deploy hooks with the **current active certificate**, not the temporary test certificate. It checks invocation; synthetic new-pair and rollback tests cover the helper, while unattended VPS renewal remains unverified until observed on that host. Confirm the actual renewal scheduler and command rather than assuming a timer name:

```sh
sudo systemctl list-timers --all
sudo systemctl list-unit-files '*certbot*'
sudo grep -R -- 'certbot renew' /etc/crontab /etc/cron.d /etc/cron.daily 2>/dev/null
```

Inspect the active timer/service or cron entry for the installed Certbot package and verify it runs `certbot renew` without `--no-directory-hooks`. If none is active, use that package's [documented renewal setup](https://eff-certbot.readthedocs.io/en/stable/using.html#automated-renewals) before relying on unattended TLS. The hook must stay installed; a one-time copy alone is insufficient.

Before opening an exact leaf, explicitly place the relay in deny-all, check the complete configuration, enable/start **only** its unit, and verify active state. Do not enable D1 notifications; step 6 verifies the disabled state before the leaf is opened:

```sh
sudo /opt/babymonkey-relay/current/babymonkey-relay-allowlist
sudo -u babymonkey-relay /opt/babymonkey-relay/current/babymonkey-relay -config /etc/babymonkey-relay/relay.json -check
sudo systemctl enable babymonkey-relay.service
sudo systemctl start babymonkey-relay.service
sudo systemctl is-active --quiet babymonkey-relay.service
```

If `-check` or the active check fails, leave the allowlist deny-all and inspect only this relay; do not enable notifications. A successful start with deny-all proves local service readiness, **not** notification delivery or D1 state. Leave the allowlist deny-all while returning to D1 in step 6.

If rotating a certificate: upload the new one, install any new CA, allowlist both exact leaves temporarily, deploy the Worker with the new certificate ID, verify the new client certificate's TLS handshake and local fixed-operation tests, remove the old leaf from the relay allowlist **first**, verify old-client denial, then remove the old Cloudflare certificate. The allowlist supports at most two fingerprints for this overlap. A hosted send remains a separate deliberate owner-authorized action. Do not roll back to a Worker bound only to a revoked leaf.

## 6. Check and deploy the Worker

This section is an unrun sequence for after the private credential installer and regular-file TLS procedure have been reviewed and run by the owner. Verify the exact owner target and existing state before each external action.

**Return to the new D1 now that the private Wrangler config has its final account, D1 UUID/name, mTLS certificate ID, app origin, and relay origin.** Before any maintenance CLI status or Worker deployment, list remote pending migrations, apply only 0001–0005 **once to this new database**, then list again:

```sh
cd site
npx wrangler d1 migrations list DB --remote --config /ABSOLUTE/PRIVATE/wrangler.json
npx wrangler d1 migrations apply DB --remote --config /ABSOLUTE/PRIVATE/wrangler.json
npx wrangler d1 migrations list DB --remote --config /ABSOLUTE/PRIVATE/wrangler.json
```

Expected: the first list shows files 0001–0005, apply asks for confirmation and reports each migration, and the second list shows none pending. **Do not use `--local` for the hosted D1.** If application fails, inspect its reported transaction and migration state before retrying; do not paste SQL directly into a live D1. The owner CLI status below should then report notifications disabled.

The maintenance CLI uses an owner-only JSON file at `~/.config/babymonkey/maintenance.json` and its hash-only invitation journal at `~/.local/state/babymonkey/invitation-journal.json`. It will create the config interactively if absent. Its config contains only the account ID, D1 UUID, and exact application HTTPS origin; never a token. Its directories must be owned by the current user and mode 700; existing files must be mode 600. Make the account ID and D1 UUID match the private Wrangler config. The CLI accepts a dedicated account-scoped **D1 Edit** token only through an echo-disabled, attached TTY. Keep that token separate from any Worker deployment or certificate-management token. It rejects token environment variables, CLI arguments, pipes, and redirected output. The CLI's optional clipboard copy is macOS-only and should normally be declined. The token permits D1 writes in the chosen account; review that scope before creating it.

From the owner's `maintenance/maintenance-cli/` directory:

```sh
cd maintenance/maintenance-cli
npm ci
npm run build
npm start
```

Expected: after an optional nonsecret config prompt, the CLI asks for the D1 Write token without echo and shows its numbered maintenance menu. Choose `1` for status; after migrations it should report two unassigned slots and notifications disabled. Choose `8` to exit. If the CLI rejects directory permissions, fix only the owner-specific config/state paths; do not loosen them. If your platform cannot provide a real attached TTY and `getuid`, do not bypass this guard; use a verified supported owner computer.

Only after that disabled status is verified, recompute the client leaf's lowercase SHA-256 DER fingerprint locally and verify it against the exact uploaded leaf. On the VPS, open **only that one** certificate in the relay allowlist, then check and restart its unit:

```sh
sudo /opt/babymonkey-relay/current/babymonkey-relay-allowlist YOUR_64_CHARACTER_LOWERCASE_SHA256_DER_HEX
sudo -u babymonkey-relay /opt/babymonkey-relay/current/babymonkey-relay -config /etc/babymonkey-relay/relay.json -check
sudo systemctl restart babymonkey-relay.service
sudo systemctl is-active --quiet babymonkey-relay.service
```

Expected: the allowlist file contains one exact leaf and the relay remains active. Never open an allowlist for an entire CA. The source's local Worker→Go tests use synthetic certificates and fake Telegram. A new hosted installation must still verify its actual DNS, server TLS, exact client certificate, relay health, and anonymous Worker boundaries. There is no supplied hosted fake-Telegram harness; do not claim one was run or require building one as an adopter prerequisite. Keep notifications disabled until the owner separately authorizes a bounded live check.

From `site/`, run the static checker using absolute private paths:

```sh
cd site
npm run setup:check -- /ABSOLUTE/PRIVATE/wrangler.json /ABSOLUTE/OWNER/.config/babymonkey/maintenance.json
npx wrangler deploy --dry-run --config /ABSOLUTE/PRIVATE/wrangler.json
```

Expected: the checker says `Static setup check passed` and explicitly says provider state is unverified; Wrangler packages without deploying. The example file is intentionally invalid until all placeholders and paths are replaced. The checker enforces a single custom domain, canonical RP/origin, D1 and mTLS bindings, guarded entrypoint, packaged assets, and preview restrictions. It cannot verify account ownership, DNS, TLS, or actual certificate authorization.

Only after the owner reviews the exact target, source artifact, D1 binding, certificate ID, hostname, and provider effects, deploy from `site/`:

```sh
cd site
npx wrangler deploy --config /ABSOLUTE/PRIVATE/wrangler.json
```

Expected: Wrangler reports the Worker and its custom domain. [Cloudflare custom domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/) create their own DNS and server TLS record; do not overlay an unrelated existing hostname. The config disables `workers.dev` and preview URLs. Before invitations, verify the exact app URL over HTTPS serves only the neutral public shell to an unauthenticated browser; protected media and mutations deny anonymous requests. Confirm the relay still rejects absent/wrong client certificates. This skeleton's local build and tests are **not** proof of those hosted checks.

## 7. Invite the two people, then deliberately enable delivery

Do not proceed until the relay credentials and TLS renewal procedures are complete, the hosted Worker and relay boundaries are verified, and the owner has authorized this stage.

Only after hosted anonymous checks and the permanent RP ID/origin are verified, open the owner CLI in its attached terminal. Read status first. Choose `2` and select slot 1; repeat for slot 2. Each action creates a **different, 24-hour, single-use** invitation and shows its URL once. Hand each URL privately to its intended person. Do not put it in Git, chat with an agent, or a public ticket. Each person opens their own link, deliberately confirms, and completes the normal passkey/user-verification prompt. Verify both can sign out and return through passkey authentication. A cancelled or failed pre-commit ceremony leaves an unused invitation available; a committed enrollment remains authoritative even if its response is lost, so return with the newly registered passkey instead of reusing the invitation.

Leave notifications disabled while checking enrollment. The owner CLI's `1` status shows both slots and the notification revision, without exposing a history. For a **separately owner-authorized** live notification, choose `7`, read its current revision, and type the exact confirmation phrase to enable. Have one authorized user deliberately tap the monkey once. Verify only the limited result: the app reports accepted/ambiguous/failure, relay service remained healthy, and the intended Telegram chat received the fixed message if confirmed. The app must never claim that someone saw it. If the result is ambiguous, do not automatically retry. Return to CLI `7` to disable notifications whenever delivery must stop; also remove the relay leaf from the allowlist for a second independent stop. Bot-token revocation in BotFather is the ultimate credential stop.

## 8. Recovery, updates, and safe pause points

The owner CLI menu supports: `1` minimal status; `2` initial/replacement invitation; `3` revoke one outstanding invitation; `4` reset one slot's credential authorization and its sessions; `5` advance one active slot's generation and revoke its sessions; `6` revoke one slot's sessions; `7` toggle notifications after an exact confirmation; `8` exit. A reset preserves that slot and does not affect the other. Then create a **replacement** invitation for that slot and let the same person register one new passkey. Do not create a third principal or manually edit credential rows. Lost invitation? Revoke it, then create a fresh one. Expired session? Use the registered passkey; do not create a new invitation. Lost or compromised bot token? Disable notifications, deny the relay certificate, revoke/regenerate the bot token in BotFather, then use the private replacement procedure above and validate before considering re-enablement.

For a delivery pause or an uncertain relay state, use owner CLI option `7` to disable D1 notifications and verify its status when the CLI is available. Independently deny every client certificate and stop only this relay:

```sh
sudo /opt/babymonkey-relay/current/babymonkey-relay-allowlist
sudo systemctl stop babymonkey-relay.service
sudo systemctl show --property=ActiveState --property=UnitFileState babymonkey-relay.service
```

Expected: the allowlist is empty and `ActiveState=inactive`. These host commands cannot prove D1 notification disablement; if the CLI is unavailable, keep the relay stopped and treat D1 state as unknown. If the **first** service start failed after `enable`, also run `sudo systemctl disable babymonkey-relay.service` until its cause is resolved, then verify `UnitFileState=disabled`. Do not disable or stop an unrelated unit. For an interrupted TLS install, keep the relay deny-all/stopped, inspect the marker and backups, run the documented `install_tls.py --recover`, and verify `-check` and service state before reconsidering any client leaf or D1 enablement.

For ordinary source updates, keep the owner private Wrangler config and relay credentials outside the checkout. Read migration and config changes **before** replacing binaries or deploying a Worker. Back up D1 and verify a synthetic restore path; apply only new migrations to the intended remote database; build and inspect artifacts; run the local checks in [VALIDATION.md](../VALIDATION.md); create a new immutable relay release and validate it before switching the `current` symlink; preserve the old release for rollback. Re-run `setup:check` after checkout paths or config change. A Worker rollback cannot undo a relay certificate revocation or D1 migration. Do not restore an older D1 snapshot over live enrollment without a plan for invitation and authorization-generation monotonicity.

At any interruption, record only **nonsecret** facts: source revision, working directories, chosen hostnames, Cloudflare resource IDs, which migrations applied, certificate ID and nonsecret fingerprint, relay binary release, whether service is active, whether notifications are enabled, and which checks actually passed. Never record token contents, invitation URLs, destination, private message, or private keys. If a command fails, inspect the exact failing layer, preserve current state, and resume there. Do not re-run `d1 create`, initial migration, bot creation, or invitation generation merely because setup was interrupted. For teardown, disable notifications, set deny-all allowlist, stop the relay, revoke the Cloudflare client certificate and bot token, then remove only resources you verified belong to this installation. D1 deletion erases identity state and requires a separate owner decision.

## References and validation boundary

Provider commands and constraints were checked against [Cloudflare D1 Wrangler commands](https://developers.cloudflare.com/workers/wrangler/commands/d1/), [Worker mTLS bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/mtls/), [custom domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/), [Wrangler deploy](https://developers.cloudflare.com/workers/wrangler/commands/workers/), [Cloudflare API-token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/), the [Telegram Bot API](https://core.telegram.org/bots/api), [BotFather guidance](https://core.telegram.org/bots/features#creating-a-new-bot), [Go installation](https://go.dev/doc/install), and [Certbot](https://certbot.eff.org/). Commands in this guide were **not** executed against a hosted account or VPS for this public edition. Recheck provider documentation and local `--help` at the time of use; provider behavior can change.
