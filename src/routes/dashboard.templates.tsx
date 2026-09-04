import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, useCallback } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Plus, Trash2, Edit2, FileText, Eye, X, ChevronDown, ChevronUp, History, RotateCcw, Check, Code2, Layers, ChevronUp as Up, ChevronDown as Down, Type, MousePointerClick, Image, Minus, AlignLeft } from "lucide-react";

// ── Visual block editor ────────────────────────────────────────────────────────

type BlockType = "header" | "text" | "button" | "image" | "divider" | "footer";

interface HeaderBlock  { type: "header";  id: string; company: string; logoUrl: string; bgColor: string; }
interface TextBlock    { type: "text";    id: string; content: string; fontSize: number; color: string; bold: boolean; }
interface ButtonBlock  { type: "button";  id: string; label: string; href: string; bgColor: string; textColor: string; }
interface ImageBlock   { type: "image";   id: string; src: string; alt: string; maxWidth: number; }
interface DividerBlock { type: "divider"; id: string; color: string; }
interface FooterBlock  { type: "footer";  id: string; text: string; color: string; }

type Block = HeaderBlock | TextBlock | ButtonBlock | ImageBlock | DividerBlock | FooterBlock;

function uid() { return Math.random().toString(36).slice(2, 10); }

function defaultBlocks(): Block[] {
  return [
    { type: "header",  id: uid(), company: "Your Company", logoUrl: "", bgColor: "#1a1a1a" },
    { type: "text",    id: uid(), content: "Hi {{first_name}},", fontSize: 15, color: "#374151", bold: false },
    { type: "text",    id: uid(), content: "Thank you for being a valued customer. Here's an update we thought you'd want to know about.", fontSize: 14, color: "#6b7280", bold: false },
    { type: "button",  id: uid(), label: "Get Started", href: "{{action_url}}", bgColor: "#111827", textColor: "#ffffff" },
    { type: "divider", id: uid(), color: "#e5e7eb" },
    { type: "footer",  id: uid(), text: "© 2026 Your Company · 123 Main St · Unsubscribe", color: "#9ca3af" },
  ];
}

function blocksToHtml(blocks: Block[]): string {
  const rows = blocks.map((b) => {
    switch (b.type) {
      case "header":
        return `<tr><td style="background:${b.bgColor};padding:24px 40px;text-align:center">${
          b.logoUrl
            ? `<img src="${b.logoUrl}" alt="${b.company}" style="max-height:40px;display:inline-block">`
            : `<span style="color:#ffffff;font-size:18px;font-weight:700;font-family:sans-serif">${b.company}</span>`
        }</td></tr>`;
      case "text":
        return `<tr><td style="padding:12px 40px;font-family:sans-serif;font-size:${b.fontSize}px;color:${b.color};line-height:1.6;${b.bold ? "font-weight:700;" : ""}">${b.content.replace(/\n/g, "<br>")}</td></tr>`;
      case "button":
        return `<tr><td style="padding:16px 40px;text-align:center"><a href="${b.href}" style="display:inline-block;background:${b.bgColor};color:${b.textColor};font-family:sans-serif;font-size:14px;font-weight:600;text-decoration:none;padding:12px 28px;border-radius:6px">${b.label}</a></td></tr>`;
      case "image":
        return `<tr><td style="padding:16px 40px;text-align:center"><img src="${b.src}" alt="${b.alt}" style="max-width:${b.maxWidth}%;display:inline-block;border-radius:4px"></td></tr>`;
      case "divider":
        return `<tr><td style="padding:8px 40px"><hr style="border:none;border-top:1px solid ${b.color};margin:0"></td></tr>`;
      case "footer":
        return `<tr><td style="padding:20px 40px 28px;text-align:center;font-family:sans-serif;font-size:12px;color:${b.color}">${b.text}</td></tr>`;
    }
  }).join("\n");
  return `<!DOCTYPE html><html><body style="margin:0;padding:20px;background:#f3f4f6"><table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:8px;overflow:hidden">\n${rows}\n</table></body></html>`;
}

const BLOCK_ICONS: Record<BlockType, React.ReactNode> = {
  header:  <AlignLeft className="h-3.5 w-3.5" />,
  text:    <Type className="h-3.5 w-3.5" />,
  button:  <MousePointerClick className="h-3.5 w-3.5" />,
  image:   <Image className="h-3.5 w-3.5" />,
  divider: <Minus className="h-3.5 w-3.5" />,
  footer:  <FileText className="h-3.5 w-3.5" />,
};

