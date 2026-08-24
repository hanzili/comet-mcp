/**
 * Structural fingerprint rebind (ADR 0003, inspired by Bladebro src/page/refs.rs).
 *
 * When a provider control's selector misses (React/Vue re-render changed text/class
 * but preserved structure), we rebind via a structural fingerprint instead of
 * escalating to full discovery. FNV-1a hash of ancestor chain + tag + first children
 * + identity attributes, computed in-page — same scheme as Bladebro's JS_NC_FN +
 * JS_FNV_FN (perception.rs).
 *
 * Resolution order (registry.ts + here): known → fingerprint-rebind → heuristic →
 * discovery escalation. The fingerprint is a SECONDARY signal after the primary
 * selector/sig; 32-bit collisions are acceptable.
 */

/** FNV-1a 32-bit — in-page, deterministic, cheap. Mirrors Bladebro's JS_FNV_FN. */
export const FNV_FN_JS = `function __fnv(s){let h=0x811c9dc5;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,0x01000193)>>>0}return h}`;

/**
 * Ephemeral framework-generated IDs (React/Radix/Base UI): `_r_`, `base-ui-_r_`,
 * `radix-…` — they rotate on every re-render and must never be used as a primary
 * selector or rebind target. Structural fingerprints ignore them by construction;
 * this guard keeps them out of selector-building too (fix 2026-08-07: claude
 * modelPicker was stored as `#base-ui-_r_cp_` and broke on the first render).
 */
export function isEphemeralId(id: string | null | undefined): boolean {
  if (!id) return false;
  return /^(base-ui-|radix-|_r_)/.test(id) || /_r_/.test(id);
}

/** Ancestor chain string: tag[index]>tag[index]>... up to 10 levels (Bladebro JS_NC_FN). */
export const ANCESTOR_CHAIN_JS = `function __nc(n){const c=[];let cur=n;for(let d=0;d<10&&cur;d++){c.push(cur.tagName?cur.tagName.toLowerCase():'unk');const p=cur.parentElement;if(p){c.push(''+Array.prototype.indexOf.call(p.children,cur));cur=p}else break}return c.join('>')}`;

/**
 * In-page fingerprint expression for a given CSS selector. Returns the fingerprint
 * (number) of the first matching element, or 0 if no match. Computes the same
 * structural fingerprint as discovery: ancestor chain + tag + first-3 children +
 * (type, name, data-testid).
 */
export function fingerprintOf(selector: string): string {
  return `(()=>{
    ${FNV_FN_JS}
    ${ANCESTOR_CHAIN_JS}
    const el=document.querySelector(${JSON.stringify(selector)});
    if(!el) return 0;
    const kids=el.children&&el.children.length?Array.from(el.children).slice(0,3).map(c=>c.tagName.toLowerCase()).join(','):'';
    const cust=(el.type||'')+','+(el.name||'')+','+(el.getAttribute('data-testid')||'');
    return __fnv(__nc(el)+','+el.tagName.toLowerCase()+','+kids+'|'+cust);
  })()`;
}

/**
 * In-page rebind search: given the previous element's fingerprint + the previous
 * signature parts (role/name via data-testid/type/name heuristics), find the element
 * on the live page whose structural fingerprint matches. Returns its best selector,
 * or null if no fingerprint match (genuine DOM change → escalate to discovery).
 *
 * Strategy (scoped version of Bladebro's stabilize Pass 2): enumerate candidate
 * elements that are in the same structural neighborhood (composer-area, message
 * containers), compute each one's fingerprint, and match. Candidates are limited to
 * interactive/form/message-like elements to keep it cheap.
 */
