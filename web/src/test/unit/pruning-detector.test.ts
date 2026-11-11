import { describe, expect, it } from 'vitest';
import {
  checkAsciinemaEventForPruning,
  containsPruningSequence,
  detectLastPruningSequence,
  findLastPrunePoint,
  getSequenceDescription,
  PRUNE_SEQUENCES,
} from '../../server/utils/pruning-detector';

describe('Pruning Detector', () => {
  describe('detectLastPruningSequence', () => {
    it('should detect the last pruning sequence in data', () => {
      const data = 'some text\x1bcmore text\x1b[3Jfinal text';
      const result = detectLastPruningSequence(data);

      expect(result).not.toBeNull();
      expect(result?.sequence).toBe('\x1b[3J');
      expect(result?.index).toBe(data.lastIndexOf('\x1b[3J'));
    });

    it('should return null if no pruning sequence found', () => {
      const data = 'just normal text without escape sequences';
      const result = detectLastPruningSequence(data);
      expect(result).toBeNull();
    });

    it('should not treat a bare clear-screen as a pruning sequence', () => {
      const data = 'text\x1b[2Jmore text';
      const result = detectLastPruningSequence(data);
      expect(result).toBeNull();
    });

    it('should find the last sequence when multiple exist', () => {
      const data = '\x1b[3J\x1bc\x1b[?1049h';
      const result = detectLastPruningSequence(data);
      expect(result?.sequence).toBe('\x1b[?1049h');
    });
  });

  describe('containsPruningSequence', () => {
    it('should return true if data contains any pruning sequence', () => {
      expect(containsPruningSequence('text\x1b[3Jmore')).toBe(true);
      expect(containsPruningSequence('text\x1bcmore')).toBe(true);
      expect(containsPruningSequence('text\x1b[?1049hmore')).toBe(true);
    });

    it('should return false if no pruning sequences', () => {
      expect(containsPruningSequence('normal text')).toBe(false);
      expect(containsPruningSequence('text with \x1b[31m color')).toBe(false);
    });
  });

  describe('findLastPrunePoint', () => {
    it('should return position after the sequence', () => {
      const data = 'before\x1b[3Jafter';
      const result = findLastPrunePoint(data);

      expect(result).not.toBeNull();
      expect(result?.sequence).toBe('\x1b[3J');
      expect(result?.position).toBe(data.indexOf('after'));
    });
  });

  describe('checkAsciinemaEventForPruning', () => {
    it('should detect pruning in valid output event', () => {
      const line = JSON.stringify([1.234, 'o', 'text\x1b[3Jmore']);
      const result = checkAsciinemaEventForPruning(line);

      expect(result).not.toBeNull();
      expect(result?.sequence).toBe('\x1b[3J');
      expect(result?.dataIndex).toBe(4); // position in the data string
      expect(result?.timestamp).toBe(1.234);
      expect(result?.eventType).toBe('o');
    });

    it('should return null for non-output events', () => {
      const inputEvent = JSON.stringify([1.234, 'i', 'user input']);
      expect(checkAsciinemaEventForPruning(inputEvent)).toBeNull();

      const resizeEvent = JSON.stringify([1.234, 'r', '80x24']);
      expect(checkAsciinemaEventForPruning(resizeEvent)).toBeNull();
    });

    it('should return null for invalid JSON', () => {
      expect(checkAsciinemaEventForPruning('not json')).toBeNull();
    });
  });

  describe('getSequenceDescription', () => {
    it('should return correct descriptions for known sequences', () => {
      expect(getSequenceDescription('\x1b[3J')).toBe('Clear scrollback buffer');
      expect(getSequenceDescription('\x1bc')).toBe('Terminal reset (RIS)');
      expect(getSequenceDescription('\x1b[?1049h')).toBe('Enter alternate screen');
      expect(getSequenceDescription('\x1b[?1049l')).toBe('Exit alternate screen');
    });

    it('should return unknown for unrecognized sequences, including the dropped clear-screen variants', () => {
      expect(getSequenceDescription('\x1b[99X')).toBe('Unknown sequence');
      expect(getSequenceDescription('\x1b[2J')).toBe('Unknown sequence');
      expect(getSequenceDescription('\x1b[H\x1b[J')).toBe('Unknown sequence');
      expect(getSequenceDescription('\x1b[H\x1b[2J')).toBe('Unknown sequence');
    });
  });

  describe('PRUNE_SEQUENCES constant', () => {
    it('should contain only screen-switch and reset sequences, not bare clear-screen', () => {
      expect(PRUNE_SEQUENCES).toContain('\x1b[3J');
      expect(PRUNE_SEQUENCES).toContain('\x1bc');
      expect(PRUNE_SEQUENCES).toContain('\x1b[?1049h');
      expect(PRUNE_SEQUENCES).toContain('\x1b[?1049l');
      expect(PRUNE_SEQUENCES).toContain('\x1b[?47h');
      expect(PRUNE_SEQUENCES).toContain('\x1b[?47l');
      expect(PRUNE_SEQUENCES).not.toContain('\x1b[2J');
      expect(PRUNE_SEQUENCES).not.toContain('\x1b[H\x1b[J');
      expect(PRUNE_SEQUENCES).not.toContain('\x1b[H\x1b[2J');
      expect(PRUNE_SEQUENCES.length).toBe(6);
    });
  });
});
