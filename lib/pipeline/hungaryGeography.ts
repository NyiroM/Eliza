// lib/pipeline/hungaryGeography.ts — comma-separated target locations + HU county → city expansion.

import {
  JOB_BOARD_BROAD_LOCATION_SLUGS,
  parsePreferredLocationSegments,
  segmentToLocationSlug,
} from "../discovery/locationPreferenceShared";

/** Cities / towns recognized in job text, URLs, and user preference segments. */
export const KNOWN_LOCATION_CITY_SLUGS = new Set([
  "budapest",
  "miskolc",
  "debrecen",
  "szeged",
  "gyor",
  "pecs",
  "kecskemet",
  "szekesfehervar",
  "nyiregyhaza",
  "szombathely",
  "szolnok",
  "tatabanya",
  "erd",
  "szigetszentmiklos",
  "dunakeszi",
  "godollo",
  "god",
  "visegrad",
  "biatorbagy",
  "szentendre",
  "budaors",
  "vac",
  "zalaegerszeg",
  "sopron",
  "eger",
  "bekescsaba",
  "kaposvar",
  "veszprem",
  "kazincbarcika",
  "sajoszentpeter",
  "ozd",
  "mezokovesd",
  "edeleny",
  "tiszaujvaros",
  "baja",
  "kiskunfelegyhaza",
  "komlo",
  "mohacs",
  "gyula",
  "oroshaza",
  "hodmezovasarhely",
  "mako",
  "dunaujvaros",
  "mosonmagyarovar",
  "hajduszoboszlo",
  "gyongyos",
  "hatvan",
  "jaszbereny",
  "torokszentmiklos",
  "esztergom",
  "komarom",
  "oroszlany",
  "salgotarjan",
  "balassagyarmat",
  "cegled",
  "siom",
  "marcali",
  "kisvarda",
  "mateszalka",
  "szekszard",
  "paks",
  "kormend",
  "szentgotthard",
  "ajka",
  "tapolca",
  "papa",
  "keszthely",
  "nagykanizsa",
]);

/** Non-HU cities kept so incidental HQ / footprint mentions can be recognized and ignored. */
export const FOREIGN_LOCATION_CITY_SLUGS = new Set([
  "berlin",
  "munich",
  "munchen",
  "hamburg",
  "frankfurt",
  "vienna",
  "wien",
  "prague",
  "praha",
  "warsaw",
  "warszawa",
  "krakow",
  "bucharest",
  "bucuresti",
  "london",
  "manchester",
  "birmingham",
  "paris",
  "lyon",
  "marseille",
  "amsterdam",
  "rotterdam",
  "brussels",
  "bruxelles",
  "zurich",
  "geneva",
  "genf",
]);

for (const city of FOREIGN_LOCATION_CITY_SLUGS) KNOWN_LOCATION_CITY_SLUGS.add(city);

/** Canonical county key → major city slugs in that county. */
const COUNTY_CITIES: Record<string, readonly string[]> = {
  "bacs-kiskun": ["kecskemet", "baja", "kiskunfelegyhaza"],
  baranya: ["pecs", "komlo", "mohacs"],
  bekes: ["bekescsaba", "gyula", "oroshaza"],
  "borsod-abauj-zemplen": [
    "miskolc",
    "kazincbarcika",
    "ozd",
    "mezokovesd",
    "sajoszentpeter",
    "edeleny",
    "tiszaujvaros",
  ],
  "csongrad-csanad": ["szeged", "hodmezovasarhely", "mako"],
  fejer: ["szekesfehervar", "dunaujvaros"],
  "gyor-moson-sopron": ["gyor", "sopron", "mosonmagyarovar"],
  "hajdu-bihar": ["debrecen", "hajduszoboszlo"],
  heves: ["eger", "gyongyos", "hatvan"],
  "jasz-nagykun-szolnok": ["szolnok", "jaszbereny", "torokszentmiklos"],
  "komarom-esztergom": ["tatabanya", "esztergom", "komarom", "oroszlany"],
  nograd: ["salgotarjan", "balassagyarmat"],
  pest: ["erd", "szigetszentmiklos", "dunakeszi", "godollo", "vac", "cegled", "god", "visegrad", "biatorbagy", "szentendre", "budaors"],
  somogy: ["kaposvar", "siom", "marcali"],
  "szabolcs-szatmar-bereg": ["nyiregyhaza", "kisvarda", "mateszalka"],
  tolna: ["szekszard", "paks"],
  vas: ["szombathely", "kormend", "szentgotthard"],
  veszprem: ["veszprem", "ajka", "tapolca", "papa"],
  zala: ["zalaegerszeg", "keszthely", "nagykanizsa"],
};

