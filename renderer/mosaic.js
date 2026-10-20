// Split layout on screen (like Lichtblick's panels): renders a layout tree
// (see plotLayouts.js) so it fills its container, lets the gaps between
// neighbours be dragged to resize them, and lets a leaf be dragged by its
// handle onto another leaf (an edge splits it, the middle swaps) or onto an
// outside target such as a tab. Esc cancels a move.
//
//   const root = renderMosaic(layout, {
//     leaf: (id) => element,         // its inline min-width/min-height are its minimum size
//     dragHandle: '.plot-head',      // where in a leaf a move starts…
//     noDrag: 'button, select',      // …except over these
//     label: (id) => 'Title',        // shown under the mouse while moving
//     externalTarget: (element) => ({ element, ...anything }) | null,
//     onResize: (split, sizes) => {},  // a gap was dragged: new sizes for that split
//     onMove: (id, target) => {},    // { type: 'leaf', id, edge } or an external target
//   });

import { el } from './ui.js';
import { normalizeWeights, resizeWeights } from './plotLayouts.js';

const GAP = 6; // px between neighbours (see .mosaic-handle)
const START_MOVE = 6; // px the mouse must travel before a press becomes a move

export function renderMosaic(layout, opts) {
  const root = renderNode(layout, opts);
  root.classList.add('mosaic-root');
  return root;
}

function renderNode(node, opts) {
  if (typeof node === 'string') {
    // Leaves carry no padding or border, so flex sizes them exactly in
    // proportion to their weights.
    const leaf = el('div', 'mosaic-leaf');
    leaf.dataset.leafId = node;
    const content = opts.leaf(node);
    leaf.style.minWidth = content.style.minWidth;
    leaf.style.minHeight = content.style.minHeight;
    leaf.append(content);
    // Listened for on the leaf, so a card drawn again inside it still moves.
    if (opts.dragHandle) leaf.addEventListener('mousedown', (e) => e.target.closest(opts.dragHandle) && startMove(e, node, leaf, opts));
    return leaf;
  }
  const box = el('div', `mosaic-split ${node.dir}`);
  node.children.forEach((child, i) => {
    if (i > 0) {
      const gap = el('div', `mosaic-handle ${node.dir}`);
      gap.title = 'Drag to resize, double-click to make equal';
      gap.addEventListener('mousedown', (e) => startResize(e, node, box, i - 1, opts));
      gap.addEventListener('dblclick', () => {
        const equal = node.children.map(() => 1);
        applySizes(box, equal);
        opts.onResize?.(node, equal);
      });
      box.append(gap);
    }
    box.append(renderNode(child, opts));
  });
  applySizes(box, node.sizes);
  return box;
}

const items = (box) => [...box.children].filter((c) => !c.classList.contains('mosaic-handle'));

function applySizes(box, sizes) {
  items(box).forEach((c, i) => (c.style.flex = `${sizes[i]} 1 0px`));
}

// Smallest size (px) of a layout element along a direction: a leaf's own
// minimum; for a split the sum (same direction) or the largest (across) of
// its children's.
function minSize(elem, row) {
  if (elem.classList.contains('mosaic-leaf')) return parseFloat(row ? elem.style.minWidth : elem.style.minHeight) || 0;
  const mins = items(elem).map((c) => minSize(c, row));
  return elem.classList.contains(row ? 'row' : 'col') ? mins.reduce((a, b) => a + b, 0) + (mins.length - 1) * GAP : Math.max(0, ...mins);
}

// Drags the gap after child `index` of a split.
function startResize(e, node, box, index, opts) {
  if (e.button !== 0) return;
  e.preventDefault();
  const row = node.dir === 'row';
  const kids = items(box);
  const sizes = kids.map((c) => (row ? c.getBoundingClientRect().width : c.getBoundingClientRect().height));
  const start = normalizeWeights(node.sizes, kids.length);
  const origin = row ? e.clientX : e.clientY;
  const min = [minSize(kids[index], row), minSize(kids[index + 1], row)];
  document.body.classList.add(row ? 'resizing-x' : 'resizing-y');
  let next = start;
  const move = (ev) => {
    next = resizeWeights(start, sizes, index, (row ? ev.clientX : ev.clientY) - origin, min);
    applySizes(box, next);
  };
  const up = () => {
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
    document.body.classList.remove('resizing-x', 'resizing-y');
    if (next !== start) opts.onResize?.(node, next);
  };
  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', up);
}

