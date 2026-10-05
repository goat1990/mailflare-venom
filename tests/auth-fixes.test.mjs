import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "mailflare-auth-fixes-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `
			export { jmapMailboxScope, resolveMessageListScope } from "./src/lib/jmap/message-scope.ts";
			export { revokedCredentialKinds, profileChangeNeedsCurrentPassword } from "./src/lib/auth/password-reset-utils.ts";
			export { matchTotp, totp, totpCounter, totpCounterAllowed, verifyTotp } from "./src/lib/auth/totp.ts";
			export { loginAllowedAfterLimiterError } from "./src/lib/auth/rate-limit.ts";
			export { forwardingDestinationForMailbox } from "./src/lib/email/account-forwarding.ts";
			export { updateForwardingEmail } from "./src/components/settings/utils.ts";
			export { filterToSql } from "./src/lib/jmap/email-query.ts";
		`,
		resolveDir: root,
		sourcefile: "auth-fixes-entry.js",
	},
	outfile: join(outDir, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	logLevel: "silent",
});

const {
	jmapMailboxScope,
	resolveMessageListScope,
	revokedCredentialKinds,
	profileChangeNeedsCurrentPassword,
	matchTotp,
	totp,
	totpCounter,
	totpCounterAllowed,
	verifyTotp,
	loginAllowedAfterLimiterError,
	forwardingDestinationForMailbox,
	updateForwardingEmail,
	filterToSql,
} = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

test("no accessible mailboxes is an empty list, not a user id fallback", () => {
	assert.equal(jmapMailboxScope([]), "empty");
	assert.equal(jmapMailboxScope(["mbx1"]), "ids");
	assert.deepEqual(resolveMessageListScope({ accessibleMailboxIds: [] }), { kind: "empty" });
	assert.deepEqual(resolveMessageListScope({ mailboxId: null, accessibleMailboxIds: [] }), { kind: "empty" });
	assert.deepEqual(resolveMessageListScope({ accessibleMailboxIds: ["mbx1"] }), {
		kind: "mailboxes",
		mailboxIds: ["mbx1"],
	});
	assert.deepEqual(resolveMessageListScope({ mailboxId: "mbx9", accessibleMailboxIds: [] }), {
		kind: "mailbox",
		mailboxId: "mbx9",
	});
});

test("a password reset revokes other reset links, login challenges, and API keys", () => {
	const kinds = revokedCredentialKinds();
	assert.ok(kinds.includes("sessions"));
	assert.ok(kinds.includes("passwordResetTokens"));
	assert.ok(kinds.includes("loginChallenges"));
	assert.ok(kinds.includes("apiKeys"));
});

test("changing the recovery or forwarding address requires the current password", () => {
	const current = { resetEmail: "old@example.com", forwardingEmail: null };
	assert.equal(profileChangeNeedsCurrentPassword(current, { resetEmail: "old@example.com" }), false);
	assert.equal(profileChangeNeedsCurrentPassword(current, { resetEmail: "new@example.com" }), true);
	assert.equal(
		profileChangeNeedsCurrentPassword(current, { resetEmail: "old@example.com", forwardingEmail: "copy@example.com" }),
		true,
	);
});

test("the forwarding request sends the current password the route requires", async (t) => {
	let body;
	t.mock.method(globalThis, "fetch", async (_url, init) => {
		body = JSON.parse(init.body);
		return Response.json({ forwardingEmail: body.forwardingEmail });
	});
	assert.equal(await updateForwardingEmail("copy@example.com", "secret-pass"), "copy@example.com");
	assert.deepEqual(body, { forwardingEmail: "copy@example.com", currentPassword: "secret-pass" });
});

test("a TOTP code cannot be reused inside the acceptance window", async () => {
	const at = Date.UTC(2026, 0, 15, 12, 0, 0);
	const secret = "JBSWY3DPEHPK3PXP";
	const code = await totp(secret, at);
	const step = totpCounter(at);
	assert.equal(await verifyTotp(secret, code, at, null), true);
	assert.equal(await matchTotp(secret, code, at), step);
	assert.equal(totpCounterAllowed(step, step), false);
	assert.equal(await verifyTotp(secret, code, at, step), false);
	const previous = await totp(secret, at - 30_000);
	assert.equal(await verifyTotp(secret, previous, at, step), false);
	const next = await totp(secret, at + 30_000);
	assert.equal(totpCounterAllowed(step, totpCounter(at + 30_000)), true);
	assert.equal(await verifyTotp(secret, next, at + 30_000, step), true);
});

test("a login rate limiter error fails closed", () => {
	assert.equal(loginAllowedAfterLimiterError(), false);
});

test("forwarding is the mailbox owner's address, not another account's", () => {
	assert.equal(
		forwardingDestinationForMailbox({
			mailboxOwnerUserId: "owner",
			forwardingUserId: "owner",
			forwardingEmail: "copy@example.com",
			recipient: "owner@example.com",
		}),
		"copy@example.com",
	);
	assert.equal(
		forwardingDestinationForMailbox({
			mailboxOwnerUserId: "owner",
			forwardingUserId: "admin",
			forwardingEmail: "admin@example.com",
			recipient: "owner@example.com",
		}),
		null,
	);
});

test("an unsupported JMAP filter errors instead of matching every message", () => {
	assert.throws(() => filterToSql({ notARealFilter: true }, new Set(["mbx1"])), (error) => error.type === "unsupportedFilter");
	assert.throws(() => filterToSql({}, new Set(["mbx1"])), (error) => error.type === "unsupportedFilter");
	assert.throws(
		() => filterToSql({ operator: "AND", conditions: [{ subject: "hello" }, { notARealFilter: true }] }, new Set(["mbx1"])),
		(error) => error.type === "unsupportedFilter",
	);
});
