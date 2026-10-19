// Message inspector: view modes, history and held messages, search, copy,
// save, maximize, and stability of scroll/expansion across live updates.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  test,
  expect,
  row,
  rowByPath,
  waitForTopic,
  viewerBody,
  viewerTab,
  viewerButton,
  historyItems,
  clipboard,
  mockDialogs,
  dialogCalls,
  tempDir,
  toast,
  selectTopic,
} from './fixtures.mjs';

const JSON_V1 = { name: 'robot', pose: { x: 1.5, y: -2, tags: ['a', 'b'] }, ok: true, n: null };
const JSON_V2 = { name: 'robot', pose: { x: 2.5, y: -2, tags: ['a', 'b', 'c'] }, ok: true };
const RAW = '{"a":1,   "b":[1,2]}';
const BIN = Buffer.from([0x00, 0x01, 0xff, 0x41, 0x7f]);

const line = (page, jsonPath) => viewerBody(page).locator(`.jt-line[title="${jsonPath}"]`);
const liveBtn = (page) => page.locator('#viewer-host .btn.live');
const meta = (page) => page.locator('#viewer-host .viewer-meta');

async function openTopic(page, topic) {
  await (await rowByPath(page, topic)).click();
  await expect(page.locator('#viewer-host .viewer-topic')).toHaveText(topic);
}

