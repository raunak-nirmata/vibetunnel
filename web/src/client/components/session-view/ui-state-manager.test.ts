/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { restoreLocalStorage, setupLocalStorageMock } from '../../../test/utils/component-helpers';
import { UIStateManager } from './ui-state-manager';

describe('UIStateManager', () => {
  let manager: UIStateManager;

  beforeEach(() => {
    setupLocalStorageMock();
    manager = new UIStateManager();
  });

  afterEach(() => {
    restoreLocalStorage();
  });

  describe('keyboardLocked', () => {
    it('defaults to false with no stored preferences', () => {
      manager.loadDirectKeyboardPreference();
      expect(manager.getState().keyboardLocked).toBe(false);
    });

    it('defaults to false on a malformed preferences blob', () => {
      localStorage.setItem('vibetunnel_app_preferences', '{not json');
      manager.loadDirectKeyboardPreference();
      expect(manager.getState().keyboardLocked).toBe(false);
    });

    it('persists the lock across reloads via a fresh manager instance', () => {
      manager.setKeyboardLocked(true);
      expect(manager.getState().keyboardLocked).toBe(true);

      const reloaded = new UIStateManager();
      reloaded.loadDirectKeyboardPreference();
      expect(reloaded.getState().keyboardLocked).toBe(true);
    });

    it('preserves useDirectKeyboard when only the lock changes', () => {
      manager.loadDirectKeyboardPreference();
      manager.toggleDirectKeyboard(); // false
      manager.setKeyboardLocked(true);

      const reloaded = new UIStateManager();
      reloaded.loadDirectKeyboardPreference();
      expect(reloaded.getState().useDirectKeyboard).toBe(false);
      expect(reloaded.getState().keyboardLocked).toBe(true);
    });

    it('unlocking persists false and does not touch other preferences', () => {
      manager.setKeyboardLocked(true);
      manager.setKeyboardLocked(false);

      const reloaded = new UIStateManager();
      reloaded.loadDirectKeyboardPreference();
      expect(reloaded.getState().keyboardLocked).toBe(false);
    });
  });
});
