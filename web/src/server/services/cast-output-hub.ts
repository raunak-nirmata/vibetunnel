import chalk from 'chalk';
import * as fs from 'fs';
import type { SessionManager } from '../pty/session-manager.js';
import type { AsciinemaHeader } from '../pty/types.js';
import { createLogger } from '../utils/logger.js';
import { detectLastPruningSequence, logPruningDetection } from '../utils/pruning-detector.js';

const logger = createLogger('cast-output-hub');

const HEADER_READ_BUFFER_SIZE = 4096;

// Cap how much of the cast we replay, counted back from the end of the file.
// Bounds replay time for normal-screen sessions that never clear (shells, build logs).
const REPLAY_MAX_BYTES = 2 * 1024 * 1024;

// Mode sequences the client needs to know about even when the window that carried
// them is outside the replay cap; without these a resumed client can't tell mouse
// tracking or kitty keyboard mode is on.
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences are necessary for terminal output
const MOUSE_MODE_RE = /\x1b\[\?(1000|1002|1003|1006)h/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences are necessary for terminal output
const KITTY_KEYBOARD_PUSH_RE = /\x1b\[>\d+u/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences are necessary for terminal output
const SCREEN_SWITCH_RE = /\x1b\[\?1049([hl])/g;

type AsciinemaOutputEvent = [number, 'o', string];
type AsciinemaInputEvent = [number, 'i', string];
type AsciinemaResizeEvent = [number, 'r', string];
type AsciinemaExitEvent = ['exit', number, string];
type AsciinemaEvent =
  | AsciinemaOutputEvent
  | AsciinemaInputEvent
  | AsciinemaResizeEvent
  | AsciinemaExitEvent;

function isOutputEvent(event: AsciinemaEvent): event is AsciinemaOutputEvent {
  return (
    Array.isArray(event) && event.length === 3 && event[1] === 'o' && typeof event[0] === 'number'
  );
}

function isResizeEvent(event: AsciinemaEvent): event is AsciinemaResizeEvent {
  return (
    Array.isArray(event) && event.length === 3 && event[1] === 'r' && typeof event[0] === 'number'
  );
}

function isExitEvent(event: AsciinemaEvent): event is AsciinemaExitEvent {
  return Array.isArray(event) && event[0] === 'exit';
}

export type CastOutputHubEvent =
  | { kind: 'header'; header: AsciinemaHeader }
  | { kind: 'output'; data: string; historical: boolean }
  | { kind: 'resize'; dimensions: string; historical: boolean }
  | { kind: 'exit'; exitCode: number }
  | { kind: 'error'; message: string };

export type CastOutputHubListener = (event: CastOutputHubEvent) => void;

interface WatcherInfo {
  streamPath: string;
  clients: Set<CastOutputHubListener>;
  watcher?: fs.FSWatcher;
  lastOffset: number;
  lastSize: number;
  lastMtime: number;
  lineBuffer: string;
  retryTimer?: NodeJS.Timeout;
}

export class CastOutputHub {
  private activeWatchers: Map<string, WatcherInfo> = new Map();

  constructor(private sessionManager: SessionManager) {
    process.on('beforeExit', () => this.cleanup());
  }

  subscribe(sessionId: string, listener: CastOutputHubListener): () => void {
    const paths = this.sessionManager.getSessionPaths(sessionId, true);
    if (!paths) {
      listener({ kind: 'error', message: 'Session paths not found' });
      return () => {};
    }

    const streamPath = paths.stdoutPath;
    let watcherInfo = this.activeWatchers.get(sessionId);

    if (!watcherInfo) {
      watcherInfo = {
        streamPath,
        clients: new Set(),
        lastOffset: 0,
        lastSize: 0,
        lastMtime: 0,
        lineBuffer: '',
      };
      this.activeWatchers.set(sessionId, watcherInfo);

      // Send existing content (pruned) to the first subscriber.
      this.sendExistingContent(sessionId, streamPath, listener);

      // Initialize offsets if file exists.
      if (fs.existsSync(streamPath)) {
        const stats = fs.statSync(streamPath);
        watcherInfo.lastOffset = stats.size;
        watcherInfo.lastSize = stats.size;
        watcherInfo.lastMtime = stats.mtimeMs;
      }

      // Start watching (or retry until file exists).
      this.startWatchingWithRetry(sessionId, watcherInfo);
    } else {
      // Send pruned existing content to late joiners too.
      this.sendExistingContent(sessionId, watcherInfo.streamPath, listener);
    }

    watcherInfo.clients.add(listener);

    return () => {
      const current = this.activeWatchers.get(sessionId);
      if (!current) return;
      current.clients.delete(listener);

      if (current.clients.size === 0) {
        this.stopWatching(sessionId);
      }
    };
  }

  private stopWatching(sessionId: string) {
    const watcherInfo = this.activeWatchers.get(sessionId);
    if (!watcherInfo) return;

    watcherInfo.retryTimer && clearTimeout(watcherInfo.retryTimer);
    watcherInfo.watcher?.close();
    watcherInfo.watcher = undefined;
    this.activeWatchers.delete(sessionId);
    logger.debug(chalk.yellow(`stopped cast watcher for session ${sessionId}`));
  }

  private startWatchingWithRetry(sessionId: string, watcherInfo: WatcherInfo) {
    if (watcherInfo.watcher) return;

    if (!fs.existsSync(watcherInfo.streamPath)) {
      watcherInfo.retryTimer = setTimeout(() => {
        watcherInfo.retryTimer = undefined;
        this.startWatchingWithRetry(sessionId, watcherInfo);
      }, 200);
      return;
    }

    this.startWatching(sessionId, watcherInfo);
  }

  private startWatching(sessionId: string, watcherInfo: WatcherInfo): void {
    watcherInfo.watcher = fs.watch(watcherInfo.streamPath, { persistent: true }, (eventType) => {
      if (eventType !== 'change') return;

      try {
        const stats = fs.statSync(watcherInfo.streamPath);
        if (!(stats.size > watcherInfo.lastSize || stats.mtimeMs > watcherInfo.lastMtime)) return;

        watcherInfo.lastSize = stats.size;
        watcherInfo.lastMtime = stats.mtimeMs;

        if (stats.size <= watcherInfo.lastOffset) return;

        const fd = fs.openSync(watcherInfo.streamPath, 'r');
        const buffer = Buffer.alloc(stats.size - watcherInfo.lastOffset);
        fs.readSync(fd, buffer, 0, buffer.length, watcherInfo.lastOffset);
        fs.closeSync(fd);

        watcherInfo.lastOffset = stats.size;

        watcherInfo.lineBuffer += buffer.toString('utf8');
        const lines = watcherInfo.lineBuffer.split('\n');
        watcherInfo.lineBuffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          this.broadcastLine(sessionId, line, watcherInfo);
        }
      } catch (error) {
        logger.error(`failed to read file changes for session ${sessionId}:`, error);
      }
    });

    watcherInfo.watcher.on('error', (error) => {
      logger.error(`file watcher error for session ${sessionId}:`, error);
    });

    logger.debug(chalk.green(`watching cast file for session ${sessionId}`));
  }

  private parseAsciinemaLine(line: string): AsciinemaEvent | AsciinemaHeader | null {
    if (!line.trim()) return null;
    try {
      const parsed = JSON.parse(line);
      if (parsed.version && parsed.width && parsed.height) return parsed as AsciinemaHeader;
      if (Array.isArray(parsed)) {
        if (parsed[0] === 'exit') return parsed as AsciinemaExitEvent;
        if (parsed.length >= 3 && typeof parsed[0] === 'number') return parsed as AsciinemaEvent;
      }
      return null;
    } catch {
      return null;
    }
  }

  private broadcastLine(_sessionId: string, line: string, watcherInfo: WatcherInfo): void {
    const parsed = this.parseAsciinemaLine(line);
    if (!parsed) {
      // Treat as raw output line
      for (const client of watcherInfo.clients) {
        client({ kind: 'output', data: line, historical: false });
      }
      return;
    }

    // Skip headers during live follow (clients already got one from existing content).
    if (!Array.isArray(parsed)) return;

    if (isExitEvent(parsed)) {
      for (const client of watcherInfo.clients) {
        client({ kind: 'exit', exitCode: parsed[1] });
      }
      return;
    }

    if (isOutputEvent(parsed)) {
      for (const client of watcherInfo.clients) {
        client({ kind: 'output', data: parsed[2], historical: false });
      }
    } else if (isResizeEvent(parsed)) {
      for (const client of watcherInfo.clients) {
        client({ kind: 'resize', dimensions: parsed[2], historical: false });
      }
    }
  }

  /**
   * Find the byte offset of the first line that starts at or after `fromOffset`.
   * Used to land the replay window on a line boundary.
   */
  private findNextLineStart(streamPath: string, fromOffset: number, size: number): number {
    if (fromOffset <= 0) return 0;
    const fd = fs.openSync(streamPath, 'r');
    try {
      const bufSize = 64 * 1024;
      const buf = Buffer.alloc(bufSize);
      let pos = fromOffset;
      while (pos < size) {
        const toRead = Math.min(bufSize, size - pos);
        const bytesRead = fs.readSync(fd, buf, 0, toRead, pos);
        if (bytesRead <= 0) break;
        const idx = buf.subarray(0, bytesRead).indexOf(0x0a);
        if (idx !== -1) return pos + idx + 1;
        pos += bytesRead;
      }
      return size;
    } finally {
      fs.closeSync(fd);
    }
  }

  /**
   * Track mode state (screen switch, mouse tracking, kitty keyboard) from a line
   * that falls outside the replay window, so a synthetic preamble can restore it.
   */
  private trackPreWindowModeState(
    data: string,
    state: { screenSwitch: 'h' | 'l' | null; mouseModes: Set<string>; kittyPush: string | null }
  ): void {
    for (const match of data.matchAll(SCREEN_SWITCH_RE)) {
      state.screenSwitch = match[1] as 'h' | 'l';
    }
    for (const match of data.matchAll(MOUSE_MODE_RE)) {
      state.mouseModes.add(match[0]);
    }
    for (const match of data.matchAll(KITTY_KEYBOARD_PUSH_RE)) {
      state.kittyPush = match[0];
    }
  }

  private sendExistingContent(
    sessionId: string,
    streamPath: string,
    listener: CastOutputHubListener
  ) {
    try {
      const sessionInfo = this.sessionManager.loadSessionInfo(sessionId);
      let startOffset = sessionInfo?.lastClearOffset ?? 0;

      let size = 0;
      if (fs.existsSync(streamPath)) {
        size = fs.statSync(streamPath).size;
        startOffset = Math.min(startOffset, size);
      }

      // Read header line (best-effort)
      let header: AsciinemaHeader | null = null;
      let fd: number | null = null;
      try {
        fd = fs.openSync(streamPath, 'r');
        const buf = Buffer.alloc(HEADER_READ_BUFFER_SIZE);
        let data = '';
        let filePosition = 0;
        let bytesRead = fs.readSync(fd, buf, 0, buf.length, filePosition);

        while (!data.includes('\n') && bytesRead > 0) {
          data += buf.toString('utf8', 0, bytesRead);
          filePosition += bytesRead;
          if (!data.includes('\n')) {
            bytesRead = fs.readSync(fd, buf, 0, buf.length, filePosition);
          }
        }

        const idx = data.indexOf('\n');
        if (idx !== -1) header = JSON.parse(data.slice(0, idx));
      } catch {
        // ignore
      } finally {
        if (fd !== null) {
          try {
            fs.closeSync(fd);
          } catch {
            // ignore
          }
        }
      }

      // Window of the file we actually replay raw, capped to the last REPLAY_MAX_BYTES,
      // landed on a line boundary. Content between startOffset and windowStart is only
      // scanned for mode state, never buffered or sent verbatim.
      let windowStart = startOffset;
      const capCandidate = size - REPLAY_MAX_BYTES;
      if (capCandidate > startOffset) {
        windowStart = this.findNextLineStart(streamPath, capCandidate, size);
      }

      const analysisStream = fs.createReadStream(streamPath, {
        encoding: 'utf8',
        start: startOffset,
      });
      let lineBuffer = '';

      // Events at or after windowStart, buffered for replay.
      const events: AsciinemaEvent[] = [];
      // Index into `events` of the last clear sequence found inside the window, if any.
      let windowClearIndex = -1;
      let windowClearSliceIndex = 0;
      // Resize immediately before the in-window clear, for header dimensions.
      let resizeBeforeWindowClear: AsciinemaResizeEvent | null = null;
      // Resize most recently seen before windowStart, frozen once we cross it.
      let resizeBeforeWindowStart: AsciinemaResizeEvent | null = null;

      // Mode state tracked only from lines before windowStart, for the synthetic preamble.
      const preWindowState: {
        screenSwitch: 'h' | 'l' | null;
        mouseModes: Set<string>;
        kittyPush: string | null;
      } = { screenSwitch: null, mouseModes: new Set(), kittyPush: null };

      // Global last-clear position across the whole scanned range, persisted regardless
      // of the replay window, so the next subscriber starts from the true last clear.
      let fileOffset = startOffset;
      let lastClearOffset = startOffset;

      const processLine = (line: string) => {
        const lineStart = fileOffset;
        fileOffset += Buffer.byteLength(line, 'utf8') + 1;
        if (!line.trim()) return;

        try {
          const parsed = JSON.parse(line);
          if (parsed.version && parsed.width && parsed.height) {
            header = parsed as AsciinemaHeader;
            return;
          }

          if (!Array.isArray(parsed)) return;

          const inWindow = lineStart >= windowStart;

          if (parsed[0] === 'exit') {
            if (inWindow) events.push(parsed as AsciinemaExitEvent);
            return;
          }

          if (parsed.length < 3 || typeof parsed[0] !== 'number') return;
          const event = parsed as AsciinemaEvent;

          if (isResizeEvent(event) && !inWindow) {
            resizeBeforeWindowStart = event;
          }

          if (inWindow) events.push(event);

          if (isOutputEvent(event)) {
            const detection = detectLastPruningSequence(event[2]);
            if (detection) {
              lastClearOffset = lineStart;
              logPruningDetection(detection.sequence, lineStart, '(retroactive scan)');

              if (inWindow) {
                windowClearIndex = events.length - 1;
                windowClearSliceIndex = detection.index;
              }
            }

            if (!inWindow) {
              this.trackPreWindowModeState(event[2], preWindowState);
            }
          }
        } catch {
          // ignore invalid lines
        }
      };

      analysisStream.on('data', (chunk: string | Buffer) => {
        lineBuffer += chunk.toString();
        let idx = lineBuffer.indexOf('\n');
        while (idx !== -1) {
          const line = lineBuffer.slice(0, idx);
          lineBuffer = lineBuffer.slice(idx + 1);
          processLine(line);
          idx = lineBuffer.indexOf('\n');
        }
      });

      analysisStream.on('end', () => {
        if (lineBuffer.trim()) {
          // last line without trailing newline
          processLine(lineBuffer);
        }

        if (sessionInfo && lastClearOffset !== startOffset) {
          sessionInfo.lastClearOffset = lastClearOffset;
          this.sessionManager.saveSessionInfo(sessionId, sessionInfo);
        }

        let startIndex = 0;
        const preamble: string[] = [];
        let lastResizeBeforeClear: AsciinemaResizeEvent | null = null;

        if (windowClearIndex >= 0) {
          // A clear fell inside the window: replay from it, sliced to the sequence itself.
          startIndex = windowClearIndex;
          const clearEvent = events[windowClearIndex] as AsciinemaOutputEvent;
          events[windowClearIndex] = [
            clearEvent[0],
            'o',
            clearEvent[2].slice(windowClearSliceIndex),
          ];
          for (let i = windowClearIndex - 1; i >= 0; i--) {
            if (isResizeEvent(events[i])) {
              resizeBeforeWindowClear = events[i] as AsciinemaResizeEvent;
              break;
            }
          }
          lastResizeBeforeClear = resizeBeforeWindowClear;
        } else if (windowStart > startOffset) {
          // The cap moved the start past the last clear: synthesize the mode state the
          // client would otherwise never learn about.
          if (preWindowState.screenSwitch === 'h') preamble.push('\x1b[?1049h');
          for (const seq of preWindowState.mouseModes) preamble.push(seq);
          if (preWindowState.kittyPush) preamble.push(preWindowState.kittyPush);
          lastResizeBeforeClear = resizeBeforeWindowStart;
        }

        if (header) {
          const headerToSend = { ...header };
          if (lastResizeBeforeClear) {
            const [w, h] = lastResizeBeforeClear[2].split('x');
            headerToSend.width = Number.parseInt(w, 10);
            headerToSend.height = Number.parseInt(h, 10);
          }
          listener({ kind: 'header', header: headerToSend });
        }

        for (const seq of preamble) {
          listener({ kind: 'output', data: seq, historical: true });
        }

        for (let i = startIndex; i < events.length; i++) {
          const event = events[i];
          if (isExitEvent(event)) {
            listener({ kind: 'exit', exitCode: event[1] });
          } else if (isOutputEvent(event)) {
            listener({ kind: 'output', data: event[2], historical: true });
          } else if (isResizeEvent(event)) {
            listener({ kind: 'resize', dimensions: event[2], historical: true });
          }
        }
      });

      analysisStream.on('error', (error) => {
        logger.error(`failed to read existing cast content for ${sessionId}:`, error);
        listener({ kind: 'error', message: 'Failed to read session output' });
      });
    } catch (error) {
      logger.error(`failed to send existing cast content for ${sessionId}:`, error);
      listener({ kind: 'error', message: 'Failed to read session output' });
    }
  }

  private cleanup(): void {
    for (const [sessionId] of this.activeWatchers) {
      this.stopWatching(sessionId);
    }
  }
}
