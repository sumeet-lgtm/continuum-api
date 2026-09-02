import { useEffect, useRef, useState, useCallback } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  Search, KeyRound, Mail, BarChart3, Webhook, Globe, Settings,
  CreditCard, Zap, Building2, ShieldCheck, Plug, Activity,
  FileText, GitBranch, Megaphone, Users, Send, Layers,
  ArrowRight, BookOpen, Wrench, TrendingUp, ListChecks,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface Command {
  id: string;
  label: string;
  group: string;
  keywords?: string;
  icon: typeof Search;
  href: string;
}

const COMMANDS: Command[] = [
  { id: "overview",       label: "Overview",              group: "Navigation", icon: BarChart3,   href: "/dashboard" },
  { id: "api-keys",       label: "API Keys",              group: "Navigation", icon: KeyRound,    href: "/dashboard/api-keys" },
  { id: "api-ref",        label: "API Reference",         group: "Navigation", keywords: "docs documentation endpoints", icon: BookOpen, href: "/dashboard/api-reference" },
  { id: "transactional",  label: "Send Email",            group: "Sending",    keywords: "transactional send email",     icon: Send,      href: "/dashboard/transactional" },
  { id: "batch-send",     label: "Batch Send",            group: "Sending",    icon: Layers,      href: "/dashboard/batch-send" },
  { id: "messages",       label: "Message History",       group: "Sending",    keywords: "history logs emails",          icon: Mail,      href: "/dashboard/messages" },
  { id: "templates",      label: "Email Templates",       group: "Sending",    icon: FileText,    href: "/dashboard/templates" },
  { id: "domains",        label: "Sending Domains",       group: "Sending",    keywords: "dns spf dkim dmarc domain",    icon: Globe,     href: "/dashboard/domains" },
  { id: "suppressions",   label: "Suppressions",          group: "Sending",    keywords: "bounced unsubscribed block",   icon: Mail,      href: "/dashboard/suppressions" },
  { id: "verify",         label: "Verify Email",          group: "Verification", keywords: "email verify check valid",   icon: Zap,       href: "/dashboard/verify" },
  { id: "bulk",           label: "Bulk Verification",     group: "Verification", keywords: "bulk csv upload list",       icon: ListChecks, href: "/dashboard/bulk" },
  { id: "widget",         label: "Embed Widget",          group: "Verification", keywords: "embed widget snippet code",  icon: Zap,       href: "/dashboard/widget" },
  { id: "campaigns",      label: "Campaigns",             group: "Marketing",  icon: Megaphone,   href: "/dashboard/campaigns" },
  { id: "automations",    label: "Autoresponders",        group: "Marketing",  icon: Zap,         href: "/dashboard/automations" },
  { id: "lists",          label: "Mailing Lists",         group: "Marketing",  icon: Users,       href: "/dashboard/lists" },
  { id: "contacts",       label: "Contacts",              group: "Marketing",  icon: Users,       href: "/dashboard/contacts" },
  { id: "migrate",        label: "Migrate Contacts",      group: "Marketing",  keywords: "mailchimp sendgrid klaviyo import",icon: ArrowRight, href: "/dashboard/migrate" },
  { id: "sequences",      label: "Sequences",             group: "Outreach",   keywords: "cold outreach sequence",      icon: GitBranch, href: "/dashboard/sequences" },
  { id: "mailboxes",      label: "Mailboxes",             group: "Outreach",   icon: Mail,        href: "/dashboard/mailboxes" },
  { id: "analytics",      label: "Analytics",             group: "Reports",    keywords: "reports stats data charts",   icon: BarChart3, href: "/dashboard/analytics" },
  { id: "usage",          label: "Usage & Limits",        group: "Reports",    keywords: "quota credits usage limit plan", icon: TrendingUp, href: "/dashboard/usage" },
  { id: "deliverability", label: "Deliverability Score",  group: "Reports",    icon: ShieldCheck, href: "/dashboard/deliverability" },
  { id: "monitoring",     label: "Uptime Monitoring",     group: "Reports",    keywords: "monitor uptime health check", icon: Activity,  href: "/dashboard/monitoring" },
  { id: "webhooks",       label: "Webhooks",              group: "Developers", keywords: "webhook events callbacks",     icon: Webhook,   href: "/dashboard/webhooks" },
  { id: "connectors",     label: "Connectors",            group: "Developers", keywords: "integrations zapier slack",    icon: Plug,      href: "/dashboard/connectors" },
  { id: "tools",          label: "Deliverability Tools",  group: "Developers", keywords: "domain health dkim spf check", icon: Wrench,   href: "/dashboard/tools" },
  { id: "organization",   label: "Organization / SSO",    group: "Enterprise", keywords: "sso saml scim members team",  icon: Building2, href: "/dashboard/organization" },
  { id: "audit-logs",     label: "Audit Logs",            group: "Enterprise", keywords: "audit log events compliance", icon: ShieldCheck, href: "/dashboard/audit-logs" },
  { id: "billing",        label: "Billing & Plans",       group: "Account",    keywords: "billing upgrade subscription credits", icon: CreditCard, href: "/dashboard/billing" },
  { id: "settings",       label: "Account Settings",      group: "Account",    keywords: "settings account profile",    icon: Settings,  href: "/dashboard/settings" },
];

