const RAW_ORDER = ["NM", "LP", "MP", "HP", "DMG"];
const GRADERS = ["PSA", "BGS", "CGC", "SGC"];

export const DEFAULT_FILTERS = {
  raw: { NM: true, LP: false, MP: false, HP: false, DMG: false },
  graded: { PSA: false, BGS: false, CGC: false, SGC: false },
};

export function mergeFilters(saved) {
  const out = JSON.parse(JSON.stringify(DEFAULT_FILTERS));
  if (!saved || typeof saved !== "object") return out;
  for (const group of Object.keys(DEFAULT_FILTERS)) {
    const source = saved[group];
    if (!source || typeof source !== "object") continue;
    for (const key of Object.keys(DEFAULT_FILTERS[group])) {
      if (typeof source[key] === "boolean") out[group][key] = source[key];
    }
  }
  return out;
}

export function primaryCondition(filters) {
  return RAW_ORDER.find((key) => filters?.raw?.[key] === true) ?? "NM";
}

export function withCondition(filters, cond) {
  const raw = Object.fromEntries(RAW_ORDER.map((key) => [key, key === cond]));
  return { ...filters, raw };
}

export function withGrader(filters, grader, on) {
  if (!GRADERS.includes(grader)) return filters;
  return { ...filters, graded: { ...filters.graded, [grader]: Boolean(on) } };
}
