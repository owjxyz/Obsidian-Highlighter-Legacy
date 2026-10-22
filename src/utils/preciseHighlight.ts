import { parseHighlights } from "./highlights";
import { wrapHighlight, type HighlightColor } from "./colors";
import { tableCellRanges } from "./sourceBlocks";

/** Split at unbalanced emphasis boundaries instead of widening the visible selection. */
function wrapSelected(text: string, color: HighlightColor | null) {
    const tokens = [...text.matchAll(/\\[\s\S]|<[^>]+>|\*{1,3}|_{1,3}|~~/g)].filter(
        (token) => !token[0].startsWith("\\")
    );
    const counts = new Map<string, number>();
    for (const token of tokens) counts.set(token[0], (counts.get(token[0]) ?? 0) + 1);
    const boundaries = tokens.filter((token) => token[0].startsWith("<") || counts.get(token[0]) % 2 !== 0);
    if (!boundaries.length) return wrapHighlight(text, color);
    let result = "";
    let cursor = 0;
    for (const token of boundaries) {
        result += wrapHighlight(text.slice(cursor, token.index), color) + token[0];
        cursor = token.index + token[0].length;
    }
    return result + wrapHighlight(text.slice(cursor), color);
}

/** Rewrite only the touched wrappers, retaining the old colours on either side. */
function rewriteSpan(text: string, start: number, end: number, mode: string, color: HighlightColor | null) {
    if (mode.startsWith("toggle-")) {
        const containing = parseHighlights(text).highlights.find((h) => h.start <= start && h.end >= end);
        if (containing && (mode === "toggle-highlight" || containing.color === color))
            return (
                text.slice(0, containing.start) +
                text.slice(containing.innerStart, containing.innerEnd) +
                text.slice(containing.end)
            );
        mode = mode === "toggle-color" ? "color" : "highlight";
    }
    const highlights = parseHighlights(text).highlights.filter((h) => h.innerStart < end && h.innerEnd > start);
    const from = Math.min(start, ...highlights.map((h) => h.start));
    const to = Math.max(end, ...highlights.map((h) => h.end));
    const deletions = highlights
        .flatMap((h) => [
            { start: h.openTagStart, end: h.openTagEnd },
            { start: h.closeTagStart, end: h.closeTagEnd },
        ])
        .sort((a, b) => a.start - b.start);
    const map = (position: number) =>
        position - from - deletions.reduce((sum, d) => sum + Math.max(0, Math.min(position, d.end) - d.start), 0);
    let clean = "";
    let cursor = from;
    for (const d of deletions) {
        clean += text.slice(cursor, d.start);
        cursor = d.end;
    }
    clean += text.slice(cursor, to);
    const a = map(start);
    const b = map(end);
    const existing = highlights.map((h) => ({ start: map(h.innerStart), end: map(h.innerEnd), color: h.color }));
    const cuts = [...new Set([0, clean.length, a, b, ...existing.flatMap((h) => [h.start, h.end])])].sort(
        (x, y) => x - y
    );
    const runs: { text: string; active: boolean; color: HighlightColor | null }[] = [];
    for (let i = 0; i < cuts.length - 1; i++) {
        const left = cuts[i];
        const right = cuts[i + 1];
        if (right <= left) continue;
        const old = existing.find((h) => h.start <= left && h.end >= right);
        const selected = left >= a && right <= b;
        const active = selected ? mode !== "remove" : !!old;
        const shade = selected && mode === "color" ? color : old ? old.color : color;
        const previous = runs[runs.length - 1];
        if (previous && previous.active === active && previous.color === shade)
            previous.text += clean.slice(left, right);
        else runs.push({ text: clean.slice(left, right), active, color: shade });
    }
    const replacement = runs.map((run) => (run.active ? wrapSelected(run.text, run.color) : run.text)).join("");
    return text.slice(0, from) + replacement + text.slice(to);
}

/** Keep link/code syntax whole without ever adding visible, unselected text. */
function protectInlineSyntax(raw: string, start: number, end: number) {
    const tokens = /\[\[[^\]\n]+\]\]|\[[^\]\n]*\]\((?:[^()"]|"[^"]*"|\([^()]*\))*\)|(`+)[^\n]*?\1/g;
    for (const match of raw.matchAll(tokens)) {
        const token = match[0];
        const from = match.index;
        const to = from + token.length;
        if (to <= start || from >= end) continue;
        let innerStart: number;
        let innerEnd: number;
        if (token.startsWith("[[")) {
            const pipe = token.indexOf("|");
            innerStart = from + (pipe === -1 ? 2 : pipe + 1);
            innerEnd = to - 2;
        } else if (token.startsWith("[")) {
            innerStart = from + 1;
            innerEnd = from + token.indexOf("](");
        } else {
            innerStart = from + match[1].length;
            innerEnd = to - match[1].length;
        }
        if ((start > innerStart && start < innerEnd) || (end > innerStart && end < innerEnd)) {
            throw new Error(
                "A partial link or code span cannot be highlighted safely. Select its complete visible text."
            );
        }
        if (start >= from && start <= innerStart) start = from;
        if (end >= innerEnd && end <= to) end = to;
    }
    return { start, end };
}

/** Apply the exact interval per line/cell; preserve every byte of unselected content. */
export function editHighlightRange(
    raw: string,
    start: number,
    end: number,
    mode: string,
    color: HighlightColor | null
) {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > raw.length || start >= end) {
        throw new Error("Invalid highlight range.");
    }
    ({ start, end } = protectInlineSyntax(raw, start, end));
    const bodyStart = raw.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/)?.[0].length ?? 0;
    const parts = raw.split(/(\r\n|\n)/);
    let offset = 0;
    let fence: string | null = null;
    return parts
        .map((line, index) => {
            const lineStart = offset;
            offset += line.length;
            if (index % 2) return line;
            const marker = line.match(/^\s*(?:>\s*)*(`{3,}|~{3,})/)?.[1];
            if (marker) {
                if (!fence) fence = marker;
                else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
                return line;
            }
            if (fence || lineStart < bodyStart || lineStart >= end || lineStart + line.length <= start || !line.trim())
                return line;
            if (/^\s*\|?(\s*:?-+:?\s*\|)+\s*:?-*:?[ \t]*$/.test(line)) return line;
            const table = /^\s*\|/.test(line);
            const prefix =
                line.match(/^[ \t]*(?:>\s*)*(?:#{1,6}\s+|[-*+]\s+(?:\[[ xX]\]\s*)?|\d+[.)]\s+|\[\^[^\]]+\]:\s*)?/)?.[0]
                    .length ?? 0;
            const cells = table ? tableCellRanges(line, 0) : [{ start: prefix, end: line.length }];
            let result = line;
            for (const cell of cells.slice().reverse()) {
                const a = Math.max(cell.start, start - lineStart);
                const b = Math.min(cell.end, end - lineStart);
                if (a >= b) continue;
                const text = result.slice(cell.start, cell.end);
                result =
                    result.slice(0, cell.start) +
                    rewriteSpan(text, a - cell.start, b - cell.start, mode, color) +
                    result.slice(cell.end);
            }
            return result;
        })
        .join("");
}
