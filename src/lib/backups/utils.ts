import type { BackupScheduleType, DatabaseBackupDocument, DatabaseBackupTable, DatabaseRecord } from "./types";

export const BACKUP_SETTINGS_ID = "default";
export const BACKUP_PREFIX = "backups/database";

export function isBackupDue(
	scheduleType: BackupScheduleType,
	scheduleValue: number | null,
	now: Date,
): boolean {
	if (scheduleType === "daily") return true;
	if (scheduleType === "weekly") return now.getUTCDay() === scheduleValue;
	return now.getUTCDate() === scheduleValue;
}

export function getUtcDayBounds(now: Date): { start: number; end: number } {
	const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
	return { start, end: start + 86_400_000 };
}

export function createBackupFilename(now: Date): string {
	return `mailflare-${now.toISOString().replace(/[:.]/g, "-")}.json`;
}

/** Moves records from the pre-0019 body table into their message records. */
export function mergeLegacyMessageBodies(document: DatabaseBackupDocument): void {
	const tables = document.tables as Record<string, DatabaseRecord[]>;
	const bodyRows = tables.message_bodies;
	if (!bodyRows) return;

	const bodiesByMessageId = new Map<string, DatabaseRecord>();
	for (const body of bodyRows) {
		if (!isDatabaseRecord(body) || typeof body.message_id !== "string") {
			throw new Error("Backup contains an invalid message_bodies record");
		}
		bodiesByMessageId.set(body.message_id, body);
	}

	for (const message of tables.messages) {
		const body = bodiesByMessageId.get(message.id as string);
		if (!body) continue;
		copyMissingBodyField(message, body, "text_body");
		copyMissingBodyField(message, body, "html_body");
		copyMissingBodyField(message, body, "raw_r2_key");
	}

	delete tables.message_bodies;
}

function copyMissingBodyField(
	message: DatabaseRecord,
	body: DatabaseRecord,
	field: "text_body" | "html_body" | "raw_r2_key",
): void {
	if (!(field in message) && field in body) message[field] = body[field];
}

function isDatabaseRecord(value: unknown): value is DatabaseRecord {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

const REDACTED = "redacted";

type SecretColumn = { column: string; nullable: boolean; unique: boolean };

/** Credential material a JSON backup must not carry. Nullable secrets are removed; NOT NULL secrets become a placeholder. */
const SECRET_COLUMNS: Record<string, SecretColumn[]> = {
	users: [
		{ column: "password_hash", nullable: false, unique: false },
		{ column: "totp_secret", nullable: true, unique: false },
	],
	webhooks: [{ column: "secret", nullable: false, unique: false }],
	app_settings: [{ column: "agent_api_key", nullable: true, unique: false }],
	api_keys: [{ column: "key_hash", nullable: false, unique: false }],
	sessions: [{ column: "token_hash", nullable: false, unique: true }],
	password_reset_tokens: [{ column: "token_hash", nullable: false, unique: true }],
	mfa_recovery_codes: [{ column: "code_hash", nullable: false, unique: true }],
	login_challenges: [{ column: "token_hash", nullable: false, unique: true }],
};

const MESSAGE_BODY_COLUMNS = ["text_body", "html_body"] as const;

const CONFLICT_COLUMNS: Partial<Record<DatabaseBackupTable, string[]>> = {
	mailbox_agent_settings: ["mailbox_id"],
	agent_draft_metadata: ["draft_id"],
	mcp_key_mailboxes: ["key_id", "mailbox_id"],
};

export function redactBackupRows(table: string, rows: DatabaseRecord[], includeMessageBodies = false): DatabaseRecord[] {
	return rows.map((row, index) => redactBackupRow(table, row, index, includeMessageBodies));
}

function redactBackupRow(table: string, row: DatabaseRecord, index: number, includeMessageBodies: boolean): DatabaseRecord {
	const next: DatabaseRecord = { ...row };
	for (const secret of SECRET_COLUMNS[table] ?? []) {
		if (!(secret.column in next)) continue;
		if (secret.nullable) {
			delete next[secret.column];
			continue;
		}
		const id = typeof next.id === "string" ? next.id : String(index);
		next[secret.column] = secret.unique ? `${REDACTED}:${id}` : REDACTED;
	}
	if (table === "messages" && !includeMessageBodies) {
		for (const column of MESSAGE_BODY_COLUMNS) delete next[column];
	}
	return next;
}

/** An export that left groups out must not be applied by deleting every live table. */
export function isPartialBackup(
	document: { complete?: boolean; includedTables?: readonly string[] },
	allTables: readonly string[],
): boolean {
	if (document.complete === false) return true;
	if (!document.includedTables) return false;
	if (document.includedTables.length !== allTables.length) return true;
	const included = new Set(document.includedTables);
	return allTables.some((table) => !included.has(table));
}

export function backupConflictColumns(table: string): string[] {
	return CONFLICT_COLUMNS[table as DatabaseBackupTable] ?? ["id"];
}
