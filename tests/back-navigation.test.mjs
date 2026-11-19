import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BackNavigationManager,
  BackPriority,
  installGlobalBackBridge,
  popMobileRouteHistory,
  pushMobileRouteHistory,
  resolveMobileBackTarget,
} from '../src/lib/backNavigation.ts';

test('dispatch obeys strict priority ordering from CONFIRM down to NAVIGATION', () => {
  const nav = new BackNavigationManager();
  const order = [];

  const unregister = [
    nav.register(() => { order.push('navigation'); return false; }, BackPriority.NAVIGATION),
    nav.register(() => { order.push('subview'); return false; }, BackPriority.SUBVIEW),
    nav.register(() => { order.push('panel'); return false; }, BackPriority.PANEL_OR_DRAWER),
    nav.register(() => { order.push('panel_subview'); return false; }, BackPriority.PANEL_SUBVIEW),
    nav.register(() => { order.push('popover'); return false; }, BackPriority.POPOVER),
    nav.register(() => { order.push('modal'); return false; }, BackPriority.MODAL),
    nav.register(() => { order.push('nested_modal'); return false; }, BackPriority.NESTED_MODAL),
    nav.register(() => { order.push('dropdown'); return false; }, BackPriority.DROPDOWN),
    nav.register(() => { order.push('confirm'); return false; }, BackPriority.CONFIRM),
  ];

  assert.equal(nav.canGoBack(), true);
  assert.equal(nav.dispatch(), false);
  assert.deepEqual(order, [
    'confirm',
    'dropdown',
    'nested_modal',
    'modal',
    'popover',
    'panel_subview',
    'panel',
    'subview',
    'navigation',
  ]);

  unregister.forEach((fn) => fn());
  assert.equal(nav.canGoBack(), false);
});

test('same-priority handlers run in LIFO order and stop at the first handler that consumes Back', () => {
  const nav = new BackNavigationManager();
  const closed = [];

  const unregFirst = nav.register(() => {
    closed.push('first');
    unregFirst();
  }, BackPriority.MODAL);
  const unregSecond = nav.register(() => {
    closed.push('second');
    unregSecond();
  }, BackPriority.MODAL);

  assert.equal(nav.dispatch(), true);
  assert.deepEqual(closed, ['second']);
  assert.equal(nav.canGoBack(), true);

  assert.equal(nav.dispatch(), true);
  assert.deepEqual(closed, ['second', 'first']);
  assert.equal(nav.canGoBack(), false);

  assert.equal(nav.dispatch(), false);
});

test('returning false passes through to the next lower handler; throwing handler does not break fallback', () => {
  const nav = new BackNavigationManager();
  const hits = [];

  nav.register(() => {
    hits.push('fallback');
    return true;
  }, BackPriority.NAVIGATION);

  nav.register(() => {
    hits.push('inactive-modal');
    return false;
  }, BackPriority.MODAL);

  const originalError = console.error;
  console.error = () => {};
  try {
    nav.register(() => {
      hits.push('broken');
      throw new Error('boom');
    }, BackPriority.CONFIRM);

    assert.equal(nav.dispatch(), true);
    assert.deepEqual(hits, ['broken', 'inactive-modal', 'fallback']);
  } finally {
    console.error = originalError;
  }
});

test('entries unregistered during dispatch are skipped', () => {
  const nav = new BackNavigationManager();
  let lowerCalled = false;
  const unregLower = nav.register(() => {
    lowerCalled = true;
    return true;
  }, BackPriority.NAVIGATION);

  nav.register(() => {
    unregLower();
    return false;
  }, BackPriority.MODAL);

  assert.equal(nav.dispatch(), false);
  assert.equal(lowerCalled, false);
});

test('Welcome -> Hosts -> Terminal -> Back -> Back never loops back into the terminal', () => {
  let page = 'terminals';
  let history = [];

  // Tap Hosts from Welcome screen
  history = pushMobileRouteHistory(history, page, 'hosts');
  page = 'hosts';
  assert.deepEqual(history, ['terminals']);

  // Tap a host -> opens full-screen terminal
  history = pushMobileRouteHistory(history, page, 'terminals');
  page = 'terminals';
  assert.deepEqual(history, ['hosts']);

  // Swipe back from full-screen terminal -> returns to Hosts
  const step1 = resolveMobileBackTarget({ currentPage: page, history, terminalScreen: true });
  assert.equal(step1.target, 'hosts');
  assert.deepEqual(step1.nextHistory, []);
  page = step1.target;
  history = step1.nextHistory;

  // Swipe back again from Hosts -> root exit (null), no loop back into terminal
  const step2 = resolveMobileBackTarget({ currentPage: page, history, terminalScreen: false });
  assert.equal(step2.target, null);
  assert.deepEqual(step2.nextHistory, []);
});