function score(cmd: Command, q: string): number {
  const ql = q.toLowerCase();
  const label = cmd.label.toLowerCase();
  const kw = (cmd.keywords ?? "").toLowerCase();
  if (label === ql) return 100;
  if (label.startsWith(ql)) return 90;
  if (label.includes(ql)) return 70;
  if (kw.includes(ql)) return 50;
  if (cmd.group.toLowerCase().includes(ql)) return 30;
  return 0;
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((o) => !o);
        setQuery("");
        setSelected(0);
      }
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 30);
  }, [open]);

  const filtered = query.trim()
    ? COMMANDS.map((c) => ({ cmd: c, s: score(c, query.trim()) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).map((x) => x.cmd)
    : COMMANDS;

  useEffect(() => setSelected(0), [query]);

  const run = useCallback((href: string) => {
    setOpen(false);
    setQuery("");
    navigate({ to: href as "/dashboard" });
  }, [navigate]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "ArrowDown") { e.preventDefault(); setSelected((s) => Math.min(s + 1, filtered.length - 1)); }
      if (e.key === "ArrowUp") { e.preventDefault(); setSelected((s) => Math.max(s - 1, 0)); }
      if (e.key === "Enter" && filtered[selected]) { run(filtered[selected].href); }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, filtered, selected, run]);

  if (!open) return null;

  const groups = query.trim()
    ? [{ label: "Results", cmds: filtered }]
    : Object.entries(
        filtered.reduce<Record<string, Command[]>>((acc, c) => {
          (acc[c.group] ??= []).push(c); return acc;
        }, {})
      ).map(([label, cmds]) => ({ label, cmds }));

  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center pt-[12vh] px-4" onClick={() => setOpen(false)}>
      <div className="absolute inset-0 bg-background/60 backdrop-blur-sm" />
      <div
        className="relative w-full max-w-lg rounded-xl border border-border bg-card shadow-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search bar */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border">
          <Search className="h-4 w-4 text-muted-foreground shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search pages and features…"
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <kbd className="text-[10px] text-muted-foreground border border-border rounded px-1 py-0.5">esc</kbd>
        </div>

        {/* Results */}
        <div className="max-h-[50vh] overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <p className="px-4 py-6 text-center text-xs text-muted-foreground">No results for "{query}"</p>
          ) : (
            groups.map(({ label, cmds }) => {
              return (
                <div key={label}>
                  <p className="px-4 py-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{label}</p>
                  {cmds.map((cmd) => {
                    const Icon = cmd.icon;
                    const idx = filtered.indexOf(cmd);
                    return (
                      <button
                        key={cmd.id}
                        onMouseEnter={() => setSelected(idx)}
                        onClick={() => run(cmd.href)}
                        className={cn("flex items-center gap-3 w-full px-4 py-2.5 text-sm text-left transition-colors", idx === selected ? "bg-muted/40 text-foreground" : "text-muted-foreground hover:text-foreground")}
                      >
                        <Icon className="h-4 w-4 shrink-0" />
                        <span className="flex-1">{cmd.label}</span>
                        {idx === selected && <ArrowRight className="h-3.5 w-3.5 opacity-50" />}
                      </button>
                    );
                  })}
                </div>
              );
            })
          )}
        </div>

        {/* Footer hint */}
        <div className="border-t border-border px-4 py-2 flex items-center gap-4 text-[10px] text-muted-foreground">
          <span><kbd className="border border-border rounded px-1">↑↓</kbd> navigate</span>
          <span><kbd className="border border-border rounded px-1">↵</kbd> open</span>
          <span><kbd className="border border-border rounded px-1">⌘K</kbd> close</span>
        </div>
      </div>
    </div>
  );
}
