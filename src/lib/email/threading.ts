import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { getDb } from "@/db";
import { messages } from "@/db/schema";
import { newId } from "@/lib/ids";
import type { ResolveThreadInput } from "@/lib/email/threading-types";

type Db = ReturnType<typeof getDb>;

/** RFC 5322 Message-IDs are compared without their angle brackets or surrounding space. */
export function normalizeMessageId(value: string | null | undefined): string | null {
	const trimmed = (value ?? "").trim().replace(/^<|>$/g, "").trim();
	return trimmed || null;
}

/** A References header is a whitespace (occasionally comma) separated list of Message-IDs. */
export function parseMessageIdList(value: string | null | undefined): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const token of (value ?? "").split(/[\s,]+/)) {
		const id = normalizeMessageId(token);
		if (!id || seen.has(id)) continue;
		seen.add(id);
		result.push(id);
	}
	return result;
}

export function formatMessageIdHeader(ids: string[]): string {
	return ids.map((id) => `<${id}>`).join(" ");
}

/**
 * The References line a reply should carry: the parent's own chain followed by
 * the parent itself. Long chains keep the root and the most recent ancestors,
 * which is what mail clients use to reconstruct a conversation.
 */
export function buildReplyReferences(parentReferences: string[], parentMessageId: string | null): string[] {
	const ids = [...parentReferences];
	const parent = normalizeMessageId(parentMessageId);
	if (parent && !ids.includes(parent)) ids.push(parent);
	const MAX = 30;
	if (ids.length <= MAX) return ids;
	return [ids[0], ...ids.slice(ids.length - (MAX - 1))];
}

/** Parents looked up per message; each costs two bound parameters and D1 allows 100 per statement. */
const MAX_PARENT_CANDIDATES = 20;

/**
 * Work out which conversation a message belongs to. A reply names its parent in
 * In-Reply-To or References; if that parent is stored in the same mailbox, the
 * new message joins the parent's thread. The closest parent wins: In-Reply-To,
 * then References from its newest entry back, since older entries may belong to
 * a conversation this one branched from. Otherwise the message starts a thread
 * keyed by its own Message-ID so later replies can find it.
 */
export async function resolveThreadId(db: Db, input: ResolveThreadInput): Promise<string> {
	const candidates = [...new Set(
		[normalizeMessageId(input.inReplyTo), ...[...(input.references ?? [])].reverse().map((id) => normalizeMessageId(id))]
			.filter((id): id is string => !!id),
	)].slice(0, MAX_PARENT_CANDIDATES);

	if (input.mailboxId && candidates.length > 0) {
		// Stored Message-IDs may or may not include their angle brackets.
		const variants = candidates.flatMap((id) => [id, `<${id}>`]);
		const rows = await db
			.select({ id: messages.id, threadId: messages.threadId, providerMessageId: messages.providerMessageId })
			.from(messages)
			.where(and(eq(messages.mailboxId, input.mailboxId), inArray(messages.providerMessageId, variants)))
			.orderBy(asc(messages.createdAt), asc(messages.id));
		const parent = candidates
			.map((id) => rows.find((row) => normalizeMessageId(row.providerMessageId) === id))
			.find((row) => row !== undefined);
		if (parent?.threadId) return parent.threadId;
		if (parent) {
			// Lists group by coalesce(threadId, id), so a parent without a thread would stay apart
			// from its replies; it takes the key they are about to share.
			const threadId = normalizeMessageId(parent.providerMessageId) ?? newId("thr");
			await db.update(messages).set({ threadId }).where(and(eq(messages.id, parent.id), isNull(messages.threadId)));
			return threadId;
		}
	}

	return normalizeMessageId(input.messageId) ?? newId("thr");
}
