import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import {
  ArrowRightLeft,
  Upload,
  ChevronRight,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Plus,
  ArrowLeft,
  FileText,
  Users,
} from "lucide-react";

export const Route = createFileRoute("/dashboard/migrate")({
  head: () => ({ meta: [{ title: "Migrate Contacts — Continuum" }] }),
  component: MigratePage,
});

// ── Platform definitions ─────────────────────────────────────────────────────

type PlatformId = "mailchimp" | "sendgrid" | "klaviyo" | "instantly" | "smartlead" | "csv";

interface Platform {
  id: PlatformId;
  name: string;
  description: string;
  emailCols: string[];       // possible header names for email
  firstNameCols: string[];
  lastNameCols: string[];
  statusCols: string[];      // column that holds subscribe/unsubscribe status
  suppressedValues: string[]; // values in status col that mean "suppress"
  icon: React.ReactNode;
}

const PLATFORMS: Platform[] = [
  {
    id: "mailchimp",
    name: "Mailchimp",
    description: "Standard Mailchimp export CSV",
    emailCols: ["email address", "email"],
    firstNameCols: ["first name", "fname"],
    lastNameCols: ["last name", "lname"],
    statusCols: ["status"],
    suppressedValues: ["unsubscribed", "cleaned", "bounced"],
    icon: <MonoIcon label="MC" />,
  },
  {
    id: "sendgrid",
    name: "SendGrid",
    description: "SendGrid contacts export",
    emailCols: ["email"],
    firstNameCols: ["first_name"],
    lastNameCols: ["last_name"],
    statusCols: ["email_groups_unsubscribed_from", "unsubscribed"],
    suppressedValues: ["true", "1", "yes"],
    icon: <MonoIcon label="SG" />,
  },
  {
    id: "klaviyo",
    name: "Klaviyo",
    description: "Klaviyo profiles or suppression list",
    emailCols: ["email"],
    firstNameCols: ["first name"],
    lastNameCols: ["last name"],
    statusCols: ["subscribed"],
    suppressedValues: ["false", "0", "no"],
    icon: <MonoIcon label="KL" />,
  },
  {
    id: "instantly",
    name: "Instantly",
    description: "Instantly.ai lead export",
    emailCols: ["email"],
    firstNameCols: ["first_name"],
    lastNameCols: ["last_name"],
    statusCols: ["status"],
    suppressedValues: ["bounced", "unsubscribed", "opt_out"],
    icon: <MonoIcon label="IN" />,
  },
  {
    id: "smartlead",
    name: "Smartlead",
    description: "Smartlead prospect export",
    emailCols: ["email"],
    firstNameCols: ["first_name", "firstname"],
    lastNameCols: ["last_name", "lastname"],
    statusCols: ["status"],
    suppressedValues: ["bounced", "unsubscribed", "opted_out"],
    icon: <MonoIcon label="SL" />,
  },
  {
    id: "csv",
    name: "Generic CSV",
    description: "Any CSV — map columns manually",
    emailCols: ["email"],
    firstNameCols: ["first_name", "first name", "firstname"],
    lastNameCols: ["last_name", "last name", "lastname"],
    statusCols: [],
    suppressedValues: [],
    icon: <FileText className="h-5 w-5" />,
  },
];

// ── Simple icon placeholder ──────────────────────────────────────────────────

function MonoIcon({ label }: { label: string }) {
  return (
    <span className="inline-flex h-5 w-5 items-center justify-center rounded text-[10px] font-bold tracking-tight border border-border leading-none">
      {label}
    </span>
  );
}

// ── CSV parser ───────────────────────────────────────────────────────────────

