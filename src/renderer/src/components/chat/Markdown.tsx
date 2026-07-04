import {
  isValidElement,
  memo,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import './chat.css'

interface MarkdownProps {
  content: string
}

/** Recursively flattens a React node tree to plain text (for copy buttons). */
function extractText(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(extractText).join('')
  if (isValidElement(node)) {
    return extractText((node.props as { children?: ReactNode }).children)
  }
  return ''
}

function useCopied(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const copy = (text: string): void => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => setCopied(false), 1500)
    })
  }
  return [copied, copy]
}

/** Fenced code block with a header bar: language label + copy button. */
function CodeBlock({ children }: { children?: ReactNode }): ReactElement {
  const [copied, copy] = useCopied()

  // react-markdown renders <pre><code class="hljs language-xyz">…</code></pre>;
  // we replace the <pre> wrapper and inspect its single <code> child.
  const codeEl = isValidElement(children)
    ? (children as ReactElement<{ className?: string; children?: ReactNode }>)
    : null
  const match = /language-([\w+.-]+)/.exec(codeEl?.props.className ?? '')
  const language = match?.[1] ?? 'text'
  const rawText = extractText(codeEl?.props.children)

  return (
    <div className="chat-codeblock">
      <div className="chat-codeblock-header">
        <span className="chat-codeblock-lang">{language}</span>
        <button
          type="button"
          className="chat-codeblock-copy"
          aria-label={copied ? 'Copied' : 'Copy code'}
          onClick={() => copy(rawText)}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="chat-codeblock-pre">{children}</pre>
    </div>
  )
}

const components: Components = {
  pre: ({ node, ...rest }) => <CodeBlock>{rest.children}</CodeBlock>,
  a: ({ node, ...rest }) => <a {...rest} target="_blank" rel="noreferrer" />,
}

function Markdown({ content }: MarkdownProps): ReactElement {
  return (
    <div className="chat-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}

export default memo(Markdown)
