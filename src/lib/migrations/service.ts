import journal from "../../../drizzle/migrations/meta/_journal.json";
import bundle from "./bundle.json";
import { orderMigrationNames } from "./order";
import type { BundledMigration, MigrationNameRow, MigrationResult, MigrationStatus } from "./types";

const MIGRATION_TABLE_SQL =
	"CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)";

const bundled = bundle.migrations as BundledMigration[];
const migrations = orderMigrationNames(
	bundled.map((migration) => migration.name),
	journal.entries.map((entry) => entry.tag),
).map((name) => {
	const migration = bundled.find((candidate) => candidate.name === name);
	if (!migration) throw new Error(`Migration ${name} is missing from the bundle`);
	return migration;
});

async function getAppliedMigrationNames(db: D1Database): Promise<string[]> {
	const table = await db
		.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'd1_migrations'")
		.first<MigrationNameRow>();
	if (!table) return [];

	const result = await db.prepare("SELECT name FROM d1_migrations").all<MigrationNameRow>();
	return result.results.map((row) => row.name);
}

export async function getMigrationStatus(db: D1Database): Promise<MigrationStatus> {
	const applied = new Set(await getAppliedMigrationNames(db));
	const committed = new Set(migrations.map((migration) => migration.name));
	const pending = migrations.filter((migration) => !applied.has(migration.name)).map((migration) => migration.name);
	const unknown = [...applied].filter((name) => !committed.has(name)).sort();

	return { ready: pending.length === 0 && unknown.length === 0, pending, unknown };
}

export async function applyPendingMigrations(db: D1Database): Promise<MigrationResult> {
	const initial = await getMigrationStatus(db);
	if (initial.unknown.length > 0) {
		throw new Error("The database contains migrations that are not part of this Mailflare release.");
	}

	await db.prepare(MIGRATION_TABLE_SQL).run();
	const applied: string[] = [];

	for (const name of initial.pending) {
		const migration = migrations.find((candidate) => candidate.name === name);
		if (!migration) continue;

		try {
			await db.batch([
				db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").bind(name),
				...migration.statements.map((statement) => db.prepare(statement)),
			]);
			applied.push(name);
		} catch (error) {
			const completed = await db
				.prepare("SELECT name FROM d1_migrations WHERE name = ?")
				.bind(name)
				.first<MigrationNameRow>();
			if (completed) continue;
			throw new Error(
				`Migration ${name} failed: ${error instanceof Error ? error.message : "Database error"}`,
			);
		}
	}

	return { ...(await getMigrationStatus(db)), applied };
}
