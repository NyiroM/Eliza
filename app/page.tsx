"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import DiscoveryHubPanel from "@/app/components/DiscoveryHubPanel";
import JobInputHighlighter from "@/app/components/JobInputHighlighter";
import { LanAccessPanel } from "@/app/components/LanAccessPanel";
import { SalaryForecastCard } from "@/app/components/SalaryForecastCard";
import { DEFAULT_OLLAMA_MODEL } from "@/config/constants";
import {
  BTN_GHOST,
  BTN_GHOST_BLUE_LG,
  BTN_GHOST_SM,
  BTN_PRIMARY_COMPACT,
  BTN_PRIMARY_LG,
} from "@/lib/ui/dashboardButtons";
import { elizaFetch, persistActiveUserId, getPersistedActiveUserId } from "@/lib/elizaFetch";
import type { SemanticHighlight } from "@/types/pipeline";

type UploadStatus = {
  loaded: boolean;
  uploaded_at?: string | null;
  skills_count?: number;
  /** Normalized skill tokens from the CV parser (GET after upload, or full parse response). */
  skills?: string[];
  skill_suggestions?: Array<{ phrase: string; status?: string }>;
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
    salary_forecast_display?: import("@/types/pipeline").SalaryForecastDisplay;
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

type RegistryUserRow = { id: string; displayName: string; createdAt: string };

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
  const [registryUsers, setRegistryUsers] = useState<RegistryUserRow[]>([]);
  const [activeUserId, setActiveUserId] = useState("");
  const [newUserDisplayName, setNewUserDisplayName] = useState("");
  const [newUserBusy, setNewUserBusy] = useState(false);
  const [showNewUserRow, setShowNewUserRow] = useState(false);
  /** Shown under the header so profile actions are visible on every tab (not only Analysis body). */
  const [profileNotice, setProfileNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [activeTab, setActiveTab] = useState<"analysis" | "discovery">("analysis");
  const [status, setStatus] = useState<UploadStatus>({ loaded: false });
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [jobText, setJobText] = useState("");
  const [refineText, setRefineText] = useState("");
  const [result, setResult] = useState<PipelineResult | null>(null);
  const [loadingUpload, setLoadingUpload] = useState(false);
  const [skillsDraft, setSkillsDraft] = useState("");
  const [skillsSaveBusy, setSkillsSaveBusy] = useState(false);
  const [skillSuggestBusy, setSkillSuggestBusy] = useState(false);
  const [skillPhraseReviewBusy, setSkillPhraseReviewBusy] = useState(false);
  const [lastSkillSuggestRationale, setLastSkillSuggestRationale] = useState<string | null>(null);
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
  type VetoStanceOpt = "default" | "strong_preference";
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
        elizaFetch("/api/user-preferences"),
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
        void elizaFetch("/api/user-preferences", {
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

  const checkCvStatus = useCallback(async () => {
    setMessage("");
    try {
      const response = await elizaFetch("/api/upload-cv");
      const data = (await response.json()) as UploadStatus & {
        skills?: string[];
        skill_suggestions?: Array<{ phrase: string; status?: string }>;
      };
      const skills = Array.isArray(data.skills) ? data.skills : [];
      setStatus({
        loaded: data.loaded,
        uploaded_at: data.uploaded_at,
        skills_count: data.skills_count,
        skills,
        skill_suggestions: Array.isArray(data.skill_suggestions) ? data.skill_suggestions : [],
      });
      if (data.loaded) {
        setSkillsDraft(skills.join(", "));
      } else {
        setSkillsDraft("");
      }
    } catch {
      setMessage("Unable to check CV status.");
    }
  }, []);

  async function saveCvSkillsDraft() {
    if (!status.loaded || skillsSaveBusy) return;
    setSkillsSaveBusy(true);
    setMessage("");
    try {
      const res = await elizaFetch("/api/upload-cv/skills", {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-Eliza-Internal": "true" },
        body: JSON.stringify({ skills_text: skillsDraft, model: selectedModel }),
      });
      const data = (await res.json()) as UploadStatus & {
        error?: string;
        skills?: string[];
        skill_suggestions?: Array<{ phrase: string }>;
      };
      if (!res.ok) {
        setMessage(data.error ?? "Could not save skills.");
        return;
      }
      const skills = Array.isArray(data.skills) ? data.skills : [];
      setStatus((prev) => ({
        ...prev,
        loaded: true,
        skills,
        skills_count: data.skills_count ?? skills.length,
        skill_suggestions: Array.isArray(data.skill_suggestions) ? data.skill_suggestions : prev.skill_suggestions,
      }));
      setSkillsDraft(skills.join(", "));
      setMessage("CV skills saved.");
    } catch {
      setMessage("Could not save skills.");
    } finally {
      setSkillsSaveBusy(false);
    }
  }

  async function suggestCvSkillPhrases() {
    if (!status.loaded || skillSuggestBusy) return;
    setSkillSuggestBusy(true);
    setLastSkillSuggestRationale(null);
    setMessage("");
    try {
      const res = await elizaFetch("/api/upload-cv/suggest-skills", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Eliza-Internal": "true" },
        body: JSON.stringify({ model: selectedModel }),
      });
      const data = (await res.json()) as {
        error?: string;
        skills?: string[];
        skills_count?: number;
        skill_suggestions?: Array<{ phrase: string }>;
        suggest_rationale?: string | null;
      };
      if (!res.ok) {
        setMessage(data.error ?? "Suggestion request failed.");
        return;
      }
      const skills = Array.isArray(data.skills) ? data.skills : [];
      setStatus((prev) => ({
        ...prev,
        loaded: true,
        skills,
        skills_count: typeof data.skills_count === "number" ? data.skills_count : skills.length,
        skill_suggestions: Array.isArray(data.skill_suggestions) ? data.skill_suggestions : prev.skill_suggestions,
      }));
      if (typeof data.suggest_rationale === "string" && data.suggest_rationale.trim()) {
        setLastSkillSuggestRationale(data.suggest_rationale.trim());
      }
      setMessage("New skill suggestions added — review below.");
    } catch {
      setMessage("Could not reach suggest-skills API.");
    } finally {
      setSkillSuggestBusy(false);
    }
  }

  async function postSkillSuggestionAction(body: Record<string, unknown>, okMsg: string) {
    if (!status.loaded || skillPhraseReviewBusy) return;
    setSkillPhraseReviewBusy(true);
    setDomainSettingsMessage(null);
    try {
      const res = await elizaFetch("/api/upload-cv/skill-suggestions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Eliza-Internal": "true" },
        body: JSON.stringify({ ...body, model: selectedModel }),
      });
      const data = (await res.json()) as {
        error?: string;
        skills?: string[];
        skills_count?: number;
        skill_suggestions?: Array<{ phrase: string }>;
      };
      if (!res.ok) {
        setMessage(data.error ?? "Skill suggestion update failed.");
        return;
      }
      const skills = Array.isArray(data.skills) ? data.skills : [];
      setStatus((prev) => ({
        ...prev,
        loaded: true,
        skills,
        skills_count: typeof data.skills_count === "number" ? data.skills_count : skills.length,
        skill_suggestions: Array.isArray(data.skill_suggestions) ? data.skill_suggestions : [],
      }));
      setSkillsDraft(skills.join(", "));
      setMessage(okMsg);
    } catch {
      setMessage("Could not reach skill-suggestions API.");
    } finally {
      setSkillPhraseReviewBusy(false);
    }
  }

  async function savePreferredLocation() {
    setPrefsLocationBusy(true);
    setMessage("");
    try {
      const response = await elizaFetch("/api/user-preferences", {
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

      const response = await elizaFetch("/api/upload-cv", {
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
      setLastSkillSuggestRationale(null);

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
          `CV uploaded and parsed. ${added} new synonym suggestion row(s) added (${pendingTot} total pending — open CV skills & tuning → Skill synonyms (advanced) to review).`,
        );
      } else {
        setMessage(
          `CV uploaded and parsed. The model proposed ${proposed.length} synonym mapping(s); all were already saved or pending — see CV skills & tuning → Skill synonyms (advanced).`,
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
      const response = await elizaFetch("/api/user-constraints");
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
        elizaFetch("/api/domain/skill-synonyms"),
        elizaFetch("/api/domain/constraint-tactics"),
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
          v === "strong_preference" ? v : "default";
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

  const reloadForActiveProfile = useCallback(async () => {
    await loadUserPrefsAndOllamaModels();
    await checkCvStatus();
    await loadConstraints();
    await loadDomainSettings();
  }, [loadUserPrefsAndOllamaModels, checkCvStatus, loadConstraints, loadDomainSettings]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const ur = await fetch("/api/users");
        const reg = (await ur.json()) as {
          users?: RegistryUserRow[];
          defaultUserId?: string;
        };
        const users = Array.isArray(reg.users) ? reg.users : [];
        const def =
          typeof reg.defaultUserId === "string" && reg.defaultUserId.trim()
            ? reg.defaultUserId.trim()
            : "default";
        const stored = getPersistedActiveUserId();
        const nextId = stored && users.some((u) => u.id === stored) ? stored : def;
        persistActiveUserId(nextId);
        if (cancelled) return;
        setRegistryUsers(users);
        setActiveUserId(nextId);
        await loadUserPrefsAndOllamaModels();
        await checkCvStatus();
        await loadConstraints();
        await loadDomainSettings();
      } catch {
        if (!cancelled) setMessage("Could not load user registry or profile data.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadUserPrefsAndOllamaModels, checkCvStatus, loadConstraints, loadDomainSettings]);

  async function createProfileFromName() {
    const displayName = newUserDisplayName.trim();
    if (!displayName || newUserBusy) return;
    setNewUserBusy(true);
    setMessage("");
    setProfileNotice(null);
    try {
      const res = await fetch("/api/users", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Eliza-Internal": "true",
        },
        body: JSON.stringify({ displayName }),
        cache: "no-store",
      });
      let data: { id?: string; user?: RegistryUserRow; error?: string };
      try {
        data = (await res.json()) as { id?: string; user?: RegistryUserRow; error?: string };
      } catch {
        setProfileNotice({
          kind: "err",
          text: "Invalid server response (not JSON). Check the terminal for API errors.",
        });
        return;
      }
      if (!res.ok) {
        const errText = data.error ?? `Could not create profile (${res.status}).`;
        setProfileNotice({ kind: "err", text: errText });
        setMessage(errText);
        return;
      }
      const id = typeof data.id === "string" ? data.id : data.user?.id;
      if (!id) {
        const errText = "Invalid server response: missing profile id.";
        setProfileNotice({ kind: "err", text: errText });
        setMessage(errText);
        return;
      }
      persistActiveUserId(id);
      setActiveUserId(id);
      setRegistryUsers((prev) => {
        const row = data.user ?? { id, displayName, createdAt: new Date().toISOString() };
        if (prev.some((u) => u.id === row.id)) return prev;
        return [...prev, row];
      });
      setResult(null);
      try {
        await reloadForActiveProfile();
      } catch (reloadErr) {
        const msg =
          reloadErr instanceof Error
            ? reloadErr.message
            : "Profile was created but reloading settings failed. Refresh the page.";
        setProfileNotice({ kind: "err", text: msg });
        setMessage(msg);
        return;
      }
      setNewUserDisplayName("");
      setShowNewUserRow(false);
      const okText = `Új profil aktív: ${id}`;
      setProfileNotice({ kind: "ok", text: okText });
      setMessage(okText);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Could not create profile.";
      setProfileNotice({ kind: "err", text: msg });
      setMessage(msg);
    } finally {
      setNewUserBusy(false);
    }
  }

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
      const response = await elizaFetch(`/api/pipeline?t=${Date.now()}`, {
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
      const res = await elizaFetch("/api/corrections", {
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
      const response = await elizaFetch("/api/generate-assets", {
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
      const response = await elizaFetch("/api/user-constraints", {
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
      const response = await elizaFetch("/api/user-constraints", {
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
      const response = await elizaFetch("/api/domain/skill-synonyms", {
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
      const response = await elizaFetch("/api/domain/constraint-tactics", {
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
          <div className="flex flex-wrap items-end justify-between gap-4">
            <h1 className="text-2xl font-semibold tracking-tight">ELIZA Dashboard</h1>
            <div className="flex w-full max-w-xl flex-col gap-3 sm:w-auto sm:max-w-none sm:flex-row sm:items-end sm:justify-end">
              <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-slate-400 sm:min-w-[11rem]">
                <span className="font-medium uppercase tracking-wide">Active profile</span>
                <select
                  value={activeUserId}
                  onChange={(e) => {
                    const id = e.target.value;
                    persistActiveUserId(id);
                    setActiveUserId(id);
                    setResult(null);
                    setMessage("");
                    setProfileNotice(null);
                    void reloadForActiveProfile();
                  }}
                  disabled={registryUsers.length === 0}
                  className="rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100"
                >
                  {registryUsers.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.displayName} ({u.id})
                    </option>
                  ))}
                </select>
              </label>
              {!showNewUserRow ? (
                <button
                  type="button"
                  onClick={() => {
                    setProfileNotice(null);
                    setShowNewUserRow(true);
                  }}
                  className={BTN_GHOST_SM}
                >
                  + New profile
                </button>
              ) : (
                <form
                  className="flex flex-wrap items-end gap-2"
                  onSubmit={(ev) => {
                    ev.preventDefault();
                    void createProfileFromName();
                  }}
                >
                  <label className="flex flex-col gap-1 text-xs text-slate-400">
                    <span className="font-medium uppercase tracking-wide">Display name</span>
                    <input
                      value={newUserDisplayName}
                      onChange={(ev) => setNewUserDisplayName(ev.target.value)}
                      placeholder="e.g. Anna"
                      autoComplete="off"
                      className="min-w-[8rem] rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm"
                    />
                  </label>
                  <button
                    type="submit"
                    disabled={newUserBusy || !newUserDisplayName.trim()}
                    className={BTN_PRIMARY_COMPACT}
                  >
                    {newUserBusy ? "Creating…" : "Create"}
                  </button>
                  <button
                    type="button"
                    disabled={newUserBusy}
                    onClick={() => {
                      setShowNewUserRow(false);
                      setNewUserDisplayName("");
                      setProfileNotice(null);
                    }}
                    className={BTN_GHOST_SM}
                  >
                    Cancel
                  </button>
                </form>
              )}
            </div>
          </div>
          {profileNotice ? (
            <p
              role="status"
              className={
                profileNotice.kind === "ok"
                  ? "text-sm text-emerald-300/95"
                  : "text-sm text-amber-300"
              }
            >
              {profileNotice.text}
            </p>
          ) : null}
          <LanAccessPanel />
          <nav className="flex flex-wrap gap-2 border-b border-slate-800 pb-2" aria-label="Dashboard sections">
            <button
              type="button"
              onClick={() => setActiveTab("analysis")}
              className={`rounded-full px-4 py-2 text-sm font-medium transition ${
                activeTab === "analysis"
                  ? "bg-slate-100 text-slate-900 shadow-sm"
                  : "border border-transparent bg-transparent text-slate-400 hover:border-slate-700 hover:bg-slate-800/50 hover:text-slate-200"
              }`}
            >
              Analysis
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("discovery")}
              className={`rounded-full px-4 py-2 text-sm font-medium transition ${
                activeTab === "discovery"
                  ? "bg-slate-100 text-slate-900 shadow-sm"
                  : "border border-transparent bg-transparent text-slate-400 hover:border-slate-700 hover:bg-slate-800/50 hover:text-slate-200"
              }`}
            >
              Discovery Hub
            </button>
          </nav>
        </header>

        {activeTab === "discovery" ? (
          <DiscoveryHubPanel
            key={activeUserId || "no-user"}
            selectedModel={selectedModel}
            preferredLocation={targetLocation}
            cvLoaded={status.loaded}
          />
        ) : null}

        {activeTab === "analysis" ? (
        <div className="grid grid-cols-1 gap-12 lg:grid-cols-2 lg:items-start">
          <div className="space-y-6 rounded-2xl border border-slate-800/80 bg-slate-900/50 p-5 shadow-sm shadow-black/20 ring-1 ring-white/[0.04] lg:p-6">
            <section className="space-y-3">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
                CV status
              </h2>
          <div className="rounded-lg border border-slate-800/90 bg-slate-950/40 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">CV</span>
              <span
                className={
                  status.loaded
                    ? "rounded-full bg-emerald-950/70 px-2.5 py-0.5 text-xs font-semibold text-emerald-100 ring-1 ring-emerald-600/35"
                    : "rounded-full bg-amber-950/70 px-2.5 py-0.5 text-xs font-semibold text-amber-100 ring-1 ring-amber-600/40"
                }
              >
                {status.loaded ? "Loaded" : "Not loaded"}
              </span>
            </div>
            {status.loaded ? (
              <p className="mt-2 text-xs text-slate-400">
                Skills parsed: {status.skills_count ?? 0}
                {status.uploaded_at ? ` · Uploaded: ${status.uploaded_at}` : ""}
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <input
              type="file"
              accept="application/pdf"
              onChange={(event) => setSelectedFile(event.target.files?.[0] ?? null)}
              className="block text-sm text-slate-300 file:mr-3 file:rounded-md file:border file:border-slate-600 file:bg-slate-800/50 file:px-3 file:py-2 file:text-slate-100 file:hover:bg-slate-800"
            />
            <button type="button" onClick={uploadCv} disabled={loadingUpload} className={BTN_GHOST}>
              {loadingUpload ? "Uploading..." : "Upload CV PDF"}
            </button>
            <button
              type="button"
              onClick={() => {
                void checkCvStatus();
              }}
              className={BTN_GHOST}
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
                    CV skills &amp; tuning
                  </h2>
                  <p className="mt-1 text-xs text-slate-400">
                    <span className="font-medium text-slate-300">Skills</span> are loaded from the CV parser;
                    edit the comma-separated list and save. <span className="font-medium text-slate-300">
                      Suggested skills (AI)
                    </span>{" "}
                    are optional additions — approve to merge into the list above (same pattern as Discovery search
                    keywords). <span className="font-medium text-slate-300">Skill synonyms</span> (advanced) are
                    alias → canonical rows for ATS matching.
                  </p>
                </div>

                <div className="space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-xs font-medium text-slate-300">Skills (comma-separated)</h3>
                    <button
                      type="button"
                      disabled={skillsSaveBusy || skillSuggestBusy || skillPhraseReviewBusy}
                      onClick={() => void saveCvSkillsDraft()}
                      className={BTN_PRIMARY_COMPACT}
                    >
                      {skillsSaveBusy ? "Saving…" : "Save skills"}
                    </button>
                  </div>
                  <textarea
                    id="cv-skills-draft"
                    rows={4}
                    value={skillsDraft}
                    onChange={(e) => setSkillsDraft(e.target.value)}
                    placeholder="e.g. react, node.js, typescript, postgres"
                    className="w-full rounded-md border border-slate-700 bg-slate-950/80 px-3 py-2 font-mono text-xs text-slate-100 placeholder:text-slate-600"
                  />
                  {typeof status.skills_count === "number" && status.skills_count > (status.skills ?? []).length ? (
                    <p className="text-[11px] text-slate-500">
                      Showing {(status.skills ?? []).length} of {status.skills_count} skills (list truncated in
                      API).
                    </p>
                  ) : null}
                </div>

                <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-3 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                      Suggested skills (AI)
                    </h3>
                    <button
                      type="button"
                      disabled={skillSuggestBusy || skillsSaveBusy || domainSettingsBusy}
                      onClick={() => void suggestCvSkillPhrases()}
                      className={BTN_GHOST_SM}
                    >
                      {skillSuggestBusy ? "Generating…" : "Generate suggestions"}
                    </button>
                  </div>
                  <p className="text-[11px] text-slate-500">
                    Suggestions start as pending. Approving appends the phrase to the skills field above
                    (deduped).
                  </p>
                  {(status.skill_suggestions ?? []).filter((s) => s.status === "suggested" || !s.status).length ===
                  0 ? (
                    <p className="text-xs text-slate-600">No pending skill suggestions.</p>
                  ) : (
                    <ul className="space-y-2">
                      {(status.skill_suggestions ?? [])
                        .filter((s) => s.status === "suggested" || !s.status)
                        .map((row) => (
                          <li
                            key={`skill-sug-${row.phrase}`}
                            className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-violet-900/40 bg-violet-950/20 px-3 py-2"
                          >
                            <span className="min-w-0 flex-1 font-mono text-sm text-violet-100/95">{row.phrase}</span>
                            <div className="flex shrink-0 gap-2">
                              <button
                                type="button"
                                disabled={skillPhraseReviewBusy}
                                className={BTN_PRIMARY_COMPACT}
                                onClick={() =>
                                  void postSkillSuggestionAction(
                                    { action: "approve", phrase: row.phrase },
                                    `Approved skill «${row.phrase}».`,
                                  )
                                }
                              >
                                Accept
                              </button>
                              <button
                                type="button"
                                disabled={skillPhraseReviewBusy}
                                className={BTN_GHOST_SM}
                                onClick={() =>
                                  void postSkillSuggestionAction(
                                    { action: "reject", phrase: row.phrase },
                                    "Suggestion dismissed.",
                                  )
                                }
                              >
                                Dismiss
                              </button>
                            </div>
                          </li>
                        ))}
                    </ul>
                  )}
                  {(status.skill_suggestions ?? []).filter((s) => s.status === "suggested" || !s.status).length >
                  1 ? (
                    <div className="flex flex-wrap gap-2 pt-1">
                      <button
                        type="button"
                        disabled={skillPhraseReviewBusy}
                        className={BTN_PRIMARY_COMPACT}
                        onClick={() =>
                          void postSkillSuggestionAction(
                            { action: "approve_all_skill_phrases" },
                            "All pending skill suggestions approved.",
                          )
                        }
                      >
                        Accept all
                      </button>
                      <button
                        type="button"
                        disabled={skillPhraseReviewBusy}
                        className={BTN_GHOST_SM}
                        onClick={() =>
                          void postSkillSuggestionAction(
                            { action: "reject_all_skill_phrases" },
                            "All pending skill suggestions dismissed.",
                          )
                        }
                      >
                        Dismiss all
                      </button>
                    </div>
                  ) : null}
                  {lastSkillSuggestRationale ? (
                    <p className="text-xs text-slate-500">
                      <span className="font-medium text-slate-400">Model note: </span>
                      {lastSkillSuggestRationale}
                    </p>
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
                    <span className="font-medium text-slate-400">Synonym model note (upload): </span>
                    {synonymReviewLastUpload.rationale}
                  </p>
                ) : null}
                {synonymReviewLastUpload &&
                synonymReviewLastUpload.proposed.length > 0 &&
                synonymReviewLastUpload.addedRowCount === 0 &&
                !synonymReviewLastUpload.modelFailed ? (
                  <div className="rounded-md border border-slate-700 bg-slate-950/50 p-2 text-xs text-slate-400">
                    <p className="mb-1 font-medium text-slate-300">Latest synonym proposals (this upload)</p>
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

                <details className="rounded-md border border-slate-800 bg-slate-950/40 p-2 text-xs text-slate-400">
                  <summary className="cursor-pointer select-none text-sm font-medium text-slate-300">
                    Skill synonyms (advanced)
                  </summary>
                  <p className="mt-2 mb-3 text-[11px] text-slate-500">
                    Alias → canonical mappings for job matching. Pending rows from CV upload appear here; use
                    Accept/Dismiss or edit saved rows and Save synonyms.
                  </p>

                  <div className="space-y-2 border-t border-slate-800 pt-3">
                    <h4 className="text-xs font-medium text-slate-300">AI-suggested synonym mappings</h4>
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
                                className={BTN_PRIMARY_COMPACT}
                                onClick={() => void approvePendingSynonymRow(idx)}
                              >
                                Accept
                              </button>
                              <button
                                type="button"
                                disabled={domainSettingsBusy}
                                title="Dismiss this suggestion"
                                className={BTN_GHOST_SM}
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
                        No pending synonym rows. They appear after a CV upload when the model proposes new pairs.
                      </p>
                    )}
                    {skillSynonymPending.length > 1 ? (
                      <div className="flex flex-wrap gap-2 pt-1">
                        <button
                          type="button"
                          disabled={domainSettingsBusy}
                          className={BTN_PRIMARY_COMPACT}
                          onClick={() => void approveAllPendingSynonyms()}
                        >
                          Accept all
                        </button>
                        <button
                          type="button"
                          disabled={domainSettingsBusy}
                          className={BTN_GHOST_SM}
                          onClick={() => void dismissAllPendingSynonyms()}
                        >
                          Dismiss all
                        </button>
                      </div>
                    ) : null}
                  </div>

                  <div className="space-y-2 border-t border-slate-800 pt-3 mt-3">
                    <h4 className="text-xs font-medium text-slate-300">Saved &amp; editable synonym rows</h4>
                    <div className="space-y-2 max-h-64 overflow-auto pr-1">
                      {skillSynonymPairs.length === 0 ? (
                        <p className="text-xs text-slate-500">
                          No saved synonym rows yet — use Add row or accept a suggestion above.
                        </p>
                      ) : null}
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
                            className={BTN_GHOST_SM}
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
                        className={BTN_GHOST_SM}
                        onClick={() => setSkillSynonymPairs((prev) => [...prev, { from: "", to: "" }])}
                      >
                        Add row
                      </button>
                      <button
                        type="button"
                        disabled={domainSettingsBusy}
                        onClick={() => void saveSkillSynonymsToApi()}
                        className={BTN_PRIMARY_COMPACT}
                      >
                        Save synonyms
                      </button>
                    </div>
                    {synonymsUpdatedAt ? (
                      <p className="text-xs text-slate-500">Synonyms file updated: {synonymsUpdatedAt}</p>
                    ) : null}
                  </div>
                </details>
              </section>
            ) : null}

            <section className="space-y-4 rounded-2xl border border-slate-800/80 bg-slate-950/35 p-4 ring-1 ring-white/[0.04] sm:p-5">
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
                  className={BTN_GHOST}
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
                void elizaFetch("/api/user-preferences", {
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
              className={BTN_GHOST}
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
              className={`${BTN_PRIMARY_LG} w-full sm:w-auto`}
            >
            {loadingAnalysis
              ? `Processing with ${selectedModel}... (step ${analysisStep}/3)`
              : "Run Analysis"}
          </button>
          {!canRunAnalysis && !loadingAnalysis ? (
            <p className="text-xs text-slate-400">
              Upload a CV and paste a job description to enable Run Analysis.
            </p>
          ) : null}
          <div className="border-t border-slate-700 pt-3">
            <p className="text-sm font-medium mb-2">Refine Results (Persistent Constraint)</p>
            <input
              type="text"
              value={refineText}
              onChange={(event) => setRefineText(event.target.value)}
              placeholder='e.g. "I do not want PM roles", "I prefer remote work", "I want full-time only", or "I need to avoid certain countries or cities"'
              className="w-full rounded-md border border-slate-700 bg-slate-950 p-2 text-sm"
            />
            <button type="button" onClick={saveConstraintOnly} className={`${BTN_GHOST} mt-2`}>
              Save Constraint
            </button>
          </div>
            </section>
          </div>

          <div className="space-y-6 rounded-2xl border border-slate-800/80 bg-slate-900/50 p-5 shadow-sm shadow-black/20 ring-1 ring-white/[0.04] lg:sticky lg:top-6 lg:self-start lg:p-6">
            <section className="space-y-5">
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
                      Salary forecast
                    </h3>
                    <SalaryForecastCard
                      s={{
                        match_status: result.salary_analysis.match_status,
                        source: result.salary_analysis.source,
                        rationale: result.salary_analysis.rationale,
                        display: result.salary_analysis.salary_forecast_display ?? null,
                      }}
                    />
                    <div className="mt-2 flex flex-wrap gap-2 text-[10px] text-slate-500">
                      <span>
                        Range:{" "}
                        {formatSalaryValue(
                          result.salary_analysis.estimated_min,
                          result.salary_analysis.currency ?? preferredCurrency ?? "HUF",
                        )}{" "}
                        –{" "}
                        {formatSalaryValue(
                          result.salary_analysis.estimated_max,
                          result.salary_analysis.currency ?? preferredCurrency ?? "HUF",
                        )}
                      </span>
                      {result.salary_analysis.conversion_applied ? (
                        <span>
                          vs floor in {result.salary_analysis.comparison_currency}
                          {result.salary_analysis.exchange_rate_used
                            ? ` (${result.salary_analysis.exchange_rate_used})`
                            : ""}
                        </span>
                      ) : null}
                    </div>
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
                    className={BTN_GHOST_SM}
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
                        className={BTN_GHOST_BLUE_LG}
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

        <section className="rounded-2xl border border-slate-800/80 bg-slate-900/50 p-5 ring-1 ring-white/[0.04] space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
            Saved constraints
          </h2>
          {constraints.constraints.length === 0 ? (
            <p className="text-sm text-slate-400">No saved constraints yet.</p>
          ) : (
            <div className="max-h-52 space-y-1.5 overflow-auto pr-0.5">
              {constraints.constraints.map((item) => (
                <div
                  key={item}
                  className="group flex items-center gap-2 rounded-lg border border-slate-800/90 bg-slate-950/50 px-3 py-2 transition hover:border-slate-700/90 hover:bg-slate-900/70"
                >
                  <span className="min-w-0 flex-1 text-sm leading-snug text-slate-200">{item}</span>
                  <button
                    type="button"
                    onClick={() => {
                      void deleteConstraint(item);
                    }}
                    className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-transparent text-slate-500 opacity-0 transition hover:border-rose-800/50 hover:bg-rose-950/40 hover:text-rose-200 group-hover:opacity-100"
                    disabled={constraintsBusy}
                    aria-label={`Delete constraint: ${item}`}
                  >
                    <span className="text-xs font-semibold" aria-hidden>
                      ×
                    </span>
                  </button>
                </div>
              ))}
            </div>
          )}
          {constraints.updated_at ? (
            <p className="text-xs text-slate-500">Updated: {constraints.updated_at}</p>
          ) : null}
        </section>

        <section className="rounded-2xl border border-slate-800/80 bg-slate-900/50 p-5 ring-1 ring-white/[0.04] space-y-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
            Domain &amp; CV tuning
          </h2>
          <p className="text-xs text-slate-500">
            CV skills, AI skill suggestions, and skill synonyms are managed in the{" "}
            <span className="text-slate-400">CV skills &amp; tuning</span> card above. This section keeps{" "}
            <span className="font-medium text-slate-400">constraint tactics</span> only — they soften vetoes vs.
            score deltas (semantic scorer + offline location check).
          </p>

          <div className="space-y-2">
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
                  <option value="strong_preference">Strong preference (no veto)</option>
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
                  <option value="strong_preference">Strong preference (no veto)</option>
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
                  <option value="strong_preference">Strong preference (no veto)</option>
                </select>
              </label>
            </div>
            <button
              type="button"
              disabled={domainSettingsBusy}
              onClick={() => void saveConstraintTacticsToApi()}
              className={BTN_PRIMARY_COMPACT}
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
