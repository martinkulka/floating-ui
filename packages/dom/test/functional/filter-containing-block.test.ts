import {expect, test} from '@playwright/test';

import {click} from './utils/click';

// The defaults of the `filter-containing-block` route, in its field order.
const DEFAULTS = {
  layout: 'host',
  effect: 'none',
  position: 'static',
  display: 'block',
  strategy: 'fixed',
  scroll: 'none',
  overflow: 'visible',
  nearer: 'false',
  containing: 'will-change-transform',
};

type Scenario = Partial<typeof DEFAULTS>;

const FILTER_EFFECTS = ['drop-shadow', 'brightness', 'backdrop'];

const scenarios: Scenario[] = [];
for (const effect of ['none', ...FILTER_EFFECTS, 'will-change']) {
  for (const strategy of ['fixed', 'absolute']) {
    for (const position of ['static', 'relative', 'absolute', 'fixed']) {
      for (const display of ['block', 'inline-block']) {
        scenarios.push({effect, strategy, position, display});
      }
    }
    scenarios.push({effect, strategy, scroll: 'host', overflow: 'auto'});
    scenarios.push({effect, strategy, scroll: 'window'});
    // A static host that clips, with or without a nearer containing block
    // that clips.
    for (const overflow of ['hidden', 'auto']) {
      for (const nearer of ['false', 'true']) {
        scenarios.push({effect, strategy, overflow, nearer});
      }
    }
  }
}
// The containing block of a slotted floating element is inside the shadow
// root of a filtered host.
for (const containing of ['will-change-transform', 'contain-layout']) {
  for (const scroll of ['none', 'inner']) {
    scenarios.push({layout: 'shadow', containing, scroll});
  }
}

scenarios.forEach((scenario) => {
  const title = Object.entries(scenario)
    .map(([field, value]) => `${field}=${value}`)
    .join(' ');

  test(`filter containing block: ${title}`, async ({page, browserName}) => {
    await page.goto('http://localhost:1234/filter-containing-block');
    for (const [field, value] of Object.entries(scenario)) {
      await click(page, `[data-testid="${field}-${value}"]`);
    }

    const key = Object.values({...DEFAULTS, ...scenario}).join(' ');
    const result = JSON.parse(
      (await page
        .locator(`[data-testid="result"][data-scenario="${key}"]`)
        .textContent()) ?? '{}',
    );

    expect(result.containingBlock).not.toBe('unknown');
    // Floating UI only reads the DOM.
    expect(result.mutations).toBe(0);

    // WebKit before Safari 26.1 does not report a fixed element's containing
    // block as its `offsetParent`, so a filter one can't be detected there.
    test.skip(
      browserName === 'webkit' &&
        FILTER_EFFECTS.includes(scenario.effect ?? '') &&
        result.containingBlock === 'host' &&
        result.offsetParent.native !== 'host',
      'The browser does not report the containing block.',
    );

    for (const {name, actual, expected} of result.checks) {
      if (typeof expected === 'number') {
        expect.soft(actual, name).toBeCloseTo(expected, 0);
      } else {
        expect.soft(actual, name).toBe(expected);
      }
    }
  });
});
