import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { CalendarDays, Megaphone, Send, RefreshCw, ChevronDown, ChevronRight } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

export const Route = createFileRoute("/dashboard/schedule")({
  component: SchedulePage,
});

interface ScheduleItem {
  id: string;
  kind: "transactional" | "campaign";
  label: string;
  detail: string;
  scheduledAt: string;
  status: string;
  recipients: number;
}

interface ScheduleDay {
  date: string;
  count: number;
  items: ScheduleItem[];
}

interface ScheduleResponse {
  total: number;
  items: ScheduleItem[];
  by_date: ScheduleDay[];
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function formatDate(dateStr: string) {
  const d = new Date(dateStr + "T00:00:00");
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (d.getTime() === today.getTime()) return "Today";
  if (d.getTime() === tomorrow.getTime()) return "Tomorrow";
  return d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}

function daysFromNow(dateStr: string) {
  const diff = new Date(dateStr + "T00:00:00").getTime() - new Date().setHours(0, 0, 0, 0);
  return Math.ceil(diff / (1000 * 60 * 60 * 24));
}

function ItemRow({ item }: { item: ScheduleItem }) {
  const isTransactional = item.kind === "transactional";
  const Icon = isTransactional ? Send : Megaphone;
  return (
    <div className="flex items-start gap-3 py-2.5 px-4 hover:bg-muted/30 transition-colors">
      <div className="mt-0.5 h-6 w-6 rounded flex items-center justify-center bg-muted shrink-0">
        <Icon className="h-3 w-3 text-muted-foreground" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">{item.label}</p>
        <p className="text-xs text-muted-foreground truncate">{item.detail}</p>
      </div>
      <div className="text-right shrink-0 space-y-0.5">
        <p className="text-xs font-mono text-muted-foreground">{formatTime(item.scheduledAt)}</p>
        {item.recipients > 1 && (
          <p className="text-[10px] text-muted-foreground">{item.recipients.toLocaleString()} recipients</p>
        )}
      </div>
    </div>
  );
}

function DayCard({ day, defaultOpen }: { day: ScheduleDay; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const days = daysFromNow(day.date);
  const urgencyClass = days === 0
    ? "border-[oklch(0.55_0.16_145)]/50 bg-[oklch(0.55_0.16_145)]/5"
    : days === 1
    ? "border-[oklch(0.65_0.14_75)]/40 bg-[oklch(0.65_0.14_75)]/5"
    : "border-border bg-card";

  return (
    <div className={`rounded-lg border overflow-hidden ${urgencyClass}`}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-4 py-3 text-left"
      >
        <div className="flex items-center gap-3">
          {open ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
          <div>
            <span className="text-sm font-medium">{formatDate(day.date)}</span>
            <span className="ml-2 text-xs text-muted-foreground">
              {day.date}
            </span>
          </div>
        </div>
        <span className="text-xs font-medium bg-muted rounded-full px-2 py-0.5">
          {day.count} {day.count === 1 ? "send" : "sends"}
        </span>
      </button>
      {open && (
        <div className="border-t border-border divide-y divide-border/60">
          {day.items.map((item) => (
            <ItemRow key={item.id} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}

function SkeletonSchedule() {
  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <Skeleton className="h-8 w-48 mb-2" />
          <Skeleton className="h-4 w-64" />
        </div>
        <Skeleton className="h-8 w-24" />
      </header>
      {[...Array(3)].map((_, i) => (
        <div key={i} className="rounded-lg border border-border bg-card p-4 space-y-3">
          <Skeleton className="h-5 w-32" />
          {[...Array(2)].map((_, j) => <Skeleton key={j} className="h-10 w-full" />)}
        </div>
      ))}
    </div>
  );
}

function SchedulePage() {
  const { primaryKey, loading: authLoading } = useAuth();
  const [data, setData] = useState<ScheduleResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = async (showSpinner = false) => {
    if (!primaryKey?.keyRaw) { setLoading(false); return; }
    if (showSpinner) setRefreshing(true);
    try {
      const res = await api.withKey.get<ScheduleResponse>("/v1/analytics/schedule", primaryKey.keyRaw);
      setData(res);
    } catch {}
    finally { setLoading(false); setRefreshing(false); }
  };

  useEffect(() => { load(); }, [primaryKey]);

  if (authLoading || loading) return <SkeletonSchedule />;

  const empty = !data || data.total === 0;

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-display font-medium tracking-tight">Scheduled Sends</h1>
          <p className="text-sm text-muted-foreground">Upcoming sends in the next 30 days.</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => load(true)} disabled={refreshing} className="gap-1.5 shrink-0">
          <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </header>

      {/* Summary strip */}
      {!empty && data && (
        <div className="grid grid-cols-3 gap-3">
          {[
            { label: "Total scheduled", value: data.total },
            {
              label: "Campaigns",
              value: data.items.filter((i) => i.kind === "campaign").length,
            },
            {
              label: "Transactional",
              value: data.items.filter((i) => i.kind === "transactional").length,
            },
          ].map(({ label, value }) => (
            <div key={label} className="rounded-lg border border-border bg-card p-4">
              <p className="text-xs text-muted-foreground">{label}</p>
              <p className="text-2xl font-display font-medium tabular-nums mt-0.5">{value.toLocaleString()}</p>
            </div>
          ))}
        </div>
      )}

      {empty ? (
        <div className="rounded-lg border border-border bg-card p-12 text-center">
          <CalendarDays className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
          <h2 className="text-sm font-medium mb-1">Nothing scheduled</h2>
          <p className="text-sm text-muted-foreground">
            Schedule a transactional email or campaign and it will appear here.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {data!.by_date.map((day, i) => (
            <DayCard key={day.date} day={day} defaultOpen={i < 3} />
          ))}
        </div>
      )}
    </div>
  );
}
