import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Mail, BookOpen, Activity, LifeBuoy, Send } from "lucide-react";
import { API_BASE } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export const Route = createFileRoute("/dashboard/support")({
  head: () => ({ meta: [{ title: "Support — Continuum" }] }),
  component: SupportPage,
});

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

const CHANNELS = [
  {
    icon: Mail,
    title: "Email support",
    desc: "For account issues, billing, or anything the assistant below can't help with.",
    action: "support@continuumapi.com",
    href: "mailto:support@continuumapi.com",
  },
  {
    icon: BookOpen,
    title: "Docs",
    desc: "Full API reference — every endpoint, request, and response shape.",
    action: "continuumapi.com/docs",
    href: "https://continuumapi.com/docs",
  },
  {
    icon: Activity,
    title: "Status page",
    desc: "Live uptime and incident history for every Continuum service.",
    action: "continuumapi.com/status",
    href: "https://continuumapi.com/status",
  },
];

function SupportPage() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, loading]);

  const send = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || loading) return;
    setError(null);
    const next: ChatMessage[] = [...messages, { role: "user", content: trimmed }];
    setMessages(next);
    setInput("");
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/v1/chat/public`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: trimmed, history: messages.slice(-16) }),
      });
      const data = (await res.json()) as { reply?: string; message?: string };
      if (!res.ok) {
        setError(data.message ?? "Something went wrong — try again in a moment.");
        return;
      }
      setMessages([...next, { role: "assistant", content: data.reply ?? "" }]);
    } catch {
      setError("Couldn't reach the assistant. Try email support instead.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-display font-medium tracking-tight">Support</h1>
        <p className="text-sm text-muted-foreground">
          Ask the assistant below, or reach us directly.
        </p>
      </header>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {CHANNELS.map((c) => (
          <a
            key={c.title}
            href={c.href}
            target={c.href.startsWith("http") ? "_blank" : undefined}
            rel={c.href.startsWith("http") ? "noopener noreferrer" : undefined}
            className="rounded-lg border border-border bg-card p-4 flex flex-col gap-2 hover:border-foreground/30 transition-colors"
          >
            <c.icon className="h-4.5 w-4.5 text-muted-foreground" />
            <div className="text-sm font-medium">{c.title}</div>
            <p className="text-xs text-muted-foreground leading-relaxed flex-1">{c.desc}</p>
            <span className="text-xs font-medium underline underline-offset-2">{c.action}</span>
          </a>
        ))}
      </div>

      <div className="rounded-lg border border-border bg-card overflow-hidden flex flex-col" style={{ height: 480 }}>
        <div className="px-4 py-3 border-b border-border flex items-center gap-2.5">
          <LifeBuoy className="h-4 w-4 text-muted-foreground" />
          <div>
            <div className="text-sm font-medium">Ask the assistant</div>
            <div className="text-xs text-muted-foreground">Answers on pricing, features, and docs — email support for account-specific issues.</div>
          </div>
        </div>

        <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-2.5">
          {messages.length === 0 && (
            <p className="text-xs text-muted-foreground">No questions yet — ask anything about Continuum below.</p>
          )}
          {messages.map((m, i) => (
            <div
              key={i}
              className={`max-w-[85%] rounded-lg px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap ${
                m.role === "user"
                  ? "ml-auto bg-foreground text-background"
                  : "bg-muted text-foreground border border-border"
              }`}
            >
              {m.content}
            </div>
          ))}
          {loading && (
            <div className="flex gap-1 px-3 py-2">
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  className="h-1.5 w-1.5 rounded-full bg-muted-foreground animate-pulse"
                  style={{ animationDelay: `${i * 0.15}s` }}
                />
              ))}
            </div>
          )}
          {error && <div className="text-xs text-destructive">{error}</div>}
        </div>

        <form
          onSubmit={(e) => { e.preventDefault(); void send(input); }}
          className="flex items-center gap-2 p-3 border-t border-border"
        >
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask a question…"
            className="flex-1 h-9 text-xs"
          />
          <Button type="submit" size="sm" disabled={loading || !input.trim()}>
            <Send className="h-3.5 w-3.5 mr-1" /> Send
          </Button>
        </form>
      </div>
    </div>
  );
}
