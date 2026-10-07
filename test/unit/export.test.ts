import { describe, expect, it } from 'vitest';
import { csvCell } from '../../src/commands/export.js';

describe('csvCell', () => {
  it('quotes cells that contain the delimiter, quotes or line breaks', () => {
    expect(csvCell('Ajvar, mild', ',')).toBe('"Ajvar, mild"');
    expect(csvCell('Ajvar, mild', ';')).toBe('Ajvar, mild');
    expect(csvCell('2" Rohr', ',')).toBe('"2"" Rohr"');
    expect(csvCell('two\nlines', ',')).toBe('"two\nlines"');
    expect(csvCell(null, ',')).toBe('');
    expect(csvCell(3.85, ',')).toBe('3.85');
  });

  it('neutralizes spreadsheet formulas in text from the stores', () => {
    expect(csvCell('=HYPERLINK("http://evil")', ',')).toBe(`"'=HYPERLINK(""http://evil"")"`);
    expect(csvCell('+41 cmd', ',')).toBe("'+41 cmd");
    expect(csvCell('@SUM(A1)', ',')).toBe("'@SUM(A1)");
    expect(csvCell('-cmd|calc', ',')).toBe("'-cmd|calc");
  });

  it('leaves discount labels and negative numbers alone', () => {
    expect(csvCell('-20%', ',')).toBe('-20%');
    expect(csvCell('-0.5', ',')).toBe('-0.5');
    expect(csvCell(-2, ',')).toBe('-2');
  });
});
