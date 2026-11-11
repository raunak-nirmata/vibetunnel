/**
 * Terminal Component
 *
 * Browser terminal rendering + input via ghostty-web (WASM + canvas).
 *
 * @fires terminal-ready - When terminal is initialized and ready
 * @fires terminal-input - When user types (detail: { text: string })
 * @fires terminal-resize - When terminal is resized (detail: { cols: number, rows: number, source: string })
 * @fires terminal-tap - When a touch gesture qualifies as a tap (not a scroll/drag/long-press)
 */

import { FitAddon, Ghostty, Terminal as GhosttyTerminal } from 'ghostty-web';
import { html, LitElement, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { KeyboardShortcutLinkProvider } from '../utils/keyboard-shortcut-link-provider.js';
import { createLogger } from '../utils/logger.js';
import { TERMINAL_FONT_FAMILY, TERMINAL_IDS } from '../utils/terminal-constants.js';
import { TerminalPreferencesManager } from '../utils/terminal-preferences.js';
import { TERMINAL_THEMES, type TerminalThemeId } from '../utils/terminal-themes.js';
import { getCurrentTheme } from '../utils/theme-utils.js';

const logger = createLogger('terminal');

// Tap-vs-scroll gesture thresholds, tuned for iOS Safari's synthetic click after touchend.
const TAP_MAX_MOVEMENT_PX = 10;
const TAP_MAX_DURATION_MS = 350;
const TAP_CLICK_SUPPRESS_MS = 700;

let ghosttyPromise: Promise<Ghostty> | null = null;
async function ensureGhostty(): Promise<Ghostty> {
  if (!ghosttyPromise) ghosttyPromise = Ghostty.load('/ghostty-vt.wasm');
  return ghosttyPromise;
}

type TerminalResizeDetail = {
  cols: number;
  rows: number;
  source: string;
};

@customElement('vibe-terminal')
export class Terminal extends LitElement {
  createRenderRoot() {
    return this as unknown as HTMLElement;
  }

  @property({ type: String }) sessionId = '';
  @property({ type: String }) sessionStatus = 'running';
  @property({ type: Number }) cols = 80;
  @property({ type: Number }) rows = 24;
  @property({ type: Number }) fontSize = 14;
  @property({ type: Boolean }) fitHorizontally = false;
  @property({ type: Number }) maxCols = 0; // 0 = unlimited
  @property({ type: String }) theme: TerminalThemeId = 'auto';
  @property({ type: Boolean }) disableClick = false;
  @property({ type: Boolean }) hideScrollButton = false;
  @property({ type: Boolean }) keyboardLocked = false;
  @property({ type: Number }) initialCols = 0;
  @property({ type: Number }) initialRows = 0;

  private originalFontSize = 14;
  userOverrideWidth = false;

  @state() private followCursorEnabled = true;

  private container: HTMLElement | null = null;
  private terminal: GhosttyTerminal | null = null;
  private fitAddon: FitAddon | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private themeObserver: MutationObserver | null = null;
  private pasteInput: HTMLTextAreaElement | null = null;
  private pendingOutput = '';
  private pendingFollowCursor = true;
  private preservedScrollPosition: number | null = null;
  private touchStartX = 0;
  private touchStartY = 0;
  private lastTouchY = 0;
  private touchScrollRemainder = 0;
  private touchScrolling = false;
  private touchStartTime = 0;
  private touchSingleThroughout = true;
  private suppressClickUntil = 0;

  private lastCols = 0;
  private lastRows = 0;

  private pendingResizeSource: string | null = null;
  private initializationId = 0;

  connectedCallback() {
    const prefs = TerminalPreferencesManager.getInstance();
    this.theme = prefs.getTheme();
    super.connectedCallback();

    this.originalFontSize = this.fontSize;
    // Make host focusable so browser shortcuts (Cmd/Ctrl+V) have a target.
    if (this.tabIndex < 0) this.tabIndex = 0;

    // Restore user override preference
    if (this.sessionId) {
      this.restoreUserOverrideWidthFromStorage(this.sessionId);
    }

    // Watch for system theme changes (only when using auto theme)
    this.themeObserver = new MutationObserver(() => {
      if (this.terminal && this.theme === 'auto') {
        this.applyTheme();
      }
    });
    this.themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });

    if (this.hasUpdated && !this.terminal) {
      this.pasteInput = this.querySelector('.terminal-paste-input') as HTMLTextAreaElement | null;
      this.initializeTerminal();
    }
  }

  disconnectedCallback() {
    this.cleanup();
    this.themeObserver?.disconnect();
    this.themeObserver = null;
    super.disconnectedCallback();
  }

  firstUpdated() {
    this.pasteInput = this.querySelector('.terminal-paste-input') as HTMLTextAreaElement | null;
    this.initializeTerminal();
  }

  updated(changed: PropertyValues) {
    if (changed.has('sessionId') && this.sessionId) {
      this.restoreUserOverrideWidthFromStorage(this.sessionId);
      this.requestResize('session-id-change');
    }

    if (changed.has('fontSize')) {
      if (!this.fitHorizontally) this.originalFontSize = this.fontSize;
      this.applyFontSize();
      this.requestResize('font-size-change');
    }

    if (changed.has('fitHorizontally')) {
      if (!this.fitHorizontally) this.fontSize = this.originalFontSize;
      this.requestResize('fit-mode-change');
    }

    if (changed.has('maxCols') || changed.has('initialCols') || changed.has('disableClick')) {
      this.requestResize('property-change');
    }

    if (changed.has('theme')) {
      this.applyTheme();
    }

    // Engaging the lock must retract an already-open keyboard, not just prevent future ones:
    // flipping inputmode on a focused element doesn't dismiss iOS's current soft keyboard.
    if (changed.has('keyboardLocked') && this.keyboardLocked) {
      this.pasteInput?.blur();
    }
  }

  setUserOverrideWidth(override: boolean) {
    this.userOverrideWidth = override;

    if (this.sessionId) {
      try {
        localStorage.setItem(`terminal-width-override-${this.sessionId}`, String(override));
      } catch (error) {
        logger.warn('Failed to save terminal width preference to localStorage:', error);
      }
    }

    this.requestResize('user-override-width');
  }

  public handleFitToggle = () => {
    if (!this.fitHorizontally) this.originalFontSize = this.fontSize;
    this.fitHorizontally = !this.fitHorizontally;
    if (!this.fitHorizontally) this.fontSize = this.originalFontSize;
    this.requestResize('fit-toggle');
  };

  public write(data: string, followCursor = true) {
    if (!this.terminal) {
      this.pendingOutput += data;
      this.pendingFollowCursor = this.pendingFollowCursor && followCursor;
      return;
    }

    const shouldPreserveScroll = !this.followCursorEnabled && this.preservedScrollPosition === null;
    if (shouldPreserveScroll) {
      this.preservedScrollPosition = this.getScrollPosition();
    }

    if (this.preservedScrollPosition !== null) {
      const preservedScrollPosition = this.preservedScrollPosition;
      try {
        this.terminal.write(data);
        // ghostty-web scrolls to bottom synchronously during write(), so restore before paint.
        this.scrollToPosition(preservedScrollPosition);
        this.followCursorEnabled = false;
      } finally {
        this.preservedScrollPosition = null;
      }
      return;
    }

    // ghostty-web already follows output; another smooth scroll per write queues badly on iOS.
    this.terminal.write(data);
  }

  public clear() {
    this.terminal?.clear();
    this.preservedScrollPosition = null;
    this.followCursorEnabled = true;
  }

  public setTerminalSize(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;

    if (!this.terminal) return;
    this.requestResizeMeta('explicit-set-size');
    this.terminal.resize(cols, rows);
  }

  public scrollToBottom() {
    this.terminal?.scrollToBottom();
  }

  /**
   * Whether the viewport is at (or near) the bottom, i.e. auto-following new output.
   * Becomes false when the user scrolls up to read history (incl. touch scroll), so
   * callers can avoid yanking the view back to the bottom while the user is reading.
   */
  public isFollowingCursor(): boolean {
    return this.followCursorEnabled;
  }

  public scrollToPosition(position: number) {
    if (!this.terminal) return;
    const max = this.getMaxScrollPosition();
    const clamped = Math.max(0, Math.min(max, Math.floor(position)));
    this.terminal.scrollToLine(max - clamped);
  }

  public queueCallback(callback: () => void) {
    requestAnimationFrame(() => callback());
  }

  public getTerminalSize(): { cols: number; rows: number } {
    return { cols: this.cols, rows: this.rows };
  }

  public getVisibleRows(): number {
    return this.rows;
  }

  public getBufferSize(): number {
    if (!this.terminal) return 0;
    return this.terminal.buffer.active.length;
  }

  public getMaxScrollPosition(): number {
    if (!this.terminal) return 0;
    return Math.max(0, this.terminal.buffer.active.length - this.terminal.rows);
  }

  public getScrollPosition(): number {
    if (!this.terminal) return 0;
    const max = this.getMaxScrollPosition();
    const viewportFromBottom = this.terminal.getViewportY();
    return Math.round(Math.max(0, Math.min(max, max - viewportFromBottom)));
  }

  // e2e-only debug API (canvas has no textContent)
  public getDebugText(options?: { maxLines?: number; trimRight?: boolean }): string {
    if (!this.terminal) return '';
    const maxLines = options?.maxLines ?? 250;
    const trimRight = options?.trimRight ?? true;

    const buffer = this.terminal.buffer.active;
    const end = buffer.length;
    const start = Math.max(0, end - maxLines);
    const lines: string[] = [];
    for (let i = start; i < end; i++) {
      const line = buffer.getLine(i);
      lines.push(line ? line.translateToString(trimRight) : '');
    }
    return lines.join('\n');
  }

  private restoreUserOverrideWidthFromStorage(sessionId: string) {
    try {
      const stored = localStorage.getItem(`terminal-width-override-${sessionId}`);
      if (stored !== null) this.userOverrideWidth = stored === 'true';
    } catch (error) {
      logger.warn('Failed to load terminal width preference from localStorage:', error);
    }
  }

  private handleTerminalTouchStart = (event: TouchEvent) => {
    if (event.touches.length !== 1) {
      this.resetTouchScroll();
      // A second finger joining mid-gesture (e.g. pinch) disqualifies the whole gesture as a tap.
      this.touchSingleThroughout = false;
      return;
    }

    const touch = event.touches[0];
    this.touchStartX = touch.clientX;
    this.touchStartY = touch.clientY;
    this.lastTouchY = touch.clientY;
    this.touchScrollRemainder = 0;
    this.touchScrolling = false;
    this.touchStartTime = performance.now();
    this.touchSingleThroughout = true;
  };

  private handleTerminalTouchMove = (event: TouchEvent) => {
    if (event.touches.length !== 1) return;

    const touch = event.touches[0];
    const totalX = touch.clientX - this.touchStartX;
    const totalY = touch.clientY - this.touchStartY;

    if (!this.touchScrolling) {
      if (Math.abs(totalY) <= 6 || Math.abs(totalY) <= Math.abs(totalX)) return;
      this.touchScrolling = true;
      // Unconditional: a scroll must drop keyboard focus regardless of input mode,
      // otherwise iOS restores the keyboard on touchend from whatever stayed focused.
      this.blurFocusedInput();
      this.dispatchScrollGestureEvent(true);
    }

    if (event.cancelable) event.preventDefault();

    const lineHeight = Math.max(
      1,
      this.terminal?.renderer?.getMetrics().height ?? this.fontSize * 1.2
    );
    this.touchScrollRemainder += this.lastTouchY - touch.clientY;
    const lines = Math.trunc(this.touchScrollRemainder / lineHeight);
    this.lastTouchY = touch.clientY;

    if (lines !== 0) {
      this.terminal?.scrollLines(lines);
      this.touchScrollRemainder -= lines * lineHeight;
    }
  };

  private resetTouchScroll = () => {
    // Covers touchend, touchcancel, and the mid-gesture multi-finger bailout in touchstart.
    if (this.touchScrolling) {
      this.dispatchScrollGestureEvent(false);
    }
    this.touchScrolling = false;
    this.touchScrollRemainder = 0;
  };

  /**
   * Drops focus from whatever text entry currently holds it when a scroll gesture starts.
   * Deliberately doesn't target a specific element (e.g. the paste textarea): five earlier
   * fixes each guessed which input was holding focus and guessed wrong. Instead this blurs
   * any focused input/textarea/contenteditable, scoped to the terminal area so a rename
   * field, file-browser filter, or modal input elsewhere on the page is never touched.
   */
  private blurFocusedInput() {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return;

    const isTextEntry =
      active instanceof HTMLInputElement ||
      active instanceof HTMLTextAreaElement ||
      active.isContentEditable;
    if (!isTextEntry) return;

    // Scope to the terminal area (falling back to this component's own subtree, e.g. in
    // tests that don't render the surrounding session-view chrome) so overlays/modals,
    // which render as siblings of .terminal-area, are never in scope.
    const terminalArea = this.closest('.terminal-area');
    const inScope = terminalArea ? terminalArea.contains(active) : this.contains(active);
    if (!inScope) return;

    logger.log('blurring focused text entry on scroll gesture', {
      tag: active.tagName,
      id: active.id || undefined,
      className: active.className || undefined,
    });
    active.blur();
  }

  /** Lets the mobile action bar fade out of the way while the user is actively scrolling. */
  private dispatchScrollGestureEvent(active: boolean) {
    this.dispatchEvent(
      new CustomEvent('terminal-scroll-gesture', { bubbles: true, detail: { active } })
    );
  }

  /**
   * Classifies the just-finished gesture as a tap or not, then either dispatches
   * `terminal-tap` or arms a suppression window so the synthetic click Safari fires
   * after touchend is ignored. Never calls preventDefault(): the document-level
   * swipe-back handler depends on seeing an unsuppressed touchend.
   */
  private handleTerminalTouchEnd = (event: TouchEvent) => {
    const wasScrolling = this.touchScrolling;
    const singleThroughout = this.touchSingleThroughout;
    const duration = performance.now() - this.touchStartTime;
    const touch = event.changedTouches[0];
    const movement = touch
      ? Math.max(
          Math.abs(touch.clientX - this.touchStartX),
          Math.abs(touch.clientY - this.touchStartY)
        )
      : Number.POSITIVE_INFINITY;

    this.resetTouchScroll();

    const isTap =
      singleThroughout &&
      !wasScrolling &&
      movement <= TAP_MAX_MOVEMENT_PX &&
      duration <= TAP_MAX_DURATION_MS;

    if (isTap) {
      // Dispatch from the real touch target so composedPath() still carries it
      // (e.g. link-detection in session-view relies on seeing the tapped element).
      const dispatchTarget = (event.target as EventTarget | null) ?? this;
      dispatchTarget.dispatchEvent(new CustomEvent('terminal-tap', { bubbles: true }));
    } else {
      this.suppressClickUntil = performance.now() + TAP_CLICK_SUPPRESS_MS;
    }
  };

  private attachTouchScrollHandlers() {
    this.container?.addEventListener('touchstart', this.handleTerminalTouchStart, {
      passive: true,
    });
    this.container?.addEventListener('touchmove', this.handleTerminalTouchMove, {
      passive: false,
    });
    this.container?.addEventListener('touchend', this.handleTerminalTouchEnd, { passive: true });
    this.container?.addEventListener('touchcancel', this.resetTouchScroll, { passive: true });
  }

  private detachTouchScrollHandlers() {
    this.container?.removeEventListener('touchstart', this.handleTerminalTouchStart);
    this.container?.removeEventListener('touchmove', this.handleTerminalTouchMove);
    this.container?.removeEventListener('touchend', this.handleTerminalTouchEnd);
    this.container?.removeEventListener('touchcancel', this.resetTouchScroll);
  }

  private cleanup() {
    this.initializationId++;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.detachTouchScrollHandlers();

    this.terminal?.dispose();
    this.terminal = null;
    this.fitAddon = null;
    this.container = null;
    this.pasteInput = null;
    this.preservedScrollPosition = null;
  }

  private requestResize(source: string) {
    requestAnimationFrame(() => this.fitTerminal(source));
  }

  private requestResizeMeta(source: string) {
    this.pendingResizeSource = source;
  }

  private applyFontSize() {
    if (!this.terminal) return;
    this.terminal.options.fontSize = this.fontSize;
  }

  private getResolvedTheme() {
    const effectiveTheme = this.theme === 'auto' ? getCurrentTheme() : this.theme;
    const themeId: TerminalThemeId = effectiveTheme === 'dark' ? 'dark' : 'light';

    const selected =
      this.theme === 'auto'
        ? TERMINAL_THEMES.find((t) => t.id === themeId)
        : TERMINAL_THEMES.find((t) => t.id === this.theme);

    return selected?.colors ?? {};
  }

  private applyTheme() {
    if (!this.terminal) return;
    this.terminal.options.theme = this.getResolvedTheme();
  }

  private applyHorizontalFit() {
    if (!this.terminal || !this.container) return;
    const renderer = this.terminal.renderer;
    if (!renderer) return;

    const metrics = renderer.getMetrics();
    const charWidth = metrics?.width || renderer.charWidth || 8;
    const containerWidth = this.container.clientWidth || 0;
    if (containerWidth <= 0 || charWidth <= 0 || this.cols <= 0) return;

    const targetCharWidth = containerWidth / this.cols;
    const scale = targetCharWidth / charWidth;
    const newFontSize = Math.max(8, Math.min(32, this.fontSize * scale));
    if (!Number.isFinite(newFontSize)) return;
    this.fontSize = newFontSize;
    this.terminal.options.fontSize = newFontSize;
  }

  private computeConstrainedCols(proposedCols: number): number {
    const calculatedCols = Math.max(20, Math.floor(proposedCols));
    const isTunneledSession = this.sessionId.startsWith('fwd_');

    if (this.maxCols > 0) return Math.min(calculatedCols, this.maxCols);
    if (this.userOverrideWidth) return calculatedCols;
    if (this.initialCols > 0 && isTunneledSession)
      return Math.min(calculatedCols, this.initialCols);
    return calculatedCols;
  }

  public fitTerminal(source = 'unknown') {
    if (!this.terminal || !this.fitAddon) return;

    if (this.fitHorizontally) {
      this.applyHorizontalFit();
    }

    const proposed = this.fitAddon.proposeDimensions();
    if (!proposed) return;

    const cols = this.computeConstrainedCols(proposed.cols);
    const rows = Math.max(6, Math.floor(proposed.rows));

    const prevCols = this.lastCols || this.terminal.cols;
    const prevRows = this.lastRows || this.terminal.rows;

    if (cols === prevCols && rows === prevRows) return;

    this.requestResizeMeta(source);
    this.terminal.resize(cols, rows);
  }

  private async initializeTerminal() {
    if (this.terminal) return;
    const initializationId = ++this.initializationId;

    const container = this.querySelector(
      `#${TERMINAL_IDS.TERMINAL_CONTAINER}`
    ) as HTMLElement | null;
    if (!container) return;
    this.container = container;

    try {
      const ghostty = await ensureGhostty();
      if (
        initializationId !== this.initializationId ||
        !this.isConnected ||
        this.container !== container
      )
        return;

      const term = new GhosttyTerminal({
        cols: this.cols,
        rows: this.rows,
        fontSize: this.fontSize,
        fontFamily: TERMINAL_FONT_FAMILY,
        theme: this.getResolvedTheme(),
        cursorBlink: true,
        smoothScrollDuration: 120,
        disableStdin: true,
        ghostty,
      });

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);

      term.onData((text) => {
        this.dispatchEvent(new CustomEvent('terminal-input', { detail: { text }, bubbles: true }));
      });

      term.onResize(({ cols, rows }) => {
        const source = this.pendingResizeSource ?? 'unknown';
        this.pendingResizeSource = null;

        this.lastCols = cols;
        this.lastRows = rows;
        this.cols = cols;
        this.rows = rows;

        const detail: TerminalResizeDetail = { cols, rows, source };

        this.dispatchEvent(new CustomEvent('terminal-resize', { detail, bubbles: true }));
      });

      term.onScroll(() => {
        if (this.preservedScrollPosition !== null) return;
        const viewportFromBottom = term.getViewportY();
        this.followCursorEnabled = viewportFromBottom <= 0.5;
      });

      // Fresh mount
      container.innerHTML = '';
      term.open(container);
      term.registerLinkProvider(new KeyboardShortcutLinkProvider(term, this.handleShortcutClick));

      this.terminal = term;
      this.fitAddon = fitAddon;

      // Size first, then initialize every cell; ghostty-web can reuse uncleared WASM memory.
      this.fitTerminal('initial');
      term.clear();

      // ghostty-web does not translate touch pans into scrollback movement.
      this.attachTouchScrollHandlers();

      if (this.pendingOutput) {
        const pending = this.pendingOutput;
        const followCursor = this.pendingFollowCursor;
        this.pendingOutput = '';
        this.pendingFollowCursor = true;
        this.terminal.write(pending, () => {
          if (followCursor && this.followCursorEnabled) {
            this.terminal?.scrollToBottom();
          }
        });
      }

      this.setAttribute('data-ready', 'true');

      // Follow up after layout settles; this should normally be a no-op.
      this.requestResize('initial');

      this.dispatchEvent(new CustomEvent('terminal-ready', { bubbles: true }));

      // Observe container resizes
      this.resizeObserver = new ResizeObserver(() => this.requestResize('resize-observer'));
      this.resizeObserver.observe(this.container);
    } catch (error) {
      logger.error('failed to initialize ghostty terminal', error);
    }
  }

  private handleScrollToBottom = () => {
    this.followCursorEnabled = true;
    this.scrollToBottom();
  };

  private handleShortcutClick = (controlCharacter: string) => {
    if (this.disableClick || performance.now() < this.suppressClickUntil) return;

    this.dispatchEvent(
      new CustomEvent('terminal-input', {
        detail: { text: controlCharacter },
        bubbles: true,
      })
    );
  };

  private handleClick = (e: MouseEvent) => {
    if (this.disableClick || performance.now() < this.suppressClickUntil) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest('a[href]')) {
      // Keep native link behavior (especially important on mobile browsers).
      return;
    }
    const selection = document.getSelection();
    if (selection && selection.toString().length > 0) return;
    this.focus();
    this.pasteInput?.focus();
    this.pasteInput?.select();
  };

  private handlePaste = (e: ClipboardEvent) => {
    const files = e.clipboardData?.files;
    if (files && files.length > 0) return; // let file/image paste handlers run

    const text = e.clipboardData?.getData('text/plain') ?? '';
    if (!text) return;

    e.preventDefault();
    e.stopPropagation();

    // Clear hidden textarea so it doesn't accumulate text
    if (this.pasteInput) this.pasteInput.value = '';

    this.dispatchEvent(new CustomEvent('terminal-paste', { detail: { text }, bubbles: true }));
  };

  /**
   * Return the rendered cursor position relative to the session terminal.
   * Desktop IME inputs use this to place the native candidate window at the cursor.
   */
  public getCursorInfo(): { x: number; y: number } | null {
    if (!this.terminal || !this.container) return null;

    try {
      const renderer = this.terminal.renderer;
      if (!renderer) return null;

      const metrics = renderer.getMetrics();
      const charWidth = metrics?.width || renderer.charWidth || 8;
      const charHeight = metrics?.height || renderer.charHeight || this.fontSize * 1.2;
      if (charWidth <= 0 || charHeight <= 0) return null;

      const buffer = this.terminal.buffer.active;
      const terminalRect = this.container.getBoundingClientRect();
      const absoluteX = terminalRect.left + buffer.cursorX * charWidth;
      const absoluteY = terminalRect.top + buffer.cursorY * charHeight;

      const sessionTerminal = document.getElementById(TERMINAL_IDS.SESSION_TERMINAL);
      if (!sessionTerminal) {
        return { x: absoluteX, y: absoluteY };
      }

      const sessionRect = sessionTerminal.getBoundingClientRect();
      return {
        x: absoluteX - sessionRect.left,
        y: absoluteY - sessionRect.top,
      };
    } catch (error) {
      logger.warn('Failed to get terminal cursor position:', error);
      return null;
    }
  }

  /**
   * Get the current input line (text the user has typed on the current line).
   * Used to sync chat mode input with the terminal state.
   */
  public getCurrentInputLine(): string {
    if (!this.terminal) return '';

    try {
      const buffer = this.terminal.buffer.active;
      const lineIndex = buffer.baseY + buffer.cursorY;
      const line = buffer.getLine(lineIndex);
      if (!line) return '';

      const lineText = line.translateToString(true).replace(/\s+$/g, '');
      if (!lineText.trim()) return '';

      const promptMatch = lineText.match(/[>$#%➜❯]\s*([^>$#%➜❯│┃|]*)/);
      if (promptMatch?.[1]) {
        const input = promptMatch[1]
          .replace(/[│┃┆┇┊┋|]/g, '')
          .replace(/\s+$/g, '')
          .trim();
        if (input && this.isPlaceholderText(input)) return '';
        return input;
      }

      return '';
    } catch (error) {
      logger.warn('Failed to get current input line:', error);
      return '';
    }
  }

  private isPlaceholderText(text: string): boolean {
    const lowerText = text.toLowerCase();

    if (
      lowerText.startsWith('type your message') ||
      lowerText.startsWith('type a message') ||
      lowerText.includes('@path/to/file') ||
      lowerText.includes('@path to file')
    ) {
      return true;
    }

    if (lowerText.startsWith('try "') || lowerText.startsWith("try '")) {
      return true;
    }

    if (
      lowerText.startsWith('enter your') ||
      lowerText.startsWith('enter a ') ||
      lowerText.startsWith('press enter') ||
      lowerText.startsWith('type here')
    ) {
      return true;
    }

    return false;
  }

  render() {
    return html`
      <style>
        vibe-terminal {
          display: block;
          width: 100%;
          height: 100%;
        }
        .terminal-root {
          position: relative;
          width: 100%;
          height: 100%;
        }
        .terminal-container {
          width: 100%;
          height: 100%;
          overflow: hidden;
          font-family: ${TERMINAL_FONT_FAMILY};
          /* Own one-finger pans for scrollback while retaining two-finger page zoom. */
          touch-action: pinch-zoom;
          -webkit-user-select: text;
          user-select: text;
        }
        .terminal-paste-input {
          position: absolute;
          left: -9999px;
          top: 0;
          width: 1px;
          height: 1px;
          opacity: 0;
          pointer-events: none;
        }
        .scroll-to-bottom {
          position: absolute;
          right: 12px;
          bottom: 12px;
          z-index: 20;
        }
        .scroll-to-bottom button {
          font-family: ${TERMINAL_FONT_FAMILY};
          background: rgba(0, 0, 0, 0.55);
          color: #fff;
          border: 1px solid rgba(255, 255, 255, 0.18);
          border-radius: 10px;
          padding: 6px 10px;
        }
      </style>

      <div class="terminal-root" @click=${this.handleClick} @paste=${this.handlePaste}>
        <textarea
          id=${TERMINAL_IDS.TERMINAL_INPUT}
          class="terminal-paste-input"
          aria-label="Terminal input"
          data-testid="terminal-input"
          tabindex="-1"
          autocapitalize="off"
          autocomplete="off"
          autocorrect="off"
          spellcheck="false"
          inputmode=${this.keyboardLocked ? 'none' : 'text'}
          @paste=${this.handlePaste}
        ></textarea>
        <div
          id=${TERMINAL_IDS.TERMINAL_CONTAINER}
          class="terminal-container"
          style="view-transition-name: session-${this.sessionId};"
        ></div>

        ${
          !this.hideScrollButton && !this.followCursorEnabled
            ? html`
              <div class="scroll-to-bottom">
                <button type="button" @click=${this.handleScrollToBottom}>Scroll</button>
              </div>
            `
            : null
        }
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'vibe-terminal': Terminal;
  }
}
