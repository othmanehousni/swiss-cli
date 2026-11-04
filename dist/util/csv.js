/**
 * A small RFC 4180 CSV reader: quoted fields (with commas, quotes and line breaks
 * inside), CRLF or LF line ends, a byte-order mark, any one-character delimiter.
 */
export function parseCsv(text, delimiter = ',') {
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
    for (; i < text.length; i++) {
        const char = text[i];
        if (quoted) {
            if (char === '"') {
                if (text[i + 1] === '"') {
                    field += '"';
                    i++;
                }
                else {
                    quoted = false;
                }
            }
            else {
                field += char;
            }
        }
        else if (char === '"' && field === '') {
            quoted = true;
        }
        else if (char === delimiter) {
            row.push(field);
            field = '';
        }
        else if (char === '\n' || char === '\r') {
            if (char === '\r' && text[i + 1] === '\n')
                i++;
            row.push(field);
            rows.push(row);
            row = [];
            field = '';
        }
        else {
            field += char;
        }
    }
    if (field !== '' || row.length > 0) {
        row.push(field);
        rows.push(row);
    }
    return rows.filter((r) => r.length > 1 || (r[0] ?? '') !== '');
}
/** Rows as objects keyed by the header line. */
export function parseCsvRecords(text, delimiter = ',') {
    const [header, ...rows] = parseCsv(text, delimiter);
    if (!header)
        return [];
    const keys = header.map((h) => h.trim());
    return rows.map((row) => Object.fromEntries(keys.map((key, i) => [key, row[i] ?? ''])));
}
