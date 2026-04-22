"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";

type UploadStatus = {
  loaded: boolean;
  uploaded_at?: string | null;
  skills_count?: number;
};

type ConstraintsState = {
  constraints: string[];
  updated_at?: string;
};

type SemanticHighlight = {
  phrase: string;
  sentiment: "positive" | "negative";
  reason: string;
};

type PipelineResult = {
  fit_score: number;
  matched_skills?: string[];
  missing_skills: string[];
  strength_highlights?: string[];
  seniority_match: boolean;
  summary: string;
  mathematical_breakdown?: string;
  vibe_warnings?: string[];
  semantic_highlights?: SemanticHighlight[];
  constraint_veto?: boolean;
  analysis_model?: string;
  metadata_fit_badge?: "Location Conflict" | "Preference Match" | null;
  extracted_entities?: {
    required_skills: string[];
    optional_skills: string[];
    experience_years: number | null;
    education: string | null;
    job_location?: string | null;
    work_model?: string;
    job_type?: string;
    benefits?: string[];
    commitments?: string[];
    metadata_constraint_notes?: string[];
  };
  application_bundle?: {
    cover_letter?: string;
    cv_rewrite_suggestions?: string[];
  };
  debug?: {
    fit_score_reconciled_from_components?: boolean;
    analysis_source?: string;
    cv_parser_source?: string;
    job_parser_source?: string;
    constraints_source?: string;
  };
};