test('inspector views: JSON tree, text, raw, hex, diff, chart', async ({ env }) => {
  const broker = await env.broker();
  await broker.publish('dev/json', JSON.stringify(JSON_V1), { retain: true });
  await broker.publish('dev/raw', RAW, { retain: true });
  await broker.publish('dev/bin', BIN, { retain: true });
  await broker.publish('dev/num', '1', { retain: true });
  const { page, errors } = await env.connected(broker);
  await waitForTopic(page, 'dev/num');

  // Nothing selected yet.
  await expect(page.locator('#viewer-host .viewer-topic')).toHaveText('No topic selected');

  // A branch without its own message lists the values below it.
  await row(page, 'dev').click();
  await expect(viewerBody(page).locator('.branch-row')).toHaveCount(4);
  await expect(viewerBody(page).locator('.branch-row', { hasText: 'num' }).locator('.branch-value')).toHaveText('1');
  await viewerBody(page).locator('.branch-row', { hasText: 'json' }).click();
  await expect(page.locator('#viewer-host .viewer-topic')).toHaveText('dev/json');

  // Tree view (default): nested data, all expanded for small messages.
  await expect(viewerTab(page, 'tree')).toHaveClass(/active/);
  await expect(meta(page)).toContainText('JSON');
  await expect(meta(page)).toContainText('RETAINED');
  const jt = viewerBody(page).locator('.jt');
  await expect(jt.locator('.jt-key')).toHaveText(['"name"', '"pose"', '"x"', '"y"', '"tags"', '"ok"', '"n"']);
  await expect(line(page, '$.pose.x').locator('.tk-num')).toHaveText('1.5');
  await expect(line(page, '$.pose.tags[1]').locator('.tk-str')).toHaveText('"b"');
  await expect(line(page, '$.ok').locator('.tk-bool')).toHaveText('true');
  await expect(line(page, '$.n').locator('.tk-null')).toHaveText('null');

  // Click a container line to collapse / expand it.
  await line(page, '$.pose').click();
  await expect(line(page, '$.pose.x')).toHaveCount(0);
  await expect(line(page, '$.pose').locator('.jt-summary')).toHaveText(' { 3 keys } },');
  await expect(line(page, '$.pose').locator('.jt-caret')).toHaveText('▸');
  await line(page, '$.pose').click();
  await expect(line(page, '$.pose.x')).toBeVisible();
  await expect(line(page, '$.pose').locator('.jt-caret')).toHaveText('▾');

  // Collapse / Expand all.
  await viewerButton(page, 'Collapse').click();
  await expect(line(page, '$.pose.x')).toHaveCount(0);
  await expect(line(page, '$.name')).toBeVisible();
  await viewerButton(page, 'Expand all').click();
  await expect(line(page, '$.pose.tags[0]')).toBeVisible();

  // Text view: pretty-printed, highlighted, with line numbers.
  await viewerTab(page, 'text').click();
  const pretty = JSON.stringify(JSON_V1, null, 2);
  await expect(viewerBody(page).locator('.code .src')).toHaveText(pretty);
  const lines = pretty.split('\n').length;
  await expect(viewerBody(page).locator('.code .gutter')).toHaveText(Array.from({ length: lines }, (_, i) => i + 1).join('\n'));
  await expect(viewerBody(page).locator('.src .tk-key')).toHaveCount(7);
  await expect(viewerBody(page).locator('.src .tk-num').first()).toHaveText('1.5');
  await expect(viewerBody(page).locator('.src .tk-bool')).toHaveText('true');
  // Wrap hides the gutter.
  await viewerButton(page, 'Wrap').click();
  await expect(viewerBody(page).locator('.code .gutter')).toHaveCount(0);
  await viewerButton(page, 'Wrap').click();
  await expect(viewerBody(page).locator('.code .gutter')).toHaveCount(1);

  // Raw view shows the original text, unformatted and unhighlighted.
  await viewerTab(page, 'raw').click();
  await openTopic(page, 'dev/raw');
  await expect(viewerBody(page).locator('.code .src')).toHaveText(RAW);
  await expect(viewerBody(page).locator('.code .src span')).toHaveCount(0);
  await expect(viewerBody(page).locator('.code .gutter')).toHaveText('1');

  // Hex view of a binary payload; other text views fall back to hex.
  await openTopic(page, 'dev/bin');
  await expect(meta(page)).toContainText('BINARY');
  await expect(viewerBody(page)).toContainText('Binary payload — shown as hex');
  await viewerTab(page, 'hex').click();
  await expect(viewerBody(page).locator('pre.code-plain')).toHaveText(/^00000000 {2}00 01 ff 41 7f\s+\.\.\.A\.$/);

  // Diff: structural changes between the previous and the current message.
  await openTopic(page, 'dev/json');
  await viewerTab(page, 'diff').click();
  await expect(viewerBody(page)).toContainText('No earlier message in history to compare with');
  await broker.publish('dev/json', JSON.stringify(JSON_V2));
  await expect(viewerBody(page).locator('.diff-head')).toContainText('3 changes');
  const diffRows = viewerBody(page).locator('.diff-row');
  await expect(diffRows).toHaveCount(3);
  await expect(viewerBody(page).locator('.diff-row.changed .diff-path')).toHaveText('$.pose.x');
  await expect(viewerBody(page).locator('.diff-row.changed .diff-from')).toHaveText('1.5');
  await expect(viewerBody(page).locator('.diff-row.changed .diff-to')).toHaveText('2.5');
  await expect(viewerBody(page).locator('.diff-row.added .diff-path')).toHaveText('$.pose.tags[2]');
  await expect(viewerBody(page).locator('.diff-row.added .diff-to')).toHaveText('"c"');
  await expect(viewerBody(page).locator('.diff-row.removed .diff-path')).toHaveText('$.n');

  // The Tree view marks what changed.
  await viewerTab(page, 'tree').click();
  await expect(line(page, '$.pose.x')).toHaveClass(/jt-changed/);
  await expect(line(page, '$.name')).not.toHaveClass(/jt-changed/);

  // Chart of a numeric topic.
  for (const v of ['2', '3', '5']) await broker.publish('dev/num', v);
  await openTopic(page, 'dev/num');
  await expect(meta(page)).toContainText('#4 of 4 kept');
  await viewerTab(page, 'chart').click();
  await expect(viewerBody(page).locator('.chart-title')).toHaveText('payload · 4 points in kept history');
  await expect(viewerBody(page).locator('canvas.chart')).toBeVisible();
  expect(errors).toEqual([]);
});

