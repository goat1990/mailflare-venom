import { getAccountForwardingDestination, MAILFLARE_FORWARDED_HEADER } from "@/lib/email/account-forwarding";
import { resolveIncomingMail } from "@/lib/email/incoming";
import type { InboundQueueMessage } from "@/lib/email/inbound";
import type { IntakeActions, IntakeInput, IntakeResult } from "@/lib/email/intake-types";

/**
 * The edge of inbound mail, shared by the Worker `email` handler, the SMTP listener and the
 * Cloudflare relay webhook: resolve domain rules, act on reject and forward through the supplied
 * callbacks, then store the raw MIME and enqueue it for parsing. Whatever reaches the queue is
 * stored there, so a forward that did not go out falls through to storage here.
 */
export async function intakeIncomingMail(env: CloudflareEnv, input: IntakeInput, actions: IntakeActions): Promise<IntakeResult> {
	const decision = await resolveIncomingMail(env, input.from, input.to);

	if (decision?.action === "reject") {
		const reason = decision.rejectReason ?? "Message rejected by routing rule";
		await actions.reject?.(reason);
		return { action: "reject", reason };
	}

	let forwardedTo: string | null = null;
	if (decision?.action === "forward" && decision.forwardTo) {
		const forwarded = await actions.forward?.(decision.forwardTo, { [MAILFLARE_FORWARDED_HEADER]: "1" });
		if (forwarded) forwardedTo = decision.forwardTo;
		if (forwarded && !decision.keepCopy) return { action: "forward", forwardedTo };
	}

	const alreadyForwarded = input.headers[MAILFLARE_FORWARDED_HEADER.toLowerCase()] === "1" || input.headers[MAILFLARE_FORWARDED_HEADER] === "1";
	if (!alreadyForwarded) {
		const destination = await getAccountForwardingDestination(env, input.to);
		if (destination) await actions.forward?.(destination, { [MAILFLARE_FORWARDED_HEADER]: "1" });
	}

	const rawR2Key = await getInboundRawKey(input);
	await env.BUCKET.put(rawR2Key, input.raw, {
		httpMetadata: { contentType: "message/rfc822" },
		customMetadata: { from: input.from, to: input.to },
	});
	const payload: InboundQueueMessage = { from: input.from, to: input.to, rawR2Key, headers: input.headers };
	await env.INBOUND_QUEUE.send(payload);
	return { action: "store", rawR2Key, forwardedTo };
}

/**
 * Keyed by content and envelope, so a sender retrying the same delivery rewrites one object and
 * the queue recognises the stored row instead of filing a second copy.
 */
async function getInboundRawKey(input: IntakeInput): Promise<string> {
	const [content, envelope] = await Promise.all([
		crypto.subtle.digest("SHA-256", input.raw),
		crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${input.from}\n${input.to}`)),
	]);
	return `inbound/${hex(content)}-${hex(envelope).slice(0, 16)}.eml`;
}

function hex(buffer: ArrayBuffer): string {
	return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
