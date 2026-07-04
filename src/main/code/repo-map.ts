/**
 * Repo map: a lightweight, dependency-free code index for the `repo_map` tool.
 *
 * It walks a granted project folder, extracts top-level symbols (functions,
 * classes, exports, imports) with per-language regex, and ranks files against a
 * natural-language query using in-house BM25 (Robertson/Zaragoza, k1=1.2,
 * b=0.75) over path segments + symbol names + imported module names, boosted by
 * entrypoint filenames and recency (file mtime). No embeddings, no vector DB.
 *
 * The index is cached per project and rebuilt only when the file set changes
 * (a cheap stat-only signature is checked on every query).
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

const MAX_ENTRIES = 20_000
const MAX_DEPTH = 24
const MAX_FILES_PARSED = 3000
const MAX_FILE_BYTES = 256 * 1024
const BM25_K1 = 1.2
const BM25_B = 0.75

const IGNORED_DIR_NAMES = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'dist', 'out', 'build', 'coverage',
  '.next', '.nuxt', '.cache', '.turbo', '.venv', 'venv', '__pycache__',
  'target', '.idea', '.vscode',
])

const ENTRYPOINT_BASENAMES = new Set([
  'index', 'main', 'app', 'mod', 'lib', 'cli', 'server', 'init', '__init__', 'readme',
])

export interface RepoMapHit {
  relPath: string
  score: number
  symbols: string[]
}

interface WalkedFile {
  relPath: string
  absPath: string
  sizeBytes: number
  mtimeMs: number
}

interface FileDoc {
  relPath: string
  symbols: string[]
  /** term -> frequency in this document. */
  terms: Map<string, number>
  length: number
  mtimeMs: number
}

interface RepoIndex {
  signature: string
  docs: FileDoc[]
  /** term -> number of docs containing it. */
  df: Map<string, number>
  avgLength: number
}

// ---------------------------------------------------------------------------
// Tokenization
// ---------------------------------------------------------------------------

/** Split identifiers on non-alphanumerics and camelCase / snake boundaries. */
export function tokenize(text: string): string[] {
  const out: string[] = []
  for (const raw of text.split(/[^A-Za-z0-9]+/)) {
    if (!raw) continue
    // Split camelCase and consecutive-caps followed by word.
    for (const part of raw.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/)) {
      const t = part.toLowerCase()
      if (t.length >= 2) out.push(t)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Symbol extraction (best-effort regex per language)
// ---------------------------------------------------------------------------

const IMPORT_PATTERNS = [
  /import\s+.*?from\s+['"]([^'"]+)['"]/g, // JS/TS
  /require\(\s*['"]([^'"]+)['"]\s*\)/g, // CJS
  /^\s*(?:from|import)\s+([\w.]+)/gm, // Python
  /^\s*import\s+"([^"]+)"/gm, // Go
  /^\s*use\s+([\w:]+)/gm, // Rust
]

const SYMBOL_PATTERNS: Record<string, RegExp[]> = {
  js: [
    /\b(?:export\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/g,
    /\b(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/g,
    /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g,
    /\b(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/g,
  ],
  py: [/^\s*def\s+([A-Za-z_]\w*)/gm, /^\s*class\s+([A-Za-z_]\w*)/gm],
  go: [/\bfunc\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/g, /\btype\s+([A-Za-z_]\w*)/g],
  rust: [/\bfn\s+([A-Za-z_]\w*)/g, /\b(?:struct|enum|trait)\s+([A-Za-z_]\w*)/g],
  clike: [
    /\b(?:class|interface|enum|struct)\s+([A-Za-z_]\w*)/g,
    /\b(?:public|private|protected|static|\s)+[\w<>,[\]]+\s+([A-Za-z_]\w*)\s*\(/g,
  ],
}

function patternsForExt(ext: string): RegExp[] {
  switch (ext) {
    case 'js': case 'jsx': case 'mjs': case 'cjs':
    case 'ts': case 'tsx': case 'mts': case 'cts':
      return SYMBOL_PATTERNS.js
    case 'py':
      return SYMBOL_PATTERNS.py
    case 'go':
      return SYMBOL_PATTERNS.go
    case 'rs':
      return SYMBOL_PATTERNS.rust
    case 'java': case 'kt': case 'kts': case 'cs':
    case 'c': case 'h': case 'cpp': case 'hpp': case 'cc': case 'hh': case 'cxx':
      return SYMBOL_PATTERNS.clike
    default:
      return []
  }
}

function extractSymbols(ext: string, content: string): { symbols: string[]; imports: string[] } {
  const symbols = new Set<string>()
  for (const pattern of patternsForExt(ext)) {
    pattern.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = pattern.exec(content)) !== null) {
      if (m[1]) symbols.add(m[1])
      if (symbols.size > 200) break
    }
  }
  const imports = new Set<string>()
  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = pattern.exec(content)) !== null) {
      if (m[1]) imports.add(path.basename(m[1]))
      if (imports.size > 100) break
    }
  }
  return { symbols: [...symbols], imports: [...imports] }
}

// ---------------------------------------------------------------------------
// Walk + build
// ---------------------------------------------------------------------------

