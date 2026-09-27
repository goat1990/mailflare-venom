-- Inbound deduplication by mailbox and Message-ID. Existing rows stay NULL, which the unique index allows.
ALTER TABLE `messages` ADD `inbound_dedupe_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `messages_inbound_dedupe_idx` ON `messages` (`inbound_dedupe_key`);
