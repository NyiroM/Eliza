import type { ParserSource } from "../lib/llm/ollama";

export type CvParseResult = {
  skills: string[];
  seniority_level: "junior" | "mid" | "senior" | "lead" | "unknown";
  core_stories: string[];
  parser_source: ParserSource;
};
