/** @jsxImportSource react */
import { test, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { markdown, inline } from "./markdown";

// Real rendering, through React's own server renderer - so what these assert is the markup a browser
// would get, not an intermediate structure. The reason this exists at all: the transcript printed
// `**Hardware & OS**` literally, which is what made the UI look unfinished.

const render = (text: string) => renderToStaticMarkup(<>{markdown(text)}</>);
const renderInline = (text: string) => renderToStaticMarkup(<>{inline(text)}</>);

test("the exact thing that looked broken: bold and bulleted prose", () => {
  const out = render("**Hardware & OS**\n- **CPU:** Apple M4 (10 cores)\n- **RAM:** 16GB");
  expect(out).toContain("<strong>Hardware &amp; OS</strong>");
  expect(out).toContain("<ul>");
  expect(out).toContain("<strong>CPU:</strong>");
  expect(out).not.toContain("**");
});

test("headings, ordered lists, rules and blockquotes", () => {
  expect(render("## Storage")).toContain("<h2>Storage</h2>");
  expect(render("###### deep")).toContain("<h6>deep</h6>");
  expect(render("1. first\n2. second")).toContain("<ol><li>first</li><li>second</li></ol>");
  expect(render("---")).toContain("<hr/>");
  expect(render("> a quote")).toContain("<blockquote>a quote</blockquote>");
});

test("fenced code keeps its content verbatim, including markdown-looking text", () => {
  const out = render("```yaml\nservices:\n  web:\n    image: **not bold**\n```");
  expect(out).toContain('<pre class="code">');
  expect(out).toContain("services:");
  expect(out).toContain("**not bold**"); // inside code, nothing is interpreted
});

test("an unterminated fence renders what it has instead of swallowing the rest", () => {
  const out = render("before\n```\nstill here");
  expect(out).toContain("before");
  expect(out).toContain("still here");
});

test("inline code, italics and links", () => {
  expect(renderInline("run `docker ps` now")).toContain("<code>docker ps</code>");
  expect(renderInline("*emphasis* and _also_")).toBe("<em>emphasis</em> and <em>also</em>");
  expect(renderInline("[docs](https://example.com/x)")).toBe(
    '<a href="https://example.com/x" target="_blank" rel="noreferrer noopener">docs</a>',
  );
});

test("model output is never a way to inject markup or a dangerous link", () => {
  // No innerHTML anywhere, so tags arrive as text.
  const out = render('<img src=x onerror="alert(1)"> and <script>alert(2)</script>');
  // Escaped text is the whole point: the characters may appear, but never as an element or attribute.
  expect(out).toContain("&lt;script&gt;");
  expect(out).toContain("&lt;img");
  expect(out).not.toContain("<script>");
  expect(out).not.toContain("<img");
  // An unsafe scheme keeps its label but is not clickable.
  const link = renderInline("[click](javascript:alert(1))");
  expect(link).toContain("click");
  expect(link).not.toContain("href");
});

test("paragraphs join wrapped lines and separate on a blank line", () => {
  const out = render("one line\nsame paragraph\n\nsecond paragraph");
  expect(out).toContain("<p>one line same paragraph</p>");
  expect(out).toContain("<p>second paragraph</p>");
});

test("a wrapped list item stays one item", () => {
  const out = render("- first item\n  continued here\n- second");
  expect(out).toContain("<li>first item continued here</li>");
  expect(out).toContain("<li>second</li>");
});

test("plain text with no markdown comes out unchanged", () => {
  expect(render("just a sentence.")).toBe("<div><p>just a sentence.</p></div>");
  expect(render("")).toBe("");
});

test("a nested list keeps its nesting instead of flattening", () => {
  const out = render("- Miro Config:\n  - Web UI on port 4281\n  - Auto-update enabled\n- Next item");
  // The children belong to the first item, not to the top-level list.
  expect(out).toContain("<li>Miro Config:<ul><li>Web UI on port 4281</li><li>Auto-update enabled</li></ul></li>");
  expect(out).toContain("<li>Next item</li>");
});

test("an indented plain line is still a continuation, not a child item", () => {
  expect(render("- first\n  wrapped text\n- second")).toContain("<li>first wrapped text</li>");
});
