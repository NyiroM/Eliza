"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import DiscoveryHubPanel from "@/app/components/DiscoveryHubPanel";
import JobInputHighlighter from "@/app/components/JobInputHighlighter";
import { DEFAULT_OLLAMA_MODEL } from "@/config/constants";
import type { SemanticHighlight } from "@/types/pipeline";

type UploadStatus = {
  loaded: boolean;
  uploaded_at?: string | null;
  skills_count?: number;
  /** Normalized skill tokens from the CV parser (GET after upload, or full parse response). */
  skills?: string[];
};

type ConstraintsState = {
  constraints: string[];
  updated_at?: string;
};

type PipelineResult = {
  job_source?: "manual" | "discovery_indeed" | "discovery_linkedin" | "discovery_profession";
  fit_score: number;
  matched_skills?: string[];
  missing_skills: string[];
  strength_highlights?: string[];
  seniority_match: boolean;
  summary: string;
  one_sentence_summary?: string;
  mathematical_breakdown?: string;
  vibe_warnings?: string[];
  semantic_highlights?: SemanticHighlight[];
  constraint_veto?: boolean;
  match_strength?: "Vetoed" | "Normal";
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
  irrelevant_extra_skills?: string[];
  salary_analysis?: {
    hays_matched_label?: string;
    confidence_score: number;
    low_confidence?: boolean;
    estimated_min: number;
    estimated_max: number;
    estimated_modus: number;
    match_status: "above_limit" | "borderline" | "below_limit";
    rationale: string;
    source: "posted" | "market_benchmark";
    currency: "USD" | "EUR" | "GBP" | "HUF" | "PLN" | "JPY";
    base_salary: {
      estimated_min: number;
      estimated_max: number;
      estimated_modus: number;
      basis: "gross" | "net";
    };
    bonus_detected: boolean;
    benefits_value: string | null;
    normalized_net_estimate?: number;
    comparison_currency: "USD" | "EUR" | "GBP" | "HUF" | "PLN" | "JPY";
    normalized_estimated_min: number;
    normalized_estimated_max: number;
    normalized_estimated_modus: number;
    conversion_applied: boolean;
    exchange_rate_used?: string;
  };
  debug?: {
    fit_score_reconciled_from_components?: boolean;
    analysis_source?: string;
    cv_parser_source?: string;
    job_parser_source?: string;
    constraints_source?: string;
    cv_evidence_pass?: { confirmed_skills: string[]; source: string };
    constraint_tactics_snapshot?: Record<string, string>;
  };
};

type SynonymRow = { from: string; to: string };