/** Slug aliases → canonical county key in COUNTY_CITIES. */
const COUNTY_ALIASES: Record<string, string> = {
  baz: "borsod-abauj-zemplen",
  "borsod-abauj-zemplen-megye": "borsod-abauj-zemplen",
  "borsod-abauj-zemplen-m": "borsod-abauj-zemplen",
  borsod: "borsod-abauj-zemplen",
  abauj: "borsod-abauj-zemplen",
  zemplen: "borsod-abauj-zemplen",
  "bacs-kiskun-megye": "bacs-kiskun",
  "baranya-megye": "baranya",
  "bekes-megye": "bekes",
  "csongrad-megye": "csongrad-csanad",
  "csongrad-csanad-megye": "csongrad-csanad",
  "fejer-megye": "fejer",
  "gyor-moson-sopron-megye": "gyor-moson-sopron",
  "hajdu-bihar-megye": "hajdu-bihar",
  "heves-megye": "heves",
  "jasz-nagykun-szolnok-megye": "jasz-nagykun-szolnok",
  "komarom-esztergom-megye": "komarom-esztergom",
  "nograd-megye": "nograd",
  "pest-megye": "pest",
  "somogy-megye": "somogy",
  "szabolcs-szatmar-bereg-megye": "szabolcs-szatmar-bereg",
  "tolna-megye": "tolna",
  "vas-megye": "vas",
  "veszprem-megye": "veszprem",
  "zala-megye": "zala",
};

/** Typos / alternate spellings → canonical city slug in KNOWN_LOCATION_CITY_SLUGS. */
const CITY_ALIASES: Record<string, string> = {
  gud: "god",
  goed: "god",
  "go-d": "god",
};

function resolveCitySlug(slug: string): string {
  return CITY_ALIASES[slug] ?? slug;
}

/** Same-metro / commuter expansion when a city is listed explicitly (not via whole county). */
const METRO_BY_CITY: Record<string, readonly string[]> = {
  budapest: [
    "budapest",
    "pest",
    "buda",
    "szigetszentmiklos",
    "dunakeszi",
    "godollo",
    "erd",
    "vac",
    "szentendre",
    "budaors",
    "cegled",
    "god",
    "visegrad",
    "biatorbagy",
  ],
};

function resolveCountyKey(slug: string): string | null {
  if (COUNTY_CITIES[slug]) return slug;
  return COUNTY_ALIASES[slug] ?? null;
}

/**
 * All city slugs implied by the dashboard target location (comma list + county expansion).
 */
export function expandPreferredLocationToCitySlugs(preferredLocation: string | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const seg of parsePreferredLocationSegments(preferredLocation)) {
    const slug = segmentToLocationSlug(seg);
    if (!slug || JOB_BOARD_BROAD_LOCATION_SLUGS.has(slug)) continue;

    const countyKey = resolveCountyKey(slug);
    if (countyKey) {
      for (const c of COUNTY_CITIES[countyKey] ?? []) out.add(c);
      continue;
    }

    const city = resolveCitySlug(slug);
    if (KNOWN_LOCATION_CITY_SLUGS.has(city)) {
      out.add(city);
      for (const m of METRO_BY_CITY[city] ?? []) out.add(m);
      continue;
    }
    if (city.length >= 3) out.add(city);
  }
  return out;
}

export function hasActionablePreferredGeography(preferredLocation: string | null | undefined): boolean {
  return expandPreferredLocationToCitySlugs(preferredLocation).size > 0;
}

/** Short label for veto messages (full comma list, trimmed). */
export function formatPreferredLocationLabel(preferredLocation: string | null | undefined): string {
  const segments = parsePreferredLocationSegments(preferredLocation);
  if (segments.length === 0) return "your target location";
  const joined = segments.join(", ");
  return joined.length > 120 ? `${joined.slice(0, 117)}…` : joined;
}

/**
 * First city slug for Profession / Indeed listing URLs (skips bare county-only until it picks county seat).
 */
export function primaryCitySlugForJobBoardSearch(
  preferredLocation: string | null | undefined,
): string | null {
  const segments = parsePreferredLocationSegments(preferredLocation);
  for (const seg of segments) {
    const slug = segmentToLocationSlug(seg);
    if (!slug || JOB_BOARD_BROAD_LOCATION_SLUGS.has(slug)) continue;
    if (KNOWN_LOCATION_CITY_SLUGS.has(resolveCitySlug(slug))) return resolveCitySlug(slug);
  }
  for (const seg of segments) {
    const slug = segmentToLocationSlug(seg);
    if (!slug) continue;
    const countyKey = resolveCountyKey(slug);
    if (countyKey) {
      const cities = COUNTY_CITIES[countyKey];
      if (cities?.[0]) return cities[0];
    }
  }
  return null;
}

/** LinkedIn guest `location=` — one city (or Hungary), never the full comma list. */
export function linkedInLocationFromPreference(preferredLocation: string | null | undefined): string {
  const city = primaryCitySlugForJobBoardSearch(preferredLocation);
  if (!city) return "Hungary";
  const label = city
    .split("-")
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
  return `${label}, Hungary`;
}