const BLOCK_LABELS: Record<BlockType, string> = {
  header:  "Header",
  text:    "Text",
  button:  "Button",
  image:   "Image",
  divider: "Divider",
  footer:  "Footer",
};

function BlockEditor({ block, onChange }: { block: Block; onChange: (b: Block) => void }) {
  const field = (label: string, el: React.ReactNode) => (
    <div className="space-y-1">
      <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">{label}</label>
      {el}
    </div>
  );
  const inp = (key: string, val: string | number, placeholder?: string, type = "text") => (
    <Input
      type={type}
      className="h-7 text-xs"
      placeholder={placeholder}
      value={val}
      onChange={(e) => onChange({ ...block, [key]: type === "number" ? Number(e.target.value) : e.target.value } as Block)}
    />
  );
  const colorInp = (key: string, val: string) => (
    <div className="flex gap-1.5">
      <input type="color" value={val} onChange={(e) => onChange({ ...block, [key]: e.target.value } as Block)} className="h-7 w-9 rounded border border-input cursor-pointer p-0.5" />
      <Input className="h-7 text-xs font-mono flex-1" value={val} onChange={(e) => onChange({ ...block, [key]: e.target.value } as Block)} maxLength={7} />
    </div>
  );

  switch (block.type) {
    case "header":  return <div className="grid grid-cols-2 gap-2 p-3 bg-muted/30 rounded-b-md border-t border-border">
      {field("Company", inp("company", block.company, "Acme Inc."))}
      {field("Logo URL", inp("logoUrl", block.logoUrl, "https://…"))}
      {field("Background", colorInp("bgColor", block.bgColor))}
    </div>;
    case "text":    return <div className="grid grid-cols-2 gap-2 p-3 bg-muted/30 rounded-b-md border-t border-border">
      <div className="col-span-2 space-y-1">
        <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Content</label>
        <textarea className="w-full rounded border border-input bg-background px-2 py-1.5 text-xs min-h-[60px] resize-y focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" value={block.content} onChange={(e) => onChange({ ...block, content: e.target.value })} />
      </div>
      {field("Font size (px)", inp("fontSize", block.fontSize, "14", "number"))}
      {field("Color", colorInp("color", block.color))}
      <div className="col-span-2 flex items-center gap-2">
        <input type="checkbox" id={`bold-${block.id}`} checked={block.bold} onChange={(e) => onChange({ ...block, bold: e.target.checked })} className="rounded border-input" />
        <label htmlFor={`bold-${block.id}`} className="text-xs">Bold</label>
      </div>
    </div>;
    case "button":  return <div className="grid grid-cols-2 gap-2 p-3 bg-muted/30 rounded-b-md border-t border-border">
      {field("Label", inp("label", block.label, "Click here"))}
      {field("Link URL", inp("href", block.href, "https://…"))}
      {field("Background", colorInp("bgColor", block.bgColor))}
      {field("Text color", colorInp("textColor", block.textColor))}
    </div>;
    case "image":   return <div className="grid grid-cols-2 gap-2 p-3 bg-muted/30 rounded-b-md border-t border-border">
      <div className="col-span-2">{field("Image URL", inp("src", block.src, "https://…"))}</div>
      {field("Alt text", inp("alt", block.alt, "Image"))}
      {field("Max width %", inp("maxWidth", block.maxWidth, "100", "number"))}
    </div>;
    case "divider": return <div className="p-3 bg-muted/30 rounded-b-md border-t border-border">
      {field("Color", colorInp("color", block.color))}
    </div>;
    case "footer":  return <div className="p-3 bg-muted/30 rounded-b-md border-t border-border">
      <div className="space-y-1 mb-2">
        <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Footer text</label>
        <textarea className="w-full rounded border border-input bg-background px-2 py-1.5 text-xs min-h-[48px] resize-y focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" value={block.text} onChange={(e) => onChange({ ...block, text: e.target.value })} />
      </div>
      {field("Color", colorInp("color", block.color))}
    </div>;
  }
}

