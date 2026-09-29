<p align="center">
  <img src="site/protected-assets/monkey/ready-monkey.png" width="240" alt="A smiling baby monkey sitting inside a pink storybook badge">
</p>

# Baby Monkey

A little pink way to ask someone to reach out. **Exactly two equal users, one monkey button, and one fixed Telegram signal sent only after a deliberate tap.**

## Start with your agent

Paste this into a coding agent that can browse the web and work in a terminal. **You don't need to clone the repository first.**

```text
Help me set up Baby Monkey from https://github.com/arshiaghaf/BabyMonkey.
Read the full copyable setup prompt at
https://github.com/arshiaghaf/BabyMonkey/blob/main/AGENT_SETUP_PROMPT.md
and follow it using the actual repository instructions and docs/SETUP.md.
Start by finding a suitable checkout or cloning safely, then run and verify
the provider-free local demo and its cleanup. Guide me through hosted setup
in reviewed stages. Keep secrets out of chat and ask before any external
stage I have not already authorized.
```

Your agent can inspect prerequisites, prepare private configuration, run local checks, and guide the Cloudflare, VPS, and Telegram steps. You'll still choose your accounts and hostnames, enter credentials privately, approve external actions, share invitations privately, and complete the passkey prompts. This is a guided setup, with checkpoints along the way.

[Copy the full agent prompt](AGENT_SETUP_PROMPT.md) · [Follow the manual setup guide](docs/SETUP.md) · [Read the validation record](VALIDATION.md)

## How Baby Monkey works

I originally built Baby Monkey for someone I care about, to make reaching out a little easier when words felt difficult. One small gesture lets someone know you’d welcome their company.

Each person receives a private, single-use invitation and registers one passkey. Both get the same access and the same monkey button. The deployment owner handles maintenance from a separate local terminal; neither account has administrator powers in the app.

There are no message choices, freeform text, reminders, analytics, or signal history. A confirmed result means Telegram accepted the request; it does not mean someone saw it. An uncertain result is shown honestly, and revealing an existing outcome never sends again.

<p align="center">
  <img src="site/protected-assets/monkey/pending-monkey.png" width="120" alt="A baby monkey with open arms, used for a pending request">
  <img src="site/protected-assets/monkey/confirmed-monkey.png" width="120" alt="A baby monkey hugging a pink heart, used for a confirmed request">
</p>

## Try it locally yourself

The demo needs no Cloudflare, VPS, or Telegram account and sends nothing. With Git, npm, and Node.js installed, run these commands from a directory where a new `BabyMonkey` folder is safe to create:

```sh
git clone https://github.com/arshiaghaf/BabyMonkey.git
cd BabyMonkey/site
npm ci
npm run demo
```

Open the two synthetic invitation URLs printed in the terminal in separate browser profiles. Stop with Ctrl-C and verify that the demo process and its disposable state are cleaned up. If startup or cleanup fails, use the [demo instructions](docs/SETUP.md#2-try-it-locally-first) before retrying.

Node.js 22.13+ is the declared minimum; recorded validation used Node 26.10.0 on macOS. The minimum and Linux owner tooling remain unverified; the local demo and maintenance CLI do not support native Windows. `npm run dev` is an inert visual preview. Optional automated demo checks and their limits are in the setup guide.

## Give it a home

Hosted setup uses your own permanent app domain, Cloudflare account, isolated Ubuntu VPS, and separate Telegram bot with one private destination.

| Piece | Its job |
| --- | --- |
| Cloudflare Worker + OpenNext + D1 | Serve the app, verify passkeys and opaque sessions, coordinate bounded signal state |
| Isolated Go relay on your VPS | Authorize the Worker's exact mTLS client certificate and send the fixed Telegram message |
| Local owner CLI | Manage invitations, recovery, sessions, and the notification switch outside the app |

The Worker never receives the Telegram bot token, destination, or message configuration. Those stay in the relay's private configuration. Public responses remain neutral; protected artwork and actions require server authorization.

Follow [the hosted setup sequence](docs/SETUP.md#3-prepare-private-owner-files-and-the-cloudflare-database) after the demo. Provisioning, migrations, DNS, deployment, notification enablement, and a live send are separate owner-approved stages. The [validation record](VALIDATION.md) documents local synthetic checks; hosted delivery, renewal, and real-device behavior require verification on your installation.

## License and artwork

Source and the original monkey artwork are released under [MIT](LICENSE), with `2026 arshiaghaf` attribution. The [artwork record](docs/ARTWORK.md) lists provenance and included assets. Third-party dependencies retain their own licenses.

Public commits are public even when the running app serves content only after authentication. Keep private deployment wording, credentials, invitations, configuration, generated bundles, and local state outside public release artifacts.
