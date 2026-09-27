# Self-hosting Mailflare (Docker)

Mailflare can run as a single container on any host instead of Cloudflare
Workers. The same code serves both; the container provides its own database
(SQLite on a volume), blob storage (files on the same volume), job queue,
realtime WebSocket, backup schedule and an SMTP listener for inbound mail.

## Quick start

```bash
git clone https://github.com/goat1990/mailflare-venom && cd mailflare-venom
cp .env.docker.example .env.docker      # edit: how to receive and send mail
docker compose up -d --build
```

Open `http://your-host:3000/setup`, create the admin account and add your
domain. All data lives in the `mailflare-data` volume (`/data` in the
container): the SQLite database, raw messages, attachments and backups.

Behind a reverse proxy, set `APP_URL=https://mail.example.com` so links in
password-reset mail and the JMAP session point at the public address, and
forward WebSocket upgrades for `/api/realtime`.

## Receiving mail

Pick one; both can be on at once.

**Built-in SMTP listener (default).** The container listens on port 25 and
accepts mail for every domain you add. Point the domain's MX record at the
host, set `MAIL_HOSTNAME` to that host's name, and make sure port 25 is
reachable from the internet (several clouds block it by default; Hetzner and
most VPS providers do not). The domain page in the app lists the MX, SPF and
DMARC records to create. Domain routing rules work as on Cloudflare: reject
rules answer the sender with a 550 during delivery, forward rules relay the
message through your outbound SMTP.

Optional: `SMTP_TLS_KEY` and `SMTP_TLS_CERT` (paths inside the container)
enable STARTTLS with your own certificate. Without them STARTTLS is not
offered, which is safe but means transport encryption depends on the sender.

**Cloudflare Email Routing relay.** Keep MX on Cloudflare and deploy the
Worker in `deploy/cloudflare-email-relay`. It posts each message to
`/api/inbound` on your server, signed with `INBOUND_WEBHOOK_SECRET`, and acts
on the reject or forward decision the server returns. Set
`SMTP_INBOUND_PORT=0` if you do not want the listener at all.

## Sending mail

**Any SMTP relay.** `SMTP_URL=smtps://user:pass@host:465` (or `smtp://`
with STARTTLS). Works with your hosting provider's relay, Amazon SES,
Postmark, Mailgun, or a Postfix you run. Set
`SMTP_TLS_REJECT_UNAUTHORIZED=false` only for a relay with a self-signed
certificate on a private network.

**Cloudflare Email Sending.** `CF_ACCOUNT_ID` plus a `CF_TOKEN` with Email
Sending: Edit. The domain must be a Cloudflare zone with Email Sending set
up; Mailflare calls the REST API, no Workers plan needed.

## Cloudflare zone management (optional)

If `CF_TOKEN` can also edit DNS and Email Routing on your zones, adding a
domain configures Email Routing and the sending subdomain automatically,
exactly as on Workers. Without it, domains are recorded as manually managed
and the DNS page shows what to set by hand.

## Configuration reference

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DATA_DIR` | `/data` | SQLite database, blobs and backups |
| `APP_URL` | request origin | Public URL behind a proxy |
| `SMTP_INBOUND_PORT` | `25` | Inbound SMTP; `0` disables |
| `MAIL_HOSTNAME` | `mail.<domain>` | Host the MX record points at; SMTP banner |
| `SMTP_MAX_SIZE` | 25 MiB | Largest inbound message |
| `SMTP_TLS_KEY`, `SMTP_TLS_CERT` | unset | STARTTLS certificate for the listener |
| `SMTP_URL` | unset | Outbound relay |
| `SMTP_TLS_REJECT_UNAUTHORIZED` | `true` | Trust self-signed relay certificates when `false` |
| `CF_ACCOUNT_ID`, `CF_TOKEN` | unset | Cloudflare Email Sending, and zone management if the token allows |
| `INBOUND_WEBHOOK_SECRET` | unset | Enables `/api/inbound` for the relay Worker |
| `TURNSTILE_SECRET_KEY` | unset | Bot protection on login and reset forms (`NEXT_PUBLIC_TURNSTILE_SITE_KEY` at build time) |
| `AI_BASE_URL` | unset | OpenAI-compatible model API base URL for the assistant |
| `AI_API_KEY` | unset | Server-only key for that model API |
| `AI_MODEL` | `gpt-4o-mini` | Model ID supported by the configured API |

## Operations

- **Backups.** The daily 02:00 UTC backup and the admin Backups page work
  unchanged; files land under `/data/blobs/backups`. Back up the whole volume
  for a full copy.
- **Updates.** Pull the image you build from this repository and recreate
  the container; migrations run at start. There is no in-app updater.
- **Logs.** `docker compose logs -f mailflare`.
- **Queues.** Jobs are held in memory. Inbound mail is written to the volume
  before it is queued, so a restart never loses a message; at worst one
  stays unparsed until it is re-imported.

## Email assistant and MCP

Set `AI_BASE_URL`, `AI_API_KEY`, and `AI_MODEL` in the container environment to configure the built-in assistant. These values stay on the server. Assistant chat is available by default when a provider is configured; a mailbox manager can change its writing instructions and availability through the settings button in the assistant panel. Automatic reply drafts remain off until enabled there. Auto-draft work is recorded in SQLite and retried after a restart by the local scheduler. AI failure does not reject inbound mail. Out-of-office auto-replies and AI auto-drafts are separate features; turn off out-of-office replies before enabling auto-drafts for a mailbox.

The MCP endpoint is `/mcp`. Create a dedicated mailbox-scoped Bearer key in **Assistant → MCP** and give the key to a client that supports custom HTTP headers. The endpoint uses Streamable HTTP; `request_send` gives the client a review URL, and only an authenticated Mailflare browser session can confirm delivery. MCP read and draft tools remain available when no AI model is configured.

## Running without Docker

```bash
npm ci
npm run build:node
MAILFLARE_RUNTIME=node NODE_ENV=production DATA_DIR=./data node dist/server.mjs
```

Port 25 needs root or a capability (`setcap cap_net_bind_service=+ep`); use
`SMTP_INBOUND_PORT=2525` behind a port forward otherwise.
