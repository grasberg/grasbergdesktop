/**
 * Attachment building for app:pickFiles — reads user-picked files, extracts
 * text content for recognizable text/code files up to a size cap, and maps
 * extensions to mime types.
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import type { Attachment } from '@shared/types'

/** Files larger than this keep their metadata but no textContent. */
export const MAX_ATTACHMENT_TEXT_BYTES = 512 * 1024

/**
 * Images larger than this keep metadata only (not sent). base64 inflates ~33%
 * and providers reject very large images, so keep the on-disk cap modest.
 */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024

/** Raster image extensions we send to vision models (svg stays on the text path). */
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif'])

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'rst', 'text', 'log', 'csv', 'tsv',
  'json', 'jsonc', 'json5', 'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'properties', 'env',
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts',
  'html', 'htm', 'css', 'scss', 'sass', 'less', 'svg', 'vue', 'svelte', 'astro',
  'py', 'rb', 'php', 'java', 'kt', 'kts', 'scala', 'groovy', 'clj',
  'c', 'h', 'cpp', 'hpp', 'cc', 'hh', 'cxx', 'cs', 'go', 'rs', 'swift', 'm', 'mm',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'psm1', 'bat', 'cmd',
  'sql', 'graphql', 'gql', 'proto', 'prisma',
  'lua', 'r', 'pl', 'pm', 'dart', 'ex', 'exs', 'erl', 'hs', 'elm', 'zig', 'nim', 'jl',
  'tf', 'tfvars', 'hcl', 'gradle', 'cmake', 'mk', 'nix',
  'gitignore', 'gitattributes', 'editorconfig', 'dockerignore', 'npmrc', 'nvmrc',
  'lock', 'diff', 'patch', 'http', 'rest',
])

/** Extension-less files that are conventionally text. */
const TEXT_BASENAMES = new Set([
  'dockerfile', 'makefile', 'rakefile', 'gemfile', 'procfile', 'justfile',
  'license', 'readme', 'changelog', 'authors', 'notice', 'codeowners',
  '.gitignore', '.gitattributes', '.editorconfig', '.env', '.npmrc', '.nvmrc',
])

const MIME_BY_EXTENSION: Record<string, string> = {
  txt: 'text/plain',
  log: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  json: 'application/json',
  jsonc: 'application/json',
  xml: 'application/xml',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  toml: 'application/toml',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  scss: 'text/x-scss',
  less: 'text/x-less',
  js: 'text/javascript',
  mjs: 'text/javascript',
  cjs: 'text/javascript',
  jsx: 'text/jsx',
  ts: 'text/typescript',
  tsx: 'text/tsx',
  py: 'text/x-python',
  rb: 'text/x-ruby',
  php: 'text/x-php',
  java: 'text/x-java-source',
  c: 'text/x-c',
  h: 'text/x-c',
  cpp: 'text/x-c++',
  hpp: 'text/x-c++',
  cs: 'text/x-csharp',
  go: 'text/x-go',
  rs: 'text/x-rust',
  swift: 'text/x-swift',
  kt: 'text/x-kotlin',
  sh: 'text/x-shellscript',
  bash: 'text/x-shellscript',
  ps1: 'text/x-powershell',
  bat: 'text/x-bat',
  cmd: 'text/x-bat',
  sql: 'application/sql',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  pdf: 'application/pdf',
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  webm: 'video/webm',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
}

/** Null-byte sniff over the head of the file — a cheap binary detector. */
function looksBinary(buffer: Buffer): boolean {
  const limit = Math.min(buffer.length, 8192)
  for (let i = 0; i < limit; i++) {
    if (buffer[i] === 0) return true
  }
  return false
}

/** True for a raster image type we can send to vision models. */
export function isSupportedImage(ext: string, mimeType: string): boolean {
  return IMAGE_EXTENSIONS.has(ext) && mimeType.startsWith('image/')
}

/**
 * Builds an Attachment for a picked file. Returns null for unreadable paths
 * and non-files. Oversized or non-text files get metadata only.
 *
 * When `imageDir` is given and the file is a supported image within the size
 * cap, its bytes are copied to `imageDir/<id>.<ext>` and the attachment is
 * marked kind:'image' with a storageKey (plus a transient dataUrl for preview).
 */
export async function readAttachment(
  filePath: string,
  imageDir?: string
): Promise<Attachment | null> {
  try {
    const info = await stat(filePath)
    if (!info.isFile()) return null

    const name = basename(filePath)
    const ext = extname(name).slice(1).toLowerCase()
    const mimeType = MIME_BY_EXTENSION[ext] ?? 'application/octet-stream'
    const attachment: Attachment = {
      id: randomUUID(),
      name,
      mimeType,
      sizeBytes: info.size,
    }

    // Image path: copy bytes to the attachments dir, reference by storageKey.
    if (imageDir && isSupportedImage(ext, mimeType) && info.size <= MAX_IMAGE_BYTES) {
      const buffer = await readFile(filePath)
      const storageKey = `${attachment.id}.${ext}`
      await mkdir(imageDir, { recursive: true })
      await writeFile(join(imageDir, storageKey), buffer)
      attachment.kind = 'image'
      attachment.storageKey = storageKey
      attachment.dataUrl = `data:${mimeType};base64,${buffer.toString('base64')}`
      return attachment
    }

    if (info.size > MAX_ATTACHMENT_TEXT_BYTES) return attachment
    const isTextCandidate = TEXT_EXTENSIONS.has(ext) || TEXT_BASENAMES.has(name.toLowerCase())
    if (!isTextCandidate) return attachment

    const buffer = await readFile(filePath)
    if (looksBinary(buffer)) return attachment
    attachment.textContent = buffer.toString('utf8')
    return attachment
  } catch {
    return null
  }
}

/**
 * Reads a stored image by its storageKey and returns a data URL, or null when
 * the file is missing or escapes the attachments dir. Read-only.
 */
export async function readStoredImage(
  imageDir: string,
  storageKey: string
): Promise<{ dataUrl: string } | null> {
  // storageKey is an app-generated '<uuid>.<ext>' — reject anything else.
  if (!/^[A-Za-z0-9-]+\.[A-Za-z0-9]+$/.test(storageKey)) return null
  const ext = extname(storageKey).slice(1).toLowerCase()
  const mimeType = MIME_BY_EXTENSION[ext] ?? 'application/octet-stream'
  if (!mimeType.startsWith('image/')) return null
  try {
    const buffer = await readFile(join(imageDir, storageKey))
    return { dataUrl: `data:${mimeType};base64,${buffer.toString('base64')}` }
  } catch {
    return null
  }
}
