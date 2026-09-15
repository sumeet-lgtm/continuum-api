import { useEffect, useState } from "react";
import { CheckCircle2, AlertTriangle, PauseCircle, Info, XCircle } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

// Shared "visually agentic" surface — renders an AgentRun's event feed for
// whichever pillar it belongs to (config: {AgentRun,AgentRunEvent} in
// continuum-deploy/prisma/schema.prisma). One component, reused by every
// pillar's dashboard page instead of a bespoke feed per pillar.

interface AgentEvent {
  id: string;
  eventType: string;
  message: string;
  data: Record<string, unknown> | null;
  createdAt: string;
}

function eventIcon(eventType: string) {
  switch (eventType) {
    case "verified":
    case "tick_complete":
      return <CheckCircle2 className="h-3.5 w-3.5 text-[oklch(0.55_0.14_145)]" />;
    case "quota_exhausted":
      return <PauseCircle className="h-3.5 w-3.5 text-[oklch(0.6_0.14_75)]" />;
    case "error":
      return <XCircle className="h-3.5 w-3.5 text-[oklch(0.55_0.2_27)]" />;
    case "auto_paused":
      return <AlertTriangle className="h-3.5 w-3.5 text-[oklch(0.6_0.14_75)]" />;
    default:
      return <Info className="h-3.5 w-3.5 text-muted-foreground" />;
  }
}

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function AgentActivityFeed({
  agentRunId,
  apiKey,
  limit = 30,
  className,
}: {
  agentRunId: string;
  apiKey: string;
  limit?: number;
  className?: string;
}) {
  const [events, setEvents] = useState<AgentEvent[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setEvents(null);
    api.withKey
      .get<{ data: AgentEvent[] }>(`/v1/agent-runs/${agentRunId}/events?limit=${limit}`, apiKey)
      .then((res) => { if (!cancelled) setEvents(res.data ?? []); })
      .catch(() => { if (!cancelled) setEvents([]); });
    return () => { cancelled = true; };
  }, [agentRunId, apiKey, limit]);

  if (events === null) {
    return (
      <div className={cn("space-y-2 p-4", className)}>
        {[...Array(3)].map((_, i) => (
          <div key={i} className="h-3 w-3/4 bg-muted rounded animate-pulse" />
        ))}
      </div>
    );
  }

  if (events.length === 0) {
    return (
      <div className={cn("p-6 text-center text-xs text-muted-foreground", className)}>
        No activity yet — the agent hasn't ticked for this watch.
      </div>
    );
  }

  return (
    <div className={cn("divide-y divide-border max-h-96 overflow-y-auto", className)}>
      {events.map((e) => (
        <div key={e.id} className="flex items-start gap-2.5 px-4 py-2.5">
          <div className="mt-0.5 shrink-0">{eventIcon(e.eventType)}</div>
          <div className="min-w-0 flex-1">
            <p className="text-xs leading-relaxed">{e.message}</p>
          </div>
          <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums" title={new Date(e.createdAt).toLocaleString()}>
            {relativeTime(e.createdAt)}
          </span>
        </div>
      ))}
    </div>
  );
}
