import type { FtsMatch, ParsedSearchQuery, SearchToken } from "./types";

/**
 * Gmail-style search grammar shared by the search box and the API:
 *
 *   from:maya to:"sam okoro" subject:invoice has:attachment is:unread
 *   is:starred after:2026-09-01 before:2026-09-30 "exact phrase" -excluded word
 *
 * The older `title:` and bare `:unread` / `:read` forms keep working.
 */
const OPERATOR_RE = /(?:^|\s)(from|to|subject|title|has|is|after|before|newer|older):(?:"([^"]*)"|(\S+))/gi;

type SearchOperator = "from" | "to" | "subject" | "title" | "has" | "is" | "after" | "before" | "newer" | "older";

export function parseSearchQuery(raw: string): ParsedSearchQuery {
	const parsed: ParsedSearchQuery = { text: "", needsFullText: false };
	let rest = raw ?? "";

	rest = rest.replace(OPERATOR_RE, (_match, key: string, quoted: string | undefined, bare: string | undefined) => {
		const value = (quoted ?? bare ?? "").trim();
		if (!applyOperator(parsed, key.toLowerCase() as SearchOperator, value)) {
			noteSearchError(parsed, `Unknown search operator "${key.toLowerCase()}:${value}"`);
		}
		return " ";
	});

	const unquoted = rest.replace(/"[^"]*"/g, " ");
	for (const match of unquoted.matchAll(/(?:^|\s)([A-Za-z][A-Za-z0-9_-]*):(?:"([^"]*)"|(\S+))/g)) {
		const value = match[2] ?? match[3] ?? "";
		if (value.startsWith("/")) continue;
		noteSearchError(parsed, `Unknown search operator "${match[1].toLowerCase()}"`);
	}

	if (/(^|\s):unread(?=\s|$)/i.test(rest)) {
		parsed.read = "unread";
		rest = rest.replace(/(^|\s):unread(?=\s|$)/gi, " ");
	} else if (/(^|\s):read(?=\s|$)/i.test(rest)) {
		parsed.read = "read";
		rest = rest.replace(/(^|\s):read(?=\s|$)/gi, " ");
	}

	parsed.text = rest.replace(/\s+/g, " ").trim();
	parsed.needsFullText = !!(parsed.text || parsed.from || parsed.to || parsed.subject);
	return parsed;
}

function noteSearchError(parsed: ParsedSearchQuery, message: string): void {
	if (!parsed.error) parsed.error = message;
}

function applyOperator(parsed: ParsedSearchQuery, key: SearchOperator, value: string): boolean {
	switch (key) {
		case "from":
			if (!value) return false;
			parsed.from = value;
			return true;
		case "to":
			if (!value) return false;
			parsed.to = value;
			return true;
		case "subject":
		case "title":
			if (!value) return false;
			parsed.subject = value;
			return true;
		case "has":
			if (!/^attachments?$/i.test(value)) return false;
			parsed.hasAttachment = true;
			return true;
		case "is":
			if (/^unread$/i.test(value)) parsed.read = "unread";
			else if (/^read$/i.test(value)) parsed.read = "read";
			else if (/^starred$/i.test(value)) parsed.starred = true;
			else return false;
			return true;
		case "after":
		case "newer": {
			const after = parseDate(value);
			if (!after) return false;
			parsed.after = after;
			return true;
		}
		case "before":
		case "older": {
			const before = parseDate(value);
			if (!before) return false;
			parsed.before = before;
			return true;
		}
		default: {
			const unreachable: never = key;
			return unreachable;
		}
	}
}

function parseDate(value: string): Date | undefined {
	const match = value.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
	if (!match) return undefined;
	const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
	return Number.isNaN(date.getTime()) ? undefined : date;
}

/** Split free text into phrases ("..."), negations (-word) and plain terms. */
export function tokenizeSearchText(text: string): SearchToken[] {
	const tokens: SearchToken[] = [];
	const re = /(-?)"([^"]+)"|(-?)(\S+)/g;
	let match: RegExpExecArray | null;
	while ((match = re.exec(text))) {
		if (match[2] !== undefined) {
			const term = match[2].trim();
			if (term) tokens.push({ term, negate: match[1] === "-", phrase: true });
		} else {
			const term = match[4].replace(/^-+/, "").trim();
			if (term) tokens.push({ term, negate: match[3] === "-", phrase: false });
		}
	}
	return tokens;
}

/** FTS5 string literal: double quotes doubled, so user input can never alter the query grammar. */
function ftsString(value: string): string {
	return `"${value.replace(/"/g, '""')}"`;
}

/**
 * One term. Phrases match whole words; plain terms match by prefix so "inv"
 * finds "invoice". Punctuation FTS5 treats as separators is normalised to
 * spaces first, so "maya@acme.test" becomes the phrase "maya acme test".
 */
function ftsTerm(term: string, phrase: boolean): string {
	const cleaned = term.replace(/[^\p{L}\p{N}\s]+/gu, " ").replace(/\s+/g, " ").trim();
	if (!cleaned) return "";
	if (phrase || cleaned.includes(" ")) {
		// A multi-word prefix query needs the last word starred, which FTS5 only
		// allows inside a phrase as `"a b" *`; keep it simple and require whole words.
		return ftsString(cleaned);
	}
	return `${ftsString(cleaned)}*`;
}

/**
 * Build the FTS5 MATCH expression. Column filters restrict a term to one
 * column; free text is ANDed across the whole row. Returns null when there is
 * nothing to match, so callers skip the index entirely.
 */
export function buildFtsMatch(parsed: ParsedSearchQuery): FtsMatch | null {
	const parts: string[] = [];

	for (const token of tokenizeSearchText(parsed.text)) {
		const expr = ftsTerm(token.term, token.phrase);
		if (!expr) continue;
		parts.push(token.negate ? `NOT ${expr}` : expr);
	}
	const column = (name: string, value: string | undefined) => {
		if (!value) return;
		const terms = tokenizeSearchText(value)
			.map((token) => ftsTerm(token.term, token.phrase))
			.filter(Boolean);
		if (terms.length === 0) return;
		parts.push(`${name} : (${terms.join(" AND ")})`);
	};
	column("subject", parsed.subject);
	column("from_addr", parsed.from);
	column("{to_addr cc_addr}", parsed.to);

	if (parts.length === 0) return null;
	// FTS5 has no unary NOT, and a leading `""*` matches nothing. A query that
	// only excludes has to be applied as "row NOT IN (MATCH term)" by the caller.
	const positives = parts.filter((part) => !part.startsWith("NOT "));
	const negatives = parts.filter((part) => part.startsWith("NOT ")).map((part) => part.slice(4));
	if (positives.length === 0) {
		return negatives.length > 0 ? { mode: "exclude", expression: negatives.join(" OR ") } : null;
	}
	const base = positives.join(" AND ");
	const expression = negatives.length > 0 ? `(${base}) NOT (${negatives.join(" OR ")})` : base;
	return { mode: "match", expression };
}
