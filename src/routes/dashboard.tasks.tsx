import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import { CheckSquare, RefreshCw, Linkedin, Phone, User, Check, GitBranch } from "lucide-react";

export const Route = createFileRoute("/dashboard/tasks")({
  head: () => ({ meta: [{ title: "Tasks — Continuum" }] }),
  component: TasksPage,
});

interface Task {
  enrollmentId: string;
  sequenceId: string;
  sequenceName: string;
  email: string;
  stepType: string;
  subject: string | null;
  taskNote: string | null;
  waitingSince: string | null;
}

const STEP_ICON: Record<string, typeof Linkedin> = {
  linkedin: Linkedin,
  call: Phone,
};

function timeSince(iso: string | null): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `${days}d ago`;
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 1) return `${hours}h ago`;
  return "just now";
}

function TasksPage() {
  const { primaryKey } = useAuth();
  const navigate = useNavigate();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [completingId, setCompletingId] = useState<string | null>(null);

  const load = () => {
    if (!primaryKey?.keyRaw) return;
    setLoading(true);
    api.withKey
      .get<{ data: Task[]; total: number }>("/v1/tasks", primaryKey.keyRaw)
      .then((r) => setTasks(r.data ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [primaryKey]);

  const complete = async (t: Task) => {
    if (!primaryKey?.keyRaw) return;
    setCompletingId(t.enrollmentId);
    try {
      await api.withKey.post(
        `/v1/sequences/${t.sequenceId}/enrollments/${t.enrollmentId}/complete-task`,
        {},
        primaryKey.keyRaw,
      );
      setTasks((prev) => prev.filter((x) => x.enrollmentId !== t.enrollmentId));
      toast.success(`Marked done for ${t.email}.`);
    } catch {
      toast.error("Couldn't mark this done — try again.");
    } finally {
      setCompletingId(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <header>
          <h1 className="text-2xl font-display font-medium tracking-tight">Tasks</h1>
          <p className="text-sm text-muted-foreground">
            LinkedIn touches and calls your sequences are waiting on you for — nothing here auto-advances until you mark it done.
          </p>
        </header>
        <Button variant="outline" size="sm" className="gap-1.5" onClick={load}>
          <RefreshCw className="h-4 w-4" /> Refresh
        </Button>
      </div>

      {loading ? (
        <div className="rounded-lg border border-border bg-card divide-y divide-border overflow-hidden">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="px-5 py-4 flex items-start gap-4">
              <div className="flex-1 space-y-2">
                <div className="h-3 w-40 bg-muted rounded animate-pulse" />
                <div className="h-3 w-56 bg-muted rounded animate-pulse" />
              </div>
            </div>
          ))}
        </div>
      ) : tasks.length === 0 ? (
        <div className="rounded-lg border border-border bg-card p-10 text-center">
          <CheckSquare className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
          <p className="text-sm text-muted-foreground mb-1">No pending tasks.</p>
          <p className="text-xs text-muted-foreground">LinkedIn and call steps from your sequences will show up here as they come due.</p>
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-card overflow-hidden">
          <div className="divide-y divide-border">
            {tasks.map((t) => {
              const Icon = STEP_ICON[t.stepType] ?? CheckSquare;
              return (
                <div key={t.enrollmentId} className="flex items-start gap-4 p-4 hover:bg-muted/20 transition-colors">
                  <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center shrink-0 mt-0.5">
                    <Icon className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <button
                        className="font-medium text-sm hover:underline"
                        onClick={() => navigate({ to: "/dashboard/leads", search: { q: t.email } as never })}
                      >
                        {t.email}
                      </button>
                      <span className="text-xs bg-muted px-1.5 py-0.5 rounded capitalize">{t.stepType}</span>
                      <button
                        className="text-xs text-muted-foreground hover:underline flex items-center gap-1"
                        onClick={() => navigate({ to: "/dashboard/sequences" })}
                      >
                        <GitBranch className="h-3 w-3" /> {t.sequenceName}
                      </button>
                    </div>
                    {(t.taskNote || t.subject) && (
                      <p className="text-sm text-muted-foreground mt-0.5">{t.taskNote ?? t.subject}</p>
                    )}
                    <p className="text-[11px] text-muted-foreground mt-1">Waiting since {timeSince(t.waitingSince)}</p>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      className="p-1 rounded hover:bg-muted text-muted-foreground"
                      onClick={() => navigate({ to: "/dashboard/leads/$id", params: { id: t.email } })}
                      title="View lead profile"
                    >
                      <User className="h-3.5 w-3.5" />
                    </button>
                    <Button
                      size="sm"
                      className="h-7 gap-1.5 text-xs"
                      disabled={completingId === t.enrollmentId}
                      onClick={() => complete(t)}
                    >
                      <Check className="h-3 w-3" />
                      {completingId === t.enrollmentId ? "…" : "Done"}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
