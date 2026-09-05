import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect, useRef } from "react";
import { toast } from "sonner";
import { Copy, Check, Code2, Eye, Settings2, Zap } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/dashboard/widget")({
  head: () => ({ meta: [{ title: "Verification Widget — Continuum" }] }),
  component: WidgetPage,
});

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => { navigator.clipboard.writeText(text); setCopied(true); toast.success("Copied"); setTimeout(() => setCopied(false), 2000); }}
      className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-[oklch(0.55_0.16_145)]" /> : <Copy className="h-3.5 w-3.5" />}
      {copied ? "Copied" : label}
    </button>
  );
}

type TriggerMode = "blur" | "submit" | "typing";
type Theme = "light" | "dark" | "auto";

const THEMES: { value: Theme; label: string }[] = [
  { value: "auto", label: "Auto (match page)" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];
const TRIGGERS: { value: TriggerMode; label: string; desc: string }[] = [
  { value: "blur", label: "On blur", desc: "Validates when user leaves the field" },
  { value: "typing", label: "While typing", desc: "Validates 600ms after typing stops" },
  { value: "submit", label: "On submit", desc: "Validates before form submission" },
];

function genSnippet(apiKey: string, trigger: TriggerMode, theme: Theme, selector: string, errorMsg: string) {
  return `<!-- Continuum Verification Widget -->
<script>
(function(w,d,s){
  var x=d.createElement(s),y=d.getElementsByTagName(s)[0];
  x.src='https://cdn.continuumapi.com/widget/v1.js';
  x.dataset.key=${JSON.stringify(apiKey)};
  x.dataset.trigger=${JSON.stringify(trigger)};
  x.dataset.theme=${JSON.stringify(theme)};
  x.dataset.selector=${JSON.stringify(selector)};
  x.dataset.error=${JSON.stringify(errorMsg)};
  x.async=true;
  y.parentNode.insertBefore(x,y);
})(window,document,'script');
</script>`;
}

function genNpmSnippet(apiKey: string, trigger: TriggerMode) {
  return `import { ContinuumWidget } from '@continuumapi/widget';

const widget = new ContinuumWidget({
  apiKey: ${JSON.stringify(apiKey)},
  trigger: ${JSON.stringify(trigger)},
  onResult: (email, result) => {
    // result.valid, result.disposable, result.score
    if (!result.valid) {
      showError('Please enter a valid email address');
    }
  },
});

widget.attach('#email-input');`;
}

function LivePreview({ trigger, theme }: { trigger: TriggerMode; theme: Theme }) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "checking" | "valid" | "invalid" | "risky">("idle");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isDark = theme === "dark" || (theme === "auto" && window.matchMedia("(prefers-color-scheme: dark)").matches);

  function simulateCheck(v: string) {
    if (!v.includes("@")) { setStatus("invalid"); return; }
    setStatus("checking");
    setTimeout(() => {
      const domain = v.split("@")[1] ?? "";
      if (["mailinator.com", "guerrillamail.com", "tempmail.com", "throwaway.email", "yopmail.com"].some(d => domain.endsWith(d))) {
        setStatus("risky");
      } else if (v.includes(".") && v.length > 5) {
        setStatus("valid");
      } else {
        setStatus("invalid");
      }
    }, 650);
  }

  function handleChange(v: string) {
    setEmail(v);
    if (trigger === "typing") {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (v.length > 3) {
        timerRef.current = setTimeout(() => simulateCheck(v), 600);
      } else {
        setStatus("idle");
      }
    } else {
      setStatus("idle");
    }
  }

  function handleBlur() {
    if (trigger === "blur" && email.length > 3) simulateCheck(email);
  }

  const STATUS_ICONS = {
    idle: null,
    checking: <span className="h-3.5 w-3.5 rounded-full border-2 border-current border-t-transparent animate-spin inline-block" />,
    valid: <Check className="h-3.5 w-3.5 text-[oklch(0.55_0.16_145)]" />,
    invalid: <span className="text-[oklch(0.58_0.22_27)] font-bold text-xs">✕</span>,
    risky: <span className="text-[oklch(0.65_0.16_75)] font-bold text-xs">!</span>,
  };
  const STATUS_MSG = {
    idle: null,
    checking: <span className="text-muted-foreground">Verifying…</span>,
    valid: <span className="text-[oklch(0.55_0.16_145)]">Valid email address</span>,
    invalid: <span className="text-[oklch(0.58_0.22_27)]">Please enter a valid email address</span>,
    risky: <span className="text-[oklch(0.65_0.16_75)]">Disposable or temporary email detected</span>,
  };

  return (
    <div className={cn("rounded-xl border p-6 space-y-3 text-sm", isDark ? "bg-zinc-900 border-zinc-700 text-white" : "bg-white border-zinc-200 text-zinc-900")}>
      <label className={cn("block text-xs font-medium mb-1", isDark ? "text-zinc-300" : "text-zinc-600")}>Email address</label>
      <div className="relative">
        <input
          value={email}
          onChange={(e) => handleChange(e.target.value)}
          onBlur={handleBlur}
          placeholder="you@company.com"
          className={cn(
            "w-full rounded-lg border px-3 py-2 text-sm outline-none transition-all pr-9",
            isDark ? "bg-zinc-800 border-zinc-600 text-white placeholder:text-zinc-500 focus:border-zinc-400" : "bg-white border-zinc-300 text-zinc-900 placeholder:text-zinc-400 focus:border-zinc-500",
            status === "valid" && "border-[oklch(0.55_0.16_145)]",
            status === "invalid" && "border-[oklch(0.58_0.22_27)]",
            status === "risky" && "border-[oklch(0.65_0.16_75)]",
          )}
        />
        <span className="absolute right-3 top-1/2 -translate-y-1/2">{STATUS_ICONS[status]}</span>
      </div>
      {STATUS_MSG[status] && <p className="text-xs">{STATUS_MSG[status]}</p>}
      {trigger === "submit" && (
        <button
          onClick={() => simulateCheck(email)}
          className={cn("w-full rounded-lg py-2 text-sm font-medium transition-colors mt-1", isDark ? "bg-white text-black hover:bg-zinc-200" : "bg-zinc-900 text-white hover:bg-zinc-700")}
        >
          Subscribe
        </button>
      )}
    </div>
  );
}

