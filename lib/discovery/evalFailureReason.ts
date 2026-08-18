// lib/discovery/evalFailureReason.ts
/** Visible non-match line when the pipeline throws until max attempts (not a constraint veto). */
export function buildPipelineFailureNotMatchReason(attempts: number, error: string): string {
  const trimmed = error.length > 400 ? `${error.slice(0, 397)}...` : error;
  return `Pipeline failed after ${attempts} attempt(s) (not a constraint veto). Last error: ${trimmed}`;
}
