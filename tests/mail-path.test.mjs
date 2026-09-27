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
// worker.ts wraps the OpenNext build and exports the Durable Object; neither exists outside Workers.
const workerStubs = {
	name: "worker-stubs",
	setup(build) {
		build.onResolve({ filter: /\.open-next\/worker\.js$|^cloudflare:workers$/ }, (args) => ({ path: args.path, namespace: "stub" }));
		build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "export default { fetch() {} }; export class DurableObject {}" }));
	},
};
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { FileBucket } from "./server/runtime/file-bucket.ts";
			export { InProcessQueue, QueueJournal } from "./server/runtime/queue.ts";
			export { Mailer } from "./server/runtime/mailer.ts";
			export { intakeIncomingMail } from "./src/lib/email/intake.ts";
			export { processInboundMessage } from "./src/lib/email/inbound.ts";
			export { recordRuleMatch, resolveInboundAddress } from "./src/lib/email/routing.ts";
			export { resolveThreadId } from "./src/lib/email/threading.ts";
			export { processOutboundQueue } from "./src/lib/email/send.ts";
			export { loadMessageAttachmentContents } from "./src/lib/email/attachments.ts";
			export { getBlockedWebhookTarget, processWebhookRetry, runDelivery } from "./src/lib/email/webhooks.ts";
			export { removeDomainForUser } from "./src/lib/domains/service.ts";
			export { createEmailRoutingRuleToWorker } from "./src/lib/cloudflare-api.ts";
			export { getDb } from "./src/db/index.ts";
			export { default as relay } from "./deploy/cloudflare-email-relay/src/index.ts";
			export { default as worker } from "./worker.ts";
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
	plugins: [workerStubs],
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

function mockFetch(t, handler) {
	const original = globalThis.fetch;
	const calls = [];
	globalThis.fetch = async (input, init) => {
		const request = new Request(input, init);
		calls.push({ url: request.url, method: request.method, headers: Object.fromEntries(request.headers), body: await request.text() });
		return handler(calls.at(-1));
	};
	t.after(() => { globalThis.fetch = original; });
	return calls;
}

function liveMessage(overrides = {}) {
	const raw = rawMessage({ to: "owner@example.com" });
	const calls = { rejected: [], forwarded: [] };
	return {
		calls,
		message: {
			from: "sender@example.net",
			to: "owner@example.com",
			raw: new Response(raw).body,
			headers: new Headers({ "message-id": "<note-1@example.net>" }),
			setReject: (reason) => { calls.rejected.push(reason); },
			forward: async (to, headers) => { calls.forwarded.push({ to, loop: headers?.get("X-Mailflare-Forwarded") ?? null }); },
			...overrides,
		},
	};
}

test("a message delivered twice under different raw keys is stored once", async (t) => {
	const { env, database, queued } = await openMailflare(t);
	const input = { from: "sender@example.net", to: "owner@example.com", raw: rawMessage({ to: "owner@example.com" }), headers: {} };
	await mail.intakeIncomingMail(env, input, {});
	await mail.intakeIncomingMail(env, input, {});
	assert.equal(queued[0].rawR2Key, queued[1].rawR2Key, "a retried delivery rewrites the same raw object");
	await env.BUCKET.put("inbound/other-door.eml", input.raw);
	await mail.processInboundMessage(env, queued[0]);
	await mail.processInboundMessage(env, queued[1]);
	await mail.processInboundMessage(env, { ...queued[1], rawR2Key: "inbound/other-door.eml" });
	assert.equal(database.db.prepare("SELECT count(*) AS count FROM messages WHERE provider_message_id = '<note-1@example.net>'").get().count, 1);
});

test("the Worker throws on a failed store instead of bouncing the message", async (t) => {
	const { env } = await openMailflare(t);
	env.BUCKET.put = async () => { throw new Error("R2 unavailable"); };
	const { message, calls } = liveMessage();
	await assert.rejects(mail.worker.email(message, env), /R2 unavailable/);
	assert.deepEqual(calls.rejected, []);
});

