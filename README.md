# BabyMonkey

BabyMonkey is a small pink app for **exactly two equal users**. Each receives a private, single-use invitation, registers one passkey, and can deliberately tap one monkey to send the same fixed notification. There is no account administrator in the app; the deployment owner maintains it from a separate local terminal.

I originally built BabyMonkey for someone I care about, to make reaching out a little easier when words felt difficult. One small gesture lets someone know you’d welcome their company.

**Start here:** [Set up BabyMonkey](docs/SETUP.md). First try the local demo, which needs no Cloudflare, VPS, or Telegram account and sends nothing. The later hosted steps require your own permanent domain, Cloudflare account, isolated Linux VPS, and separate Telegram bot. This is a hands-on setup; the local demo is not proof that your hosted installation works.

Want an assistant to guide you? Give it [the agent setup prompt](AGENT_SETUP_PROMPT.md), then work through the same guide together. Enter secrets only into the private terminal or provider UI named in the guide, never into agent chat.

```text
two browsers → Cloudflare Worker + D1 → client-certificate-authenticated Go relay on your VPS → Telegram
```

The Worker never receives the Telegram bot token or destination. The relay owns the fixed message and those credentials. A confirmed result means Telegram accepted the request; it does not prove a person saw it. See [validation](VALIDATION.md) for what this skeleton has actually exercised. Hosted provisioning, real-device enrollment, and live delivery still need owner-controlled verification.

## Local start

Use Node.js 22.13+ (the declared minimum; validation used Node 26.10.0 on macOS). From `site/`:

```sh
npm ci
npm run demo
```

The demo creates two one-hour synthetic invitations in a disposable local D1 and uses fake delivery only. Open the URLs shown in the terminal in separate browser profiles, then stop with Ctrl-C. For automated two-user checks, install Playwright Chromium if needed and run `npm run test:browser:demo`. `npm run dev` is an inert visual preview. See [the setup guide](docs/SETUP.md) for exact checks, cleanup limits, and the separate hosted sequence.

## License and release files

Project source and the original monkey artwork are released under the [MIT license](LICENSE), with `2026 arshiaghaf` attribution. See the [artwork provenance and inventory](docs/ARTWORK.md) for the included assets. Third-party dependencies retain their own licenses.

Publicly committed text is public even when the running app serves it only after authentication. Private planning material has been relocated outside this checkout. Keep generated bundles, local D1 state, credentials, invitations, and test output outside release artifacts. This local candidate has not initialized Git or been published; hosted setup and verification remain separate owner-controlled steps.