function WidgetPage() {
  const { primaryKey } = useAuth();
  const apiKey = primaryKey?.keyRaw ?? "cnt_your_api_key";

  const [trigger, setTrigger] = useState<TriggerMode>("blur");
  const [theme, setTheme] = useState<Theme>("auto");
  const [selector, setSelector] = useState("#email");
  const [errorMsg, setErrorMsg] = useState("Please enter a valid email address.");
  const [tab, setTab] = useState<"cdn" | "npm">("cdn");

  const snippet = genSnippet(apiKey, trigger, theme, selector, errorMsg);
  const npmSnippet = genNpmSnippet(apiKey, trigger);

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-display font-medium tracking-tight">Verification Widget</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Drop one script tag on your signup form to get real-time email verification with zero backend work.
        </p>
      </div>

      {/* Feature pills */}
      <div className="flex flex-wrap gap-2">
        {["< 200ms validation", "Disposable email detection", "DNS MX check", "No CORS setup", "Framework agnostic"].map((f) => (
          <span key={f} className="inline-flex items-center gap-1 rounded-full border border-border px-3 py-1 text-xs text-muted-foreground">
            <Zap className="h-3 w-3" />{f}
          </span>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Config panel */}
        <div className="space-y-5">
          <div className="rounded-lg border border-border bg-card p-5 space-y-4">
            <div className="flex items-center gap-2 mb-1">
              <Settings2 className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-sm font-medium">Configuration</h2>
            </div>

            {/* Trigger */}
            <div className="space-y-2">
              <p className="text-xs font-medium">Validation trigger</p>
              <div className="grid grid-cols-3 gap-2">
                {TRIGGERS.map((t) => (
                  <button
                    key={t.value}
                    onClick={() => setTrigger(t.value)}
                    className={cn("rounded-md border px-3 py-2 text-xs text-left transition-colors", trigger === t.value ? "border-foreground bg-foreground/5 font-medium" : "border-border hover:border-foreground/40")}
                  >
                    <p>{t.label}</p>
                    <p className="text-muted-foreground mt-0.5 leading-tight">{t.desc}</p>
                  </button>
                ))}
              </div>
            </div>

            {/* Theme */}
            <div className="space-y-2">
              <p className="text-xs font-medium">Theme</p>
              <div className="grid grid-cols-3 gap-2">
                {THEMES.map((t) => (
                  <button
                    key={t.value}
                    onClick={() => setTheme(t.value)}
                    className={cn("rounded-md border px-3 py-2 text-xs transition-colors", theme === t.value ? "border-foreground bg-foreground/5 font-medium" : "border-border hover:border-foreground/40")}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Selector */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium">CSS selector</label>
              <input
                value={selector}
                onChange={(e) => setSelector(e.target.value)}
                className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-xs font-mono outline-none focus:border-foreground/60"
                placeholder="#email-input"
              />
              <p className="text-xs text-muted-foreground">The input field to attach the widget to</p>
            </div>

            {/* Error message */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium">Error message</label>
              <input
                value={errorMsg}
                onChange={(e) => setErrorMsg(e.target.value)}
                className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-xs outline-none focus:border-foreground/60"
              />
            </div>
          </div>

          {/* Live preview */}
          <div className="rounded-lg border border-border bg-card p-5">
            <div className="flex items-center gap-2 mb-3">
              <Eye className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-sm font-medium">Live preview</h2>
              <span className="ml-auto text-xs text-muted-foreground">Simulated — try typing an email</span>
            </div>
            <LivePreview trigger={trigger} theme={theme} />
          </div>
        </div>

        {/* Code panel */}
        <div className="space-y-4">
          <div className="rounded-lg border border-border bg-card overflow-hidden">
            <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
              <Code2 className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-sm font-medium">Installation code</h2>
              <div className="ml-auto flex gap-3">
                <button onClick={() => setTab("cdn")} className={cn("text-xs", tab === "cdn" ? "text-foreground font-medium" : "text-muted-foreground")}>CDN (HTML)</button>
                <span className="text-border">|</span>
                <button onClick={() => setTab("npm")} className={cn("text-xs", tab === "npm" ? "text-foreground font-medium" : "text-muted-foreground")}>npm / ESM</button>
              </div>
            </div>
            <div className="relative">
              <pre className="text-xs font-mono leading-relaxed p-4 overflow-x-auto bg-muted/20 whitespace-pre-wrap break-all">
                {tab === "cdn" ? snippet : npmSnippet}
              </pre>
              <div className="absolute top-3 right-3">
                <CopyButton text={tab === "cdn" ? snippet : npmSnippet} label="Copy code" />
              </div>
            </div>
          </div>

          {/* How it works */}
          <div className="rounded-lg border border-border bg-card p-5 space-y-3">
            <h2 className="text-sm font-medium">How it works</h2>
            <ol className="space-y-2.5">
              {[
                ["Add the script", "Paste the snippet above just before </body> in your HTML."],
                ["Widget attaches", "The widget finds your email input using the CSS selector and binds to it."],
                ["User types / blurs", "On your chosen trigger, the widget calls /v1/verify in the background."],
                ["Instant feedback", "A green check, warning, or error appears inline — no page reload needed."],
                ["Block bad emails", "Invalid or disposable addresses are flagged before the form submits."],
              ].map(([title, desc], i) => (
                <li key={i} className="flex gap-3">
                  <span className="flex-shrink-0 w-5 h-5 rounded-full bg-muted flex items-center justify-center text-[10px] font-medium tabular-nums">{i + 1}</span>
                  <div>
                    <p className="text-xs font-medium">{title}</p>
                    <p className="text-xs text-muted-foreground">{desc}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>

          {/* Callback reference */}
          <div className="rounded-lg border border-border bg-card p-5 space-y-2">
            <h2 className="text-sm font-medium">Callback data</h2>
            <p className="text-xs text-muted-foreground">The widget fires a custom event you can listen to:</p>
            <pre className="text-xs font-mono bg-muted/20 rounded-md p-3 overflow-x-auto">{`document.addEventListener('continuum:verify', (e) => {
  const { email, valid, score, disposable, reason } = e.detail;
});`}</pre>
            <table className="w-full text-xs mt-2">
              <thead>
                <tr className="text-muted-foreground">
                  <th className="text-left py-1 pr-3 font-medium">Field</th>
                  <th className="text-left py-1 font-medium">Description</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {[
                  ["email", "The email address that was verified"],
                  ["valid", "Boolean — true if safe to accept"],
                  ["score", "0–1 confidence score"],
                  ["disposable", "Boolean — true if a throwaway service"],
                  ["reason", '"valid" | "invalid_format" | "no_mx" | "disposable" | "blocked"'],
                ].map(([f, d]) => (
                  <tr key={f}>
                    <td className="py-1.5 pr-3 font-mono text-[11px] text-foreground">{f}</td>
                    <td className="py-1.5 text-muted-foreground">{d}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
