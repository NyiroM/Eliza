// lib/ui/dashboardButtons.ts
/** Tailwind class bundles for ELIZA Dashboard primary (emerald) and ghost CTAs. */

export const BTN_PRIMARY_BASE =
  "inline-flex items-center justify-center rounded-lg bg-gradient-to-r from-emerald-600 to-emerald-500 font-semibold text-white transition hover:from-emerald-500 hover:to-emerald-400 disabled:cursor-not-allowed disabled:from-emerald-950 disabled:to-emerald-900 disabled:text-emerald-100/50 disabled:shadow-none disabled:opacity-70";

export const BTN_PRIMARY = `${BTN_PRIMARY_BASE} px-4 py-2 text-sm shadow-lg shadow-emerald-900/20`;

export const BTN_PRIMARY_LG = `${BTN_PRIMARY_BASE} px-5 py-2.5 text-sm shadow-lg shadow-emerald-900/20`;

export const BTN_PRIMARY_COMPACT = `${BTN_PRIMARY_BASE} px-3 py-1.5 text-xs shadow-md shadow-emerald-900/25`;

export const BTN_GHOST =
  "inline-flex items-center justify-center rounded-md border border-slate-600 bg-transparent px-4 py-2 text-sm font-medium text-slate-200 transition hover:border-slate-500 hover:bg-slate-800/70 disabled:pointer-events-none disabled:opacity-40";

export const BTN_GHOST_SM =
  "inline-flex items-center justify-center rounded-md border border-slate-600 bg-transparent px-3 py-1.5 text-xs font-medium text-slate-200 transition hover:border-slate-500 hover:bg-slate-800/70 disabled:pointer-events-none disabled:opacity-40";

export const BTN_GHOST_BLUE_LG =
  "inline-flex w-full items-center justify-center rounded-lg border border-blue-500/45 bg-transparent px-5 py-3.5 text-base font-semibold text-blue-100 transition hover:border-blue-400 hover:bg-blue-950/35 disabled:cursor-not-allowed disabled:border-slate-700 disabled:text-slate-500 disabled:hover:bg-transparent sm:w-auto";

export const BTN_GHOST_AMBER_SM =
  "inline-flex items-center justify-center rounded-md border border-amber-700/70 bg-transparent px-3 py-2 text-xs font-medium text-amber-100 transition hover:border-amber-600 hover:bg-amber-950/40 disabled:pointer-events-none disabled:opacity-40";

export const BTN_GHOST_ROSE_SM =
  "inline-flex items-center justify-center rounded-md border border-rose-700/70 bg-transparent px-3 py-2 text-xs font-medium text-rose-100 transition hover:border-rose-600 hover:bg-rose-950/40 disabled:pointer-events-none disabled:opacity-40";

export const BTN_GHOST_VIOLET_SM =
  "inline-flex items-center justify-center rounded-md border border-violet-600/55 bg-transparent px-3 py-1.5 text-xs font-medium text-violet-100 transition hover:border-violet-500 hover:bg-violet-950/35 disabled:pointer-events-none disabled:opacity-40";

export const BTN_GHOST_VIOLET_LG =
  "inline-flex items-center justify-center rounded-lg border border-violet-600/55 bg-transparent px-5 py-2.5 text-sm font-semibold text-violet-100 transition hover:border-violet-500 hover:bg-violet-950/35 disabled:cursor-not-allowed disabled:border-slate-700 disabled:text-slate-500 disabled:hover:bg-transparent";

export const BTN_PRIMARY_MICRO =
  "inline-flex items-center justify-center rounded-md bg-gradient-to-r from-emerald-600 to-emerald-500 px-2 py-0.5 text-[11px] font-semibold text-white shadow-sm shadow-emerald-900/20 transition hover:from-emerald-500 hover:to-emerald-400 disabled:opacity-40";