function parseCSV(raw: string): { headers: string[]; rows: Record<string, string>[] } {
  const lines = raw.split(/\r?\n/);
  const nonEmpty = lines.filter((l) => l.trim());
  if (nonEmpty.length < 2) return { headers: [], rows: [] };

  const parseRow = (line: string): string[] => {
    const cells: string[] = [];
    let cur = "";
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuote && line[i + 1] === '"') { cur += '"'; i++; }
        else inQuote = !inQuote;
      } else if (ch === "," && !inQuote) {
        cells.push(cur.trim());
        cur = "";
      } else {
        cur += ch;
      }
    }
    cells.push(cur.trim());
    return cells;
  };

  const headers = parseRow(nonEmpty[0]!);
  const rows = nonEmpty.slice(1).map((line) => {
    const vals = parseRow(line);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => { row[h] = vals[i] ?? ""; });
    return row;
  }).filter((r) => Object.values(r).some((v) => v));

  return { headers, rows };
}

// ── Column auto-mapper ───────────────────────────────────────────────────────

function bestMatch(candidates: string[], headers: string[]): string {
  const lower = headers.map((h) => h.toLowerCase());
  for (const c of candidates) {
    const idx = lower.findIndex((h) => h === c.toLowerCase());
    if (idx !== -1) return headers[idx]!;
  }
  return "";
}

// ── Step components ──────────────────────────────────────────────────────────

type Step = "platform" | "upload" | "mapping" | "list" | "importing" | "done";

interface ImportResult {
  imported: number;
  skipped: number;
  suppressions_added: number;
  list_id: string | null;
}

interface MailingList { id: string; name: string; }

// ── Main page ────────────────────────────────────────────────────────────────

function MigratePage() {
  const { primaryKey } = useAuth();

  const [step, setStep] = useState<Step>("platform");
  const [platform, setPlatform] = useState<Platform | null>(null);
  const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
  const [csvRows, setCsvRows] = useState<Record<string, string>[]>([]);
  const [mapping, setMapping] = useState({ email: "", firstName: "", lastName: "", status: "" });
  const [lists, setLists] = useState<MailingList[]>([]);
  const [targetListId, setTargetListId] = useState("");
  const [newListName, setNewListName] = useState("");
  const [result, setResult] = useState<ImportResult | null>(null);

  // Load existing lists once we reach the list step
  useEffect(() => {
    if (step !== "list" || !primaryKey?.keyRaw) return;
    api.withKey.get<{ data: MailingList[] }>("/v1/lists", primaryKey.keyRaw)
      .then((r) => setLists(r.data ?? []))
      .catch(() => {});
  }, [step, primaryKey]);

  const handlePlatformSelect = (p: Platform) => {
    setPlatform(p);
    setStep("upload");
  };

  const handleCSVParsed = (raw: string) => {
    const { headers, rows } = parseCSV(raw);
    if (!headers.length) { toast.error("Could not parse CSV — make sure it has headers"); return; }
    setCsvHeaders(headers);
    setCsvRows(rows);
    const p = platform!;
    setMapping({
      email: bestMatch(p.emailCols, headers),
      firstName: bestMatch(p.firstNameCols, headers),
      lastName: bestMatch(p.lastNameCols, headers),
      status: bestMatch(p.statusCols, headers),
    });
    setStep("mapping");
  };

  const handleImport = async () => {
    if (!primaryKey?.keyRaw || !platform) return;
    if (!mapping.email) { toast.error("Email column is required"); return; }

    const suppressedVals = new Set(platform.suppressedValues.map((v) => v.toLowerCase()));

    const contacts: { email: string; first_name?: string; last_name?: string }[] = [];
    const suppressions: { email: string; reason: string }[] = [];

    for (const row of csvRows) {
      const email = row[mapping.email]?.trim().toLowerCase();
      if (!email || !email.includes("@")) continue;

      const statusVal = mapping.status ? (row[mapping.status] ?? "").toLowerCase() : "";
      const isSuppressed = mapping.status && suppressedVals.has(statusVal);

      if (isSuppressed) {
        suppressions.push({ email, reason: statusVal || "unsubscribed" });
      } else {
        contacts.push({
          email,
          ...(mapping.firstName && row[mapping.firstName] ? { first_name: row[mapping.firstName] } : {}),
          ...(mapping.lastName && row[mapping.lastName] ? { last_name: row[mapping.lastName] } : {}),
        });
      }
    }

    if (!contacts.length && !suppressions.length) {
      toast.error("No valid contacts found in the file");
      return;
    }

    setStep("importing");

    try {
      const body: Record<string, unknown> = {
        contacts,
        suppressions,
        source_platform: platform.id,
      };
      if (targetListId) {
        body["list_id"] = targetListId;
      } else if (newListName.trim()) {
        body["list_name"] = newListName.trim();
      }

      const data = await api.withKey.post<ImportResult>(
        "/v1/contacts/import",
        body,
        primaryKey.keyRaw,
      );
      setResult(data);
      setStep("done");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Import failed";
      toast.error(msg);
      setStep("list");
    }
  };

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-2 mb-1">
          <ArrowRightLeft className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-2xl font-display font-medium tracking-tight">Migrate contacts</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Import contacts and suppressions from your existing email platform in minutes.
        </p>
      </div>

      {/* Step indicator */}
      <StepBar current={step} />

      {/* Steps */}
      <div className="mt-8">
        {step === "platform" && (
          <PlatformStep onSelect={handlePlatformSelect} />
        )}
        {step === "upload" && platform && (
          <UploadStep
            platform={platform}
            onBack={() => setStep("platform")}
            onParsed={handleCSVParsed}
          />
        )}
        {step === "mapping" && platform && (
          <MappingStep
            platform={platform}
            headers={csvHeaders}
            rows={csvRows}
            mapping={mapping}
            setMapping={setMapping}
            onBack={() => setStep("upload")}
            onNext={() => setStep("list")}
          />
        )}
        {step === "list" && (
          <ListStep
            lists={lists}
            targetListId={targetListId}
            setTargetListId={setTargetListId}
            newListName={newListName}
            setNewListName={setNewListName}
            totalContacts={csvRows.length}
            onBack={() => setStep("mapping")}
            onImport={handleImport}
          />
        )}
        {step === "importing" && <ImportingStep />}
        {step === "done" && result && (
          <DoneStep
            result={result}
            onReset={() => {
              setPlatform(null);
              setCsvHeaders([]);
              setCsvRows([]);
              setMapping({ email: "", firstName: "", lastName: "", status: "" });
              setTargetListId("");
              setNewListName("");
              setResult(null);
              setStep("platform");
            }}
          />
        )}
      </div>
    </div>
  );
}

