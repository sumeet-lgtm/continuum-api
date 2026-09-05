import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Eye, X, Type, MousePointerClick, Image, Minus, AlignLeft, FileText, Code2, GripVertical } from "lucide-react";

// Shared between Templates and Campaigns — previously two different editors
// (a block editor here, a free-form rich-text box in Campaigns) that
// produced HTML in incompatible shapes despite both existing for the exact
// same job. See dashboard.campaigns.tsx and dashboard.templates.tsx for the
// two call sites.

export type BlockType = "header" | "text" | "button" | "image" | "divider" | "footer" | "custom";

interface HeaderBlock  { type: "header";  id: string; company: string; logoUrl: string; bgColor: string; }
interface TextBlock    { type: "text";    id: string; content: string; fontSize: number; color: string; bold: boolean; }
interface ButtonBlock  { type: "button";  id: string; label: string; href: string; bgColor: string; textColor: string; }
interface ImageBlock   { type: "image";   id: string; src: string; alt: string; maxWidth: number; }
interface DividerBlock { type: "divider"; id: string; color: string; }
interface FooterBlock  { type: "footer";  id: string; text: string; color: string; }
// Raw-HTML passthrough — the escape hatch for anything the structured
// blocks don't model yet, and the safe landing spot for HTML that arrived
// from outside this editor (an existing campaign's saved body, a template
// loaded in) rather than fragile-parsing it back into the block types above.
interface CustomBlock  { type: "custom";  id: string; html: string; }

export type Block = HeaderBlock | TextBlock | ButtonBlock | ImageBlock | DividerBlock | FooterBlock | CustomBlock;

export function uid(): string { return Math.random().toString(36).slice(2, 10); }

export function defaultBlocks(): Block[] {
  return [
    { type: "header",  id: uid(), company: "Your Company", logoUrl: "", bgColor: "#1a1a1a" },
    { type: "text",    id: uid(), content: "Hi {{first_name}},", fontSize: 15, color: "#374151", bold: false },
    { type: "text",    id: uid(), content: "Thank you for being a valued customer. Here's an update we thought you'd want to know about.", fontSize: 14, color: "#6b7280", bold: false },
    { type: "button",  id: uid(), label: "Get Started", href: "{{action_url}}", bgColor: "#111827", textColor: "#ffffff" },
    { type: "divider", id: uid(), color: "#e5e7eb" },
    { type: "footer",  id: uid(), text: "© 2026 Your Company · 123 Main St · Unsubscribe", color: "#9ca3af" },
  ];
}

// Wraps arbitrary existing HTML (a template loaded in, a campaign's saved
// body) as a single custom block instead of destructively re-parsing it
// into structured blocks — the safe default whenever content didn't
// originate in this editor.
export function htmlAsCustomBlocks(html: string): Block[] {
  if (!html.trim()) return defaultBlocks();
  return [{ type: "custom", id: uid(), html }];
}

export function blocksToHtml(blocks: Block[]): string {
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
      case "custom":
        return `<tr><td>${b.html}</td></tr>`;
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
  custom:  <Code2 className="h-3.5 w-3.5" />,
};

const BLOCK_LABELS: Record<BlockType, string> = {
  header:  "Header",
  text:    "Text",
  button:  "Button",
  image:   "Image",
  divider: "Divider",
  footer:  "Footer",
  custom:  "Custom HTML",
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
    case "custom": return <div className="p-3 bg-muted/30 rounded-b-md border-t border-border space-y-1">
      <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Raw HTML</label>
      <textarea className="w-full rounded border border-input bg-background px-2 py-1.5 text-xs font-mono min-h-[100px] resize-y focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" value={block.html} onChange={(e) => onChange({ ...block, html: e.target.value })} spellCheck={false} />
    </div>;
  }
}

export function EmailBlockEditor({ blocks, onChange }: { blocks: Block[]; onChange: (b: Block[]) => void }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

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
  const reorder = (fromId: string, toId: string) => {
    if (fromId === toId) return;
    const from = blocks.findIndex((b) => b.id === fromId);
    const to = blocks.findIndex((b) => b.id === toId);
    if (from === -1 || to === -1) return;
    const next = [...blocks];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved!);
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
      case "custom":  b = { type, id: uid(), html: "<p>Custom HTML…</p>" }; break;
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
          const isDragOver = dragOverId === block.id && dragId !== block.id;
          return (
            <div key={block.id}>
              <div
                draggable
                onDragStart={() => setDragId(block.id)}
                onDragEnd={() => { setDragId(null); setDragOverId(null); }}
                onDragOver={(e) => { e.preventDefault(); setDragOverId(block.id); }}
                onDrop={(e) => { e.preventDefault(); if (dragId) reorder(dragId, block.id); setDragId(null); setDragOverId(null); }}
                className={`group flex items-center gap-2 px-3 py-2 cursor-pointer select-none transition-colors ${isSelected ? "bg-muted" : "hover:bg-muted/40"} ${isDragOver ? "border-t-2 border-t-foreground" : ""}`}
                onClick={() => setSelectedId(isSelected ? null : block.id)}
              >
                <span className="text-muted-foreground/50 cursor-grab active:cursor-grabbing" title="Drag to reorder">
                  <GripVertical className="h-3.5 w-3.5" />
                </span>
                <span className="text-muted-foreground">{BLOCK_ICONS[block.type]}</span>
                <span className="text-xs font-medium flex-1 truncate">
                  {BLOCK_LABELS[block.type]}
                  {block.type === "text"   && <span className="ml-2 text-muted-foreground font-normal truncate">{block.content.slice(0, 40)}</span>}
                  {block.type === "button" && <span className="ml-2 text-muted-foreground font-normal">{block.label}</span>}
                </span>
                <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 shrink-0" onClick={(e) => e.stopPropagation()}>
                  <button className="rounded p-0.5 hover:bg-muted-foreground/20 disabled:opacity-30" disabled={i === 0} onClick={() => move(block.id, -1)} title="Move up">↑</button>
                  <button className="rounded p-0.5 hover:bg-muted-foreground/20 disabled:opacity-30" disabled={i === blocks.length - 1} onClick={() => move(block.id, 1)} title="Move down">↓</button>
                  <button className="rounded p-0.5 hover:bg-destructive/20 text-destructive" onClick={() => remove(block.id)} title="Remove"><X className="h-3 w-3" /></button>
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
        {(["header", "text", "button", "image", "divider", "footer", "custom"] as BlockType[]).map((t) => (
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
