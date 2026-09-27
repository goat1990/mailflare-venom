import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeComposerHtml } from "../src/components/compose/composer-html.mjs";
import { threadActionIds } from "../src/components/messages/thread-selection.mjs";
import { replaceCidReference } from "../src/app/(dashboard)/inbox/[messageId]/inline-cid.mjs";
import { readMessageListPayload } from "../src/hooks/message-list-response.mjs";
import { realtimeFallbackOn } from "../src/hooks/realtime-fallback.mjs";

test("a failed message list is an error, not an empty inbox", () => {
	const failed = readMessageListPayload(false, { error: "Network down" });
	assert.equal(failed.ok, false);
	if (!failed.ok) assert.equal(failed.error, "Network down");

	const empty = readMessageListPayload(true, { messages: [], total: 0 });
	assert.equal(empty.ok, true);
	if (empty.ok) assert.deepEqual(empty.messages, []);

	const disguised = readMessageListPayload(true, { error: "Could not load messages" });
	assert.equal(disguised.ok, false);
});

test("draft HTML escapes a script tag and event handlers", () => {
	const safe = sanitizeComposerHtml('<p>Hello</p><script>alert(1)</script><img src="x" onerror="alert(1)">');
	assert.equal(safe.includes("<script"), false);
	assert.equal(/onerror\s*=/i.test(safe), false);
	assert.match(safe, /Hello/);
	assert.equal(sanitizeComposerHtml('<a href="javascript:alert(1)">click</a>').includes("javascript:"), false);
});

test("a cid prefix does not replace a longer content id", () => {
	const html = '<img src="cid:img"><img src="cid:img2">';
	assert.equal(
		replaceCidReference(html, "img", "/a"),
		'<img src="/a"><img src="cid:img2">',
	);
	assert.equal(
		replaceCidReference(html, "<img2>", "/b"),
		'<img src="cid:img"><img src="/b">',
	);
});

test("split selection acts on every message in the thread", () => {
	assert.deepEqual(
		threadActionIds([{ id: "newest", messageIds: ["oldest", "newest"] }]),
		["oldest", "newest"],
	);
});

test("realtime fallback stays armed until the socket opens", () => {
	assert.equal(realtimeFallbackOn("start"), true);
	assert.equal(realtimeFallbackOn("reconnect"), true);
	assert.equal(realtimeFallbackOn("close"), true);
	assert.equal(realtimeFallbackOn("open"), false);
});
