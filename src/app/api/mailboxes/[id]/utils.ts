import { eq } from "drizzle-orm";
import { domains, mailboxes, users } from "@/db/schema";
import type { getDb } from "@/db";
import { deleteEmailRoutingRuleForAddress } from "@/lib/cloudflare-api";
import { getMailboxDomainAddresses } from "@/lib/mailboxes/domain-addresses";
import type { MailboxUpdateValues } from "./types";

type Db = ReturnType<typeof getDb>;

/** Deletes the Cloudflare rules for addresses a mailbox answers only while it uses every domain. */
export async function removeOtherDomainRouting(
	env: CloudflareEnv,
	db: Db,
	mailbox: { id: string; domainId: string; localPart: string },
): Promise<void> {
	const everyDomain = await getMailboxDomainAddresses(db, { ...mailbox, useAllDomains: true });
	const ownDomain = new Set(await getMailboxDomainAddresses(db, { ...mailbox, useAllDomains: false }));
	const dropped = everyDomain.filter((address) => !ownDomain.has(address));
	if (dropped.length === 0) return;
	const zones = await db.select({ hostname: domains.hostname, zoneId: domains.zoneId }).from(domains);
	const zoneByHostname = new Map(zones.map((zone) => [zone.hostname.toLowerCase(), zone.zoneId]));
	await Promise.all(
		dropped.map(async (address) => {
			const zoneId = zoneByHostname.get(address.slice(address.lastIndexOf("@") + 1));
			if (zoneId) await deleteEmailRoutingRuleForAddress(env, zoneId, address);
		}),
	);
}

export function selectMailboxForUser(db: Db, userId: string, mailboxId: string) {
	return db
		.select({
			id: mailboxes.id,
			userId: mailboxes.userId,
			domainId: mailboxes.domainId,
		localPart: mailboxes.localPart,
		displayName: mailboxes.displayName,
		signature: mailboxes.signature,
		autoReplyEnabled: mailboxes.autoReplyEnabled,
		autoReplySubject: mailboxes.autoReplySubject,
		autoReplyBody: mailboxes.autoReplyBody,
		useAllDomains: mailboxes.useAllDomains,
			avatarKey: mailboxes.avatarKey,
			ownerName: users.name,
			ownerAvatarKey: users.avatarKey,
			type: mailboxes.type,
			disabled: mailboxes.disabled,
			createdAt: mailboxes.createdAt,
			hostname: domains.hostname,
		})
		.from(mailboxes)
		.innerJoin(domains, eq(mailboxes.domainId, domains.id))
		.innerJoin(users, eq(mailboxes.userId, users.id))
		.where(eq(mailboxes.id, mailboxId))
		.limit(1);
}

export function getMailboxUpdateValues(input: MailboxUpdateValues): MailboxUpdateValues {
	const values: MailboxUpdateValues = {};
	if ("displayName" in input) values.displayName = input.displayName?.trim() || null;
	if ("signature" in input) values.signature = input.signature?.trim() || null;
	if ("autoReplyEnabled" in input) values.autoReplyEnabled = input.autoReplyEnabled;
	if ("autoReplySubject" in input) values.autoReplySubject = input.autoReplySubject?.trim() || "Out of office";
	if ("autoReplyBody" in input) values.autoReplyBody = input.autoReplyBody?.trim() || "";
	if ("useAllDomains" in input) values.useAllDomains = input.useAllDomains;
	return values;
}
