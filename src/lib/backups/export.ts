import type { BackupTableGroupId, DatabaseBackupDocument, DatabaseBackupExportOptions, DatabaseBackupTable, DatabaseRecord } from "./types";
import { backupConflictColumns, isPartialBackup, mergeLegacyMessageBodies, redactBackupRows } from "./utils";
import { BACKUP_TABLE_GROUPS, getSelectedBackupTables } from "./table-groups";

export const BACKUP_TABLES: DatabaseBackupTable[] = ["users", "domains", "mailboxes", "mailbox_access", "contacts", "folders", "api_keys", "messages", "message_attachments", "outbound_jobs", "routing_rules", "webhooks", "webhook_deliveries", "sessions", "audit_logs", "backup_settings", "backups", "app_settings", "license_settings", "email_templates", "calendar_events", "auto_reply_deliveries", "spam_token_stats", "spam_reputation", "spam_feedback", "mailbox_aliases", "password_reset_tokens", "mfa_recovery_codes", "login_challenges", "mailbox_agent_settings", "agent_conversations", "agent_chat_messages", "agent_jobs", "agent_draft_metadata", "agent_send_approvals", "mcp_key_mailboxes", 'ai_usage'];
/**
 * Tables every backup document must contain. Tables added to BACKUP_TABLES
 * after the format shipped are absent from older documents, so they stay
 * optional here and are filled in as empty on restore.
 */
const REQUIRED_BACKUP_TABLES: DatabaseBackupTable[] = ["users", "domains", "mailboxes", "mailbox_access", "contacts", "folders", "api_keys", "messages", "message_attachments", "outbound_jobs", "routing_rules", "webhooks", "webhook_deliveries", "sessions", "audit_logs", "backup_settings", "backups", "app_settings", "license_settings"];

export function getBackupConfigurationStatus(_env?: CloudflareEnv) {
	return { configured: true, missing: [] };
}

/**
 * Tables D1 manages itself, which are intentionally absent from BACKUP_TABLES.
 */
const INTERNAL_TABLE_PATTERNS = ["sqlite_%", "_cf%", "messages_fts%"];
/**
 * The search index is derived data: its triggers repopulate it as messages are
 * restored, so it is neither exported nor part of the coverage check.
 */
const INTERNAL_TABLES = ["d1_migrations"];

/**
 * Fails the backup when the database contains a table BACKUP_TABLES does not
 * list. Without this, a migration that adds a table silently produces backups
 * that omit it, and the omission only surfaces during a restore.
 */
