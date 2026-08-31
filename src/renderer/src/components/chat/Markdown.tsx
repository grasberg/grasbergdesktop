import {
  isValidElement,
  memo,
  useEffect,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeHighlight from 'rehype-highlight'
import rehypeKatex from 'rehype-katex'
import type { ResearchSource } from '@shared/types'
import { linkifyCitations } from '@shared/citations'
import { useCopied } from '@/hooks/useCopied'
import { useUiStore } from '@/stores/ui'
import 'katex/dist/katex.min.css'
import './chat.css'

interface MarkdownProps {
  content: string
  /** Deep-research sources: bare [n] markers become clickable citation chips. */
  citations?: ResearchSource[]
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

/**
 * Models frequently emit LaTeX with \( \) / \[ \] delimiters, which remark-math
 * doesn't parse. Convert them to $ / $$ everywhere except inside code fences
 * and inline code (odd split indices are the code segments).
 */
function normalizeMathDelimiters(src: string): string {
  if (!src.includes('\\(') && !src.includes('\\[')) return src
  const parts = src.split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/)
  return parts
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part
            .replace(/\\\[([\s\S]*?)\\\]/g, (_m, expr: string) => `$$${expr}$$`)
            .replace(/\\\(([\s\S]*?)\\\)/g, (_m, expr: string) => `$${expr}$`)
    )
    .join('')
}

let mermaidSeq = 0

/** SVG-as-image runs in the browser's scriptless SVG image mode. */
function svgImageDataUrl(svg: string): string {
  const bytes = new TextEncoder().encode(svg)
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return `data:image/svg+xml;base64,${btoa(binary)}`
}

/**
 * Renders a ```mermaid fence as a diagram once the source parses; while the
 * source is incomplete (streaming) or invalid it shows the plain code block.
 * mermaid is imported lazily so the heavy library never loads for chats
 * without diagrams.
 */
function MermaidBlock({
  source,
  fallback,
}: {
  source: string
  fallback: ReactNode
}): ReactElement {
  const resolvedTheme = useUiStore((s) => s.resolvedTheme)
  const [imageUrl, setImageUrl] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    // Debounced so streaming deltas don't re-parse on every token.
    const timer = setTimeout(() => {
      const id = `mermaid-${++mermaidSeq}`
      void import('mermaid')
        .then(async ({ default: mermaid }) => {
          mermaid.initialize({
            startOnLoad: false,
            securityLevel: 'strict',
            theme: resolvedTheme === 'dark' ? 'dark' : 'default',
          })
          const rendered = await mermaid.render(id, source)
          if (!cancelled) setImageUrl(svgImageDataUrl(rendered.svg))
        })
        .catch(() => {
          // mermaid can leave its scratch element behind on a parse failure.
          document.getElementById(`d${id}`)?.remove()
          if (!cancelled) setImageUrl(null)
        })
    }, 200)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [source, resolvedTheme])

  if (!imageUrl) return <>{fallback}</>
  return (
    <div className="chat-mermaid">
      <img src={imageUrl} alt="Mermaid diagram" />
    </div>
  )
}

/** Languages whose code blocks offer a sandboxed live preview. */
const PREVIEWABLE = new Set(['html', 'svg'])

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

  const block = (
    <div className="chat-codeblock">
      <div className="chat-codeblock-header">
        <span className="chat-codeblock-lang">{language}</span>
        {PREVIEWABLE.has(language) && (
          <button
            type="button"
            className="chat-codeblock-copy"
            aria-label="Preview in a sandboxed panel"
            onClick={() =>
              useUiStore.getState().openArtifactPreview({ title: language, html: rawText })
            }
          >
            Preview
          </button>
        )}
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

  if (language === 'mermaid') return <MermaidBlock source={rawText} fallback={block} />
  return block
}

const components: Components = {
  pre: ({ node, ...rest }) => <CodeBlock>{rest.children}</CodeBlock>,
  a: ({ node, ...rest }) => {
    // Linkified deep-research citations carry "[n]" as their link text —
    // render them as superscript chips (href still opens externally).
    if (/^\[\d+\]$/.test(extractText(rest.children))) {
      return (
        <a
          {...rest}
          className="chat-citation"
          target="_blank"
          rel="noreferrer"
          title={typeof rest.href === 'string' ? rest.href : undefined}
        />
      )
    }
    return <a {...rest} target="_blank" rel="noreferrer" />
  },
}

function Markdown({ content, citations }: MarkdownProps): ReactElement {
  const prepared =
    citations && citations.length > 0 ? linkifyCitations(content, citations) : content
  return (
    <div className="chat-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex, rehypeHighlight]}
        components={components}
      >
        {normalizeMathDelimiters(prepared)}
      </ReactMarkdown>
    </div>
  )
}

export default memo(Markdown)
