import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';

import type * as DOM from '../src/dom';

let dom: typeof DOM;

beforeEach(async () => {
  vi.resetModules();
  dom = await import('../src/dom');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

// jsdom has no layout, so `offsetParent` is always null unless mocked.
function reportOffsetParent(
  element: HTMLElement,
  offsetParent: Element | null,
) {
  Object.defineProperty(element, 'offsetParent', {
    configurable: true,
    get: () => offsetParent,
  });
}

// Returns `body > ancestor > element`, where `element` is fixed.
function setup(ancestorStyle: string) {
  const ancestor = document.createElement('div');
  ancestor.style.cssText = ancestorStyle;
  const element = document.createElement('div');
  element.style.position = 'fixed';
  ancestor.append(element);
  document.body.append(ancestor);
  return {ancestor, element};
}

describe('isReportedContainingBlock', () => {
  test('a filter ancestor reported as the offsetParent', () => {
    const {ancestor, element} = setup('filter: drop-shadow(0 0 1px black)');
    reportOffsetParent(element, ancestor);
    expect(dom.isReportedContainingBlock(element, ancestor)).toBe(true);
  });

  test.each([
    ['standard', {backdropFilter: 'blur(0px)'}],
    ['prefixed', {'-webkit-backdrop-filter': 'blur(0px)'}],
  ])('a %s backdrop-filter ancestor reported as the offsetParent', (_, css) => {
    const {ancestor, element} = setup('');
    reportOffsetParent(element, ancestor);
    // jsdom does not compute backdrop-filter.
    const getComputedStyle = window.getComputedStyle;
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el) =>
      el === ancestor
        ? ({
            display: 'block',
            filter: 'none',
            ...css,
            getPropertyValue: (name: string) =>
              (css as Record<string, string>)[name] ?? '',
          } as unknown as CSSStyleDeclaration)
        : getComputedStyle(el),
    );
    expect(dom.isReportedContainingBlock(element, ancestor)).toBe(true);
  });

  test('a filter ancestor that is not reported', () => {
    const {ancestor, element} = setup('filter: brightness(1)');
    reportOffsetParent(element, null);
    expect(dom.isReportedContainingBlock(element, ancestor)).toBe(false);
    reportOffsetParent(element, document.body);
    expect(dom.isReportedContainingBlock(element, ancestor)).toBe(false);
  });

  test('an inline filter ancestor', () => {
    const {ancestor, element} = setup('display: inline; filter: brightness(1)');
    reportOffsetParent(element, ancestor);
    expect(dom.isReportedContainingBlock(element, ancestor)).toBe(false);
  });

  test('a reported ancestor without filter or backdrop-filter', () => {
    const {ancestor, element} = setup('position: relative');
    reportOffsetParent(element, ancestor);
    expect(dom.isReportedContainingBlock(element, ancestor)).toBe(false);
  });

  test('a non-HTML element', () => {
    const {ancestor} = setup('filter: brightness(1)');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    ancestor.append(svg);
    expect(dom.isReportedContainingBlock(svg, ancestor)).toBe(false);
  });
});

describe('getContainingBlock', () => {
  beforeEach(() => {
    // Simulate WebKit, where `isContainingBlock` ignores filter.
    vi.stubGlobal('CSS', {supports: () => true});
  });

  test('isContainingBlock still ignores filter in WebKit', () => {
    const {ancestor} = setup('filter: brightness(1)');
    expect(dom.isContainingBlock(ancestor)).toBe(false);
    expect(
      dom.isContainingBlock({
        filter: 'brightness(1)',
      } as CSSStyleDeclaration),
    ).toBe(false);
  });

  test('returns a reported filter ancestor', () => {
    const {ancestor, element} = setup('filter: brightness(1)');
    const parent = document.createElement('div');
    ancestor.append(parent);
    parent.append(element);
    reportOffsetParent(element, ancestor);
    expect(dom.getContainingBlock(element)).toBe(ancestor);
  });

  test('ignores a filter ancestor that is not reported', () => {
    const {element} = setup('filter: brightness(1)');
    reportOffsetParent(element, null);
    expect(dom.getContainingBlock(element)).toBe(null);
  });

  test('prefers a nearer containing block', () => {
    const {ancestor, element} = setup('filter: brightness(1)');
    const nearer = document.createElement('div');
    nearer.style.willChange = 'transform';
    ancestor.append(nearer);
    nearer.append(element);
    // A browser can report the outer ancestor, e.g. when the nearer one is
    // inside a shadow root.
    reportOffsetParent(element, ancestor);
    expect(dom.getContainingBlock(element)).toBe(nearer);
  });

  test('stops at the body', () => {
    const element = document.createElement('div');
    document.body.style.filter = 'brightness(1)';
    document.body.append(element);
    reportOffsetParent(element, document.body);
    expect(dom.getContainingBlock(element)).toBe(null);
    document.body.style.filter = '';
  });

  test('stops at a top-layer element', () => {
    const {ancestor, element} = setup('filter: brightness(1)');
    const layer = document.createElement('div');
    vi.spyOn(layer, 'matches').mockImplementation(
      (selector) => selector === ':popover-open',
    );
    ancestor.append(layer);
    layer.append(element);
    reportOffsetParent(element, ancestor);
    expect(dom.getContainingBlock(element)).toBe(null);
  });
});