// ── Step indicator ────────────────────────────────────────────────────────────

const STEPS: { id: Step; label: string }[] = [
  { id: "platform", label: "Platform" },
  { id: "upload", label: "Upload" },
  { id: "mapping", label: "Columns" },
  { id: "list", label: "Target list" },
  { id: "importing", label: "Importing" },
  { id: "done", label: "Done" },
];

const STEP_ORDER: Step[] = ["platform", "upload", "mapping", "list", "importing", "done"];

function StepBar({ current }: { current: Step }) {
  const currentIdx = STEP_ORDER.indexOf(current);
  return (
    <div className="flex items-center gap-0">
      {STEPS.map((s, i) => {
        const done = i < currentIdx;
        const active = i === currentIdx;
        return (
          <div key={s.id} className="flex items-center">
            <div className="flex flex-col items-center gap-1">
              <div
                className={cn(
                  "h-6 w-6 rounded-full border text-[11px] font-semibold flex items-center justify-center",
                  done && "border-foreground bg-foreground text-background",
                  active && "border-foreground bg-background text-foreground",
                  !done && !active && "border-border bg-background text-muted-foreground",
                )}
              >
                {done ? <CheckCircle2 className="h-3.5 w-3.5" /> : i + 1}
              </div>
              <span className={cn("text-[10px] whitespace-nowrap", active ? "text-foreground font-medium" : "text-muted-foreground")}>
                {s.label}
              </span>
            </div>
            {i < STEPS.length - 1 && (
              <div className={cn("h-px w-8 -mt-4 mx-1", done ? "bg-foreground" : "bg-border")} />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Platform step ─────────────────────────────────────────────────────────────

function PlatformStep({ onSelect }: { onSelect: (p: Platform) => void }) {
  return (
    <div>
      <h2 className="text-sm font-medium mb-4">Where are you migrating from?</h2>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {PLATFORMS.map((p) => (
          <button
            key={p.id}
            onClick={() => onSelect(p)}
            className="flex flex-col items-start gap-2 rounded-lg border border-border p-4 text-left transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <div className="flex items-center gap-2">
              {p.icon}
              <span className="text-sm font-medium">{p.name}</span>
            </div>
            <span className="text-xs text-muted-foreground leading-snug">{p.description}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Upload step ───────────────────────────────────────────────────────────────

function UploadStep({
  platform,
  onBack,
  onParsed,
}: {
  platform: Platform;
  onBack: () => void;
  onParsed: (raw: string) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleFile = (file: File) => {
    if (!file.name.endsWith(".csv")) { toast.error("Please upload a .csv file"); return; }
    const reader = new FileReader();
    reader.onload = (e) => onParsed(e.target?.result as string);
    reader.readAsText(file, "utf-8");
  };

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <button onClick={onBack} className="flex items-center gap-1 hover:text-foreground transition-colors">
          <ArrowLeft className="h-3.5 w-3.5" /> Back
        </button>
        <span>·</span>
        <span>Uploading from <strong className="text-foreground">{platform.name}</strong></span>
      </div>

      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => fileRef.current?.click()}
        className={cn(
          "flex flex-col items-center justify-center gap-4 rounded-xl border-2 border-dashed px-8 py-16 cursor-pointer transition-colors",
          dragging ? "border-foreground bg-muted" : "border-border hover:border-foreground/50 hover:bg-muted/50",
        )}
      >
        <Upload className="h-8 w-8 text-muted-foreground" />
        <div className="text-center">
          <p className="text-sm font-medium">Drop your CSV here or click to browse</p>
          <p className="mt-1 text-xs text-muted-foreground">Up to 50,000 contacts per file</p>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept=".csv"
          className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
        />
      </div>

      <ExportGuide platform={platform} />
    </div>
  );
}

function ExportGuide({ platform }: { platform: Platform }) {
  const guides: Record<PlatformId, string[]> = {
    mailchimp: [
      "Go to Audience → All contacts",
      "Click Export Audience → Export as CSV",
      "Download the file and upload it here",
    ],
    sendgrid: [
      "Go to Marketing → Contacts",
      "Click Export → All contacts",
      "Download the CSV once the export is ready",
    ],
    klaviyo: [
      "Go to Lists & Segments",
      "Open your list → click Export",
      "Download the CSV with all profile fields",
    ],
    instantly: [
      "Go to your campaign → Leads",
      "Click Export → Download CSV",
      "Upload the file here",
    ],
    smartlead: [
      "Go to Leads in your campaign",
      "Click Export CSV",
      "Upload the downloaded file here",
    ],
    csv: [
      "Your CSV needs at least an Email column",
      "First Name and Last Name are optional",
      "Headers are detected automatically",
    ],
  };

  const steps = guides[platform.id];
  return (
    <div className="rounded-lg border border-border bg-muted/30 p-4">
      <p className="text-xs font-medium mb-2 text-muted-foreground uppercase tracking-wide">How to export from {platform.name}</p>
      <ol className="space-y-1">
        {steps.map((s, i) => (
          <li key={i} className="flex items-start gap-2 text-xs text-muted-foreground">
            <span className="mt-px font-mono text-[10px] font-bold text-foreground/60 shrink-0">{i + 1}.</span>
            {s}
          </li>
        ))}
      </ol>
    </div>
  );
}

// ── Mapping step ──────────────────────────────────────────────────────────────

function MappingStep({
  platform,
  headers,
  rows,
  mapping,
  setMapping,
  onBack,
  onNext,
}: {
  platform: Platform;
  headers: string[];
  rows: Record<string, string>[];
  mapping: { email: string; firstName: string; lastName: string; status: string };
  setMapping: (m: typeof mapping) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const preview = rows.slice(0, 3);

  const field = (
    label: string,
    key: keyof typeof mapping,
    required?: boolean,
  ) => (
    <div className="space-y-1">
      <Label className="text-xs">
        {label} {required && <span className="text-[oklch(0.58_0.22_27)]">*</span>}
      </Label>
      <select
        value={mapping[key]}
        onChange={(e) => setMapping({ ...mapping, [key]: e.target.value })}
        className="flex h-8 w-full rounded-md border border-input bg-background px-2 py-0 text-xs shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <option value="">— skip —</option>
        {headers.map((h) => <option key={h} value={h}>{h}</option>)}
      </select>
    </div>
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <button onClick={onBack} className="flex items-center gap-1 hover:text-foreground transition-colors">
          <ArrowLeft className="h-3.5 w-3.5" /> Back
        </button>
        <span>·</span>
        <span>{rows.length.toLocaleString()} rows detected</span>
      </div>

      <div>
        <h2 className="text-sm font-medium mb-4">Map your columns</h2>
        <div className="grid grid-cols-2 gap-3">
          {field("Email", "email", true)}
          {field("First name", "firstName")}
          {field("Last name", "lastName")}
          {platform.statusCols.length > 0 && field("Status / unsubscribe column", "status")}
        </div>
        {mapping.status && (
          <p className="mt-2 text-xs text-muted-foreground">
            Rows where this column is <em>{platform.suppressedValues.join(", ")}</em> will be added to your suppression list instead of imported as contacts.
          </p>
        )}
      </div>

      {/* Preview */}
      {preview.length > 0 && mapping.email && (
        <div>
          <p className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wide">Preview (first {preview.length} rows)</p>
          <div className="rounded-lg border border-border overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border bg-muted/40">
                  {[mapping.email, mapping.firstName, mapping.lastName, mapping.status].filter(Boolean).map((col) => (
                    <th key={col} className="px-3 py-2 text-left font-medium text-muted-foreground">{col}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.map((row, i) => (
                  <tr key={i} className="border-b border-border last:border-0">
                    {[mapping.email, mapping.firstName, mapping.lastName, mapping.status].filter(Boolean).map((col) => (
                      <td key={col} className="px-3 py-2 text-foreground truncate max-w-[160px]">{row[col]}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="flex justify-end">
        <Button onClick={onNext} disabled={!mapping.email} size="sm">
          Continue <ChevronRight className="h-4 w-4 ml-1" />
        </Button>
      </div>
    </div>
  );
}

// ── List step ─────────────────────────────────────────────────────────────────

function ListStep({
  lists,
  targetListId,
  setTargetListId,
  newListName,
  setNewListName,
  totalContacts,
  onBack,
  onImport,
}: {
  lists: MailingList[];
  targetListId: string;
  setTargetListId: (v: string) => void;
  newListName: string;
  setNewListName: (v: string) => void;
  totalContacts: number;
  onBack: () => void;
  onImport: () => void;
}) {
  const [mode, setMode] = useState<"existing" | "new" | "none">("new");

  useEffect(() => {
    if (mode !== "existing") setTargetListId("");
    if (mode !== "new") setNewListName("");
  }, [mode]);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <button onClick={onBack} className="flex items-center gap-1 hover:text-foreground transition-colors">
          <ArrowLeft className="h-3.5 w-3.5" /> Back
        </button>
      </div>

      <div>
        <h2 className="text-sm font-medium mb-1">Add contacts to a list?</h2>
        <p className="text-xs text-muted-foreground mb-4">
          {totalContacts.toLocaleString()} rows ready to import. Contacts will always be saved globally — a list is optional.
        </p>

        <div className="space-y-2">
          {/* New list */}
          <label className={cn(
            "flex items-start gap-3 rounded-lg border p-4 cursor-pointer transition-colors",
            mode === "new" ? "border-foreground bg-muted/40" : "border-border hover:bg-muted/20",
          )}>
            <input type="radio" className="mt-0.5 accent-foreground" checked={mode === "new"} onChange={() => setMode("new")} />
            <div className="flex-1 space-y-2">
              <div className="flex items-center gap-2">
                <Plus className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-medium">Create a new list</span>
              </div>
              {mode === "new" && (
                <Input
                  placeholder="e.g. Migrated from Mailchimp"
                  value={newListName}
                  onChange={(e) => setNewListName(e.target.value)}
                  className="h-8 text-sm"
                  autoFocus
                />
              )}
            </div>
          </label>

          {/* Existing list */}
          {lists.length > 0 && (
            <label className={cn(
              "flex items-start gap-3 rounded-lg border p-4 cursor-pointer transition-colors",
              mode === "existing" ? "border-foreground bg-muted/40" : "border-border hover:bg-muted/20",
            )}>
              <input type="radio" className="mt-0.5 accent-foreground" checked={mode === "existing"} onChange={() => setMode("existing")} />
              <div className="flex-1 space-y-2">
                <div className="flex items-center gap-2">
                  <Users className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm font-medium">Add to existing list</span>
                </div>
                {mode === "existing" && (
                  <select
                    value={targetListId}
                    onChange={(e) => setTargetListId(e.target.value)}
                    className="flex h-8 w-full rounded-md border border-input bg-background px-2 py-0 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    autoFocus
                  >
                    <option value="">Select a list…</option>
                    {lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                  </select>
                )}
              </div>
            </label>
          )}

          {/* No list */}
          <label className={cn(
            "flex items-center gap-3 rounded-lg border p-4 cursor-pointer transition-colors",
            mode === "none" ? "border-foreground bg-muted/40" : "border-border hover:bg-muted/20",
          )}>
            <input type="radio" className="mt-0.5 accent-foreground" checked={mode === "none"} onChange={() => setMode("none")} />
            <span className="text-sm">Just import contacts globally (no list)</span>
          </label>
        </div>
      </div>

      <div className="rounded-lg border border-border bg-muted/30 p-4 flex items-start gap-3">
        <AlertCircle className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
        <p className="text-xs text-muted-foreground">
          Contacts that match your suppression list will be skipped and added to your global suppressions. Existing contacts will be updated, not duplicated.
        </p>
      </div>

      <div className="flex justify-end">
        <Button
          onClick={onImport}
          disabled={mode === "existing" && !targetListId}
          size="sm"
        >
          Start import
        </Button>
      </div>
    </div>
  );
}

// ── Importing step ────────────────────────────────────────────────────────────

function ImportingStep() {
  return (
    <div className="flex flex-col items-center justify-center py-20 gap-4">
      <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      <div className="text-center">
        <p className="text-sm font-medium">Importing your contacts…</p>
        <p className="text-xs text-muted-foreground mt-1">This usually takes a few seconds. Don't close this tab.</p>
      </div>
    </div>
  );
}

// ── Done step ─────────────────────────────────────────────────────────────────

function DoneStep({ result, onReset }: { result: ImportResult; onReset: () => void }) {
  return (
    <div className="space-y-6">
      <div className="flex flex-col items-center py-8 gap-3">
        <CheckCircle2 className="h-10 w-10 text-[oklch(0.55_0.16_145)]" />
        <div className="text-center">
          <p className="text-lg font-display font-medium">Import complete</p>
          <p className="text-sm text-muted-foreground mt-1">Your contacts are ready to use.</p>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <Stat label="Imported" value={result.imported.toLocaleString()} />
        <Stat label="Skipped" value={result.skipped.toLocaleString()} note="already exist or suppressed" />
        <Stat label="Suppressions" value={result.suppressions_added.toLocaleString()} note="added to global list" />
      </div>

      {result.list_id && (
        <div className="rounded-lg border border-border bg-muted/30 p-3 flex items-center gap-2 text-xs text-muted-foreground">
          <CheckCircle2 className="h-3.5 w-3.5 text-[oklch(0.55_0.16_145)] shrink-0" />
          Contacts were added to your list.
        </div>
      )}

      <div className="flex gap-3">
        <Button variant="outline" size="sm" onClick={onReset}>
          Import another file
        </Button>
        <Button size="sm" asChild>
          <a href="/dashboard/contacts">View contacts</a>
        </Button>
      </div>
    </div>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-lg border border-border p-4 text-center">
      <p className="text-2xl font-display font-medium tabular-nums">{value}</p>
      <p className="text-xs font-medium mt-1">{label}</p>
      {note && <p className="text-[10px] text-muted-foreground mt-0.5">{note}</p>}
    </div>
  );
}
