import { eq, and, asc, desc, sql } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { domains, folders, mailboxAliases, mailboxes, routingRules } from "@/db/schema";
import { getEmailAddress } from "@/lib/email/address";
import { getMailboxDomainAddresses } from "@/lib/mailboxes/domain-addresses";
import { parseRecipientAddress, rankLocalPartMatch } from "@/lib/email/recipient-address";
import type { ParsedRecipientAddress } from "@/lib/email/recipient-address-types";

export type ResolvedMailbox = {
	mailboxId: string;
	folderId: string | null;
	userId: string;
	domainId: string;
	localPart: string;
	hostname: string;
	displayName: string | null;
};

export type RoutingDecision = {
	action: "store" | "forward" | "reject";
	mailbox?: ResolvedMailbox;
	forwardTo?: string;
	/** Forward rules drop the message unless the rule also keeps a copy in the mailbox. */
	keepCopy?: boolean;
	rejectReason?: string;
	/** Set when a domain-scope rule produced this decision, so the caller can record a match. */
	ruleId?: string;
};

export type InboxRuleDestination = {
	status: "received" | "spam" | "trash";
	folderId: string | null;
};

type RuleRow = typeof routingRules.$inferSelect;

export type RuleMatchInput = {
	toAddress: string;
	fromAddress?: string | null;
	subject?: string | null;
	content?: string | null;
};

/**
 * Resolves what should happen to an inbound message addressed to `toAddress`.
 *
 * Domain-scope rules are evaluated in three phases so that a broad catch-all can never
 * shadow a real mailbox:
 *   1. `reject` rules (block lists) — highest precedence, evaluated before delivery.
 *   2. exact mailbox, then multi-domain mailbox aliases.
 *   3. remaining `forward` / `store` rules — the catch-all fallback.
 * Within each phase rules run by descending priority, then oldest first.
 */
export async function resolveInboundAddress(
	db: AppDatabase,
	toAddress: string,
	fromAddress?: string | null,
): Promise<RoutingDecision | null> {
	const parsed = parseRecipientAddress(toAddress);
	if (!parsed) return null;

	const [domain] = await db
		.select()
		.from(domains)
		.where(and(eq(domains.hostname, parsed.domain), eq(domains.status, "active")))
		.limit(1);

	if (!domain) return null;

	const domainRules = await listDomainRules(db, domain.id);
	const matchInput: RuleMatchInput = { toAddress, fromAddress };

	// Phase 1 — block rules run before any mailbox lookup so they can block a sender
	// even when the recipient is a real mailbox.
	for (const rule of domainRules) {
		if (rule.action !== "reject") continue;
		if (!matchesRule(rule, matchInput)) continue;
		return {
			action: "reject",
			rejectReason: rule.rejectReason?.trim() || "Message rejected by routing rule",
			ruleId: rule.id,
		};
	}

	// Phase 2 — a real mailbox always wins over a catch-all.
	const mailbox = await findAddressMailbox(db, domain.id, parsed);

	if (mailbox) {
		return {
			action: "store",
			mailbox: toResolvedMailbox(mailbox, domain.id, domain.hostname),
		};
	}

	// Phase 3 — catch-all and forwarding fallbacks.
	for (const rule of domainRules) {
		if (rule.action !== "forward" && rule.action !== "store") continue;
		if (!matchesRule(rule, matchInput)) continue;

		if (rule.action === "forward") {
			const forwardTo = rule.forwardTo?.trim();
			if (!forwardTo) continue;
			const catchAll = rule.mailboxId ? await getRuleMailbox(db, rule.mailboxId, domain.id) : null;
			return {
				action: "forward",
				forwardTo,
				keepCopy: rule.keepCopy && !!catchAll,
				mailbox: catchAll ?? undefined,
				ruleId: rule.id,
			};
		}

		if (!rule.mailboxId) continue;
		const catchAll = await getRuleMailbox(db, rule.mailboxId, domain.id);
		if (!catchAll) continue;
		return { action: "store", mailbox: catchAll, ruleId: rule.id };
	}

	return null;
}

/**
 * The mailbox that keeps a message the edge has already accepted. Reject and forward only work
 * on the live message, so once a message is queued it is stored: where its route delivers, else
 * in the mailbox that owns the address, else with the recipient domain's owner. `blocked` marks
 * mail that a reject rule matches now but that was accepted before the rule could refuse it.
 */