test('inspector history: grows, holds an older message, Live returns to the latest', async ({ env }) => {
  const broker = await env.broker();
  await broker.publish('h/val', 'v1', { retain: true });
  const { page, errors } = await env.connected(broker);
  await waitForTopic(page, 'h/val');
  await openTopic(page, 'h/val');
  await viewerTab(page, 'raw').click();

  await expect(historyItems(page)).toHaveCount(1);
  await expect(page.locator('#viewer-host .history-head')).toHaveText('History (1)');
  await broker.publish('h/val', 'v2');
  await broker.publish('h/val', 'v3');
  await expect(historyItems(page)).toHaveCount(3);
  await expect(page.locator('#viewer-host .history-head')).toHaveText('History (3)');
  // Newest first; the shown message is marked.
  await expect(historyItems(page).locator('.history-preview')).toHaveText(['v3', 'v2', 'v1']);
  await expect(historyItems(page).first()).toHaveClass(/active/);
  await expect(liveBtn(page)).toHaveText('● Live');
  await expect(viewerBody(page).locator('.src')).toHaveText('v3');

  // Pick the oldest: the view holds it.
  await historyItems(page).nth(2).click();
  await expect(liveBtn(page)).toHaveText('❚❚ Held');
  await expect(viewerBody(page).locator('.src')).toHaveText('v1');
  await expect(meta(page)).toContainText('#1 of 3 kept');
  await expect(historyItems(page).nth(2)).toHaveClass(/active/);

  // New messages extend the history but do not replace the held view. (The
  // list holds still while the pointer is over it, and says so.)
  await broker.publish('h/val', 'v4');
  await expect(page.locator('#viewer-host .history-head')).toHaveText('History (4) · paused while pointing');
  await page.mouse.move(5, 5);
  await expect(historyItems(page)).toHaveCount(4);
  await expect(meta(page)).toContainText('#1 of 4 kept');
  await expect(viewerBody(page).locator('.src')).toHaveText('v1');
  await expect(liveBtn(page)).toHaveText('❚❚ Held');

  // Live follows the latest again.
  await liveBtn(page).click();
  await expect(liveBtn(page)).toHaveText('● Live');
  await expect(viewerBody(page).locator('.src')).toHaveText('v4');
  await broker.publish('h/val', 'v5');
  await expect(viewerBody(page).locator('.src')).toHaveText('v5');

  // The Live button can also hold the current message.
  await liveBtn(page).click();
  await expect(liveBtn(page)).toHaveText('❚❚ Held');
  await broker.publish('h/val', 'v6');
  await expect(historyItems(page)).toHaveCount(6);
  await expect(viewerBody(page).locator('.src')).toHaveText('v5');
  // Clicking the newest history item goes live again.
  await historyItems(page).first().click();
  await expect(liveBtn(page)).toHaveText('● Live');
  await expect(viewerBody(page).locator('.src')).toHaveText('v6');
  expect(errors).toEqual([]);
});

test('inspector search: matching branches in Tree, marks in Text, Enter/Shift+Enter cycle', async ({ env }) => {
  const broker = await env.broker();
  const doc = {
    robots: [
      { id: 1, temp: 20, status: 'ok' },
      { id: 2, temp: 21, status: 'hot' },
    ],
    site: { temperatureUnit: 'C', name: 'lab' },
  };
  await broker.publish('s/doc', JSON.stringify(doc), { retain: true });
  const { page, errors } = await env.connected(broker);
  await waitForTopic(page, 's/doc');
  await openTopic(page, 's/doc');

  const search = page.locator('#viewer-host input.search');
  const hitCount = page.locator('#viewer-host .hit-count');
  await search.fill('temp');
  await expect(hitCount).toHaveText('1/3');
  // The note explaining the filtered view and its match count. Soft: a
  // failure is a reported bug, the rest of the test still runs.
  await expect.soft(viewerBody(page).locator('.search-note'), 'search note with match count').toContainText('(3 matches)', { timeout: 2000 });
  // Only matching branches are shown.
  await expect(line(page, '$.robots[0].temp')).toBeVisible();
  await expect(line(page, '$.robots[1].temp')).toBeVisible();
  await expect(line(page, '$.site.temperatureUnit')).toBeVisible();
  await expect(line(page, '$.robots[0].status')).toHaveCount(0);
  await expect(line(page, '$.site.name')).toHaveCount(0);
  await expect(viewerBody(page).locator('mark.hit')).toHaveCount(3);
  await expect(viewerBody(page).locator('mark.hit.current')).toHaveCount(1);
  const currentPath = () => viewerBody(page).locator('mark.hit.current').evaluate((m) => m.closest('.jt-line').title);
  expect(await currentPath()).toBe('$.robots[0].temp');

  await search.press('Enter');
  await expect(hitCount).toHaveText('2/3');
  expect(await currentPath()).toBe('$.robots[1].temp');
  await search.press('Enter');
  await expect(hitCount).toHaveText('3/3');
  expect(await currentPath()).toBe('$.site.temperatureUnit');
  await search.press('Enter');
  await expect(hitCount).toHaveText('1/3');
  await search.press('Shift+Enter');
  await expect(hitCount).toHaveText('3/3');
  await page.locator('#viewer-host .search-box').getByRole('button', { name: '↑' }).click();
  await expect(hitCount).toHaveText('2/3');

  // No match.
  await search.fill('zzz-nothing');
  await expect(viewerBody(page)).toContainText('No keys or values contain “zzz-nothing”');
  // Soft (reported bug): the query echoed in the "no match" note must not count as a hit.
  await expect.soft(hitCount, 'hit counter with no matches').toHaveText('0/0', { timeout: 2000 });
  await expect.soft(viewerBody(page).locator('mark.hit'), 'no highlighted hits without matches').toHaveCount(0, { timeout: 1000 });

  // Escape clears the search and shows everything again.
  await search.press('Escape');
  await expect(search).toHaveValue('');
  await expect(hitCount).toHaveText('');
  await expect(line(page, '$.site.name')).toBeVisible();

  // Text mode marks matches in the highlighted source.
  await viewerTab(page, 'text').click();
  await search.fill('hot');
  await expect(viewerBody(page).locator('.src mark.hit')).toHaveText(['hot']);
  await expect(hitCount).toHaveText('1/1');
  await search.fill('"id"');
  await expect(viewerBody(page).locator('.src mark.hit')).toHaveCount(2);
  await expect(hitCount).toHaveText('1/2');
  await search.press('Enter');
  await expect(hitCount).toHaveText('2/2');

  // Ctrl+F inside the inspector focuses its search box.
  await search.press('Escape');
  await viewerBody(page).click();
  await page.keyboard.press('Control+f');
  await expect(search).toBeFocused();
  expect(errors).toEqual([]);
});

