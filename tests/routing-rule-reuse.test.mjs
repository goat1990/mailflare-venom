import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "mailflare-routing-rule-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `
			export { decideEmailRoutingRuleAction, isWorkerRouteForAddress } from "./src/lib/cloudflare-routing-utils.ts";
		`,
		resolveDir: root,
		sourcefile: "routing-rule-entry.js",
	},
	outfile: join(outDir, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	logLevel: "silent",
});

const { decideEmailRoutingRuleAction, isWorkerRouteForAddress } = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

const workerName = "mailflare";
const address = "venom@digitaltiming.com";

const workerRule = {
	id: "rule-worker",
	enabled: true,
	name: "Route venom@digitaltiming.com to mailflare",
	matchers: [{ type: "literal", field: "to", value: "venom@digitaltiming.com" }],
	actions: [{ type: "worker", value: [workerName] }],
};

const disabledWorkerRule = {
	id: "rule-worker-disabled",
	enabled: false,
	name: "Route venom@digitaltiming.com to mailflare",
	matchers: [{ type: "literal", field: "to", value: "Venom@DigitalTiming.com" }],
	actions: [{ type: "worker", value: [workerName] }],
};

const forwardRule = {
	id: "rule-forward",
	enabled: true,
	name: "Forward to Gmail",
	priority: 0,
	matchers: [{ type: "literal", field: "to", value: "venom@digitaltiming.com" }],
	actions: [{ type: "forward", value: ["owner@gmail.com"] }],
};

const catchAll = {
	id: "rule-catch-all",
	enabled: true,
	name: "Catch-all",
	matchers: [{ type: "all", field: "to", value: address }],
	actions: [{ type: "forward", value: ["owner@gmail.com"] }],
};

const otherAddress = {
	id: "rule-other",
	enabled: true,
	matchers: [{ type: "literal", field: "to", value: "other@digitaltiming.com" }],
	actions: [{ type: "worker", value: [workerName] }],
};

test("an existing worker rule is reused", () => {
	const decision = decideEmailRoutingRuleAction([otherAddress, workerRule, catchAll], address, workerName);
	assert.equal(decision.action, "reuse");
	assert.equal(decision.rule.id, "rule-worker");
});

test("an existing forward rule for the same address is updated, not created", () => {
	const decision = decideEmailRoutingRuleAction([catchAll, forwardRule], address, workerName);
	assert.equal(decision.action, "update");
	assert.equal(decision.rule.id, "rule-forward");
	assert.notEqual(decision.action, "create");
});

test("a disabled worker rule for the same address is updated", () => {
	const decision = decideEmailRoutingRuleAction([disabledWorkerRule], "Venom@DigitalTiming.com", workerName);
	assert.equal(decision.action, "update");
	assert.equal(decision.rule.id, "rule-worker-disabled");
});

test("a catch-all is ignored", () => {
	const decision = decideEmailRoutingRuleAction([catchAll], address, workerName);
	assert.equal(decision.action, "create");
	assert.equal(isWorkerRouteForAddress(catchAll, address, workerName), false);
});

test("an unknown address is created", () => {
	const decision = decideEmailRoutingRuleAction([otherAddress, catchAll], address, workerName);
	assert.equal(decision.action, "create");
});

test("delete still matches only the worker route for that address", () => {
	assert.equal(isWorkerRouteForAddress(workerRule, address, workerName), true);
	assert.equal(isWorkerRouteForAddress(disabledWorkerRule, address, workerName), true);
	assert.equal(isWorkerRouteForAddress(forwardRule, address, workerName), false);
	assert.equal(isWorkerRouteForAddress(catchAll, address, workerName), false);
	assert.equal(isWorkerRouteForAddress(otherAddress, address, workerName), false);
});