test("the relay forwards every destination and keeps a copy when a forward fails", async (t) => {
	const env = { MAILFLARE_URL: "https://mail.example.com", INBOUND_WEBHOOK_SECRET: "secret" };
	const calls = mockFetch(t, ({ headers }) => Response.json(headers["x-mailflare-keep-copy"] === "1"
		? { action: "store", rawR2Key: "inbound/kept.eml", forwards: [] }
		: { action: "store", forwards: [{ to: "one@example.org", headers: { "X-Mailflare-Forwarded": "1" } }, { to: "two@example.org", headers: { "X-Mailflare-Forwarded": "1" } }] }));
	const both = liveMessage();
	await mail.relay.email(both.message, env);
	assert.deepEqual(both.calls.forwarded, [{ to: "one@example.org", loop: "1" }, { to: "two@example.org", loop: "1" }]);
	assert.equal(calls.length, 1, "a stored message needs no second request");

	calls.length = 0;
	const onlyForward = { action: "forward", forwardedTo: "one@example.org", forwards: [{ to: "one@example.org", headers: {} }] };
	mockFetch(t, ({ headers }) => Response.json(headers["x-mailflare-keep-copy"] === "1" ? { action: "store", forwards: [] } : onlyForward));
	const failing = liveMessage({ forward: async () => { throw new Error("destination not verified"); } });
	await mail.relay.email(failing.message, env);

	mockFetch(t, () => Response.json(onlyForward));
	const lost = liveMessage({ forward: async () => { throw new Error("destination not verified"); } });
	await assert.rejects(mail.relay.email(lost.message, env), /did not keep/);
});

test("the relay throws instead of rejecting when Mailflare is unreachable", async (t) => {
	mockFetch(t, () => new Response("down", { status: 503 }));
	const { message, calls } = liveMessage();
	await assert.rejects(mail.relay.email(message, { MAILFLARE_URL: "https://mail.example.com", INBOUND_WEBHOOK_SECRET: "secret" }), /503/);
	assert.deepEqual(calls.rejected, []);
});

test("SMTP forwarding carries the loop guard header", async () => {
	const mailer = new mail.Mailer({ kind: "smtp", url: "smtp://127.0.0.1:2525" });
	const sent = [];
	mailer.transporter = { sendMail: async (options) => { sent.push(options); } };
	assert.equal(await mailer.sendRaw("sender@example.net", "elsewhere@example.org", Buffer.from("Subject: Hi\r\n\r\nBody"), { "X-Mailflare-Forwarded": "1" }), true);
	assert.equal(sent[0].raw.toString(), "X-Mailflare-Forwarded: 1\r\nSubject: Hi\r\n\r\nBody");
});

