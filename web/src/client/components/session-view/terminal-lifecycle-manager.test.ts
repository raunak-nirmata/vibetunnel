// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockSession } from '@/test/utils/lit-test-utils';
import type { Terminal } from '../terminal.js';
import { TerminalLifecycleManager } from './terminal-lifecycle-manager.js';

const terminalSocketClientMock = vi.hoisted(() => ({
  resize: vi.fn().mockReturnValue(true),
  release: vi.fn().mockReturnValue(true),
}));

vi.mock('../../services/terminal-socket-client.js', () => ({
  terminalSocketClient: terminalSocketClientMock,
}));

function resizeEvent(cols: number, rows: number, source = 'test') {
  return new CustomEvent('terminal-resize', { detail: { cols, rows, source } });
}

describe('TerminalLifecycleManager resize handling', () => {
  let manager: TerminalLifecycleManager;

  beforeEach(() => {
    vi.useFakeTimers();
    terminalSocketClientMock.resize.mockClear();
    manager = new TerminalLifecycleManager();
    manager.setSession(createMockSession({ status: 'running' }));
  });

  afterEach(() => {
    manager.cleanup();
    vi.useRealTimers();
  });

  it('sends a height-only mobile resize to the server', async () => {
    // First resize establishes the baseline (what used to be "first paint").
    manager.handleTerminalResize(resizeEvent(133, 42));
    vi.advanceTimersByTime(260);
    await vi.runAllTimersAsync();
    expect(terminalSocketClientMock.resize).toHaveBeenCalledWith(expect.any(String), 133, 42);

    terminalSocketClientMock.resize.mockClear();

    // Columns unchanged, rows changed - the height-only case the mobile code used to drop.
    manager.handleTerminalResize(resizeEvent(133, 20));
    vi.advanceTimersByTime(260);
    await vi.runAllTimersAsync();

    expect(terminalSocketClientMock.resize).toHaveBeenCalledWith(expect.any(String), 133, 20);
  });

  it('skips a redundant resize matching the cached dimensions', async () => {
    manager.handleTerminalResize(resizeEvent(100, 30));
    vi.advanceTimersByTime(260);
    await vi.runAllTimersAsync();
    terminalSocketClientMock.resize.mockClear();

    manager.handleTerminalResize(resizeEvent(100, 30));
    vi.advanceTimersByTime(260);
    await vi.runAllTimersAsync();

    expect(terminalSocketClientMock.resize).not.toHaveBeenCalled();
  });
});

describe('TerminalLifecycleManager resume path', () => {
  let manager: TerminalLifecycleManager;
  let fakeTerminal: Terminal;

  beforeEach(() => {
    vi.useFakeTimers();
    terminalSocketClientMock.resize.mockClear();
    terminalSocketClientMock.release.mockClear();
    manager = new TerminalLifecycleManager();
    manager.setSession(createMockSession({ status: 'running' }));
    manager.setupTerminal();
    fakeTerminal = { cols: 133, rows: 42 } as Terminal;
    manager.setTerminal(fakeTerminal);
  });

  afterEach(() => {
    manager.cleanup();
    vi.useRealTimers();
  });

  it('resends the current dimensions on visibilitychange to visible, even if unchanged', async () => {
    manager.handleTerminalResize(resizeEvent(133, 42));
    vi.advanceTimersByTime(260);
    await vi.runAllTimersAsync();
    terminalSocketClientMock.resize.mockClear();

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    document.dispatchEvent(new Event('visibilitychange'));

    vi.advanceTimersByTime(260);
    await vi.runAllTimersAsync();

    expect(terminalSocketClientMock.resize).toHaveBeenCalledWith(expect.any(String), 133, 42);
  });

  it('coalesces a resume with a same-tick dimension change into a single send of the newest size', async () => {
    manager.handleTerminalResize(resizeEvent(133, 42));
    vi.advanceTimersByTime(260);
    await vi.runAllTimersAsync();
    terminalSocketClientMock.resize.mockClear();

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    document.dispatchEvent(new Event('visibilitychange'));

    // ResizeObserver catches a real dimension change before the debounce fires.
    manager.handleTerminalResize(resizeEvent(133, 20));

    vi.advanceTimersByTime(260);
    await vi.runAllTimersAsync();

    expect(terminalSocketClientMock.resize).toHaveBeenCalledTimes(1);
    expect(terminalSocketClientMock.resize).toHaveBeenCalledWith(expect.any(String), 133, 20);
  });

  it('removes the resume and release listeners on cleanup', () => {
    const removeWindowSpy = vi.spyOn(window, 'removeEventListener');
    const removeDocSpy = vi.spyOn(document, 'removeEventListener');

    manager.cleanup();

    expect(removeWindowSpy).toHaveBeenCalledWith('pageshow', expect.any(Function));
    expect(removeWindowSpy).toHaveBeenCalledWith('pagehide', expect.any(Function));
    expect(removeDocSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function));

    removeWindowSpy.mockRestore();
    removeDocSpy.mockRestore();
  });

  it('sends exactly one RESIZE_RELEASE on visibilitychange to hidden', () => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    document.dispatchEvent(new Event('visibilitychange'));

    expect(terminalSocketClientMock.release).toHaveBeenCalledTimes(1);
    expect(terminalSocketClientMock.release).toHaveBeenCalledWith(expect.any(String));
  });

  it('sends a release on pagehide', () => {
    window.dispatchEvent(new Event('pagehide'));

    expect(terminalSocketClientMock.release).toHaveBeenCalledTimes(1);
  });
});
