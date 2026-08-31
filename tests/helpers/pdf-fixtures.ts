/**
 * Programmatic minimal-PDF builder for extraction tests — no binary fixtures
 * in the repo. Everything stays latin1/ASCII so byte offsets equal string
 * lengths and the xref table is exact.
 */

function escapePdfText(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
}

interface PdfObject {
  num: number
  body: string
}

function buildPdf(pages: Array<string | null>): Buffer {
  // Objects: 1 Catalog, 2 Pages, 3 Helvetica font, then Page + Contents per page.
  const objects: PdfObject[] = []
  const pageObjNums: number[] = []
  let nextNum = 4
  for (let i = 0; i < pages.length; i++) {
    pageObjNums.push(nextNum)
    nextNum += 2
  }
  objects.push({ num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' })
  objects.push({
    num: 2,
    body: `<< /Type /Pages /Kids [${pageObjNums.map((n) => `${n} 0 R`).join(' ')}] /Count ${pages.length} >>`,
  })
  objects.push({ num: 3, body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>' })
  for (let i = 0; i < pages.length; i++) {
    const pageNum = pageObjNums[i]
    const contentNum = pageNum + 1
    const text = pages[i]
    const stream = text === null ? '' : `BT /F1 12 Tf 72 720 Td (${escapePdfText(text)}) Tj ET`
    objects.push({
      num: pageNum,
      body: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentNum} 0 R >>`,
    })
    objects.push({
      num: contentNum,
      body: `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    })
  }
  objects.sort((a, b) => a.num - b.num)

  let out = '%PDF-1.4\n'
  const offsets = new Map<number, number>()
  for (const obj of objects) {
    offsets.set(obj.num, out.length)
    out += `${obj.num} 0 obj\n${obj.body}\nendobj\n`
  }
  const xrefOffset = out.length
  const size = objects.length + 1
  out += `xref\n0 ${size}\n0000000000 65535 f \n`
  for (const obj of objects) {
    out += `${String(offsets.get(obj.num)).padStart(10, '0')} 00000 n \n`
  }
  out += `trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

/** One page of Helvetica text per entry. */
export function makeTextPdf(pages: string[]): Buffer {
  return buildPdf(pages)
}

/** A single page with an empty content stream — simulates a scanned page. */
export function makeScannedPdf(): Buffer {
  return buildPdf([null])
}
