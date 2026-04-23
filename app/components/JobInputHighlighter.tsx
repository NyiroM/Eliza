"use client";

import { useMemo, useRef, useState, type MouseEvent } from "react";
import { buildSemanticHighlightMatches, buildSemanticHighlightParts } from "@/lib/semanticHighlightMatcher";
import type { SemanticHighlight } from "@/types/pipeline";

type JobInputHighlighterProps = {
  id: string;
  value: string;
  onChange: (value: string) => void;
  highlights?: SemanticHighlight[];
  placeholder?: string;
};

type HighlightTooltip = {
  phrase: string;
  reason: string;
  sentiment: "positive" | "negative";
  x: number;
  y: number;
};

const MIRROR_TEXT_STYLES = {
  fontFamily: "Arial, Helvetica, sans-serif",
  fontSize: "0.875rem",
  lineHeight: "1.625",
  padding: "0.75rem",
};

export default function JobInputHighlighter({
  id,
  value,
  onChange,
  highlights = [],
  placeholder = "Paste the full job posting here…",
}: JobInputHighlighterProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mirrorScrollRef = useRef<HTMLDivElement>(null);
  const [tooltip, setTooltip] = useState<HighlightTooltip | null>(null);
  const tooltipTargetIdRef = useRef<string | null>(null);

  const matches = useMemo(
    () => buildSemanticHighlightMatches(value, highlights),
    [highlights, value],
  );
  const parts = useMemo(() => buildSemanticHighlightParts(value, matches), [matches, value]);
  const hasHighlights = highlights.length > 0;

  const syncMirrorScroll = () => {
    const textarea = textareaRef.current;
    const mirror = mirrorScrollRef.current;
    if (!textarea || !mirror) {
      return;
    }
    mirror.scrollTop = textarea.scrollTop;
    mirror.scrollLeft = textarea.scrollLeft;
  };

  const handleOverlayMouseMove = (event: MouseEvent<HTMLDivElement>) => {
    const layeredElements = document.elementsFromPoint(event.clientX, event.clientY);
    const hoveredMatch = layeredElements.find(
      (element): element is HTMLElement =>
        element instanceof HTMLElement && Boolean(element.dataset.semanticReason),
    );

    if (!hoveredMatch) {
      if (tooltip) {
        setTooltip(null);
      }
      tooltipTargetIdRef.current = null;
      return;
    }

    const targetId = hoveredMatch.dataset.semanticId ?? null;
    if (
      tooltipTargetIdRef.current === targetId &&
      tooltip?.phrase === (hoveredMatch.dataset.semanticPhrase ?? "") &&
      tooltip?.reason === (hoveredMatch.dataset.semanticReason ?? "") &&
      tooltip?.x === event.clientX &&
      tooltip?.y === event.clientY
    ) {
      return;
    }

    tooltipTargetIdRef.current = targetId;

    setTooltip({
      phrase: hoveredMatch.dataset.semanticPhrase ?? "",
      reason: hoveredMatch.dataset.semanticReason ?? "",
      sentiment:
        hoveredMatch.dataset.semanticSentiment === "negative" ? "negative" : "positive",
      x: event.clientX,
      y: event.clientY,
    });
  };

  return (
    <div
      className="space-y-2"
      onMouseMove={handleOverlayMouseMove}
      onMouseLeave={() => {
        tooltipTargetIdRef.current = null;
        setTooltip(null);
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={id} className="text-sm font-medium text-slate-200">
          Job description
        </label>
        {hasHighlights ? (
          <span className="inline-flex items-center gap-1 rounded-full border border-emerald-700/80 bg-emerald-950/50 px-2 py-0.5 text-[11px] font-medium text-emerald-200">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-300" aria-hidden />
            Highlights Active
          </span>
        ) : null}
      </div>
      <p className="text-xs text-slate-500">
        Edit normally. Hover highlighted phrases to inspect semantic rationale.
      </p>

      <div className="relative rounded-md border border-slate-700 bg-slate-950">
        <div
          ref={mirrorScrollRef}
          aria-hidden
          className="absolute inset-0 overflow-auto rounded-md"
        >
          <div style={MIRROR_TEXT_STYLES} className="min-h-[14rem] whitespace-pre-wrap break-words md:min-h-[22rem]">
            {value.length === 0 ? (
              <span className="text-slate-500">{placeholder}</span>
            ) : (
              <>
                {parts.map((part) => {
                  if (!part.match) {
                    return (
                      <span key={part.id} className="text-slate-200">
                        {part.text}
                      </span>
                    );
                  }
                  const highlightClass =
                    part.match.sentiment === "positive"
                      ? "bg-emerald-700/55 text-emerald-50 ring-1 ring-emerald-500/30"
                      : "bg-rose-800/55 text-rose-50 ring-1 ring-rose-500/35";
                  return (
                    <mark
                      key={part.id}
                      data-semantic-id={part.id}
                      data-semantic-phrase={part.text}
                      data-semantic-reason={part.match.reason}
                      data-semantic-sentiment={part.match.sentiment}
                      className={`rounded px-0.5 ${highlightClass}`}
                    >
                      {part.text}
                    </mark>
                  );
                })}
                {value.endsWith("\n") ? <span>{"\u00A0"}</span> : null}
              </>
            )}
          </div>
        </div>

        <textarea
          ref={textareaRef}
          id={id}
          value={value}
          onChange={(event) => {
            onChange(event.target.value);
            requestAnimationFrame(syncMirrorScroll);
          }}
          onScroll={syncMirrorScroll}
          placeholder={placeholder}
          className="relative z-10 block min-h-[14rem] w-full resize-y overflow-auto rounded-md bg-transparent text-transparent caret-black focus:outline-none md:min-h-[22rem]"
          style={MIRROR_TEXT_STYLES}
        />
      </div>

      {tooltip ? (
        <div
          role="tooltip"
          className="pointer-events-none fixed z-50 max-w-xs rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-slate-100 shadow-lg shadow-slate-950/80"
          style={{ left: tooltip.x + 12, top: tooltip.y + 12 }}
        >
          <p className="font-medium text-slate-200">{tooltip.phrase}</p>
          <p
            className={
              tooltip.sentiment === "positive" ? "text-emerald-300" : "text-rose-300"
            }
          >
            {tooltip.sentiment === "positive" ? "Positive signal" : "Negative signal"}
          </p>
          <p className="mt-0.5 text-slate-300">{tooltip.reason}</p>
        </div>
      ) : null}
    </div>
  );
}
