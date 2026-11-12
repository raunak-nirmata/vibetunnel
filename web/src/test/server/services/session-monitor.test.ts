import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it } from 'vitest';
import { SessionMonitor } from '../../../server/services/session-monitor.js';

// Minimal fake PtyManager: SessionMonitor only needs `on` (EventEmitter) and `getSession`
class FakePtyManager extends EventEmitter {
  getSession(_sessionId: string) {
    return { command: ['bash'], workingDir: '/tmp', pid: 1 };
  }
}

describe('SessionMonitor bell detection', () => {
  let ptyManager: FakePtyManager;
  let monitor: SessionMonitor;
  const sessionId = 'test-session';

  beforeEach(() => {
    ptyManager = new FakePtyManager();
    // biome-ignore lint/suspicious/noExplicitAny: fake only implements the methods SessionMonitor uses
    monitor = new SessionMonitor(ptyManager as any);
    ptyManager.emit('sessionStarted', sessionId, 'test-session-name');
  });

  function bellEvents(): unknown[] {
    const events: unknown[] = [];
    monitor.on('notification', (event) => {
      if (event.type === 'bell') events.push(event);
    });
    return events;
  }

  it('does not emit bell for an OSC 0 title update terminated by BEL', () => {
    const events = bellEvents();
    monitor.trackPtyOutput(sessionId, '\x1b]0;claude (~/Projects/foo)\x07');
    expect(events).toHaveLength(0);
  });

  it('does not emit bell for an OSC 52 clipboard payload terminated by BEL', () => {
    const events = bellEvents();
    monitor.trackPtyOutput(sessionId, '\x1b]52;c;SGVsbG8gd29ybGQ=\x07');
    expect(events).toHaveLength(0);
  });

  it('does not emit bell for an OSC sequence split across two chunks', () => {
    const events = bellEvents();
    monitor.trackPtyOutput(sessionId, '\x1b]0;claude (~/Projects/');
    monitor.trackPtyOutput(sessionId, 'foo)\x07rest of output');
    expect(events).toHaveLength(0);
  });

  it('does not emit bell for an ST-terminated OSC sequence', () => {
    const events = bellEvents();
    monitor.trackPtyOutput(sessionId, '\x1b]0;claude (~/Projects/foo)\x1b\\rest');
    expect(events).toHaveLength(0);
  });

  it('emits exactly one bell for a bare BEL after text', () => {
    const events = bellEvents();
    monitor.trackPtyOutput(sessionId, 'some output\x07');
    expect(events).toHaveLength(1);
  });

  it('emits a bell even when preceded by an unrelated completed OSC sequence', () => {
    const events = bellEvents();
    monitor.trackPtyOutput(sessionId, '\x1b]0;title\x07plain bell here\x07');
    // One bell from the OSC terminator is ignored, the trailing bare BEL is genuine
    expect(events).toHaveLength(1);
  });

  it('does not emit bell for a long OSC 52 payload split across many chunks', () => {
    const events = bellEvents();
    monitor.trackPtyOutput(sessionId, '\x1b]52;c;');
    for (let i = 0; i < 50; i++) {
      monitor.trackPtyOutput(sessionId, 'QQ'.repeat(50));
    }
    monitor.trackPtyOutput(sessionId, '\x07done');
    expect(events).toHaveLength(0);
  });

  it('ignores an unknown session id without throwing', () => {
    expect(() => monitor.trackPtyOutput('unknown-session', '\x07')).not.toThrow();
  });
});