export async function assertBackupTablesCoverDatabase(db: D1Database): Promise<void> {
	const conditions = [
		...INTERNAL_TABLE_PATTERNS.map((pattern) => `name NOT LIKE '${pattern}'`),
		...INTERNAL_TABLES.map((name) => `name <> '${name}'`),
	].join(" AND ");
	const result = await db
		.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND ${conditions}`)
		.all<{ name: string }>();
	const covered = new Set<string>(BACKUP_TABLES);
	const unlisted = result.results.map((row) => row.name).filter((name) => !covered.has(name));
	if (unlisted.length) throw new Error(`Backup aborted: ${unlisted.join(", ")} not listed in BACKUP_TABLES. Add new tables to src/lib/backups/export.ts and assign each to a group in table-groups.ts.`);
	const assigned = BACKUP_TABLE_GROUPS.flatMap((group) => group.tables);
	const ungrouped = BACKUP_TABLES.filter((table) => assigned.filter((item) => item === table).length !== 1);
	const unknown = assigned.filter((table) => !covered.has(table));
	if (ungrouped.length || unknown.length) throw new Error(`Backup aborted: table groups are out of sync (${[...ungrouped, ...unknown].join(", ")}). Update src/lib/backups/table-groups.ts.`);
}

export async function exportDatabaseRecords(
	db: D1Database,
	excludedGroups: BackupTableGroupId[] = [],
	options: DatabaseBackupExportOptions = {},
): Promise<Uint8Array> {
	await assertBackupTablesCoverDatabase(db);
	const includeMessageBodies = options.includeMessageBodies === true;
	const selected = getSelectedBackupTables(excludedGroups);
	const includedTables = BACKUP_TABLES.filter((table) => selected.has(table));
	if (!includedTables.length) throw new Error("Select at least one backup table group");
	const tables: DatabaseBackupDocument["tables"] = {};
	for (const table of includedTables) {
		const result = await db.prepare(`SELECT * FROM ${table}`).all<DatabaseRecord>();
		tables[table] = redactBackupRows(table, result.results, includeMessageBodies);
	}
	const complete = excludedGroups.length === 0 && includedTables.length === BACKUP_TABLES.length;
	const document: DatabaseBackupDocument = {
		format: "mailflare-database-backup",
		version: 1,
		createdAt: new Date().toISOString(),
		includedTables,
		complete,
		tables,
	};
	return new TextEncoder().encode(JSON.stringify(document));
}

export async function restoreDatabaseRecords(db: D1Database, content: ArrayBuffer): Promise<void> {
	const document = parseDatabaseBackup(content);
	mergeLegacyMessageBodies(document);
	const partial = isPartialBackup(document, BACKUP_TABLES);
	if (partial && !document.includedTables?.length) {
		throw new Error("This backup is incomplete and does not list its tables. Restore will not delete live data.");
	}
	const tables = partial ? BACKUP_TABLES.filter((table) => document.includedTables!.includes(table)) : BACKUP_TABLES;
	if (!partial) fillMissingBackupTables(document);
	validateDatabaseBackup(document, tables);
	// One batch is one transaction. A partial export upserts only the tables it
	// contains: deleting a parent would cascade into groups that were left out.
	const statements = [
		...(partial ? [] : [...tables].reverse().map((table) => db.prepare(`DELETE FROM ${table}`))),
		...tables.flatMap((table) =>
			(document.tables[table] ?? []).map((row) =>
				partial ? createUpsertStatement(db, table, row) : createInsertStatement(db, table, row),
			),
		),
	];
	if (statements.length > 0) await db.batch(statements);
}

function parseDatabaseBackup(content: ArrayBuffer): DatabaseBackupDocument {
	let value: unknown;
	try { value = JSON.parse(new TextDecoder().decode(content)); } catch { throw new Error("The selected file is not a valid Mailflare backup"); }
	if (!isDatabaseBackupDocument(value)) throw new Error("The selected file is not a valid Mailflare backup");
	return value;
}

function isDatabaseBackupDocument(value: unknown): value is DatabaseBackupDocument {
	if (!value || typeof value !== "object") return false;
	const document = value as Partial<DatabaseBackupDocument>;
	if (document.format !== "mailflare-database-backup" || document.version !== 1 || !document.tables) return false;
	if (document.complete !== undefined && typeof document.complete !== "boolean") return false;
	if (document.includedTables) {
		if (!Array.isArray(document.includedTables) || !document.includedTables.length || new Set(document.includedTables).size !== document.includedTables.length) return false;
		if (!document.includedTables.every((table) => BACKUP_TABLES.includes(table) && Array.isArray(document.tables?.[table]))) return false;
	} else if (!REQUIRED_BACKUP_TABLES.every((table) => Array.isArray(document.tables?.[table]))) return false;
	return BACKUP_TABLES.every((table) => {
		const rows = document.tables?.[table];
		return rows === undefined || Array.isArray(rows);
	});
}

function quoteIdentifier(column: string): string {
	return `\`${column.replaceAll("`", "``")}\``;
}

function createInsertStatement(db: D1Database, table: DatabaseBackupTable, row: DatabaseRecord) {
	const columns = Object.keys(row);
	if (columns.length === 0) throw new Error(`Backup contains an invalid ${table} record`);
	const placeholders = columns.map(() => "?").join(", ");
	const identifiers = columns.map((column) => quoteIdentifier(column)).join(", ");
	return db.prepare(`INSERT INTO ${table} (${identifiers}) VALUES (${placeholders})`).bind(...columns.map((column) => row[column]));
}

function createUpsertStatement(db: D1Database, table: DatabaseBackupTable, row: DatabaseRecord) {
	const columns = Object.keys(row);
	if (columns.length === 0) throw new Error(`Backup contains an invalid ${table} record`);
	const placeholders = columns.map(() => "?").join(", ");
	const identifiers = columns.map((column) => quoteIdentifier(column)).join(", ");
	const conflict = backupConflictColumns(table).map((column) => quoteIdentifier(column)).join(", ");
	const updates = columns.map((column) => `${quoteIdentifier(column)} = excluded.${quoteIdentifier(column)}`).join(", ");
	return db.prepare(
		`INSERT INTO ${table} (${identifiers}) VALUES (${placeholders}) ON CONFLICT(${conflict}) DO UPDATE SET ${updates}`,
	).bind(...columns.map((column) => row[column]));
}

/** Backups written before a table joined BACKUP_TABLES simply omit it. */
function fillMissingBackupTables(document: DatabaseBackupDocument): void {
	for (const table of BACKUP_TABLES) {
		if (!document.tables[table]) document.tables[table] = [];
	}
}

function validateDatabaseBackup(document: DatabaseBackupDocument, tables: DatabaseBackupTable[]): void {
	for (const table of tables) {
		for (const row of document.tables[table] ?? []) {
			if (!row || typeof row !== "object" || Array.isArray(row)) {
				throw new Error(`Backup contains an invalid ${table} record`);
			}
		}
	}
}
