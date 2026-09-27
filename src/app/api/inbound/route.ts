import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { intakeIncomingMail } from "@/lib/email/intake";
import { verifyInboundSignature } from "@/lib/email/intake-signature";

export const dynamic = "force-dynamic";

/**
 * Inbound mail from the Cloudflare email relay Worker (deploy/cloudflare-email-relay).
 * The body is the raw RFC 5322 message; envelope addresses travel in headers and
 * the request is HMAC-signed with INBOUND_WEBHOOK_SECRET. The response tells the
 * relay whether to reject and where to forward, since only it can act on the live message.
 */
export async function POST(request: Request) {
	const env = getEnv();
	const secret = env.INBOUND_WEBHOOK_SECRET?.trim();
	if (!secret) return NextResponse.json({ error: "INBOUND_WEBHOOK_SECRET is not configured" }, { status: 503 });

	const raw = await request.arrayBuffer();
	if (raw.byteLength > 25 * 1024 * 1024) return NextResponse.json({ error: "Message too large" }, { status: 413 });
	const from = request.headers.get("x-mailflare-from") ?? "";
	const to = request.headers.get("x-mailflare-to") ?? "";
	const signature = request.headers.get("x-mailflare-signature") ?? "";
	const keepCopy = request.headers.get("x-mailflare-keep-copy") === "1";
	if (!from || !to || !(await verifyInboundSignature(secret, signature, raw, from, to, keepCopy))) {
		return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
	}

	let headers: Record<string, string> = {};
	try {
		headers = JSON.parse(request.headers.get("x-mailflare-headers") ?? "{}") as Record<string, string>;
	} catch {
		// The header map is advisory; the raw message is authoritative.
	}

	const forwards: Array<{ to: string; headers: Record<string, string> }> = [];
	const result = await intakeIncomingMail(
		env,
		{ from, to, raw, headers },
		{
			// The relay forwards after this responds, so a forward-only rule skips storage here.
			// When one of those forwards fails the relay asks again with keep-copy, and then no
			// forward counts as sent, which stores the message.
			forward: async (destination, extra) => {
				if (keepCopy) return false;
				forwards.push({ to: destination, headers: extra });
				return true;
			},
		},
	);
	const last = forwards.at(-1);
	return NextResponse.json({ ...result, forwards, forwardTo: last?.to ?? null, forwardHeaders: last?.headers ?? {} });
}
