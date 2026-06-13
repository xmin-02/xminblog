// Single source of truth for tag/post "영역(domain)" classification + colors.
// Used by both Astro frontmatter (server) and bundled client scripts.
//
// Area → color mapping (see global.css .v11-tag / .lvl):
//   sec → red · ai → purple · dev → cyan · '' → meta (subtle/gray)
//
// To add/adjust a domain, edit ONLY this file. Adding a brand-new area also
// needs a matching `.v11-tag.<area>` color rule in global.css.

export type Area = 'sec' | 'ai' | 'dev' | '';

/** Keyword lists (lowercased, substring match). Order = priority. */
export const AREA_KEYWORDS: Record<Exclude<Area, ''>, string[]> = {
  sec: [
    'security', '보안', 'fuzzing', '퍼징', '0day', '0-day', 'binary', '바이너리',
    'kernel', '커널', 'windows', 'zdi', 'winafl', 'syzkaller', 'reverse',
    'exploit', 'pwn', 'pentest', 'cve', 'npd', '취약점',
  ],
  ai: [
    'ai', '인공지능', 'ml', '머신러닝', 'llm', 'rag', 'nlp', 'deep', '딥러닝',
    'gpt', 'bert', 'ensemble',
  ],
  dev: [
    'dev', '개발', 'react', 'flask', 'node', 'python', 'typescript', 'bot',
    'telegram', 'frontend', 'backend', 'web',
  ],
};

const AREA_ORDER: Array<Exclude<Area, ''>> = ['sec', 'ai', 'dev'];

export const AREA_LABEL: Record<Area, string> = {
  sec: 'security',
  ai: 'ai',
  dev: 'dev',
  '': 'meta',
};

/** Classify a free-text string (a tag, or category+tags joined). */
export function areaForText(text: string | undefined | null): Area {
  const h = String(text ?? '').toLowerCase();
  for (const a of AREA_ORDER) {
    if (AREA_KEYWORDS[a].some((k) => h.includes(k))) return a;
  }
  return '';
}

/** Classify a post by its category + tags. */
export function areaForPost(p: { category?: string; tags?: string[] } | undefined | null): Area {
  return areaForText([p?.category, ...((p?.tags) || [])].join(' '));
}

export function areaLabel(a: Area): string {
  return AREA_LABEL[a];
}
