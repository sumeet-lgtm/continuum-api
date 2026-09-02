import { Link, Outlet, createFileRoute, useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  LayoutDashboard,
  KeyRound,
  Mail,
  Phone,
  Globe,
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
  SlidersHorizontal,
  Layers,
  Zap,
  ArrowRightLeft,
  Building2,
  ShieldCheck,
  Wrench,
  Plug,
} from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { Wordmark } from "@/components/Logo";
import { Toaster } from "@/components/ui/sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

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
  {
    to: "/dashboard/transactional",
    label: "Transactional",
    icon: Send,
    children: [
      { to: "/dashboard/transactional", label: "Send Email", icon: Send, exact: true },
      { to: "/dashboard/batch-send", label: "Batch Send", icon: Layers },
      { to: "/dashboard/messages", label: "Message History", icon: Mail },
      { to: "/dashboard/templates", label: "Templates", icon: FileText },
      { to: "/dashboard/domains", label: "Sending Domains", icon: ServerCog },
      { to: "/dashboard/suppressions", label: "Suppressions", icon: ShieldOff },
    ],
  },
  {
    to: "/dashboard/campaigns",
    label: "Campaigns",
    icon: Megaphone,
    children: [
      { to: "/dashboard/campaigns", label: "All Campaigns", icon: Megaphone, exact: true },
      { to: "/dashboard/automations", label: "Autoresponders", icon: Zap },
      { to: "/dashboard/lists", label: "Mailing Lists", icon: Users },
      { to: "/dashboard/contacts", label: "Contacts", icon: UserRound },
      { to: "/dashboard/segments", label: "Segments", icon: SlidersHorizontal },
      { to: "/dashboard/migrate", label: "Migrate", icon: ArrowRightLeft },
    ],
  },
  {
    to: "/dashboard/sequences",
    label: "Sequences",
    icon: GitBranch,
    children: [
      { to: "/dashboard/sequences", label: "All Sequences", icon: GitBranch, exact: true },
      { to: "/dashboard/leads", label: "Leads", icon: Users },
      { to: "/dashboard/mailboxes", label: "Mailboxes", icon: Send },
      { to: "/dashboard/inbox", label: "Unified Inbox", icon: Inbox },
      { to: "/dashboard/inbox-test", label: "Inbox Placement", icon: FlaskConical },
      { to: "/dashboard/ai", label: "AI Tools", icon: Sparkles },
    ],
  },
  { to: "/dashboard/analytics", label: "Analytics", icon: BarChart3 },
  { to: "/dashboard/verify", label: "Verify", icon: Mail },
  { to: "/dashboard/tools", label: "Deliverability Tools", icon: Wrench },
  { to: "/dashboard/connectors", label: "Connectors", icon: Plug },
  { to: "/dashboard/phone", label: "Phone", icon: Phone },
  { to: "/dashboard/ip", label: "IP Intelligence", icon: Globe },
  { to: "/dashboard/bulk", label: "Bulk Jobs", icon: ListChecks },
  { to: "/dashboard/monitoring", label: "Monitoring", icon: Activity },
  { to: "/dashboard/webhooks", label: "Webhooks", icon: Webhook },
  {
    to: "/dashboard/organization",
    label: "Enterprise",
    icon: Building2,
    children: [
      { to: "/dashboard/organization", label: "Organization", icon: Building2, exact: true },
      { to: "/dashboard/audit-logs", label: "Audit Logs", icon: ShieldCheck },
    ],
  },
  { to: "/dashboard/billing", label: "Billing", icon: CreditCard },
  { to: "/dashboard/settings", label: "Settings", icon: Settings },
];

// Which groups are open by default
const DEFAULT_OPEN = new Set(["/dashboard/transactional", "/dashboard/campaigns", "/dashboard/sequences"]);

function DashboardLayout() {
  const { user, loading, signOut } = useAuth();
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
    </div>
  );
}
