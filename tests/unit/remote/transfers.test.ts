import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { RemoteTransfers, TRANSFER_MAX_BYTES, TRANSFER_CHUNK_BYTES } from '../../../src/main/remote/transfers'

const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex')
describe('device file transfers', () => {
  it('binds uploads to their owner, verifies bytes, and removes temporary files after import', async () => {
    const transfers = new RemoteTransfers()
    const bytes = Buffer.from('knowledge contents')
    const file = transfers.begin('phone', 'notes.txt', bytes.length)
    expect(() => transfers.chunk('other', file.id, 0, bytes.toString('base64'))).toThrow('expired')
    transfers.chunk('phone', file.id, 0, bytes.toString('base64'))
    expect(transfers.chunk('phone', file.id, 0, bytes.toString('base64')).received).toBe(bytes.length)
    expect(() => transfers.finish('phone', file.id, '0'.repeat(64))).toThrow('checksum')
    transfers.finish('phone', file.id, digest(bytes))
    let path = ''
    const result = await transfers.withFiles('phone', [file.id], async paths => {
      path = paths[0]
      expect(await readFile(path)).toEqual(bytes)
      await expect(transfers.withFiles('phone', [file.id], async () => {})).rejects.toThrow('once')
      return 'imported'
    })
    expect(result).toBe('imported')
    await expect(stat(path)).rejects.toThrow()
    await expect(transfers.withFiles('phone', [file.id], async () => {})).rejects.toThrow('expired')
  })
  it('rejects traversal, oversized files, out of order chunks and duplicate uploads', async () => {
    const t = new RemoteTransfers()
    for (const name of ['../secret', 'C:\\secret', 'CON.txt', 'file:stream', 'trailing.']) expect(() => t.begin('a', name, 1)).toThrow('file name')
    expect(() => t.begin('a', 'large', TRANSFER_MAX_BYTES + 1)).toThrow('64 MB')
    const file = t.begin('a', 'small', 2)
    expect(() => t.chunk('a', file.id, 1, 'YQ==')).toThrow('out of order')
    expect(() => t.chunk('a', file.id, 0, '!!!!')).toThrow('Invalid')
    await expect(t.withFiles('a', [file.id, file.id], async () => {})).rejects.toThrow('once')
  })
  it('bounds downloads and expires abandoned transfers', () => {
    let now = 0
    const t = new RemoteTransfers(() => now)
    const bytes = Buffer.alloc(TRANSFER_CHUNK_BYTES + 12, 42)
    const file = t.offer('a', 'export.json', bytes)
    expect(() => t.read('b', file.id, 0)).toThrow('expired')
    const first = t.read('a', file.id, 0)
    const last = t.read('a', file.id, first.next)
    expect(first.done).toBe(false)
    expect(last.done).toBe(true)
    expect(Buffer.concat([Buffer.from(first.data, 'base64'), Buffer.from(last.data, 'base64')])).toEqual(bytes)
    now = 600_001
    expect(() => t.read('a', file.id, 0)).toThrow('expired')
  })
})
