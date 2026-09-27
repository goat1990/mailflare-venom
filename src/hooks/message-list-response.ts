import { readMessageListPayload as readPayload } from "./message-list-response.mjs";
import type { MessageListResponse } from "./types";

export type MessageListResult =
	| {
			ok: true;
			messages: NonNullable<MessageListResponse["messages"]>;
			total: number;
			limit: number | undefined;
			offset: number | undefined;
	  }
	| { ok: false; error: string };

export function readMessageListPayload(responseOk: boolean, body: unknown): MessageListResult {
	return readPayload(responseOk, body) as MessageListResult;
}