function VisualEditor({ blocks, onChange }: { blocks: Block[]; onChange: (b: Block[]) => void }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const update = (updated: Block) => onChange(blocks.map((b) => b.id === updated.id ? updated : b));
  const remove = (id: string) => { onChange(blocks.filter((b) => b.id !== id)); if (selectedId === id) setSelectedId(null); };
  const move   = (id: string, dir: -1 | 1) => {
    const i = blocks.findIndex((b) => b.id === id);
    const j = i + dir;
    if (j < 0 || j >= blocks.length) return;
    const next = [...blocks];
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange(next);
  };
  const add = (type: BlockType) => {
    let b: Block;
    switch (type) {
      case "header":  b = { type, id: uid(), company: "Company", logoUrl: "", bgColor: "#1a1a1a" }; break;
      case "text":    b = { type, id: uid(), content: "Your text here", fontSize: 14, color: "#374151", bold: false }; break;
      case "button":  b = { type, id: uid(), label: "Click here", href: "https://", bgColor: "#111827", textColor: "#ffffff" }; break;
      case "image":   b = { type, id: uid(), src: "", alt: "", maxWidth: 100 }; break;
      case "divider": b = { type, id: uid(), color: "#e5e7eb" }; break;
      case "footer":  b = { type, id: uid(), text: "© 2026 Your Company", color: "#9ca3af" }; break;
    }
    onChange([...blocks, b]);
    setSelectedId(b.id);
  };

  return (
    <div className="space-y-3">
      {/* Block list */}
      <div className="rounded-md border border-border overflow-hidden divide-y divide-border">
        {blocks.map((block, i) => {
          const isSelected = selectedId === block.id;
          return (
            <div key={block.id}>
              <div
                className={`flex items-center gap-2 px-3 py-2 cursor-pointer select-none transition-colors ${isSelected ? "bg-muted" : "hover:bg-muted/40"}`}
                onClick={() => setSelectedId(isSelected ? null : block.id)}
              >
                <span className="text-muted-foreground">{BLOCK_ICONS[block.type]}</span>
                <span className="text-xs font-medium flex-1 truncate">
                  {BLOCK_LABELS[block.type]}
                  {block.type === "text"   && <span className="ml-2 text-muted-foreground font-normal truncate">{block.content.slice(0, 40)}</span>}
                  {block.type === "button" && <span className="ml-2 text-muted-foreground font-normal">{block.label}</span>}
                </span>
                <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 shrink-0" onClick={(e) => e.stopPropagation()}>
                  <button className="rounded p-0.5 hover:bg-muted-foreground/20 disabled:opacity-30" disabled={i === 0} onClick={() => move(block.id, -1)}><Up className="h-3 w-3" /></button>
                  <button className="rounded p-0.5 hover:bg-muted-foreground/20 disabled:opacity-30" disabled={i === blocks.length - 1} onClick={() => move(block.id, 1)}><Down className="h-3 w-3" /></button>
                  <button className="rounded p-0.5 hover:bg-destructive/20 text-destructive" onClick={() => remove(block.id)}><X className="h-3 w-3" /></button>
                </div>
              </div>
              {isSelected && <BlockEditor block={block} onChange={update} />}
            </div>
          );
        })}
        {blocks.length === 0 && (
          <div className="px-5 py-8 text-center text-xs text-muted-foreground">No blocks yet — add one below</div>
        )}
      </div>

      {/* Add block buttons */}
      <div className="flex flex-wrap gap-1.5">
        <span className="text-[10px] text-muted-foreground self-center mr-0.5">Add:</span>
        {(["header", "text", "button", "image", "divider", "footer"] as BlockType[]).map((t) => (
          <button
            key={t}
            onClick={() => add(t)}
            className="inline-flex items-center gap-1 rounded border border-border px-2 py-0.5 text-xs hover:bg-muted transition-colors"
          >
            {BLOCK_ICONS[t]}
            {BLOCK_LABELS[t]}
          </button>
        ))}
      </div>

      {/* Live preview */}
      <div className="rounded-md border border-border overflow-hidden">
        <div className="px-3 py-2 border-b border-border bg-muted/30 flex items-center gap-1.5">
          <Eye className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-xs text-muted-foreground">Live preview</span>
        </div>
        <iframe
          srcDoc={blocksToHtml(blocks)}
          sandbox="allow-same-origin"
          className="w-full border-0"
          style={{ height: 320 }}
          title="Visual preview"
        />
      </div>
    </div>
  );
}

export const Route = createFileRoute("/dashboard/templates")({
  head: () => ({ meta: [{ title: "Templates — Continuum API" }] }),
  component: TemplatesPage,
});

interface Template { id: string; name: string; subject: string; htmlBody?: string; createdAt: string; updatedAt?: string; }
interface TemplateVersion { id: string; version: number; name: string; subject: string; savedAt: string; savedBy?: string; }
interface TemplateVersionDetail extends TemplateVersion { htmlBody: string; textBody?: string; }

