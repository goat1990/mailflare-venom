import { readFileSync } from "node:fs";
import { SMTPServer } from "smtp-server";
import type { SMTPServerSession } from "smtp-server";
import { resolveRecipientRejection } from "@/lib/email/incoming";
import { intakeIncomingMail } from "@/lib/email/intake";
import type { Mailer } from "./mailer";

/**
 * Receive mail directly on port 25 (or wherever SMTP_INBOUND_PORT points).
 * One inbound connection per message; each envelope recipient is handed to
 * the same intake the Cloudflare handler uses. A recipient a routing rule
 * blocks is refused at RCPT TO with the rule's reason, so the rest still
 * arrive; a failure answers 451 and the sender's retry is deduplicated.
 */
export function startSmtpListener(
	env: CloudflareEnv,
	mailer: Mailer,
	options: { port: number; host?: string; maxSize: number; hostname?: string; tls: { keyPath: string; certPath: string } | null },
) {
	// STARTTLS is only offered with a real certificate; smtp-server's built-in
	// one has a public private key, and advertising it would mislead senders.
	const server = new SMTPServer({
		name: options.hostname,
		authOptional: true,
		disabledCommands: options.tls ? ["AUTH"] : ["AUTH", "STARTTLS"],
		...(options.tls ? { key: readFileSync(options.tls.keyPath), cert: readFileSync(options.tls.certPath) } : {}),
		size: options.maxSize,
		banner: "Mailflare",
		onRcptTo(address, session: SMTPServerSession, callback) {
			const from = session.envelope.mailFrom ? session.envelope.mailFrom.address : "";
			void resolveRecipientRejection(env, from, address.address).then((reason) => {
				callback(reason ? Object.assign(new Error(reason), { responseCode: 550 }) : undefined);
			});
		},
		onData(stream, session: SMTPServerSession, callback) {
			const chunks: Buffer[] = [];
			stream.on("data", (chunk: Buffer) => chunks.push(chunk));
			stream.on("end", async () => {
				if (stream.sizeExceeded) {
					const error = Object.assign(new Error("Message exceeds size limit"), { responseCode: 552 });
					callback(error);
					return;
				}
				const raw = Buffer.concat(chunks);
				const from = session.envelope.mailFrom ? session.envelope.mailFrom.address : "";
				const headers = parseHeaders(raw);
				let accepted = 0;
				let rejectReason: string | null = null;
				for (const recipient of session.envelope.rcptTo) {
					const result = await intakeIncomingMail(
						env,
						{ from, to: recipient.address, raw: toArrayBuffer(raw), headers },
						{
							forward: (destination, forwardHeaders) =>
								mailer.sendRaw(from, destination, raw, forwardHeaders).catch((error) => {
									console.error(`SMTP forward to ${destination} failed`, error);
									return false;
								}),
						},
					).catch((error) => {
						console.error(`SMTP intake failed for ${recipient.address}`, error);
						return null;
					});
					if (!result) {
						callback(Object.assign(new Error("Temporary failure, try again later"), { responseCode: 451 }));
						return;
					}
					if (result.action === "reject") rejectReason = result.reason;
					else accepted += 1;
				}
				if (accepted === 0 && rejectReason) {
					callback(Object.assign(new Error(rejectReason), { responseCode: 550 }));
					return;
				}
				callback();
			});
		},
	});
	server.on("error", (error) => console.error("SMTP listener error", error));
	server.listen(options.port, options.host ?? "0.0.0.0", () => {
		console.log(`SMTP inbound listening on ${options.host ?? "0.0.0.0"}:${options.port}`);
	});
	return server;
}

/** Header map in the shape the Worker handler provides: lower-cased names, folded lines joined. */
export function parseHeaders(raw: Buffer): Record<string, string> {
	const text = new TextDecoder("latin1").decode(raw.subarray(0, Math.min(raw.length, 256 * 1024)));
	const end = text.search(/\r?\n\r?\n/);
	const block = (end >= 0 ? text.slice(0, end) : text).replace(/\r?\n[ \t]+/g, " ");
	const headers: Record<string, string> = {};
	for (const line of block.split(/\r?\n/)) {
		const index = line.indexOf(":");
		if (index <= 0) continue;
		const name = line.slice(0, index).trim().toLowerCase();
		if (!(name in headers)) headers[name] = line.slice(index + 1).trim();
	}
	return headers;
}

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
	return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}
