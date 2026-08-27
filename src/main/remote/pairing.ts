/**
 * Guard for one pairing offer: the desktop shows a QR, and exactly one phone
 * may prove knowledge of the secret inside it. Mirrors the Telegram bridge's
 * pairing discipline — a code is short-lived, burns after a few wrong
 * attempts, and lives ONLY in memory so it can never outlive the session that
 * issued it. Here the secret is 256-bit (the QR can carry it), so guessing is
 * hopeless anyway; the guards exist to keep an offer from lingering open.
 */

import { generatePairingSecret, pairingProof, proofMatches } from './crypto'

const PAIRING_TTL_MS = 15 * 60_000
const PAIRING_MAX_ATTEMPTS = 5

export interface PairingOffer {
  /** The QR URL (relay origin + desktopId + secret fragment). */
  url: string
  expiresAt: number
}

export class PairingGuard {
  private offer: { secret: string; url: string; expiresAt: number; attempts: number } | null = null

  constructor(
    /** Builds the QR URL around the minted secret. */
    private readonly buildUrl: (secret: string) => string
  ) {}

  /** Mints a fresh offer, replacing any previous one. */
  issue(): PairingOffer {
    const secret = generatePairingSecret()
    this.offer = {
      secret,
      url: this.buildUrl(secret),
      expiresAt: Date.now() + PAIRING_TTL_MS,
      attempts: 0,
    }
    return { url: this.offer.url, expiresAt: this.offer.expiresAt }
  }

  /** Burns the current offer, if any. */
  cancel(): void {
    this.offer = null
  }

  /** The visible offer for status, or null when none is open/expired. Pure read. */
  current(): PairingOffer | null {
    if (!this.offer || Date.now() > this.offer.expiresAt) return null
    return { url: this.offer.url, expiresAt: this.offer.expiresAt }
  }

  /**
   * Verifies one proof. On success the offer is CONSUMED (one offer pairs one
   * device) and the secret is returned for key derivation. On failure the
   * attempt is counted; after PAIRING_MAX_ATTEMPTS the offer burns and 'burned'
   * is reported so the UI can tell the user to rescan.
   */
  verify(proof: string): { ok: true; secret: string } | { ok: false; reason: 'no-offer' | 'expired' | 'burned' | 'wrong' } {
    if (!this.offer) return { ok: false, reason: 'no-offer' }
    if (Date.now() > this.offer.expiresAt) {
      this.offer = null
      return { ok: false, reason: 'expired' }
    }
    if (!proofMatches(pairingProof(this.offer.secret), proof)) {
      this.offer.attempts += 1
      if (this.offer.attempts >= PAIRING_MAX_ATTEMPTS) {
        this.offer = null
        return { ok: false, reason: 'burned' }
      }
      return { ok: false, reason: 'wrong' }
    }
    const secret = this.offer.secret
    this.offer = null
    return { ok: true, secret }
  }
}
