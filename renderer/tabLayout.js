// How the tab strip spends its width (pure; tabStrip.js measures and applies).
// Widths are in px: `available` is what the strip may use in all, `tabs` the
// tabs' natural widths.

export const MIN_TAB = 100;

// Order of giving way: the brand shrinks to its icon first, then the tabs
// share what is left (the short ones keep their width, the long ones get an
// equal share), then, below MIN_TAB each, the strip scrolls.
export function stripLayout({ available, brandFull, brandIcon, plus, tabs }) {
  const total = tabs.reduce((a, b) => a + b, 0);
  if (total + brandFull + plus <= available) return { brand: 'full', maxTab: null, scroll: false };
  if (total + brandIcon + plus <= available) return { brand: 'icon', maxTab: null, scroll: false };
  if (!tabs.length) return { brand: 'icon', maxTab: null, scroll: false };
  let room =available - brandIcon - plus;
  const sorted = [...tabs].sort((a, b) => a - b);
  let share = room / sorted.length;
  for (let i = 0; i < sorted.length; i++) {
    share = room / (sorted.length - i);
    if (sorted[i] > share) break;
    room -= sorted[i];
  }
  return share >= MIN_TAB ? { brand: 'icon', maxTab: share, scroll: false } : { brand: 'icon', maxTab: MIN_TAB, scroll: true };
}
