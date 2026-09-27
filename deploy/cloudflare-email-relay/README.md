# Mailflare email relay

A small Cloudflare Worker for self-hosted Mailflare installs that want to keep
receiving mail through Cloudflare Email Routing (no port 25, no MX changes).

1. `npm install`, then `npx wrangler secret put MAILFLARE_URL` (your server's
   public URL, e.g. `https://mail.example.com`) and
   `npx wrangler secret put INBOUND_WEBHOOK_SECRET` (the same value as in the
   server's `.env.docker`).
2. `npm run deploy`.
3. In the Cloudflare dashboard, under Email Routing for your zone, route the
   catch-all, or the addresses you want, to the `mailflare-email-relay` Worker.
   Set `CF_EMAIL_WORKER_NAME=mailflare-email-relay` on the server so the address
   rules Mailflare creates for new mailboxes point here too.

Each message is posted to `/api/inbound` on your server with an HMAC
signature. The server stores it and replies with the routing decision, so
reject rules and forwarding rules still act at Cloudflare's edge. The relay
forwards to every destination the server names; if a forward fails and the
server kept no copy, it asks the server to keep one. If the server is
unreachable the Worker throws instead of rejecting, so the message is not
bounced permanently.
