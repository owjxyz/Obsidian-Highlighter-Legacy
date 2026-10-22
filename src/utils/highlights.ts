import { colorAt, nearestHighlightColor, stripHighlightMarkers, wrapHighlight, type HighlightColor } from "./colors";

export type HighlightType = "markdown" | "html";

export interface Highlight {
    id: string;
    text: string;
    line: number;
    type: HighlightType;
    /**
     * The native colour, or null for the theme's default. An HTML highlight
     * left by an older version reports the native colour nearest its own.
     */
    color: HighlightColor | null;
    start: number;
    end: number;
    innerStart: number;
    innerEnd: number;
    openTagStart: number;
    openTagEnd: number;
    closeTagStart: number;
    closeTagEnd: number;
    openTag?: string;
    tagsText: string;
    footnoteId: string | null;
}

export interface ParsedHighlights {
    highlights: Highlight[];
}

interface StyleAttr {
    quote: string;
    value: string;
    index: number;
    length: number;
}

interface Deletion {
    start: number;
    end: number;
}

function detectNewline(raw: string): string {
    return raw.includes("\r\n") ? "\r\n" : "\n";
}

/**
 * Which lines sit inside a fenced code block, fences included. A fence opened
 * with backticks only closes on backticks, and at least as many of them.
 */
