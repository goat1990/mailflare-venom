/**
 * Mailflare email relay. Keeps MX on Cloudflare Email Routing while the app
 * runs elsewhere: every message routed to this Worker is posted to the
 * self-hosted server, which answers with the routing decision so reject and
 * forward still happen here, on the live message.
 *
 * Route the domain's catch-all (and any address rules) to this Worker.
 */
type Env = { MAILFLARE_URL: string; INBOUND_WEBHOOK_SECRET: string };

type Forward = { to: string; headers?: Record<string, string> };

type Decision =
	| { action: "reject"; reason: string }
	| { action: "forward" | "store"; forwards?: Forward[]; forwardTo?: string | null; forwardHeaders?: Record<string, string> };

async function sign(secret: string, raw: ArrayBuffer, from: string, to: string, keepCopy: boolean): Promise<string> {
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const prefix = new TextEncoder().encode(`${from}\n${to}\n${keepCopy ? "keep-copy\n" : ""}`);
	const data = new Uint8Array(prefix.byteLength + raw.byteLength);
	data.set(prefix, 0);
	data.set(new Uint8Array(raw), prefix.byteLength);
	return Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", key, data)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function postToMailflare(env: Env, message: ForwardableEmailMessage, raw: ArrayBuffer, keepCopy: boolean): Promise<Decision> {
	const response = await fetch(`${env.MAILFLARE_URL.replace(/\/$/, "")}/api/inbound`, {
		method: "POST",
		headers: {
			"Content-Type": "message/rfc822",
			"X-Mailflare-From": message.from,
			"X-Mailflare-To": message.to,
			"X-Mailflare-Headers": JSON.stringify(Object.fromEntries(message.headers)),
			...(keepCopy ? { "X-Mailflare-Keep-Copy": "1" } : {}),
			"X-Mailflare-Signature": await sign(env.INBOUND_WEBHOOK_SECRET, raw, message.from, message.to, keepCopy),
		},
		body: raw,
	});
	if (response.status === 413) return { action: "reject", reason: "Message too large" };
	if (!response.ok) throw new Error(`Mailflare answered ${response.status}`);
	return (await response.json()) as Decision;
}

export default {
	// Failures are thrown rather than passed to setReject, which bounces the message permanently.
	async email(message: ForwardableEmailMessage, env: Env) {
		const raw = await new Response(message.raw).arrayBuffer();
		const decision = await postToMailflare(env, message, raw, false);
		if (decision.action === "reject") {
			message.setReject(decision.reason);
			return;
		}

		const forwards = decision.forwards ?? (decision.forwardTo ? [{ to: decision.forwardTo, headers: decision.forwardHeaders }] : []);
		let failed = false;
		for (const forward of forwards) {
			try {
				await message.forward(forward.to, new Headers(forward.headers ?? {}));
			} catch (error) {
				console.error(`Forward to ${forward.to} failed`, error);
				failed = true;
			}
		}
		if (!failed || decision.action === "store") return;

		// Mailflare stored nothing because the forward was to carry the message.
		const kept = await postToMailflare(env, message, raw, true);
		if (kept.action === "reject") message.setReject(kept.reason);
		else if (kept.action !== "store") throw new Error(`Mailflare did not keep mail for ${message.to} after its forward failed`);
	},
} satisfies ExportedHandler<Env>;
