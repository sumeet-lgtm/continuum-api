import { Link, Outlet, createFileRoute, useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import {
  LayoutDashboard,
  KeyRound,
  Mail,
  ListChecks,
  Activity,
  Webhook,
  Settings,
  LogOut,
  CreditCard,
  Sparkles,
  Send,
  Megaphone,
  GitBranch,
  Inbox,
  Users,
  BarChart3,
  ServerCog,
  FileText,
  ChevronDown,
  ChevronRight,
  FlaskConical,
  UserRound,
  ShieldOff,
  ShieldCheck,
  SlidersHorizontal,
  Layers,
  CalendarDays,
  Zap,
  Building2,
  Terminal,
  TrendingUp,
  BookOpen,
  Search,
  Bell,
  AlertCircle,
  AlertTriangle,
  Info,
  X,
  Calendar,
  ArrowRightLeft,
  Palette,
  Plug,
  Upload,
} from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { api } from "@/lib/api";
import { CommandPalette } from "@/components/CommandPalette";
import { Wordmark } from "@/components/Logo";
import { Toaster } from "@/components/ui/sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// ── Alert types ──────────────────────────────────────────────────────────────

type AlertSeverity = "error" | "warning" | "info";
interface Alert { id: string; severity: AlertSeverity; title: string; body: string; href?: string }

function severityIcon(s: AlertSeverity) {
  if (s === "error") return <AlertCircle className="h-4 w-4 text-[oklch(0.58_0.22_27)] shrink-0" />;
  if (s === "warning") return <AlertTriangle className="h-4 w-4 text-[oklch(0.65_0.16_75)] shrink-0" />;
  return <Info className="h-4 w-4 text-muted-foreground shrink-0" />;
}

function AlertsBell({ apiKey }: { apiKey: string }) {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem("cnt_dismissed_alerts") ?? "[]")); }
    catch { return new Set(); }
  });
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!apiKey) return;
    Promise.allSettled([
      api.withKey.get<{ plan: string; verifications: { used: number; limit: number; resets_at: string }; sends: { used: number; limit: number; resets_at: string } }>("/v1/usage", apiKey),
      api.withKey.get<{ data: Array<{ id: string; url: string; consecutive_failures: number; isActive: boolean }> }>("/v1/webhooks", apiKey),
      api.withKey.get<{ data: Array<{ id: string; name: string; verifiedAt: string | null }> }>("/v1/domains", apiKey),
      api.withKey.get<{ data: Array<{ id: string; label: string | null; expires_at: string | null; isActive: boolean }> }>("/v1/api-keys", apiKey),
    ]).then(([usage, webhooks, domains, keys]) => {
      const list: Alert[] = [];

      if (usage.status === "fulfilled") {
        const u = usage.value;
        const vPct = u.verifications.limit > 0 ? Math.round((u.verifications.used / u.verifications.limit) * 100) : 0;
        const sPct = u.sends.limit > 0 ? Math.round((u.sends.used / u.sends.limit) * 100) : 0;
        if (vPct >= 100) list.push({ id: "v-exhausted", severity: "error", title: "Verification credits exhausted", body: "You have used all your monthly verification credits. Add credits to continue.", href: "/dashboard/billing" });
        else if (vPct >= 90) list.push({ id: "v-critical", severity: "error", title: `${vPct}% of verification credits used`, body: `Only ${(u.verifications.limit - u.verifications.used).toLocaleString()} credits remain this month.`, href: "/dashboard/usage" });
        else if (vPct >= 80) list.push({ id: "v-warn", severity: "warning", title: `${vPct}% of verification credits used`, body: "You are approaching your monthly limit.", href: "/dashboard/usage" });
        if (sPct >= 100) list.push({ id: "s-exhausted", severity: "error", title: "Send credits exhausted", body: "You have used all your monthly send credits.", href: "/dashboard/billing" });
        else if (sPct >= 90) list.push({ id: "s-critical", severity: "error", title: `${sPct}% of send credits used`, body: `Only ${(u.sends.limit - u.sends.used).toLocaleString()} credits remain.`, href: "/dashboard/usage" });
      }

      if (webhooks.status === "fulfilled") {
        for (const wh of (webhooks.value.data ?? [])) {
          if (wh.consecutive_failures >= 5) {
            list.push({ id: `wh-${wh.id}`, severity: "error", title: "Webhook repeatedly failing", body: `${wh.url} has failed ${wh.consecutive_failures} consecutive deliveries.`, href: "/dashboard/webhooks" });
          } else if (wh.consecutive_failures >= 2) {
            list.push({ id: `wh-${wh.id}`, severity: "warning", title: "Webhook delivery failures", body: `${wh.url} has failed ${wh.consecutive_failures} consecutive deliveries.`, href: "/dashboard/webhooks" });
          }
        }
      }

      if (domains.status === "fulfilled") {
        const unverified = (domains.value.data ?? []).filter((d) => !d.verifiedAt);
        if (unverified.length === 1) list.push({ id: "domain-unverified", severity: "warning", title: "Domain not verified", body: `${unverified[0].name} DNS records have not been verified yet.`, href: "/dashboard/domains" });
        else if (unverified.length > 1) list.push({ id: "domain-unverified", severity: "warning", title: `${unverified.length} domains not verified`, body: "Finish DNS setup to start sending from these domains.", href: "/dashboard/domains" });
      }

      if (keys.status === "fulfilled") {
        const now = Date.now();
        for (const k of (keys.value.data ?? [])) {
          if (k.expires_at && k.isActive) {
            const daysLeft = Math.ceil((new Date(k.expires_at).getTime() - now) / 86400000);
            if (daysLeft <= 0) list.push({ id: `key-${k.id}-exp`, severity: "error", title: "API key expired", body: `${k.label ?? "An API key"} expired. Rotate it immediately.`, href: "/dashboard/api-keys" });
            else if (daysLeft <= 7) list.push({ id: `key-${k.id}-exp`, severity: "warning", title: `API key expiring in ${daysLeft}d`, body: `${k.label ?? "An API key"} will expire soon.`, href: "/dashboard/api-keys" });
          }
        }
      }

      setAlerts(list);
    });
  }, [apiKey]);

  useEffect(() => {
    function handle(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, []);

  function dismiss(id: string) {
    setDismissed((prev) => {
      const next = new Set(prev);
      next.add(id);
      try { localStorage.setItem("cnt_dismissed_alerts", JSON.stringify([...next])); } catch {}
      return next;
    });
  }

  const visible = alerts.filter((a) => !dismissed.has(a.id));
  const errorCount = visible.filter((a) => a.severity === "error").length;
  const warnCount = visible.filter((a) => a.severity === "warning").length;
  const badgeCount = visible.length;

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="relative flex items-center justify-center h-8 w-8 rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-muted/30 transition-colors"
        aria-label="Notifications"
      >
        <Bell className="h-4 w-4" />
        {badgeCount > 0 && (
          <span className={cn("absolute -top-1 -right-1 h-4 min-w-4 px-1 rounded-full text-[10px] font-medium text-background flex items-center justify-center tabular-nums", errorCount > 0 ? "bg-[oklch(0.58_0.22_27)]" : "bg-[oklch(0.65_0.16_75)]")}>
            {badgeCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1.5 w-80 rounded-xl border border-border bg-card shadow-lg z-50 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-border">
            <p className="text-sm font-medium">Alerts</p>
            {visible.length > 0 && (
              <button onClick={() => visible.forEach((a) => dismiss(a.id))} className="text-xs text-muted-foreground hover:text-foreground">
                Clear all
              </button>
            )}
          </div>
          {visible.length === 0 ? (
            <div className="px-4 py-6 text-center text-xs text-muted-foreground">
              <Bell className="h-6 w-6 mx-auto mb-2 opacity-30" />
              All clear — no active alerts
            </div>
          ) : (
            <div className="divide-y divide-border max-h-80 overflow-y-auto">
              {visible.map((alert) => (
                <div key={alert.id} className="flex items-start gap-3 px-4 py-3 hover:bg-muted/10">
                  {severityIcon(alert.severity)}
                  <div className="flex-1 min-w-0">
                    {alert.href ? (
                      <Link to={alert.href as "/dashboard"} onClick={() => setOpen(false)} className="text-xs font-medium hover:underline block truncate">{alert.title}</Link>
                    ) : (
                      <p className="text-xs font-medium truncate">{alert.title}</p>
                    )}
                    <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">{alert.body}</p>
                  </div>
                  <button onClick={() => dismiss(alert.id)} className="text-muted-foreground hover:text-foreground mt-0.5 shrink-0">
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export const Route = createFileRoute("/dashboard")({
  component: DashboardLayout,
});

type NavItem = {
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
  exact?: boolean;
  children?: NavItem[];
};

const NAV: NavItem[] = [
  { to: "/dashboard", label: "Overview", icon: LayoutDashboard, exact: true },
  { to: "/dashboard/api-keys", label: "API Keys", icon: KeyRound },
  { to: "/dashboard/logs", label: "API Logs", icon: Terminal },

  // Pillar 1: Verification — competes with MillionVerifier
  {
    to: "/dashboard/verify",
    label: "Verification",
    icon: ShieldCheck,
    children: [
      { to: "/dashboard/verify", label: "Single Verify", icon: ShieldCheck, exact: true },
      { to: "/dashboard/bulk", label: "Bulk Jobs", icon: ListChecks },
      { to: "/dashboard/monitoring", label: "Monitoring", icon: Activity },
    ],
  },

  // Pillar 2: Transactional — competes with Resend
  {
    to: "/dashboard/transactional",
    label: "Transactional",
    icon: Send,
    children: [
      { to: "/dashboard/transactional", label: "Send Email", icon: Send, exact: true },
      { to: "/dashboard/batch-send", label: "Batch Send", icon: Layers },
      { to: "/dashboard/messages", label: "Message History", icon: Mail },
      { to: "/dashboard/schedule", label: "Schedule", icon: CalendarDays },
      { to: "/dashboard/templates", label: "Templates", icon: FileText },
      { to: "/dashboard/domains", label: "Sending Domains", icon: ServerCog },
      { to: "/dashboard/deliverability", label: "Deliverability", icon: TrendingUp },
      { to: "/dashboard/suppressions", label: "Suppressions", icon: ShieldOff },
    ],
  },

  // Pillar 3: Nurture — competes with Sendy
  {
    to: "/dashboard/campaigns",
    label: "Nurture",
    icon: Megaphone,
    children: [
      { to: "/dashboard/campaigns", label: "Campaigns", icon: Megaphone, exact: true },
      { to: "/dashboard/automations", label: "Automations", icon: Zap },
      { to: "/dashboard/lists", label: "Mailing Lists", icon: Users },
      { to: "/dashboard/contacts", label: "Contacts", icon: UserRound },
      { to: "/dashboard/segments", label: "Segments", icon: SlidersHorizontal },
      { to: "/dashboard/migrate", label: "Import Contacts", icon: ArrowRightLeft },
      { to: "/dashboard/import", label: "Import CSV", icon: Upload },
    ],
  },

  // Pillar 4: Outbound — competes with Smartlead / Outreach
  {
    to: "/dashboard/sequences",
    label: "Outbound",
    icon: GitBranch,
    children: [
      { to: "/dashboard/sequences", label: "Sequences", icon: GitBranch, exact: true },
      { to: "/dashboard/accounts", label: "Accounts", icon: Building2 },
      { to: "/dashboard/mailboxes", label: "Mailboxes", icon: Mail },
      { to: "/dashboard/inbox", label: "Unified Inbox", icon: Inbox },
    ],
  },

  // Pillar 5: Finder — competes with Apollo
  {
    to: "/dashboard/finder",
    label: "Finder",
    icon: Search,
    children: [
      { to: "/dashboard/finder", label: "Find People", icon: Search, exact: true },
      { to: "/dashboard/leads", label: "Lead CRM", icon: Users },
    ],
  },

  { to: "/dashboard/analytics", label: "Analytics", icon: BarChart3 },
  { to: "/dashboard/brand-kit", label: "Brand Kit", icon: Palette },
  { to: "/dashboard/connectors", label: "Connectors", icon: Plug },
  { to: "/dashboard/webhooks", label: "Webhooks", icon: Webhook },
  { to: "/dashboard/organization", label: "Organization", icon: Building2 },
  { to: "/dashboard/usage", label: "Usage & Limits", icon: Zap },
  { to: "/dashboard/billing", label: "Billing", icon: CreditCard },
  { to: "/dashboard/team", label: "Team", icon: Users },
  { to: "/dashboard/settings", label: "Settings", icon: Settings },
];

const DEFAULT_OPEN = new Set([
  "/dashboard/verify",
  "/dashboard/transactional",
  "/dashboard/campaigns",
  "/dashboard/sequences",
  "/dashboard/finder",
]);

function DashboardLayout() {
  const { user, loading, signOut, primaryKey } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [openGroups, setOpenGroups] = useState<Set<string>>(DEFAULT_OPEN);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  useEffect(() => {
    if (!loading && !user) navigate({ to: "/login" });
  }, [loading, user, navigate]);

  if (loading || !user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-border border-t-foreground" />
      </div>
    );
  }

  const isActive = (to: string, exact?: boolean) =>
    exact ? location.pathname === to : location.pathname === to || location.pathname.startsWith(to + "/");

  const toggleGroup = (to: string) => {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(to)) next.delete(to);
      else next.add(to);
      return next;
    });
  };

  const renderNavItem = (item: NavItem, depth = 0) => {
    const Icon = item.icon;
    const active = isActive(item.to, item.exact);
    const hasChildren = item.children && item.children.length > 0;
    const isOpen = openGroups.has(item.to);

    if (hasChildren) {
      const groupActive = location.pathname.startsWith(item.to);
      return (
        <div key={item.to}>
          <button
            onClick={() => toggleGroup(item.to)}
            className={cn(
              "flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors",
              groupActive ? "text-foreground" : "text-muted-foreground hover:bg-background hover:text-foreground",
            )}
          >
            <Icon className="h-4 w-4 shrink-0" />
            <span className="flex-1 text-left">{item.label}</span>
            {isOpen ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
          </button>
          {isOpen && (
            <div className="ml-3 mt-0.5 border-l border-border pl-3 space-y-0.5">
              {item.children!.map((child) => renderNavItem(child, depth + 1))}
            </div>
          )}
        </div>
      );
    }

    return (
      <Link
        key={item.to}
        to={item.to as "/dashboard"}
        className={cn(
          "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors",
          active
            ? "bg-foreground text-background"
            : depth > 0
              ? "text-muted-foreground hover:bg-background hover:text-foreground text-xs"
              : "text-muted-foreground hover:bg-background hover:text-foreground",
        )}
      >
        <Icon className="h-4 w-4 shrink-0" />
        {item.label}
      </Link>
    );
  };

  const displayName = user.firstName ? `${user.firstName} ${user.lastName ?? ""}`.trim() : user.email;

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Sidebar */}
      <aside className="hidden md:flex fixed inset-y-0 left-0 w-60 flex-col border-r border-border bg-[var(--sidebar-bg)] overflow-y-auto">
        <div className="px-5 py-5 flex items-center gap-2 shrink-0">
          <Wordmark size={24} />
        </div>
        <nav className="mt-2 flex-1 px-3 space-y-0.5 pb-4">
          {NAV.map((item) => renderNavItem(item))}
        </nav>
        <div className="border-t border-border p-3 shrink-0">
          <a
            href="https://cal.com/sumeet-sutar-ecfqg3/continuum-api-email-infrastructure-consultation"
            target="_blank"
            rel="noopener noreferrer"
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground hover:bg-background hover:text-foreground transition-colors mb-0.5"
          >
            <Calendar className="h-4 w-4 shrink-0" />
            Talk to an expert
          </a>
          <div className="px-2 py-1.5">
            <p className="text-xs font-medium truncate">{displayName}</p>
            <p className="text-xs text-muted-foreground truncate">{user.email}</p>
          </div>
          <button
            onClick={signOut}
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground hover:bg-background hover:text-foreground transition-colors"
          >
            <LogOut className="h-4 w-4" />
            Sign out
          </button>
        </div>
      </aside>

      {/* Mobile top bar */}
      <header className="md:hidden flex items-center justify-between border-b border-border bg-[var(--sidebar-bg)] px-4 py-3 sticky top-0 z-20">
        <div className="flex items-center gap-2">
          <Wordmark size={22} />
        </div>
        <button
          onClick={() => setMobileNavOpen(o => !o)}
          className="flex items-center justify-center w-8 h-8 rounded-md border border-border text-muted-foreground"
          aria-label="Menu"
        >
          {mobileNavOpen ? (
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M1 1l12 12M13 1L1 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
          ) : (
            <svg width="14" height="12" viewBox="0 0 14 12" fill="none"><path d="M0 1h14M0 6h14M0 11h14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
          )}
        </button>
      </header>

      {/* Mobile nav drawer */}
      {mobileNavOpen && (
        <div className="md:hidden fixed inset-0 z-10 bg-background pt-[53px] overflow-y-auto" onClick={(e) => { if (e.target === e.currentTarget) setMobileNavOpen(false); }}>
          <nav className="px-3 pt-3 pb-8 space-y-0.5">
            {NAV.map((item) => renderNavItem(item))}
          </nav>
          <div className="border-t border-border mx-3 pt-3 pb-6">
            <a
              href="https://cal.com/sumeet-sutar-ecfqg3/continuum-api-email-infrastructure-consultation"
              target="_blank"
              rel="noopener noreferrer"
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground hover:bg-background hover:text-foreground transition-colors mb-1"
            >
              <Calendar className="h-4 w-4 shrink-0" />
              Talk to an expert
            </a>
            <div className="px-2 py-1.5 mb-1">
              <p className="text-xs font-medium truncate">{displayName}</p>
              <p className="text-xs text-muted-foreground truncate">{user.email}</p>
            </div>
            <button
              onClick={() => { setMobileNavOpen(false); signOut(); }}
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground hover:bg-background hover:text-foreground transition-colors"
            >
              <LogOut className="h-4 w-4" />
              Sign out
            </button>
          </div>
        </div>
      )}

      {/* Main */}
      <main className="md:ml-60 pb-20 md:pb-0">
        <div className="hidden md:flex items-center justify-end gap-2 border-b border-border bg-[var(--sidebar-bg)] px-6 py-2.5">
          {/* Command palette trigger */}
          <button
            onClick={() => { const e = new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }); document.dispatchEvent(e); }}
            className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors"
          >
            <Search className="h-3.5 w-3.5" />
            <span>Search…</span>
            <kbd className="ml-2 hidden lg:inline text-[10px] border border-border rounded px-1">⌘K</kbd>
          </button>
          {primaryKey?.keyRaw && <AlertsBell apiKey={primaryKey.keyRaw} />}
          <Link to="/dashboard/billing">
            <Button size="sm" className="gap-1.5">
              <Sparkles className="h-3.5 w-3.5" />
              Upgrade
            </Button>
          </Link>
        </div>
        <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8 py-6 md:py-8">
          <Outlet />
        </div>
      </main>
      <Toaster />
      <CommandPalette />
    </div>
  );
}