test('inspector actions: copy topic/payload, save payload, maximize via button, F11 and Escape', async ({ env }) => {
  const broker = await env.broker();
  const payload = JSON.stringify(JSON_V1);
  await broker.publish('act/json', payload, { retain: true });
  await broker.publish('act/bin', BIN, { retain: true });
  const { app, page, errors } = await env.connected(broker);
  await waitForTopic(page, 'act/bin');
  await openTopic(page, 'act/json');

  // Copy topic / payload.
  await page.locator('#viewer-host').getByRole('button', { name: '⧉' }).click();
  await expect(toast(page).filter({ hasText: 'Topic copied' })).toBeVisible();
  await expect.poll(() => clipboard(app)).toBe('act/json');
  await viewerButton(page, 'Copy').click();
  await expect.poll(() => clipboard(app)).toBe(payload);

  // Save payload: exact bytes, file name derived from the topic.
  const dir = tempDir();
  const out = path.join(dir, 'saved.json');
  await mockDialogs(app, { saveFile: out });
  await viewerButton(page, 'Save').click();
  await expect(toast(page).filter({ hasText: `Saved ${out}` })).toBeVisible();
  expect(readFileSync(out, 'utf8')).toBe(payload);

  await openTopic(page, 'act/bin');
  const outBin = path.join(dir, 'saved.bin');
  await mockDialogs(app, { saveFile: outBin });
  await viewerButton(page, 'Save').click();
  await expect.poll(() => dialogCalls(app)).toContainEqual({ kind: 'save', defaultPath: 'act_bin.bin' });
  await expect(toast(page).filter({ hasText: `Saved ${outBin}` })).toBeVisible();
  expect(readFileSync(outBin).equals(BIN)).toBe(true);
  // Copying a binary payload copies its hex dump.
  await viewerButton(page, 'Copy').click();
  await expect.poll(() => clipboard(app)).toMatch(/^00000000 {2}00 01 ff 41 7f/);

  // Maximize with the button.
  const layout = page.locator('#layout');
  await viewerButton(page, 'Maximize').click();
  await expect(layout).toHaveClass(/max-viewer/);
  await expect(page.locator('.tree-pane')).toBeHidden();
  await expect(page.locator('#publisher-host')).toBeHidden();
  await expect(viewerButton(page, 'Restore')).toBeVisible();
  await viewerButton(page, 'Restore').click();
  await expect(layout).not.toHaveClass(/max-viewer/);
  await expect(page.locator('.tree-pane')).toBeVisible();

  // F11 toggles, Escape restores.
  await viewerBody(page).click();
  await page.keyboard.press('F11');
  await expect(layout).toHaveClass(/max-viewer/);
  await expect(viewerButton(page, 'Restore')).toBeVisible();
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen())).toBe(false);
  await page.keyboard.press('Escape');
  await expect(layout).not.toHaveClass(/max-viewer/);
  await expect(viewerButton(page, 'Maximize')).toBeVisible();
  // Maximizing from the Plots tab switches back to the inspector.
  await page.locator('.right-tabs .tab[data-tab="plots"]').click();
  await expect(page.locator('#viewer-host')).toBeHidden();
  await page.keyboard.press('F11');
  await expect(page.locator('#viewer-host')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(layout).not.toHaveClass(/max-viewer/);
  expect(errors).toEqual([]);
});

