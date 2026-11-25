import type {Rect} from '@floating-ui/core';
import type {Boundary, Middleware} from '@floating-ui/dom';
import {
  computePosition,
  detectOverflow,
  flip,
  platform,
  shift,
  size,
} from '@floating-ui/dom';
import type {CSSProperties} from 'react';
import {useLayoutEffect, useRef, useState} from 'react';

import {Controls} from '../utils/Controls';

const OPTIONS = {
  layout: ['host', 'shadow'],
  effect: ['none', 'drop-shadow', 'brightness', 'backdrop', 'will-change'],
  position: ['static', 'relative', 'absolute', 'fixed'],
  display: ['block', 'inline-block'],
  strategy: ['fixed', 'absolute'],
  scroll: ['none', 'host', 'window', 'inner'],
  overflow: ['visible', 'hidden', 'auto'],
  nearer: ['false', 'true'],
  containing: ['will-change-transform', 'contain-layout'],
} as const;

type Scenario = {[K in keyof typeof OPTIONS]: (typeof OPTIONS)[K][number]};

const DEFAULT_SCENARIO: Scenario = {
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

const EFFECT_STYLES: Record<Scenario['effect'], CSSProperties> = {
  none: {},
  'drop-shadow': {filter: 'drop-shadow(0 4px 8px rgba(0, 0, 0, 0.25))'},
  brightness: {filter: 'brightness(1)'},
  // Older WebKit versions only support the prefixed property.
  backdrop: {backdropFilter: 'blur(0px)', WebkitBackdropFilter: 'blur(0px)'},
  'will-change': {willChange: 'filter'},
};

type Check = {
  name: string;
  actual: number | string | undefined;
  expected: number | string;
};

type Result = {
  scenario: string;
  // The element the floating element actually moves with, measured without
  // Floating UI or `offsetParent`.
  containingBlock: 'host' | 'inner' | 'viewport' | 'unknown';
  offsetParent: {native: string | null; library: string | null};
  // DOM mutations observed while Floating UI computed the position.
  mutations: number;
  checks: Check[];
};

type Elements = {
  wrapper: HTMLElement;
  host: HTMLElement;
  inner: HTMLElement;
  reference: HTMLElement;
  floating: HTMLElement;
};

const scenarioKey = (scenario: Scenario) => Object.values(scenario).join(' ');

const identify = (element: unknown) =>
  element instanceof HTMLElement
    ? element.dataset.testid ?? element.nodeName
    : element === window
      ? 'window'
      : null;

function getClientRect(element: Element): Rect {
  const rect = element.getBoundingClientRect();
  return {
    x: rect.x + element.clientLeft,
    y: rect.y + element.clientTop,
    width: element.clientWidth,
    height: element.clientHeight,
  };
}

// Moves the candidate containing block by (37, 29) and reports whether the
// floating element moves with it.
function measureContainingBlock(
  scenario: Scenario,
  {wrapper, host, inner, floating}: Elements,
): Result['containingBlock'] {
  const isShadow = scenario.layout === 'shadow';
  const isInner = isShadow || scenario.nearer === 'true';
  const isHostPositioned = ['absolute', 'fixed'].includes(host.style.position);
  const [element, xProperty, yProperty] = isShadow
    ? [inner, 'marginLeft', 'marginTop']
    : isInner || isHostPositioned
      ? [isInner ? inner : host, 'left', 'top']
      : [wrapper, 'paddingLeft', 'paddingTop'];
  const style = element.style as unknown as Record<string, string>;
  const [x, y] = [style[xProperty], style[yProperty]];
  const before = floating.getBoundingClientRect();
  style[xProperty] = `${parseFloat(x || '0') + 37}px`;
  style[yProperty] = `${parseFloat(y || '0') + 29}px`;
  const after = floating.getBoundingClientRect();
  style[xProperty] = x;
  style[yProperty] = y;

  const dx = after.x - before.x;
  const dy = after.y - before.y;
  const near = (a: number, b: number) => Math.abs(a - b) < 0.5;
  if (near(dx, 37) && near(dy, 29)) return isInner ? 'inner' : 'host';
  if (near(dx, 0) && near(dy, 0)) return 'viewport';
  return 'unknown';
}

async function measure(
  scenario: Scenario,
  elements: Elements,
  isActive: () => boolean,
): Promise<Result | null> {
  const {host, inner, reference, floating} = elements;
  window.scrollTo(0, 0);
  const containingBlock = measureContainingBlock(scenario, elements);
  if (scenario.scroll === 'host') host.scrollTop = 48;
  if (scenario.scroll === 'inner') inner.scrollTop = 48;
  if (scenario.scroll === 'window') window.scrollTo(0, 48);

  // Floating UI must only read the DOM.
  const observer = new MutationObserver(() => {});
  const observed = {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  };
  observer.observe(document, observed);
  if (host.shadowRoot) observer.observe(host.shadowRoot, observed);

  const options = {
    strategy: scenario.strategy,
    placement: 'bottom-start' as const,
  };
  const libraryOffsetParent = await platform.getOffsetParent(floating);
  // The DOM platform is synchronous, so the `Promisable` type is cast away.
  const getClippingRect = (boundary: Boundary) =>
    platform.getClippingRect.call(
      {...platform, _c: new Map()},
      {
        element: floating,
        boundary,
        rootBoundary: 'viewport',
        strategy: scenario.strategy,
      },
    ) as Rect;
  const clipping = getClippingRect('clippingAncestors');
  const viewport = getClippingRect([]);
  const plain = await computePosition(reference, floating, options);
  let detectedBottom: number | undefined;
  const overflowProbe: Middleware = {
    name: 'overflowProbe',
    async fn(state) {
      // Keep the first (bottom-start) sample.
      detectedBottom ??= (await detectOverflow(state)).bottom;
      return {};
    },
  };
  const flipped = await computePosition(reference, floating, {
    ...options,
    middleware: [overflowProbe, flip({fallbackPlacements: ['top-start']})],
  });
  const shifted = await computePosition(reference, floating, {
    ...options,
    middleware: [shift({crossAxis: true})],
  });
  let available = {width: NaN, height: NaN};
  await computePosition(reference, floating, {
    ...options,
    middleware: [
      size({
        apply({availableWidth, availableHeight}) {
          available = {width: availableWidth, height: availableHeight};
        },
      }),
    ],
  });
  const mutations = observer.takeRecords().length;
  observer.disconnect();
  if (!isActive()) return null;

  const place = ({x, y}: {x: number; y: number}) => {
    Object.assign(floating.style, {left: `${x}px`, top: `${y}px`});
    return floating.getBoundingClientRect();
  };
  const shiftedY = place(shifted).y;
  const actual = place(plain);
  const ref = reference.getBoundingClientRect();

  // Expected values follow from the measured containing block: an overflow
  // element clips the floating element only if it is in its containing block
  // chain.
  const clip =
    containingBlock === 'inner'
      ? getClientRect(inner)
      : containingBlock === 'host' && scenario.overflow !== 'visible'
        ? getClientRect(host)
        : viewport;
  const clipBottom = clip.y + clip.height;
  const expectedBottom = ref.bottom + actual.height - clipBottom;
  const checks: Check[] = [
    {name: 'x', actual: actual.x, expected: ref.x},
    {name: 'y', actual: actual.y, expected: ref.bottom},
    ...(['x', 'y', 'width', 'height'] as const).map((key) => ({
      name: `clipping ${key}`,
      actual: clipping[key],
      expected: clip[key],
    })),
    {name: 'overflow bottom', actual: detectedBottom, expected: expectedBottom},
    {
      name: 'flip placement',
      actual: flipped.placement,
      expected: expectedBottom > 0 ? 'top-start' : 'bottom-start',
    },
    {
      name: 'shift y',
      actual: shiftedY,
      expected: Math.min(ref.bottom, clipBottom - actual.height),
    },
    {
      name: 'size available width',
      actual: available.width,
      expected: Math.min(clip.width, clip.x + clip.width - ref.x),
    },
    {
      name: 'size available height',
      actual: available.height,
      expected: Math.min(clip.height, clipBottom - ref.bottom),
    },
  ];
  if (containingBlock === 'inner') {
    checks.push({
      name: 'offsetParent',
      actual: identify(libraryOffsetParent) ?? '',
      expected: 'inner',
    });
  }

  return {
    scenario: scenarioKey(scenario),
    containingBlock,
    offsetParent: {
      native: identify(floating.offsetParent),
      library: identify(libraryOffsetParent),
    },
    mutations,
    checks,
  };
}

export function FilterContainingBlock() {
  const [scenario, setScenario] = useState<Scenario>(DEFAULT_SCENARIO);
  const [result, setResult] = useState<Result | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const innerRef = useRef<HTMLDivElement | null>(null);
  const referenceRef = useRef<HTMLDivElement | null>(null);
  const floatingRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!wrapperRef.current || !host) return;
    let inner = innerRef.current;

    if (scenario.layout === 'shadow') {
      // The slotted floating element's containing block is inside the
      // filtered host's shadow root.
      const root = host.shadowRoot ?? host.attachShadow({mode: 'open'});
      if (!root.firstElementChild) {
        root.innerHTML =
          '<div data-testid="inner" style="width:360px;height:260px;overflow:auto">' +
          '<div style="height:600px;padding:64px 20px"><slot></slot></div></div>';
      }
      inner = root.firstElementChild as HTMLDivElement;
      Object.assign(
        inner.style,
        scenario.containing === 'contain-layout'
          ? {contain: 'layout'}
          : {willChange: 'transform'},
      );
    }

    if (!inner || !referenceRef.current || !floatingRef.current) return;
    let active = true;
    measure(
      scenario,
      {
        wrapper: wrapperRef.current,
        host,
        inner,
        reference: referenceRef.current,
        floating: floatingRef.current,
      },
      () => active,
    ).then((localResult) => {
      if (localResult) setResult(localResult);
    });
    return () => {
      active = false;
    };
  }, [scenario]);

  const isShadow = scenario.layout === 'shadow';
  const isHostPositioned =
    isShadow || ['absolute', 'fixed'].includes(scenario.position);
  const reference = (
    <div
      ref={referenceRef}
      style={{width: 100, height: 30, background: 'royalblue'}}
    />
  );
  const floating = (
    <div
      ref={floatingRef}
      style={{
        position: isShadow ? 'fixed' : scenario.strategy,
        left: 0,
        top: 0,
        width: 180,
        height: 80,
        background: 'rgba(64, 224, 208, 0.8)',
      }}
    />
  );

  return (
    <>
      <h1>Filter Containing Block</h1>
      <p>
        A filter or backdrop-filter ancestor that the browser reports as the
        containing block positions and clips the floating element.
      </p>
      {/* Remounted per scenario so no measured style leaks between them. */}
      <div key={scenarioKey(scenario)}>
        <div ref={wrapperRef} style={{paddingTop: 20, paddingLeft: 40}}>
          <div
            ref={hostRef}
            data-testid="host"
            style={{
              position: isShadow ? 'absolute' : scenario.position,
              display: isShadow ? 'block' : scenario.display,
              width: 360,
              height: 260,
              overflow: isShadow ? 'visible' : scenario.overflow,
              background: 'rgba(255, 99, 71, 0.2)',
              ...(isHostPositioned && {left: 300, top: 200}),
              ...EFFECT_STYLES[isShadow ? 'drop-shadow' : scenario.effect],
            }}
          >
            {isShadow ? (
              <>
                {reference}
                {floating}
              </>
            ) : (
              <div
                ref={innerRef}
                data-testid="inner"
                style={
                  scenario.nearer === 'true'
                    ? {
                        position: 'relative',
                        willChange: 'transform',
                        overflow: 'hidden',
                        width: 300,
                        height: 220,
                        padding: '170px 0 0 60px',
                      }
                    : {
                        width: 340,
                        height: scenario.scroll === 'host' ? 700 : 240,
                        padding: '170px 0 0 60px',
                      }
                }
              >
                {reference}
                {floating}
              </div>
            )}
          </div>
        </div>
        {scenario.scroll === 'window' && <div style={{height: 1000}} />}
      </div>
      <pre
        data-testid="result"
        data-scenario={result?.scenario}
        style={{whiteSpace: 'pre-wrap'}}
      >
        {result ? JSON.stringify(result, null, 2) : ''}
      </pre>

      {(Object.keys(OPTIONS) as Array<keyof Scenario>).map((field) => (
        <div key={field}>
          <h2>{field}</h2>
          <Controls>
            {OPTIONS[field].map((value) => (
              <button
                key={value}
                data-testid={`${field}-${value}`}
                onClick={() =>
                  setScenario((previous) => ({...previous, [field]: value}))
                }
                style={{
                  backgroundColor: scenario[field] === value ? 'black' : '',
                }}
              >
                {value}
              </button>
            ))}
          </Controls>
        </div>
      ))}
    </>
  );
}
