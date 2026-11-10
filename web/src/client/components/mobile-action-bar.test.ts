// @vitest-environment happy-dom
/**
 * Unit tests for MobileActionBar component
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import './mobile-action-bar.js';
import type { MobileActionBar, MobileActionBarCallbacks } from './mobile-action-bar.js';

// Mock logger
vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({
    log: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Force the component to render its mobile UI regardless of the test environment's UA.
vi.mock('../utils/mobile-utils.js', () => ({
  detectMobile: () => true,
}));

describe('MobileActionBar', () => {
  let container: HTMLElement;
  let element: MobileActionBar;
  let onShowKeyboard: ReturnType<typeof vi.fn>;

  const dispatchPointer = (
    target: Element,
    type: 'pointerdown' | 'pointerup' | 'pointermove',
    options: { clientX: number; clientY: number; pointerId?: number }
  ) => {
    const event = new Event(type, { bubbles: true, cancelable: true }) as PointerEvent;
    Object.defineProperty(event, 'clientX', { value: options.clientX });
    Object.defineProperty(event, 'clientY', { value: options.clientY });
    Object.defineProperty(event, 'pointerId', { value: options.pointerId ?? 1 });
    target.dispatchEvent(event);
  };

  beforeEach(async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    container.innerHTML = '<mobile-action-bar></mobile-action-bar>';
    element = container.querySelector('mobile-action-bar') as MobileActionBar;

    onShowKeyboard = vi.fn();
    element.callbacks = { onShowKeyboard } as unknown as MobileActionBarCallbacks;
    element.visible = true;
    await element.updateComplete;
  });

  afterEach(() => {
    container.remove();
  });

  function getKeyboardButton(): HTMLButtonElement {
    const button = Array.from(element.querySelectorAll('button')).find(
      (b) => b.getAttribute('aria-label') === 'Keyboard'
    );
    expect(button).toBeTruthy();
    return button as HTMLButtonElement;
  }

  it('does not fire the action when the pointer moves more than 10px before release', () => {
    const button = getKeyboardButton();

    dispatchPointer(button, 'pointerdown', { clientX: 100, clientY: 100 });
    dispatchPointer(button, 'pointermove', { clientX: 130, clientY: 100 });
    dispatchPointer(button, 'pointerup', { clientX: 130, clientY: 100 });

    expect(onShowKeyboard).not.toHaveBeenCalled();
  });

  it('fires the action when the pointer releases within 10px of press', () => {
    const button = getKeyboardButton();

    dispatchPointer(button, 'pointerdown', { clientX: 100, clientY: 100 });
    dispatchPointer(button, 'pointerup', { clientX: 105, clientY: 100 });

    expect(onShowKeyboard).toHaveBeenCalledTimes(1);
  });

  it('does not fire the action when the release pointerId differs from the press', () => {
    const button = getKeyboardButton();

    dispatchPointer(button, 'pointerdown', { clientX: 100, clientY: 100, pointerId: 1 });
    dispatchPointer(button, 'pointerup', { clientX: 100, clientY: 100, pointerId: 2 });

    expect(onShowKeyboard).not.toHaveBeenCalled();
  });

  it('applies the hidden classes while a scroll gesture is active', async () => {
    element.hidden = true;
    await element.updateComplete;

    const bar = element.querySelector('div.fixed');
    expect(bar).toBeTruthy();
    expect(bar?.className).toContain('opacity-0');
    expect(bar?.className).toContain('pointer-events-none');
  });

  it('does not apply the hidden classes when no scroll gesture is active', async () => {
    element.hidden = false;
    await element.updateComplete;

    const bar = element.querySelector('div.fixed');
    expect(bar).toBeTruthy();
    expect(bar?.className).not.toContain('opacity-0');
  });
});
