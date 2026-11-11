/**
 * Pruning Detector - Unified detection of terminal pruning sequences
 *
 * This module provides a single source of truth for detecting terminal sequences
 * that indicate the terminal buffer should be pruned (cleared). It's used by both:
 * - AsciinemaWriter: Real-time detection during recording
 * - CastOutputHub: Retroactive detection during playback/tailing
 *
 * Pruning helps prevent session files from growing indefinitely by identifying
 * points where old terminal content can be safely discarded.
 */

import { createLogger } from './logger.js';

const logger = createLogger('PruningDetector');

/**
 * Comprehensive list of ANSI sequences that warrant pruning.
 * These sequences indicate the terminal has been cleared or reset,
 * making previous content unnecessary for playback.
 */
export const PRUNE_SEQUENCES = [
  '\x1b[3J', // Clear scrollback buffer (common)
  '\x1bc', // RIS - Full terminal reset
  '\x1b[?1049h', // Enter alternate screen (vim, less, etc)
  '\x1b[?1049l', // Exit alternate screen
  '\x1b[?47h', // Save screen and enter alternate screen (older)
  '\x1b[?47l', // Restore screen and exit alternate screen (older)
] as const;

/**
 * Result of pruning sequence detection
 */
export interface PruningDetectionResult {
  sequence: string;
  index: number;
}

/**
 * Detect the last pruning sequence in raw terminal data.
 *
 * @param data - Raw terminal output data
 * @returns Detection result with sequence and index, or null if not found
 */
export function detectLastPruningSequence(data: string): PruningDetectionResult | null {
  let lastIndex = -1;
  let lastSequence = '';

  for (const sequence of PRUNE_SEQUENCES) {
    const index = data.lastIndexOf(sequence);
    if (index > lastIndex) {
      lastIndex = index;
      lastSequence = sequence;
    }
  }

  if (lastIndex === -1) {
    return null;
  }

  return {
    sequence: lastSequence,
    index: lastIndex,
  };
}

/**
 * Check if data contains any pruning sequence.
 *
 * @param data - Terminal data to check
 * @returns true if any pruning sequence is found
 */
export function containsPruningSequence(data: string): boolean {
  return PRUNE_SEQUENCES.some((sequence) => data.includes(sequence));
}

/**
 * Find the position of the last pruning sequence and where it ends.
 *
 * @param data - Terminal data to search
 * @returns Object with sequence and end position, or null if not found
 */
export function findLastPrunePoint(data: string): { sequence: string; position: number } | null {
  const result = detectLastPruningSequence(data);
  if (!result) {
    return null;
  }

  return {
    sequence: result.sequence,
    position: result.index + result.sequence.length,
  };
}

/**
 * Parse an asciinema event line and check for pruning sequences.
 *
 * @param line - JSON line from asciinema file
 * @returns Detection result with additional metadata, or null
 */
export function checkAsciinemaEventForPruning(line: string): {
  sequence: string;
  dataIndex: number;
  timestamp: number;
  eventType: string;
} | null {
  try {
    const parsed = JSON.parse(line);

    // Check if it's a valid event array
    if (!Array.isArray(parsed) || parsed.length < 3) {
      return null;
    }

    const [timestamp, eventType, data] = parsed;

    // Only check output events
    if (eventType !== 'o' || typeof data !== 'string') {
      return null;
    }

    // Check for pruning sequences
    const result = detectLastPruningSequence(data);
    if (!result) {
      return null;
    }

    return {
      sequence: result.sequence,
      dataIndex: result.index,
      timestamp,
      eventType,
    };
  } catch (error) {
    // Invalid JSON or parsing error
    logger.debug(`Failed to parse asciinema line: ${error}`);
    return null;
  }
}

/**
 * Log detection of a pruning sequence in a consistent format.
 * The position is the start of the event line containing the sequence,
 * not the sequence itself, so replay can always resume on a line boundary.
 *
 * @param sequence - The detected sequence
 * @param position - Byte position of the start of the event line in the file
 * @param context - Additional context for the log
 */
export function logPruningDetection(
  sequence: string,
  position: number,
  context: string = ''
): void {
  const escapedSequence = sequence.split('\x1b').join('\\x1b');
  logger.debug(
    `Detected pruning sequence '${escapedSequence}' at line-start byte position ${position}` +
      (context ? ` ${context}` : '')
  );
}

/**
 * Get a human-readable name for a pruning sequence.
 *
 * @param sequence - The pruning sequence
 * @returns Description of what the sequence does
 */
export function getSequenceDescription(sequence: string): string {
  switch (sequence) {
    case '\x1b[3J':
      return 'Clear scrollback buffer';
    case '\x1bc':
      return 'Terminal reset (RIS)';
    case '\x1b[?1049h':
      return 'Enter alternate screen';
    case '\x1b[?1049l':
      return 'Exit alternate screen';
    case '\x1b[?47h':
      return 'Save screen (legacy)';
    case '\x1b[?47l':
      return 'Restore screen (legacy)';
    default:
      return 'Unknown sequence';
  }
}
