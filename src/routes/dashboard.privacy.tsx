import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Shield, Search, Download, Trash2, AlertTriangle, CheckCircle2, XCircle, Database } from "lucide-react";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/dashboard/privacy")({
  head: () => ({ meta: [{ title: "Data Privacy — Continuum" }] }),
  component: PrivacyPage,
});

interface DataHeld {
  contact: { id: string; firstName: string | null; lastName: string | null; createdAt: string } | null;
  verifications: number;
  messages_sent: number;
  suppression: { reason: string; since: string } | null;
  leads: number;
  sequence_enrollments: number;
  automation_enrollments: number;
  campaign_recipients: number;
}

interface DataSubjectResponse {
  email: string;
  data_held: DataHeld;
  generated_at: string;
}

interface EraseResponse {
  email: string;
  erased: boolean;
  suppressed: boolean;
  erasure_timestamp: string;
  note: string;
}

function DataRow({ label, value, highlight }: { label: string; value: string | number | null; highlight?: boolean }) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-border last:border-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className={cn("text-sm font-medium tabular-nums", highlight && "text-[oklch(0.58_0.22_27)]")}>
        {value === null || value === undefined ? "—" : String(value)}
      </span>
    </div>
  );
}

function PrivacyPage() {
  const { primaryKey } = useAuth();
  const [searchEmail, setSearchEmail] = useState("");
  const [result, setResult] = useState<DataSubjectResponse | null>(null);
  const [searching, setSearching] = useState(false);
  const [erasing, setErasing] = useState(false);
  const [erased, setErased] = useState<EraseResponse | null>(null);
  const [confirmEmail, setConfirmEmail] = useState("");
  const [showConfirm, setShowConfirm] = useState(false);

  const search = async () => {
    if (!primaryKey?.keyRaw || !searchEmail.trim()) return;
    setSearching(true);
    setResult(null);
    setErased(null);
    try {
      const res = await fetch(
        `https://api.continuumapi.com/v1/privacy/data-subject?email=${encodeURIComponent(searchEmail.trim())}`,
        { headers: { "X-API-Key": primaryKey.keyRaw } },
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error ?? "Lookup failed");
      }
      setResult(await res.json() as DataSubjectResponse);
    } catch (e: unknown) {
      toast.error((e as Error).message);
    } finally {
      setSearching(false);
    }
  };

  const erase = async () => {
    if (!primaryKey?.keyRaw || !result) return;
    setErasing(true);
    try {
      const res = await fetch("https://api.continuumapi.com/v1/privacy/data-subject", {
        method: "DELETE",
        headers: { "Content-Type": "application/json", "X-API-Key": primaryKey.keyRaw },
        body: JSON.stringify({ email: result.email }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error ?? "Erasure failed");
      }
      const data = await res.json() as EraseResponse;
      setErased(data);
      setResult(null);
      setShowConfirm(false);
      setConfirmEmail("");
      toast.success("Data erased and address suppressed");
    } catch (e: unknown) {
      toast.error((e as Error).message);
    } finally {
      setErasing(false);
    }
  };

  const exportJson = () => {
    if (!result) return;
    const blob = new Blob([JSON.stringify(result, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `data-subject-${result.email.replace("@", "_at_")}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const d = result?.data_held;
  const totalRecords =
    (d?.verifications ?? 0) +
    (d?.messages_sent ?? 0) +
    (d?.leads ?? 0) +
    (d?.sequence_enrollments ?? 0) +
    (d?.automation_enrollments ?? 0) +
    (d?.campaign_recipients ?? 0) +
    (d?.contact ? 1 : 0);

  return (
    <div className="space-y-6 max-w-2xl">
      <header>
        <div className="flex items-center gap-2 mb-1">
          <Shield className="h-5 w-5" />
          <h1 className="text-2xl font-display font-medium tracking-tight">Data Privacy</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          GDPR Article 15 (right of access) and Article 17 (right to erasure). Look up all data
          held for a contact, export it, or permanently delete it.
        </p>
      </header>

      {/* Lookup */}
      <div className="rounded-lg border border-border bg-card p-5 space-y-4">
        <h2 className="text-sm font-semibold">Look up a contact</h2>
        <div className="flex gap-2">
          <Input
            type="email"
            placeholder="contact@example.com"
            value={searchEmail}
            onChange={(e) => { setSearchEmail(e.target.value); setResult(null); setErased(null); }}
            onKeyDown={(e) => e.key === "Enter" && search()}
            className="flex-1"
          />
          <Button onClick={search} disabled={searching || !searchEmail.trim()} className="gap-1.5">
            <Search className="h-4 w-4" />
            {searching ? "Searching…" : "Lookup"}
          </Button>
        </div>
      </div>

      {/* Results */}
      {result && (
        <div className="rounded-lg border border-border bg-card overflow-hidden">
          <div className="flex items-center justify-between px-5 py-3 border-b border-border">
            <div>
              <p className="text-sm font-semibold">{result.email}</p>
              <p className="text-xs text-muted-foreground">
                {totalRecords} record{totalRecords !== 1 ? "s" : ""} found · queried {new Date(result.generated_at).toLocaleTimeString()}
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={exportJson} className="gap-1.5">
              <Download className="h-3.5 w-3.5" />
              Export JSON
            </Button>
          </div>

          <div className="px-5 py-2">
            {d?.contact ? (
              <DataRow
                label="Contact record"
                value={`${d.contact.firstName ?? ""} ${d.contact.lastName ?? ""}`.trim() || "(no name) · " + new Date(d.contact.createdAt).toLocaleDateString()}
              />
            ) : (
              <DataRow label="Contact record" value="None" />
            )}
            <DataRow label="Verification requests" value={d?.verifications ?? 0} />
            <DataRow label="Messages sent to this address" value={d?.messages_sent ?? 0} />
            <DataRow label="Lead records" value={d?.leads ?? 0} />
            <DataRow label="Sequence enrollments" value={d?.sequence_enrollments ?? 0} />
            <DataRow label="Automation enrollments" value={d?.automation_enrollments ?? 0} />
            <DataRow label="Campaign recipients" value={d?.campaign_recipients ?? 0} />
            <DataRow
              label="Suppression status"
              value={d?.suppression ? `Suppressed (${d.suppression.reason}) since ${new Date(d.suppression.since).toLocaleDateString()}` : "Not suppressed"}
              highlight={!!d?.suppression}
            />
          </div>

          {totalRecords > 0 && (
            <div className="border-t border-border px-5 py-4">
              {!showConfirm ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5 text-[oklch(0.58_0.22_27)] border-[oklch(0.85_0.12_27)] hover:bg-[oklch(0.97_0.04_27)]"
                  onClick={() => setShowConfirm(true)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Erase all data (GDPR Art. 17)
                </Button>
              ) : (
                <div className="space-y-3">
                  <div className="flex items-start gap-2 rounded-md bg-[oklch(0.97_0.04_27)] border border-[oklch(0.85_0.12_27)] p-3">
                    <AlertTriangle className="h-4 w-4 text-[oklch(0.58_0.22_27)] mt-0.5 shrink-0" />
                    <p className="text-xs text-[oklch(0.40_0.15_27)]">
                      This permanently deletes all records for <strong>{result.email}</strong> and adds the
                      address to your suppression list. This action cannot be undone.
                    </p>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">
                      Type <strong>{result.email}</strong> to confirm
                    </Label>
                    <Input
                      className="h-8 text-xs"
                      placeholder={result.email}
                      value={confirmEmail}
                      onChange={(e) => setConfirmEmail(e.target.value)}
                    />
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      className="gap-1.5 bg-[oklch(0.58_0.22_27)] hover:bg-[oklch(0.50_0.22_27)] text-white"
                      onClick={erase}
                      disabled={erasing || confirmEmail !== result.email}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      {erasing ? "Erasing…" : "Confirm erasure"}
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => { setShowConfirm(false); setConfirmEmail(""); }}>
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Erasure receipt */}
      {erased && (
        <div className="rounded-lg border border-border bg-card p-5 space-y-3">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-5 w-5 text-[oklch(0.55_0.16_145)]" />
            <p className="text-sm font-semibold">Erasure complete</p>
          </div>
          <div className="text-xs text-muted-foreground space-y-1">
            <p><strong>Address:</strong> {erased.email}</p>
            <p><strong>Completed:</strong> {new Date(erased.erasure_timestamp).toLocaleString()}</p>
            <p><strong>Suppressed:</strong> {erased.suppressed ? "Yes — future sends to this address are blocked" : "No"}</p>
            <p className="pt-1">{erased.note}</p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              const content = JSON.stringify(erased, null, 2);
              const blob = new Blob([content], { type: "application/json" });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = `erasure-receipt-${erased.email.replace("@", "_at_")}.json`;
              a.click();
              URL.revokeObjectURL(url);
            }}
            className="gap-1.5"
          >
            <Download className="h-3.5 w-3.5" />
            Download erasure receipt
          </Button>
        </div>
      )}

      {/* Info box */}
      <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-2">
        <div className="flex items-center gap-1.5">
          <Database className="h-3.5 w-3.5 text-muted-foreground" />
          <p className="text-xs font-medium">What data is covered</p>
        </div>
        <ul className="text-xs text-muted-foreground space-y-1 list-inside list-disc">
          <li>Contact records and mailing list memberships</li>
          <li>Email verification history</li>
          <li>Outbound message records (send history)</li>
          <li>Lead and prospect records</li>
          <li>Sequence and automation enrollments</li>
          <li>Campaign recipient records</li>
        </ul>
        <p className="text-xs text-muted-foreground pt-1">
          Erasure also adds the address to your suppression list to prevent future contact, fulfilling
          the opt-out requirement under GDPR, CAN-SPAM, and CASL.
        </p>
      </div>
    </div>
  );
}
