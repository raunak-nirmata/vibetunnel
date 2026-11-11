// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../../shared/types.js';
import { ConnectionManager } from './connection-manager.js';

type SubscribeOpts = {
  stdout?: boolean;
  events?: boolean;
  onStdout?: (data: Uint8Array) => void;
  onEvent?: (data: unknown) => void;
  onError?: (message: string) => void;
};

let lastSubscribeOpts: SubscribeOpts | null = null;

vi.mock('../../services/terminal-socket-client.js', () => ({
  terminalSocketClient: {
    subscribe: (_sessionId: string, opts: SubscribeOpts) => {
      lastSubscribeOpts = opts;
      return () => {};
    },
  },
}));

describe('ConnectionManager - header handling', () => {
  let manager: ConnectionManager;
  let terminal: { write: ReturnType<typeof vi.fn>; reset: ReturnType<typeof vi.fn> };
  let session: Session;

  beforeEach(() => {
    lastSubscribeOpts = null;
    manager = new ConnectionManager(
      () => {},
      () => {}
    );
    terminal = { write: vi.fn(), reset: vi.fn() };
    session = { id: 'test-session' } as Session;

    manager.setTerminal(terminal as unknown as Parameters<ConnectionManager['setTerminal']>[0]);
    manager.setSession(session);
    manager.setConnected(true);
    manager.connectToStream();
  });

  it('resets the terminal and drops buffered output on a header event', async () => {
    expect(lastSubscribeOpts).not.toBeNull();

    // Buffer some stdout, but don't let the 16ms batch timer flush it yet.
    lastSubscribeOpts?.onStdout?.(new TextEncoder().encode('stale output'));

    lastSubscribeOpts?.onEvent?.({ kind: 'header', header: { version: 2, width: 80, height: 24 } });

    expect(terminal.reset).toHaveBeenCalledTimes(1);

    // The buffered chunk from before the header must never reach terminal.write,
    // even once the batch timer would otherwise have fired.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(terminal.write).not.toHaveBeenCalled();

    // Output after the header flushes normally.
    lastSubscribeOpts?.onStdout?.(new TextEncoder().encode('fresh output'));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(terminal.write).toHaveBeenCalledWith('fresh output', true);
  });
});
