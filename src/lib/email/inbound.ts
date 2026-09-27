import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { messages, users } from "@/db/schema";
import { newId } from "@/lib/ids";
import { buildSnippet, parseRawMime } from "@/lib/email/parse";
import { resolveAcceptedMailbox, resolveInboxRuleDestination } from "@/lib/email/routing";
import { dispatchWebhooks } from "@/lib/email/webhooks";
import { getMessageContactNames, upsertContactFromAddress } from "@/lib/contacts/service";
import { getEmailAddress } from "@/lib/email/address";
import { sendMailboxAutoReply } from "@/lib/email/auto-reply";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { listMessageAttachments, storeMessageAttachments } from "@/lib/email/attachments";
import { getUnsubscribeUrlFromRawR2Key } from "@/lib/email/unsubscribe";
import { normalizeMessageId, resolveThreadId } from "@/lib/email/threading";
import type { SessionUser } from "@/lib/auth/types";
import { analyzeSpam } from "@/lib/spam/engine";
import { getReputationKeys } from "@/lib/spam/analyzers/reputation";
import { recordReputationObservation } from "@/lib/spam/repository";
import {
	getMailboxNotificationUserIds,
	notifyUsersOfNewMessage,
} from "@/lib/realtime/utils";
import { scheduleAutoDraft } from "@/lib/agent/jobs/utils";

export type InboundQueueMessage = {
	from: string;
	to: string;
	rawR2Key: string;
	headers?: Record<string, string>;
};