function startMove(e, id, leaf, opts) {
  if (e.button !== 0 || (opts.noDrag && e.target.closest(opts.noDrag))) return;
  const root = leaf.closest('.mosaic-root');
  const x0 = e.clientX;
  const y0 = e.clientY;
  let moving = false;
  let target = null;
  let ghost;
  let marker;
  let highlighted = null;
  const highlight = (elem) => {
    if (highlighted === elem) return;
    highlighted?.classList.remove('drop-target');
    elem?.classList.add('drop-target');
    highlighted = elem;
  };
  const cleanup = () => {
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
    document.removeEventListener('keydown', key, true);
    ghost?.remove();
    marker?.remove();
    highlight(null);
    leaf.classList.remove('dragging');
    document.body.classList.remove('moving-plot');
  };
  const move = (ev) => {
    if (!moving) {
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < START_MOVE) return;
      moving = true;
      leaf.classList.add('dragging');
      document.body.classList.add('moving-plot');
      ghost = el('div', 'drag-ghost', opts.label?.(id) ?? id);
      marker = el('div', 'drop-marker');
      document.body.append(ghost, marker);
      window.getSelection()?.removeAllRanges();
    }
    ghost.style.left = `${ev.clientX + 14}px`;
    ghost.style.top = `${ev.clientY + 10}px`;
    target = dropTarget(ev.clientX, ev.clientY, id, root, opts);
    highlight(target && target.type !== 'leaf' ? target.element : null);
    marker.hidden = target?.type !== 'leaf';
    if (target?.type === 'leaf') {
      const r = target.zone;
      Object.assign(marker.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
      marker.classList.toggle('center', target.edge === 'center');
    }
  };
  const up = () => {
    cleanup();
    if (moving && target) {
      const { zone, element, ...result } = target;
      opts.onMove?.(id, target.type === 'leaf' ? result : target);
    }
  };
  const key = (ev) => {
    if (ev.key !== 'Escape') return;
    ev.stopPropagation();
    target = null;
    cleanup();
  };
  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', up);
  document.addEventListener('keydown', key, true);
}

// What is under the mouse: another leaf (with the edge and the zone to
// highlight), an outside target, or null.
function dropTarget(x, y, id, root, opts) {
  const under = document.elementFromPoint(x, y);
  if (!under) return null;
  if (opts.externalTarget && !root?.contains(under)) return opts.externalTarget(under) || null;
  const leafEl = under.closest('.mosaic-leaf');
  if (!leafEl || !root?.contains(leafEl) || leafEl.dataset.leafId === id) return null;
  const r = leafEl.getBoundingClientRect();
  const fx = (x - r.left) / r.width;
  const fy = (y - r.top) / r.height;
  let edge = 'center';
  if (fx < 0.3 || fx > 0.7 || fy < 0.3 || fy > 0.7) {
    const d = { left: fx, right: 1 - fx, top: fy, bottom: 1 - fy };
    edge = Object.keys(d).reduce((a, b) => (d[b] < d[a] ? b : a));
  }
  return { type: 'leaf', id: leafEl.dataset.leafId, edge, zone: edgeZone(r, edge) };
}

// The part of a leaf that a drop on `edge` would give to the moved leaf.
function edgeZone(r, edge) {
  switch (edge) {
    case 'left':
      return { left: r.left, top: r.top, width: r.width / 2, height: r.height };
    case 'right':
      return { left: r.left + r.width / 2, top: r.top, width: r.width / 2, height: r.height };
    case 'top':
      return { left: r.left, top: r.top, width: r.width, height: r.height / 2 };
    case 'bottom':
      return { left: r.left, top: r.top + r.height / 2, width: r.width, height: r.height / 2 };
    default:
      return { left: r.left + r.width * 0.15, top: r.top + r.height * 0.15, width: r.width * 0.7, height: r.height * 0.7 };
  }
}
