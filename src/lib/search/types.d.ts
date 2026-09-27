export type ParsedSearchQuery = {
	/** Free text after operators are removed; matched against every indexed column. */
	text: string;
	from?: string;
	to?: string;
	subject?: string;
	hasAttachment?: boolean;
	read?: "read" | "unread";
	starred?: boolean;
	/** Inclusive lower bound on the message date, from `after:YYYY-MM-DD`. */
	after?: Date;
	/** Exclusive upper bound on the message date, from `before:YYYY-MM-DD`. */
	before?: Date;
	/** True when anything in the query needs the full-text index. */
	needsFullText: boolean;
	/**
	 * Set when the query uses an operator this grammar does not understand.
	 * Callers must fail the search. Ignoring it matches the whole mailbox.
	 */
	error?: string;
};

/** `exclude` is a NOT-only query. FTS5 has no unary NOT, so it must not be a MATCH expression. */
export type FtsMatch = { mode: "match" | "exclude"; expression: string };

export type SearchToken = { term: string; negate: boolean; phrase: boolean };
