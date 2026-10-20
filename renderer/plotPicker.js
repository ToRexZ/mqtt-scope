// "Add data to plot" dialog: a scrollable topic list, the structure of the
// selected topic's latest message with a checkbox per plottable value, and
// the selection with optional aliases.

import { el, button, overlayHost } from './ui.js';
import { preview, topicMatches } from './payload.js';
import { messageFields, visibleFields, hasNumbers } from './fields.js';
import { sourceLabel } from './plotView.js';
import { seriesKey } from './plotMath.js';

const MAX_TOPIC_ROWS = 2000;
const MAX_FIELD_ROWS = 3000;
const COLLAPSE_ARRAYS_OVER = 10; // longer arrays start collapsed

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function formatLeaf(r) {
  if (r.kind === 'string') return JSON.stringify(r.value).slice(0, 80);
  return String(r.value);
}

// opts: topics() -> iterable of topic nodes ({ path, message }), plots: [{ id, title, series }],
// targetPlotId, initialTopic, maxSeries.
// Resolves to { plotId (null = new plot), items: [{ topic, segs, alias }] } or null.
export function openPlotPicker(opts) {
  return new Promise((resolve) => {
    const nodes = [...opts.topics()].filter((n) => n.message).sort((a, b) => collator.compare(a.path, b.path));
    const selection = new Map(); // seriesKey -> { topic, segs, alias }
    const collapsedByTopic = new Map(); // topic -> Set of collapsed container paths
    let current = nodes.find((n) => n.path === opts.initialTopic) || null;

    const overlay = el('div', 'modal-overlay');
    const box = el('div', 'modal picker');
    overlay.append(box);

    // ---- header
    const head = el('div', 'picker-head');
    const target = el('select', 'select');
    target.append(Object.assign(el('option', '', 'New plot'), { value: '' }));
    for (const p of opts.plots) target.append(Object.assign(el('option', '', `Plot “${p.title}”`), { value: p.id }));
    target.value = opts.targetPlotId || '';
    head.append(el('h3', '', 'Add data to plot'), el('span', 'spacer'), el('span', 'field-label', 'Add to'), target);

    // ---- topic column
    const topicSearch = Object.assign(el('input', 'input picker-topic-search'), { placeholder: 'Filter topics (supports + and #)', spellcheck: false });
    const numbersBox = Object.assign(el('input'), { type: 'checkbox', checked: true });
    const topicList = el('div', 'picker-list picker-topics');
    const topicFoot = el('div', 'picker-foot');
    const topicCol = el('div', 'picker-col');
    const topicTools = el('div', 'picker-tools');
    const numbersLabel = el('label', 'check small');
    numbersLabel.append(numbersBox, document.createTextNode(' With numbers'));
    topicTools.append(topicSearch, numbersLabel);
    topicCol.append(el('div', 'picker-col-title', 'Topics'), topicTools, topicList, topicFoot);

    // ---- field column
    const fieldSearch = Object.assign(el('input', 'input picker-field-search'), { placeholder: 'Filter fields', spellcheck: false });
    const onlyNumbersBox = Object.assign(el('input'), { type: 'checkbox', checked: true });
    const fieldList = el('div', 'picker-list picker-fields');
    const fieldFoot = el('div', 'picker-foot');
    const fieldTitle = el('div', 'picker-col-title', 'Fields');
    const fieldCol = el('div', 'picker-col');
    const fieldTools = el('div', 'picker-tools');
    const onlyLabel = el('label', 'check small');
    onlyLabel.append(onlyNumbersBox, document.createTextNode(' Numbers only'));
    fieldTools.append(fieldSearch, onlyLabel);
    fieldCol.append(fieldTitle, fieldTools, fieldList, fieldFoot);

    const body = el('div', 'picker-body');
    body.append(topicCol, fieldCol);

    // ---- selection and actions
    const selTitle = el('div', 'picker-col-title');
    const selList = el('div', 'picker-selected');
    const note = el('span', 'picker-note');
    const addBtn = Object.assign(el('button', 'btn primary picker-add'), { type: 'button' });
    const actions = el('div', 'modal-actions');
    actions.append(note, el('span', 'spacer'), button('Cancel', 'Close without adding', () => done(null)), addBtn);
    box.append(head, body, selTitle, selList, actions);

    const done = (result) => {
      overlay.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(result);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        done(null);
      }
    };
    document.addEventListener('keydown', onKey, true);
    overlay.addEventListener('mousedown', (e) => e.target === overlay && done(null));

    // ---- rendering
    const renderTopics = () => {
      const q = topicSearch.value.trim();
      const wild = /[+#]/.test(q);
      const lower = q.toLowerCase();
      const scroll = topicList.scrollTop;
      const matches = nodes.filter(
        (n) =>
          (!q || (wild ? topicMatches(q, n.path) : n.path.toLowerCase().includes(lower))) &&
          (!numbersBox.checked || hasNumbers(n.message)),
      );
      topicList.textContent = '';
      for (const n of matches.slice(0, MAX_TOPIC_ROWS)) {
        const row = el('div', 'picker-topic' + (n === current ? ' active' : ''));
        const picked = [...selection.values()].filter((s) => s.topic === n.path).length;
        row.append(el('div', 'picker-topic-path', n.path), el('div', 'picker-topic-value', preview(n.message, 120)));
        if (picked) row.append(el('span', 'picker-count', String(picked)));
        row.title = n.path;
        row.addEventListener('click', () => {
          current = n;
          renderTopics();
          renderFields();
        });
        topicList.append(row);
      }
      topicFoot.textContent =
        matches.length > MAX_TOPIC_ROWS
          ? `Showing ${MAX_TOPIC_ROWS} of ${matches.length} topics — refine the filter`
          : `${matches.length} of ${nodes.length} topics`;
      if (!matches.length) topicList.append(el('div', 'placeholder small', nodes.length ? 'No matching topics' : 'No messages received yet'));
      topicList.scrollTop = scroll;
    };

    let fieldsFor = null;
    const renderFields = () => {
      // Keep the scroll position while ticking boxes; start at the top for a new topic.
      const scroll = fieldsFor === current ? fieldList.scrollTop : 0;
      fieldsFor = current;
      fieldList.textContent = '';
      if (!current) {
        fieldTitle.textContent = 'Fields';
        fieldList.append(el('div', 'placeholder small', 'Pick a topic on the left to see the values in its latest message.'));
        fieldFoot.textContent = '';
        return;
      }
      fieldTitle.textContent = `Fields of ${current.path}`;
      const { rows, truncated } = messageFields(current.message);
      if (!collapsedByTopic.has(current.path)) {
        collapsedByTopic.set(current.path, new Set(rows.filter((r) => r.kind === 'array' && r.size > COLLAPSE_ARRAYS_OVER).map((r) => r.path)));
      }
      const collapsed = collapsedByTopic.get(current.path);
      // A filter shows matches inside collapsed arrays too.
      const shown = visibleFields(rows, {
        query: fieldSearch.value,
        numbersOnly: onlyNumbersBox.checked,
        collapsed: fieldSearch.value.trim() ? new Set() : collapsed,
      });
      for (const r of shown.slice(0, MAX_FIELD_ROWS)) {
        const row = el('div', `picker-field depth-${Math.min(r.depth, 12)}`);
        row.style.paddingLeft = `${8 + r.depth * 16}px`;
        row.title = r.path;
        if (r.kind === 'object' || r.kind === 'array') {
          row.classList.add('container');
          const isClosed = collapsed.has(r.path) && !fieldSearch.value.trim();
          row.append(
            el('span', 'jt-caret', isClosed ? '▸' : '▾'),
            el('span', 'picker-key', String(r.key)),
            el('span', 'picker-meta', r.kind === 'array' ? `[ ${r.size} ]` : `{ ${r.size} }`),
          );
          row.addEventListener('click', () => {
            if (collapsed.has(r.path)) collapsed.delete(r.path);
            else collapsed.add(r.path);
            renderFields();
          });
        } else {
          const key = seriesKey(current.path, r.segs);
          const check = Object.assign(el('input'), { type: 'checkbox', checked: selection.has(key), disabled: !r.plottable });
          row.classList.toggle('disabled', !r.plottable);
          row.append(check, el('span', 'picker-key', String(r.key)), el('span', `picker-value tk-${r.kind === 'string' ? 'str' : r.kind === 'boolean' ? 'bool' : r.kind === 'null' ? 'null' : 'num'}`, formatLeaf(r)));
          if (r.plottable) {
            row.addEventListener('click', (e) => {
              if (e.target !== check) check.checked = !check.checked;
              if (check.checked) selection.set(key, { topic: current.path, segs: r.segs, alias: '' });
              else selection.delete(key);
              renderSelection();
              renderTopics();
            });
          }
        }
        fieldList.append(row);
      }
      if (!shown.length) fieldList.append(el('div', 'placeholder small', onlyNumbersBox.checked ? 'No numeric values in this message' : 'No matching fields'));
      fieldList.scrollTop = scroll;
      fieldFoot.textContent = `${current.message.payload.length.toLocaleString()} bytes · latest message${truncated ? ' · large message: first fields only' : ''}${shown.length > MAX_FIELD_ROWS ? ` · showing ${MAX_FIELD_ROWS} of ${shown.length} rows` : ''}`;
    };

    const capacity = () => {
      const plot = opts.plots.find((p) => p.id === target.value);
      return opts.maxSeries - (plot ? plot.series.length : 0);
    };

    const renderSelection = () => {
      selTitle.textContent = selection.size ? `Selected (${selection.size}) — optional alias shown in the legend` : 'Selected';
      selList.textContent = '';
      if (!selection.size) selList.append(el('div', 'placeholder small', 'Tick values in the field list. You can pick from several topics.'));
      for (const [key, item] of selection) {
        const row = el('div', 'picker-sel');
        const alias = Object.assign(el('input', 'input picker-alias'), { placeholder: 'Alias (optional)', value: item.alias, spellcheck: false });
        alias.addEventListener('input', () => (item.alias = alias.value));
        row.append(
          el('span', 'picker-sel-source', sourceLabel(item.topic, item.segs)),
          alias,
          button('×', 'Remove from selection', () => {
            selection.delete(key);
            renderSelection();
            renderFields();
            renderTopics();
          }, 'chip-x'),
        );
        selList.append(row);
      }
      const room = capacity();
      const existing = opts.plots.find((p) => p.id === target.value);
      const dupes = existing ? [...selection.keys()].filter((k) => existing.series.some((s) => seriesKey(s.topic, s.segs) === k)).length : 0;
      addBtn.textContent = selection.size ? `Add ${selection.size} series` : 'Add';
      addBtn.disabled = !selection.size || selection.size - dupes > room;
      note.textContent =
        selection.size - dupes > room
          ? `This plot has room for ${Math.max(0, room)} more series (max ${opts.maxSeries}). Pick fewer or add to a new plot.`
          : dupes
            ? `${dupes} already in this plot (skipped)`
            : '';
    };

    addBtn.addEventListener('click', () => {
      if (addBtn.disabled) return;
      done({
        plotId: target.value || null,
        items: [...selection.values()].map((s) => ({ topic: s.topic, segs: s.segs, alias: s.alias.trim() })),
      });
    });
    target.addEventListener('change', renderSelection);
    let tTimer;
    topicSearch.addEventListener('input', () => {
      clearTimeout(tTimer);
      tTimer = setTimeout(renderTopics, 120);
    });
    topicSearch.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') topicList.querySelector('.picker-topic')?.click();
    });
    numbersBox.addEventListener('change', renderTopics);
    let fTimer;
    fieldSearch.addEventListener('input', () => {
      clearTimeout(fTimer);
      fTimer = setTimeout(renderFields, 120);
    });
    onlyNumbersBox.addEventListener('change', renderFields);

    overlayHost().append(overlay);
    renderTopics();
    renderFields();
    renderSelection();
    topicList.querySelector('.picker-topic.active')?.scrollIntoView({ block: 'center' });
    topicSearch.focus();
  });
}
