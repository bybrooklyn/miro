/** @jsxImportSource react */
import type { ReactNode } from "react";

// Markdown for what the model actually writes: headings, bold, italic, inline code, fenced code, lists,
// blockquotes, rules, links. Rendering it raw put literal `**Hardware & OS**` on screen, which is the
// single thing that made the web client look unfinished.
//
// Built as React nodes, never innerHTML: assistant text is model output and could contain anything, so
// there is no path here where a string becomes markup. Links are limited to http/https/mailto for the
// same reason - a `javascript:` href is one careless anchor away otherwise.
//
// A subset on purpose. Tables, footnotes, nested emphasis inside links and the rest of CommonMark are not
// what a sysadmin's assistant writes, and every extra rule is another thing to get subtly wrong.

const SAFE_HREF = /^(https?:|mailto:)/i;

/** Inline: `code`, **bold**, *italic*, [text](href). Scanned once, left to right. */
export function inline(text: string, keyPrefix = "i"): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = text;
  let n = 0;
  const push = (node: ReactNode) => out.push(typeof node === "string" ? node : node);

  while (rest.length > 0) {
    const m = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(_[^_\n]+_)|(\[[^\]]+\]\([^)\s]+\))/.exec(rest);
    if (!m || m.index === undefined) {
      push(rest);
      break;
    }
    if (m.index > 0) push(rest.slice(0, m.index));
    const token = m[0];
    const key = `${keyPrefix}-${n++}`;
    if (token.startsWith("`")) {
      push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith("**")) {
      push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("*") || token.startsWith("_")) {
      push(<em key={key}>{token.slice(1, -1)}</em>);
    } else {
      const split = token.indexOf("](");
      const label = token.slice(1, split);
      const href = token.slice(split + 2, -1);
      push(
        SAFE_HREF.test(href) ? (
          <a key={key} href={href} target="_blank" rel="noreferrer noopener">
            {label}
          </a>
        ) : (
          // An unsafe scheme is shown as text, so nothing is silently dropped and nothing is clickable.
          <span key={key}>{label}</span>
        ),
      );
    }
    rest = rest.slice(m.index + token.length);
  }
  return out;
}

interface Block {
  key: string;
  node: ReactNode;
}

/** Block level. Returns React nodes, so a caller can drop them straight into a transcript. */
export function markdown(text: string): ReactNode[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  let n = 0;
  const key = () => `b${n++}`;

  while (i < lines.length) {
    const line = lines[i]!;

    if (!line.trim()) {
      i++;
      continue;
    }

    // Fenced code. An unterminated fence runs to the end rather than swallowing the document silently.
    const fence = /^\s*```(\w+)?\s*$/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i]!)) body.push(lines[i++]!);
      i++; // closing fence
      blocks.push({ key: key(), node: <pre className="code">{body.join("\n")}</pre> });
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = Math.min(heading[1]!.length, 6);
      const Tag = (["h1", "h2", "h3", "h4", "h5", "h6"] as const)[level - 1]!;
      blocks.push({ key: key(), node: <Tag>{inline(heading[2]!)}</Tag> });
      i++;
      continue;
    }

    if (/^\s*(?:-\s*-\s*-[-\s]*|\*\s*\*\s*\*[*\s]*|_\s*_\s*_[_\s]*)$/.test(line)) {
      blocks.push({ key: key(), node: <hr /> });
      i++;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i]!)) body.push(lines[i++]!.replace(/^\s*>\s?/, ""));
      blocks.push({ key: key(), node: <blockquote>{inline(body.join(" "))}</blockquote> });
      continue;
    }

    const bullet = /^\s*[-*+]\s+/;
    const ordered = /^\s*\d+[.)]\s+/;
    const isItem = (l: string) => bullet.test(l) || ordered.test(l);
    const indentOf = (l: string) => /^\s*/.exec(l)![0].length;
    if (isItem(line)) {
      // Items at this indent, each possibly followed by a more-indented sublist. One level of nesting is
      // what the model actually writes; deeper nesting keeps folding into the level above rather than
      // growing a general tree here.
      const baseIndent = indentOf(line);
      const isOrdered = ordered.test(line);
      const items: { text: string; children: string[] }[] = [];
      while (i < lines.length && isItem(lines[i]!) && indentOf(lines[i]!) <= baseIndent) {
        items.push({ text: lines[i]!.replace(isOrdered ? ordered : bullet, ""), children: [] });
        i++;
        while (i < lines.length && lines[i]!.trim() && indentOf(lines[i]!) > baseIndent) {
          const l = lines[i]!;
          // A more-indented item is a child; anything else is a wrapped continuation of the item's text.
          if (isItem(l)) items[items.length - 1]!.children.push(l.replace(bullet, "").replace(ordered, ""));
          else items[items.length - 1]!.text += ` ${l.trim()}`;
          i++;
        }
      }
      const List = isOrdered ? "ol" : "ul";
      blocks.push({
        key: key(),
        node: (
          <List>
            {items.map((item, idx) => (
              <li key={idx}>
                {inline(item.text, `li${idx}`)}
                {item.children.length ? (
                  <ul>
                    {item.children.map((c, ci) => (
                      <li key={ci}>{inline(c, `li${idx}-${ci}`)}</li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </List>
        ),
      });
      continue;
    }

    // Paragraph: consecutive non-blank lines that start no other block.
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() &&
      !/^\s*```/.test(lines[i]!) &&
      !/^#{1,6}\s/.test(lines[i]!) &&
      !/^\s*[-*+]\s+/.test(lines[i]!) &&
      !/^\s*\d+[.)]\s+/.test(lines[i]!) &&
      !/^\s*>\s?/.test(lines[i]!)
    ) {
      para.push(lines[i++]!);
    }
    blocks.push({ key: key(), node: <p>{inline(para.join(" "))}</p> });
  }

  return blocks.map((b) => <div key={b.key}>{b.node}</div>);
}
