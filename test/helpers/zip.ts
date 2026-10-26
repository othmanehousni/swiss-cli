import { deflateRawSync } from 'node:zlib';

export interface ZipInput {
  /** The name as bytes, to write names without the UTF-8 flag (code page 437). */
  name: string | Uint8Array;
  data: string | Uint8Array;
  deflate?: boolean;
}

/** Writes a minimal ZIP archive (for tests of the ZIP and XLSX readers). */
export function makeZip(files: ZipInput[]): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const utf8 =
      typeof file.name === 'string' && [...file.name].some((c) => c.charCodeAt(0) > 0x7f);
    const name =
      typeof file.name === 'string' ? Buffer.from(file.name, 'utf-8') : Buffer.from(file.name);
    const data =
      typeof file.data === 'string' ? Buffer.from(file.data, 'utf-8') : Buffer.from(file.data);
    const stored = file.deflate ? deflateRawSync(data) : data;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(utf8 ? 0x800 : 0, 6);
    local.writeUInt16LE(file.deflate ? 8 : 0, 8);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(utf8 ? 0x800 : 0, 8);
    central.writeUInt16LE(file.deflate ? 8 : 0, 10);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, stored);
    centrals.push(central, name);
    offset += 30 + name.length + stored.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, directory, end]));
}

/** A minimal .xlsx workbook with one sheet per entry of `sheets` (rows of XML cells). */
export function makeXlsx(sheets: Record<string, string>, sharedStrings: string[]): Uint8Array {
  const names = Object.keys(sheets);
  const workbook = `<?xml version="1.0"?><workbook xmlns:r="r"><sheets>${names
    .map((name, i) => `<sheet name="${name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
    .join('')}</sheets></workbook>`;
  const rels = `<?xml version="1.0"?><Relationships>${names
    .map(
      (_, i) =>
        `<Relationship Id="rId${i + 1}" Type="worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
    )
    .join('')}</Relationships>`;
  const shared = `<?xml version="1.0"?><sst>${sharedStrings.map((s) => `<si>${s}</si>`).join('')}</sst>`;
  return makeZip([
    { name: 'xl/workbook.xml', data: workbook, deflate: true },
    { name: 'xl/_rels/workbook.xml.rels', data: rels },
    { name: 'xl/sharedStrings.xml', data: shared, deflate: true },
    ...names.map((name, i) => ({
      name: `xl/worksheets/sheet${i + 1}.xml`,
      data: `<?xml version="1.0"?><worksheet><sheetData>${sheets[name]}</sheetData></worksheet>`,
      deflate: true,
    })),
  ]);
}