function fencedLines(lines: string[]): boolean[] {
    const result: boolean[] = [];
    let fence: string | null = null;
    for (const line of lines) {
        const marker = line.match(/^[ \t]{0,3}(?:>[ \t]?)*(`{3,}|~{3,})/)?.[1] ?? null;
        if (fence === null) {
            if (marker) fence = marker;
            result.push(fence !== null);
        } else {
            result.push(true);
            if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
        }
    }
    return result;
}

function extractStyleAttribute(openTag: string): StyleAttr | null {
    const styleMatch = openTag.match(/\sstyle=(["'])([\s\S]*?)\1/i);
    if (!styleMatch) return null;
    return {
        quote: styleMatch[1],
        value: styleMatch[2],
        index: styleMatch.index ?? -1,
        length: styleMatch[0].length,
    };
}

function extractBackgroundFromStyle(styleValue: string | null | undefined): string | null {
    if (!styleValue) return null;
    const parts = styleValue
        .split(";")
        .map((part) => part.trim())
        .filter(Boolean);
    for (const part of parts) {
        const colon = part.indexOf(":");
        if (colon === -1) continue;
        const key = part.slice(0, colon).trim().toLowerCase();
        const value = part.slice(colon + 1).trim();
        if (key === "background" || key === "background-color") {
            return value || null;
        }
    }
    return null;
}

export function parseHighlights(raw: string): ParsedHighlights {
    const newline = detectNewline(raw);
    const highlights: Highlight[] = [];

    const lines = raw.split(/\r?\n/);
    let lineOffset = 0;

    const inFence = fencedLines(lines);

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const line = lines[lineIdx];

        // `==` inside a code block is code (`a == b`), not a highlight.
        if (inFence[lineIdx]) {
            lineOffset += line.length + (lineIdx < lines.length - 1 ? newline.length : 0);
            continue;
        }

        const markdownPattern = /==(.*?)==/g;
        const htmlPattern = /<mark\b[^>]*>(.*?)<\/mark>/gi;

        let match: RegExpExecArray | null;
        while ((match = markdownPattern.exec(line)) !== null) {
            const start = lineOffset + match.index;
            const end = start + match[0].length;
            // A colour emoji straight after the opening marker belongs to the
            // marker: Obsidian reads it as the colour and never shows it.
            const colour = colorAt(match[1] ?? "");
            const innerText = (match[1] ?? "").slice(colour.length);
            const innerStart = start + 2 + colour.length;
            const innerEnd = end - 2;

            // Read existing tags/footnotes only to avoid merging across their boundaries.
            const tagsText = line.slice(0, match.index).match(/(?:^|\s)(#[^\s#]+(?:\s+#[^\s#]+)*)\s*$/u)?.[1] ?? "";
            const after = line.slice(match.index + match[0].length);
            const footnoteId =
                after.match(/^\[\^([^\]]+)\]/)?.[1] ?? innerText.match(/\[\^([^\]]+)\]\s*$/)?.[1] ?? null;

            highlights.push({
                id: "",
                text: innerText.trim(),
                line: lineIdx,
                type: "markdown",
                color: colour.color,
                start,
                end,
                innerStart,
                innerEnd,
                openTagStart: start,
                openTagEnd: innerStart,
                closeTagStart: innerEnd,
                closeTagEnd: end,
                tagsText,
                footnoteId,
            });
        }

        while ((match = htmlPattern.exec(line)) !== null) {
            const start = lineOffset + match.index;
            const end = start + match[0].length;

            const innerText = match[1] ?? "";
            const full = match[0];
            const openTagMatch = full.match(/^<mark\b[^>]*>/i);
            const openTag = openTagMatch ? openTagMatch[0] : "<mark>";
            const openTagEndInMatch = openTag.length;
            const closeTagLength = "</mark>".length;

            const openTagStart = start;
            const openTagEnd = start + openTagEndInMatch;
            const innerStart = openTagEnd;
            const innerEnd = end - closeTagLength;

            const styleAttr = extractStyleAttribute(openTag);
            const color = nearestHighlightColor(styleAttr ? extractBackgroundFromStyle(styleAttr.value) : null);

            // Read existing tags/footnotes only to avoid merging across their boundaries.
            const tagsText = line.slice(0, match.index).match(/(?:^|\s)(#[^\s#]+(?:\s+#[^\s#]+)*)\s*$/u)?.[1] ?? "";
            const after = line.slice(match.index + match[0].length);
            const footnoteId =
                after.match(/^\[\^([^\]]+)\]/)?.[1] ?? innerText.match(/\[\^([^\]]+)\]\s*$/)?.[1] ?? null;

            highlights.push({
                id: "",
                text: (match[1] ?? "").trim(),
                line: lineIdx,
                type: "html",
                color,
                start,
                end,
                innerStart,
                innerEnd,
                openTagStart,
                openTagEnd,
                closeTagStart: innerEnd,
                closeTagEnd: end,
                openTag,
                tagsText,
                footnoteId,
            });
        }

        lineOffset += line.length + (lineIdx < lines.length - 1 ? newline.length : 0);
    }

    highlights.sort((a, b) => a.start - b.start);
    // Ids count by position within the line, not by syntax, so converting an
    // HTML highlight to a native one leaves every id on the line unchanged.
    const perLine = new Map<number, number>();
    for (const highlight of highlights) {
        const n = perLine.get(highlight.line) ?? 0;
        highlight.id = `${highlight.line}:${n}`;
        perLine.set(highlight.line, n + 1);
    }
    return { highlights };
}

export function findHighlightById(parsed: ParsedHighlights, id: string): Highlight | null {
    return parsed.highlights.find((h) => h.id === id) || null;
}

export function removeHighlightFromRaw(raw: string, highlight: Highlight | null): string {
    if (!highlight) return raw;
    const before = raw.slice(0, highlight.openTagStart);
    const inner = raw.slice(highlight.innerStart, highlight.innerEnd);
    const after = raw.slice(highlight.closeTagEnd);
    return before + inner + after;
}

/**
 * Give a highlight a native colour, or none for the theme's default.
 *
 * An HTML highlight left by an older version becomes a native one: the plugin
 * no longer writes HTML into notes.
 */
export function updateHighlightColorInRaw(
    raw: string,
    highlight: Highlight | null,
    newColor: HighlightColor | null
): string {
    if (!highlight) return raw;
    // Markers nested inside would end up inside the new pair, so drop them.
    const inner = stripHighlightMarkers(
        raw.slice(highlight.innerStart, highlight.innerEnd).replace(/<mark\b[^>]*>|<\/mark>/gi, "")
    );
    return raw.slice(0, highlight.openTagStart) + wrapHighlight(inner, newColor) + raw.slice(highlight.closeTagEnd);
}

/** Highlights that do not sit inside another one, so each can be rewritten whole. */
function outermost(highlights: Highlight[]): Highlight[] {
    return highlights.filter(
        (h) =>
            !highlights.some(
                (other) => other !== h && other.openTagStart <= h.openTagStart && other.closeTagEnd >= h.closeTagEnd
            )
    );
}

function applyDeletions(raw: string, deletions: Deletion[]): string {
    const ranges = (deletions || [])
        .filter((r) => r && Number.isInteger(r.start) && Number.isInteger(r.end) && r.end > r.start)
        .sort((a, b) => b.start - a.start);

    let updated = raw;
    for (const range of ranges) {
        updated = updated.slice(0, range.start) + updated.slice(range.end);
    }
    return updated;
}

export function mergeAdjacentHighlightsInRaw(raw: string): { raw: string; mergedCount: number } {
    let updated = String(raw ?? "");
    let mergedCount = 0;
    let passes = 0;

    while (passes < 250) {
        passes++;
        const parsed = parseHighlights(updated);
        const highlights = parsed.highlights;
        const deletions: Deletion[] = [];
        let mergedThisPass = 0;

        for (let i = 0; i < highlights.length - 1; i++) {
            const a = highlights[i];
            const b = highlights[i + 1];

            if (a.line !== b.line) continue;
            if (a.type !== b.type) continue;
            if ((a.tagsText || "").trim() || (b.tagsText || "").trim()) continue;
            if (a.footnoteId || b.footnoteId) continue;

            const between = updated.slice(a.closeTagEnd, b.openTagStart);
            if (!/^\s*$/.test(between)) continue;

            // Joining two highlights keeps the first one's opening marker, so
            // they must look the same: same colour, and for HTML the same tag.
            if (a.color !== b.color) continue;
            if (a.type === "html") {
                const aOpen = updated.slice(a.openTagStart, a.openTagEnd);
                const bOpen = updated.slice(b.openTagStart, b.openTagEnd);
                if (aOpen !== bOpen) continue;
            }

            deletions.push({ start: a.closeTagStart, end: a.closeTagEnd });
            deletions.push({ start: b.openTagStart, end: b.openTagEnd });
            mergedThisPass++;
            i++; // skip b - it is merged into a
        }

        if (mergedThisPass === 0) break;
        updated = applyDeletions(updated, deletions);
        mergedCount += mergedThisPass;
    }

    return { raw: updated, mergedCount };
}

/** Which highlights a recolour applies to. */
export type RecolorSource = "any" | "default" | HighlightColor;

/**
 * Recolour every highlight in the note whose colour is `from`. HTML highlights
 * count by their nearest native colour and come out native.
 */
export function recolorHighlightsInRaw(
    raw: string,
    { from = "any", to = null }: { from?: RecolorSource; to?: HighlightColor | null } = {}
): { raw: string; changedCount: number } {
    let updated = String(raw ?? "");
    const candidates = outermost(parseHighlights(updated).highlights)
        .filter((h) => from === "any" || (from === "default" ? h.color === null : h.color === from))
        .sort((a, b) => b.openTagStart - a.openTagStart);

    let changedCount = 0;
    for (const highlight of candidates) {
        const before = updated;
        updated = updateHighlightColorInRaw(updated, highlight, to);
        if (updated !== before) changedCount++;
    }

    return { raw: updated, changedCount };
}

/**
 * Turn the HTML highlights older versions wrote, `<mark style="background:
 * …">` and background-coloured `<span>`s, into native `==` highlights in the
 * nearest native colour. Code blocks are left alone.
 */
export function convertHtmlHighlightsInRaw(raw: string): { raw: string; changedCount: number } {
    const source = String(raw ?? "");
    const newline = detectNewline(source);
    const lines = source.split(/\r?\n/);
    const inFence = fencedLines(lines);
    let changedCount = 0;

    const converted = lines.map((line, index) => {
        if (inFence[index]) return line;
        return line
            .replace(/<mark\b([^>]*)>(.*?)<\/mark>/gi, (_full, attrs: string, inner: string) => {
                changedCount++;
                const style = extractStyleAttribute(` ${attrs}`);
                const color = nearestHighlightColor(style ? extractBackgroundFromStyle(style.value) : null);
                return wrapHighlight(stripHighlightMarkers(inner), color);
            })
            .replace(/<span\b([^>]*)>(.*?)<\/span>/gi, (full: string, attrs: string, inner: string) => {
                const style = extractStyleAttribute(` ${attrs}`);
                const background = style ? extractBackgroundFromStyle(style.value) : null;
                if (!background) return full;
                changedCount++;
                return wrapHighlight(stripHighlightMarkers(inner), nearestHighlightColor(background));
            });
    });

    return { raw: converted.join(newline), changedCount };
}

/**
 * Remove every highlight in the note, keeping its text. Works from the parsed
 * highlights rather than a blanket `==` replace, so code (`a == b`) and lone
 * markers are left as they are.
 */
export function removeAllHighlightsFromRaw(raw: string): { raw: string; removedCount: number } {
    const source = String(raw ?? "");
    const highlights = parseHighlights(source).highlights;
    // Every marker is deleted in one pass, so a highlight nested in another
    // cannot be thrown off by offsets that shifted under it.
    const deletions = highlights.flatMap((h) => [
        { start: h.openTagStart, end: h.openTagEnd },
        { start: h.closeTagStart, end: h.closeTagEnd },
    ]);
    return { raw: applyDeletions(source, deletions), removedCount: highlights.length };
}