export async function resolveAcceptedMailbox(
	db: AppDatabase,
	toAddress: string,
	fromAddress?: string | null,
): Promise<{ mailbox: ResolvedMailbox; blocked: boolean } | null> {
	const decision = await resolveInboundAddress(db, toAddress, fromAddress);
	if (decision?.mailbox) return { mailbox: decision.mailbox, blocked: false };

	const parsed = parseRecipientAddress(toAddress);
	if (!parsed) return null;
	const [domain] = await db.select().from(domains).where(eq(domains.hostname, parsed.domain)).limit(1);
	if (!domain) return null;

	const addressMailbox = await findAddressMailbox(db, domain.id, parsed);
	const mailbox = addressMailbox
		? toResolvedMailbox(addressMailbox, domain.id, domain.hostname)
		: await findDomainOwnerMailbox(db, domain);
	return mailbox ? { mailbox, blocked: decision?.action === "reject" } : null;
}

async function findDomainOwnerMailbox(
	db: AppDatabase,
	domain: typeof domains.$inferSelect,
): Promise<ResolvedMailbox | null> {
	const rows = await db
		.select({ mailbox: mailboxes, hostname: domains.hostname })
		.from(mailboxes)
		.innerJoin(domains, eq(mailboxes.domainId, domains.id))
		.where(and(eq(mailboxes.userId, domain.userId), eq(mailboxes.disabled, false)))
		.orderBy(asc(mailboxes.createdAt), asc(mailboxes.id));
	const row = rows.find((item) => item.mailbox.domainId === domain.id) ?? rows[0];
	return row ? toResolvedMailbox(row.mailbox, row.mailbox.domainId, row.hostname) : null;
}

type MailboxRow = typeof mailboxes.$inferSelect;

/**
 * The closest owner of an address on a domain: its mailboxes and aliases, then mailboxes that
 * answer on every domain. A closer match wins across all three; ties go to the domain's own
 * addresses, then to the oldest.
 */
async function findAddressMailbox(
	db: AppDatabase,
	domainId: string,
	recipient: ParsedRecipientAddress,
): Promise<MailboxRow | null> {
	const direct = await db
		.select()
		.from(mailboxes)
		.where(and(eq(mailboxes.domainId, domainId), eq(mailboxes.disabled, false)))
		.orderBy(asc(mailboxes.createdAt), asc(mailboxes.id));
	const aliases = await db
		.select({ mailbox: mailboxes, localPart: mailboxAliases.localPart })
		.from(mailboxAliases)
		.innerJoin(mailboxes, eq(mailboxAliases.mailboxId, mailboxes.id))
		.where(and(eq(mailboxAliases.domainId, domainId), eq(mailboxes.disabled, false)))
		.orderBy(asc(mailboxAliases.createdAt), asc(mailboxAliases.id));
	const onDomain = closestLocalPart(
		[...direct.map((mailbox) => ({ mailbox, localPart: mailbox.localPart })), ...aliases],
		recipient.addressedLocalPart,
	);
	if (onDomain?.rank === 0) return onDomain.mailbox;
	const everyDomain = await findMultiDomainMailbox(db, recipient, onDomain?.rank ?? Number.POSITIVE_INFINITY);
	return everyDomain ?? onDomain?.mailbox ?? null;
}

function closestLocalPart<T extends { localPart: string }>(
	candidates: T[],
	addressedLocalPart: string,
	closerThan = Number.POSITIVE_INFINITY,
): (T & { rank: number }) | null {
	let best: (T & { rank: number }) | null = null;
	for (const candidate of candidates) {
		const rank = rankLocalPartMatch(candidate.localPart, addressedLocalPart);
		if (rank === null || rank >= (best?.rank ?? closerThan)) continue;
		best = { ...candidate, rank };
	}
	return best;
}

async function findMultiDomainMailbox(
	db: AppDatabase,
	recipient: ParsedRecipientAddress,
	closerThan: number,
): Promise<MailboxRow | null> {
	const candidates = await db
		.select()
		.from(mailboxes)
		.where(and(eq(mailboxes.useAllDomains, true), eq(mailboxes.disabled, false)))
		.orderBy(asc(mailboxes.createdAt), asc(mailboxes.id));
	let best: { mailbox: MailboxRow; rank: number } | null = null;
	for (const mailbox of candidates) {
		const match = closestLocalPart([{ mailbox, localPart: mailbox.localPart }], recipient.addressedLocalPart, best?.rank ?? closerThan);
		if (!match) continue;
		const addresses = await getMailboxDomainAddresses(db, mailbox);
		if (addresses.includes(`${mailbox.localPart}@${recipient.domain}`.toLowerCase())) best = match;
	}
	return best?.mailbox ?? null;
}

async function listDomainRules(db: AppDatabase, domainId: string): Promise<RuleRow[]> {
	return db
		.select()
		.from(routingRules)
		.where(
			and(
				eq(routingRules.domainId, domainId),
				eq(routingRules.scope, "domain"),
				eq(routingRules.enabled, true),
			),
		)
		.orderBy(desc(routingRules.priority), asc(routingRules.createdAt));
}

