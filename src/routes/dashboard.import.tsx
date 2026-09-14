import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, useRef, useCallback, useEffect } from "react";
import {
  Upload,
  ChevronRight,
  ChevronLeft,
  CheckCircle2,
  AlertCircle,
  FileText,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAuth } from "@/lib/auth-context";
import { api } from "@/lib/api";
import { API_BASE } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import { parseCsv } from "@/lib/csv";

export const Route = createFileRoute("/dashboard/import")({
  head: () => ({ meta: [{ title: "Import CSV — Continuum" }] }),
  component: ImportPage,
});

// This page's preview table wants rows as string[][] (parallel to headers),
// not keyed objects — reshape parseCsv's output for that shape.
function parseCsvPreview(text: string, maxRows = 200): { headers: string[]; rows: string[][] } {
  const { headers, rows } = parseCsv(text, { maxRows });
  return { headers, rows: rows.map((row) => headers.map((h) => row[h] ?? "")) };
}

// ── Auto-detect column mapping ────────────────────────────────────────────────

const FIELD_OPTIONS = [
  { value: "email", label: "Email (required)" },
  { value: "first_name", label: "First Name" },
  { value: "last_name", label: "Last Name" },
  { value: "company", label: "Company" },
  { value: "phone", label: "Phone" },
  { value: "tags", label: "Tags (comma-separated)" },
  { value: "(skip)", label: "(skip)" },
];

function autoDetect(header: string): string {
  const h = header.toLowerCase().replace(/[\s_\-\.]/g, "");
  if (["email", "emailaddress", "email_address", "e-mail", "emailaddresses"].some((k) => k.replace(/[\s_\-\.]/g, "") === h))
    return "email";
  if (["firstname", "first", "fname", "givenname"].includes(h)) return "first_name";
  if (["lastname", "last", "lname", "surname", "familyname"].includes(h)) return "last_name";
  if (["company", "companyname", "organization", "org", "employer"].includes(h))
    return "company";
  if (["phone", "phonenumber", "mobile", "cell", "telephone", "tel"].includes(h))
    return "phone";
  if (["tags", "tag", "labels", "label"].includes(h)) return "tags";
  return "(skip)";
}

// ── Step indicator ────────────────────────────────────────────────────────────

