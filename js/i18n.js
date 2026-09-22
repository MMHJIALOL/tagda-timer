/* ===========================================================
   Tagda Timer — interface language

   English is the source text: t('Some string') returns the Spanish for it
   when Spanish is on, and the string itself otherwise. Placeholders are
   {name} and filled from the second argument, so word order can change:
   t('{n} moves to finish the solve', { n: 7 }).

   The language is read synchronously from localStorage before any other
   module evaluates, because plenty of labels are built at import time and
   would otherwise be frozen in English. Changing it reloads the page.
   A worker has no localStorage, so the page starts the solver worker with
   ?lang= on its URL and the worker reads it from there.
   =========================================================== */

const KEY = 'tdt-lang';

export const lang = (() => {
  let v = null;
  try { v = localStorage.getItem(KEY); }
  catch { v = new URLSearchParams(globalThis.location?.search).get('lang'); }
  return v === 'es' ? 'es' : 'en';
})();

const dict = lang === 'es' ? (await import('../locales/es.js')).es : {};

if (typeof document !== 'undefined') document.documentElement.lang = lang;

export function t(str, vars) {
  let s = (str && dict[str]) || str;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
  return s;
}

export function setLang(next) {
  try { localStorage.setItem(KEY, next); } catch { /* private window: stays English */ }
  location.reload();
}

// HTML text wraps across source lines; the dictionary holds it on one.
const squash = (s) => s.trim().replace(/\s+/g, ' ');

/** Translate the static text a page ships with in its HTML. */
export function translateDOM(root = document.body) {
  if (lang === 'en' || !root) return;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || /^(SCRIPT|STYLE|CODE)$/.test(parent.tagName) || parent.closest('.brand')) {
        return NodeFilter.FILTER_REJECT;
      }
      return dict[squash(node.textContent)] ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    // Keep the whitespace either side: it is what separates this text from
    // the <kbd> or <b> next to it.
    const [, lead, , trail] = node.textContent.match(/^(\s*)([\s\S]*?)(\s*)$/);
    node.textContent = lead + dict[squash(node.textContent)] + trail;
  }

  for (const attr of ['title', 'placeholder', 'aria-label']) {
    for (const node of root.querySelectorAll(`[${attr}]`)) {
      const v = dict[node.getAttribute(attr)];
      if (v) node.setAttribute(attr, v);
    }
  }
}
