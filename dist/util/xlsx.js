import { readZip } from './zip.js';
/** Decodes the five XML entities and numeric character references. */
function xmlText(text) {
    return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity) => {
        if (entity[0] === '#') {
            const code = entity[1] === 'x' || entity[1] === 'X'
                ? Number.parseInt(entity.slice(2), 16)
                : Number.parseInt(entity.slice(1), 10);
            return String.fromCodePoint(code);
        }
        return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[entity.toLowerCase()] ?? '';
    });
}
/** The text of an <si> or <is> element: plain or split into formatted runs. */
function richText(xml) {
    return [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)]
        .map((m) => xmlText(m[1] ?? ''))
        .join('');
}
function columnIndex(reference) {
    let index = 0;
    for (const char of reference.replace(/\d+$/, ''))
        index = index * 26 + (char.charCodeAt(0) - 64);
    return index - 1;
}
function entryText(entries, name) {
    const entry = entries.find((e) => e.name === name);
    return entry ? new TextDecoder('utf-8').decode(entry.read()) : null;
}
/** The sheets of a workbook, in order: their names and where their XML is. */
function sheetPaths(entries) {
    const workbook = entryText(entries, 'xl/workbook.xml') ?? '';
    const rels = entryText(entries, 'xl/_rels/workbook.xml.rels') ?? '';
    const targets = new Map([...rels.matchAll(/<Relationship\s[^>]*>/g)].map((m) => [
        /Id="([^"]+)"/.exec(m[0])?.[1] ?? '',
        /Target="([^"]+)"/.exec(m[0])?.[1] ?? '',
    ]));
    return [...workbook.matchAll(/<sheet\s[^>]*>/g)].map((m) => {
        const id = /r:id="([^"]+)"/.exec(m[0])?.[1] ?? '';
        const target = (targets.get(id) ?? '').replace(/^\/?(xl\/)?/, '');
        return { name: xmlText(/name="([^"]*)"/.exec(m[0])?.[1] ?? ''), path: `xl/${target}` };
    });
}
/**
 * Reads one sheet of an .xlsx workbook as rows of text (numbers as written in the
 * file, empty cells as ''). Enough for the data tables public offices publish.
 */
export function readXlsxSheet(data, sheet = 0) {
    const entries = readZip(data);
    const sheets = sheetPaths(entries);
    const chosen = typeof sheet === 'number' ? sheets[sheet] : sheets.find((s) => s.name === sheet);
    if (!chosen)
        throw new Error(`the workbook has no sheet ${JSON.stringify(sheet)}`);
    const shared = [
        ...(entryText(entries, 'xl/sharedStrings.xml') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g),
    ].map((m) => richText(m[1] ?? ''));
    const xml = entryText(entries, chosen.path) ?? '';
    const rows = [];
    for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>|<row\b[^>]*\/>/g)) {
        const row = [];
        for (const cell of (rowMatch[1] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
            const attributes = cell[1] ?? '';
            const reference = /\br="([A-Z]+\d+)"/.exec(attributes)?.[1];
            const type = /\bt="(\w+)"/.exec(attributes)?.[1];
            const inner = cell[2] ?? '';
            const value = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
            let text;
            if (type === 's')
                text = shared[Number(value)] ?? '';
            else if (type === 'inlineStr')
                text = richText(inner);
            else
                text = value === undefined ? '' : xmlText(value);
            const index = reference ? columnIndex(reference) : row.length;
            while (row.length < index)
                row.push('');
            row[index] = text;
        }
        rows.push(row);
    }
    return rows;
}
