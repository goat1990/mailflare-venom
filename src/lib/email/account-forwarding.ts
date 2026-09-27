import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { getEmailAddress } from "@/lib/email/address";
import { resolveInboundAddress } from "@/lib/email/routing";
import { getLicenseEntitlements } from "@/lib/licenses/service";

export const MAILFLARE_FORWARDED_HEADER = "X-Mailflare-Forwarded";

/** Forwarding follows the mailbox owner. A domain owner or creating admin does not inherit it. */
export function forwardingDestinationForMailbox(input: {
	mailboxOwnerUserId: string;
	forwardingUserId: string;
	forwardingEmail: string | null;
	recipient: string;
}): string | null {
	if (input.mailboxOwnerUserId !== input.forwardingUserId) return null;
	const destination = input.forwardingEmail?.trim() ?? "";
	if (!destination || getEmailAddress(destination).toLowerCase() === getEmailAddress(input.recipient).toLowerCase()) return null;
	return destination;
}

export async function getAccountForwardingDestination(
	env: CloudflareEnv,
	recipient: string,
): Promise<string | null> {
	if (!(await getLicenseEntitlements(env)).canForwardEmail) return null;
	const db = getDb(env);
	const decision = await resolveInboundAddress(db, recipient);
	if (!decision?.mailbox) return null;
	const [account] = await db
		.select({ id: users.id, forwardingEmail: users.forwardingEmail })
		.from(users)
		.where(eq(users.id, decision.mailbox.userId))
		.limit(1);
	if (!account) return null;
	return forwardingDestinationForMailbox({
		mailboxOwnerUserId: decision.mailbox.userId,
		forwardingUserId: account.id,
		forwardingEmail: account.forwardingEmail,
		recipient,
	});
}
