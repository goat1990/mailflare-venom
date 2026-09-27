import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { requireUser } from "@/lib/auth/cookies";
import { sendEmailSchema } from "@/lib/validators";
import { sendEmail } from "@/lib/email/send";
import { parseSendRequest } from "./utils";
import { RequestBodyTooLargeError } from "@/lib/http/errors";
import { getSendErrorStatus } from "./error-utils";
import { getDb } from "@/db";
import { agentDraftMetadata, messages } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { loadMessageAttachmentContents } from "@/lib/email/attachments";
import { deleteMessageWithObjects } from "@/lib/email/message-cleanup";
import { userOwnsDraft } from "@/app/api/drafts/utils";

export async function POST(request: Request) {
	const env = getEnv();
	const user = await requireUser(env, request);
	let input;
	try {
		input = await parseSendRequest(request);
	} catch (error) {
		const status = error instanceof RequestBodyTooLargeError ? 413 : 400;
		return NextResponse.json({ error: "Invalid send request" }, { status });
	}
	const { attachments = [], draftId, ...fields } = input;
	const parsed = sendEmailSchema.omit({ attachments: true }).safeParse(fields);
	if (!parsed.success) {
		return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
	}

	const db = getDb(env);
	let draft: typeof messages.$inferSelect | undefined;
	if (draftId) {
		[draft] = await db.select().from(messages).where(eq(messages.id, draftId)).limit(1);
		if (!userOwnsDraft(draft, user.id)) {
			return NextResponse.json({ error: "Draft not found" }, { status: 404 });
		}
		const [agent] = await db.select({ draftId: agentDraftMetadata.draftId }).from(agentDraftMetadata).where(eq(agentDraftMetadata.draftId, draftId)).limit(1);
		if (agent) return NextResponse.json({ error: "Review and confirm this AI draft before sending" }, { status: 409 });
		// Claimed so a second request for the same draft, a double click or a retry, sends nothing.
		const [claimed] = await db
			.update(messages)
			.set({ status: "sending" })
			.where(and(eq(messages.id, draftId), eq(messages.status, "draft")))
			.returning({ id: messages.id });
		if (!claimed) return NextResponse.json({ error: "This draft is already being sent" }, { status: 409 });
	}

	let result: Awaited<ReturnType<typeof sendEmail>>;
	try {
		// Files already stored on the draft (a forwarded message's attachments) ride
		// along with whatever the composer uploaded in this request.
		if (draftId) attachments.push(...(await loadMessageAttachmentContents(env, draftId)));
		result = await sendEmail(env, {
			userId: user.id,
			...parsed.data,
			attachments,
		});
	} catch (err) {
		if (draftId) await db.update(messages).set({ status: "draft" }).where(eq(messages.id, draftId));
		const message = err instanceof Error ? err.message : "Send failed";
		return NextResponse.json({ error: message }, { status: getSendErrorStatus(message) });
	}

	if (draftId) {
		await deleteMessageWithObjects(env, db, draftId, draft?.rawR2Key ?? null).catch((error) => {
			console.error(`Removing sent draft ${draftId} failed`, error);
		});
	}
	return NextResponse.json(result);
}
