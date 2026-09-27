import { updateForwardingEmailSchema } from "@/lib/validators";
import type { UpdateForwardingEmailInput } from "./types";

export async function parseUpdateForwardingEmailRequest(
	request: Request,
): Promise<UpdateForwardingEmailInput> {
	const body: unknown = await request.json();
	const parsed = updateForwardingEmailSchema.parse(body);
	const record = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
	const currentPassword = typeof record?.currentPassword === "string" ? record.currentPassword : undefined;
	return { ...parsed, currentPassword };
}
