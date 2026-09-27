-- Rebuild message search so bcc is indexed and HTML tags are not.
-- 0031 was already taken by password reset, so this is 0041.
-- messages_search_source is the FTS content view: html_body is plain text.
DROP TRIGGER IF EXISTS `messages_fts_ai`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `messages_fts_ad`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `messages_fts_au`;--> statement-breakpoint
DROP TABLE IF EXISTS `messages_fts`;--> statement-breakpoint
DROP VIEW IF EXISTS `messages_search_source`;--> statement-breakpoint
CREATE VIEW `messages_search_source` AS
SELECT
	`m`.`rowid` AS `rowid`,
	`m`.`subject` AS `subject`,
	`m`.`from_addr` AS `from_addr`,
	`m`.`to_addr` AS `to_addr`,
	`m`.`cc_addr` AS `cc_addr`,
	`m`.`bcc_addr` AS `bcc_addr`,
	`m`.`text_body` AS `text_body`,
	(
		WITH RECURSIVE `cleaned`(`s`, `n`) AS (
			SELECT REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(`m`.`html_body`, ''), '&nbsp;', ' '), '&amp;', '&'), '&lt;', '<'), '&gt;', '>'), '&quot;', '"'), '&#39;', CHAR(39)), 0
			UNION ALL
			SELECT
				substr(`s`, 1, instr(`s`, '<') - 1) || ' ' || substr(`s`, instr(`s`, '<') + instr(substr(`s`, instr(`s`, '<')), '>')),
				`n` + 1
			FROM `cleaned`
			WHERE instr(`s`, '<') > 0 AND instr(substr(`s`, instr(`s`, '<')), '>') > 0 AND `n` < 2000
		)
		SELECT `s` FROM `cleaned` ORDER BY `n` DESC LIMIT 1
	) AS `html_body`
FROM `messages` AS `m`;--> statement-breakpoint
CREATE VIRTUAL TABLE `messages_fts` USING fts5(
	`subject`,
	`from_addr`,
	`to_addr`,
	`cc_addr`,
	`bcc_addr`,
	`text_body`,
	`html_body`,
	content='messages_search_source',
	content_rowid='rowid',
	tokenize='unicode61 remove_diacritics 2'
);--> statement-breakpoint
CREATE TRIGGER `messages_fts_ai` AFTER INSERT ON `messages` BEGIN
	INSERT INTO `messages_fts`(`rowid`, `subject`, `from_addr`, `to_addr`, `cc_addr`, `bcc_addr`, `text_body`, `html_body`)
	SELECT `rowid`, `subject`, `from_addr`, `to_addr`, `cc_addr`, `bcc_addr`, `text_body`, `html_body`
	FROM `messages_search_source` WHERE `rowid` = new.`rowid`;
END;--> statement-breakpoint
CREATE TRIGGER `messages_fts_ad` AFTER DELETE ON `messages` BEGIN
	INSERT INTO `messages_fts`(`messages_fts`, `rowid`, `subject`, `from_addr`, `to_addr`, `cc_addr`, `bcc_addr`, `text_body`, `html_body`)
	VALUES (
		'delete',
		old.`rowid`,
		old.`subject`,
		old.`from_addr`,
		old.`to_addr`,
		old.`cc_addr`,
		old.`bcc_addr`,
		old.`text_body`,
		(
			WITH RECURSIVE `cleaned`(`s`, `n`) AS (
				SELECT REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(old.`html_body`, ''), '&nbsp;', ' '), '&amp;', '&'), '&lt;', '<'), '&gt;', '>'), '&quot;', '"'), '&#39;', CHAR(39)), 0
				UNION ALL
				SELECT
					substr(`s`, 1, instr(`s`, '<') - 1) || ' ' || substr(`s`, instr(`s`, '<') + instr(substr(`s`, instr(`s`, '<')), '>')),
					`n` + 1
				FROM `cleaned`
				WHERE instr(`s`, '<') > 0 AND instr(substr(`s`, instr(`s`, '<')), '>') > 0 AND `n` < 2000
			)
			SELECT `s` FROM `cleaned` ORDER BY `n` DESC LIMIT 1
		)
	);
END;--> statement-breakpoint
CREATE TRIGGER `messages_fts_au` AFTER UPDATE OF `subject`, `from_addr`, `to_addr`, `cc_addr`, `bcc_addr`, `text_body`, `html_body` ON `messages` BEGIN
	INSERT INTO `messages_fts`(`messages_fts`, `rowid`, `subject`, `from_addr`, `to_addr`, `cc_addr`, `bcc_addr`, `text_body`, `html_body`)
	VALUES (
		'delete',
		old.`rowid`,
		old.`subject`,
		old.`from_addr`,
		old.`to_addr`,
		old.`cc_addr`,
		old.`bcc_addr`,
		old.`text_body`,
		(
			WITH RECURSIVE `cleaned`(`s`, `n`) AS (
				SELECT REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(old.`html_body`, ''), '&nbsp;', ' '), '&amp;', '&'), '&lt;', '<'), '&gt;', '>'), '&quot;', '"'), '&#39;', CHAR(39)), 0
				UNION ALL
				SELECT
					substr(`s`, 1, instr(`s`, '<') - 1) || ' ' || substr(`s`, instr(`s`, '<') + instr(substr(`s`, instr(`s`, '<')), '>')),
					`n` + 1
				FROM `cleaned`
				WHERE instr(`s`, '<') > 0 AND instr(substr(`s`, instr(`s`, '<')), '>') > 0 AND `n` < 2000
			)
			SELECT `s` FROM `cleaned` ORDER BY `n` DESC LIMIT 1
		)
	);
	INSERT INTO `messages_fts`(`rowid`, `subject`, `from_addr`, `to_addr`, `cc_addr`, `bcc_addr`, `text_body`, `html_body`)
	SELECT `rowid`, `subject`, `from_addr`, `to_addr`, `cc_addr`, `bcc_addr`, `text_body`, `html_body`
	FROM `messages_search_source` WHERE `rowid` = new.`rowid`;
END;--> statement-breakpoint
INSERT INTO `messages_fts`(`messages_fts`) VALUES ('rebuild');
