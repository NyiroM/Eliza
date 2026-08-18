// app/components/LanAccessPanel.tsx — dashboard banner: LAN + Tailscale URLs + gate / logout.
"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { BTN_GHOST_SM } from "../../lib/ui/dashboardButtons";

type ServerInfo = {
  accessMode?: string;
  accessModeLabel?: string;
  gateEnabled?: boolean;
  localhostUrl?: string;
  lanUrls?: string[];
  tailscaleUrls?: string[];
  remoteHint?: string;
  wanNote?: string;
  port?: number;
};

type AuthStatus = {
  gateEnabled?: boolean;
  authenticated?: boolean;
};

export function LanAccessPanel() {
  const router = useRouter();
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [gateEnabled, setGateEnabled] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const statusRes = await fetch("/api/auth/status", { cache: "no-store" });
        const status = (await statusRes.json()) as AuthStatus;
        if (cancelled) return;
        setGateEnabled(Boolean(status.gateEnabled));

        const infoRes = await fetch("/api/server-info", { cache: "no-store" });
        if (cancelled) return;
        if (infoRes.status === 401) {
          router.replace("/login");
          return;
        }
        if (!infoRes.ok) {
          setLoadError("Could not load network access info.");
          return;
        }
        setInfo((await infoRes.json()) as ServerInfo);
      } catch {
        if (!cancelled) setLoadError("Could not load network access info.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  async function copyUrl(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(url);
      window.setTimeout(() => setCopied(null), 2000);
    } catch {
      /* ignore */
    }
  }

  async function logout() {
    try {
      await fetch("/api/auth/logout", {
        method: "POST",
        headers: { "X-Eliza-Internal": "true" },
      });
    } catch {
      /* ignore */
    }
    router.replace("/login");
    router.refresh();
  }

  const lanUrls = info?.lanUrls ?? [];
  const tailscaleUrls = info?.tailscaleUrls ?? [];
  const stepLabel = info?.accessMode === "tailscale" ? "steps 1–2" : "step 1 · Tailscale for remote";

  return (
    <section
      className="rounded-lg border border-slate-800 bg-slate-900/80 px-4 py-3 text-sm text-slate-300"
      aria-label="Network access"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">
            Network access · {stepLabel}
          </p>
          <p className="text-slate-200">
            {info?.accessModeLabel ?? "Same Wi‑Fi / LAN"}
            {gateEnabled ? (
              <span className="ml-2 text-emerald-400/90">· password gate on</span>
            ) : (
              <span className="ml-2 text-amber-300/90">· set ELIZA_GATE_PASSWORD for remote browsers</span>
            )}
          </p>
          <p className="text-xs text-slate-500">
            Full backend and Ollama run on this host. Same Wi‑Fi: use a LAN URL. Away from home: install
            Tailscale on this phone (same account), then open a Tailscale URL
            {gateEnabled ? " after the password screen" : ""}.
          </p>
        </div>
        {gateEnabled ? (
          <button type="button" onClick={() => void logout()} className={BTN_GHOST_SM}>
            Sign out
          </button>
        ) : null}
      </div>

      {loadError ? <p className="mt-2 text-xs text-amber-300">{loadError}</p> : null}

      <ul className="mt-3 space-y-1.5">
        {info?.localhostUrl ? (
          <li className="flex flex-wrap items-center gap-2 text-xs">
            <span className="shrink-0 text-slate-500">This PC</span>
            <code className="rounded bg-slate-950 px-2 py-0.5 text-slate-200">{info.localhostUrl}</code>
          </li>
        ) : null}
        {lanUrls.length === 0 && info ? (
          <li className="text-xs text-amber-200/90">
            No LAN IPv4 detected yet. Ensure the host is on Wi‑Fi/Ethernet and the server listens on{" "}
            <code className="text-slate-300">0.0.0.0</code> (default <code className="text-slate-300">npm run dev</code>
            ).
          </li>
        ) : null}
        {lanUrls.map((url) => (
          <li key={url} className="flex flex-wrap items-center gap-2 text-xs">
            <span className="shrink-0 text-emerald-500/90">LAN</span>
            <code className="rounded bg-slate-950 px-2 py-0.5 text-emerald-100">{url}</code>
            <button type="button" onClick={() => void copyUrl(url)} className={BTN_GHOST_SM}>
              {copied === url ? "Copied" : "Copy"}
            </button>
          </li>
        ))}
        {tailscaleUrls.length === 0 && info ? (
          <li className="text-xs text-slate-500">
            No Tailscale IP yet — install Tailscale on this host for remote access (no router port forward).
          </li>
        ) : null}
        {tailscaleUrls.map((url) => (
          <li key={url} className="flex flex-wrap items-center gap-2 text-xs">
            <span className="shrink-0 text-sky-400/90">Tailscale</span>
            <code className="rounded bg-slate-950 px-2 py-0.5 text-sky-100">{url}</code>
            <button type="button" onClick={() => void copyUrl(url)} className={BTN_GHOST_SM}>
              {copied === url ? "Copied" : "Copy"}
            </button>
          </li>
        ))}
      </ul>

      {info?.remoteHint ? <p className="mt-2 text-[11px] text-slate-500">{info.remoteHint}</p> : null}
      {info?.wanNote ? <p className="mt-1 text-[11px] text-slate-500">{info.wanNote}</p> : null}
    </section>
  );
}
