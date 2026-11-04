import pc from 'picocolors';
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escape codes
const ANSI = /\u001b\[[0-9;]*m/g;
export function visibleLength(text) {
    return [...text.replace(ANSI, '').normalize('NFC')].length;
}
export function truncate(text, width) {
    if (width <= 0)
        return '';
    const chars = [...text.normalize('NFC')];
    return chars.length <= width ? text : `${chars.slice(0, Math.max(0, width - 1)).join('')}…`;
}
function pad(text, width, align) {
    const gap = ' '.repeat(Math.max(0, width - visibleLength(text)));
    return align === 'right' ? gap + text : text + gap;
}
/**
 * Results go to stdout, everything else (progress, warnings, errors) to stderr,
 * so `swiss-grocery search milch --json > milk.json` stays clean.
 */
export class Output {
    options;
    stdout;
    stderr;
    c;
    constructor(options, stdout = process.stdout, stderr = process.stderr) {
        this.options = options;
        this.stdout = stdout;
        this.stderr = stderr;
        const color = options.color &&
            !process.env.NO_COLOR &&
            (stderr.isTTY === true || process.env.FORCE_COLOR !== undefined);
        this.c = pc.createColors(color);
    }
    get width() {
        return Math.max(60, Math.min(this.stdout.columns ?? 120, 160));
    }
    get interactive() {
        return this.stderr.isTTY === true && !this.options.json && !this.options.quiet;
    }
    /** Result output (stdout). */
    print(text = '') {
        if (!this.options.json)
            this.stdout.write(`${text}\n`);
    }
    json(value) {
        this.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    }
    message(text) {
        if (!this.options.json && !this.options.quiet)
            this.stderr.write(`${text}\n`);
    }
    info(text = '') {
        this.message(text);
    }
    heading(text) {
        this.message(this.c.bold(text));
    }
    success(text) {
        this.message(`${this.c.green('✔')} ${text}`);
    }
    hint(text) {
        this.message(`  ${this.c.cyan('→')} ${text}`);
    }
    warn(text) {
        if (!this.options.json)
            this.stderr.write(`${this.c.yellow('⚠')} ${text}\n`);
    }
    error(text) {
        this.stderr.write(`${this.c.red('✖')} ${text}\n`);
    }
    debug(text) {
        if (this.options.verbose)
            this.stderr.write(`${this.c.dim(`· ${text}`)}\n`);
    }
    /** Renders rows as an aligned table that fits the terminal width. */
    table(rows, columns, indent = 2) {
        const cells = rows.map((row) => columns.map((col) => col.value(row)));
        const widths = columns.map((col, i) => Math.max(visibleLength(col.header), ...cells.map((r) => visibleLength(r[i] ?? ''))));
        const gap = 2;
        const available = this.width - indent;
        const total = () => widths.reduce((sum, w) => sum + w, 0) + gap * (columns.length - 1);
        for (let i = 0; i < columns.length && total() > available; i++) {
            if (columns[i]?.flex)
                widths[i] = Math.max(12, (widths[i] ?? 0) - (total() - available));
        }
        const prefix = ' '.repeat(indent);
        const line = (values, styled) => prefix +
            values
                .map((value, i) => styled(pad(truncate(value, widths[i] ?? 0), widths[i] ?? 0, columns[i]?.align ?? 'left'), i))
                .join(' '.repeat(gap))
                .trimEnd();
        this.print(line(columns.map((c) => c.header), (text) => this.c.bold(this.c.dim(text))));
        rows.forEach((row, r) => {
            this.print(line(cells[r] ?? [], (text, i) => columns[i]?.style?.(text, row) ?? text));
        });
    }
}
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
/**
 * A single status line that redraws itself in a terminal. When output is not a
 * terminal (CI, log files) it prints a plain line every 15 seconds instead.
 */
export class ProgressLine {
    out;
    stream;
    frame = 0;
    // Non-interactive output waits 15 s before its first line, so quick steps stay quiet.
    lastDraw = Date.now();
    shown = false;
    constructor(out, stream = process.stderr) {
        this.out = out;
        this.stream = stream;
    }
    update(text) {
        if (this.out.options.json || this.out.options.quiet)
            return;
        const now = Date.now();
        if (!this.out.interactive) {
            if (now - this.lastDraw >= 15_000) {
                this.lastDraw = now;
                this.stream.write(`… ${text}\n`);
            }
            return;
        }
        if (this.shown && now - this.lastDraw < 80)
            return;
        this.lastDraw = now;
        const spinner = this.out.c.cyan(FRAMES[this.frame++ % FRAMES.length]);
        this.stream.write(`\r\u001b[2K${spinner} ${truncate(text, (this.stream.columns ?? 100) - 3)}`);
        this.shown = true;
    }
    clear() {
        if (this.shown)
            this.stream.write('\r\u001b[2K');
        this.shown = false;
    }
}
