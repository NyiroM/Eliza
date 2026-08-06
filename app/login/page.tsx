// app/login/page.tsx
"use client";

import { FormEvent, Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { BTN_PRIMARY_LG } from "../../lib/ui/dashboardButtons";

function safeNextPath(raw: string | null): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return "/";
  if (raw.startsWith("/login")) return "/";
  return raw;
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const nextPath = safeNextPath(searchParams.get("next"));

  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gateEnabled, setGateEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/auth/status", { cache: "no-store" });
        const data = (await res.json()) as { gateEnabled?: boolean; authenticated?: boolean };
        if (cancelled) return;
        setGateEnabled(Boolean(data.gateEnabled));
        if (!data.gateEnabled || data.authenticated) {
          router.replace(nextPath);
        }
      } catch {
        if (!cancelled) setGateEnabled(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router, nextPath]);

  async function onSubmit(ev: FormEvent) {
    ev.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Eliza-Internal": "true",
        },
        body: JSON.stringify({ password }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; ok?: boolean };
      if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : "Sign-in failed.");
        setBusy(false);
        return;
      }
      router.replace(nextPath);
      router.refresh();
    } catch {
      setError("Could not reach the ELIZA host. Is the server running on this Wi‑Fi?");
      setBusy(false);
    }
  }

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-slate-950 px-4 text-slate-100">
      <div
        className="pointer-events-none absolute inset-0 opacity-90"
        style={{
          background:
            "radial-gradient(ellipse 80% 50% at 50% -20%, rgba(16,185,129,0.18), transparent), radial-gradient(ellipse 60% 40% at 100% 100%, rgba(51,65,85,0.5), transparent)",
        }}
        aria-hidden
      />
      <div className="relative w-full max-w-md space-y-8">
        <div className="space-y-2 text-center">
          <p className="text-4xl font-semibold tracking-tight text-emerald-50 sm:text-5xl">ELIZA</p>
          <p className="text-sm text-slate-400">
            Sign in to open the dashboard on this host. Backend and Ollama stay on the ELIZA machine.
          </p>
        </div>

        {gateEnabled === false ? (
          <p className="rounded-lg border border-slate-700 bg-slate-900/80 px-4 py-3 text-center text-sm text-slate-300">
            No gate password configured — redirecting…
          </p>
        ) : (
          <form
            onSubmit={onSubmit}
            className="space-y-4 rounded-xl border border-slate-800 bg-slate-900/70 p-6 shadow-xl shadow-black/30 backdrop-blur-sm"
          >
            <label className="flex flex-col gap-1.5 text-xs text-slate-400">
              <span className="font-medium uppercase tracking-wide">Password</span>
              <input
                type="password"
                name="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={busy || gateEnabled === null}
                className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-slate-100 outline-none ring-emerald-500/40 focus:ring-2"
                placeholder="ELIZA_GATE_PASSWORD"
                required
              />
            </label>
            {error ? (
              <p role="alert" className="text-sm text-amber-300">
                {error}
              </p>
            ) : null}
            <button type="submit" disabled={busy || !password} className={`${BTN_PRIMARY_LG} w-full`}>
              {busy ? "Signing in…" : "Open dashboard"}
            </button>
            <p className="text-[11px] leading-relaxed text-slate-500">
              Step 1: same Wi‑Fi / LAN only. Use the host PC&apos;s LAN address (shown on the dashboard after
              login). Worldwide access comes in a later step.
            </p>
          </form>
        )}
      </div>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <main className="flex min-h-screen items-center justify-center bg-slate-950 text-slate-400">
          Loading…
        </main>
      }
    >
      <LoginForm />
    </Suspense>
  );
}