export async function processInboundMessage(
	env: CloudflareEnv,
	payload: InboundQueueMessage,
): Promise<void> {
	const db = getDb(env);
	// The sender is passed so that sender-based block rules resolve the same way here as they
	// do at the edge.
	const accepted = await resolveAcceptedMailbox(db, payload.to, payload.from);
	// Throwing keeps the message on the queue; returning would acknowledge mail nobody stored.
	if (!accepted) throw new Error(`No mailbox can keep inbound mail for ${payload.to}`);
	const { mailbox, blocked } = accepted;

	const [stored] = await db.select({ id: messages.id }).from(messages).where(and(
		eq(messages.mailboxId, mailbox.mailboxId),
		eq(messages.rawR2Key, payload.rawR2Key),
	)).limit(1);
	if (stored) {
		try {
			const [existing] = await db.select().from(messages).where(eq(messages.id, stored.id)).limit(1);
			if (existing && Date.now() - existing.createdAt.getTime() < 30 * 60_000) await scheduleAutoDraft(env, { mailboxId: mailbox.mailboxId, sourceMessageId: existing.id, ownerUserId: mailbox.userId, sender: existing.fromAddr, headers: payload.headers, status: existing.status, folderId: existing.folderId, spamVerdict: existing.spamVerdict, spamAnalysisError: existing.spamAnalysisError });
		} catch (error) { console.error("Auto-draft recovery failed", error); }
		return;
	}

	const raw = await env.BUCKET.get(payload.rawR2Key);
	if (!raw) throw new Error(`Missing R2 object: ${payload.rawR2Key}`);

	const buffer = await raw.arrayBuffer();
	const parsed = await parseRawMime(buffer);
	const inboundDedupeKey = getInboundDedupeKey(mailbox.mailboxId, parsed.messageId, payload.rawR2Key);
	const [duplicate] = await db.select({ id: messages.id }).from(messages).where(eq(messages.inboundDedupeKey, inboundDedupeKey)).limit(1);
	if (duplicate) return;
	const messageId = newId("msg");
	const snippet = buildSnippet(parsed.text, parsed.html);
	const deliveredAddress = getEmailAddress(payload.to) || `${mailbox.localPart}@${mailbox.hostname}`;
	// Keep the whole To header so reply-all can address everyone; rules and
	// webhooks still see the envelope recipient the message was delivered to.
	const toAddr = parsed.toAddr ?? payload.to;
	const fromAddr = parsed.fromAddr ?? payload.from;
	const destination = await resolveInboxRuleDestination(db, {
		mailboxId: mailbox.mailboxId,
		toAddress: payload.to,
		fromAddress: fromAddr,
		subject: parsed.subject,
		content: [parsed.text, parsed.html, snippet].filter(Boolean).join(" "),
	});
	let spamAnalysis: Awaited<ReturnType<typeof analyzeSpam>> | null = null;
	let spamAnalysisError: string | null = null;
	const [owner] = await db.select({ enabled: users.spamProtectionEnabled }).from(users).where(eq(users.id, mailbox.userId)).limit(1);
	if (owner?.enabled !== false) {
		try {
			spamAnalysis = await analyzeSpam(db, {
				mailboxId: mailbox.mailboxId,
				userId: mailbox.userId,
				envelopeFrom: payload.from,
				headers: payload.headers,
				message: parsed,
			});
		} catch (error) {
			spamAnalysisError = error instanceof Error ? error.message.slice(0, 300) : "Spam analysis failed";
			console.error(`Spam analysis failed for ${messageId}`, error);
		}
	}
	if (destination.status === "spam" && spamAnalysis) {
		spamAnalysis = {
			score: 100,
			verdict: "spam",
			signals: [{ id: "mailbox_rule_spam", score: 100, reason: "A mailbox rule marked this message as spam" }],
			fingerprint: spamAnalysis?.fingerprint ?? "",
		};
	}
	const status = blocked || (destination.status === "received" && spamAnalysis?.verdict === "spam")
		? "spam"
		: destination.status;
	const folderId = status === "spam" ? null : destination.folderId;
	const contact = await upsertContactFromAddress(env, {
		userId: mailbox.userId,
		address: fromAddr,
		source: "inbound",
	});
	const threadId = await resolveThreadId(db, {
		mailboxId: mailbox.mailboxId,
		messageId: parsed.messageId,
		inReplyTo: parsed.inReplyTo,
		references: parsed.references,
	});

	try {
		const [inserted] = await db.insert(messages).values({
			id: messageId,
			userId: mailbox.userId,
			mailboxId: mailbox.mailboxId,
			folderId,
			direction: "inbound",
			providerMessageId: parsed.messageId,
			fromAddr,
			toAddr,
			ccAddr: parsed.ccAddr,
			subject: parsed.subject,
			snippet,
			textBody: parsed.text,
			htmlBody: parsed.html,
			rawR2Key: payload.rawR2Key,
			status,
			threadId,
			inReplyTo: parsed.inReplyTo,
			references: parsed.references.length ? parsed.references.join(" ") : null,
			spamScore: spamAnalysis?.score ?? null,
			spamVerdict: spamAnalysis?.verdict ?? null,
			spamSignals: spamAnalysis ? JSON.stringify(spamAnalysis.signals) : null,
			spamAnalyzedAt: spamAnalysis ? new Date() : null,
			spamAnalysisError,
			inboundDedupeKey,
		}).onConflictDoNothing().returning({ id: messages.id });
		if (!inserted) return;

		await storeMessageAttachments(env, messageId, parsed.attachments, { validate: false });
		if (spamAnalysis) {
			try {
				await recordReputationObservation(env, mailbox.mailboxId, getReputationKeys(parsed, spamAnalysis.fingerprint));
			} catch (error) {
				console.error(`Spam reputation observation failed for ${messageId}`, error);
			}
			console.info(JSON.stringify({
				messageId,
				spamScore: spamAnalysis.score,
				verdict: spamAnalysis.verdict,
				signals: spamAnalysis.signals.map((signal) => signal.id),
			}));
		}
	} catch (error) {
		await db.delete(messages).where(eq(messages.id, messageId));
		throw error;
	}

	if (status === "received") {
		try {
			await sendMailboxAutoReply(env, {
				mailboxId: mailbox.mailboxId,
				userId: mailbox.userId,
				deliveredAddress,
				fromAddress: fromAddr,
				incomingMessageId: parsed.messageId,
				headers: payload.headers,
			});
		} catch (error) {
			console.error(`Auto-reply failed for mailbox ${mailbox.mailboxId}`, error);
		}
	}

	if (status !== "spam") {
		const notificationUserIds = await getMailboxNotificationUserIds(
			env,
			mailbox.mailboxId,
			mailbox.userId,
		);
		await notifyUsersOfNewMessage(env, notificationUserIds, {
			type: "new_message",
			messageId,
			mailboxId: mailbox.mailboxId,
			from: fromAddr,
			fromName: contact?.displayName ?? null,
			subject: parsed.subject,
		});
	}
	await dispatchWebhooks(env, mailbox.userId, "message.inbound", {
		messageId,
		from: fromAddr,
		to: payload.to,
		cc: parsed.ccAddr ?? undefined,
		subject: parsed.subject,
		threadId,
		spamScore: spamAnalysis?.score,
		spamVerdict: spamAnalysis?.verdict,
	});
	try {
		await scheduleAutoDraft(env, { mailboxId: mailbox.mailboxId, sourceMessageId: messageId, ownerUserId: mailbox.userId, sender: fromAddr, headers: payload.headers, status, folderId, spamVerdict: spamAnalysis?.verdict, spamAnalysisError });
	} catch (error) { console.error("Auto-draft scheduling failed", error); }
}

