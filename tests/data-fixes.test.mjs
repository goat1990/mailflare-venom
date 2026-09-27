import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "mailflare-data-fixes-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `
			export { redactBackupRows, isPartialBackup } from "./src/lib/backups/utils.ts";
			export { BACKUP_TABLES, restoreDatabaseRecords } from "./src/lib/backups/export.ts";
			export { parseSearchQuery, buildFtsMatch } from "./src/lib/search/query-utils.ts";
			export { buildSearchConditions } from "./src/lib/search/conditions.ts";
		`,
		resolveDir: root,
		sourcefile: "data-fixes-entry.js",
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
	redactBackupRows,
	isPartialBackup,
	BACKUP_TABLES,
	restoreDatabaseRecords,
	parseSearchQuery,
	buildFtsMatch,
	buildSearchConditions,
} = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

function encodeBackup(document) {
	const bytes = new TextEncoder().encode(JSON.stringify(document));
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function createFakeDb() {
	const batches = [];
	return {
		batches,
		prepare(sql) {
			const statement = {
				sql,
				bind() {
					return statement;
				},
			};
			return statement;
		},
		async batch(statements) {
			batches.push(statements.map((statement) => statement.sql));
			return statements.map(() => ({ results: [], success: true, meta: {} }));
		},
	};
}

test("backup redaction drops secrets and message bodies unless bodies are requested", () => {
	const users = redactBackupRows("users", [
		{
			id: "usr_1",
			email: "a@b.c",
			password_hash: "s3cret-hash",
			totp_secret: "JBSWY3DPEHPK3PXP",
			name: "A",
		},
	]);
	assert.equal(users[0].password_hash, "redacted");
	assert.equal("totp_secret" in users[0], false);
	assert.equal(users[0].email, "a@b.c");
	assert.equal(JSON.stringify(users).includes("s3cret-hash"), false);
	assert.equal(JSON.stringify(users).includes("JBSWY3DPEHPK3PXP"), false);

	const hooks = redactBackupRows("webhooks", [{ id: "wh_1", url: "https://example.test/hook", secret: "whsec_live" }]);
	assert.equal(hooks[0].secret, "redacted");
	assert.equal(JSON.stringify(hooks).includes("whsec_live"), false);

	const settings = redactBackupRows("app_settings", [{ id: "default", app_name: "Mailflare", agent_api_key: "sk-live" }]);
	assert.equal("agent_api_key" in settings[0], false);
	assert.equal(JSON.stringify(settings).includes("sk-live"), false);

	const hidden = redactBackupRows("messages", [
		{ id: "msg_1", subject: "Hello", text_body: "secret body", html_body: "<p>secret body</p>" },
	]);
	assert.equal("text_body" in hidden[0], false);
	assert.equal("html_body" in hidden[0], false);
	assert.equal(hidden[0].subject, "Hello");
	assert.equal(JSON.stringify(hidden).includes("secret body"), false);

	const shown = redactBackupRows(
		"messages",
		[{ id: "msg_1", subject: "Hello", text_body: "secret body", html_body: "<p>secret body</p>" }],
		true,
	);
	assert.equal(shown[0].text_body, "secret body");
	assert.equal(shown[0].html_body, "<p>secret body</p>");
});

test("an incomplete backup is marked partial and restore does not delete live tables", async () => {
	assert.equal(isPartialBackup({ complete: false, includedTables: ["users"] }, ["users", "messages"]), true);
	const db = createFakeDb();
	await restoreDatabaseRecords(
		db,
		encodeBackup({
			format: "mailflare-database-backup",
			version: 1,
			createdAt: "2026-09-27T00:00:00.000Z",
			complete: false,
			includedTables: ["users"],
			tables: { users: [{ id: "usr_1", email: "a@b.c", name: "A" }] },
		}),
	);
	assert.equal(db.batches.length, 1);
	const sql = db.batches[0].join("\n");
	assert.equal(sql.includes("DELETE FROM"), false);
	assert.match(sql, /INSERT INTO users/);
	assert.match(sql, /ON CONFLICT/);
	assert.equal(sql.includes("messages"), false);
});

test("a complete restore deletes and inserts inside one batch", async () => {
	const tables = {};
	for (const table of BACKUP_TABLES) tables[table] = [];
	tables.users = [{ id: "usr_1", email: "a@b.c", name: "A" }];
	const db = createFakeDb();
	await restoreDatabaseRecords(
		db,
		encodeBackup({
			format: "mailflare-database-backup",
			version: 1,
			createdAt: "2026-09-27T00:00:00.000Z",
			complete: true,
			includedTables: [...BACKUP_TABLES],
			tables,
		}),
	);
	assert.equal(db.batches.length, 1);
	assert.match(db.batches[0][0], /^DELETE FROM /);
	assert.match(db.batches[0].at(-1), /^INSERT INTO users /);
});

test("a search that only excludes does not use an empty match-all", () => {
	const parsed = parseSearchQuery("-newsletter");
	assert.equal(parsed.error, undefined);
	const match = buildFtsMatch(parsed);
	assert.ok(match);
	assert.equal(match.mode, "exclude");
	assert.match(match.expression, /newsletter/);
	assert.doesNotMatch(match.expression, /""\*/);
});

test("an unknown operator is an error instead of matching the whole mailbox", () => {
	assert.match(parseSearchQuery("folder:inbox").error ?? "", /folder/);
	assert.match(parseSearchQuery("is:archived").error ?? "", /is/);
	assert.match(parseSearchQuery("has:folder").error ?? "", /has/);
	assert.equal(parseSearchQuery("is:unread").error, undefined);
	assert.equal(parseSearchQuery("from:maya@acme.test invoice").error, undefined);
	assert.equal(parseSearchQuery("https://example.test/path").error, undefined);
	assert.throws(() => buildSearchConditions("folder:inbox"), /folder/);
	assert.throws(() => buildSearchConditions("is:archived"), /is/);
});