async function getRuleMailbox(
	db: AppDatabase,
	mailboxId: string,
	domainId: string,
): Promise<ResolvedMailbox | null> {
	const [mailbox] = await db
		.select()
		.from(mailboxes)
		.where(and(eq(mailboxes.id, mailboxId), eq(mailboxes.disabled, false)))
		.limit(1);
	if (!mailbox) return null;

	const [domain] = await db
		.select({ hostname: domains.hostname })
		.from(domains)
		.where(eq(domains.id, domainId))
		.limit(1);
	if (!domain) return null;

	return toResolvedMailbox(mailbox, domainId, domain.hostname);
}

function toResolvedMailbox(
	mailbox: typeof mailboxes.$inferSelect,
	domainId: string,
	hostname: string,
): ResolvedMailbox {
	return {
		mailboxId: mailbox.id,
		folderId: null,
		userId: mailbox.userId,
		domainId,
		localPart: mailbox.localPart,
		hostname,
		displayName: mailbox.displayName,
	};
}

/** Records that a domain rule fired, for the "last matched" column in the routing UI. */
export async function recordRuleMatch(db: AppDatabase, ruleId: string): Promise<void> {
	await db
		.update(routingRules)
		.set({ matchCount: sql`${routingRules.matchCount} + 1`, lastMatchedAt: new Date() })
		.where(eq(routingRules.id, ruleId));
}

export async function resolveInboxRuleDestination(
	db: AppDatabase,
	input: {
		mailboxId: string;
		toAddress: string;
		fromAddress?: string | null;
		subject?: string | null;
		content?: string | null;
	},
): Promise<InboxRuleDestination> {
	const rules = await db
		.select()
		.from(routingRules)
		.where(
			and(
				eq(routingRules.mailboxId, input.mailboxId),
				eq(routingRules.scope, "mailbox"),
				eq(routingRules.enabled, true),
			),
		)
		.orderBy(desc(routingRules.priority), asc(routingRules.createdAt));

	for (const rule of rules) {
		if (!matchesRule(rule, input)) continue;

		if (rule.action === "spam" || rule.action === "trash") {
			return { status: rule.action, folderId: null };
		}

		if (!rule.folderId) continue;
		const folderId = await getRuleFolderId(db, rule.folderId, input.mailboxId);
		if (!folderId) continue;
		return { status: "received", folderId };
	}

	return { status: "received", folderId: null };
}

type MatchableRule = {
	pattern: string;
	matchField?: string | null;
	matchOperator?: string | null;
	matchValue?: string | null;
};

export function matchesRule(rule: MatchableRule, input: RuleMatchInput): boolean {
	const rawValue = (rule.matchValue || rule.pattern).trim();
	// "*" is the catch-all pattern used by catch-all and block-everything rules.
	if (rawValue === "*") return true;
	const normalizedRuleValue = normalizeRuleComparisonValue(rule.matchField, rawValue);
	if (!normalizedRuleValue) return false;

	const values = getRuleFieldValues(rule.matchField, input);
	return values.some((value) => {
		if (!value) return false;
		const normalizedValue = normalizeRuleComparisonValue(rule.matchField, value);
		if (!normalizedValue) return false;
		return compareRuleValue(rule.matchOperator, normalizedValue, normalizedRuleValue, rawValue);
	});
}

function compareRuleValue(
	operator: string | null | undefined,
	value: string,
	ruleValue: string,
	rawRuleValue: string,
): boolean {
	switch (operator) {
		case "exact":
			return value === ruleValue;
		case "starts_with":
			return value.startsWith(ruleValue);
		case "ends_with":
			return value.endsWith(ruleValue);
		case "regex":
			return matchesRegex(value, rawRuleValue);
		default:
			return value.includes(ruleValue);
	}
}

/**
 * Rule patterns are operator-authored but still untrusted enough to warrant guarding:
 * an invalid pattern must not throw and take down inbound processing.
 */
function matchesRegex(value: string, pattern: string): boolean {
	try {
		return new RegExp(pattern, "i").test(value);
	} catch {
		return false;
	}
}

function normalizeRuleComparisonValue(field: string | null | undefined, value: string | null | undefined): string {
	if (!value) return "";
	if (field === "email" || field === "sender" || field === "recipient") {
		return getEmailAddress(value).trim().toLowerCase();
	}
	return value.toLowerCase();
}

function getRuleFieldValues(field: string | null | undefined, input: RuleMatchInput) {
	if (field === "content") return [input.content];
	if (field === "title") return [input.subject];
	if (field === "sender") return [input.fromAddress];
	if (field === "recipient") return [input.toAddress];
	return [input.fromAddress, input.toAddress];
}

async function getRuleFolderId(
	db: AppDatabase,
	folderId: string,
	mailboxId: string,
): Promise<string | null> {
	const [folder] = await db
		.select({ id: folders.id })
		.from(folders)
		.where(and(eq(folders.id, folderId), eq(folders.mailboxId, mailboxId)))
		.limit(1);
	return folder?.id ?? null;
}