test("Node queue jobs survive a restart and a second process cannot take the journal", async (t) => {
	const directory = mkdtempSync(join(tmpdir(), "mailflare-queue-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const file = join(directory, "queue.sqlite");
	const first = new mail.QueueJournal(file);
	const before = new mail.InProcessQueue("mailflare-inbound", first);
	await before.send({ rawR2Key: "inbound/a.eml", from: "a@example.net", to: "b@example.com" });
	assert.throws(() => new mail.QueueJournal(file), /single process/);
	before.stop();
	first.close();

	const second = new mail.QueueJournal(file);
	t.after(() => second.close());
	const after = new mail.InProcessQueue("mailflare-inbound", second);
	const delivered = await new Promise((resolve) => after.setConsumer(async (body) => resolve(body)));
	assert.deepEqual(delivered, { rawR2Key: "inbound/a.eml", from: "a@example.net", to: "b@example.com" });
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.deepEqual(await after.metrics(), { backlogCount: 0 });
	after.stop();
});

test("the D1 shim reports changes for a write that returns rows", async (t) => {
	const { database } = await openMailflare(t);
	const result = await database.prepare("UPDATE mailboxes SET display_name = ? WHERE id = ? RETURNING id").bind("Owner", "mailbox-owner").run();
	assert.deepEqual(result.results, [{ id: "mailbox-owner" }]);
	assert.equal(result.meta.changes, 1);
});

test("concurrent rule matches are all counted", async (t) => {
	const { env, database } = await openMailflare(t);
	database.db.exec(`INSERT INTO routing_rules (id, user_id, domain_id, scope, pattern, action, created_at) VALUES ('rule-1', 'user-1', 'domain-1', 'domain', '*', 'store', 1);`);
	const db = mail.getDb(env);
	await Promise.all([mail.recordRuleMatch(db, "rule-1"), mail.recordRuleMatch(db, "rule-1")]);
	assert.equal(database.db.prepare("SELECT match_count AS count FROM routing_rules WHERE id = 'rule-1'").get().count, 2);
});

test("a reply joins its direct parent's thread, and a parent without a thread joins it", async (t) => {
	const { env, database } = await openMailflare(t);
	database.db.exec(`
		INSERT INTO messages (id, user_id, mailbox_id, direction, provider_message_id, from_addr, to_addr, status, thread_id, created_at)
		VALUES ('old', 'user-1', 'mailbox-owner', 'inbound', '<old@example.net>', 'a@example.net', 'owner@example.com', 'received', 'thread-a', 1),
			('parent', 'user-1', 'mailbox-owner', 'inbound', '<parent@example.net>', 'a@example.net', 'owner@example.com', 'received', 'thread-b', 2),
			('loose', 'user-1', 'mailbox-owner', 'inbound', '<loose@example.net>', 'a@example.net', 'owner@example.com', 'received', NULL, 3);
	`);
	const db = mail.getDb(env);
	assert.equal(await mail.resolveThreadId(db, { mailboxId: "mailbox-owner", messageId: "<reply@example.net>", inReplyTo: "<parent@example.net>", references: ["old@example.net", "parent@example.net"] }), "thread-b");
	assert.equal(await mail.resolveThreadId(db, { mailboxId: "mailbox-owner", messageId: "<reply-2@example.net>", inReplyTo: "<loose@example.net>", references: [] }), "loose@example.net");
	assert.equal(database.db.prepare("SELECT thread_id AS threadId FROM messages WHERE id = 'loose'").get().threadId, "loose@example.net");
});

test("a scheduled send redelivered while it is sending goes out once", async (t) => {
	const { env, database } = await openMailflare(t);
	const payload = JSON.stringify({ userId: "user-1", from: "owner@example.com", to: ["friend@example.net"], subject: "Hi", text: "Hello", mailboxId: "mailbox-owner" });
	database.db.exec(`
		INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, status, created_at) VALUES ('out-1', 'user-1', 'mailbox-owner', 'outbound', 'owner@example.com', 'friend@example.net', 'queued', 1);
		INSERT INTO outbound_jobs (id, user_id, message_id, status, payload, created_at, updated_at) VALUES ('job-1', 'user-1', 'out-1', 'queued', '${payload}', 1, 1);
	`);
	const sends = [];
	env.EMAIL = { send: async (message) => { sends.push(message.subject); await new Promise((resolve) => setTimeout(resolve, 5)); return { messageId: "<sent-1@example.com>" }; } };
	const job = { kind: "email.scheduled", jobId: "job-1", messageId: "out-1", scheduledAt: new Date(0).toISOString() };
	await Promise.all([mail.processOutboundQueue(env, job), mail.processOutboundQueue(env, job)]);
	assert.deepEqual(sends, ["Hi"]);
	assert.equal(database.db.prepare("SELECT status FROM outbound_jobs WHERE id = 'job-1'").get().status, "sent");
});

test("a draft attachment missing from storage stops the send instead of being skipped", async (t) => {
	const { env, database } = await openMailflare(t);
	database.db.exec(`
		INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, status, created_at) VALUES ('draft-1', 'user-1', 'mailbox-owner', 'outbound', 'owner@example.com', 'friend@example.net', 'draft', 1);
		INSERT INTO message_attachments (id, message_id, filename, content_type, size, disposition, r2_key, created_at) VALUES ('att-1', 'draft-1', 'report.pdf', 'application/pdf', 3, 'attachment', 'attachments/draft-1/att-1/report.pdf', 1);
	`);
	await assert.rejects(mail.loadMessageAttachmentContents(env, "draft-1"), /report\.pdf is missing/);
});

test("each webhook attempt is sent once and private targets are refused", async (t) => {
	const { env, database } = await openMailflare(t);
	database.db.exec(`
		INSERT INTO webhooks (id, user_id, url, secret, events, created_at) VALUES ('hook-1', 'user-1', 'https://hooks.example.org/in', 's', '["message.inbound"]', 1);
		INSERT INTO webhook_deliveries (id, webhook_id, event_type, payload, status, attempts, created_at) VALUES ('whd-1', 'hook-1', 'message.inbound', '{}', 'retrying', 1, 1);
	`);
	const calls = mockFetch(t, async () => { await new Promise((resolve) => setTimeout(resolve, 5)); return new Response("ok"); });
	await Promise.all([
		mail.processWebhookRetry(env, { kind: "webhook.retry", deliveryId: "whd-1", attempts: 1 }),
		mail.runDelivery(env, "whd-1", { attempts: 1, scheduled: true }),
	]);
	await mail.processWebhookRetry(env, { kind: "webhook.retry", deliveryId: "whd-1", attempts: 1 });
	assert.equal(calls.length, 1);
	assert.deepEqual(database.db.prepare("SELECT status, attempts FROM webhook_deliveries WHERE id = 'whd-1'").get(), { status: "delivered", attempts: 2 });

	for (const url of ["http://127.0.0.1:8787/", "http://localhost/", "http://[::ffff:127.0.0.1]/", "http://169.254.169.254/latest", "http://10.0.0.5/"]) {
		assert.ok(await mail.getBlockedWebhookTarget(env, url), `${url} is refused`);
	}
	assert.ok(await mail.getBlockedWebhookTarget({ ...env, HOST_RESOLVER: async () => ["127.0.0.1"] }, "https://rebind.example.org/"));
	assert.equal(await mail.getBlockedWebhookTarget(env, "https://hooks.example.org/in"), null);
});

test("deleting a subdomain or a shared apex leaves the zone's Email Routing on", async (t) => {
	const { env, database } = await openMailflare(t);
	env.CF_TOKEN = "token";
	database.db.exec(`
		UPDATE domains SET zone_id = 'zone-1', routing_enabled = 1 WHERE id = 'domain-1';
		INSERT INTO domains (id, user_id, hostname, zone_id, status, routing_enabled, created_at) VALUES ('domain-sub', 'user-1', 'mail.example.com', 'zone-1', 'active', 1, 2);
	`);
	const calls = mockFetch(t, ({ url }) => Response.json({ success: true, errors: [], result: url.endsWith("/zones/zone-1") ? { id: "zone-1", name: "example.com" } : [] }));
	await mail.removeDomainForUser(env, "user-1", "domain-sub");
	await mail.removeDomainForUser(env, "user-1", "domain-1");
	const disables = calls.filter((call) => call.method === "DELETE" && call.url.endsWith("/email/routing/dns"));
	assert.deepEqual(disables.map((call) => call.body), ['{"name":"mail.example.com"}', ""], "the subdomain alone first, then the apex once nothing else shares the zone");

	const ruleCalls = mockFetch(t, () => Response.json({ success: true, errors: [], result: {} }));
	await mail.createEmailRoutingRuleToWorker({ ...env, CF_EMAIL_WORKER_NAME: "mailflare-email-relay" }, "zone-1", "owner@example.com");
	assert.deepEqual(JSON.parse(ruleCalls[0].body).actions, [{ type: "worker", value: ["mailflare-email-relay"] }]);
});