test('inspector keeps scroll position and JSON expansion across live updates', async ({ env }) => {
  const broker = await env.broker();
  const make = (rev) => ({
    meta: { rev, source: 'test' },
    items: Array.from({ length: 200 }, (_, i) => ({ id: i, name: `item-${i}`, value: i * rev })),
  });
  await broker.publish('big/list', JSON.stringify(make(1)), { retain: true });
  const { page, errors } = await env.connected(broker);
  await waitForTopic(page, 'big/list');
  await openTopic(page, 'big/list');

  // Large message: only the first level is open by default.
  await expect(line(page, '$.items[199]')).toBeVisible();
  await expect(line(page, '$.items[5].name')).toHaveCount(0);

  // Expand one item, collapse "meta".
  await line(page, '$.items[5]').click();
  await expect(line(page, '$.items[5].name')).toBeVisible();
  await line(page, '$.meta').click();
  await expect(line(page, '$.meta.rev')).toHaveCount(0);

  // Scroll down the body.
  const body = viewerBody(page);
  await body.evaluate((b) => (b.scrollTop = 2000));
  const before = await body.evaluate((b) => b.scrollTop);
  expect(before).toBeGreaterThan(1000);

  await broker.publish('big/list', JSON.stringify(make(2)));
  await expect(meta(page)).toContainText('#2 of 2 kept');
  await expect(line(page, '$.items[199].value')).toHaveCount(0);
  await expect.poll(() => viewerBody(page).locator('.jt-line[title="$.items[5].value"] .tk-num').textContent()).toBe('10');
  expect(await body.evaluate((b) => b.scrollTop)).toBe(before);
  await expect(line(page, '$.items[5].name')).toBeVisible();
  await expect(line(page, '$.meta.rev')).toHaveCount(0);
  await expect(line(page, '$.meta').locator('.jt-summary')).toBeVisible();

  // And once more, after expanding meta again.
  await body.evaluate((b) => (b.scrollTop = 0));
  await line(page, '$.meta').click();
  await expect(line(page, '$.meta.rev')).toBeVisible();
  await body.evaluate((b) => (b.scrollTop = 900));
  const before2 = await body.evaluate((b) => b.scrollTop);
  await broker.publish('big/list', JSON.stringify(make(3)));
  await expect(meta(page)).toContainText('#3 of 3 kept');
  await expect(line(page, '$.meta.rev').locator('.tk-num')).toHaveText('3');
  expect(await body.evaluate((b) => b.scrollTop)).toBe(before2);
  await expect(line(page, '$.items[5].name')).toBeVisible();

  // Text view keeps its scroll position too.
  await viewerTab(page, 'text').click();
  await body.evaluate((b) => (b.scrollTop = 3000));
  const before3 = await body.evaluate((b) => b.scrollTop);
  await broker.publish('big/list', JSON.stringify(make(4)));
  await expect(meta(page)).toContainText('#4 of 4 kept');
  await expect(body.locator('.src')).toContainText('"rev": 4');
  expect(await body.evaluate((b) => b.scrollTop)).toBe(before3);
  expect(errors).toEqual([]);
});

test('selectTopic helper and tree selection agree', async ({ env }) => {
  // Guards the shortcut used by other specs: selecting via the helper must be
  // equivalent to clicking the row.
  const broker = await env.broker();
  await broker.publish('x/y/z', '42', { retain: true });
  const { page, errors } = await env.connected(broker);
  await selectTopic(page, 'x/y/z');
  await expect(page.locator('#viewer-host .viewer-topic')).toHaveText('x/y/z');
  await expect(page.locator('#tree-scroll .tree-row.selected .name')).toHaveText('z');
  await expect(page.locator('#publisher-host .topic-input')).toHaveValue('x/y/z');
  expect(errors).toEqual([]);
});
