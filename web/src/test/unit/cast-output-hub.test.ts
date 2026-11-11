import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AsciinemaWriter } from '../../server/pty/asciinema-writer.js';
import { SessionManager } from '../../server/pty/session-manager.js';
import type { AsciinemaHeader } from '../../server/pty/types.js';
import { CastOutputHub } from '../../server/services/cast-output-hub.js';

type CollectedEvent =
  | { kind: 'header'; header: AsciinemaHeader }
  | { kind: 'output'; data: string }
  | { kind: 'resize'; dimensions: string }
  | { kind: 'exit'; exitCode: number }
  | { kind: 'error'; message: string };

describe('CastOutputHub - replay from screen switch', () => {
  let tempDir: string;
  let sessionManager: SessionManager;
  let castOutputHub: CastOutputHub;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-output-hub-test-'));
    sessionManager = new SessionManager(tempDir);
    castOutputHub = new CastOutputHub(sessionManager);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function ensureSessionInfo(sessionId: string, lastClearOffset = 0) {
    sessionManager.createSessionDirectory(sessionId);
    sessionManager.saveSessionInfo(sessionId, {
      id: sessionId,
      name: 'test',
      command: ['bash'],
      workingDir: tempDir,
      status: 'running',
      startedAt: new Date().toISOString(),
      lastClearOffset,
    });
  }

  function writeCastFile(
    sessionId: string,
    header: AsciinemaHeader,
    events: Array<[number | 'exit', string | number, string?]>
  ): string {
    ensureSessionInfo(sessionId);
    const paths = sessionManager.getSessionPaths(sessionId, true);
    if (!paths) throw new Error('session paths not found');
    const lines = [JSON.stringify(header), ...events.map((e) => JSON.stringify(e))];
    fs.writeFileSync(paths.stdoutPath, `${lines.join('\n')}\n`);
    return paths.stdoutPath;
  }

  async function collectEvents(sessionId: string, timeoutMs = 250): Promise<CollectedEvent[]> {
    const events: CollectedEvent[] = [];
    const unsubscribe = castOutputHub.subscribe(sessionId, (event) => {
      if (event.kind === 'header') events.push({ kind: 'header', header: event.header });
      else if (event.kind === 'output') events.push({ kind: 'output', data: event.data });
      else if (event.kind === 'resize')
        events.push({ kind: 'resize', dimensions: event.dimensions });
      else if (event.kind === 'exit') events.push({ kind: 'exit', exitCode: event.exitCode });
      else if (event.kind === 'error') events.push({ kind: 'error', message: event.message });
    });
    await new Promise((resolve) => setTimeout(resolve, timeoutMs));
    unsubscribe();
    return events;
  }

  function outputData(events: CollectedEvent[]): string[] {
    return events
      .filter((e): e is { kind: 'output'; data: string } => e.kind === 'output')
      .map((e) => e.data);
  }

  it('replays the clear event itself, sliced from the sequence onward', async () => {
    writeCastFile('basic-clear', { version: 2, width: 80, height: 24 }, [
      [0, 'o', 'stale banner\r\n'],
      [0.1, 'o', '[?1049h[2J[Hfresh screen\r\n'],
      [0.2, 'o', 'more fresh content\r\n'],
    ]);

    const events = await collectEvents('basic-clear');
    const outputs = outputData(events);

    expect(outputs.length).toBe(2);
    expect(outputs[0]).toBe('[?1049h[2J[Hfresh screen\r\n');
    expect(outputs[1]).toBe('more fresh content\r\n');
    expect(outputs.join('')).not.toContain('stale banner');
  });

  it('carries a mode preamble when the replay window starts after the last screen switch', async () => {
    const REPLAY_MAX_BYTES = 2 * 1024 * 1024;
    const header: AsciinemaHeader = { version: 2, width: 80, height: 24 };
    const switchLine: [number, string, string] = [0, 'o', '[?1049h[?1000h[?1002h[?1003h[?1006h'];

    // Enough filler after the switch to push it outside the 2 MB replay window,
    // with no further clear sequence so the window can't just start at a later one.
    const fillerLine = `x`.repeat(500) + '\r\n';
    const fillerCount = Math.ceil((REPLAY_MAX_BYTES * 1.5) / (fillerLine.length + 20));
    const events: Array<[number, string, string]> = [switchLine];
    for (let i = 0; i < fillerCount; i++) {
      events.push([1 + i, 'o', fillerLine]);
    }

    writeCastFile('mid-file-switch', header, events);

    const collected = await collectEvents('mid-file-switch', 1000);
    const outputs = outputData(collected);

    // Synthetic preamble: alternate screen plus every mouse mode seen in the skipped region.
    expect(outputs[0]).toBe('[?1049h');
    expect(outputs.slice(1, 5)).toEqual(['[?1000h', '[?1002h', '[?1003h', '[?1006h']);
    // The rest is filler, none of it the raw switch line itself (that fell outside the window).
    expect(outputs.slice(5).every((d) => d === fillerLine)).toBe(true);
  });

  it('replays the last 2 MB of a 3 MB cast, starting on a line boundary', async () => {
    const header: AsciinemaHeader = { version: 2, width: 80, height: 24 };
    const line = `y`.repeat(998) + '\r\n'; // ~1000 bytes of payload once JSON-escaped-ish
    const totalTargetBytes = 3 * 1024 * 1024;
    const events: Array<[number, string, string]> = [];
    let approxBytes = 0;
    let t = 0;
    while (approxBytes < totalTargetBytes + 200 * 1024) {
      events.push([t, 'o', line]);
      approxBytes += line.length + 20;
      t += 1;
    }

    const streamPath = writeCastFile('big-file', header, events);
    const sizeBefore = fs.statSync(streamPath).size;
    expect(sizeBefore).toBeGreaterThan(totalTargetBytes);

    const collected = await collectEvents('big-file', 1500);
    const outputs = outputData(collected);

    // No partial/garbled first line: every replayed line is the exact filler line.
    expect(outputs.length).toBeGreaterThan(0);
    for (const data of outputs) {
      expect(data).toBe(line);
    }

    const totalReplayedBytes = outputs.reduce((sum, d) => sum + Buffer.byteLength(d, 'utf8'), 0);
    expect(totalReplayedBytes).toBeLessThan(2 * 1024 * 1024 + line.length);
    expect(totalReplayedBytes).toBeGreaterThan(0);
  });

  it('gives a late joiner the same replay as the first subscriber', async () => {
    writeCastFile('late-joiner', { version: 2, width: 80, height: 24 }, [
      [0, 'o', 'stale\r\n'],
      [0.1, 'o', '[?1049h[2J[Hfresh\r\n'],
      [0.2, 'o', 'tail\r\n'],
    ]);

    const firstEvents: CollectedEvent[] = [];
    const unsubscribeFirst = castOutputHub.subscribe('late-joiner', (event) => {
      if (event.kind === 'header') firstEvents.push({ kind: 'header', header: event.header });
      else if (event.kind === 'output') firstEvents.push({ kind: 'output', data: event.data });
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    const secondEvents: CollectedEvent[] = [];
    const unsubscribeSecond = castOutputHub.subscribe('late-joiner', (event) => {
      if (event.kind === 'header') secondEvents.push({ kind: 'header', header: event.header });
      else if (event.kind === 'output') secondEvents.push({ kind: 'output', data: event.data });
    });

    await new Promise((resolve) => setTimeout(resolve, 150));
    unsubscribeFirst();
    unsubscribeSecond();

    expect(outputData(secondEvents)).toEqual(outputData(firstEvents));
    expect(outputData(firstEvents).join('')).not.toContain('stale');
  });

  it('agrees with the writer on the byte offset for the same file, and lands on a line boundary', async () => {
    const paths = sessionManager.createSessionDirectory('writer-agreement');
    ensureSessionInfo('writer-agreement');

    const writer = AsciinemaWriter.create(paths.stdoutPath, 80, 24, 'bash');
    let reportedPosition: number | null = null;
    writer.onPruningSequence(({ position }) => {
      reportedPosition = position;
    });

    writer.writeOutput(Buffer.from('stale banner\r\n'));
    writer.writeOutput(Buffer.from('[?1049h[2J[Hfresh screen\r\n'));
    writer.writeOutput(Buffer.from('tail content\r\n'));
    await writer.close();

    expect(reportedPosition).not.toBeNull();
    const position = reportedPosition as unknown as number;

    // The writer's reported offset must be a line start.
    const fileContents = fs.readFileSync(paths.stdoutPath);
    expect(position === 0 || fileContents[position - 1] === 0x0a).toBe(true);

    // Force a full rescan from offset 0 and confirm the hub's retroactive scan agrees.
    ensureSessionInfo('writer-agreement', 0);
    await collectEvents('writer-agreement', 200);

    const sessionInfo = sessionManager.loadSessionInfo('writer-agreement');
    expect(sessionInfo?.lastClearOffset).toBe(position);
  });
});
