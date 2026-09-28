import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "mailflare-api-key-scopes-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `
			export { acceptedApiKeyScopes, scopesFromCreateRequest } from "./src/lib/api/scopes.ts";
			export { hasScope } from "./src/lib/api/key-auth.ts";
		`,
		resolveDir: root,
		sourcefile: "api-key-scopes-entry.js",
	},
	outfile: join(outDir, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	logLevel: "silent",
});

const { acceptedApiKeyScopes, hasScope, scopesFromCreateRequest } = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

test("a key with admin scopes and mail scopes is accepted", () => {
	assert.deepEqual(acceptedApiKeyScopes(["domains", "mcp:read", "mcp:draft", "mcp:organize"]), [
		"domains",
		"mcp:read",
		"mcp:draft",
		"mcp:organize",
	]);
	assert.deepEqual(acceptedApiKeyScopes(["accounts", "mailboxes", "read"]), ["accounts", "mailboxes", "read"]);
});

test("an unknown scope rejects the key", () => {
	assert.equal(acceptedApiKeyScopes(["domains", "mcp:read", "not-a-scope"]), null);
	assert.equal(acceptedApiKeyScopes([]), null);
});

test("a create payload with both groups is accepted", () => {
	const payload = {
		name: "ops",
		scopes: ["domains", "mailboxes", "read", "send", "jmap", "mcp:read", "mcp:request-send"],
	};
	assert.deepEqual(scopesFromCreateRequest(payload.scopes), [
		"domains",
		"mailboxes",
		"read",
		"send",
		"jmap",
		"mcp:read",
		"mcp:request-send",
	]);
	assert.deepEqual(scopesFromCreateRequest(["domains", "mcp:request-send"]), ["domains", "mcp:request-send"]);
});

test("a create payload with an unknown scope is rejected", () => {
	const payload = { name: "ops", scopes: ["domains", "send", "not-a-scope"] };
	assert.equal(scopesFromCreateRequest(payload.scopes), null);
});

test("request_send still does not send", () => {
	const scopes = acceptedApiKeyScopes(["mailboxes", "mcp:request-send"]);
	assert.deepEqual(scopes, ["mailboxes", "mcp:request-send"]);
	assert.equal(hasScope(scopes, "send"), false);
	assert.equal(hasScope(acceptedApiKeyScopes(["domains", "send"]), "send"), true);
});
