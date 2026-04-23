import { useCallback, useEffect, useMemo, useState } from "react";
import type { SemanticHighlight } from "../../../types/pipeline";

const envApi = import.meta.env.VITE_ELIZA_API_URL;
const API_BASE =
  typeof envApi === "string" && envApi.trim().length > 0
    ? envApi.trim().replace(/\/+$/, "")
    : "http://localhost:3000";

type PipelineResponse = {
  fit_score: number;
  strength_highlights?: string[];
  missing_skills: string[];
  seniority_match: boolean;
  summary: string;
  one_sentence_summary?: string;
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
  };
};

type ConstraintsState = {
  constraints: string[];
  updated_at?: string;
};

function getFitScoreColor(score: number): string {
  if (score < 40) return "text-red-400";
  if (score < 70) return "text-orange-300";
  return "text-green-400";
}

async function getSelectedJobTextFromTab(): Promise<string> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    return "";
  }

  const response = await chrome.tabs.sendMessage(tab.id, { type: "ELIZA_GET_SELECTION" });
  return typeof response?.selectedText === "string" ? response.selectedText : "";
}

export function App() {
  const [jobText, setJobText] = useState<string>("");
  const [result, setResult] = useState<PipelineResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  const [refineText, setRefineText] = useState<string>("");
  const [constraints, setConstraints] = useState<ConstraintsState>({ constraints: [] });
  const [constraintsBusy, setConstraintsBusy] = useState<boolean>(false);
  const [ollamaModels, setOllamaModels] = useState<string[]>(["llama3"]);
  const [selectedModel, setSelectedModel] = useState("llama3");
  const [modelsListWarning, setModelsListWarning] = useState<string | null>(null);
  const [modelsRefreshing, setModelsRefreshing] = useState(false);
  const [cvLoaded, setCvLoaded] = useState<boolean>(false);
  const [analysisStep, setAnalysisStep] = useState(1);
  const [loadingAssets, setLoadingAssets] = useState(false);

  const loadOllamaModels = useCallback(async () => {
    setModelsRefreshing(true);
    setModelsListWarning(null);
    try {
      const response = await fetch(`${API_BASE}/api/ollama-models`);
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
        `Could not load models from ${API_BASE}. Is the Next app running and Ollama available? Using llama3.`,
      );
      setSelectedModel("llama3");
    } finally {
      setModelsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const timerId = window.setTimeout(() => {
      void loadOllamaModels();
    }, 0);
    return () => {
      window.clearTimeout(timerId);
    };
  }, [loadOllamaModels]);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch(`${API_BASE}/api/upload-cv`);
        const data = (await response.json()) as { loaded?: boolean };
        setCvLoaded(Boolean(data.loaded));
      } catch {
        setCvLoaded(false);
      }
    })();
  }, []);

  const fitColorClass = useMemo(() => {
    if (!result) return "text-slate-200";
    return getFitScoreColor(result.fit_score);
  }, [result]);

  async function loadSelection() {
    setError("");
    try {
      const selected = await getSelectedJobTextFromTab();
      if (!selected) {
        setError("No selected text found. Highlight a job description first.");
        return;
      }
      setJobText(selected);
    } catch {
      setError("Could not read selected text from page.");
    }
  }

  async function calculateFitScore() {
    if (!cvLoaded || !jobText.trim()) {
      setError("Please upload a CV and paste a Job Description to start.");
      return;
    }
    setLoading(true);
    setAnalysisStep(1);
    setError("");
    setResult(null);
    const stepInterval = setInterval(() => {
      setAnalysisStep((prev) => (prev >= 3 ? 3 : prev + 1));
    }, 1800);

    try {
      const payload = {
        job: jobText,
        refine_feedback: refineText,
        model: selectedModel,
      };

      const response = await fetch(`${API_BASE}/api/pipeline?t=${Date.now()}`, {
        method: "POST",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-cache",
          Pragma: "no-cache",
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error("Pipeline request failed.");
      }

      const data = (await response.json()) as PipelineResponse;
      setResult(data);
      if (refineText.trim()) {
        await loadConstraints();
      }
    } catch {
        setError(`Unable to calculate score. Ensure the ELIZA API is reachable (${API_BASE}).`);
    } finally {
      clearInterval(stepInterval);
      setLoading(false);
    }
  }

  async function generateApplicationBundle() {
    if (!result || result.fit_score <= 0) {
      setError("Application bundle is only available when the fit score is above 0.");
      return;
    }
    setLoadingAssets(true);
    setError("");
    try {
      const response = await fetch(`${API_BASE}/api/generate-assets`, {
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
        application_bundle?: PipelineResponse["application_bundle"];
        error?: string;
      };
      if (!response.ok) {
        setError(data.error ?? "Could not generate application bundle.");
        return;
      }
      if (data.application_bundle) {
        setResult((prev) => (prev ? { ...prev, application_bundle: data.application_bundle } : null));
      }
    } catch {
      setError("Could not connect to generate-assets API.");
    } finally {
      setLoadingAssets(false);
    }
  }

  async function saveConstraintOnly() {
    if (!refineText.trim()) {
      setError("Write a refinement before saving.");
      return;
    }
    setError("");
    try {
      const response = await fetch(`${API_BASE}/api/user-constraints`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ constraint: refineText }),
      });
      const data = (await response.json()) as ConstraintsState & { error?: string };
      if (!response.ok) {
        setError("Could not save constraint.");
        return;
      }
      setConstraints({
        constraints: data.constraints ?? [],
        updated_at: data.updated_at,
      });
    } catch {
      setError("Could not save constraint.");
    }
  }

  async function loadConstraints() {
    setConstraintsBusy(true);
    try {
      const response = await fetch(`${API_BASE}/api/user-constraints`);
      const data = (await response.json()) as ConstraintsState;
      setConstraints({
        constraints: data.constraints ?? [],
        updated_at: data.updated_at,
      });
    } catch {
      setError("Could not load constraints.");
    } finally {
      setConstraintsBusy(false);
    }
  }

  async function deleteConstraint(item: string) {
    setConstraintsBusy(true);
    try {
      const response = await fetch(`${API_BASE}/api/user-constraints`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ constraint: item }),
      });
      const data = (await response.json()) as ConstraintsState & { error?: string };
      if (!response.ok) {
        setError(data.error ?? "Could not delete constraint.");
        return;
      }
      setConstraints({
        constraints: data.constraints ?? [],
        updated_at: data.updated_at,
      });
    } catch {
      setError("Could not delete constraint.");
    } finally {
      setConstraintsBusy(false);
    }
  }

  return (
    <main className="w-[380px] min-h-[520px] bg-slate-900 text-slate-100 p-4">
      <div className="mb-4">
        <h1 className="text-lg font-semibold">ELIZA</h1>
        <p className="text-xs text-slate-400 mt-1">
          Select job text on the page, then run fit analysis against your saved CV.
        </p>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <label htmlFor="ollama-model" className="text-xs text-slate-400">
          Model
        </label>
        <select
          id="ollama-model"
          value={selectedModel}
          onChange={(e) => setSelectedModel(e.target.value)}
          className="flex-1 min-w-0 rounded-md border border-slate-700 bg-slate-800 px-2 py-1 text-xs"
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
          className="rounded-md bg-slate-700 px-2 py-1 text-xs hover:bg-slate-600 disabled:opacity-50"
        >
          {modelsRefreshing ? "…" : "Refresh"}
        </button>
      </div>
      {modelsListWarning ? (
        <p className="text-[11px] text-amber-300 mb-3 rounded border border-amber-800/50 bg-amber-950/30 p-2">
          {modelsListWarning}
        </p>
      ) : null}

      <div className="flex gap-2 mb-3">
        <button
          onClick={loadSelection}
          className="rounded-md bg-slate-700 hover:bg-slate-600 px-3 py-2 text-sm"
        >
          Load Selected Text
        </button>
        <button
          onClick={calculateFitScore}
          disabled={loading || loadingAssets || !cvLoaded || !jobText.trim()}
          className="rounded-md bg-blue-600 hover:bg-blue-500 disabled:bg-blue-900 disabled:text-slate-300 px-3 py-2 text-sm"
        >
          {loading ? `Processing step ${analysisStep}/3…` : "Run fit analysis"}
        </button>
      </div>
      <p className="text-[11px] text-slate-400 mb-3">
        Upload a CV in the dashboard and keep at least 20 characters of job text here.
      </p>

      <textarea
        value={jobText}
        onChange={(e) => setJobText(e.target.value)}
        placeholder="Selected job description appears here..."
        className="w-full h-32 bg-slate-800 border border-slate-700 rounded-md p-2 text-xs mb-3"
      />
      <input
        value={refineText}
        onChange={(e) => setRefineText(e.target.value)}
        placeholder='Optional constraint, e.g. "Remote only", "No contract roles"'
        className="w-full bg-slate-800 border border-slate-700 rounded-md p-2 text-xs mb-2"
      />
      <button
        onClick={saveConstraintOnly}
        className="rounded-md bg-slate-700 hover:bg-slate-600 px-3 py-2 text-xs mb-3"
      >
        Save Constraint
      </button>
      <button
        onClick={loadConstraints}
        className="rounded-md bg-slate-700 hover:bg-slate-600 px-3 py-2 text-xs mb-3 ml-2"
        disabled={constraintsBusy}
      >
        Refresh Constraints
      </button>

      {error ? <p className="text-xs text-red-400 mb-3">{error}</p> : null}

      {result ? (
        <section className="bg-slate-800 border border-slate-700 rounded-md p-3">
          <div className="mb-2">
            <p className="text-xs text-slate-400">Fit score</p>
            <p className={`text-2xl font-bold ${fitColorClass}`}>
              {result.fit_score}%
              {result.constraint_veto ? (
                <span className="ml-2 text-xs font-bold text-red-400">VETO</span>
              ) : null}
            </p>
          </div>

          {result.constraint_veto ? (
            <div className="mb-2 rounded border border-red-600 bg-red-950/30 p-2 text-[11px] text-red-100">
              <p className="font-semibold">Constraint veto</p>
              <p className="mt-0.5 text-red-200/90">0% — hard rule conflict with this posting.</p>
            </div>
          ) : null}

          <p className="mb-2 text-xs font-medium text-slate-200 leading-snug">
            {result.one_sentence_summary ??
              result.summary ??
              "Open details below for the full numeric breakdown."}
          </p>

          <details className="mb-2 rounded border border-slate-600 bg-slate-900 p-2">
            <summary className="cursor-pointer text-[10px] font-medium text-amber-200/90">
              View details (breakdown)
            </summary>
            <pre className="mt-1 whitespace-pre-wrap text-[10px] text-slate-100 font-mono leading-snug max-h-40 overflow-y-auto">
              {result.mathematical_breakdown ?? "—"}
            </pre>
            <p className="mt-1 text-[9px] leading-snug text-slate-500">
              Headline score matches line 7; line 6 is verified when the API returns score components.
              {result.debug?.fit_score_reconciled_from_components ? " Adjusted this run." : ""}
            </p>
          </details>

          {(result.vibe_warnings ?? []).length > 0 ? (
            <div className="mb-2 rounded border border-amber-800/50 bg-amber-950/20 p-2">
              <p className="text-[10px] font-medium text-amber-200/95 mb-1">Corporate vibe</p>
              <ul className="list-disc pl-3 text-[10px] text-amber-100/90 space-y-0.5">
                {(result.vibe_warnings ?? []).map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="mb-2">
            <p className="text-xs text-slate-400">Seniority Match</p>
            <p className={result.seniority_match ? "text-green-400" : "text-red-400"}>
              {result.seniority_match ? "Yes" : "No"}
            </p>
          </div>

          <div className="mb-3">
            <p className="text-xs text-slate-400">Critical gaps</p>
            <p className="text-sm">{result.missing_skills.join(", ") || "None"}</p>
          </div>
          {result.summary &&
          result.summary !== (result.one_sentence_summary ?? "") ? (
            <div className="mb-3 border-t border-slate-700 pt-2">
              <p className="text-[10px] text-slate-500 mb-0.5">Notes</p>
              <p className="text-xs text-slate-300">{result.summary}</p>
            </div>
          ) : null}

          <div className="mb-3 rounded-md border border-slate-700 p-2">
            <div className="flex flex-wrap items-center gap-1.5 mb-1">
              <p className="text-xs text-slate-400">Requirement analysis</p>
              {result.metadata_fit_badge ? (
                <span
                  className={
                    result.metadata_fit_badge === "Location Conflict"
                      ? "rounded-full border border-red-800/60 bg-red-950/40 px-1.5 py-0.5 text-[10px] text-red-200"
                      : "rounded-full border border-emerald-800/60 bg-emerald-950/40 px-1.5 py-0.5 text-[10px] text-emerald-200"
                  }
                >
                  {result.metadata_fit_badge}
                </span>
              ) : null}
            </div>
            <p className="text-[11px] text-slate-500 mb-2">
              Analyzed with:{" "}
              <span className="text-slate-300">{result.analysis_model ?? "llama3"}</span>
            </p>
            <p className="text-[11px] text-slate-500">
              Loc: {result.extracted_entities?.job_location?.trim() || "—"} |{" "}
              <span className="capitalize">
                {(result.extracted_entities?.work_model ?? "unknown").replace(/-/g, " ")}
              </span>{" "}
              |{" "}
              <span className="capitalize">
                {(result.extracted_entities?.job_type ?? "unknown").replace(/-/g, " ")}
              </span>
            </p>
            <p className="text-[10px] text-slate-500 mt-1 mb-0.5">Benefits</p>
            <div className="flex flex-wrap gap-1 mb-1">
              {(result.extracted_entities?.benefits ?? []).length === 0 ? (
                <span className="text-[10px] text-slate-500">—</span>
              ) : (
                (result.extracted_entities?.benefits ?? []).map((b, i) => (
                  <span
                    key={`${i}-${b}`}
                    className="rounded-full border border-slate-600 bg-slate-900 px-1.5 py-0.5 text-[10px]"
                  >
                    {b}
                  </span>
                ))
              )}
            </div>
            {(result.extracted_entities?.commitments ?? []).length > 0 ? (
              <>
                <p className="text-[10px] text-slate-500 mb-0.5">Commitments</p>
                <div className="flex flex-wrap gap-1 mb-1">
                  {(result.extracted_entities?.commitments ?? []).map((c, i) => (
                    <span
                      key={`${i}-${c}`}
                      className="rounded-full border border-violet-900/40 bg-violet-950/30 px-1.5 py-0.5 text-[10px] text-violet-100"
                    >
                      {c}
                    </span>
                  ))}
                </div>
              </>
            ) : null}
            {(result.extracted_entities?.metadata_constraint_notes ?? []).length > 0 ? (
              <ul className="list-disc pl-3 text-[10px] text-slate-400 mb-1 space-y-0.5">
                {(result.extracted_entities?.metadata_constraint_notes ?? []).map((n, i) => (
                  <li key={`${i}-${n}`}>{n}</li>
                ))}
              </ul>
            ) : null}
            <p className="text-xs">
              Required: {result.extracted_entities?.required_skills.join(", ") || "None"}
            </p>
            <p className="text-xs">
              Optional: {result.extracted_entities?.optional_skills.join(", ") || "None"}
            </p>
            <p className="text-xs">
              Experience:{" "}
              {result.extracted_entities?.experience_years != null
                ? `${result.extracted_entities.experience_years} years`
                : "Not specified"}
            </p>
            <p className="text-xs">
              Education: {result.extracted_entities?.education ?? "Not specified"}
            </p>
          </div>

          {result.fit_score > 0 ? (
            <div className="mt-3 border-t border-slate-700 pt-3 space-y-3">
              {!result.application_bundle ? (
                loadingAssets ? (
                  <div
                    className="flex flex-col items-center justify-center gap-3 py-8 rounded-md border border-violet-800/40 bg-slate-950/80"
                    aria-busy="true"
                    aria-label="Generating application bundle"
                  >
                    <div
                      className="h-10 w-10 rounded-full border-2 border-violet-400 border-t-transparent animate-spin"
                      aria-hidden
                    />
                    <p className="text-[11px] text-violet-200 text-center px-1">
                      Generating cover letter and suggestions…
                    </p>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      void generateApplicationBundle();
                    }}
                    disabled={loadingAssets}
                    className="w-full rounded-md bg-violet-600 px-3 py-2.5 text-xs font-medium hover:bg-violet-500 disabled:bg-violet-900 disabled:opacity-70"
                  >
                    Generate Application Bundle
                  </button>
                )
              ) : null}
              {result.application_bundle ? (
                <>
                  <p className="text-xs font-medium text-slate-300">Application Bundle</p>
                  <p className="text-xs text-slate-400 mb-1">Cover Letter</p>
                  <pre className="text-xs whitespace-pre-wrap bg-slate-900 p-2 rounded-md mb-3 max-h-40 overflow-y-auto">
                    {result.application_bundle.cover_letter ?? "No cover letter generated."}
                  </pre>
                  <p className="text-xs text-slate-400 mb-1">CV Rewrite Suggestions</p>
                  <ul className="list-disc ml-4 text-xs space-y-1 max-h-32 overflow-y-auto">
                    {(result.application_bundle.cv_rewrite_suggestions ?? []).map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}

      <section className="mt-3 bg-slate-800 border border-slate-700 rounded-md p-3">
        <p className="text-xs text-slate-400 mb-2">Constraints History</p>
        {constraints.constraints.length === 0 ? (
          <p className="text-xs text-slate-400">No saved constraints.</p>
        ) : (
          <ul className="max-h-24 overflow-auto space-y-1 pr-1">
            {constraints.constraints.map((item) => (
              <li
                key={item}
                className="flex items-start justify-between gap-2 rounded bg-slate-900 p-1"
              >
                <span className="text-xs">{item}</span>
                <button
                  onClick={() => {
                    void deleteConstraint(item);
                  }}
                  className="rounded bg-red-700 px-1 text-[10px] hover:bg-red-600"
                  disabled={constraintsBusy}
                >
                  X
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