function dedupeSynonymPairs(rows: SynonymRow[]): SynonymRow[] {
  const seen = new Set<string>();
  const out: SynonymRow[] = [];
  for (const p of rows) {
    const from = p.from.trim();
    const to = p.to.trim();
    if (!from || !to || from.toLowerCase() === to.toLowerCase()) continue;
    const k = `${from.toLowerCase()}|${to.toLowerCase()}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ from, to });
  }
  return out;
}

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

function jobSourceBadgeLabel(source?: PipelineResult["job_source"]): string {
  if (!source || source === "manual") return "Manual paste";
  if (source === "discovery_indeed") return "Discovery · Indeed";
  if (source === "discovery_linkedin") return "Discovery · LinkedIn";
  return "Discovery · Profession.hu";
}

export default function DashboardPage() {
  const [activeTab, setActiveTab] = useState<"analysis" | "discovery">("analysis");
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
  const [ollamaModels, setOllamaModels] = useState<string[]>([DEFAULT_OLLAMA_MODEL]);
  const [selectedModel, setSelectedModel] = useState(DEFAULT_OLLAMA_MODEL);
  const [modelsListWarning, setModelsListWarning] = useState<string | null>(null);
  const [modelsRefreshing, setModelsRefreshing] = useState(false);
  const [analysisStep, setAnalysisStep] = useState(1);
  const [targetLocation, setTargetLocation] = useState("");
  const [preferredCurrency, setPreferredCurrency] = useState<string | null>(null);
  const [prefsLocationBusy, setPrefsLocationBusy] = useState(false);
  const [loadingAssets, setLoadingAssets] = useState(false);
  const [correctionDraft, setCorrectionDraft] = useState("");
  const [correctionBusy, setCorrectionBusy] = useState(false);
  const [correctionMessage, setCorrectionMessage] = useState<string | null>(null);
  type VetoStanceOpt = "default" | "never_veto" | "soft_only";
  const [skillSynonymPairs, setSkillSynonymPairs] = useState<Array<{ from: string; to: string }>>(
    [],
  );
  const [skillSynonymPending, setSkillSynonymPending] = useState<Array<{ from: string; to: string }>>(
    [],
  );
  const [synonymsUpdatedAt, setSynonymsUpdatedAt] = useState<string | null>(null);
  const [tacticLocation, setTacticLocation] = useState<VetoStanceOpt>("default");
  const [tacticRemoteZone, setTacticRemoteZone] = useState<VetoStanceOpt>("default");
  const [tacticCompensation, setTacticCompensation] = useState<VetoStanceOpt>("default");
  const [tacticsUpdatedAt, setTacticsUpdatedAt] = useState<string | null>(null);
  const [domainSettingsBusy, setDomainSettingsBusy] = useState(false);
  const [domainSettingsMessage, setDomainSettingsMessage] = useState<string | null>(null);
  /** Last CV upload: raw LLM synonym rows (for transparency when none were added as pending). */
  const [synonymReviewLastUpload, setSynonymReviewLastUpload] = useState<{
    proposed: SynonymRow[];
    rationale: string | null;
    modelFailed: boolean;
    at: string | null;
    /** How many new pending rows were appended this upload (0 = all dupes or empty). */
    addedRowCount: number;
  } | null>(null);
  const cvSynonymReviewRef = useRef<HTMLDivElement | null>(null);
  /** Re-runs must not be blocked while application assets generate; `loadingAnalysis` is the only busy gate. */
  const canRunAnalysis = status.loaded && jobText.trim().length > 0 && !loadingAnalysis;

  const loadUserPrefsAndOllamaModels = useCallback(async () => {
    setModelsRefreshing(true);
    setModelsListWarning(null);
    try {
      const [modelsRes, prefsRes] = await Promise.all([
        fetch("/api/ollama-models"),
        fetch("/api/user-preferences"),
      ]);
      const md = (await modelsRes.json()) as {
        models?: string[];
        ok?: boolean;
        warning?: string;
      };
      const pd = (await prefsRes.json()) as {
        preferred_location?: string | null;
        preferred_currency?: string | null;
        ollama_model?: string | null;
      };
      const list =
        Array.isArray(md.models) && md.models.length > 0 ? md.models : [DEFAULT_OLLAMA_MODEL];
      setOllamaModels(list);
      if (md.ok === false && typeof md.warning === "string") {
        setModelsListWarning(md.warning);
      }
      if (typeof pd.preferred_location === "string" && pd.preferred_location.trim()) {
        setTargetLocation(pd.preferred_location.trim());
      }
      if (typeof pd.preferred_currency === "string" && pd.preferred_currency.trim()) {
        setPreferredCurrency(pd.preferred_currency.trim().toUpperCase());
      }
      const saved =
        typeof pd.ollama_model === "string" && pd.ollama_model.trim() ? pd.ollama_model.trim() : null;
      const nextModel =
        saved && list.includes(saved)
          ? saved
          : list.includes(DEFAULT_OLLAMA_MODEL)
            ? DEFAULT_OLLAMA_MODEL
            : list[0];
      setSelectedModel(nextModel);
      if (!saved || saved !== nextModel) {
        void fetch("/api/user-preferences", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Eliza-Internal": "true" },
          body: JSON.stringify({ ollama_model: nextModel }),
        }).catch(() => {});
      }
    } catch {
      setOllamaModels([DEFAULT_OLLAMA_MODEL]);
      setModelsListWarning(
        "Could not load installed models or preferences. Ensure Ollama is running and the server can run `ollama list`.",
      );
      setSelectedModel(DEFAULT_OLLAMA_MODEL);
    } finally {
      setModelsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const timerId = window.setTimeout(() => {
      void loadUserPrefsAndOllamaModels();
    }, 0);
    return () => {
      window.clearTimeout(timerId);
    };
  }, [loadUserPrefsAndOllamaModels]);

  useEffect(() => {
    void checkCvStatus();
  }, []);

  async function savePreferredLocation() {
    setPrefsLocationBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/user-preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Eliza-Internal": "true" },
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
      const data = (await response.json()) as UploadStatus & { skills?: string[] };
      setStatus({
        loaded: data.loaded,
        uploaded_at: data.uploaded_at,
        skills_count: data.skills_count,
        skills: Array.isArray(data.skills) ? data.skills : undefined,
      });
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
        headers: { "X-Eliza-Internal": "true" },
        body: formData,
      });
      const data = (await response.json()) as {
        error?: string;
        parsed?: { skills?: string[] };
        uploaded_at?: string;
        synonym_suggestions_added?: number;
        synonym_suggestions_pending_total?: number;
        synonym_llm_proposed?: Array<{ from?: string; to?: string }>;
        synonym_llm_rationale?: string | null;
        synonym_suggestions_error?: boolean;
      };

      if (!response.ok) {
        setMessage(data.error ?? "CV upload failed.");
        return;
      }

      const added = data.synonym_suggestions_added ?? 0;
      const pendingTot = data.synonym_suggestions_pending_total ?? 0;
      const proposedRaw = Array.isArray(data.synonym_llm_proposed) ? data.synonym_llm_proposed : [];
      const proposed: SynonymRow[] = proposedRaw
        .map((p) => ({
          from: typeof p.from === "string" ? p.from.trim() : "",
          to: typeof p.to === "string" ? p.to.trim() : "",
        }))
        .filter((p) => p.from && p.to);
      setSynonymReviewLastUpload({
        proposed,
        rationale: data.synonym_llm_rationale ?? null,
        modelFailed: data.synonym_suggestions_error === true,
        at: typeof data.uploaded_at === "string" ? data.uploaded_at : new Date().toISOString(),
        addedRowCount: added,
      });

      if (data.synonym_suggestions_error) {
        setMessage(
          "CV uploaded and parsed. Skill synonym suggestions could not run (check Ollama and the selected model).",
        );
      } else if (proposed.length === 0) {
        setMessage(
          "CV uploaded and parsed. The model returned no synonym mappings for this CV (or the run produced an empty list).",
        );
      } else if (added > 0) {
        setMessage(
          `CV uploaded and parsed. ${added} new synonym suggestion row(s) added (${pendingTot} total pending below — review and accept or dismiss).`,
        );
      } else {
        setMessage(
          `CV uploaded and parsed. The model proposed ${proposed.length} synonym mapping(s); all were already saved or pending — see “CV skills & synonym review” below.`,
        );
      }

      await checkCvStatus();
      await loadDomainSettings();
      window.requestAnimationFrame(() => {
        cvSynonymReviewRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      });
    } catch {
      setMessage("CV upload failed.");
    } finally {
      setLoadingUpload(false);
    }
  }

  const loadConstraints = useCallback(async () => {
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
  }, []);

  const loadDomainSettings = useCallback(async () => {
    setDomainSettingsBusy(true);
    setDomainSettingsMessage(null);
    try {
      const [synRes, tacRes] = await Promise.all([
        fetch("/api/domain/skill-synonyms"),
        fetch("/api/domain/constraint-tactics"),
      ]);
      const synData = (await synRes.json()) as {
        pairs?: Array<{ from: string; to: string }>;
        pending_suggestions?: Array<{ from: string; to: string }>;
        updated_at?: string;
      };
      const tacData = (await tacRes.json()) as {
        tactics?: Record<string, string>;
        updated_at?: string;
      };
      if (synRes.ok) {
        setSkillSynonymPairs(
          Array.isArray(synData.pairs) ? synData.pairs.map((p) => ({ from: p.from, to: p.to })) : [],
        );
        setSkillSynonymPending(
          Array.isArray(synData.pending_suggestions)
            ? synData.pending_suggestions.map((p) => ({ from: p.from, to: p.to }))
            : [],
        );
        setSynonymsUpdatedAt(synData.updated_at ?? null);
      }
      if (tacRes.ok) {
        const t = tacData.tactics ?? {};
        const norm = (v: string | undefined): VetoStanceOpt =>
          v === "never_veto" || v === "soft_only" ? v : "default";
        setTacticLocation(norm(t.location));
        setTacticRemoteZone(norm(t.remote_zone));
        setTacticCompensation(norm(t.compensation));
        setTacticsUpdatedAt(tacData.updated_at ?? null);
      }
    } catch {
      setDomainSettingsMessage("Could not load domain settings.");
    } finally {
      setDomainSettingsBusy(false);
    }
  }, []);

  useEffect(() => {
    const id = window.setTimeout(() => {
      void loadConstraints();
    }, 0);
    return () => window.clearTimeout(id);
  }, [loadConstraints]);

  useEffect(() => {
    const id = window.setTimeout(() => {
      void loadDomainSettings();
    }, 0);
    return () => window.clearTimeout(id);
  }, [loadDomainSettings]);

  const runAnalysis = useCallback(async () => {
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
      const response = await fetch(`/api/pipeline?t=${Date.now()}`, {
        method: "POST",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-cache",
          Pragma: "no-cache",
          "X-Eliza-Internal": "true",
        },
        body: JSON.stringify({
          job: jobText,
          refine_feedback: refineText,
          model: selectedModel,
          preferred_location: targetLocation.trim(),
          job_source: "manual",
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
  }, [
    selectedModel,
    jobText,
    refineText,
    targetLocation,
    status.loaded,
    loadConstraints,
  ]);

  const submitUserCorrection = useCallback(async () => {
    const text = correctionDraft.trim();
    if (!text) {
      setCorrectionMessage("Enter a correction first.");
      return;
    }
    setCorrectionBusy(true);
    setCorrectionMessage(null);
    try {
      const res = await fetch("/api/corrections", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Eliza-Internal": "true" },
        body: JSON.stringify({ correction: text }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok) {
        setCorrectionMessage(data.error ?? "Save failed.");
        return;
      }
      setCorrectionDraft("");
      setCorrectionMessage("Saved. It will apply on the next analysis run.");
    } catch {
      setCorrectionMessage("Could not reach corrections API.");
    } finally {
      setCorrectionBusy(false);
    }
  }, [correctionDraft]);

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
        headers: { "Content-Type": "application/json", "X-Eliza-Internal": "true" },
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
        headers: { "Content-Type": "application/json", "X-Eliza-Internal": "true" },
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

  async function deleteConstraint(item: string) {
    setConstraintsBusy(true);
    try {
      const response = await fetch("/api/user-constraints", {
        method: "DELETE",
        headers: { "Content-Type": "application/json", "X-Eliza-Internal": "true" },
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

  async function persistSkillSynonymsToServer(
    pairsIn: SynonymRow[],
    pendingIn: SynonymRow[],
    successMsg: string,
  ) {
    setDomainSettingsBusy(true);
    setDomainSettingsMessage(null);
    try {
      const pairs = dedupeSynonymPairs(
        pairsIn.map((p) => ({ from: p.from.trim(), to: p.to.trim() })).filter((p) => p.from && p.to),
      );
      const pending_suggestions = pendingIn
        .map((p) => ({ from: p.from.trim(), to: p.to.trim() }))
        .filter((p) => p.from && p.to);
      const response = await fetch("/api/domain/skill-synonyms", {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-Eliza-Internal": "true" },
        body: JSON.stringify({ pairs, pending_suggestions }),
      });
      const data = (await response.json()) as {
        error?: string;
        updated_at?: string;
        pending_suggestions?: Array<{ from: string; to: string }>;
        pairs?: Array<{ from: string; to: string }>;
      };
      if (!response.ok) {
        setDomainSettingsMessage(data.error ?? "Could not save skill synonyms.");
        return;
      }
      setSynonymsUpdatedAt(data.updated_at ?? null);
      if (Array.isArray(data.pairs)) {
        setSkillSynonymPairs(data.pairs.map((p) => ({ from: p.from, to: p.to })));
      }
      if (Array.isArray(data.pending_suggestions)) {
        setSkillSynonymPending(data.pending_suggestions.map((p) => ({ from: p.from, to: p.to })));
      }
      setDomainSettingsMessage(successMsg);
    } catch {
      setDomainSettingsMessage("Could not save skill synonyms.");
    } finally {
      setDomainSettingsBusy(false);
    }
  }

  async function saveSkillSynonymsToApi() {
    await persistSkillSynonymsToServer(
      skillSynonymPairs,
      skillSynonymPending,
      "Skill synonyms saved.",
    );
  }

  async function approvePendingSynonymRow(idx: number) {
    const row = skillSynonymPending[idx];
    if (!row?.from.trim() || !row?.to.trim()) return;
    const nextPairs = dedupeSynonymPairs([...skillSynonymPairs, row]);
    const nextPending = skillSynonymPending.filter((_, i) => i !== idx);
    await persistSkillSynonymsToServer(nextPairs, nextPending, "Synonym approved.");
  }

  async function dismissPendingSynonymRow(idx: number) {
    const nextPending = skillSynonymPending.filter((_, i) => i !== idx);
    await persistSkillSynonymsToServer(skillSynonymPairs, nextPending, "Suggestion dismissed.");
  }

  async function approveAllPendingSynonyms() {
    if (skillSynonymPending.length === 0) return;
    const nextPairs = dedupeSynonymPairs([...skillSynonymPairs, ...skillSynonymPending]);
    await persistSkillSynonymsToServer(nextPairs, [], "All suggestions approved.");
  }

  async function dismissAllPendingSynonyms() {
    if (skillSynonymPending.length === 0) return;
    await persistSkillSynonymsToServer(skillSynonymPairs, [], "All pending suggestions dismissed.");
  }

  async function saveConstraintTacticsToApi() {
    setDomainSettingsBusy(true);
    setDomainSettingsMessage(null);
    try {
      const tactics: Record<string, string> = {
        location: tacticLocation,
        remote_zone: tacticRemoteZone,
        compensation: tacticCompensation,
      };
      const response = await fetch("/api/domain/constraint-tactics", {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-Eliza-Internal": "true" },
        body: JSON.stringify({ tactics }),
      });
      const data = (await response.json()) as { error?: string; updated_at?: string };
      if (!response.ok) {
        setDomainSettingsMessage(data.error ?? "Could not save constraint tactics.");
        return;
      }
      setTacticsUpdatedAt(data.updated_at ?? null);
      setDomainSettingsMessage("Constraint tactics saved.");
    } catch {
      setDomainSettingsMessage("Could not save constraint tactics.");
    } finally {
      setDomainSettingsBusy(false);
    }
  }

  function formatSalaryValue(amount: number, currency: string) {
    try {
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency,
        maximumFractionDigits: 0,
      }).format(amount);
    } catch {
      return `${amount.toLocaleString()} ${currency}`;
    }
  }

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 p-4 md:p-6">
      <div className="mx-auto max-w-7xl space-y-8">
        <header className="space-y-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">ELIZA Dashboard</h1>
            <p className="mt-1 max-w-2xl text-sm text-slate-400">
              Upload your CV once, then paste a posting for semantic fit scoring, a transparent match
              breakdown, and optional application assets.
            </p>
          </div>
          <nav className="flex flex-wrap gap-2 border-b border-slate-800 pb-2" aria-label="Dashboard sections">
            <button
              type="button"
              onClick={() => setActiveTab("analysis")}
              className={`rounded-md px-4 py-2 text-sm font-medium ${
                activeTab === "analysis"
                  ? "bg-slate-100 text-slate-900"
                  : "bg-slate-800 text-slate-300 hover:bg-slate-700"
              }`}
            >
              Analysis
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("discovery")}
              className={`rounded-md px-4 py-2 text-sm font-medium ${
                activeTab === "discovery"
                  ? "bg-slate-100 text-slate-900"
                  : "bg-slate-800 text-slate-300 hover:bg-slate-700"
              }`}
            >
              Discovery Hub
            </button>
          </nav>
        </header>

        {activeTab === "discovery" ? (
          <DiscoveryHubPanel
            selectedModel={selectedModel}
            preferredLocation={targetLocation}
            cvLoaded={status.loaded}
          />
        ) : null}

        {activeTab === "analysis" ? (
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

            {status.loaded ? (
              <section
                id="cv-skill-synonym-review"
                ref={cvSynonymReviewRef}
                className="rounded-lg border border-amber-800/40 bg-slate-900 p-4 space-y-4 shadow-lg shadow-amber-950/10"
              >
                <div>
                  <h2 className="text-sm font-semibold uppercase tracking-wide text-amber-200/90">
                    CV skills &amp; synonym review
                  </h2>
                  <p className="mt-1 text-xs text-slate-400">
                    <span className="font-medium text-slate-300">Skills</span> come from the CV parser
                    (normalized tokens). <span className="font-medium text-slate-300">Synonym rows</span> are
                    extra alias → canonical mappings the model suggests for job matching; they are not applied
                    until you accept them.
                  </p>
                </div>

                <div className="space-y-2">
                  <h3 className="text-xs font-medium text-slate-300">Skills extracted from your CV</h3>
                  <div className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto rounded-md border border-slate-700 bg-slate-950/60 p-2">
                    {(status.skills ?? []).length === 0 ? (
                      <span className="text-xs text-slate-500">No skills in the parsed CV payload.</span>
                    ) : (
                      (status.skills ?? []).map((s) => (
                        <span
                          key={s}
                          className="rounded-full border border-sky-800/60 bg-sky-950/50 px-2 py-0.5 text-xs text-sky-100"
                        >
                          {s}
                        </span>
                      ))
                    )}
                  </div>
                  {typeof status.skills_count === "number" && status.skills_count > (status.skills ?? []).length ? (
                    <p className="text-[11px] text-slate-500">
                      Showing {(status.skills ?? []).length} of {status.skills_count} skills (list truncated in
                      API).
                    </p>
                  ) : null}
                </div>

                <div className="space-y-2 border-t border-slate-800 pt-3">
                  <h3 className="text-xs font-medium text-slate-300">AI-suggested synonym mappings</h3>
                  {skillSynonymPending.length > 0 ? (
                    <ul className="space-y-2">
                      {skillSynonymPending.map((row, idx) => (
                        <li
                          key={`review-pending-${idx}-${row.from}-${row.to}`}
                          className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-800/45 bg-amber-950/20 px-3 py-2"
                        >
                          <div className="min-w-0 flex-1 text-sm">
                            <span className="font-mono text-amber-100/95">{row.from}</span>
                            <span className="mx-2 text-amber-600/80">→</span>
                            <span className="font-mono text-emerald-200/90">{row.to}</span>
                          </div>
                          <div className="flex shrink-0 gap-2">
                            <button
                              type="button"
                              disabled={domainSettingsBusy}
                              title="Accept and save as a saved synonym"
                              className="rounded-md bg-emerald-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-600 disabled:opacity-50"
                              onClick={() => void approvePendingSynonymRow(idx)}
                            >
                              Accept
                            </button>
                            <button
                              type="button"
                              disabled={domainSettingsBusy}
                              title="Dismiss this suggestion"
                              className="rounded-md border border-slate-600 bg-slate-800 px-3 py-1.5 text-xs hover:bg-slate-700 disabled:opacity-50"
                              onClick={() => void dismissPendingSynonymRow(idx)}
                            >
                              Dismiss
                            </button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-xs text-slate-500">
                      No pending synonym rows. They appear here after a CV upload when the model proposes new
                      pairs.
                    </p>
                  )}
                  {skillSynonymPending.length > 1 ? (
                    <div className="flex flex-wrap gap-2 pt-1">
                      <button
                        type="button"
                        disabled={domainSettingsBusy}
                        className="rounded-md bg-emerald-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                        onClick={() => void approveAllPendingSynonyms()}
                      >
                        Accept all
                      </button>
                      <button
                        type="button"
                        disabled={domainSettingsBusy}
                        className="rounded-md bg-slate-700 px-3 py-1.5 text-xs hover:bg-slate-600 disabled:opacity-50"
                        onClick={() => void dismissAllPendingSynonyms()}
                      >
                        Dismiss all
                      </button>
                    </div>
                  ) : null}
                </div>

                {synonymReviewLastUpload?.modelFailed ? (
                  <p className="rounded-md border border-red-900/50 bg-red-950/30 px-2 py-1.5 text-xs text-red-200/90">
                    Synonym suggestion step failed (Ollama unreachable, timeout, or invalid JSON). Fix the model
                    connection and upload again.
                  </p>
                ) : null}
                {synonymReviewLastUpload?.rationale ? (
                  <p className="text-xs text-slate-500">
                    <span className="font-medium text-slate-400">Model note: </span>
                    {synonymReviewLastUpload.rationale}
                  </p>
                ) : null}
                {synonymReviewLastUpload &&
                synonymReviewLastUpload.proposed.length > 0 &&
                synonymReviewLastUpload.addedRowCount === 0 &&
                !synonymReviewLastUpload.modelFailed ? (
                  <div className="rounded-md border border-slate-700 bg-slate-950/50 p-2 text-xs text-slate-400">
                    <p className="mb-1 font-medium text-slate-300">Latest model proposals (this upload)</p>
                    <p className="mb-2 text-slate-500">
                      The model returned these pairs, but none were added as new pending rows (they likely match
                      skills already on file or duplicate pending/saved mappings).
                    </p>
                    <ul className="space-y-1 font-mono text-[11px] text-slate-300">
                      {synonymReviewLastUpload.proposed.map((p, i) => (
                        <li key={`prop-${i}-${p.from}-${p.to}`}>
                          {p.from} → {p.to}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                <p className="text-[11px] text-slate-600">
                  Advanced: edit rows manually in{" "}
                  <span className="text-slate-400">Domain &amp; CV tuning → Skill synonyms</span> below.
                </p>
              </section>
            ) : null}

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
                  placeholder="e.g. Berlin, Germany or Remote — EU"
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

              <JobInputHighlighter
                id="job-description"
                value={jobText}
                onChange={setJobText}
                highlights={result?.semantic_highlights ?? []}
                placeholder="Paste the full job posting here…"
              />

              <div className="flex flex-wrap items-center gap-2 border-t border-slate-800 pt-3">
                <label htmlFor="ollama-model" className="text-sm text-slate-300">
                  Ollama model
                </label>
            <select
              id="ollama-model"
              value={selectedModel}
              onChange={(event) => {
                const v = event.target.value;
                setSelectedModel(v);
                void fetch("/api/user-preferences", {
                  method: "POST",
                  headers: { "Content-Type": "application/json", "X-Eliza-Internal": "true" },
                  body: JSON.stringify({ ollama_model: v }),
                }).catch(() => {});
              }}
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
                void loadUserPrefsAndOllamaModels();
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
              onClick={() => {
                void runAnalysis();
              }}
              disabled={!canRunAnalysis}
              className="rounded-md bg-emerald-600 px-4 py-2 text-sm hover:bg-emerald-500 disabled:bg-emerald-900"
            >
            {loadingAnalysis
              ? `Processing with ${selectedModel}... (step ${analysisStep}/3)`
              : "Run Analysis"}
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
              placeholder='e.g. "I do not want PM roles", "I prefer remote work", "I want full-time only", or "I need to avoid certain countries or cities"'
              className="w-full rounded-md border border-slate-700 bg-slate-950 p-2 text-sm"
            />
            <button
              type="button"
              onClick={saveConstraintOnly}
              className="mt-2 rounded-md bg-slate-700 px-4 py-2 text-sm hover:bg-slate-600"
            >
              Save Constraint
            </button>
          </div>
            </section>
          </div>

          <div className="space-y-6 lg:sticky lg:top-6 lg:self-start">
            <section className="rounded-lg border border-slate-800 bg-slate-900 p-4 space-y-5">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
                  Match output
                </h2>
                {result ? (
                  <span
                    className="inline-flex rounded-full border border-slate-600 bg-slate-800/80 px-2.5 py-0.5 text-[11px] font-medium text-slate-200"
                    title="How this job text entered ELIZA"
                  >
                    Source: {jobSourceBadgeLabel(result.job_source)}
                  </span>
                ) : null}
              </div>
          {!result ? (
            <p className="text-sm text-slate-400">
              Run analysis from the left column to see fit scoring and breakdown here.
            </p>
          ) : (
            <div className="space-y-5">
              <div className="grid gap-5 border-b border-slate-800 pb-5 md:grid-cols-[auto,1fr] xl:grid-cols-[auto,1fr,300px]">
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
                  {result.match_strength === "Vetoed" ? (
                    <span className="ml-2 inline-flex rounded-full border border-red-700/80 bg-red-950/60 px-2.5 py-1 text-[11px] font-medium text-red-200">
                      Vetoed
                    </span>
                  ) : null}
                  {result.match_strength === "Vetoed" ? (
                    <p className="text-xs text-red-300">
                      {result.one_sentence_summary ?? result.summary}
                    </p>
                  ) : null}
                  <p className="text-xs text-slate-500">
                    Model:{" "}
                    <span className="font-medium text-slate-300">
                      {result.analysis_model ?? DEFAULT_OLLAMA_MODEL}
                    </span>
                  </p>
                  <p className="text-sm text-slate-300">
                    Seniority alignment:{" "}
                    <span className={result.seniority_match ? "text-emerald-400" : "text-rose-400"}>
                      {result.seniority_match ? "Yes" : "No"}
                    </span>
                  </p>
                  <p className="text-base font-medium leading-snug text-slate-100">
                    {result.one_sentence_summary ??
                      result.summary ??
                      "Open Match analysis below for the full numeric breakdown."}
                  </p>
                  {result.summary &&
                  result.summary !==
                    (result.one_sentence_summary ??
                      "") ? (
                    <p className="text-sm leading-relaxed text-slate-400">{result.summary}</p>
                  ) : null}
                </div>
                {result.salary_analysis ? (
                  <section className="rounded-lg border border-slate-700 bg-slate-950/70 p-3 text-left">
                    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
                      Salary Forecast
                    </h3>
                    <p className="text-xs text-slate-400">
                      Source:{" "}
                      <span className="font-medium text-slate-200">
                        {result.salary_analysis.source === "posted" ? "Posted in job ad" : "Market benchmark"}
                      </span>
                    </p>
                    <p className="mt-1 text-xs text-slate-400">
                      Currency:{" "}
                      <span className="font-medium text-slate-200">
                        {result.salary_analysis.currency ?? preferredCurrency ?? "HUF"}
                      </span>
                    </p>
                    <p className="mt-2 text-sm text-slate-200">
                      Typical:{" "}
                      <span className="font-semibold text-white">
                        {formatSalaryValue(
                          result.salary_analysis.estimated_modus,
                          result.salary_analysis.currency ?? preferredCurrency ?? "HUF",
                        )}
                      </span>
                      {result.salary_analysis.conversion_applied ? (
                        <span className="ml-1 text-xs text-slate-400">
                          (~
                          {formatSalaryValue(
                            result.salary_analysis.normalized_estimated_modus,
                            result.salary_analysis.comparison_currency,
                          )}
                          {result.salary_analysis.exchange_rate_used
                            ? ` at ${result.salary_analysis.exchange_rate_used}`
                            : ""}
                          )
                        </span>
                      ) : null}
                    </p>
                    <div className="mt-2 rounded-md border border-slate-700 bg-slate-900/60 p-2 text-xs text-slate-300">
                      <p>
                        Base:{" "}
                        <span className="font-medium text-slate-100">
                          {formatSalaryValue(
                            result.salary_analysis.base_salary.estimated_modus,
                            result.salary_analysis.currency ?? preferredCurrency ?? "HUF",
                          )}{" "}
                          ({result.salary_analysis.base_salary.basis})
                        </span>
                      </p>
                      <p className="mt-1">
                        + Bonus:{" "}
                        <span className="font-medium text-slate-100">
                          {result.salary_analysis.bonus_detected ? "Yes" : "No"}
                        </span>
                      </p>
                      <p className="mt-1">
                        + Benefits:{" "}
                        <span className="font-medium text-slate-100">
                          {result.salary_analysis.benefits_value ?? "Not mentioned"}
                        </span>
                      </p>
                      {result.salary_analysis.conversion_applied ? (
                        <p className="mt-1">
                          + Normalized:{" "}
                          <span className="font-medium text-slate-100">
                            {formatSalaryValue(
                              result.salary_analysis.normalized_estimated_modus,
                              result.salary_analysis.comparison_currency,
                            )}{" "}
                            ({result.salary_analysis.comparison_currency})
                            {result.salary_analysis.exchange_rate_used
                              ? ` at ${result.salary_analysis.exchange_rate_used}`
                              : ""}
                          </span>
                        </p>
                      ) : null}
                    </div>
                    <p className="mt-1 text-xs text-slate-300">{result.salary_analysis.rationale}</p>
                    <div className="mt-2">
                      {(() => {
                        switch (result.salary_analysis.match_status) {
                          case "above_limit":
                            return (
                              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-medium text-emerald-800">
                                Above your minimum
                              </span>
                            );
                          case "borderline":
                            return (
                              <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-800">
                                Borderline
                              </span>
                            );
                          default:
                            return (
                              <span className="inline-flex items-center gap-1 rounded-full bg-rose-100 px-2.5 py-1 text-xs font-medium text-rose-800">
                                Below your minimum
                              </span>
                            );
                        }
                      })()}
                    </div>
                  </section>
                ) : null}
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

              <details className="group rounded-md border border-slate-600 bg-slate-950 p-3">
                <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-slate-400 marker:text-slate-500">
                  View details (mathematical breakdown)
                </summary>
                <pre className="mt-3 whitespace-pre-wrap font-mono text-sm leading-relaxed text-slate-100">
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
                {result.debug?.cv_evidence_pass &&
                (result.debug.cv_evidence_pass.confirmed_skills?.length ?? 0) > 0 ? (
                  <p className="mt-2 text-[11px] text-slate-400">
                    CV evidence pass confirmed:{" "}
                    <span className="font-mono text-slate-300">
                      {result.debug.cv_evidence_pass.confirmed_skills.join(", ")}
                    </span>
                  </p>
                ) : null}
              </details>

              <div className="rounded-md border border-slate-700 bg-slate-950/50 p-3 space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                  Your corrections
                </p>
                <p className="text-[11px] text-slate-500">
                  Saved lines are treated as absolute truth on the next analysis (e.g. industry, skills
                  you do have).
                </p>
                <textarea
                  value={correctionDraft}
                  onChange={(e) => setCorrectionDraft(e.target.value)}
                  placeholder='e.g. "This role is not IT — ignore tech stack gaps"'
                  rows={2}
                  className="w-full resize-y rounded border border-slate-600 bg-slate-900 px-2 py-1.5 text-sm text-slate-200 placeholder:text-slate-600"
                />
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void submitUserCorrection()}
                    disabled={correctionBusy}
                    className="rounded bg-slate-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-600 disabled:opacity-50"
                  >
                    {correctionBusy ? "Saving…" : "Save correction"}
                  </button>
                  {correctionMessage ? (
                    <span className="text-xs text-slate-400">{correctionMessage}</span>
                  ) : null}
                </div>
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

              <details className="group rounded-md border border-slate-700 bg-slate-950/50 p-3">
                <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-slate-400 marker:text-slate-500">
                  Detailed Skill Mapping
                </summary>
                <div className="mt-3 space-y-4">
                  {/* Matched (green) */}
                  {(result.matched_skills?.length ?? 0) > 0 && (
                    <div>
                      <p className="mb-1 text-xs font-medium text-green-300">Matched Skills</p>
                      <div className="flex flex-wrap gap-2">
                        {(result.matched_skills ?? []).map((skill) => (
                          <span key={skill} className="inline-block rounded-full bg-green-100 px-2.5 py-1 text-xs font-medium text-green-800">
                            {skill}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Missing (red) */}
                  {(result.missing_skills?.length ?? 0) > 0 && (
                    <div>
                      <p className="mb-1 text-xs font-medium text-rose-300">Critical Gaps</p>
                      <div className="flex flex-wrap gap-2">
                        {(result.missing_skills ?? []).map((skill) => (
                          <span key={skill} className="inline-block rounded-full bg-rose-100 px-2.5 py-1 text-xs font-medium text-rose-800">
                            {skill}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Irrelevant extra (slate/blue) */}
                  {(result.irrelevant_extra_skills?.length ?? 0) > 0 ? (
                    <div>
                      <p className="mb-1 text-xs font-medium text-sky-300">Your Unused Superpowers</p>
                      <div className="flex flex-wrap gap-2">
                        {(result.irrelevant_extra_skills ?? []).map((skill) => (
                          <span key={skill} className="inline-block rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-800">
                            {skill}
                          </span>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <p className="text-xs text-slate-500 italic">All your skills are utilized for this role.</p>
                  )}
                </div>
              </details>

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
        ) : null}

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

        <section className="rounded-lg border border-slate-800 bg-slate-900 p-4 space-y-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
            Domain &amp; CV tuning
          </h2>
          <p className="text-xs text-slate-500">
            Skill synonyms normalize tokens for matching (e.g. React.js → react). After each CV upload, use
            <span className="text-slate-400"> CV skills &amp; synonym review </span>
            (above) for one-click accept/dismiss; this block is for manual edits, Add row, and bulk save.
            Constraint tactics soften vetoes vs. score deltas (semantic scorer + offline location check).
          </p>

          <div className="space-y-2">
            <h3 className="text-xs font-medium text-slate-300">Skill synonyms</h3>
            <div className="space-y-2 max-h-96 overflow-auto pr-1">
              {skillSynonymPairs.length === 0 && skillSynonymPending.length === 0 ? (
                <p className="text-xs text-slate-500">
                  No rows yet — upload a CV for AI suggestions, or use Add row.
                </p>
              ) : null}
              {skillSynonymPending.map((row, idx) => (
                <div
                  key={`pending-${idx}-${row.from}-${row.to}`}
                  className="flex flex-wrap items-center gap-2 rounded-md border border-amber-800/40 bg-amber-950/15 pl-1 pr-1 py-0.5"
                >
                  <input
                    type="text"
                    value={row.from}
                    onChange={(e) => {
                      const v = e.target.value;
                      setSkillSynonymPending((prev) =>
                        prev.map((p, i) => (i === idx ? { ...p, from: v } : p)),
                      );
                    }}
                    placeholder="alias (e.g. react.js)"
                    className="min-w-[8rem] flex-1 rounded border border-amber-900/50 bg-slate-950 px-2 py-1 text-xs"
                  />
                  <span className="text-amber-600/90">→</span>
                  <input
                    type="text"
                    value={row.to}
                    onChange={(e) => {
                      const v = e.target.value;
                      setSkillSynonymPending((prev) =>
                        prev.map((p, i) => (i === idx ? { ...p, to: v } : p)),
                      );
                    }}
                    placeholder="canonical (e.g. react)"
                    className="min-w-[8rem] flex-1 rounded border border-amber-900/50 bg-slate-950 px-2 py-1 text-xs"
                  />
                  <span className="shrink-0 rounded bg-amber-900/60 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-100">
                    Suggested
                  </span>
                  <button
                    type="button"
                    disabled={domainSettingsBusy}
                    className="rounded bg-emerald-800 px-2 py-1 text-xs hover:bg-emerald-700 disabled:opacity-50"
                    onClick={() => void approvePendingSynonymRow(idx)}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    disabled={domainSettingsBusy}
                    className="rounded bg-slate-700 px-2 py-1 text-xs hover:bg-slate-600 disabled:opacity-50"
                    onClick={() => void dismissPendingSynonymRow(idx)}
                  >
                    Dismiss
                  </button>
                </div>
              ))}
              {skillSynonymPairs.map((row, idx) => (
                <div key={`pair-${idx}`} className="flex flex-wrap items-center gap-2">
                  <input
                    type="text"
                    value={row.from}
                    onChange={(e) => {
                      const v = e.target.value;
                      setSkillSynonymPairs((prev) =>
                        prev.map((p, i) => (i === idx ? { ...p, from: v } : p)),
                      );
                    }}
                    placeholder="alias (e.g. react.js)"
                    className="min-w-[8rem] flex-1 rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs"
                  />
                  <span className="text-slate-500">→</span>
                  <input
                    type="text"
                    value={row.to}
                    onChange={(e) => {
                      const v = e.target.value;
                      setSkillSynonymPairs((prev) =>
                        prev.map((p, i) => (i === idx ? { ...p, to: v } : p)),
                      );
                    }}
                    placeholder="canonical (e.g. react)"
                    className="min-w-[8rem] flex-1 rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs"
                  />
                  <span className="shrink-0 rounded bg-slate-800 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-400">
                    Saved
                  </span>
                  <button
                    type="button"
                    className="rounded bg-slate-700 px-2 py-1 text-xs hover:bg-slate-600"
                    onClick={() =>
                      setSkillSynonymPairs((prev) => prev.filter((_, i) => i !== idx))
                    }
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="rounded bg-slate-700 px-3 py-1.5 text-xs hover:bg-slate-600"
                onClick={() => setSkillSynonymPairs((prev) => [...prev, { from: "", to: "" }])}
              >
                Add row
              </button>
              <button
                type="button"
                disabled={domainSettingsBusy}
                onClick={() => void saveSkillSynonymsToApi()}
                className="rounded bg-emerald-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-600 disabled:opacity-50"
              >
                Save synonyms
              </button>
              {skillSynonymPending.length > 0 ? (
                <>
                  <button
                    type="button"
                    disabled={domainSettingsBusy}
                    onClick={() => void approveAllPendingSynonyms()}
                    className="rounded bg-emerald-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                  >
                    Approve all suggested
                  </button>
                  <button
                    type="button"
                    disabled={domainSettingsBusy}
                    onClick={() => void dismissAllPendingSynonyms()}
                    className="rounded bg-slate-600 px-3 py-1.5 text-xs hover:bg-slate-500 disabled:opacity-50"
                  >
                    Dismiss all suggested
                  </button>
                </>
              ) : null}
            </div>
            {synonymsUpdatedAt ? (
              <p className="text-xs text-slate-500">Synonyms file updated: {synonymsUpdatedAt}</p>
            ) : null}
          </div>

          <div className="space-y-2 border-t border-slate-800 pt-3">
            <h3 className="text-xs font-medium text-slate-300">Constraint tactics</h3>
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="flex flex-col gap-1 text-xs">
                <span className="text-slate-400">Location</span>
                <select
                  value={tacticLocation}
                  onChange={(e) => setTacticLocation(e.target.value as VetoStanceOpt)}
                  className="rounded border border-slate-700 bg-slate-950 px-2 py-1"
                >
                  <option value="default">Default (veto ok)</option>
                  <option value="never_veto">Never veto</option>
                  <option value="soft_only">Soft only</option>
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs">
                <span className="text-slate-400">Remote / zone</span>
                <select
                  value={tacticRemoteZone}
                  onChange={(e) => setTacticRemoteZone(e.target.value as VetoStanceOpt)}
                  className="rounded border border-slate-700 bg-slate-950 px-2 py-1"
                >
                  <option value="default">Default (veto ok)</option>
                  <option value="never_veto">Never veto</option>
                  <option value="soft_only">Soft only</option>
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs">
                <span className="text-slate-400">Compensation</span>
                <select
                  value={tacticCompensation}
                  onChange={(e) => setTacticCompensation(e.target.value as VetoStanceOpt)}
                  className="rounded border border-slate-700 bg-slate-950 px-2 py-1"
                >
                  <option value="default">Default (veto ok)</option>
                  <option value="never_veto">Never veto</option>
                  <option value="soft_only">Soft only</option>
                </select>
              </label>
            </div>
            <button
              type="button"
              disabled={domainSettingsBusy}
              onClick={() => void saveConstraintTacticsToApi()}
              className="rounded bg-emerald-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-600 disabled:opacity-50"
            >
              Save tactics
            </button>
            {tacticsUpdatedAt ? (
              <p className="text-xs text-slate-500">Tactics file updated: {tacticsUpdatedAt}</p>
            ) : null}
          </div>

          {domainSettingsMessage ? (
            <p className="text-xs text-emerald-300/90">{domainSettingsMessage}</p>
          ) : null}
        </section>

        {message ? <p className="text-sm text-amber-300">{message}</p> : null}
      </div>
    </main>
  );
}