function StepBar({ step }: { step: number }) {
  const steps = ["Upload", "Map Columns", "Import"];
  return (
    <div className="flex items-center gap-0 mb-8">
      {steps.map((label, i) => {
        const n = i + 1;
        const done = step > n;
        const active = step === n;
        return (
          <div key={n} className="flex items-center">
            <div className="flex items-center gap-2">
              <div
                className={cn(
                  "w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold shrink-0",
                  done
                    ? "bg-foreground text-background"
                    : active
                      ? "bg-foreground text-background"
                      : "bg-muted text-muted-foreground",
                )}
              >
                {done ? <CheckCircle2 className="h-4 w-4" /> : n}
              </div>
              <span
                className={cn(
                  "text-sm",
                  active ? "font-medium text-foreground" : "text-muted-foreground",
                )}
              >
                {label}
              </span>
            </div>
            {i < steps.length - 1 && (
              <div className="w-10 h-px bg-border mx-3 shrink-0" />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

function ImportPage() {
  const { primaryKey } = useAuth();
  const apiKey = primaryKey?.keyRaw ?? "";

  const [step, setStep] = useState<1 | 2 | 3>(1);

  // Step 1
  const [fileName, setFileName] = useState("");
  const [csvText, setCsvText] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<string[][]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [parseError, setParseError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Step 2
  const [fieldMap, setFieldMap] = useState<Record<string, string>>({});

  // Step 3
  const [lists, setLists] = useState<Array<{ id: string; name: string }>>([]);
  const [listId, setListId] = useState("");
  const [skipDuplicates, setSkipDuplicates] = useState(true);
  const [verify, setVerify] = useState(false);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<{ jobId?: string; error?: string } | null>(null);

  // Load lists when reaching step 3
  useEffect(() => {
    if (step === 3 && apiKey && lists.length === 0) {
      api.withKey
        .get<{ lists: Array<{ id: string; name: string }> }>("/v1/lists", apiKey)
        .then((r) => setLists(r.lists ?? []))
        .catch(() => {});
    }
  }, [step, apiKey]);

  function readFile(file: File) {
    if (!file.name.endsWith(".csv")) {
      setParseError("Only .csv files are accepted.");
      return;
    }
    setParseError("");
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      const { headers: h, rows: r } = parseCsvPreview(text, 200);
      if (h.length === 0) {
        setParseError("Could not detect any columns in this file.");
        return;
      }
      setCsvText(text);
      setFileName(file.name);
      setHeaders(h);
      setRows(r);
      // Auto-detect initial mapping
      const map: Record<string, string> = {};
      h.forEach((col) => { map[col] = autoDetect(col); });
      setFieldMap(map);
    };
    reader.onerror = () => setParseError("Failed to read file.");
    reader.readAsText(file);
  }

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files[0];
      if (file) readFile(file);
    },
    [],
  );

  function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) readFile(file);
    e.target.value = "";
  }

  function goToStep2() {
    if (!csvText || headers.length === 0) return;
    setStep(2);
  }

  function goToStep3() {
    const hasEmail = Object.values(fieldMap).includes("email");
    if (!hasEmail) return;
    setStep(3);
    setResult(null);
  }

  async function doImport() {
    if (!apiKey) return;
    setImporting(true);
    setResult(null);
    try {
      const activeMap: Record<string, string> = {};
      Object.entries(fieldMap).forEach(([col, field]) => {
        if (field !== "(skip)") activeMap[col] = field;
      });

      const formData = new FormData();
      formData.append(
        "file",
        new Blob([csvText], { type: "text/csv" }),
        fileName,
      );
      formData.append("field_map", JSON.stringify(activeMap));
      if (listId) formData.append("list_id", listId);
      formData.append("on_duplicate", skipDuplicates ? "skip" : "update");

      const res = await fetch(
        `${API_BASE}/v1/contacts/import${verify ? "?verify=true" : ""}`,
        {
          method: "POST",
          headers: { "X-API-Key": apiKey },
          body: formData,
        },
      );

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        setResult({ error: (err as { error?: string }).error ?? res.statusText });
      } else {
        const data = await res.json().catch(() => ({}));
        setResult({ jobId: data?.id ?? data?.jobId ?? data?.job_id ?? "started" });
      }
    } catch (err: unknown) {
      setResult({ error: err instanceof Error ? err.message : "Import failed." });
    } finally {
      setImporting(false);
    }
  }

  const rowCount = rows.length;
  const emailMapped = Object.values(fieldMap).includes("email");

  return (
    <div className="max-w-3xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Import CSV</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Upload a CSV file to import contacts into Continuum.
        </p>
      </div>

      <StepBar step={step} />

      {/* ── Step 1: Upload ──────────────────────────────────────────────── */}
      {step === 1 && (
        <div className="space-y-5">
          <div
            className={cn(
              "border-2 border-dashed rounded-xl p-10 text-center cursor-pointer transition-colors",
              dragOver
                ? "border-foreground bg-muted/20"
                : "border-border hover:border-foreground/40 hover:bg-muted/10",
            )}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload className="h-10 w-10 mx-auto mb-3 text-muted-foreground" />
            <p className="text-sm font-medium">
              Drag & drop your CSV here, or click to browse
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              .csv files only — first 200 rows will be imported
            </p>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv"
              className="hidden"
              onChange={handleFileInput}
            />
          </div>

          {parseError && (
            <div className="flex items-center gap-2 text-sm text-destructive">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {parseError}
            </div>
          )}

          {fileName && !parseError && (
            <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/10 px-4 py-3">
              <FileText className="h-5 w-5 text-muted-foreground shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{fileName}</p>
                <p className="text-xs text-muted-foreground">
                  {rowCount} row{rowCount !== 1 ? "s" : ""} detected &middot;{" "}
                  {headers.length} column{headers.length !== 1 ? "s" : ""}
                </p>
              </div>
            </div>
          )}

          <div className="flex justify-end">
            <Button
              onClick={goToStep2}
              disabled={!fileName || !!parseError}
              className="gap-1.5"
            >
              Next
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      {/* ── Step 2: Map columns ─────────────────────────────────────────── */}
      {step === 2 && (
        <div className="space-y-6">
          {/* Preview table */}
          <div>
            <p className="text-sm font-medium mb-2">File preview (first 5 rows)</p>
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="min-w-full text-xs">
                <thead>
                  <tr className="bg-muted/40 border-b border-border">
                    {headers.map((h) => (
                      <th
                        key={h}
                        className="px-3 py-2 text-left font-medium text-muted-foreground whitespace-nowrap"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, 5).map((row, ri) => (
                    <tr
                      key={ri}
                      className="border-b border-border last:border-0 even:bg-muted/10"
                    >
                      {headers.map((h, ci) => (
                        <td
                          key={h}
                          className="px-3 py-2 max-w-[160px] truncate text-muted-foreground"
                        >
                          {row[ci] ?? ""}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Column mapping */}
          <div>
            <p className="text-sm font-medium mb-3">Map columns to contact fields</p>
            <div className="space-y-2">
              {headers.map((col) => (
                <div key={col} className="flex items-center gap-3">
                  <span className="w-40 text-sm truncate shrink-0 text-muted-foreground font-mono text-xs bg-muted/30 px-2 py-1.5 rounded">
                    {col}
                  </span>
                  <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                  <Select
                    value={fieldMap[col] ?? "(skip)"}
                    onValueChange={(v) =>
                      setFieldMap((prev) => ({ ...prev, [col]: v }))
                    }
                  >
                    <SelectTrigger className="w-52">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {FIELD_OPTIONS.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value}>
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>
          </div>

          {!emailMapped && (
            <div className="flex items-center gap-2 text-sm text-destructive">
              <AlertCircle className="h-4 w-4 shrink-0" />
              Map at least one column to <strong>Email</strong> to continue.
            </div>
          )}

          <div className="flex items-center justify-between">
            <Button variant="outline" onClick={() => setStep(1)} className="gap-1.5">
              <ChevronLeft className="h-4 w-4" />
              Back
            </Button>
            <Button onClick={goToStep3} disabled={!emailMapped} className="gap-1.5">
              Next
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      {/* ── Step 3: Options + confirm ────────────────────────────────────── */}
      {step === 3 && (
        <div className="space-y-6">
          {result?.jobId ? (
            <div className="rounded-xl border border-border bg-muted/10 p-6 text-center space-y-3">
              <CheckCircle2 className="h-10 w-10 mx-auto text-green-500" />
              <p className="text-base font-semibold">Import started</p>
              <p className="text-sm text-muted-foreground">
                Job ID:{" "}
                <span className="font-mono text-foreground">{result.jobId}</span>
              </p>
              <p className="text-sm text-muted-foreground">
                Check Bulk Jobs for progress.
              </p>
              <Link
                to="/dashboard/bulk"
                className="inline-flex items-center gap-1.5 text-sm font-medium underline underline-offset-2"
              >
                View Bulk Jobs
                <ChevronRight className="h-3.5 w-3.5" />
              </Link>
            </div>
          ) : (
            <>
              <div className="rounded-lg border border-border bg-muted/10 px-4 py-3 flex items-center gap-3">
                <FileText className="h-5 w-5 text-muted-foreground shrink-0" />
                <div>
                  <p className="text-sm font-medium">
                    Ready to import {rowCount} contact{rowCount !== 1 ? "s" : ""}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    from <span className="font-mono">{fileName}</span>
                  </p>
                </div>
              </div>

              {/* Add to list */}
              <div className="space-y-1.5">
                <Label htmlFor="list-select">Add to list (optional)</Label>
                <Select value={listId || "__none__"} onValueChange={(v) => setListId(v === "__none__" ? "" : v)}>
                  <SelectTrigger id="list-select" className="w-72">
                    <SelectValue placeholder="None (contacts only)" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">None (contacts only)</SelectItem>
                    {lists.map((l) => (
                      <SelectItem key={l.id} value={l.id}>
                        {l.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Duplicate handling */}
              <div className="space-y-1.5">
                <Label>On duplicate email</Label>
                <div className="flex flex-col gap-2 mt-1">
                  <label className="flex items-center gap-2.5 cursor-pointer">
                    <input
                      type="radio"
                      name="dup"
                      checked={skipDuplicates}
                      onChange={() => setSkipDuplicates(true)}
                      className="accent-foreground"
                    />
                    <span className="text-sm">Skip (default)</span>
                  </label>
                  <label className="flex items-center gap-2.5 cursor-pointer">
                    <input
                      type="radio"
                      name="dup"
                      checked={!skipDuplicates}
                      onChange={() => setSkipDuplicates(false)}
                      className="accent-foreground"
                    />
                    <span className="text-sm">Update existing contact</span>
                  </label>
                </div>
              </div>

              {/* Verify */}
              <label className="flex items-start gap-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={verify}
                  onChange={(e) => setVerify(e.target.checked)}
                  className="mt-0.5 accent-foreground"
                />
                <div>
                  <span className="text-sm font-medium">
                    Verify emails before importing
                  </span>
                  <p className="text-xs text-muted-foreground">
                    Runs verification on each address; uses verification credits.
                  </p>
                </div>
              </label>

              {result?.error && (
                <div className="flex items-start gap-2 text-sm text-destructive">
                  <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                  {result.error}
                </div>
              )}

              <div className="flex items-center justify-between pt-2">
                <Button
                  variant="outline"
                  onClick={() => { setStep(2); setResult(null); }}
                  className="gap-1.5"
                >
                  <ChevronLeft className="h-4 w-4" />
                  Back
                </Button>
                <Button
                  onClick={doImport}
                  disabled={importing || !apiKey}
                  className="gap-1.5 min-w-28"
                >
                  {importing ? (
                    <>
                      <span className="h-4 w-4 rounded-full border-2 border-background border-t-transparent animate-spin" />
                      Importing…
                    </>
                  ) : (
                    <>
                      <Upload className="h-4 w-4" />
                      Import {rowCount} contact{rowCount !== 1 ? "s" : ""}
                    </>
                  )}
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
