/** Isolated manual UI QA: real Electron services, encrypted relay, local fake LLM.
 * Run after npm run build. All data stays in a new OS temp folder.
 * The test-only bootstrap is bundled separately; no QA hooks enter the release.
 */
import { build } from 'esbuild'
import { createServer } from 'node:http'
import { readFile, writeFile, mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, extname, relative, basename } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const qa = process.argv[2] ? resolve(process.argv[2]) : await mkdtemp(join(tmpdir(), 'grasberg-remote-qa-'))
if (process.argv[2]) {
  if (dirname(qa).toLowerCase() !== resolve(tmpdir()).toLowerCase() || !basename(qa).startsWith('grasberg-remote-qa-') || JSON.parse(await readFile(join(qa, 'package.json'), 'utf8')).name !== 'grasberg-isolated-qa') throw new Error('Resume requires a profile created by this isolated QA harness.')
}
await mkdir(join(qa, 'profile'), { recursive: true })
const children = []
const servers = []
const listen = (server, port) => new Promise((accept, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { servers.push(server); accept() }) })
const provider = createServer(async (req, res) => {
  if (req.method === 'GET') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'qa-chat', object: 'model' }, { id: 'qa-reasoning', object: 'model' }] })); return }
  let raw = ''
  for await (const part of req) { raw += part; if (raw.length > 8e6) { res.writeHead(413).end(); return } }
  let body
  try { body = JSON.parse(raw) } catch { res.writeHead(400).end(); return }
  res.setHeader('Content-Type', 'application/json')
  if (req.url?.endsWith('/embeddings')) {
    const input = Array.isArray(body.input) ? body.input : [body.input]
    res.end(JSON.stringify({ data: input.map((text, index) => ({ index, embedding: Array.from({ length: 32 }, (_, i) => ((String(text).charCodeAt(i % String(text).length) || 1) + i) / 200) })), usage: { prompt_tokens: input.length, total_tokens: input.length } })); return
  }
  const content = '## QA response\n\nThe local test provider received your message.\n\n- Streaming and Markdown are active.\n- No paid provider was contacted.\n\n```javascript\nconsole.log("Grasberg QA");\n```'
  if (!body.stream) { res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50 } })); return }
  res.setHeader('Content-Type', 'text/event-stream')
  for (const text of content.match(/.{1,18}|\n/g) ?? []) {
    if (res.destroyed) return
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`)
    await new Promise(resolve => setTimeout(resolve, 35))
  }
  res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50 } })}\n\ndata: [DONE]\n\n`)
})
await listen(provider, 18812)
const mobileRoot = join(root, 'out', 'mobile')
await listen(createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname)
    const file = resolve(mobileRoot, '.' + (pathname === '/' ? '/index.html' : pathname))
    if (relative(mobileRoot, file).startsWith('..')) { res.writeHead(404).end(); return }
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2' }
    res.setHeader('Content-Type', types[extname(file)] ?? 'application/octet-stream')
    res.setHeader('Cache-Control', 'no-store')
    res.end(await readFile(file))
  } catch { res.writeHead(404).end() }
}), 18813)
const relayBundle = join(root, 'out', 'main', 'qa-relay.mjs')
await build({ entryPoints: [join(root, 'relay/src/server.ts')], outfile: relayBundle, bundle: true, platform: 'node', format: 'esm', packages: 'external', alias: { '@shared': join(root, 'src/shared') } })
const { RelayServer } = await import(pathToFileURL(relayBundle).href)
const relay = new RelayServer({ host: '127.0.0.1', port: 18814, storePath: join(qa, 'relay.json'), mobileOrigin: 'http://127.0.0.1:18813' })
await relay.start()
const fixture = `
  if (!database.providers.list().length) {
    const id = '11111111-1111-4111-8111-111111111111';
    database.providers.create({ id, type: 'openai-compatible', label: 'Local QA provider', baseUrl: 'http://127.0.0.1:18812/v1', defaultModelId: 'qa-chat' });
    database.settings.update({ onboardingCompleted: true, defaultProviderId: id, defaultModelId: 'qa-chat', runInBackground: false, launchAtLogin: false });
  }
`
const remoteFixture = `
  remote.setConfig({ enabled: true, relayUrl: 'http://127.0.0.1:18814', clientUrl: 'http://127.0.0.1:18813' });
  setTimeout(() => {
    const offer = remote.pair(true).pairing;
    void import('node:fs/promises').then(fs => fs.writeFile(${JSON.stringify(join(qa, 'pairing.json'))}, JSON.stringify(offer)));
    console.log('QA_READY: pairing.json in isolated profile folder');
  }, 1500);
  setInterval(() => { for (const device of database.remoteDevices.list()) if (!device.revokedAt && device.access !== 'full') remote.setDeviceAccess(device.id, 'full') }, 1000);
`
const qaBundle = join(root, 'out', 'main', 'qa-index.js')
await build({ entryPoints: [join(root, 'src/main/index.ts')], outfile: qaBundle, bundle: true, platform: 'node', format: 'cjs', packages: 'external', alias: { '@shared': join(root, 'src/shared') }, plugins: [{ name: 'isolated-qa', setup(builder) {
  builder.onLoad({ filter: /src[\\/]main[\\/]index\.ts$/ }, async ({ path }) => ({ contents: (await readFile(path, 'utf8')).replace('db = database', 'db = database;' + fixture).replace('remoteService = remote', 'remoteService = remote;' + remoteFixture).replace('  applyLoginItem()', '  // QA never changes login items'), loader: 'ts' }))
} }] })
await writeFile(join(qa, 'package.json'), JSON.stringify({ name: 'grasberg-isolated-qa', version: '1.1.0', productName: 'Grasberg QA', main: 'launch.cjs' }))
await writeFile(join(qa, 'launch.cjs'), `const { app } = require('electron'); app.setPath('userData', ${JSON.stringify(join(qa, 'profile'))}); app.setName('Grasberg isolated QA'); require(${JSON.stringify(qaBundle)});`)
const electron = spawn(join(root, 'node_modules/electron/dist/electron.exe'), [qa], { stdio: 'inherit', windowsHide: true })
children.push(electron)
console.log(`Isolated QA folder: ${qa}`)
console.log('Local QA services: provider 18812, client 18813, relay 18814. Test devices are automatically granted full access to this empty QA profile only.')
const stop = async () => { for (const child of children) child.kill(); for (const server of servers) server.close(); await relay.stop(); process.exit() }
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
electron.once('exit', stop)
