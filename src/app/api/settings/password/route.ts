import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { requireUser } from "@/lib/auth/cookies";
import { getSessionTokenFromRequestHeaders } from "@/lib/auth/session";
import { revokeCredentialsAfterPasswordChange } from "@/lib/auth/password-reset";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { getEnv } from "@/lib/cloudflare";
import type { ChangePasswordInput } from "./types";
import { parseChangePasswordRequest } from "./utils";

export async function PATCH(request: Request) {
	const env = getEnv();
	const user = await requireUser(env, request);
	let parsed: ChangePasswordInput;

	try {
		parsed = await parseChangePasswordRequest(request);
	} catch (err) {
		if (err instanceof ZodError) {
			return NextResponse.json({ error: err.flatten() }, { status: 400 });
		}
		return NextResponse.json({ error: "Invalid request" }, { status: 400 });
	}

	if (!verifyPassword(parsed.currentPassword, user.passwordHash)) {
		return NextResponse.json({ error: "Current password is incorrect" }, { status: 400 });
	}

	if (verifyPassword(parsed.newPassword, user.passwordHash)) {
		return NextResponse.json({ error: "New password must be different from the current password" }, { status: 400 });
	}

	const db = getDb(env);
	await db
		.update(users)
		.set({ passwordHash: hashPassword(parsed.newPassword) })
		.where(eq(users.id, user.id));
	// Other sessions, reset links, login challenges, and API keys stop working. This session stays.
	await revokeCredentialsAfterPasswordChange(env, user.id, getSessionTokenFromRequestHeaders(request));

	return NextResponse.json({ ok: true });
}