test('Hosts -> SFTP -> AI unwinds cleanly through every visited tab then exits at root', () => {
  let page = 'hosts';
  let history = [];

  history = pushMobileRouteHistory(history, page, 'sftp');
  page = 'sftp';
  history = pushMobileRouteHistory(history, page, 'assistant');
  page = 'assistant';
  assert.deepEqual(history, ['hosts', 'sftp']);

  const back1 = resolveMobileBackTarget({ currentPage: page, history, terminalScreen: false });
  assert.equal(back1.target, 'sftp');
  page = back1.target;
  history = back1.nextHistory;

  const back2 = resolveMobileBackTarget({ currentPage: page, history, terminalScreen: false });
  assert.equal(back2.target, 'hosts');
  page = back2.target;
  history = back2.nextHistory;

  const back3 = resolveMobileBackTarget({ currentPage: page, history, terminalScreen: false });
  assert.equal(back3.target, null);
});

test('restored full-screen terminal with empty history backs out to Hosts first, then exits at root', () => {
  const step1 = resolveMobileBackTarget({
    currentPage: 'terminals',
    history: [],
    terminalScreen: true,
  });
  assert.equal(step1.target, 'hosts');
  assert.deepEqual(step1.nextHistory, []);

  const step2 = resolveMobileBackTarget({
    currentPage: 'hosts',
    history: step1.nextHistory,
    terminalScreen: false,
  });
  assert.equal(step2.target, null);
});

test('pushMobileRouteHistory ignores self-transitions, deduplicates cycles, and caps length', () => {
  assert.deepEqual(pushMobileRouteHistory(['hosts'], 'sftp', 'sftp'), ['hosts']);

  // Cycle: hosts -> sftp -> assistant -> hosts -> sftp
  let h = [];
  h = pushMobileRouteHistory(h, 'hosts', 'sftp');
  h = pushMobileRouteHistory(h, 'sftp', 'assistant');
  h = pushMobileRouteHistory(h, 'assistant', 'hosts');
  assert.deepEqual(h, ['sftp', 'assistant']);

  const popped = popMobileRouteHistory(h);
  assert.equal(popped.target, 'assistant');
  assert.deepEqual(popped.nextHistory, ['sftp']);

  // Max length cap
  const capped = pushMobileRouteHistory(['hosts', 'sftp', 'assistant'], 'settings', 'terminals', 2);
  assert.equal(capped.length, 2);
  assert.deepEqual(capped, ['assistant', 'settings']);
});

test('installGlobalBackBridge wires window hooks and syncs deduplicated canGoBack to Android native bridge', () => {
  const nav = new BackNavigationManager();
  const calls = [];
  const fakeWindow = {
    DrexiusAndroidBack: {
      setCanGoBack(val) {
        calls.push(val);
      },
    },
  };

  const uninstall = installGlobalBackBridge(fakeWindow, nav);
  assert.equal(typeof fakeWindow.__drexiusHandleBack, 'function');
  assert.equal(typeof fakeWindow.__drexiusCanGoBack, 'function');
  assert.deepEqual(calls, [false]);
  assert.equal(fakeWindow.__drexiusCanGoBack(), false);

  const unreg1 = nav.register(() => {
    unreg1();
    return true;
  }, BackPriority.MODAL);
  assert.deepEqual(calls, [false, true]);
  assert.equal(fakeWindow.__drexiusCanGoBack(), true);

  // Registering a second handler should not send a duplicate `true` across the JNI bridge
  const unreg2 = nav.register(() => {
    unreg2();
    return true;
  }, BackPriority.CONFIRM);
  assert.deepEqual(calls, [false, true]);

  // First back pops CONFIRM (MODAL remains, still true)
  assert.equal(fakeWindow.__drexiusHandleBack(), true);
  assert.equal(fakeWindow.__drexiusCanGoBack(), true);
  assert.deepEqual(calls, [false, true]);

  // Second back pops MODAL (stack empty -> notifies Android false for Predictive Back)
  assert.equal(fakeWindow.__drexiusHandleBack(), true);
  assert.equal(fakeWindow.__drexiusCanGoBack(), false);
  assert.deepEqual(calls, [false, true, false]);

  // Third back returns false (unhandled at root)
  assert.equal(fakeWindow.__drexiusHandleBack(), false);

  uninstall();
  assert.equal(fakeWindow.__drexiusHandleBack, undefined);
  assert.equal(fakeWindow.__drexiusCanGoBack, undefined);
});
