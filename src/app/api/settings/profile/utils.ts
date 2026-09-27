import { updateProfileSchema } from "@/lib/validators";
import type { UpdateProfileInput } from "./types";

export async function parseUpdateProfileRequest(request: Request): Promise<UpdateProfileInput> {
	const body: unknown = await request.json();
	const parsed = updateProfileSchema.parse(body);
	const record = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
	const currentPassword = typeof record?.currentPassword === "string" ? record.currentPassword : undefined;
	return { ...parsed, currentPassword };
}
