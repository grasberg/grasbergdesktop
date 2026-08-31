/// Shared protocol constants — the Dart mirror of src/shared/remote-protocol.ts.
///
/// The values must stay byte-identical to the desktop's: they are domain
/// separation strings for the HKDF derivation and the pairing proof HMAC, so
/// even a one-character drift would make the two sides derive different keys.
const int remoteProtocolVersion = 1;

/// HMAC context string for the pairing proof (domain separation).
const String pairingProofContext = 'grasberg-remote-pairing-v1';

/// HKDF info string for the frame key.
const String frameKeyInfo = 'grasberg-remote-frame-v1';

/// HKDF salt — fixed, public; the secret is the pairing code's entropy.
const String frameKeySalt = 'grasberg-remote-frame-salt-v1';

/// Storage key for the paired identity (mirrors the web client's key so a
/// support conversation can reason about "the identity" in either app).
const String identityStoreKey = 'grasberg.remote.identity.v1';
