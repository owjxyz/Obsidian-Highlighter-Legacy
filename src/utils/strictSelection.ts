import { splitSourceBlocks, type BlockKind } from "./sourceBlocks";
import type { SelectionHint } from "./blockOccurrence";

/** A whitespace-normalized, visible string with UTF-16 source boundaries. */
function projectInline(raw: string, offset: number) {
    const starts: number[] = [];
    const ends: number[] = [];
    let text = "";
    const tokens =
        /(?:^[ \t]*(?:>\s*)*(?:#{1,6}\s+|[-*+]\s+(?:\[[ xX]\]\s*)?|\d+[.)]\s+|\[\^[^\]]+\]:\s*))|(?:\*{1,3}|_{1,3}|~~|`+)|(?:\\[\\`*{}[\]()#+\-.!_|>~=])|(?:&(?:#\d+|#x[\da-f]+|[a-z]+);)|[\s\S]/gim;
    for (const match of raw.matchAll(tokens)) {
        const token = match[0];
        const intraword =
            /^_+$/.test(token) &&
            /[\p{L}\p{N}]/u.test(raw[match.index - 1] ?? "") &&
            /[\p{L}\p{N}]/u.test(raw[match.index + token.length] ?? "");
        if (
            (!intraword && /^(?:\*{1,3}|_{1,3}|~~|`+)$/.test(token)) ||
            (token.length > 1 && /^\s*(?:>|#|[-*+]\s|\d+[.)]\s|\[\^)/.test(token))
        )
            continue;
        let value = token;
        if (token.startsWith("\\") && token.length === 2) value = token[1];
        else if (token.startsWith("&") && token.endsWith(";")) {
            value = new DOMParser().parseFromString(token, "text/html").body.textContent ?? token;
        }
        for (const char of value) {
            const normalized = /\s/.test(char) ? " " : char;
            if (normalized === " " && (!text || text.endsWith(" "))) {
                if (text) ends[ends.length - 1] = offset + match.index + token.length;
                continue;
            }
            text += normalized;
            for (let i = 0; i < normalized.length; i++) {
                starts.push(offset + match.index);
                ends.push(offset + match.index + token.length);
            }
        }
    }
    if (text.endsWith(" ")) {
        text = text.slice(0, -1);
        starts.pop();
        ends.pop();
    }
    return { text, starts, ends };
}

/** Require the selected text AND its rendered neighbours; never guess by distance. */
export function locateAnchoredSelection(raw: string, hint: SelectionHint, occurrence: number, kind: BlockKind | null) {
    if (!hint.selected || hint.blockText === undefined) return null;
    const blocks = splitSourceBlocks(raw).filter(
        (block) =>
            block.kind !== "code" &&
            (!kind || block.kind === kind || (block.kind === "footnote" && kind === "paragraph"))
    );
    const matching = blocks
        .map((block) => projectInline(raw.slice(block.start, block.end), block.start))
        .filter((block) => block.text === hint.blockText);
    if (hint.blockTotal !== undefined && matching.length !== hint.blockTotal) return null;
    const block = matching[occurrence];
    if (!block) return null;
    const candidates: number[] = [];
    let from = 0;
    while (from <= block.text.length) {
        const at = block.text.indexOf(hint.selected, from);
        if (at === -1) break;
        if (
            block.text
                .slice(0, at)
                .trimEnd()
                .endsWith(hint.before ?? "") &&
            block.text
                .slice(at + hint.selected.length)
                .trimStart()
                .startsWith(hint.after ?? "")
        )
            candidates.push(at);
        from = at + hint.selected.length;
    }
    if (candidates.length !== 1) return null;
    const at = candidates[0];
    return { start: block.starts[at], end: block.ends[at + hint.selected.length - 1] };
}
