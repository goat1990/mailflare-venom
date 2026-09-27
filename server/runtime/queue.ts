import Database from "better-sqlite3";

/**
 * The Queue producer API with an in-process consumer. Delivery order and the
 * retry policy match wrangler.jsonc (three retries, ten seconds apart on
 * failure). Every job is written to a SQLite journal before it is scheduled
 * and removed only once its consumer succeeds, so a restart resumes whatever
 * was pending and a job that runs out of retries stays on record as dead.
 */
export type QueueConsumer = (body: unknown) => Promise<void>;

type StoredJob = { id: number; body: string; attempts: number; runAt: number };

export class QueueJournal {
	readonly db: Database.Database;

	constructor(filename: string) {
		this.db = new Database(filename, { timeout: 1000 });
		// Jobs, sockets and rate limits all live in this process, so one process owns the data
		// directory. The exclusive lock makes a second one fail here instead of running every job twice.
		this.db.pragma("locking_mode = EXCLUSIVE");
		try {
			this.db.exec(
				"CREATE TABLE IF NOT EXISTS queue_jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, queue TEXT NOT NULL, body TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, run_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending')",
			);
		} catch (error) {
			this.db.close();
			throw new Error(`Another Mailflare process holds the job queue at ${filename}; the Node runtime runs as a single process`, { cause: error });
		}
	}

	add(queue: string, body: string, runAt: number): StoredJob {
		const info = this.db.prepare("INSERT INTO queue_jobs (queue, body, run_at) VALUES (?, ?, ?)").run(queue, body, runAt);
		return { id: Number(info.lastInsertRowid), body, attempts: 0, runAt };
	}

	pending(queue: string): StoredJob[] {
		return this.db
			.prepare("SELECT id, body, attempts, run_at AS runAt FROM queue_jobs WHERE queue = ? AND status = 'pending' ORDER BY run_at, id")
			.all(queue) as StoredJob[];
	}

	count(queue: string): number {
		return (this.db.prepare("SELECT count(*) AS count FROM queue_jobs WHERE queue = ? AND status = 'pending'").get(queue) as { count: number }).count;
	}

	reschedule(job: StoredJob) {
		this.db.prepare("UPDATE queue_jobs SET attempts = ?, run_at = ? WHERE id = ?").run(job.attempts, job.runAt, job.id);
	}

	complete(id: number) {
		this.db.prepare("DELETE FROM queue_jobs WHERE id = ?").run(id);
	}

	bury(id: number) {
		this.db.prepare("UPDATE queue_jobs SET status = 'dead' WHERE id = ?").run(id);
	}

	close() {
		this.db.close();
	}
}

export class InProcessQueue {
	private consumer: QueueConsumer | null = null;
	private readonly maxRetries: number;
	private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
	private stopped = false;

	constructor(readonly name: string, private readonly journal: QueueJournal, options?: { maxRetries?: number }) {
		this.maxRetries = options?.maxRetries ?? 3;
	}

	setConsumer(consumer: QueueConsumer) {
		this.consumer = consumer;
		for (const job of this.journal.pending(this.name)) this.schedule(job);
	}

	async send(body: unknown, options?: { delaySeconds?: number }) {
		const job = this.journal.add(this.name, JSON.stringify(body), Date.now() + (options?.delaySeconds ?? 0) * 1000);
		if (this.consumer) this.schedule(job);
	}

	async sendBatch(messages: Iterable<{ body: unknown; delaySeconds?: number }>) {
		for (const message of messages) await this.send(message.body, { delaySeconds: message.delaySeconds });
	}

	async metrics() {
		return { backlogCount: this.journal.count(this.name) };
	}

	private schedule(job: StoredJob) {
		if (this.stopped || this.timers.has(job.id)) return;
		const timer = setTimeout(() => {
			this.timers.delete(job.id);
			void this.deliver(job);
		}, Math.max(0, job.runAt - Date.now()));
		this.timers.set(job.id, timer);
	}

	private async deliver(job: StoredJob) {
		try {
			await this.consumer!(JSON.parse(job.body));
			this.journal.complete(job.id);
		} catch (error) {
			console.error(`Queue ${this.name}: job failed`, error);
			if (job.attempts < this.maxRetries) {
				const retry = { ...job, attempts: job.attempts + 1, runAt: Date.now() + 10_000 };
				this.journal.reschedule(retry);
				this.schedule(retry);
			} else {
				this.journal.bury(job.id);
				console.error(`Queue ${this.name}: giving up after ${this.maxRetries} retries`, job.body);
			}
		}
	}

	/** Stops delivering; pending jobs stay in the journal for the next start. */
	stop() {
		this.stopped = true;
		for (const timer of this.timers.values()) clearTimeout(timer);
		this.timers.clear();
	}
}

export function openQueue<T>(name: string, journal: QueueJournal): Queue<T> & InProcessQueue {
	return new InProcessQueue(name, journal) as unknown as Queue<T> & InProcessQueue;
}