async function walk(root: string): Promise<WalkedFile[]> {
  const results: WalkedFile[] = []
  let visited = 0
  const normalizedRoot = path.resolve(root)

  const recurse = async (dir: string, rel: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || visited >= MAX_ENTRIES) return
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (visited >= MAX_ENTRIES) return
      visited += 1
      if (entry.isSymbolicLink()) continue
      const entryRel = rel === '' ? entry.name : `${rel}/${entry.name}`
      const entryAbs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (IGNORED_DIR_NAMES.has(entry.name)) continue
        await recurse(entryAbs, entryRel, depth + 1)
      } else if (entry.isFile()) {
        try {
          const st = await fs.stat(entryAbs)
          results.push({
            relPath: entryRel,
            absPath: entryAbs,
            sizeBytes: st.size,
            mtimeMs: st.mtimeMs,
          })
        } catch {
          // skip unreadable
        }
      }
    }
  }

  await recurse(normalizedRoot, '', 0)
  return results
}

function looksBinary(buffer: Buffer): boolean {
  const limit = Math.min(buffer.length, 8192)
  for (let i = 0; i < limit; i++) if (buffer[i] === 0) return true
  return false
}

function isEntrypoint(relPath: string): boolean {
  const base = path.basename(relPath).replace(/\.[^.]+$/, '').toLowerCase()
  return ENTRYPOINT_BASENAMES.has(base)
}

async function buildDocs(files: WalkedFile[]): Promise<FileDoc[]> {
  const docs: FileDoc[] = []
  let parsed = 0
  for (const file of files) {
    if (parsed >= MAX_FILES_PARSED) break
    const ext = path.extname(file.relPath).slice(1).toLowerCase()
    let symbols: string[] = []
    let imports: string[] = []
    if (file.sizeBytes <= MAX_FILE_BYTES) {
      try {
        const buffer = await fs.readFile(file.absPath)
        if (!looksBinary(buffer)) {
          const extracted = extractSymbols(ext, buffer.toString('utf8'))
          symbols = extracted.symbols
          imports = extracted.imports
          parsed += 1
        }
      } catch {
        // skip unreadable file content; still index the path
      }
    }
    // Document terms = path segments + symbol tokens + import tokens.
    const terms = new Map<string, number>()
    const addAll = (tokens: string[]): void => {
      for (const t of tokens) terms.set(t, (terms.get(t) ?? 0) + 1)
    }
    addAll(tokenize(file.relPath))
    for (const s of symbols) addAll(tokenize(s))
    for (const i of imports) addAll(tokenize(i))
    let length = 0
    for (const count of terms.values()) length += count
    docs.push({ relPath: file.relPath, symbols, terms, length: length || 1, mtimeMs: file.mtimeMs })
  }
  return docs
}

function buildIndex(signature: string, docs: FileDoc[]): RepoIndex {
  const df = new Map<string, number>()
  let totalLength = 0
  for (const doc of docs) {
    totalLength += doc.length
    for (const term of doc.terms.keys()) df.set(term, (df.get(term) ?? 0) + 1)
  }
  return { signature, docs, df, avgLength: docs.length > 0 ? totalLength / docs.length : 1 }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class RepoMapService {
  private readonly cache = new Map<string, RepoIndex>()

  /** Ranked files for a query. `projectId` keys the cache; `root` is the folder. */
  async search(
    projectId: string,
    root: string,
    query: string,
    maxResults: number
  ): Promise<RepoMapHit[]> {
    const files = await walk(root)
    const maxMtime = files.reduce((max, f) => Math.max(max, f.mtimeMs), 0)
    const signature = `${files.length}:${maxMtime}`

    let index = this.cache.get(projectId)
    if (!index || index.signature !== signature) {
      index = buildIndex(signature, await buildDocs(files))
      this.cache.set(projectId, index)
    }

    const queryTerms = tokenize(query)
    if (queryTerms.length === 0 || index.docs.length === 0) return []
    const n = index.docs.length

    const idf = new Map<string, number>()
    for (const term of new Set(queryTerms)) {
      const dfCount = index.df.get(term) ?? 0
      idf.set(term, Math.log(1 + (n - dfCount + 0.5) / (dfCount + 0.5)))
    }

    const scored = index.docs.map((doc) => {
      let score = 0
      for (const term of new Set(queryTerms)) {
        const f = doc.terms.get(term)
        if (!f) continue
        const denom = f + BM25_K1 * (1 - BM25_B + (BM25_B * doc.length) / index!.avgLength)
        score += (idf.get(term) ?? 0) * ((f * (BM25_K1 + 1)) / denom)
      }
      if (score > 0) {
        if (isEntrypoint(doc.relPath)) score *= 1.15
        // Shallow files rank slightly higher.
        const depth = doc.relPath.split('/').length
        score *= 1 + 0.05 / depth
        // Recency: newest file gets a small bump.
        if (maxMtime > 0) score *= 1 + 0.1 * (doc.mtimeMs / maxMtime)
      }
      return { relPath: doc.relPath, score, symbols: doc.symbols }
    })

    return scored
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, maxResults))
  }

  /** Drop a project's cached index (e.g. when it is forgotten). */
  invalidate(projectId: string): void {
    this.cache.delete(projectId)
  }
}
