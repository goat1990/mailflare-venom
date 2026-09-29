import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { domainAddBody, isMxConflict } from "../src/lib/domains/add-request.ts";
import { decideEmailRoutingRuleAction } from "../src/lib/cloudflare-routing-utils.ts";
import {
	listMailboxAddresses,
	mailboxAddress,
	NEW_MAILBOX_USES_ALL_DOMAINS,
} from "../src/lib/mailboxes/create-utils.ts";

const workerName = "mailflare";

test("a community admin can plan a personal mailbox on each domain", () => {
	assert.equal(NEW_MAILBOX_USES_ALL_DOMAINS, false);

	const first = listMailboxAddresses({
		localPart: "venom",
		primaryHostname: "digitaltiming.com",
		useAllDomains: NEW_MAILBOX_USES_ALL_DOMAINS,
		otherHostnames: ["other.example"],
		aliasAddresses: [],
	});
	const second = listMailboxAddresses({
		localPart: "venom",
		primaryHostname: "other.example",
		useAllDomains: NEW_MAILBOX_USES_ALL_DOMAINS,
		otherHostnames: ["digitaltiming.com"],
		aliasAddresses: [],
	});

	assert.deepEqual(first, ["venom@digitaltiming.com"]);
	assert.deepEqual(second, ["venom@other.example"]);
	assert.equal(mailboxAddress("Venom", "Other.Example"), "venom@other.example");
});

test("two mailbox rows keep one local part on one domain", () => {
	const db = new DatabaseSync(":memory:");
	db.exec(`
		CREATE TABLE domains (
			id TEXT PRIMARY KEY,
			hostname TEXT NOT NULL UNIQUE
		);
		CREATE TABLE mailboxes (
			id TEXT PRIMARY KEY,
			domain_id TEXT NOT NULL,
			local_part TEXT NOT NULL,
			use_all_domains INTEGER NOT NULL,
			UNIQUE (domain_id, local_part)
		);
	`);
	const insertDomain = db.prepare("INSERT INTO domains (id, hostname) VALUES (?, ?)");
	const insertMailbox = db.prepare(
		"INSERT INTO mailboxes (id, domain_id, local_part, use_all_domains) VALUES (?, ?, ?, ?)",
	);
	insertDomain.run("dom_1", "digitaltiming.com");
	insertDomain.run("dom_2", "other.example");
	insertMailbox.run("mbx_1", "dom_1", "venom", NEW_MAILBOX_USES_ALL_DOMAINS ? 1 : 0);
	insertMailbox.run("mbx_2", "dom_2", "venom", NEW_MAILBOX_USES_ALL_DOMAINS ? 1 : 0);

	const rows = db.prepare(`
		SELECT m.id, m.local_part, d.hostname, m.use_all_domains
		FROM mailboxes m JOIN domains d ON d.id = m.domain_id
		ORDER BY d.hostname
	`).all().map((row) => ({ ...row }));
	assert.deepEqual(rows, [
		{ id: "mbx_1", local_part: "venom", hostname: "digitaltiming.com", use_all_domains: 0 },
		{ id: "mbx_2", local_part: "venom", hostname: "other.example", use_all_domains: 0 },
	]);

	assert.throws(
		() => insertMailbox.run("mbx_3", "dom_2", "venom", 0),
		/UNIQUE constraint failed/,
	);
});

test("opting into every domain still lists the other hostnames", () => {
	const addresses = listMailboxAddresses({
		localPart: "sales",
		primaryHostname: "digitaltiming.com",
		useAllDomains: true,
		otherHostnames: ["other.example"],
		aliasAddresses: [],
	});
	assert.deepEqual(addresses, ["sales@digitaltiming.com", "sales@other.example"]);
});

test("an existing literal rule on the new address is updated, not created", () => {
	const address = "venom@other.example";
	const decision = decideEmailRoutingRuleAction(
		[
			{
				id: "rule-forward",
				enabled: true,
				name: "Forward to Gmail",
				matchers: [{ type: "literal", field: "to", value: address }],
				actions: [{ type: "forward", value: ["owner@gmail.com"] }],
			},
			{
				id: "rule-catch-all",
				enabled: true,
				name: "Catch-all",
				matchers: [{ type: "all" }],
				actions: [{ type: "drop" }],
			},
		],
		address,
		workerName,
	);
	assert.equal(decision.action, "update");
	assert.equal(decision.rule.id, "rule-forward");
});

test("a second domain with foreign MX can be confirmed and replaced", () => {
	assert.equal(isMxConflict("MX_RECORDS_CONFLICT"), true);
	assert.equal(isMxConflict(undefined), false);
	const firstTry = domainAddBody("other.example", true, false);
	const confirmed = domainAddBody("other.example", true, true);
	assert.equal(firstTry.replaceMxRecords, false);
	assert.equal(confirmed.replaceMxRecords, true);
	assert.equal(confirmed.enableRouting, true);
	assert.equal(confirmed.hostname, "other.example");
});
