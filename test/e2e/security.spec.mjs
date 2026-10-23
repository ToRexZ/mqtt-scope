// Markup in topic names, payloads, saved-message names, plot labels and
// connection names must be shown as text and never executed or injected.

import { test, expect, makeUserData, profile, connect, row, rowByPath, waitForTopic, viewerBody, viewerTab, historyItems, menu, answerPrompt, popupFrom, activeTabName } from './fixtures.mjs';

const IMG = '<img src=x onerror="window.__pwned=1">';
const SCRIPT = '<script>window.__pwned=1</script>';
const SVG = '"><svg onload=window.__pwned=1>';

// Nothing executed and no element was created from data.
async function expectClean(page, where) {
  const state = await page.evaluate(() => ({
    pwned: window.__pwned,
    imgs: document.querySelectorAll('img').length,
    // The app's own icons (icons.js) are the only SVGs allowed: a fixed shape
    // directly inside an .icon span, with no attributes beyond drawing ones.
    svgs: [...document.querySelectorAll('svg')].filter(
      (e) =>
        !e.parentElement?.matches('span.icon[aria-hidden="true"]') ||
        [...e.attributes].some((a) => !['width', 'height', 'viewBox', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin'].includes(a.name)),
    ).length,
    scripts: [...document.querySelectorAll('script')].map((s) => s.getAttribute('src')),
    handlers: [...document.querySelectorAll('*')].filter((e) => [...e.attributes].some((a) => a.name.startsWith('on'))).length,
  }));
  expect(state, where).toEqual({ pwned: undefined, imgs: 0, svgs: 0, scripts: [expect.stringMatching(/\.js$/)], handlers: 0 });
}

test('markup in topics and payloads is never executed (tree, inspector modes, history, publisher, plots, dialogs)', async ({ env }) => {
  const broker = await env.broker();
  const jsonPayload = (n) => JSON.stringify({ [IMG]: SCRIPT, list: [SVG, n], nested: { [SCRIPT]: IMG } });
  await broker.publish(`xss/${IMG}`, '42', { retain: true });
  await broker.publish(`xss/json/${SVG}`, jsonPayload(1), { retain: true });
  await broker.publish('xss/text', IMG, { retain: true });
  await broker.publish('xss/bin', Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(SCRIPT)]), { retain: true });
  await broker.publish(`xss/${SCRIPT}`, SCRIPT, { retain: true });

  const userData = makeUserData({ profiles: [profile(broker.port, { name: IMG })] });
  const { app, page, errors } = await env.launch({ userData });
  // Connection dialog with a hostile profile name.
  await expect(page.locator('.conn-dialog .conn-name')).toHaveText([IMG]);
  await connect(page);
  await expect(activeTabName(page)).toHaveText(IMG);
  await expect(page).toHaveTitle(`MQTT Scope — ${IMG}`);
  await waitForTopic(page, `xss/${SCRIPT}`);

  // Tree: names and values are text.
  await row(page, 'xss').locator('.caret').click();
  await expect(row(page, IMG)).toBeVisible();
  await expect(row(page, 'text').locator('.value')).toHaveText(IMG);
  await expect(row(page, '<script>window.__pwned=1<')).toBeVisible();
  await page.locator('#tree-filter').fill('pwned');
  await page.locator('#filter-values').check();
  await expect(row(page, 'text')).toBeVisible();
  await page.locator('#tree-filter').press('Escape');
  await page.locator('#filter-values').uncheck();
  await expectClean(page, 'tree');

  // Inspector, every mode, for every hostile topic; two messages each so Diff has content.
  await broker.publish('xss/text', SCRIPT);
  await broker.publish(`xss/json/${SVG}`, jsonPayload(2));
  await broker.publish(`xss/${IMG}`, '43');
  const topics = [`xss/${IMG}`, `xss/json/${SVG}`, 'xss/text', 'xss/bin', `xss/${SCRIPT}`];
  for (const topic of topics) {
    const r = await rowByPath(page, topic);
    await r.click();
    await expect(page.locator('#viewer-host .viewer-topic')).toHaveText(topic);
    for (const mode of ['tree', 'text', 'raw', 'hex', 'diff', 'chart']) {
      await viewerTab(page, mode).click();
      await expect(viewerBody(page)).toHaveClass(new RegExp(`mode-${mode}`));
      await expectClean(page, `${topic} in ${mode} view`);
    }
    // Search highlighting re-wraps text nodes; must stay text.
    await viewerTab(page, 'text').click();
    await page.locator('#viewer-host input.search').fill('pwned');
    await expect(page.locator('#viewer-host .hit-count')).not.toHaveText('');
    await expectClean(page, `${topic} search`);
    await page.locator('#viewer-host input.search').press('Escape');
    // History previews.
    await expect(historyItems(page).first()).toBeVisible();
    await expectClean(page, `${topic} history`);
  }
  // Text payloads are shown literally.
  await (await rowByPath(page, 'xss/text')).click();
  await viewerTab(page, 'raw').click();
  await expect(viewerBody(page).locator('.src')).toHaveText(SCRIPT);
  await expect(historyItems(page).locator('.history-preview')).toHaveText([SCRIPT, IMG]);
  await viewerTab(page, 'diff').click();
  await expect(viewerBody(page).locator('.diff-lines')).toContainText(IMG);
  await (await rowByPath(page, `xss/json/${SVG}`)).click();
  await viewerTab(page, 'tree').click();
  await expect(viewerBody(page).locator('.jt-key').first()).toHaveText(JSON.stringify(IMG));
  await viewerTab(page, 'diff').click();
  await expect(viewerBody(page).locator('.diff-row .diff-path')).toHaveText(['$.list[1]']);

  // Publisher: hostile topic, payload and saved-message name.
  await (await rowByPath(page, `xss/${SCRIPT}`)).click();
  const pub = page.locator('#publisher-host');
  await expect(pub.locator('.topic-input')).toHaveValue(`xss/${SCRIPT}`);
  await pub.locator('select').nth(1).selectOption('text');
  await pub.locator('.payload-editor').fill(IMG);
  await pub.getByRole('button', { name: 'Save…' }).click();
  await answerPrompt(page, SVG);
  await expect(pub.locator('.lib-item .lib-name')).toHaveText([SVG]);
  await expect(pub.locator('.lib-item .lib-preview')).toHaveText([IMG]);
  await pub.getByRole('button', { name: 'Publish', exact: true }).click();
  await pub.getByRole('button', { name: 'Recent' }).click();
  await expect(pub.locator('.lib-item .lib-preview')).toHaveText([IMG]);
  await expect(pub.locator('.lib-item .lib-topic')).toHaveText([`xss/${SCRIPT}`]);
  await expect(page.locator('.toast').filter({ hasText: `Published to xss/${SCRIPT}` })).toBeVisible();
  await expectClean(page, 'publisher');

  // Plots: legend and title show the hostile topic as text.
  await (await rowByPath(page, `xss/${IMG}`)).click({ button: 'right' });
  await menu(page, 'Add to new plot');
  await page.locator('.right-tabs .tab[data-tab="plots"]').click();
  await expect(page.locator('.plot-card .legend-label')).toHaveText([`xss/${IMG}`]);
  await expect(page.locator('.plot-card .plot-title')).toHaveText(`xss/${IMG}`);
  await expect(page.locator('.plot-card .legend-value')).toHaveText('43');
  await expectClean(page, 'plots');

  // Pop-out window for a hostile topic.
  await page.locator('.right-tabs .tab[data-tab="inspector"]').click();
  await (await rowByPath(page, `xss/json/${SVG}`)).click();
  const { popup, errors: popupErrors } = await popupFrom(app, () => page.locator('#viewer-host').getByRole('button', { name: '⤢ Pop out' }).click());
  await expect(popup.locator('.viewer-topic')).toHaveText(`xss/json/${SVG}`);
  for (const mode of ['tree', 'text', 'raw', 'diff']) {
    await popup.locator(`.viewer-toolbar .tab[data-mode="${mode}"]`).click();
    await expect(popup.locator('.viewer-body')).toHaveClass(new RegExp(`mode-${mode}`));
  }
  await expectClean(popup, 'pop-out');
  expect(popupErrors).toEqual([]);

  await expectClean(page, 'end');
  expect(errors).toEqual([]);
});
