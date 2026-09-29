<img src="/public/icon-96.png" alt="Venommail" width="72" />

# Venommail

Venommail is a self-hosted email inbox for custom domains, built on Cloudflare.

## Screenshots

| ![Inbox](/screenshots/1.png)<br>Inbox | ![Manage domains](/screenshots/2.png)<br>Manage domains | ![Manage inboxes](/screenshots/3.png)<br>Manage inboxes |
| --- | --- | --- |

### Featured sponsors

<a target="_blank" href="https://sequenzy.com/">
  <img height="80" src="/sponsors/sequenzy.png" alt="Sequenzy">
</a>  <a target="_blank" href="https://drivemug.com/">
  Drivemug
</a>

Want to support Venommail? <a target="_blank" href="https://store.paymug.co/buy/mailflare-sponsor">Start sponsoring</a>

## What you can do

- **Domain setup**: Connect domains and set up Cloudflare Email Routing from the dashboard.
- **Mailboxes**: Create personal and shared mailboxes with delegated access.
- **Email**: Send and receive email with attachments, rich formatting, signatures, and automatic replies.
- **Inbox organization**: Organize mail with search, custom folders, stars, snoozing, archive, spam, and trash.
- **Routing rules**: Create routing rules to store, forward, reject, or categorize incoming messages.
- **Notifications**: Get real-time inbox updates and new-message notifications.
- **Mail and contacts**: Import and export mail, manage contacts, and block unwanted senders.
- **Administration**: Manage accounts, permissions, API keys, webhooks, audit logs, and database backups.
- **Email AI Assistant**: Use an AI assistant to search mail, work with threads, and prepare drafts for a selected mailbox.
- **MCP access**: Connect external AI clients through MCP with mailbox or admin permissions chosen for each key.

## How it works

Venommail runs in your Cloudflare account. Email Routing delivers incoming messages to the app, while Cloudflare's email service handles outgoing messages. Your mail data stays in your own D1 database and attachments are stored in your own R2 bucket.

## How much does it cost?

You can set up Venommail and receive email for free

A [Paid Worker](https://developers.cloudflare.com/workers/platform/pricing/) plan ($5/month) is required to send email (and it's recommend to have a smooth experience)

## Deploy

Getting started takes three steps:

1. **Deploy the app.** From this repository, run `npm run deploy` and keep the Worker name as `venommail`. The app will not work correctly under another Worker name.
2. **Complete setup.** Open the deployed app and follow `/setup` to check the installation and create your admin account.
3. **Connect your domain.** Add a domain managed by the same Cloudflare account. Venommail configures its email routing and helps you create the first mailbox.

⚠️ IMPORTANT: **`CF_TOKEN` is required during deployment**. Create a scoped Cloudflare API token with the following permissions for the domains you want to connect.
- All accounts - Email Sending:Edit, DNS Settings:Edit, Email Routing Addresses:Edit
- All zones - DNS Settings:Edit, Email Routing Rules:Edit, Zone Settings:Edit, DNS:Edit

See the [deployment guide](docs/deployment.md) for required permissions, manual deployment, and backups.

### Self-host with Docker instead

Venommail also runs as one container on any server, with SQLite and local files in place of D1 and R2, a built-in SMTP listener for inbound mail (or a small Cloudflare relay Worker if you want to keep MX on Cloudflare), and any SMTP relay or Cloudflare Email Sending for outbound.

```bash
cp .env.docker.example .env.docker
docker compose up -d --build
```

See [docs/self-hosting.md](docs/self-hosting.md).

## Local development

```bash
cp .dev.vars.example .dev.vars
npm install
npm run db:migrate:local
npm run dev
```

Add your Cloudflare credentials to `.dev.vars`, then open [http://localhost:3000](http://localhost:3000). For sample local data, run `npm run db:seed` while the development server is running.

## Documentation

- [Deployment and configuration](docs/deployment.md)
- [API and integrations](docs/api.md)
- [Email assistant and MCP](docs/email-assistant-and-mcp.md)
- [Troubleshooting](docs/troubleshooting.md)

## License

See [LICENSE](LICENSE).
