/**
 * Sensitive form fields (v53): passwords, one-time codes and payment details
 * stay with the user (dots / Grok Bot / Muse all hand these steps over). The
 * embedded browser refuses to type into them and returns this sentinel; the
 * tool executor turns it into a "your turn" handoff. Saved logins are filled
 * by main from the credential vault — the model never sees the password.
 *
 * Electron-free so the executor (and its tests) can import it.
 */

/** Prefix of a browser result that means "this field is the user's to fill". */
export const SENSITIVE_FIELD_SENTINEL = 'SENSITIVE_FIELD:'

/**
 * Page-side predicate, injected into executeJavaScript snippets as source.
 * Matches password inputs, autocomplete tokens for credentials/cards/OTPs and
 * the common card/security-code field names.
 */
export const IS_SENSITIVE_FIELD_JS = `(el) => {
  if (!el || !el.getAttribute) return false;
  const type = (el.getAttribute('type') || '').toLowerCase();
  if (type === 'password') return true;
  const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
  if (/(^|\\s)(cc-|current-password|new-password|one-time-code)/.test(ac)) return true;
  const hint = ((el.name || '') + ' ' + (el.id || '') + ' ' + (el.getAttribute('aria-label') || '')).toLowerCase();
  return /(card.?num|cardnumber|credit.?card|cvc|cvv|security.?code|iban|password|passcode|one.?time)/.test(hint);
}`

/** The message the model gets (after the sentinel) when it hits such a field. */
export function sensitiveFieldMessage(kind: 'type' | 'computer'): string {
  return (
    `${SENSITIVE_FIELD_SENTINEL} that ${kind === 'type' ? 'field' : 'focused field'} takes a ` +
    'password, one-time code or payment detail, which always stays with the user. For a saved ' +
    "login use the browser tool's 'login' action; otherwise the step is handed to the user."
  )
}

/** Normalizes an http(s) URL to its origin, or null. */
export function originOf(raw: string): string | null {
  try {
    const url = new URL(raw.trim())
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    return url.origin
  } catch {
    return null
  }
}

/**
 * The page snapshot the browser tool hands the model (title, url, visible
 * text, clickable elements with centres). A sensitive field (password,
 * one-time code, card) is labelled by its aria-label / placeholder / name
 * only — NEVER its value, so a password the vault or the user typed can't
 * reach the model, the transcript or the log.
 */
export function buildSnapshotJs(maxElements: number, maxTextChars: number): string {
  return `(() => {
  const sensitive = ${IS_SENSITIVE_FIELD_JS};
  const pick = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    if (r.bottom < 0 || r.top > innerHeight) return null;
    const label = sensitive(el)
      ? ((el.getAttribute('aria-label') || el.placeholder || el.name || 'sensitive field').trim().slice(0, 60) + ' [value hidden]')
      : (el.getAttribute('aria-label') || el.value || el.placeholder || el.innerText || el.alt || '').trim().slice(0, 80);
    return { tag: el.tagName.toLowerCase(), label, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  };
  const nodes = Array.from(document.querySelectorAll('a,button,input,textarea,select,[role=button],[role=link]'));
  const elements = [];
  for (const n of nodes) { const p = pick(n); if (p && (p.label || p.tag === 'input')) elements.push(p); if (elements.length >= ${maxElements}) break; }
  return { title: document.title, url: location.href, text: (document.body ? document.body.innerText : '').slice(0, ${maxTextChars}), elements };
})()`
}