/** One stored copy per mailbox and Message-ID; mail without a Message-ID is keyed by its raw object. */
function getInboundDedupeKey(mailboxId: string, messageId: string | null | undefined, rawR2Key: string): string {
	const id = normalizeMessageId(messageId);
	return id ? `${mailboxId}:id:${id}` : `${mailboxId}:raw:${rawR2Key}`;
}

export async function getMessageWithBody(env: CloudflareEnv, userId: string, messageId: string) {
	const db = getDb(env);
	const [message] = await db
		.select()
		.from(messages)
		.where(eq(messages.id, messageId))
		.limit(1);
	if (!message || message.userId !== userId) return null;
	const contactNames = await getMessageContactNames(env, userId, message.fromAddr, message.toAddr);
	const attachments = await listMessageAttachments(env, messageId);
	const unsubscribeUrl = await getUnsubscribeUrlFromRawR2Key(env, message.rawR2Key);
	return { message: { ...message, ...contactNames }, body: message, attachments, unsubscribeUrl };
}

export async function getMessageWithBodyForUser(env: CloudflareEnv, user: SessionUser, messageId: string) {
	const db = getDb(env);
	const [message] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
	if (!message?.mailboxId) return null;
	const access = await getMailboxAccessLevel(db, user, message.mailboxId);
	if (!access?.canRead) return null;
	const contactNames = await getMessageContactNames(env, message.userId, message.fromAddr, message.toAddr);
	const attachments = await listMessageAttachments(env, messageId);
	const unsubscribeUrl = await getUnsubscribeUrlFromRawR2Key(env, message.rawR2Key);
	return { message: { ...message, ...contactNames }, body: message, attachments, unsubscribeUrl };
}

export async function getMessageMetadataForUser(env: CloudflareEnv, user: SessionUser, messageId: string) {
	const db = getDb(env);
	const [message] = await db
		.select({ mailboxId: messages.mailboxId, rawR2Key: messages.rawR2Key })
		.from(messages)
		.where(eq(messages.id, messageId))
		.limit(1);
	if (!message?.mailboxId) return null;
	const access = await getMailboxAccessLevel(db, user, message.mailboxId);
	if (!access?.canRead) return null;
	const [attachments, unsubscribeUrl] = await Promise.all([
		listMessageAttachments(env, messageId),
		getUnsubscribeUrlFromRawR2Key(env, message.rawR2Key),
	]);
	return { attachments, unsubscribeUrl };
}
