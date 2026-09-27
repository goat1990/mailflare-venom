import { eq } from "drizzle-orm";
import QRCode from "qrcode";
import { getDb } from "@/db";
import { mfaRecoveryCodes, users } from "@/db/schema";
import { getBranding } from "@/lib/branding/service";
import { consumeRecoveryCode, countUnusedRecoveryCodes, issueRecoveryCodes } from "@/lib/auth/recovery-codes";
import { deleteUserSessions } from "@/lib/auth/session";
import { buildOtpauthUrl, generateTotpSecret, matchTotp, packStoredTotpSecret, splitStoredTotpSecret, totpCounterAllowed } from "@/lib/auth/totp";
import type { MfaEnrollment, MfaStatus } from "@/lib/auth/mfa-types";

export async function getMfaStatus(env: CloudflareEnv, user: { id: string; totpEnabled: boolean; totpConfirmedAt: Date | null }): Promise<MfaStatus> {
	return {
		enabled: user.totpEnabled,
		confirmedAt: user.totpConfirmedAt?.toISOString() ?? null,
		recoveryCodesLeft: user.totpEnabled ? await countUnusedRecoveryCodes(env, user.id) : 0,
	};
}

/**
 * Start enrolment: a fresh secret is stored but not yet trusted. It only
 * becomes the account's second factor once `confirmMfaEnrollment` sees a
 * code generated from it, which proves the authenticator has it.
 */
export async function beginMfaEnrollment(env: CloudflareEnv, user: { id: string; email: string }): Promise<MfaEnrollment> {
	const db = getDb(env);
	const secret = generateTotpSecret();
	await db.update(users).set({ totpSecret: secret, totpEnabled: false, totpConfirmedAt: null }).where(eq(users.id, user.id));
	const { appName } = await getBranding(env);
	const otpauthUrl = buildOtpauthUrl({ issuer: appName, account: user.email, secret });
	const qrSvg = await QRCode.toString(otpauthUrl, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
	return { secret, otpauthUrl, qrSvg };
}

export async function confirmMfaEnrollment(
	env: CloudflareEnv,
	user: { id: string; totpSecret: string | null; totpEnabled: boolean },
	code: string,
	currentSessionToken?: string,
): Promise<{ ok: true; recoveryCodes: string[] } | { ok: false; error: string }> {
	if (!user.totpSecret) return { ok: false, error: "Start enrolment first" };
	if (user.totpEnabled) return { ok: false, error: "Two-factor authentication is already on" };
	const stored = splitStoredTotpSecret(user.totpSecret);
	const matched = await matchTotp(stored.secret, code);
	if (matched === null || !totpCounterAllowed(stored.lastCounter, matched)) {
		return { ok: false, error: "That code did not match. Check the time on your device and try again." };
	}

	const db = getDb(env);
	await db.update(users).set({ totpSecret: packStoredTotpSecret(stored.secret, matched), totpEnabled: true, totpConfirmedAt: new Date() }).where(eq(users.id, user.id));
	const recoveryCodes = await issueRecoveryCodes(env, user.id);
	// Other sessions predate the second factor; make them sign in again with it.
	await deleteUserSessions(env, user.id, currentSessionToken);
	return { ok: true, recoveryCodes };
}

export async function disableMfa(env: CloudflareEnv, userId: string): Promise<void> {
	const db = getDb(env);
	await db.update(users).set({ totpSecret: null, totpEnabled: false, totpConfirmedAt: null }).where(eq(users.id, userId));
	await db.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, userId));
}

/** A login's second step: a TOTP code, or one of the recovery codes as a fallback. */
export async function verifySecondFactor(
	env: CloudflareEnv,
	user: { id: string; totpSecret: string | null; totpEnabled: boolean },
	code: string,
): Promise<"totp" | "recovery" | null> {
	if (!user.totpEnabled || !user.totpSecret) return null;
	const stored = splitStoredTotpSecret(user.totpSecret);
	const matched = await matchTotp(stored.secret, code);
	if (matched !== null) {
		if (!totpCounterAllowed(stored.lastCounter, matched)) return null;
		await getDb(env).update(users).set({ totpSecret: packStoredTotpSecret(stored.secret, matched) }).where(eq(users.id, user.id));
		return "totp";
	}
	if (await consumeRecoveryCode(env, user.id, code)) return "recovery";
	return null;
}