function FitGauge({ score, vetoed }: { score: number; vetoed: boolean }) {
  const display = vetoed ? 0 : Math.max(0, Math.min(100, Math.round(score)));
  const pct = display / 100;
  const R = 42;
  const c = 2 * Math.PI * R;
  const dash = c * pct;
  const stroke =
    vetoed ? "#f87171" : display >= 72 ? "#34d399" : display >= 45 ? "#fbbf24" : "#fb923c";

  return (
    <div className="flex flex-col items-center justify-center py-1">
      <div className="relative h-44 w-44">
        <svg className="h-44 w-44 -rotate-90" viewBox="0 0 100 100" aria-hidden>
          <circle cx="50" cy="50" r={R} fill="none" stroke="#1e293b" strokeWidth="9" />
          <circle
            cx="50"
            cy="50"
            r={R}
            fill="none"
            stroke={stroke}
            strokeWidth="9"
            strokeLinecap="round"
            strokeDasharray={`${dash} ${c}`}
          />
        </svg>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
          <span className="text-4xl font-bold tabular-nums tracking-tight text-white">
            {display}
            <span className="text-xl font-semibold text-slate-400">%</span>
          </span>
          {vetoed ? (
            <span className="mt-0.5 text-[10px] font-bold uppercase tracking-widest text-red-400">
              Veto
            </span>
          ) : (
            <span className="mt-0.5 text-[10px] uppercase tracking-wider text-slate-500">
              Match strength
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function JobTextWithHighlights({
  text,
  highlights,
}: {
  text: string;
  highlights: SemanticHighlight[];
}) {
  if (!highlights.length) {
    return null;
  }
  type Mark = { start: number; end: number; sentiment: "positive" | "negative"; reason: string };
  const marks: Mark[] = [];
  const lower = text.toLowerCase();
  const sorted = [...highlights]
    .filter((h) => h.phrase?.trim())
    .sort((a, b) => b.phrase.trim().length - a.phrase.trim().length);
  const used = new Array(text.length).fill(false);
  for (const h of sorted) {
    const p = h.phrase.trim();
    let from = 0;
    while (true) {
      const idx = lower.indexOf(p.toLowerCase(), from);
      if (idx === -1) break;
      let overlap = false;
      for (let i = idx; i < idx + p.length; i++) {
        if (used[i]) {
          overlap = true;
          break;
        }
      }
      if (!overlap) {
        for (let i = idx; i < idx + p.length; i++) used[i] = true;
        marks.push({
          start: idx,
          end: idx + p.length,
          sentiment: h.sentiment,
          reason: h.reason,
        });
      }
      from = idx + 1;
    }
  }
  marks.sort((a, b) => a.start - b.start);
  const nodes: ReactNode[] = [];
  let pos = 0;
  let k = 0;
  for (const m of marks) {
    if (m.start < pos) continue;
    if (m.start > pos) {
      nodes.push(<span key={`t-${k++}`}>{text.slice(pos, m.start)}</span>);
    }
    const cls =
      m.sentiment === "positive"
        ? "bg-emerald-700/55 text-emerald-50 ring-1 ring-emerald-500/30"
        : "bg-rose-800/55 text-rose-50 ring-1 ring-rose-500/35";
    nodes.push(
      <mark key={`m-${m.start}-${m.end}`} title={m.reason} className={`rounded px-0.5 ${cls}`}>
        {text.slice(m.start, m.end)}
      </mark>,
    );
    pos = m.end;
  }
  if (pos < text.length) {
    nodes.push(<span key={`t-${k++}`}>{text.slice(pos)}</span>);
  }

  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-slate-400">Semantic highlights</p>
      <p className="text-[11px] text-slate-500">Hover a mark for the model&apos;s rationale.</p>
      <div className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md border border-slate-700 bg-slate-950/80 p-3 text-sm leading-relaxed text-slate-200">
        {nodes.length ? nodes : text}
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const [status, setStatus] = useState<UploadStatus>({ loaded: false });
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [jobText, setJobText] = useState("");
  const [refineText, setRefineText] = useState("");
  const [result, setResult] = useState<PipelineResult | null>(null);
  const [loadingUpload, setLoadingUpload] = useState(false);
  const [loadingAnalysis, setLoadingAnalysis] = useState(false);
  const [constraintsBusy, setConstraintsBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [constraints, setConstraints] = useState<ConstraintsState>({
    constraints: [],
  });
  const [ollamaModels, setOllamaModels] = useState<string[]>(["llama3"]);
  const [selectedModel, setSelectedModel] = useState("llama3");
  const [modelsListWarning, setModelsListWarning] = useState<string | null>(null);
  const [modelsRefreshing, setModelsRefreshing] = useState(false);
  const [analysisStep, setAnalysisStep] = useState(1);
  const [targetLocation, setTargetLocation] = useState("");
  const [prefsLocationBusy, setPrefsLocationBusy] = useState(false);
  const [loadingAssets, setLoadingAssets] = useState(false);
  const canRunAnalysis =
    status.loaded && jobText.trim().length > 0 && !loadingAnalysis && !loadingAssets;

  const loadOllamaModels = useCallback(async () => {
    setModelsRefreshing(true);
    setModelsListWarning(null);
    try {
      const response = await fetch("/api/ollama-models");
      const data = (await response.json()) as {
        models?: string[];
        ok?: boolean;
        warning?: string;
      };
      const list =
        Array.isArray(data.models) && data.models.length > 0 ? data.models : ["llama3"];
      setOllamaModels(list);
      if (data.ok === false && typeof data.warning === "string") {
        setModelsListWarning(data.warning);
      }
      setSelectedModel((prev) => (list.includes(prev) ? prev : list[0]));
    } catch {
      setOllamaModels(["llama3"]);
      setModelsListWarning(
        "Could not load installed models. Ensure Ollama is running and the server can run `ollama list`. Using llama3.",
      );
      setSelectedModel("llama3");
    } finally {
      setModelsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadOllamaModels();
  }, [loadOllamaModels]);

  useEffect(() => {
    void checkCvStatus();
  }, []);

  useEffect(() => {
    void loadPreferredLocation();
  }, []);

  async function loadPreferredLocation() {
    try {
      const response = await fetch("/api/user-preferences");
      const data = (await response.json()) as { preferred_location?: string | null };
      if (typeof data.preferred_location === "string" && data.preferred_location.trim()) {
        setTargetLocation(data.preferred_location.trim());
      }
    } catch {
      /* ignore */
    }
  }

  async function savePreferredLocation() {
    setPrefsLocationBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/user-preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preferred_location: targetLocation.trim() || null }),
      });
      const data = (await response.json()) as { preferred_location?: string | null; error?: string };
      if (!response.ok) {
        setMessage(data.error ?? "Could not save target location.");
        return;
      }
      if (typeof data.preferred_location === "string") {
        setTargetLocation(data.preferred_location);
      } else {
        setTargetLocation("");
      }
      setMessage("Target location saved.");
    } catch {
      setMessage("Could not save target location.");
    } finally {
      setPrefsLocationBusy(false);
    }
  }

  async function checkCvStatus() {
    setMessage("");
    try {
      const response = await fetch("/api/upload-cv");
      const data = (await response.json()) as UploadStatus;
      setStatus(data);
    } catch {
      setMessage("Unable to check CV status.");
    }
  }

  async function uploadCv() {
    if (!selectedFile) {
      setMessage("Please choose a PDF CV first.");
      return;
    }

    setLoadingUpload(true);
    setMessage("");

    try {
      const formData = new FormData();
      formData.append("file", selectedFile);
      formData.append("model", selectedModel);

      const response = await fetch("/api/upload-cv", {
        method: "POST",
        body: formData,
      });
      const data = (await response.json()) as { error?: string };

      if (!response.ok) {
        setMessage(data.error ?? "CV upload failed.");
        return;
      }

      setMessage("CV uploaded and parsed successfully.");
      await checkCvStatus();
    } catch {
      setMessage("CV upload failed.");
    } finally {
      setLoadingUpload(false);
    }
  }

  async function runAnalysis() {
    if (!status.loaded) {
      setMessage("Please upload and parse a CV before running analysis.");
      return;
    }
    if (!jobText.trim()) {
      setMessage("Please paste a job description first.");
      return;
    }

    setLoadingAnalysis(true);
    setAnalysisStep(1);
    setMessage("");
    setResult(null);
    const stepInterval = setInterval(() => {
      setAnalysisStep((prev) => (prev >= 3 ? 3 : prev + 1));
    }, 1800);

    try {
      const response = await fetch("/api/pipeline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          job: jobText,
          refine_feedback: refineText,
          model: selectedModel,
          preferred_location: targetLocation.trim(),
        }),
      });
      const data = (await response.json()) as PipelineResult & { error?: string };

      if (!response.ok) {
        setMessage(data.error ?? "Analysis failed.");
        return;
      }

      setResult(data);
      if (refineText.trim()) {
        await loadConstraints();
      }
    } catch {
      setMessage("Could not connect to pipeline API.");
    } finally {
      clearInterval(stepInterval);
      setLoadingAnalysis(false);
    }
  }

  async function generateApplicationBundle() {
    if (!result || result.fit_score <= 0) {
      setMessage("Application bundle is only available when the fit score is above 0.");
      return;
    }
    setLoadingAssets(true);
    setMessage("");
    try {
      const response = await fetch("/api/generate-assets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          job_text: jobText.trim(),
          model: selectedModel,
          missing_skills: result.missing_skills,
          required_skills: result.extracted_entities?.required_skills ?? [],
          strength_highlights: result.strength_highlights ?? [],
        }),
      });
      const data = (await response.json()) as {
        application_bundle?: PipelineResult["application_bundle"];
        error?: string;
      };
      if (!response.ok) {
        setMessage(data.error ?? "Could not generate application bundle.");
        return;
      }
      if (data.application_bundle) {
        setResult((prev) => (prev ? { ...prev, application_bundle: data.application_bundle } : null));
        setMessage("Application bundle generated.");
      }
    } catch {
      setMessage("Could not connect to generate-assets API.");
    } finally {
      setLoadingAssets(false);
    }
  }

  async function saveConstraintOnly() {
    if (!refineText.trim()) {
      setMessage("Write a correction before saving constraints.");
      return;
    }
    setMessage("");
    try {
      const response = await fetch("/api/user-constraints", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ constraint: refineText }),
      });
      const data = (await response.json()) as ConstraintsState & { error?: string };
      if (!response.ok) {
        setMessage(data.error ?? "Could not save constraint.");
        return;
      }
      setConstraints({
        constraints: data.constraints ?? [],
        updated_at: data.updated_at,
      });
      setMessage("Constraint saved.");
    } catch {
      setMessage("Could not save constraint.");
    }
  }

  async function loadConstraints() {
    setConstraintsBusy(true);
    try {
      const response = await fetch("/api/user-constraints");
      const data = (await response.json()) as ConstraintsState;
      setConstraints({
        constraints: data.constraints ?? [],
        updated_at: data.updated_at,
      });
    } catch {
      setMessage("Could not load constraints.");
    } finally {
      setConstraintsBusy(false);
    }
  }

  async function deleteConstraint(item: string) {
    setConstraintsBusy(true);
    try {
      const response = await fetch("/api/user-constraints", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ constraint: item }),
      });
      const data = (await response.json()) as ConstraintsState & { error?: string };
      if (!response.ok) {
        setMessage(data.error ?? "Could not delete constraint.");
        return;
      }
      setConstraints({
        constraints: data.constraints ?? [],
        updated_at: data.updated_at,
      });
    } catch {
      setMessage("Could not delete constraint.");
    } finally {
      setConstraintsBusy(false);
    }
  }

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 p-4 md:p-6">
      <div className="mx-auto max-w-7xl space-y-8">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">ELIZA Dashboard</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-400">
            Upload your CV once, then paste a posting for semantic fit scoring, a transparent match
            breakdown, and optional application assets.
          </p>
        </header>

        <div className="grid grid-cols-1 gap-8 lg:grid-cols-2 lg:items-start">
          <div className="space-y-6">
            <section className="rounded-lg border border-slate-800 bg-slate-900 p-4 space-y-3">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
                CV status
              </h2>
          <div className="rounded-md border border-slate-700 p-3">
            <p className="text-sm">
              Status:{" "}
              <span className={status.loaded ? "text-green-400" : "text-orange-300"}>
                {status.loaded ? "Loaded" : "Not Loaded"}
              </span>
            </p>
            {status.loaded ? (
              <p className="mt-1 text-xs text-slate-400">
                Skills parsed: {status.skills_count ?? 0}
                {status.uploaded_at ? ` | Uploaded: ${status.uploaded_at}` : ""}
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <input
              type="file"
              accept="application/pdf"
              onChange={(event) => setSelectedFile(event.target.files?.[0] ?? null)}
              className="block text-sm text-slate-300 file:mr-3 file:rounded-md file:border-0 file:bg-slate-700 file:px-3 file:py-2 file:text-slate-100"
            />
            <button
              type="button"
              onClick={uploadCv}
              disabled={loadingUpload}
              className="rounded-md bg-blue-600 px-4 py-2 text-sm hover:bg-blue-500 disabled:bg-blue-900"
            >
              {loadingUpload ? "Uploading..." : "Upload CV PDF"}
            </button>
            <button
              type="button"
              onClick={() => {
                void checkCvStatus();
              }}
              className="rounded-md bg-slate-700 px-4 py-2 text-sm hover:bg-slate-600"
            >
              Refresh Status
            </button>
          </div>
            </section>

            <section className="rounded-lg border border-slate-800 bg-slate-900 p-4 space-y-4">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
                Target &amp; job input
              </h2>
              <div className="rounded-md border border-slate-700 bg-slate-950/60 p-3 space-y-2">
                <label htmlFor="target-location" className="text-sm font-medium text-slate-200">
                  Target location
                </label>
                <p className="text-xs text-slate-500">
                  Optional positive signal (e.g. &quot;Budapest&quot;, &quot;EU remote&quot;). Leave empty to stay
                  location-agnostic unless a saved constraint applies.
                </p>
                <input
                  id="target-location"
                  type="text"
                  value={targetLocation}
                  onChange={(event) => setTargetLocation(event.target.value)}
                  placeholder="e.g. Budapest, Hungary or Remote — EU"
                  className="w-full rounded-md border border-slate-700 bg-slate-950 p-2 text-sm"
                />
                <button
                  type="button"
                  onClick={() => {
                    void savePreferredLocation();
                  }}
                  disabled={prefsLocationBusy}
                  className="rounded-md bg-slate-700 px-4 py-2 text-sm hover:bg-slate-600 disabled:opacity-50"
                >
                  {prefsLocationBusy ? "Saving…" : "Save target location"}
                </button>
              </div>

              <div>
                <label htmlFor="job-description" className="text-sm font-medium text-slate-200">
                  Job description
                </label>
                <textarea
                  id="job-description"
                  value={jobText}
                  onChange={(event) => setJobText(event.target.value)}
                  placeholder="Paste the full job posting here…"
                  className="mt-1 min-h-[14rem] w-full rounded-md border border-slate-700 bg-slate-950 p-3 text-sm leading-relaxed md:min-h-[22rem]"
                />
              </div>
              {result?.semantic_highlights?.length ? (
                <JobTextWithHighlights
                  text={jobText}
                  highlights={result.semantic_highlights}
                />
              ) : null}

              <div className="flex flex-wrap items-center gap-2 border-t border-slate-800 pt-3">
                <label htmlFor="ollama-model" className="text-sm text-slate-300">
                  Ollama model
                </label>
            <select
              id="ollama-model"
              value={selectedModel}
              onChange={(event) => setSelectedModel(event.target.value)}
              className="rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm min-w-[10rem]"
            >
              {ollamaModels.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => {
                void loadOllamaModels();
              }}
              disabled={modelsRefreshing}
              className="rounded-md bg-slate-700 px-3 py-1.5 text-sm hover:bg-slate-600 disabled:opacity-50"
            >
              {modelsRefreshing ? "Refreshing…" : "Refresh Models"}
            </button>
          </div>
          {modelsListWarning ? (
            <p className="text-sm text-amber-300 rounded-md border border-amber-800/60 bg-amber-950/40 p-2">
              {modelsListWarning}
            </p>
          ) : null}
          <button
            type="button"
            onClick={runAnalysis}
            disabled={!canRunAnalysis}
            className="rounded-md bg-emerald-600 px-4 py-2 text-sm hover:bg-emerald-500 disabled:bg-emerald-900"
          >
            {loadingAnalysis ? `Processing Step ${analysisStep}/3...` : "Run Analysis"}
          </button>
          <p className="text-xs text-slate-400">
            Please upload a CV and paste a Job Description to start.
          </p>
          <div className="border-t border-slate-700 pt-3">
            <p className="text-sm font-medium mb-2">Refine Results (Persistent Constraint)</p>
            <input
              type="text"
              value={refineText}
              onChange={(event) => setRefineText(event.target.value)}
              placeholder='e.g. "I do not want PM roles", "I prefer remote work", "I want full-time only", or "I do not like working in Hungary"'
              className="w-full rounded-md border border-slate-700 bg-slate-950 p-2 text-sm"
            />
            <button
              type="button"
              onClick={saveConstraintOnly}
              className="mt-2 rounded-md bg-slate-700 px-4 py-2 text-sm hover:bg-slate-600"
            >
              Save Constraint
            </button>
            <button
              type="button"
              onClick={() => {
                void loadConstraints();
              }}
              className="mt-2 ml-2 rounded-md bg-slate-700 px-4 py-2 text-sm hover:bg-slate-600"
            >
              Refresh Constraints
            </button>
          </div>
            </section>
          </div>

          <div className="space-y-6 lg:sticky lg:top-6 lg:self-start">
            <section className="rounded-lg border border-slate-800 bg-slate-900 p-4 space-y-5">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
                Match output
              </h2>
          {!result ? (
            <p className="text-sm text-slate-400">
              Run analysis from the left column to see fit scoring and breakdown here.
            </p>
          ) : (
            <div className="space-y-5">
              <div className="flex flex-col items-center gap-5 border-b border-slate-800 pb-5 sm:flex-row sm:items-start sm:justify-between">
                <FitGauge score={result.fit_score} vetoed={Boolean(result.constraint_veto)} />
                <div className="min-w-0 flex-1 space-y-2 text-center sm:text-left">
                  {result.metadata_fit_badge ? (
                    <span
                      className={
                        result.metadata_fit_badge === "Location Conflict"
                          ? "inline-flex rounded-full border border-red-800/70 bg-red-950/50 px-2.5 py-1 text-[11px] font-medium text-red-200"
                          : "inline-flex rounded-full border border-emerald-800/70 bg-emerald-950/50 px-2.5 py-1 text-[11px] font-medium text-emerald-200"
                      }
                    >
                      {result.metadata_fit_badge}
                    </span>
                  ) : null}
                  <p className="text-xs text-slate-500">
                    Model:{" "}
                    <span className="font-medium text-slate-300">
                      {result.analysis_model ?? "llama3"}
                    </span>
                  </p>
                  <p className="text-sm text-slate-300">
                    Seniority alignment:{" "}
                    <span className={result.seniority_match ? "text-emerald-400" : "text-rose-400"}>
                      {result.seniority_match ? "Yes" : "No"}
                    </span>
                  </p>
                  {result.summary ? (
                    <p className="text-sm leading-relaxed text-slate-400">{result.summary}</p>
                  ) : null}
                </div>
              </div>

              {result.constraint_veto ? (
                <div className="rounded-md border-2 border-red-600 bg-red-950/35 p-3 text-sm text-red-100">
                  <p className="font-semibold tracking-wide">Constraint veto</p>
                  <p className="mt-1 text-xs text-red-200/90">
                    Final score is 0% because the posting conflicts with a hard rule in your saved
                    constraints.
                  </p>
                </div>
              ) : null}

              <div className="rounded-md border border-slate-600 bg-slate-950 p-3">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
                  Match analysis
                </p>
                <pre className="whitespace-pre-wrap font-mono text-sm leading-relaxed text-slate-100">
                  {result.mathematical_breakdown ?? "Not available."}
                </pre>
                <p className="mt-2 text-[11px] leading-snug text-slate-500">
                  The headline fit score always matches{" "}
                  <span className="font-medium text-slate-400">Final Score</span> on line 7. When the
                  model returns structured score components, line 6 is recomputed on the server so
                  the arithmetic sum matches that percentage
                  {result.debug?.fit_score_reconciled_from_components
                    ? " (this run was adjusted for consistency)."
                    : "."}
                </p>
              </div>

              <div className="rounded-md border border-slate-700 bg-slate-950/50 p-3">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
                  Corporate vibe
                </p>
                {(result.vibe_warnings ?? []).length > 0 ? (
                  <ul className="list-disc space-y-1 pl-4 text-sm text-slate-300">
                    {(result.vibe_warnings ?? []).map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-slate-500">
                    No notable tone or workload red flags surfaced in this pass.
                  </p>
                )}
              </div>

              <div className="rounded-md border border-slate-700 bg-slate-950/50 p-3">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
                  Constraints
                </p>
                {(result.extracted_entities?.metadata_constraint_notes ?? []).length > 0 ? (
                  <ul className="list-disc space-y-1 pl-4 text-sm text-slate-300">
                    {(result.extracted_entities?.metadata_constraint_notes ?? []).map((n, i) => (
                      <li key={`${i}-${n}`}>{n}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-slate-500">
                    No extra constraint conflicts were inferred from posting metadata.
                  </p>
                )}
              </div>

              <div className="rounded-md border border-slate-700 bg-slate-950/50 p-3">
                <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
                  Critical gaps
                </p>
                <p className="text-sm text-slate-200">
                  {result.missing_skills.join(", ") || "None flagged as required gaps."}
                </p>
              </div>

              <div className="rounded-md border border-slate-700 p-3">
                <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-400">
                  Requirement analysis
                </h3>
                <p className="text-xs text-slate-400">Location</p>
                <p className="mb-2 text-sm">
                  {result.extracted_entities?.job_location?.trim() || "Not specified"}
                </p>
                <p className="text-xs text-slate-400">Work model</p>
                <p className="mb-2 text-sm capitalize">
                  {(result.extracted_entities?.work_model ?? "unknown").replace(/-/g, " ")}
                </p>
                <p className="text-xs text-slate-400">Job type</p>
                <p className="mb-2 text-sm capitalize">
                  {(result.extracted_entities?.job_type ?? "unknown").replace(/-/g, " ")}
                </p>
                <p className="text-xs text-slate-400 mb-1">Benefits</p>
                <div className="mb-3 flex flex-wrap gap-1.5">
                  {(result.extracted_entities?.benefits ?? []).length === 0 ? (
                    <span className="text-sm text-slate-500">None listed</span>
                  ) : (
                    (result.extracted_entities?.benefits ?? []).map((tag, i) => (
                      <span
                        key={`${i}-${tag}`}
                        className="rounded-full border border-slate-600 bg-slate-800/80 px-2 py-0.5 text-xs text-slate-200"
                      >
                        {tag}
                      </span>
                    ))
                  )}
                </div>
                <p className="text-xs text-slate-400 mb-1">Commitments</p>
                <div className="mb-3 flex flex-wrap gap-1.5">
                  {(result.extracted_entities?.commitments ?? []).length === 0 ? (
                    <span className="text-sm text-slate-500">None listed</span>
                  ) : (
                    (result.extracted_entities?.commitments ?? []).map((tag, i) => (
                      <span
                        key={`${i}-${tag}`}
                        className="rounded-full border border-violet-900/50 bg-violet-950/40 px-2 py-0.5 text-xs text-violet-100"
                      >
                        {tag}
                      </span>
                    ))
                  )}
                </div>
                <p className="text-xs text-slate-400">Required skills</p>
                <p className="mb-2 text-sm">
                  {result.extracted_entities?.required_skills.join(", ") || "None"}
                </p>
                <p className="text-xs text-slate-400">Optional skills</p>
                <p className="mb-2 text-sm">
                  {result.extracted_entities?.optional_skills.join(", ") || "None"}
                </p>
                <p className="text-xs text-slate-400">Experience</p>
                <p className="mb-2 text-sm">
                  {result.extracted_entities?.experience_years != null
                    ? `${result.extracted_entities.experience_years} years`
                    : "Not specified"}
                </p>
                <p className="text-xs text-slate-400">Education</p>
                <p className="text-sm">
                  {result.extracted_entities?.education ?? "Not specified"}
                </p>
              </div>

              {result.application_bundle ? (
                <div className="space-y-3 rounded-md border border-slate-700 bg-slate-950/40 p-4">
                  <h3 className="text-sm font-medium text-slate-200">Application bundle</h3>
                  <div>
                    <p className="mb-1 text-xs text-slate-400">Cover letter</p>
                    <pre className="whitespace-pre-wrap rounded bg-slate-950 p-2 text-xs text-slate-200">
                      {result.application_bundle.cover_letter ?? "No cover letter generated."}
                    </pre>
                  </div>
                  <div>
                    <p className="mb-1 text-xs text-slate-400">CV rewrite suggestions</p>
                    <ul className="list-disc space-y-1 pl-4 text-xs text-slate-300">
                      {(result.application_bundle.cv_rewrite_suggestions ?? []).map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              ) : null}

              {result.fit_score > 0 ? (
                <div className="border-t border-slate-800 pt-4">
                  {!result.application_bundle ? (
                    loadingAssets ? (
                      <div
                        className="flex flex-col items-center justify-center gap-4 rounded-lg border border-blue-800/40 bg-slate-950/80 py-10"
                        aria-busy="true"
                        aria-label="Generating application bundle"
                      >
                        <div
                          className="h-12 w-12 animate-spin rounded-full border-2 border-blue-400 border-t-transparent"
                          aria-hidden
                        />
                        <p className="px-2 text-center text-sm text-blue-200">
                          Generating cover letter and CV suggestions…
                        </p>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          void generateApplicationBundle();
                        }}
                        disabled={loadingAssets}
                        className="w-full rounded-lg bg-blue-600 px-5 py-3.5 text-base font-semibold text-white shadow-lg shadow-blue-900/30 transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:shadow-none"
                      >
                        Generate Application Bundle
                      </button>
                    )
                  ) : null}
                </div>
              ) : null}
            </div>
          )}
            </section>
          </div>
        </div>

        <section className="rounded-lg border border-slate-800 bg-slate-900 p-4 space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
            Saved constraints
          </h2>
          {constraints.constraints.length === 0 ? (
            <p className="text-sm text-slate-400">No saved constraints yet.</p>
          ) : (
            <ul className="max-h-52 space-y-2 overflow-auto pr-1">
              {constraints.constraints.map((item) => (
                <li
                  key={item}
                  className="flex items-start justify-between gap-3 rounded-md border border-slate-700 p-2"
                >
                  <span className="text-sm text-slate-200">{item}</span>
                  <button
                    type="button"
                    onClick={() => {
                      void deleteConstraint(item);
                    }}
                    className="rounded bg-red-700 px-2 py-1 text-xs hover:bg-red-600"
                    disabled={constraintsBusy}
                    aria-label={`Delete constraint: ${item}`}
                  >
                    X
                  </button>
                </li>
              ))}
            </ul>
          )}
          {constraints.updated_at ? (
            <p className="text-xs text-slate-500">Updated: {constraints.updated_at}</p>
          ) : null}
        </section>

        {message ? <p className="text-sm text-amber-300">{message}</p> : null}
      </div>
    </main>
  );
}
