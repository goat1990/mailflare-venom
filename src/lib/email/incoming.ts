import { getDb } from "@/db";
import { recordRuleMatch, resolveInboundAddress, type RoutingDecision } from "@/lib/email/routing";

/**
 * Resolves the routing decision for a live inbound message, while `forward()` and
 * `setReject()` are still available on it.
 *
 * Never throws: a routing failure must not stop mail from being stored.
 */
export async function resolveIncomingMail(
	env: CloudflareEnv,
	from: string,
	to: string,
): Promise<RoutingDecision | null> {
	try {
		const db = getDb(env);
		const decision = await resolveInboundAddress(db, to, from);
		if (decision?.ruleId) {
			await recordRuleMatch(db, decision.ruleId).catch(() => undefined);
		}
		return decision;
	} catch (error) {
		console.error(`Routing resolution failed for ${to}`, error);
		return null;
	}
}

/**
 * The reason a domain rule refuses this recipient, or null. SMTP asks at RCPT TO so one
 * blocked recipient is refused alone instead of failing the whole DATA. Only a refusal records
 * the rule match; any other rule is recorded when the message itself is resolved.
 */
export async function resolveRecipientRejection(env: CloudflareEnv, from: string, to: string): Promise<string | null> {
	try {
		const db = getDb(env);
		const decision = await resolveInboundAddress(db, to, from);
		if (decision?.action !== "reject") return null;
		if (decision.ruleId) await recordRuleMatch(db, decision.ruleId).catch(() => undefined);
		return decision.rejectReason ?? "Message rejected by routing rule";
	} catch (error) {
		console.error(`Routing resolution failed for ${to}`, error);
		return null;
	}
}

/**
 * Forwards to a Cloudflare Email Routing destination address. Returns whether the forward
 * succeeded so the caller can decide to still store the message.
 *
 * The destination must be a verified destination address in Cloudflare Email Routing.
 */
export async function forwardMessage(
	message: ForwardableEmailMessage,
	destination: string,
	headers: Record<string, string>,
): Promise<boolean> {
	try {
		await message.forward(destination, new Headers(headers));
		return true;
	} catch (error) {
		console.error(`Forwarding failed for ${message.to} -> ${destination}`, error);
		return false;
	}
}