export function rebindSearchJs(prevFingerprint: number, candidateSelector: string): string {
  return `(()=>{
    ${FNV_FN_JS}
    ${ANCESTOR_CHAIN_JS}
    const want=${prevFingerprint};
    const cands=document.querySelectorAll(${JSON.stringify(candidateSelector)});
    for(const el of cands){
      const kids=el.children&&el.children.length?Array.from(el.children).slice(0,3).map(c=>c.tagName.toLowerCase()).join(','):'';
      const cust=(el.type||'')+','+(el.name||'')+','+(el.getAttribute('data-testid')||'');
      const fp=__fnv(__nc(el)+','+el.tagName.toLowerCase()+','+kids+'|'+cust);
      if(fp===want){
        // Return a SERIALIZABLE summary (Runtime.evaluate runs with returnByValue:true
        // — a DOM node cannot cross the boundary). selectorFromElement() rebuilds a
        // best-effort CSS selector from these attrs.
        return {
          id: el.id || null,
          testid: el.getAttribute('data-testid') || null,
          aria: el.getAttribute('aria-label') || null,
          name: el.getAttribute('name') || null,
          tag: el.tagName ? el.tagName.toLowerCase() : null,
          cls: (typeof el.className === 'string' ? el.className : '') || null,
        };
      }
    }
    return null;
  })()`;
}

/** Default candidate selector for rebind: anything interactive or text-bearing. */
export const DEFAULT_REBIND_CANDIDATES =
  'button, [role="button"], [contenteditable="true"], textarea, input, [role="textbox"], [data-testid], [class*="prose"], model-response, [data-message-author-role]';

/**
 * Rebind result: the new selector to use, or null when no fingerprint match
 * (genuine change → escalate).
 */
export interface RebindResult {
  /** Best-effort selector for the rebound element (built from its attrs). */
  selector: string | null;
  /** True when a fingerprint match was found (re-render survived). */
  rebound: boolean;
}

/**
 * Build a best-effort CSS selector for a matched element, from the SERIALIZABLE
 * summary returned by rebindSearchJs (id/testid/aria/name/tag/cls).
 */
export function selectorFromElement(summary: any): string | null {
  if (!summary) return null;
  const esc = (s: string) => String(s).replace(/[^a-zA-Z0-9_-]/g, ch => '\\' + ch);
  // fix 2026-08-07: never rebind onto an ephemeral framework id (rotates next render)
  if (summary.id && !isEphemeralId(summary.id)) return `#${esc(summary.id)}`;
  if (summary.testid) return `[data-testid="${esc(summary.testid)}"]`;
  if (summary.aria) return `[aria-label="${esc(summary.aria)}"]`;
  if (summary.name) return `[name="${esc(summary.name)}"]`;
  if (summary.cls) {
    const cls = summary.cls.split(/\s+/).filter((c: string) => c && !/^[a-f0-9]{6,}$/.test(c)).slice(0, 2);
    if (cls.length) return `${summary.tag || 'div'}.${cls.map(esc).join('.')}`;
  }
  return null;
}

/**
 * Resolve a control selector with fingerprint rebind:
 * 1. Try the known selector directly.
 * 2. On miss, if we have the previous fingerprint, search candidates for a match.
 * 3. Rebind if found; else null (escalate to heuristic/discovery).
 *
 * Pure orchestration — the caller supplies evaluate() so this stays testable.
 */
export async function resolveWithRebind(
  evaluate: (expr: string) => Promise<any>,
  selector: string,
  prevFingerprint: number | undefined,
  candidateSelector: string = DEFAULT_REBIND_CANDIDATES,
): Promise<{ selector: string; rebound: boolean } | null> {
  // 1. known selector
  try {
    const hit = await evaluate(`document.querySelector(${JSON.stringify(selector)}) !== null`);
    if (hit === true) return { selector, rebound: false };
  } catch { /* evaluate failed — treat as miss */ }

  // 2. fingerprint rebind
  if (prevFingerprint && prevFingerprint !== 0) {
    try {
      const found = await evaluate(rebindSearchJs(prevFingerprint, candidateSelector));
      if (found) {
        const newSelector = selectorFromElement(found);
        if (newSelector) return { selector: newSelector, rebound: true };
      }
    } catch { /* rebind failed — escalate */ }
  }

  // 3. no match — genuine change
  return null;
}
