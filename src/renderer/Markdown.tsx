import { memo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api } from './api';
import { CopyButton } from './CopyButton';
import { codeBlockText } from './copy-logic';
import { imageText, linkTitle, safeHref } from './markdown-safety';
import { t } from '../shared/strings';
import { hastText, keepCellWhole } from './table-cells';

// No rehype-raw: raw HTML in a message is shown as text, never run. Links open in the browser (https only);
// images are never loaded from the network.
export const components: Components = {
  a({ href, children }) {
    const safe = safeHref(href);
    if (!safe) return <span>{children}</span>;
    return (
      <a
        href={safe}
        title={linkTitle(safe)}
        onClick={(e) => {
          e.preventDefault();
          void api().openExternal(safe);
        }}
      >
        {children}
      </a>
    );
  },
  img({ src, alt }) {
    const safe = safeHref(src);
    const text = imageText(alt, src);
    if (!safe) return <span>{text}</span>;
    return (
      <a
        href={safe}
        title={linkTitle(safe)}
        onClick={(e) => {
          e.preventDefault();
          void api().openExternal(safe);
        }}
      >
        {text}
      </a>
    );
  },
  // A code block gets a copy button that copies only the code (no fences, no language label).
  pre({ node, children, ...rest }) {
    return (
      <div className="code-block">
        <pre {...rest}>{children}</pre>
        <CopyButton className="code-copy" text={codeBlockText(hastText(node))} label={t('copy.code')} />
      </div>
    );
  },
  // A short one-word cell stays on one line.
  td({ node, children, ...rest }) {
    return (
      <td {...rest} className={keepCellWhole(hastText(node)) ? 'nowrap' : undefined}>
        {children}
      </td>
    );
  },
  th({ node, children, ...rest }) {
    return (
      <th {...rest} className={keepCellWhole(hastText(node)) ? 'nowrap' : undefined}>
        {children}
      </th>
    );
  },
};

/** Same as `components` but with no clickable element: for text inside a button, which cannot hold a link. */
const plainLinkComponents: Components = {
  a: ({ children }) => <span>{children}</span>,
  img: ({ src, alt }) => <span>{imageText(alt, src)}</span>,
};

// Only inline elements; a block element (heading, list, table, quote, paragraph) shows as its own text.
const INLINE_ELEMENTS = ['strong', 'em', 'code', 'del', 'a', 'img'];

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {text}
    </ReactMarkdown>
  );
});

/** For one-line and short items (side panel, tabs, titles): inline Markdown only, same safe links and images as the chat.
 * `noLinks` is for text inside a button: links show as their text. */
export const InlineMarkdown = memo(function InlineMarkdown({ text, noLinks }: { text: string; noLinks?: boolean }) {
  return (
    <span className="imd">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={noLinks ? plainLinkComponents : components} allowedElements={INLINE_ELEMENTS} unwrapDisallowed>
        {text}
      </ReactMarkdown>
    </span>
  );
});
