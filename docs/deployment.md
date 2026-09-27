# Deployment and configuration

This guide covers Cloudflare deployment, runtime configuration, database backups, and schema migrations.

## Overview

Set up Mailflare in three steps:

1. **Deploy the app:** from this repository, run `npm run deploy`, keep the Worker name `mailflare`, and provide the required `CF_TOKEN`.
2. **Complete setup:** open the deployed app and follow `/setup` to check the installation and create the first admin account.
3. **Connect your domain:** add a domain managed by the same Cloudflare account. Mailflare configures email routing and, when available and selected, email sending before helping you create the first mailbox.

The Worker name must remain `mailflare`. Before starting, create the required `CF_TOKEN` with **Zone Read**, **DNS Edit**, **Email Routing Edit**, and **Email Routing Rules Write** permissions for every domain you plan to connect. DNS Edit lets the confirmed setup flow replace conflicting MX records. Add **Email Sending Edit** when Mailflare should send email; it is optional for receive-only domains.

## Step 1: Deploy mailflare

From this repository:

```bash
npm install
npm run deploy
```

1. Sign in to the Cloudflare account that owns the domain you want to use.
2. Keep the Worker name exactly `mailflare`. Do not rename it. Email Routing rules target that name.
3. Set `CF_TOKEN` as a Worker secret before the app serves mail.
4. Wait for Wrangler to finish provisioning and deploying the Worker.

### Required configuration

Mailflare requires this runtime value:

- `CF_TOKEN` — a scoped Cloudflare API token with **Zone Read**, **DNS Edit**, **Email Routing Edit**, and **Email Routing Rules Write** access for the domains you will connect. Add **Email Sending Edit** to enable outbound mail. This is separate from the token Cloudflare uses to deploy the app.

Paste only the token secret into `CF_TOKEN`. Do not include the word `Bearer` and do not use the token ID. The token must belong to the same Cloudflare account as the domains you connect.

## Step 2: Complete mailflare setup

1. Open the URL of the deployed `mailflare` Worker.
2. Go to `/setup` if Mailflare does not take you there automatically.
3. Let Mailflare check the required Cloudflare configuration and initialize the empty D1 database.
4. Create the first admin account when prompted.

Setup applies the committed migrations through the Worker's D1 binding before creating the first admin account.

## Step 3: Connect your primary domain and create an account

1. Enter a domain that already uses Cloudflare DNS on the same account as `CF_TOKEN`.
2. Continue while Mailflare enables Email Routing and configures the required routing and sending DNS.
3. Choose the address for your first mailbox and finish setup.
4. Open the inbox and send a test message to the new address.

To connect more domains later, open **Admin → Domains**, select **New domain**, and enter the hostname. Mailflare configures Email Routing and Email Sending automatically.

Your inbox should be ready to send and receive emails

---

## Manual deployment

Install dependencies, configure the Cloudflare bindings in `wrangler.jsonc`, and run:

```bash
npm install
npm run deploy:local
```

The local deploy command builds and uploads the complete Worker with Wrangler. It does not modify D1. The complete Worker is required because `worker.ts` also handles inbound email, queues, scheduled backups, and the real-time Durable Object.

For manual recovery, pending migrations can still be applied with:

```bash
npm run db:migrate:remote
```

Remote migrations require the target account's `database_id` in your local `wrangler.jsonc`. Do not commit an account-specific database ID to a reusable repository.

## Database backups

Mailflare exports its D1 records as JSON and stores the backup files in the configured R2 bucket. A cron trigger in `wrangler.jsonc` runs daily at 02:00 UTC and applies the schedule selected under **Admin → Backups**. Manual backups run the same record export directly from the admin API.

Deploy the complete Worker with `npm run deploy` whenever the cron trigger is added or changed.

After upgrading an existing installation and confirming the cron trigger is active, the old Workflow can be removed with `npx wrangler workflows delete mailflare-database-backup`. Deleting it also removes its historical Workflow instances; backup files in R2 and rows in Mailflare's backup history are unaffected.

## Email assistant and MCP

The assistant uses the Workers AI `AI` binding and a separate `mailflare-agent` queue. Provision the queue in the Cloudflare account before deploying a configuration that declares it, and apply migration `0032_add_agentic_mail.sql` before opening the new UI on an existing database. The five-minute cron recovers pending auto-draft work; the 02:00 UTC cron still runs backups.

In the inbox, open **Assistant → Settings** for a mailbox, select its reviewer, and enable the assistant. Auto-drafting is a separate opt-in. It skips spam, automated mail, and mailboxes with out-of-office replies enabled. Generated replies appear as ordinary drafts assigned to the reviewer. The reviewer must open the draft and confirm the exact content before delivery.

The assistant panel no longer exposes MCP key management. External MCP clients can still connect to `https://<your-mailflare-origin>/mcp` with a mailbox-scoped Bearer key created through the authenticated `/api/agent/mcp-keys` endpoint. Keys can be listed and revoked through that endpoint; a new key is shown only once. The server uses Streamable HTTP and accepts clients that can set a Bearer header. Its `request_send` tool returns a Mailflare review URL; the MCP key cannot confirm or deliver messages directly. MCP does not require Workers AI for read and draft tools.

## Schema migrations

This install does not pull application source from another repository. Deploy changes by building and uploading this repository with `npm run deploy`. There is no admin button that dispatches a GitHub workflow.

Deployment and database migration are separate. After a deploy, apply pending D1 migrations with:

```bash
npm run db:migrate:remote
```

The same runner initializes a new database during setup. An administrator can also call `GET` and `POST /api/admin/migrations` with an admin session. Self-hosted installs apply `drizzle/migrations` when the process starts.

If the Cloudflare dashboard has a custom deploy command containing `wrangler d1 migrations apply DB --remote`, remove that part and use `npm run deploy`.

Each migration and its `d1_migrations` history entry run in one D1 batch. If a migration fails, its changes are rolled back, the failed filename is shown, and it can be retried after the problem is corrected. Wrangler remains available as a manual recovery tool.

New application releases must remain compatible with the previous schema until an administrator applies their migrations. Prefer additive changes, keep old columns during the transition, and avoid making authentication or the admin settings page depend immediately on a newly added column. Plan a maintenance window for an incompatible schema change.

When adding a schema change, create a new uniquely named SQL file in `drizzle/migrations` and do not edit an applied migration. Build and development commands generate the Worker migration bundle from those files. `npm run db:bundle` can generate it explicitly.

## Branding license

Activate a purchased Pro or Team key from **Admin → Licenses**. Mailflare sends the key to Paymug and stores only a one-way hash and the activation state. Apply all D1 migrations before activating a license.
