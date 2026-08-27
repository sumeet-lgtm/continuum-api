import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { API_BASE } from "@/lib/supabase";
import { useApiKey } from "@/lib/use-api-key";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";

export const Route = createFileRoute("/dashboard/monitoring")({
  component: MonitoringPage,
});

interface Monitor {
  id: string;
  email: string;
  lastStatus: string | null;
  intervalHours: number | null;
  lastCheckedAt: string | null;
  nextCheckAt: string | null;
  isPaused: boolean;
}

interface CheckLog {
  id: string;
  status: string;
  checkedAt: string;
}

const INTERVALS = [1, 6, 12, 24, 48, 72, 168];

function MonitoringPage() {
  const { apiKey } = useApiKey();
  const [items, setItems] = useState<Monitor[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [interval, setInterval] = useState(24);
  const [active, setActive] = useState<Monitor | null>(null);
  const [history, setHistory] = useState<CheckLog[]>([]);

  const load = async () => {
    if (!apiKey?.keyRaw) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/v1/monitoring`, {
        headers: { Authorization: `Bearer ${apiKey.keyRaw}` },
      });
      if (res.ok) {
        const data = await res.json();
        const list = Array.isArray(data) ? data : (data?.data ?? data?.monitors ?? []);
        setItems(list as Monitor[]);
      } else {
        setItems([]);
      }
    } catch {
      setItems([]);
    }
    setLoading(false);
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey?.id]);

  const addMonitor = async () => {
    if (!apiKey?.keyRaw || !email) return;
    await fetch(`${API_BASE}/v1/monitoring`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey.keyRaw}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email, intervalHours: interval }),
    });
    setEmail("");
    setInterval(24);
    setOpen(false);
    await load();
  };

  const togglePause = async (m: Monitor) => {
    if (!apiKey?.keyRaw) return;
    await fetch(`${API_BASE}/v1/monitoring/${m.id}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${apiKey.keyRaw}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ isPaused: !m.isPaused }),
    });
    await load();
  };

  const removeMonitor = async (m: Monitor) => {
    if (!apiKey?.keyRaw) return;
    if (!confirm(`Stop monitoring ${m.email}?`)) return;
    await fetch(`${API_BASE}/v1/monitoring/${m.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${apiKey.keyRaw}` },
    });
    if (active?.id === m.id) setActive(null);
    await load();
  };

  const recheck = async (m: Monitor) => {
    if (!apiKey?.keyRaw) return;
    try {
      await fetch(`${API_BASE}/v1/monitoring/${m.id}/check`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey.keyRaw}`, "x-api-key": apiKey.keyRaw },
      });
    } catch {
      // ignore network — UI still refreshes
    }
    await load();
  };

  const openHistory = async (m: Monitor) => {
    setActive(m);
    setHistory([]);
    const res = await fetch(`${API_BASE}/v1/monitors/${m.id}/history?limit=50`, { headers: { "X-API-Key": apiKey?.keyRaw ?? "" } });
    const data = res.ok ? await res.json() : [];
    setHistory((data ?? []) as CheckLog[]);
  };

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Monitoring</h1>
          <p className="text-sm text-muted-foreground">Continuously watch important addresses.</p>
        </div>
        <Button onClick={() => setOpen(true)} disabled={!apiKey}>
          <Plus className="h-4 w-4 mr-1.5" /> Add monitor
        </Button>
      </header>

      <div className="rounded-lg border border-border bg-card overflow-x-auto">
        {loading ? (
          <div className="p-6 text-sm text-muted-foreground">Loading…</div>
        ) : items.length === 0 ? (
          <div className="p-10 text-center text-sm text-muted-foreground">
            No monitored emails yet.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground border-b border-border">
                <th className="px-5 py-2 font-medium">Email</th>
                <th className="px-5 py-2 font-medium">Status</th>
                <th className="px-5 py-2 font-medium">Interval</th>
                <th className="px-5 py-2 font-medium">Last check</th>
                <th className="px-5 py-2 font-medium">Next check</th>
                <th className="px-5 py-2 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((m) => (
                <tr key={m.id} className="border-b border-border last:border-0">
                  <td className="px-5 py-3 font-mono text-xs cursor-pointer" onClick={() => openHistory(m)}>
                    {m.email}
                  </td>
                  <td className="px-5 py-3">
                    {m.lastStatus
                      ? <StatusBadge status={m.lastStatus} />
                      : <span className="text-xs text-muted-foreground">Pending first check</span>}
                  </td>
                  <td className="px-5 py-3 text-xs text-muted-foreground">{m.intervalHours ?? "—"}h</td>
                  <td className="px-5 py-3 text-xs text-muted-foreground">
                    {m.lastCheckedAt ? new Date(m.lastCheckedAt).toLocaleString() : "—"}
                  </td>
                  <td className="px-5 py-3 text-xs text-muted-foreground">
                    {m.nextCheckAt ? new Date(m.nextCheckAt).toLocaleString() : "—"}
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex items-center justify-end gap-1.5">
                      <Button variant="ghost" size="sm" onClick={() => recheck(m)}>Check now</Button>
                      <Button variant="ghost" size="sm" onClick={() => togglePause(m)}>
                        {m.isPaused ? "Resume" : "Pause"}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => removeMonitor(m)}>
                        Delete
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {active && (
        <div className="rounded-lg border border-border bg-card">
          <div className="px-5 py-3 border-b border-border flex items-center justify-between">
            <h2 className="text-sm font-medium font-mono">{active.email}</h2>
            <Button variant="ghost" size="sm" onClick={() => setActive(null)}>Close</Button>
          </div>
          {history.length === 0 ? (
            <div className="p-6 text-sm text-muted-foreground">No check history yet.</div>
          ) : (
            <table className="w-full text-sm">
              <tbody>
                {history.map((h) => (
                  <tr key={h.id} className="border-b border-border last:border-0">
                    <td className="px-5 py-2"><StatusBadge status={h.status} /></td>
                    <td className="px-5 py-2 text-xs text-muted-foreground text-right">
                      {new Date(h.checkedAt).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add monitor</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="m-email">Email</Label>
              <Input
                id="m-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@example.com"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Check interval</Label>
              <div className="grid grid-cols-4 gap-1.5">
                {INTERVALS.map((h) => (
                  <button
                    key={h}
                    type="button"
                    onClick={() => setInterval(h)}
                    className={`rounded-md border px-2 py-1.5 text-xs ${
                      interval === h
                        ? "border-foreground bg-foreground text-background"
                        : "border-border bg-card hover:bg-muted"
                    }`}
                  >
                    {h}h
                  </button>
                ))}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={addMonitor} disabled={!email}>Add</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
