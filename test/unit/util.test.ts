import { describe, expect, it } from 'vitest';
import { parseCsv, parseCsvRecords } from '../../src/util/csv.js';
import { readXlsxSheet } from '../../src/util/xlsx.js';
import { findZipEntry, readZip } from '../../src/util/zip.js';
import { makeXlsx, makeZip } from '../helpers/zip.js';

describe('parseCsv', () => {
  it('reads quoted fields, escaped quotes, line breaks and both line ends', () => {
    const text = '﻿name,size\r\n"Milch, 1 l","1 l"\n"Er sagt ""ja""",\n"zwei\nZeilen",x\n';
    expect(parseCsv(text)).toEqual([
      ['name', 'size'],
      ['Milch, 1 l', '1 l'],
      ['Er sagt "ja"', ''],
      ['zwei\nZeilen', 'x'],
    ]);
  });

  it('turns rows into records by header, with any delimiter', () => {
    expect(parseCsvRecords('PLZ4;Ort\n8001;Zürich\n3920;Zermatt', ';')).toEqual([
      { PLZ4: '8001', Ort: 'Zürich' },
      { PLZ4: '3920', Ort: 'Zermatt' },
    ]);
    expect(parseCsvRecords('')).toEqual([]);
  });
});

describe('readZip', () => {
  it('reads stored and deflated files, with UTF-8 and code page 437 names', () => {
    const zip = makeZip([
      { name: 'stored.txt', data: 'hello' },
      { name: 'Prämien_CH.csv', data: 'a,b\n1,2\n'.repeat(100), deflate: true },
      { name: new Uint8Array([0x63, 0x61, 0x66, 0x82, 0x2e, 0x74, 0x78, 0x74]), data: 'cp437' },
    ]);
    const entries = readZip(zip);
    expect(entries.map((e) => e.name)).toEqual(['stored.txt', 'Prämien_CH.csv', 'café.txt']);
    expect(new TextDecoder().decode(entries[0]?.read())).toBe('hello');
    const premiums = findZipEntry(entries, /Prämien_CH\.csv$/);
    expect(premiums?.size).toBe(800);
    expect(new TextDecoder().decode(premiums?.read()).split('\n')).toHaveLength(201);
  });

  it('refuses data that is not a ZIP archive', () => {
    expect(() => readZip(new TextEncoder().encode('<html>not found</html>'))).toThrow(
      /not a ZIP file/,
    );
  });
});

describe('readXlsxSheet', () => {
  it('reads shared, inline and numeric cells into their columns', () => {
    const xlsx = makeXlsx(
      {
        Intro: '<row r="1"><c r="A1" t="s"><v>0</v></c></row>',
        Daten:
          '<row r="1"><c r="A1" t="s"><v>1</v></c><c r="C1" t="inlineStr"><is><t>Region</t></is></c></row>' +
          '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>261</v></c><c r="C2"><v>1</v></c></row>',
      },
      ['<t>Anhang</t>', '<r><t>Kan</t></r><r><t>ton</t></r>', '<t>ZH &amp; Co</t>'],
    );
    expect(readXlsxSheet(xlsx)).toEqual([['Anhang']]);
    expect(readXlsxSheet(xlsx, 'Daten')).toEqual([
      ['Kanton', '', 'Region'],
      ['ZH & Co', '261', '1'],
    ]);
    expect(() => readXlsxSheet(xlsx, 'Missing')).toThrow(/no sheet "Missing"/);
  });
});
