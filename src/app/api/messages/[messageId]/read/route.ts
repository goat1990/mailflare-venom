import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { messages } from "@/db/schema";
import { getEnv } from "@/lib/cloudflare";
import { getCurrentUser } from "@/lib/auth/cookies";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { markMessageAsReadForUser } from "@/lib/user";

export async function POST(
	request: Request,
	{ params }: { params: Promise<{ messageId: string }> },
) {
	const { messageId } = await params;
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	const db = getDb(env);
	const [message] = await db.select({ mailboxId: messages.mailboxId }).from(messages).where(eq(messages.id, messageId)).limit(1);
	if (!message?.mailboxId) return NextResponse.json({ error: "Message not found" }, { status: 404 });
	const access = await getMailboxAccessLevel(db, user, message.mailboxId);
	if (!access?.canSendOnBehalf) return NextResponse.json({ error: "Message not found" }, { status: 404 });

	const success = await markMessageAsReadForUser(env, user, messageId);
	if (!success) {
		return NextResponse.json({ error: "Message not found" }, { status: 404 });
	}

	return NextResponse.json({ success: true });
}
