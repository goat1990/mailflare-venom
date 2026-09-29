"use client";

import {
  DatabaseBackup,
  Globe2,
  Activity,
  Mail,
  Settings,
  Palette,
  Users,
  Route,
  Webhook,
  KeyRound,
  Bot,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { NavItem } from "./components-nav";
import { SidebarFooter } from "./sidebar-footer";
import { SidebarHeader } from "./sidebar-header";
import { useSidebar } from "./sidebar-state";

const sections = [
  {
    // label: "Overview",
    links: [{ href: "/admin", label: "Overview", icon: Settings }],
  },
  {
    label: "Email",
    links: [
      { href: "/mailboxes", label: "Mailboxes", icon: Mail },
      { href: "/domains", label: "Domains", icon: Globe2 },
      { href: "/routing", label: "Routing", icon: Route },
      { href: "/webhooks", label: "Webhooks", icon: Webhook },
    ],
  },
  {
    label: "Administration",
    links: [
      { href: "/agent", label: "Agent", icon: Bot },
      { href: "/accounts", label: "Accounts", icon: Users },
      { href: "/activity", label: "Activity", icon: Activity },
      { href: "/backups", label: "Backups", icon: DatabaseBackup },
      { href: "/api-keys", label: "API keys", icon: KeyRound },
    ],
  },
  {
    label: "Product",
    links: [
      { href: "/branding", label: "Branding", icon: Palette },
    ],
  },
];

export function AdminNav({ className }: { className?: string }) {
  const { minimal } = useSidebar();

  return (
    <nav className={cn("flex min-h-full flex-col gap-1", className)}>
      <SidebarHeader href="/inbox" label="Admin" />
      <div className={cn("space-y-4", minimal && "space-y-2 pl-1")}>
        {sections.map((section, sectionIndex) => {
          if (section.links.length === 0) return null;

          return (
            // The first section has no label, so fall back to its first href for a stable key.
            <section key={section.label ?? section.links[0].href}>
              {minimal && sectionIndex > 0 && <hr className="mx-3 mb-3 border-neutral-200/70" />}
              {!minimal && section.label && (
                <p className="mb-1 px-3 text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
                  {section.label}
                </p>
              )}
              <div className="space-y-1">
                {section.links.map((link) => (
                  <NavItem link={link} key={link.href} />
                ))}
              </div>
            </section>
          );
        })}
      </div>
      <span className="flex-1" />
      <SidebarFooter />
    </nav>
  );
}
