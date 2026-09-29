"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { Copy, KeyRound, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { List, ListRow } from "@/components/ui/list";
import { SectionRowSkeleton } from "@/components/page-skeletons";
import { McpAgentInstructions } from "@/components/settings/mcp-agent-instructions";
import { authFetch } from "@/lib/auth/client";
import { MCP_MAIL_SCOPES } from "@/lib/api/scopes";
import type { ApiKey } from "./types";
import { CREATE_KEY_PERMISSIONS, parseApiKeyScopes } from "./utils";

const MCP_MAIL_SCOPE_SET = new Set<string>(MCP_MAIL_SCOPES);

export default function ApiKeysPage() {
	const qc = useQueryClient();
	const { mailboxes } = useSelectedMailbox();
	const [name, setName] = useState("");
	const [scopes, setScopes] = useState<string[]>(["domains"]);
	const [mailboxIds, setMailboxIds] = useState<string[]>([]);
	const [mcpAllowed, setMcpAllowed] = useState(false);
	const [createdMcpAllowed, setCreatedMcpAllowed] = useState(false);
	const [newKey, setNewKey] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);
	const [createOpen, setCreateOpen] = useState(false);

	const { data, isLoading } = useQuery({
		queryKey: ["admin-api-keys"],
		queryFn: async () => {
			const res = await authFetch("/api/admin/api-keys");
			if (!res.ok) throw new Error("Could not load admin API keys");
			return (await res.json()) as { apiKeys: ApiKey[] };
		},
	});

	const create = useMutation({
		mutationFn: async () => {
			const res = await authFetch("/api/admin/api-keys", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: name.trim(), scopes, mcpAllowed, ...(mailboxIds.length ? { mailboxIds } : {}) }),
			});
			const json = (await res.json()) as { key?: string; error?: string };
			if (!res.ok || !json.key) throw new Error(typeof json.error === "string" ? json.error : "Could not create API key");
			setNewKey(json.key ?? null);
			setCreatedMcpAllowed(mcpAllowed || scopes.some((scope) => MCP_MAIL_SCOPE_SET.has(scope)));
			setCopied(false);
			setName("");
		},
		onSuccess: () => {
			setScopes(["domains"]);
			qc.invalidateQueries({ queryKey: ["admin-api-keys"] });
		},
	});
	const revoke = useMutation({
		mutationFn: async (id: string) => {
			const res = await authFetch(`/api/admin/api-keys?id=${encodeURIComponent(id)}`, { method: "DELETE" });
			if (!res.ok) throw new Error("Could not revoke admin API key");
		},
		onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-api-keys"] }),
	});

	return (
		<div className="space-y-6">
			<div className="flex items-center justify-between gap-4">
				<h1 className="text-3xl font-medium">Admin API keys</h1>
				<Dialog open={createOpen} onOpenChange={(open) => { if (create.isPending) return; setCreateOpen(open); if (!open) { setNewKey(null); setCopied(false); } }}>
					<DialogTrigger asChild>
						<Button>
							<Plus className="h-4 w-4" />
							New API key
						</Button>
					</DialogTrigger>
					<DialogContent className="max-h-[calc(100vh-4rem)] overflow-y-auto">
						<DialogHeader>
							<DialogTitle>{newKey ? "API key created" : "Create API key"}</DialogTitle>
							<DialogDescription>{newKey ? "Copy this key now. It will only be shown once." : "Name your key and choose the access it needs."}</DialogDescription>
						</DialogHeader>
						{!newKey && <div className="space-y-4">
						<div className="space-y-2">
							<Label htmlFor="admin-key-name">Key name</Label>
							<Input id="admin-key-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} placeholder="Production app" />
						</div>
						<label className="flex items-start gap-3 text-sm"><Checkbox checked={mcpAllowed} onChange={(event) => setMcpAllowed(event.target.checked)} /><span><strong>Allow MCP access</strong><span className="mt-1 block text-neutral-500">Use this key with an MCP client for the permissions selected below.</span></span></label>
						<fieldset className="space-y-2">
							<legend className="text-sm font-medium">Permissions</legend>
							<div className="space-y-2">
								{CREATE_KEY_PERMISSIONS.map((scope) => (
									<label key={scope.value} className="flex items-start gap-3 text-sm">
										<Checkbox
											checked={scopes.includes(scope.value)}
											className="mt-1"
											onChange={(event) =>
												setScopes((current) =>
													event.target.checked
														? [...current, scope.value]
														: current.filter((item) => item !== scope.value),
												)
											}
										/>
										<span><strong>{scope.label}</strong><span className="block text-neutral-500">{scope.description}</span></span>
									</label>
								))}
							</div>
						</fieldset>
						<fieldset className="space-y-2">
							<legend className="text-sm font-medium">Mailboxes</legend>
							{mailboxes.length === 0 ? <p className="text-sm text-neutral-500">No accessible mailboxes.</p> : mailboxes.map((mailbox) => (
								<label key={mailbox.id} className="flex items-center gap-3 text-sm">
									<Checkbox checked={mailboxIds.includes(mailbox.id)} onChange={(event) => setMailboxIds((current) => event.target.checked ? [...current, mailbox.id] : current.filter((id) => id !== mailbox.id))} />
									{mailbox.localPart}@{mailbox.hostname}
								</label>
							))}
							<p className="text-xs text-neutral-500">Leave this empty to let read, send, and JMAP follow every mailbox this account can open. MCP mail permissions need at least one mailbox.</p>
						</fieldset>
						{create.isError && (
							<p className="text-sm text-red-600">{(create.error as Error).message}</p>
						)}
						<Button
							onClick={() => create.mutate()}
							disabled={!name.trim() || scopes.length === 0 || create.isPending || (scopes.some((scope) => MCP_MAIL_SCOPE_SET.has(scope)) && mailboxIds.length === 0)}
						>
							{create.isPending ? "Creating..." : "Create key"}
						</Button>
						</div>}
						{newKey && <div className="space-y-3 rounded-xl border border-blue-200 bg-blue-50 p-4"><code className="block break-all rounded bg-white p-2 text-xs">{newKey}</code>{createdMcpAllowed && <McpAgentInstructions mode="admin" apiKey={newKey} />}<div className="flex gap-2"><Button type="button" size="sm" variant="outline" onClick={() => void navigator.clipboard.writeText(newKey).then(() => setCopied(true))}><Copy className="h-4 w-4" />{copied ? "Copied" : "Copy key"}</Button><Button type="button" size="sm" variant="ghost" onClick={() => { setCreateOpen(false); setNewKey(null); setCopied(false); }}>Done</Button></div></div>}
					</DialogContent>
				</Dialog>
			</div>
			<section className="space-y-3">
				{revoke.isError && <p role="alert" className="text-sm text-red-600">{revoke.error.message}</p>}
				{isLoading && (
					<SectionRowSkeleton />
				)}
				{!isLoading && (data?.apiKeys ?? []).length === 0 && (
					<p className="rounded-2xl bg-white px-5 py-4 text-sm text-neutral-500">
						No API keys yet
					</p>
				)}
				<List>
					{(data?.apiKeys ?? []).map((key) => (
						<ListRow
							key={key.id}
							className="px-5 py-4"
						>
							<span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-blue-100 text-blue-700">
								<KeyRound className="h-5 w-5" />
							</span>
							<span className="min-w-0 flex-1 space-y-2">
								<span className="flex min-w-0 flex-wrap items-center gap-2"><strong className="truncate text-sm font-semibold text-neutral-900">{key.name}</strong>{key.kind === "mcp" && <Badge variant="outline">MCP</Badge>}</span>
								<span className="block truncate no-font-mono text-sm text-neutral-500">{key.prefix}...</span>
								<span className="flex flex-wrap gap-1">
									{parseApiKeyScopes(key.scopes).map((scope) => (
										<Badge key={scope} variant="outline">
											{scope}
										</Badge>
									))}
								</span>
							</span>
						<Button type="button" size="sm" variant="outline" disabled={revoke.isPending} onClick={() => { if (window.confirm(`Revoke “${key.name}”? Apps using this key will lose access immediately.`)) revoke.mutate(key.id); }}><Trash2 className="h-4 w-4" />Revoke</Button>
						</ListRow>
					))}
				</List>
			</section>
		</div>
	);
}
