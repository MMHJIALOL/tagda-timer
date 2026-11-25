import { el } from './util.js';
import { t } from './i18n.js';
import { toast } from './toast.js';
import { AVG_MIN, AVG_MAX } from './average-settings.js';

export function averageHeading(n, edit, { best = false } = {}) {
  const label = best ? t('Change the best ao{n}', { n }) : t('Change the ao{n} column', { n });
  return el('span', { class: 'avg-heading' },
    el('span', { text: `ao${n}` }),
    el('button', {
      type: 'button', class: 'avg-edit', text: '✎',
      title: label, 'aria-label': label,
      onclick: event => { event.stopPropagation(); edit(); },
    }));
}

export function averageEditToggle(onClick) {
  return el('button', {
    type: 'button', class: 'avg-edit-toggle', text: '✎',
    title: t('Edit averages'), 'aria-label': t('Edit averages'), 'aria-pressed': 'false',
    // Handle the toggle before blurring an input can rebuild the summary.
    onpointerdown: event => event.preventDefault(),
    onclick: event => { event.stopPropagation(); onClick(); },
  });
}

export function setAverageEditing(host, editing) {
  host.dataset.avgEditing = String(editing);
  const toggle = host.querySelector('.avg-edit-toggle');
  const label = t(editing ? 'Finish editing averages' : 'Edit averages');
  toggle.setAttribute('aria-pressed', String(editing));
  toggle.setAttribute('aria-label', label);
  toggle.title = label;
  // Saving can rebuild the drawer and move its toggle into the new summary.
  // Update this view first, then commit the input before returning.
  if (!editing) host.querySelectorAll('input.col-num').forEach(input => input.blur());
}

/** Enter or blur saves; Escape restores the heading without changing settings. */
export function editAverage(host, n, { getValues, onCommit }) {
  if (host.querySelector('input')) return;
  const input = el('input', {
    type: 'number', class: 'col-num', min: String(AVG_MIN), max: String(AVG_MAX),
    step: '1', value: String(n), 'aria-label': t('Average of how many solves'),
    title: t('Any average from {a} to {b}', { a: AVG_MIN, b: AVG_MAX }),
  });
  const previous = [...host.childNodes];
  let done = false;
  const cancel = () => {
    if (done) return;
    done = true;
    host.replaceChildren(...previous);
  };
  const commit = () => {
    if (done) return;
    const value = Number(input.value);
    if (!Number.isInteger(value) || value < AVG_MIN || value > AVG_MAX) {
      toast(t('An average is between {a} and {b} solves.', { a: AVG_MIN, b: AVG_MAX }), { kind: 'warn' });
      cancel();
      return;
    }
    if (value !== n && getValues().includes(value)) {
      toast(t('ao{n} is already one of the columns.', { n: value }), { kind: 'warn' });
      cancel();
      return;
    }
    if (value === n) { cancel(); return; }
    done = true;
    host.replaceChildren(...previous);
    onCommit(value);
  };
  input.addEventListener('keydown', event => {
    event.stopPropagation();
    if (event.key === 'Enter') { event.preventDefault(); commit(); }
    else if (event.key === 'Escape') { event.preventDefault(); cancel(); }
  });
  input.addEventListener('click', event => event.stopPropagation());
  input.addEventListener('blur', commit);
  host.replaceChildren(input);
  input.focus();
  input.select();
}
