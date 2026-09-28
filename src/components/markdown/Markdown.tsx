import type { ReactNode } from "react";
import { parseMarkdown, type MdBlock, type MdInline } from "@/lib/markdown";

/**
 * Renders Markdown from Baseline records as React elements (never raw HTML).
 * Styles live in markdown.css, scoped under `.md` inside a v5 page.
 */
export function Markdown({ source, className }: { source: string | null | undefined; className?: string }) {
  const blocks = parseMarkdown(source);
  if (blocks.length === 0) return null;
  return <div className={className ? `md ${className}` : "md"}>{renderBlocks(blocks)}</div>;
}

function renderInline(nodes: MdInline[]): ReactNode[] {
  return nodes.map((node, i) => {
    switch (node.type) {
      case "text":
        return node.value;
      case "br":
        return <br key={i} />;
      case "code":
        return <code key={i}>{node.value}</code>;
      case "strong":
        return <strong key={i}>{renderInline(node.children)}</strong>;
      case "em":
        return <em key={i}>{renderInline(node.children)}</em>;
      case "del":
        return <del key={i}>{renderInline(node.children)}</del>;
      case "link": {
        const external = /^https?:/i.test(node.href);
        return (
          <a key={i} href={node.href} {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
            {renderInline(node.children)}
          </a>
        );
      }
    }
  });
}

/** A tight list item shows its first paragraph inline, without a <p> wrapper. */
function renderItemChildren(children: MdBlock[]): ReactNode {
  if (children.length === 0) return null;
  const [first, ...rest] = children;
  if (first.type === "paragraph") {
    return (
      <>
        <span className="md-li-text">{renderInline(first.children)}</span>
        {rest.length > 0 ? renderBlocks(rest) : null}
      </>
    );
  }
  return renderBlocks(children);
}

function renderBlocks(blocks: MdBlock[]): ReactNode[] {
  return blocks.map((block, i) => {
    switch (block.type) {
      case "heading": {
        const Tag = `h${Math.min(block.level + 1, 6)}` as "h2" | "h3" | "h4" | "h5" | "h6";
        return (
          <Tag key={i} className={`md-h md-h${block.level}`}>
            {renderInline(block.children)}
          </Tag>
        );
      }
      case "paragraph":
        return <p key={i}>{renderInline(block.children)}</p>;
      case "code":
        return (
          <pre key={i} className="md-pre">
            <code>{block.value}</code>
          </pre>
        );
      case "blockquote":
        return <blockquote key={i}>{renderBlocks(block.children)}</blockquote>;
      case "hr":
        return <hr key={i} />;
      case "list": {
        const hasTasks = block.items.some((item) => item.checked !== null);
        const items = block.items.map((item, k) =>
          item.checked === null ? (
            <li key={k}>{renderItemChildren(item.children)}</li>
          ) : (
            <li key={k} className={item.checked ? "md-task done" : "md-task"}>
              <span className="md-box" role="img" aria-label={item.checked ? "Done" : "Not done"}>
                {item.checked ? "✓" : ""}
              </span>
              <div className="md-task-body">{renderItemChildren(item.children)}</div>
            </li>
          )
        );
        return block.ordered ? (
          <ol key={i} start={block.start !== 1 ? block.start : undefined} className={hasTasks ? "md-tasks" : undefined}>
            {items}
          </ol>
        ) : (
          <ul key={i} className={hasTasks ? "md-tasks" : undefined}>
            {items}
          </ul>
        );
      }
      case "table":
        return (
          <div key={i} className="md-table" role="region" aria-label="Table" tabIndex={0}>
            <table>
              <thead>
                <tr>
                  {block.header.map((cell, c) => (
                    <th key={c} style={block.align[c] ? { textAlign: block.align[c]! } : undefined}>
                      {renderInline(cell)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, r) => (
                  <tr key={r}>
                    {row.map((cell, c) => (
                      <td key={c} style={block.align[c] ? { textAlign: block.align[c]! } : undefined}>
                        {renderInline(cell)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
    }
  });
}
