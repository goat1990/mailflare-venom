import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "venommail-mcp-agent-access-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `
			export { mcpDeliveryAllowed, resolveAgentDomain } from "./src/lib/mcp/agent-access.ts";
		`,
		resolveDir: root,
		sourcefile: "mcp-agent-access-entry.js",
	},
	outfile: join(outDir, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	logLevel: "silent",
});

const { mcpDeliveryAllowed, resolveAgentDomain } = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

const owner = {
	ownerDomains: [{ id: "dom_old" }, { id: "dom_new" }],
	ownerMailboxes: [
		{ id: "mbx_old", domainId: "dom_old" },
		{ id: "mbx_new", domainId: "dom_new" },
	],
};

test("a full-control key can address a domain the owner can access that was not listed at creation", () => {
	const decision = resolveAgentDomain({
		scopes: ["mcp:read", "mcp:draft", "domains", "mailboxes"],
		listedMailboxIds: ["mbx_old"],
		...owner,
	}, "dom_new");
	assert.deepEqual(decision, { allowed: true, mailboxIds: ["mbx_new"] });

	const frozen = resolveAgentDomain({
		scopes: ["mcp:read"],
		listedMailboxIds: ["mbx_old"],
		...owner,
	}, "dom_new");
	assert.deepEqual(frozen, { allowed: false });
});

test("a send-capable key may deliver and a review-only key may not", () => {
	assert.equal(mcpDeliveryAllowed(["mcp:read", "domains", "send"]), true);
	assert.equal(mcpDeliveryAllowed(["mcp:read", "mcp:request-send", "mailboxes"]), false);
});

test("a domain the owner cannot access is rejected", () => {
	const decision = resolveAgentDomain({
		scopes: ["mcp:read", "domains", "mailboxes", "send"],
		listedMailboxIds: ["mbx_old"],
		...owner,
	}, "dom_other");
	assert.deepEqual(decision, { allowed: false });
});
