export type FitScoreResult = {
  fit_score: number;
  matched_skills: string[];
  missing_skills: string[];
  seniority_match: boolean;
};

export type JobScoringEntities = {
  experience_years: number | null;
  education: string | null;
};