function fmt(iso: string) {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function extractVars(html: string, subject: string): string[] {
  const matches = new Set<string>();
  const re = /\{\{(\w+)\}\}/g;
  let m;
  for (const src of [html, subject]) {
    while ((m = re.exec(src)) !== null) matches.add(m[1]!);
    re.lastIndex = 0;
  }
  return [...matches];
}

function applyVars(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? `{{${k}}}`);
}

// ── Version History Modal ──────────────────────────────────────────────────────

function VersionHistoryModal({
  template,
  apiKey,
  onClose,
  onRestored,
}: {
  template: Template;
  apiKey: string;
  onClose: () => void;
  onRestored: () => void;
}) {
  const [versions, setVersions] = useState<TemplateVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<TemplateVersionDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);

  useEffect(() => {
    fetch(`https://api.continuumapi.com/v1/templates/${template.id}/versions`, {
      headers: { "X-API-Key": apiKey },
    })
      .then((r) => r.json())
      .then((data) => setVersions(data.data ?? []))
      .catch(() => setVersions([]))
      .finally(() => setLoading(false));
  }, [template.id, apiKey]);

  const loadDetail = useCallback(async (v: TemplateVersion) => {
    if (selected?.id === v.id) { setSelected(null); return; }
    setLoadingDetail(true);
    try {
      const res = await fetch(`https://api.continuumapi.com/v1/templates/${template.id}/versions/${v.id}`, {
        headers: { "X-API-Key": apiKey },
      });
      const data = await res.json() as TemplateVersionDetail;
      setSelected(data);
    } catch {
      toast.error("Failed to load version");
    } finally {
      setLoadingDetail(false);
    }
  }, [selected, template.id, apiKey]);

  const restore = async (versionId: string, versionNum: number) => {
    if (!confirm(`Restore version ${versionNum}? The current template will be saved as a new version.`)) return;
    setRestoring(versionId);
    try {
      await fetch(`https://api.continuumapi.com/v1/templates/${template.id}/versions/${versionId}/restore`, {
        method: "POST",
        headers: { "X-API-Key": apiKey },
      });
      toast.success(`Restored to version ${versionNum}`);
      onRestored();
      onClose();
    } catch {
      toast.error("Failed to restore version");
    } finally {
      setRestoring(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="rounded-lg border border-border bg-card w-full max-w-2xl shadow-xl flex flex-col max-h-[85vh]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <div>
            <h2 className="text-sm font-semibold flex items-center gap-2">
              <History className="h-4 w-4" /> Version History
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5">{template.name}</p>
          </div>
          <button onClick={onClose} className="rounded p-1.5 hover:bg-muted transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="overflow-y-auto flex-1">
          {loading ? (
            <div className="p-8 text-center text-sm text-muted-foreground">Loading versions…</div>
          ) : versions.length === 0 ? (
            <div className="p-8 text-center">
              <History className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">No previous versions yet.</p>
              <p className="text-xs text-muted-foreground mt-1">Versions are saved automatically each time you edit this template.</p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {versions.map((v) => (
                <div key={v.id} className="px-5 py-3">
                  <button
                    className="w-full flex items-center justify-between text-left hover:text-foreground transition-colors group"
                    onClick={() => void loadDetail(v)}
                  >
                    <div className="flex items-center gap-3">
                      <span className="text-[10px] font-mono bg-foreground/10 text-foreground px-1.5 py-0.5 rounded">
                        v{v.version}
                      </span>
                      <div>
                        <p className="text-sm font-medium">{v.name}</p>
                        <p className="text-xs text-muted-foreground truncate max-w-xs">{v.subject}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3 ml-4 shrink-0">
                      <div className="text-right">
                        <p className="text-xs text-muted-foreground">{fmt(v.savedAt)}</p>
                        {v.savedBy && <p className="text-[10px] text-muted-foreground/70">{v.savedBy}</p>}
                      </div>
                      {selected?.id === v.id ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
                    </div>
                  </button>

                  {selected?.id === v.id && (
                    <div className="mt-3 space-y-3">
                      {loadingDetail ? (
                        <div className="text-xs text-muted-foreground">Loading…</div>
                      ) : (
                        <>
                          <div className="rounded-md border border-border overflow-hidden bg-background">
                            <div className="px-3 py-2 border-b border-border bg-muted/40 flex items-center justify-between">
                              <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Subject</span>
                            </div>
                            <div className="px-3 py-2 text-sm">{selected.subject}</div>
                          </div>
                          <div className="rounded-md border border-border overflow-hidden">
                            <div className="px-3 py-2 border-b border-border bg-muted/40">
                              <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">HTML Preview</span>
                            </div>
                            <iframe
                              srcDoc={selected.htmlBody || "<p style='font-family:sans-serif;color:#888;padding:1rem'>No HTML body</p>"}
                              sandbox="allow-same-origin"
                              className="w-full border-0 bg-white"
                              style={{ height: 200 }}
                              title={`v${v.version} preview`}
                            />
                          </div>
                          <div className="flex gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 text-xs gap-1.5"
                              onClick={() => void restore(v.id, v.version)}
                              disabled={restoring === v.id}
                            >
                              {restoring === v.id ? (
                                <><RotateCcw className="h-3.5 w-3.5 animate-spin" /> Restoring…</>
                              ) : (
                                <><RotateCcw className="h-3.5 w-3.5" /> Restore this version</>
                              )}
                            </Button>
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Preview Modal ──────────────────────────────────────────────────────────────

function TemplatePreviewModal({ template, onClose }: { template: Template; onClose: () => void }) {
  const { primaryKey } = useAuth();
  const html = template.htmlBody ?? "";
  const vars = extractVars(html, template.subject);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(vars.map((v) => [v, ""]))
  );
  const [showVars, setShowVars] = useState(vars.length > 0);
  const [testEmail, setTestEmail] = useState("");
  const [testFrom, setTestFrom] = useState("");
  const [sendingTest, setSendingTest] = useState(false);
  const [showTest, setShowTest] = useState(false);

  const sendTest = async () => {
    if (!primaryKey?.keyRaw || !testEmail || !testFrom) return;
    setSendingTest(true);
    try {
      await fetch("https://api.continuumapi.com/v1/send", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": primaryKey.keyRaw },
        body: JSON.stringify({ to: [testEmail], from: testFrom, template_id: template.id, variables: values }),
      });
      toast.success(`Test email sent to ${testEmail}`);
      setShowTest(false);
    } catch (e: unknown) { toast.error((e as Error).message ?? "Failed to send"); }
    finally { setSendingTest(false); }
  };

  const renderedHtml = applyVars(html, values);
  const renderedSubject = applyVars(template.subject, values);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background/95 backdrop-blur-sm">
      <div className="flex items-center justify-between px-5 py-3 border-b border-border bg-card shrink-0">
        <div className="min-w-0">
          <p className="text-sm font-medium truncate">{template.name}</p>
          <p className="text-xs text-muted-foreground truncate">{renderedSubject || template.subject}</p>
        </div>
        <div className="flex items-center gap-2 ml-4 shrink-0">
          <Button size="sm" variant="outline" className="h-7 text-xs gap-1.5" onClick={() => setShowTest((v) => !v)}>
            <Eye className="h-3.5 w-3.5" /> Send test
          </Button>
          <button onClick={onClose} className="rounded p-1.5 hover:bg-muted transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {showTest && (
        <div className="shrink-0 border-b border-border bg-card px-5 py-4 space-y-3">
          <p className="text-xs font-medium">Send a test email with the current variables</p>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">From address *</Label>
              <Input className="h-7 text-xs" placeholder="noreply@yourapp.com" value={testFrom} onChange={(e) => setTestFrom(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Send to *</Label>
              <Input className="h-7 text-xs" placeholder="you@example.com" value={testEmail} onChange={(e) => setTestEmail(e.target.value)} />
            </div>
          </div>
          <div className="flex gap-2">
            <Button size="sm" className="h-7 text-xs" onClick={sendTest} disabled={sendingTest || !testEmail || !testFrom}>
              {sendingTest ? "Sending…" : "Send test email"}
            </Button>
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setShowTest(false)}>Cancel</Button>
          </div>
        </div>
      )}

      {vars.length > 0 && (
        <div className="shrink-0 border-b border-border bg-muted/30">
          <button
            onClick={() => setShowVars((v) => !v)}
            className="w-full flex items-center justify-between px-5 py-2.5 text-xs font-medium hover:bg-muted/40 transition-colors"
          >
            <span className="flex items-center gap-2">
              Test variables
              <span className="rounded-full bg-foreground/10 px-1.5 py-0.5 text-[10px]">{vars.length}</span>
            </span>
            {showVars ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </button>
          {showVars && (
            <div className="px-5 pb-4 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
              {vars.map((v) => (
                <div key={v} className="space-y-1">
                  <label className="text-[10px] text-muted-foreground font-mono">{`{{${v}}}`}</label>
                  <Input className="h-7 text-xs" placeholder={v} value={values[v] ?? ""} onChange={(e) => setValues((prev) => ({ ...prev, [v]: e.target.value }))} />
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="flex-1 overflow-hidden bg-zinc-50 dark:bg-zinc-900 flex justify-center py-4">
        <div className="w-full max-w-2xl rounded-md shadow-sm overflow-hidden border border-border">
          <iframe
            key={renderedHtml}
            srcDoc={renderedHtml || "<p style='font-family:sans-serif;color:#888;padding:2rem'>No HTML body set for this template.</p>"}
            sandbox="allow-same-origin"
            className="w-full h-full border-0 bg-white"
            style={{ minHeight: 400 }}
            title={`Preview: ${template.name}`}
          />
        </div>
      </div>
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────────

function TemplatesPage() {
  const { primaryKey } = useAuth();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: "", subject: "", preheader: "", html: "" });
  const [saving, setSaving] = useState(false);
  const [editTarget, setEditTarget] = useState<Template | null>(null);
  const [editForm, setEditForm] = useState({ name: "", subject: "", preheader: "", html: "" });
  const [editSaving, setEditSaving] = useState(false);
  const [editMode, setEditMode] = useState<"html" | "visual">("html");
  const [editBlocks, setEditBlocks] = useState<Block[]>(defaultBlocks);
  const [createMode, setCreateMode] = useState<"html" | "visual">("visual");
  const [createBlocks, setCreateBlocks] = useState<Block[]>(defaultBlocks);
  const [previewTemplate, setPreviewTemplate] = useState<Template | null>(null);
  const [historyTemplate, setHistoryTemplate] = useState<Template | null>(null);

  const load = useCallback(() => {
    if (!primaryKey?.keyRaw) return;
    fetch("https://api.continuumapi.com/v1/templates", {
      headers: { "X-API-Key": primaryKey.keyRaw },
    })
      .then((r) => r.json())
      .then((data) => setTemplates(data.data ?? data.templates ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [primaryKey?.keyRaw]);

  useEffect(() => { load(); }, [load]);

  const create = async () => {
    if (!primaryKey?.keyRaw) return;
    setSaving(true);
    const html_body = createMode === "visual" ? blocksToHtml(createBlocks) : form.html;
    try {
      await api.withKey.post("/v1/templates", { name: form.name, subject: form.subject, preheader: form.preheader || undefined, html_body }, primaryKey.keyRaw);
      toast.success("Template created");
      setCreating(false);
      setForm({ name: "", subject: "", preheader: "", html: "" });
      setCreateBlocks(defaultBlocks());
      setCreateMode("visual");
      load();
    } catch (e: unknown) { toast.error((e as Error).message); }
    finally { setSaving(false); }
  };

  const openEdit = (t: Template) => {
    setEditTarget(t);
    setEditForm({ name: t.name, subject: t.subject, preheader: "", html: t.htmlBody ?? "" });
    setEditMode("html");
    setEditBlocks(defaultBlocks());
  };

  const switchToVisual = () => {
    if (editForm.html && !confirm("Switching to Visual mode will replace the current HTML with default blocks. Continue?")) return;
    setEditMode("visual");
  };
  const switchToHtml = () => {
    if (editMode === "visual") setEditForm((f) => ({ ...f, html: blocksToHtml(editBlocks) }));
    setEditMode("html");
  };

  const saveEdit = async () => {
    if (!primaryKey?.keyRaw || !editTarget) return;
    setEditSaving(true);
    const html_body = editMode === "visual" ? blocksToHtml(editBlocks) : editForm.html;
    try {
      await fetch(`https://api.continuumapi.com/v1/templates/${editTarget.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "X-API-Key": primaryKey.keyRaw },
        body: JSON.stringify({ name: editForm.name, subject: editForm.subject, preheader: editForm.preheader || undefined, html_body }),
      });
      setTemplates((ts) => ts.map((t) => t.id === editTarget.id ? { ...t, name: editForm.name, subject: editForm.subject, htmlBody: html_body } : t));
      toast.success("Template updated — previous version saved to history");
      setEditTarget(null);
    } catch (e: unknown) { toast.error((e as Error).message); }
    finally { setEditSaving(false); }
  };

  const del = async (id: string) => {
    if (!primaryKey?.keyRaw || !confirm("Delete this template?")) return;
    try {
      await fetch(`https://api.continuumapi.com/v1/templates/${id}`, {
        method: "DELETE",
        headers: { "X-API-Key": primaryKey.keyRaw },
      });
      setTemplates((t) => t.filter((x) => x.id !== id));
      toast.success("Template deleted");
    } catch (e: unknown) { toast.error((e as Error).message); }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <header>
          <h1 className="text-2xl font-display font-medium tracking-tight">Email Templates</h1>
          <p className="text-sm text-muted-foreground">Reusable templates with variable substitution and version history.</p>
        </header>
        <Button size="sm" className="gap-1.5" onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" /> New Template
        </Button>
      </div>

      {/* Edit modal */}
      {editTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="rounded-lg border border-border bg-card w-full max-w-2xl shadow-xl flex flex-col max-h-[92vh]">
            {/* Modal header */}
            <div className="flex items-center justify-between px-5 py-3 border-b border-border shrink-0">
              <h2 className="text-sm font-semibold">Edit Template</h2>
              <div className="flex items-center gap-2">
                <div className="flex rounded-md border border-border overflow-hidden text-xs">
                  <button onClick={switchToHtml} className={`flex items-center gap-1 px-2.5 py-1 ${editMode === "html" ? "bg-foreground text-background" : "hover:bg-muted"}`}>
                    <Code2 className="h-3 w-3" /> HTML
                  </button>
                  <button onClick={switchToVisual} className={`flex items-center gap-1 px-2.5 py-1 border-l border-border ${editMode === "visual" ? "bg-foreground text-background" : "hover:bg-muted"}`}>
                    <Layers className="h-3 w-3" /> Visual
                  </button>
                </div>
                <button onClick={() => setEditTarget(null)} className="rounded p-1 hover:bg-muted"><X className="h-4 w-4" /></button>
              </div>
            </div>

            {/* Scrollable body */}
            <div className="overflow-y-auto flex-1 p-5 space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Name</Label>
                  <Input value={editForm.name} onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))} />
                </div>
                <div className="space-y-1.5">
                  <Label>Subject</Label>
                  <Input value={editForm.subject} onChange={(e) => setEditForm((f) => ({ ...f, subject: e.target.value }))} />
                </div>
              </div>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label>Preheader <span className="text-muted-foreground font-normal">(optional)</span></Label>
                  <span className="text-xs text-muted-foreground">{editForm.preheader.length}/200</span>
                </div>
                <Input maxLength={200} placeholder="Short preview text shown after subject in inbox…" value={editForm.preheader} onChange={(e) => setEditForm((f) => ({ ...f, preheader: e.target.value }))} />
              </div>

              {editMode === "html" ? (
                <div className="space-y-1.5">
                  <Label>HTML Body</Label>
                  <textarea
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono min-h-[200px] resize-y focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    value={editForm.html}
                    onChange={(e) => setEditForm((f) => ({ ...f, html: e.target.value }))}
                  />
                </div>
              ) : (
                <VisualEditor blocks={editBlocks} onChange={setEditBlocks} />
              )}

              <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                <History className="h-3.5 w-3.5" />
                Saving snapshots the current version to history automatically.
              </p>
            </div>

            {/* Footer */}
            <div className="flex gap-2 px-5 py-3 border-t border-border shrink-0">
              <Button onClick={saveEdit} disabled={editSaving}>{editSaving ? "Saving…" : "Save Changes"}</Button>
              <Button variant="outline" onClick={() => setEditTarget(null)}>Cancel</Button>
            </div>
          </div>
        </div>
      )}

      {/* Create form */}
      {creating && (
        <div className="rounded-lg border border-border bg-card p-6 space-y-4 max-w-2xl">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">New Template</h2>
            <div className="flex rounded-md border border-border overflow-hidden text-xs">
              <button
                onClick={() => setCreateMode("visual")}
                className={`flex items-center gap-1 px-2.5 py-1 ${createMode === "visual" ? "bg-foreground text-background" : "hover:bg-muted"}`}
              >
                <Layers className="h-3 w-3" /> Visual
              </button>
              <button
                onClick={() => {
                  if (createMode === "visual") setForm((f) => ({ ...f, html: blocksToHtml(createBlocks) }));
                  setCreateMode("html");
                }}
                className={`flex items-center gap-1 px-2.5 py-1 border-l border-border ${createMode === "html" ? "bg-foreground text-background" : "hover:bg-muted"}`}
              >
                <Code2 className="h-3 w-3" /> HTML
              </button>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Name</Label>
            <Input placeholder="Welcome Email" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
          </div>
          <div className="space-y-1.5">
            <Label>Subject</Label>
            <Input placeholder="Welcome, {{first_name}}!" value={form.subject} onChange={(e) => setForm((f) => ({ ...f, subject: e.target.value }))} />
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label>Preheader <span className="text-muted-foreground font-normal">(optional)</span></Label>
              <span className="text-xs text-muted-foreground">{form.preheader.length}/200</span>
            </div>
            <Input maxLength={200} placeholder="Short preview text shown after subject in inbox…" value={form.preheader} onChange={(e) => setForm((f) => ({ ...f, preheader: e.target.value }))} />
          </div>

          {createMode === "visual" ? (
            <VisualEditor blocks={createBlocks} onChange={setCreateBlocks} />
          ) : (
            <div className="space-y-1.5">
              <Label>HTML Body</Label>
              <textarea
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono min-h-[120px] resize-y focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                placeholder="<p>Hi {{first_name}},</p>"
                value={form.html}
                onChange={(e) => setForm((f) => ({ ...f, html: e.target.value }))}
              />
            </div>
          )}

          <p className="text-xs text-muted-foreground">Use {"{{variable_name}}"} syntax in subject and body. Pass values in the <code>variables</code> field when sending.</p>
          <div className="flex gap-2">
            <Button onClick={create} disabled={saving}>{saving ? "Saving…" : "Create Template"}</Button>
            <Button variant="outline" onClick={() => { setCreating(false); setCreateBlocks(defaultBlocks()); setCreateMode("visual"); }}>Cancel</Button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="rounded-lg border border-border bg-card divide-y divide-border overflow-hidden">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="px-5 py-4 flex items-center gap-4">
              <div className="h-3 w-40 bg-muted rounded animate-pulse" />
              <div className="h-3 w-28 bg-muted rounded animate-pulse" />
              <div className="h-3 w-16 bg-muted rounded animate-pulse ml-auto" />
            </div>
          ))}
        </div>
      ) : templates.length === 0 ? (
        <div className="rounded-lg border border-border bg-card p-10 text-center space-y-3">
          <FileText className="h-8 w-8 text-muted-foreground mx-auto" />
          <p className="text-sm text-muted-foreground">No templates yet. Create your first one to reuse across sends.</p>
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4 mr-1.5" /> Create template
          </Button>
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground border-b border-border bg-muted/40">
                <th className="px-5 py-3 font-medium">Name</th>
                <th className="px-5 py-3 font-medium">Subject</th>
                <th className="px-5 py-3 font-medium">Updated</th>
                <th className="px-5 py-3 font-medium w-32"></th>
              </tr>
            </thead>
            <tbody>
              {templates.map((t) => (
                <tr key={t.id} className="border-b border-border last:border-0 hover:bg-muted/20">
                  <td className="px-5 py-3 font-medium">{t.name}</td>
                  <td className="px-5 py-3 text-muted-foreground max-w-xs truncate">{t.subject}</td>
                  <td className="px-5 py-3 text-muted-foreground text-xs">{new Date(t.updatedAt ?? t.createdAt).toLocaleDateString()}</td>
                  <td className="px-5 py-3">
                    <div className="flex gap-1">
                      <Button variant="ghost" size="icon" className="h-7 w-7" title="Preview" onClick={() => setPreviewTemplate(t)}>
                        <Eye className="h-3.5 w-3.5" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-7 w-7" title="Edit" onClick={() => openEdit(t)}>
                        <Edit2 className="h-3.5 w-3.5" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-7 w-7" title="Version History" onClick={() => setHistoryTemplate(t)}>
                        <History className="h-3.5 w-3.5" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" title="Delete" onClick={() => del(t.id)}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {previewTemplate && (
        <TemplatePreviewModal template={previewTemplate} onClose={() => setPreviewTemplate(null)} />
      )}

      {historyTemplate && primaryKey?.keyRaw && (
        <VersionHistoryModal
          template={historyTemplate}
          apiKey={primaryKey.keyRaw}
          onClose={() => setHistoryTemplate(null)}
          onRestored={load}
        />
      )}

      {/* Version history legend */}
      {templates.length > 0 && (
        <p className="text-xs text-muted-foreground flex items-center gap-1.5">
          <Check className="h-3 w-3 text-[oklch(0.55_0.16_145)]" />
          Every edit automatically saves the previous version — click <History className="h-3 w-3 inline" /> to browse and restore.
        </p>
      )}
    </div>
  );
}
