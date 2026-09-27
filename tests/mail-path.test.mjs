import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// External packages resolve from the bundle's own directory, so it lives under node_modules.
const bundleDirectory = mkdtempSync(join(root, "node_modules", "mailflare-mail-path-"));
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { FileBucket } from "./server/runtime/file-bucket.ts";
			export { intakeIncomingMail } from "./src/lib/email/intake.ts";
			export { processInboundMessage } from "./src/lib/email/inbound.ts";
			export { resolveInboundAddress } from "./src/lib/email/routing.ts";
			export { getDb } from "./src/db/index.ts";
		`,
		resolveDir: root,
		sourcefile: "mail-path-test-entry.ts",
	},
	outfile: join(bundleDirectory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	logLevel: "silent",
});
const mail = await import(pathToFileURL(join(bundleDirectory, "entry.mjs")).href);

async function openMailflare(t) {
	const directory = mkdtempSync(join(tmpdir(), "mailflare-mail-path-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const database = new mail.SqliteDatabase(join(directory, "mailflare.sqlite"));
	t.after(() => database.db.close());
	await mail.applyMigrations(database, join(root, "drizzle", "migrations"));
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('user-1', 'owner@example.com', 'hash', 'Owner', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'user-1', 'example.com', 'zone-1', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mailbox-owner', 'user-1', 'domain-1', 'owner', 1);
	`);
	const queued = [];
	const env = {
		DB: database,
		BUCKET: new mail.FileBucket(join(directory, "blobs")),
		INBOUND_QUEUE: { send: async (body) => { queued.push(body); } },
		OUTBOUND_QUEUE: { send: async () => {} },
	};
	return { env, database, queued };
}

function rawMessage({ to, messageId = "<note-1@example.net>", subject = "Hello" }) {
	return new TextEncoder().encode([
		"From: Sender <sender@example.net>",
		`To: ${to}`,
		`Subject: ${subject}`,
		`Message-ID: ${messageId}`,
		"Date: Sun, 27 Sep 2026 12:00:00 +0000",
		"Content-Type: text/plain; charset=utf-8",
		"",
		"Body text",
		"",
	].join("\r\n")).buffer;
}

function storedRows(database, rawR2Key) {
	return database.db.prepare("SELECT mailbox_id AS mailboxId, status FROM messages WHERE raw_r2_key = ?").all(rawR2Key);
}

test("a forward that fails at the edge is stored and the queue keeps it", async (t) => {
	const { env, database, queued } = await openMailflare(t);
	database.db.exec(`
		INSERT INTO routing_rules (id, user_id, domain_id, scope, pattern, match_field, match_operator, match_value, action, forward_to, keep_copy, created_at)
		VALUES ('rule-forward', 'user-1', 'domain-1', 'domain', '*', 'recipient', 'contains', '*', 'forward', 'elsewhere@example.org', 0, 1);
	`);
	const forwarded = [];
	const result = await mail.intakeIncomingMail(
		env,
		{ from: "sender@example.net", to: "sales@example.com", raw: rawMessage({ to: "sales@example.com" }), headers: {} },
		{ forward: async (destination) => { forwarded.push(destination); return false; } },
	);

	assert.deepEqual(forwarded, ["elsewhere@example.org"]);
	assert.equal(result.action, "store", "the edge keeps a message whose forward failed");
	assert.equal(queued.length, 1);
	await mail.processInboundMessage(env, queued[0]);
	assert.deepEqual(storedRows(database, queued[0].rawR2Key), [{ mailboxId: "mailbox-owner", status: "received" }]);
});

test("a recipient with no route is stored at the edge and in the queue", async (t) => {
	const { env, database, queued } = await openMailflare(t);
	assert.equal(await mail.resolveInboundAddress(mail.getDb(env), "nobody@example.com"), null);

	const result = await mail.intakeIncomingMail(
		env,
		{ from: "sender@example.net", to: "nobody@example.com", raw: rawMessage({ to: "nobody@example.com" }), headers: {} },
		{},
	);

	assert.equal(result.action, "store");
	assert.equal(queued.length, 1);
	await mail.processInboundMessage(env, queued[0]);
	assert.deepEqual(storedRows(database, queued[0].rawR2Key), [{ mailboxId: "mailbox-owner", status: "received" }]);
});

test("dotted local parts and plus tags each reach their own mailbox", async (t) => {
	const { env, database } = await openMailflare(t);
	database.db.exec(`
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mailbox-johndoe', 'user-1', 'domain-1', 'johndoe', 2);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mailbox-john-dot-doe', 'user-1', 'domain-1', 'john.doe', 3);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mailbox-sales', 'user-1', 'domain-1', 'sales', 4);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mailbox-sales-eu', 'user-1', 'domain-1', 'sales+eu', 5);
	`);
	const db = mail.getDb(env);
	const mailboxFor = async (address) => (await mail.resolveInboundAddress(db, address))?.mailbox?.mailboxId ?? null;

	assert.equal(await mailboxFor("johndoe@example.com"), "mailbox-johndoe");
	assert.equal(await mailboxFor("john.doe@example.com"), "mailbox-john-dot-doe");
	assert.equal(await mailboxFor("John.Doe@example.com"), "mailbox-john-dot-doe");
	assert.equal(await mailboxFor("john.doe+news@example.com"), "mailbox-john-dot-doe");
	assert.equal(await mailboxFor("sales+eu@example.com"), "mailbox-sales-eu");
	assert.equal(await mailboxFor("sales+us@example.com"), "mailbox-sales");
	assert.equal(await mailboxFor("j.o.h.n.doe@example.com"), "mailbox-johndoe", "a dot-insensitive guess falls to the oldest mailbox");
});
