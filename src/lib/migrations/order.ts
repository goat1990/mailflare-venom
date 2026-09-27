/**
 * Journal order, then any SQL file the journal does not list, by filename.
 * The worker bundle and the node migrator both call this so a hand-written
 * file cannot land in a different position on each runtime.
 */
export function orderMigrationNames(fileNames: readonly string[], journalTags: readonly string[]): string[] {
	const files = new Set(fileNames);
	const journalNames = journalTags.map((tag) => (tag.endsWith(".sql") ? tag : `${tag}.sql`));
	const listed = journalNames.filter((name) => files.has(name));
	const listedSet = new Set(journalNames);
	const rest = fileNames.filter((name) => name.endsWith(".sql") && !listedSet.has(name)).sort();
	return [...listed, ...rest];
}
