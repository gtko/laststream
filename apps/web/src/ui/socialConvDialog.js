/* Discussions Social v3 (lot F3) : petite boîte de dialogue modale (création de groupe, de sondage). Échap annule, Tab reste
 * dans la boîte, le focus revient au déclencheur. `build(body, ctl)` remplit la boîte et appelle ctl.setValid(bool). */
import { h } from './socialConvDom.js';

let seq = 0;

/**
 * @param {{ title: string, confirmLabel: string, build: (body: HTMLElement, ctl: { setValid(v: boolean): void, setError(msg: string): void }) => void,
 *   onConfirm: () => Promise<unknown>, opener?: Element | null }} o
 * @returns {{ close(): void, el: HTMLElement }}
 */
export function openDialog(o) {
  const id = 'cvd-' + ++seq;
  const veil = h('div', 'cvd-veil');
  const box = h('div', 'cvd', null, { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': id });
  box.append(h('h2', 'cvd-title', o.title, { id }));
  const body = h('div', 'cvd-body');
  const err = h('p', 'cvd-err', '', { role: 'alert' });
  const foot = h('div', 'cvd-foot');
  const cancel = h('button', 'cvm-btn', 'Annuler', { type: 'button' });
  const ok = h('button', 'cvm-btn is-accent', o.confirmLabel, { type: 'button' });
  ok.disabled = true;
  foot.append(cancel, ok);
  box.append(body, err, foot);
  veil.append(box);
  document.body.append(veil);

  let busy = false;
  let valid = false;
  const refresh = () => { ok.disabled = busy || !valid; };
  const ctl = {
    setValid(v) { valid = !!v; refresh(); },
    setError(msg) { err.textContent = msg || ''; },
  };
  function close() {
    veil.remove();
    document.removeEventListener('keydown', onKey, true);
    if (o.opener && o.opener.isConnected && typeof o.opener.focus === 'function') o.opener.focus();
  }
  async function confirm() {
    if (busy || !valid) return;
    busy = true;
    refresh();
    ctl.setError('');
    try {
      await o.onConfirm();
      close();
    } catch (e) {
      busy = false;
      refresh();
      ctl.setError(e && e.message ? e.message : 'Impossible pour le moment.');
    }
  }
  function onKey(e) {
    if (!veil.isConnected) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === 'Tab') {
      const f = Array.from(box.querySelectorAll('button, input, textarea, select, [tabindex]')).filter((x) => !x.disabled && x.tabIndex >= 0);
      if (!f.length) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }
  document.addEventListener('keydown', onKey, true);
  veil.addEventListener('mousedown', (e) => { if (e.target === veil) close(); });
  cancel.addEventListener('click', close);
  ok.addEventListener('click', () => { void confirm(); });
  o.build(body, ctl);
  const first = body.querySelector('input, textarea, button');
  if (first) first.focus();
  return { close, el: box };
}
