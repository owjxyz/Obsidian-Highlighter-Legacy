import { describe, it, expect } from "vitest";
import { setup, textNodes } from "./WritePath.test.js";
import { TFile } from "./obsidian-stub.js";

function selection(ctx, first, start, last = first, end = start + 4) {
    const range = ctx.doc.createRange();
    range.setStart(first, start);
    range.setEnd(last, end);
    const sel = ctx.window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    return { text: range.toString(), range };
}

async function paint(ctx, snapshot, mode = "color") {
    if (mode === "remove") await ctx.plugin.removeHighlightSelection(ctx.view, snapshot);
    else if (mode === "highlight") await ctx.plugin.highlightSelection(ctx.view, snapshot);
    else await ctx.plugin.applyColorHighlight(ctx.view, "red", snapshot);
}

describe("precise Reading View selection", () => {
    it("highlights the parent list text without including its nested items in the anchor", async () => {
        const ctx = await setup(
            "- Investment companies (투자회사)\n  - Mutual funds (뮤추얼 펀드)\n  - Hedge funds (헤지펀드)",
            "<ul><li>Investment companies (투자회사)<ul><li>Mutual funds (뮤추얼 펀드)</li><li>Hedge funds (헤지펀드)</li></ul></li></ul>"
        );
        const node = textNodes(ctx.content)[0];
        await ctx.plugin.applyColorByIndex(ctx.view, 0, selection(ctx, node, 0, node, 10), true);
        expect(ctx.out()).toBe(
            "- ==🔴Investment== companies (투자회사)\n  - Mutual funds (뮤추얼 펀드)\n  - Hedge funds (헤지펀드)"
        );
    });

    it.each([false, true])("highlights every word in nested lists (loose: %s), including trusts", async (loose) => {
        const raw =
            "- Investment companies (투자회사)\n  - Unit investment trusts (단위투자신탁)\n  - Mutual funds (뮤추얼 펀드)\n- Other organizations\n  1. Closed end funds\n  2. Hedge policies";
        const tightHtml =
            "<ul><li>Investment companies (투자회사)<ul><li>Unit investment trusts (단위투자신탁)</li><li>Mutual funds (뮤추얼 펀드)</li></ul></li><li>Other organizations<ol><li>Closed end funds</li><li>Hedge policies</li></ol></li></ul>";
        const html = loose ? tightHtml.replace(/<li>([^<]+)/g, "<li><p>$1</p>") : tightHtml;
        const initial = await setup(raw, html);
        const labels = textNodes(initial.content).map((node) => node.nodeValue);
        for (let index = 0; index < labels.length; index++) {
            const label = labels[index];
            for (const word of label.matchAll(/[\p{L}\p{N}]+/gu)) {
                for (const [color, emoji] of [
                    [0, "🔴"],
                    [1, "🟠"],
                    [2, "🟡"],
                    [3, "🟢"],
                    [4, "🔵"],
                    [5, "🟣"],
                ]) {
                    const ctx = await setup(raw, html);
                    const node = textNodes(ctx.content)[index];
                    const start = raw.indexOf(label) + word.index;
                    await ctx.plugin.applyColorByIndex(
                        ctx.view,
                        color,
                        selection(ctx, node, word.index, node, word.index + word[0].length),
                        true
                    );
                    expect(ctx.out(), `selected ${word[0]} in ${label}, color ${color}`).toBe(
                        raw.slice(0, start) + "==" + emoji + word[0] + "==" + raw.slice(start + word[0].length)
                    );
                }
            }
        }
    });

    it("keeps both parent and child portions of a selection spanning a nested list", async () => {
        const ctx = await setup(
            "- first alpha\n  - second beta\n  - third gamma",
            "<ul><li>first alpha<ul><li>second beta</li><li>third gamma</li></ul></li></ul>"
        );
        const nodes = textNodes(ctx.content);
        await paint(ctx, selection(ctx, nodes[0], 6, nodes[1], 6));
        expect(ctx.out()).toBe("- first ==🔴alpha==\n  - ==🔴second== beta\n  - third gamma");
    });

    it.each([
        [
            "A [rate](https://example.org) and rate.\n\nA rate and rate.",
            "<p>A <a>rate</a> and rate.</p><p>A rate and rate.</p>",
            "A [rate](https://example.org) and ==🔴rate==.\n\nA rate and rate.",
        ],
        ["A a_b rate.\n\nA a\\_b rate.", "<p>A a_b rate.</p><p>A a_b rate.</p>", "A a_b ==🔴rate==.\n\nA a\\_b rate."],
    ])("does not shift duplicate-paragraph ordinals in %s", async (raw, html, expected) => {
        const ctx = await setup(raw, html);
        const node = textNodes(ctx.content.querySelector("p")).at(-1);
        const start = node.nodeValue.lastIndexOf("rate");
        await paint(ctx, selection(ctx, node, start));
        expect(ctx.out()).toBe(expected);
    });

    it("refuses a source/DOM block-count mismatch rather than selecting another paragraph", async () => {
        const raw = "A * rate.\n\nA \\* rate.";
        const ctx = await setup(raw, "<p>A * rate.</p><p>A * rate.</p>");
        await paint(ctx, selection(ctx, textNodes(ctx.content.querySelector("p"))[0], 4));
        expect(ctx.out()).toBe(raw);
    });

    it("keeps the default highlight colour outside a recoloured selection", async () => {
        const ctx = await setup("==alpha beta gamma==", "<p><mark>alpha beta gamma</mark></p>");
        await paint(ctx, selection(ctx, textNodes(ctx.content)[0], 6));
        expect(ctx.out()).toBe("==alpha== ==🔴beta== ==gamma==");
    });

    it("uses the same footnote normalization when numbering duplicate paragraphs", async () => {
        const raw = "A rate[^a].\n\nA rate[^b].\n\n[^a]: One.\n[^b]: Two.";
        const ctx = await setup(
            raw,
            '<p>A rate<sup class="footnote-ref">1</sup>.</p><p>A rate<sup class="footnote-ref">2</sup>.</p>'
        );
        const node = textNodes(ctx.content.querySelectorAll("p")[1])[0];
        await paint(ctx, selection(ctx, node, 2));
        expect(ctx.out()).toBe("A rate[^a].\n\nA ==🔴rate==[^b].\n\n[^a]: One.\n[^b]: Two.");
    });

    it("refuses to span an embedded note in the middle of a selection", async () => {
        const raw = "first alpha\n\n![[embed]]\n\nsecond beta";
        const ctx = await setup(
            raw,
            '<p>first alpha</p><div class="internal-embed"><p>embedded stuff</p></div><p>second beta</p>'
        );
        const read = ctx.plugin.app.vault.read;
        ctx.plugin.app.vault.read = (file) =>
            file.path === "embed.md" ? Promise.resolve("embedded stuff") : read(file);
        const at = raw.indexOf("![[");
        ctx.plugin.app.metadataCache.getFileCache = (file) => ({
            embeds:
                file.path === "note.md"
                    ? [{ link: "embed", position: { start: { offset: at }, end: { offset: at + 10 } } }]
                    : [],
        });
        ctx.plugin.app.metadataCache.getFirstLinkpathDest = () => new TFile("embed.md");
        const nodes = textNodes(ctx.content);
        await paint(ctx, selection(ctx, nodes[0], 6, nodes[2], 6));
        expect(ctx.out()).toBe(raw);
    });

    it.each([
        ["A \\* here", "<p>A * here</p>", 0, 2, 0, 3, "A ==🔴\\*== here"],
        [
            "<strong>alpha</strong> beta",
            "<p><strong>alpha</strong> beta</p>",
            0,
            2,
            1,
            5,
            "<strong>al==🔴pha==</strong> ==🔴beta==",
        ],
        [
            "A [rate](https://example.org) and rate.",
            "<p>A <a>rate</a> and rate.</p>",
            2,
            5,
            2,
            9,
            "A [rate](https://example.org) and ==🔴rate==.",
        ],
    ])("preserves inline syntax in %s", async (raw, html, a, start, b, end, expected) => {
        const ctx = await setup(raw, html);
        const nodes = textNodes(ctx.content);
        await paint(ctx, selection(ctx, nodes[a], start, nodes[b], end));
        expect(ctx.out()).toBe(expected);
    });

    it("highlights footnote prose without including its return links or treating it as a list item", async () => {
        const ctx = await setup(
            "A reference[^note].\n\n[^note]: Keep this footnote unchanged.",
            '<p>A reference<sup class="footnote-ref">1</sup>.</p><section class="footnotes"><ol><li data-footnote-id="fn-1"><p>Keep this footnote unchanged.<a class="footnote-backref">↩︎</a><a class="footnote-backref">↩︎</a></p></li></ol></section>'
        );
        const node = ctx.content.querySelector(".footnotes p").firstChild;
        await paint(ctx, selection(ctx, node, 10, node, 18));
        expect(ctx.out()).toBe("A reference[^note].\n\n[^note]: Keep this ==🔴footnote== unchanged.");
    });

    it("never falls back to a different digit when a footnote reference is selected", async () => {
        const raw = "Price 1 rate[^a].\n\n[^a]: note";
        const ctx = await setup(raw, '<p>Price 1 rate<sup class="footnote-ref">1</sup>.</p>');
        const node = ctx.content.querySelector("sup").firstChild;
        await paint(ctx, selection(ctx, node, 0, node, 1));
        expect(ctx.out()).toBe(raw);
    });

    it("removes a containing highlight and its colour when its shortcut is repeated", async () => {
        const ctx = await setup("==🔴alpha beta gamma==", "<p><mark>alpha beta gamma</mark></p>");
        const snapshot = selection(ctx, textNodes(ctx.content)[0], 6);
        await ctx.plugin.applyColorByIndex(ctx.view, 0, snapshot, true);
        expect(ctx.out()).toBe("alpha beta gamma");
    });

    const shortcutColours = ["🔴", "🟠", "🟡", "🟢", "🔵", "🟣"];
    it.each(shortcutColours.flatMap((old, i) => shortcutColours.map((next, j) => [old, next, i === j, j])))(
        "changes %s to %s within the selection, or removes it when the colours match",
        async (old, next, same, index) => {
            const raw = `==${old}alpha beta gamma==`;
            const ctx = await setup(raw, "<p><mark>alpha beta gamma</mark></p>");
            await ctx.plugin.applyColorByIndex(ctx.view, index, selection(ctx, textNodes(ctx.content)[0], 6), true);
            expect(ctx.out()).toBe(same ? "alpha beta gamma" : `==${old}alpha== ==${next}beta== ==${old}gamma==`);
            await ctx.plugin.undoLastHighlight();
            expect(ctx.out()).toBe(raw);
        }
    );

    it("recolours a complete highlight with a different shortcut colour", async () => {
        const ctx = await setup("==🟡alpha beta gamma==", "<p><mark>alpha beta gamma</mark></p>");
        const node = textNodes(ctx.content)[0];
        await ctx.plugin.applyColorByIndex(ctx.view, 0, selection(ctx, node, 0, node, 16), true);
        expect(ctx.out()).toBe("==🔴alpha beta gamma==");
    });

    it.each(["==alpha beta gamma==", '<mark style="background: yellow">alpha beta gamma</mark>'])(
        "recolours the selected part of a default or HTML highlight: %s",
        async (raw) => {
            const ctx = await setup(raw, "<p><mark>alpha beta gamma</mark></p>");
            await ctx.plugin.applyColorByIndex(ctx.view, 0, selection(ctx, textNodes(ctx.content)[0], 6), true);
            const old = raw.startsWith("==") ? "" : "🟡";
            expect(ctx.out()).toBe(`==${old}alpha== ==🔴beta== ==${old}gamma==`);
        }
    );

    it("keeps the generic highlight shortcut's removal behaviour regardless of colour", async () => {
        const ctx = await setup("==🟡alpha beta gamma==", "<p><mark>alpha beta gamma</mark></p>");
        await ctx.plugin.highlightSelection(ctx.view, selection(ctx, textNodes(ctx.content)[0], 6), true);
        expect(ctx.out()).toBe("alpha beta gamma");
    });

    it("recolours other colours and removes the requested colour across multiple lines", async () => {
        const ctx = await setup(
            "==🟡alpha==\n==🔴beta==\ngamma",
            "<p><mark>alpha</mark><br><mark>beta</mark><br>gamma</p>"
        );
        const nodes = textNodes(ctx.content);
        await ctx.plugin.applyColorByIndex(ctx.view, 0, selection(ctx, nodes[0], 0, nodes[2], 5), true);
        expect(ctx.out()).toBe("==🔴alpha==\nbeta\n==🔴gamma==");
    });

    it("applies the colour comparison separately in each selected table cell", async () => {
        const ctx = await setup(
            "| A | B | C |\n| --- | --- | --- |\n| ==🟡alpha== | ==🔴beta== | gamma |",
            "<table><thead><tr><th>A</th><th>B</th><th>C</th></tr></thead><tbody><tr><td><mark>alpha</mark></td><td><mark>beta</mark></td><td>gamma</td></tr></tbody></table>"
        );
        const cells = ctx.content.querySelectorAll("td");
        await ctx.plugin.applyColorByIndex(
            ctx.view,
            0,
            selection(ctx, cells[0].firstChild.firstChild, 0, cells[2].firstChild, 5),
            true
        );
        expect(ctx.out()).toBe("| A | B | C |\n| --- | --- | --- |\n| ==🔴alpha== | beta | ==🔴gamma== |");
    });

    it("applies a shortcut colour when the selection has no containing highlight", async () => {
        const ctx = await setup("alpha beta gamma", "<p>alpha beta gamma</p>");
        await ctx.plugin.applyColorByIndex(ctx.view, 0, selection(ctx, textNodes(ctx.content)[0], 6), true);
        expect(ctx.out()).toBe("alpha ==🔴beta== gamma");
    });

    it("toggles off each containing highlight across multiple source lines", async () => {
        const ctx = await setup("==🔴alpha==\n==🔴beta==", "<p><mark>alpha</mark><br><mark>beta</mark></p>");
        const nodes = textNodes(ctx.content);
        await ctx.plugin.applyColorByIndex(ctx.view, 0, selection(ctx, nodes[0], 0, nodes[1], 4), true);
        expect(ctx.out()).toBe("alpha\nbeta");
    });

    it("uses both neighbours of a repeated word despite hidden wiki targets", async () => {
        const raw = "A [[rate details|rate]] and rate.";
        const ctx = await setup(raw, "<p>A <a>rate</a> and rate.</p>");
        const last = textNodes(ctx.content).at(-1);
        await paint(ctx, selection(ctx, last, 5));
        expect(ctx.out()).toBe("A [[rate details|rate]] and ==🔴rate==.");
    });

    it("never matches a word inside a named footnote identifier", async () => {
        const ctx = await setup(
            "A rate[^prof-ch1-rate] and rate.\n\n[^prof-ch1-rate]: Explanation.",
            '<p>A rate<sup class="footnote-ref">1</sup> and rate.</p>'
        );
        const last = textNodes(ctx.content).at(-1);
        await paint(ctx, selection(ctx, last, 5));
        expect(ctx.out()).toBe("A rate[^prof-ch1-rate] and ==🔴rate==.\n\n[^prof-ch1-rate]: Explanation.");
    });

    it("does not count an image caption as visible text", async () => {
        const ctx = await setup(
            "A ![rate](picture.png) and rate and rate.",
            '<p>A <img alt="rate"> and rate and rate.</p>'
        );
        const last = textNodes(ctx.content).at(-1);
        await paint(ctx, selection(ctx, last, 14));
        expect(ctx.out()).toBe("A ![rate](picture.png) and rate and ==🔴rate==.");
    });

    it("preserves punctuation outside the actual selection", async () => {
        const ctx = await setup("A (rate), then rate.", "<p>A (rate), then rate.</p>");
        await paint(ctx, selection(ctx, textNodes(ctx.content)[0], 3));
        expect(ctx.out()).toBe("A (==🔴rate==), then rate.");
    });

    it("uses the exact selected number, without dropping digits", async () => {
        const ctx = await setup("rate 10 and rate 20", "<p>rate 10 and rate 20</p>");
        const node = textNodes(ctx.content)[0];
        await paint(ctx, selection(ctx, node, 12, node, 19));
        expect(ctx.out()).toBe("rate 10 and ==🔴rate 20==");
    });

    it.each([
        [
            "> Quoted rate here.",
            "<blockquote><p>Quoted rate here.</p></blockquote>",
            "rate",
            "> Quoted ==🔴rate== here.",
        ],
        [
            "- Hold bonds >>> note <<<\n- Index funds => track",
            "<ul><li>Hold bonds &gt;&gt;&gt; note &lt;&lt;&lt;</li><li>Index funds =&gt; track</li></ul>",
            "funds",
            "- Hold bonds >>> note <<<\n- Index ==🔴funds== => track",
        ],
        [
            "- Hold bonds >>> note <<<\n- Index funds => track",
            "<ul><li>Hold bonds &gt;&gt;&gt; note &lt;&lt;&lt;</li><li>Index funds =&gt; track</li></ul>",
            "note",
            "- Hold bonds >>> ==🔴note== <<<\n- Index funds => track",
        ],
        [
            "NAV $x+y$ rate",
            '<p>NAV <span class="math math-inline"><mjx-container>x+y</mjx-container></span> rate</p>',
            "rate",
            "NAV $x+y$ ==🔴rate==",
        ],
        ["Cost $105 then $78 rate", "<p>Cost $105 then $78 rate</p>", "rate", "Cost $105 then $78 ==🔴rate=="],
        ["Literal \\$x$ rate", "<p>Literal $x$ rate</p>", "rate", "Literal \\$x$ ==🔴rate=="],
        ["Code `$x$` rate", "<p>Code <code>$x$</code> rate</p>", "rate", "Code `$x$` ==🔴rate=="],
    ])("keeps prose selectable around source syntax in %s", async (raw, html, word, expected) => {
        const ctx = await setup(raw, html);
        const node = textNodes(ctx.content).find((n) => n.nodeValue.includes(word));
        const start = node.nodeValue.indexOf(word);
        await paint(ctx, selection(ctx, node, start, node, start + word.length));
        expect(ctx.out()).toBe(expected);
    });

    it("recognizes HTML attributes containing literal angle brackets", async () => {
        const ctx = await setup(
            'A <span title="x < y > z">rate</span> here',
            '<p>A <span title="x < y > z">rate</span> here</p>'
        );
        const node = ctx.content.querySelector("span").firstChild;
        await paint(ctx, selection(ctx, node, 0));
        expect(ctx.out()).toBe('A <span title="x < y > z">==🔴rate==</span> here');
    });

    it("keeps prose after a multiline inline code span selectable", async () => {
        const ctx = await setup("before `a\nb` after", "<p>before <code>a b</code> after</p>");
        const node = textNodes(ctx.content).at(-1);
        await paint(ctx, selection(ctx, node, 1, node, 6));
        expect(ctx.out()).toBe("before `a\nb` ==🔴after==");
    });

    it("refuses a stale selection when its surrounding text changed", async () => {
        const ctx = await setup("Old rate elsewhere.", "<p>Selected rate here.</p>");
        await paint(ctx, selection(ctx, textNodes(ctx.content)[0], 9));
        expect(ctx.out()).toBe("Old rate elsewhere.");
    });

    it("keeps partially selected first and last source lines exact", async () => {
        const ctx = await setup("first alpha\nsecond beta", "<p>first alpha<br>second beta</p>");
        const nodes = textNodes(ctx.content);
        await paint(ctx, selection(ctx, nodes[0], 6, nodes[1], 6));
        expect(ctx.out()).toBe("first ==🔴alpha==\n==🔴second== beta");
    });

    it("uses the same exact boundaries for plain highlighting", async () => {
        const ctx = await setup("first alpha\nsecond beta", "<p>first alpha<br>second beta</p>");
        const nodes = textNodes(ctx.content);
        await paint(ctx, selection(ctx, nodes[0], 6, nodes[1], 6), "highlight");
        expect(ctx.out()).toBe("first ==alpha==\n==second== beta");
    });

    it("colours partial endpoints across separate paragraphs", async () => {
        const ctx = await setup("first alpha\n\nsecond beta", "<p>first alpha</p><p>second beta</p>");
        const nodes = textNodes(ctx.content);
        await paint(ctx, selection(ctx, nodes[0], 6, nodes[1], 6));
        expect(ctx.out()).toBe("first ==🔴alpha==\n\n==🔴second== beta");
    });

    it("recolours only the selected part of an existing highlight", async () => {
        const ctx = await setup(
            "==🟡alpha beta gamma==",
            '<p><mark data-highlight="yellow">alpha beta gamma</mark></p>'
        );
        await paint(ctx, selection(ctx, textNodes(ctx.content)[0], 6));
        expect(ctx.out()).toBe("==🟡alpha== ==🔴beta== ==🟡gamma==");
    });

    it("erases only the selected part of an existing highlight", async () => {
        const ctx = await setup(
            "==🟡alpha beta gamma==",
            '<p><mark data-highlight="yellow">alpha beta gamma</mark></p>'
        );
        await paint(ctx, selection(ctx, textNodes(ctx.content)[0], 6), "remove");
        expect(ctx.out()).toBe("==🟡alpha== beta ==🟡gamma==");
    });

    it("highlights a word inside a cell without selecting the whole cell", async () => {
        const ctx = await setup("| alpha beta | gamma |", "<table><tr><td>alpha beta</td><td>gamma</td></tr></table>");
        await paint(ctx, selection(ctx, textNodes(ctx.content)[0], 6));
        expect(ctx.out()).toBe("| alpha ==🔴beta== | gamma |");
    });

    it("erases one cell without changing the neighbouring cell", async () => {
        const raw = "| ==🟡alpha beta== | ==🔵gamma== |";
        const ctx = await setup(
            raw,
            "<table><tr><td><mark>alpha beta</mark></td><td><mark>gamma</mark></td></tr></table>"
        );
        await paint(ctx, selection(ctx, textNodes(ctx.content)[0], 6), "remove");
        expect(ctx.out()).toBe("| ==🟡alpha== beta | ==🔵gamma== |");
    });

    it("preserves CRLF and list prefixes across a partial selection", async () => {
        const ctx = await setup("- first alpha\r\n- second beta", "<ul><li>first alpha</li><li>second beta</li></ul>");
        const nodes = textNodes(ctx.content);
        await paint(ctx, selection(ctx, nodes[0], 6, nodes[1], 6));
        expect(ctx.out()).toBe("- first ==🔴alpha==\r\n- ==🔴second== beta");
    });

    it("does not overwrite an edit made after the source range was located", async () => {
        const raw = "A rate here.";
        const ctx = await setup(raw, "<p>A rate here.</p>");
        const locate = ctx.plugin.logic.locateSelection.bind(ctx.plugin.logic);
        ctx.plugin.logic.locateSelection = async (...args) => {
            const result = await locate(...args);
            await ctx.plugin.app.vault.modify(ctx.view.file, "New edit. " + raw);
            return result;
        };
        await paint(ctx, selection(ctx, textNodes(ctx.content)[0], 2));
        expect(ctx.out()).toBe("New edit. A rate here.");
    });

    it("keeps emoji UTF-16 boundaries and punctuation exact", async () => {
        const ctx = await setup("A 🐱 here.", "<p>A 🐱 here.</p>");
        const node = textNodes(ctx.content)[0];
        await paint(ctx, selection(ctx, node, 2, node, 4));
        expect(ctx.out()).toBe("A ==🔴🐱== here.");
    });

    it("maps decoded entities back to their complete source token", async () => {
        const ctx = await setup("A &amp; B", "<p>A &amp; B</p>");
        const node = textNodes(ctx.content)[0];
        await paint(ctx, selection(ctx, node, 2, node, 3));
        expect(ctx.out()).toBe("A ==🔴&amp;== B");
    });

    it("balances emphasis when a selection crosses its closing marker", async () => {
        const ctx = await setup("**bold** next", "<p><strong>bold</strong> next</p>");
        const nodes = textNodes(ctx.content);
        await paint(ctx, selection(ctx, nodes[0], 2, nodes[1], 5));
        expect(ctx.out()).toBe("**bo==🔴ld==** ==🔴next==");
    });

    it("refuses a partial wiki label instead of colouring the whole label", async () => {
        const raw = "A [[Note|rates]] here.";
        const ctx = await setup(raw, "<p>A <a>rates</a> here.</p>");
        const node = textNodes(ctx.content)[1];
        await paint(ctx, selection(ctx, node, 0));
        expect(ctx.out()).toBe(raw);
    });
});
