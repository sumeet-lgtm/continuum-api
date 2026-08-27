// GA4 helper. Loads gtag.js once (respecting Do Not Track) and exposes
// typed helpers for the events we track.

const MEASUREMENT_ID = "G-ZQMEV0QRY5";

export const PLAN_VALUES: Record<string, number> = {
  starter: 25,
  growth: 49,
  scale: 199,
};

type GtagFn = (...args: unknown[]) => void;

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: GtagFn;
  }
}

let initialized = false;

function isDoNotTrack(): boolean {
  if (typeof navigator === "undefined") return false;
  const dnt =
    navigator.doNotTrack ||
    (window as unknown as { doNotTrack?: string }).doNotTrack;
  return dnt === "1";
}

export function initAnalytics() {
  if (initialized) return;
  if (typeof window === "undefined") return;
  if (isDoNotTrack()) return;
  initialized = true;

  const s = document.createElement("script");
  s.async = true;
  s.src = `https://www.googletagmanager.com/gtag/js?id=${MEASUREMENT_ID}`;
  document.head.appendChild(s);

  window.dataLayer = window.dataLayer || [];
  const gtag: GtagFn = function (...args: unknown[]) {
    window.dataLayer!.push(args);
  };
  window.gtag = gtag;
  gtag("js", new Date());
  gtag("config", MEASUREMENT_ID);
}

export function trackEvent(name: string, params?: Record<string, unknown>) {
  if (typeof window === "undefined") return;
  if (!window.gtag) return;
  window.gtag("event", name, params ?? {});
}

const SIGNUP_KEY = "ga_signup_fired";

export function trackSignupOnce(userId: string, method: string) {
  if (typeof window === "undefined") return;
  try {
    const prev = window.localStorage.getItem(SIGNUP_KEY);
    if (prev === userId) return;
    window.localStorage.setItem(SIGNUP_KEY, userId);
  } catch {
    // ignore storage errors — still fire once per session
  }
  trackEvent("sign_up", { method });
}
