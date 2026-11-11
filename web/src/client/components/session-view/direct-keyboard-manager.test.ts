/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DirectKeyboardCallbacks, FocusReason } from './direct-keyboard-manager';
import { DirectKeyboardManager } from './direct-keyboard-manager';
import type { InputManager } from './input-manager';

describe('DirectKeyboardManager', () => {
  let manager: DirectKeyboardManager;
  let mockInputManager: Pick<InputManager, 'isKeyboardShortcut' | 'sendInput' | 'sendInputText'>;
  let originalRequestAnimationFrame: typeof requestAnimationFrame;

  const getManagerState = () =>
    manager as unknown as {
      hiddenInput: HTMLInputElement | null;
      focusRetentionInterval: number | null;
      keyboardReopenTimeout: ReturnType<typeof setTimeout> | null;
      reopeningKeyboard: boolean;
      keyboardMode: boolean;
      lastQuickKeyTimestamp: number;
      requestHiddenInputFocus: (reason: FocusReason) => boolean;
    };

  beforeEach(() => {
    // Mock requestAnimationFrame
    originalRequestAnimationFrame = global.requestAnimationFrame;
    global.requestAnimationFrame = vi.fn((callback) => {
      // Execute callback immediately in test environment
      setTimeout(callback, 0);
      return 1;
    });

    manager = new DirectKeyboardManager('test');
    mockInputManager = {
      isKeyboardShortcut: vi.fn().mockReturnValue(false),
      sendInput: vi.fn(),
      sendInputText: vi.fn(),
    };
    manager.setInputManager(mockInputManager as InputManager);

    // Mock clipboard API using Object.defineProperty
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        readText: vi.fn().mockResolvedValue('clipboard content'),
      },
      writable: true,
      configurable: true,
    });

    // Mock secure context for clipboard API to work
    Object.defineProperty(window, 'isSecureContext', {
      value: true,
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    manager.cleanup();
    vi.useRealTimers();
    // Restore requestAnimationFrame
    global.requestAnimationFrame = originalRequestAnimationFrame;
  });

  it('should handle Paste quick key and send clipboard content', async () => {
    await manager.handleQuickKeyPress('Paste');
    expect(navigator.clipboard.readText).toHaveBeenCalled();
    expect(mockInputManager.sendInputText).toHaveBeenCalledWith('clipboard content');
  });

  it('recreates the hidden input only for an explicit keyboard reopen', () => {
    const originalInput = getManagerState().hiddenInput;
    expect(originalInput).toBeTruthy();

    originalInput?.focus();
    manager.ensureHiddenInputVisible();
    expect(getManagerState().hiddenInput).toBe(originalInput);

    vi.useFakeTimers();
    manager.focusHiddenInput(true);

    expect(getManagerState().hiddenInput).not.toBe(originalInput);
    expect(getManagerState().reopeningKeyboard).toBe(true);
    expect(getManagerState().focusRetentionInterval).toBeNull();

    vi.advanceTimersByTime(500);

    expect(getManagerState().reopeningKeyboard).toBe(false);
    expect(getManagerState().focusRetentionInterval).not.toBeNull();
  });

  it('restarts the reopen window after repeated TAP presses', () => {
    vi.useFakeTimers();

    manager.focusHiddenInput(true);
    vi.advanceTimersByTime(400);
    manager.focusHiddenInput(true);
    vi.advanceTimersByTime(100);

    expect(getManagerState().reopeningKeyboard).toBe(true);
    expect(getManagerState().focusRetentionInterval).toBeNull();

    vi.advanceTimersByTime(400);

    expect(getManagerState().reopeningKeyboard).toBe(false);
    expect(getManagerState().focusRetentionInterval).not.toBeNull();
  });

  it('cancels a pending keyboard reopen during cleanup', () => {
    vi.useFakeTimers();

    manager.focusHiddenInput(true);
    manager.cleanup();
    vi.runAllTimers();

    expect(getManagerState().hiddenInput).toBeNull();
    expect(getManagerState().keyboardReopenTimeout).toBeNull();
    expect(getManagerState().reopeningKeyboard).toBe(false);
    expect(getManagerState().focusRetentionInterval).toBeNull();
  });

  it.each([
    [' h', 'h'],
    ['h ', 'h'],
    ['hello world ', 'hello world'],
    [' /', '/'],
    [' /help', '/help'],
  ])('removes the placeholder space from %j', (inputValue, expected) => {
    const hiddenInput = getManagerState().hiddenInput;
    expect(hiddenInput).toBeTruthy();

    if (!hiddenInput) {
      return;
    }

    hiddenInput.value = inputValue;
    hiddenInput.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));

    expect(mockInputManager.sendInputText).toHaveBeenCalledWith(expected);
  });

  it('sends Escape without bubbling to app navigation', () => {
    const hiddenInput = getManagerState().hiddenInput;
    expect(hiddenInput).toBeTruthy();

    const documentKeydown = vi.fn();
    document.addEventListener('keydown', documentKeydown);

    try {
      const escapeEvent = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      });
      hiddenInput?.dispatchEvent(escapeEvent);

      expect(escapeEvent.defaultPrevented).toBe(true);
      expect(mockInputManager.sendInput).toHaveBeenCalledWith('escape');
      expect(documentKeydown).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', documentKeydown);
    }
  });

  it.each([
    ['Enter', false, 'enter'],
    ['Tab', false, 'tab'],
    ['Tab', true, 'shift_tab'],
    ['Escape', false, 'escape'],
    ['ArrowUp', false, 'arrow_up'],
    ['ArrowDown', false, 'arrow_down'],
    ['ArrowLeft', false, 'arrow_left'],
    ['ArrowRight', false, 'arrow_right'],
    ['PageUp', false, 'page_up'],
    ['PageDown', false, 'page_down'],
    ['Home', false, 'home'],
    ['End', false, 'end'],
    ['Delete', false, 'delete'],
  ])('routes hardware %s from the hidden input', (key, shiftKey, expected) => {
    const hiddenInput = getManagerState().hiddenInput;
    const keyEvent = new KeyboardEvent('keydown', {
      key,
      shiftKey,
      bubbles: true,
      cancelable: true,
    });

    hiddenInput?.dispatchEvent(keyEvent);

    expect(keyEvent.defaultPrevented).toBe(true);
    expect(mockInputManager.sendInput).toHaveBeenCalledWith(expected);
  });

  it('preserves browser shortcuts from the hidden input', () => {
    const hiddenInput = getManagerState().hiddenInput;
    vi.mocked(mockInputManager.isKeyboardShortcut).mockReturnValueOnce(true);
    const keyEvent = new KeyboardEvent('keydown', {
      key: 'ArrowLeft',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });

    hiddenInput?.dispatchEvent(keyEvent);

    expect(keyEvent.defaultPrevented).toBe(false);
    expect(mockInputManager.sendInput).not.toHaveBeenCalled();
  });

  describe('focus gate', () => {
    let keyboardLocked = false;

    const setKeyboardHeight = (height: number) => {
      const callbacks: Partial<DirectKeyboardCallbacks> = {
        getShowCtrlAlpha: () => false,
        getDisableFocusManagement: () => false,
        getVisualViewportHandler: () => null,
        getKeyboardHeight: () => height,
        getShowMobileInput: () => false,
        setKeyboardHeight: () => {},
        updateShowQuickKeys: () => {},
        toggleCtrlAlpha: () => {},
        clearCtrlSequence: () => {},
        getChatMode: () => false,
        getKeyboardLocked: () => keyboardLocked,
      };
      manager.setCallbacks(callbacks as DirectKeyboardCallbacks);
    };

    beforeEach(() => {
      keyboardLocked = false;
    });

    // Always-granted reasons never consult keyboardMode or keyboard height.
    it.each<FocusReason>([
      'keyboard-button',
      'quick-key',
      'ctrl-sequence',
      'paste',
    ])('always grants %s regardless of keyboard mode or visibility', (reason) => {
      setKeyboardHeight(0);
      getManagerState().keyboardMode = false;
      expect(getManagerState().requestHiddenInputFocus(reason)).toBe(true);

      getManagerState().keyboardMode = true;
      expect(getManagerState().requestHiddenInputFocus(reason)).toBe(true);
    });

    it('never grants terminal-tap', () => {
      setKeyboardHeight(300);
      getManagerState().keyboardMode = true;
      expect(getManagerState().requestHiddenInputFocus('terminal-tap')).toBe(false);

      getManagerState().keyboardMode = false;
      expect(getManagerState().requestHiddenInputFocus('terminal-tap')).toBe(false);
    });

    it.each<FocusReason>([
      'retention',
      'blur-recover',
    ])('denies %s when keyboard mode is off', (reason) => {
      setKeyboardHeight(300);
      getManagerState().keyboardMode = false;
      expect(getManagerState().requestHiddenInputFocus(reason)).toBe(false);
    });

    it.each<FocusReason>([
      'retention',
      'blur-recover',
    ])('grants %s when keyboard mode is on and the keyboard is still visible', (reason) => {
      setKeyboardHeight(300);
      getManagerState().keyboardMode = true;
      expect(getManagerState().requestHiddenInputFocus(reason)).toBe(true);
      expect(getManagerState().keyboardMode).toBe(true);
    });

    it.each<FocusReason>([
      'retention',
      'blur-recover',
    ])('treats %s as a user dismiss when the keyboard is gone and no quick key explains it', (reason) => {
      setKeyboardHeight(0);
      getManagerState().keyboardMode = true;
      getManagerState().lastQuickKeyTimestamp = Date.now() - 1000; // well past the grace window

      expect(getManagerState().requestHiddenInputFocus(reason)).toBe(false);
      // Dismiss means dismiss: the gate exits keyboard mode and stops retention.
      expect(getManagerState().keyboardMode).toBe(false);
    });

    it.each<FocusReason>([
      'retention',
      'blur-recover',
    ])('grants %s when the keyboard height dip is within the recent quick-key grace window', (reason) => {
      setKeyboardHeight(0);
      getManagerState().keyboardMode = true;
      getManagerState().lastQuickKeyTimestamp = Date.now();

      expect(getManagerState().requestHiddenInputFocus(reason)).toBe(true);
      expect(getManagerState().keyboardMode).toBe(true);
    });

    it.each<FocusReason>([
      'keyboard-button',
      'quick-key',
      'ctrl-sequence',
      'paste',
      'retention',
      'blur-recover',
      'terminal-tap',
    ])('denies %s when locked, regardless of keyboard mode', (reason) => {
      setKeyboardHeight(300);
      keyboardLocked = true;
      getManagerState().keyboardMode = true;
      expect(getManagerState().requestHiddenInputFocus(reason)).toBe(false);
    });
  });

  describe('keyboard lock', () => {
    const lockCallbacks = (locked: boolean): Partial<DirectKeyboardCallbacks> => ({
      getShowCtrlAlpha: () => false,
      getDisableFocusManagement: () => false,
      getVisualViewportHandler: () => null,
      getKeyboardHeight: () => 0,
      getShowMobileInput: () => false,
      setKeyboardHeight: () => {},
      updateShowQuickKeys: () => {},
      toggleCtrlAlpha: () => {},
      clearCtrlSequence: () => {},
      getChatMode: () => false,
      getKeyboardLocked: () => locked,
    });

    it('focusHiddenInput is a no-op when locked', () => {
      manager.setCallbacks(lockCallbacks(true) as DirectKeyboardCallbacks);

      manager.focusHiddenInput(true);

      expect(getManagerState().keyboardMode).toBe(false);
    });

    it('ensureHiddenInputVisible does not focus or show quick keys when locked', () => {
      manager.setCallbacks(lockCallbacks(true) as DirectKeyboardCallbacks);
      getManagerState().keyboardMode = true;

      const hiddenInput = getManagerState().hiddenInput;
      const focusSpy = hiddenInput ? vi.spyOn(hiddenInput, 'focus') : null;

      manager.ensureHiddenInputVisible();

      expect(focusSpy).not.toHaveBeenCalled();
      expect(manager.getShowQuickKeys()).toBe(false);
    });

    it('createHiddenInput sets inputmode="none" when locked, "text" when unlocked', () => {
      // ensureHiddenInputVisible(forceRecreate) is the direct path that destroys and
      // rebuilds the input; it runs the creation step before its own lock early-return,
      // so a recreate that happens to land while locked still comes out inert.
      manager.setCallbacks(lockCallbacks(true) as DirectKeyboardCallbacks);
      manager.ensureHiddenInputVisible(true);
      expect(getManagerState().hiddenInput?.getAttribute('inputmode')).toBe('none');

      manager.setCallbacks(lockCallbacks(false) as DirectKeyboardCallbacks);
      manager.ensureHiddenInputVisible(true);
      expect(getManagerState().hiddenInput?.getAttribute('inputmode')).toBe('text');
    });

    it('setKeyboardLocked(true) blurs the input and sets inputmode="none"', () => {
      manager.setCallbacks(lockCallbacks(false) as DirectKeyboardCallbacks);
      getManagerState().keyboardMode = true;

      manager.setKeyboardLocked(true);

      expect(getManagerState().keyboardMode).toBe(false);
      expect(getManagerState().hiddenInput?.getAttribute('inputmode')).toBe('none');
    });

    it('setKeyboardLocked(false) flips inputmode back without focusing', () => {
      manager.setCallbacks(lockCallbacks(false) as DirectKeyboardCallbacks);
      const hiddenInput = getManagerState().hiddenInput;
      const focusSpy = hiddenInput ? vi.spyOn(hiddenInput, 'focus') : null;

      manager.setKeyboardLocked(true);
      manager.setKeyboardLocked(false);

      expect(getManagerState().hiddenInput?.getAttribute('inputmode')).toBe('text');
      expect(focusSpy).not.toHaveBeenCalled();
    });
  });
});
