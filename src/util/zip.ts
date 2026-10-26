import { inflateRawSync } from 'node:zlib';

/** Code page 437, the encoding of ZIP file names without the UTF-8 flag (upper half). */
const CP437 =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';

function decodeName(bytes: Uint8Array, utf8: boolean): string {
  if (utf8) return new TextDecoder('utf-8').decode(bytes);
  let name = '';
  for (const byte of bytes) name += byte < 0x80 ? String.fromCharCode(byte) : CP437[byte - 0x80];
  return name;
}

export interface ZipEntry {
  name: string;
  size: number;
  /** The file's content, decompressed when it is read. */
  read(): Uint8Array;
}

/**
 * Lists the files in a ZIP archive (stored or deflated, as written by Excel, Windows
 * and most tools), reading sizes from the central directory.
 */
export function readZip(data: Uint8Array): ZipEntry[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let end = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 22 - 65_535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('not a ZIP file (no central directory found)');
  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  const entries: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (view.getUint32(offset, true) !== 0x02014b50)
      throw new Error('damaged ZIP central directory');
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const size = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decodeName(
      data.subarray(offset + 46, offset + 46 + nameLength),
      (flags & 0x800) !== 0,
    );
    offset += 46 + nameLength + extraLength + commentLength;
    if (compressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error(`${name}: ZIP64 archives are not supported`);
    }
    entries.push({
      name,
      size,
      read: () => {
        if (view.getUint32(localOffset, true) !== 0x04034b50)
          throw new Error(`${name}: damaged ZIP entry`);
        const start =
          localOffset +
          30 +
          view.getUint16(localOffset + 26, true) +
          view.getUint16(localOffset + 28, true);
        const raw = data.subarray(start, start + compressedSize);
        if (method === 0) return raw;
        if (method === 8) return new Uint8Array(inflateRawSync(raw));
        throw new Error(`${name}: unsupported ZIP compression method ${method}`);
      },
    });
  }
  return entries;
}

/** The first file whose name matches, e.g. /Prämien_CH\.csv$/. */
export function findZipEntry(entries: ZipEntry[], pattern: RegExp): ZipEntry | undefined {
  return entries.find((entry) => pattern.test(entry.name));
}
