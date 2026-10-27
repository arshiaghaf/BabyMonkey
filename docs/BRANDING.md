# Near branding and compatibility

The product is Near. Its public repository is https://github.com/arshiaghaf/near;
clone it into `near`. UI metadata, component/state names, npm packages, the Go
module, local tooling flags, and setup links use the new name. Original monkey
artwork and its accurate image descriptions remain unchanged.

The following legacy identifiers intentionally remain. A branding update must
not create a second installation, strand existing state, or invalidate a passkey:

- `BABYMONKEY_RP_ID`, `BABYMONKEY_ORIGIN`, `BABYMONKEY_RELAY_ORIGIN`, and
  `BABYMONKEY_RELAY_MTLS`: existing private configuration and Worker bindings.
  Keep the owner's actual RP ID, HTTPS origin, domain, and certificate binding.
- `babymonkey-local`: the existing local D1 database name. Database IDs, binding
  `DB`, migrations, tables, and stored authority are unchanged.
- `~/.config/babymonkey` and `~/.local/state/babymonkey`, including the lock-ready
  marker: existing owner configuration, invitation journal, and shared lock.
- `babymonkey-relay` commands, Unix user/group, systemd unit, installed binaries,
  `/opt`, `/etc`, `/var/lib` paths, certificate label, and renewal hook destination:
  existing deployment identities used by the relay and its private installers.
- `application/vnd.babymonkey.fixed-notification.v1+json` and the
  `babymonkey-relay-v1` replay-hash prefix: wire compatibility and persisted
  replay protection across Worker/relay versions.
- `__Host-bm-*` cookies and `x-bm-*` headers: existing sessions, CSRF, and response
  coordination. No credential, token, notification text, or destination changes.
- Old `BABYMONKEY_LOCAL_DEMO` / `BABYMONKEY_FAKE_DELIVERY` flags remain explicitly
  rejected by the production gate and artifact audit. Local tools now use
  `NEAR_*` flags; do not copy demo flags into production configuration.

This change performs no deployment, infrastructure migration, or credential
rotation. A checkout moved locally may require its owner's private Wrangler
configuration to be updated for absolute source paths before future setup checks;
private files are outside this change.
