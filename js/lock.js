// Face ID / fingerprint unlock. Uses the phone's own biometrics through WebAuthn: turning it
// on makes a passkey kept on this phone, and unlocking asks the phone to use it, which it
// only allows after Face ID, a fingerprint or the phone's screen lock. Nothing goes to the
// server, so it works offline. It guards opening the app on this phone; the sign-in itself
// is still the email and password.

const KEY = 'wetcheckLock';

function load() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || 'null');
  } catch {
    return null;
  }
}
function save(v) {
  try {
    if (v) localStorage.setItem(KEY, JSON.stringify(v));
    else localStorage.removeItem(KEY);
  } catch {}
}

const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const random = (n) => crypto.getRandomValues(new Uint8Array(n));

export async function lockSupported() {
  try {
    return !!(window.PublicKeyCredential && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable());
  } catch {
    return false;
  }
}

// On only for the person it was turned on for.
export const lockOn = (email) => {
  const l = load();
  return !!(l && email && l.email === email.toLowerCase());
};

export function lockOff() {
  save(null);
}

const failed = (x) => new Error(x && x.name === 'NotAllowedError' ? 'Cancelled, or it didn’t recognize you. Try again.' : (x && x.message) || 'It didn’t work. Try again.');

export async function turnLockOn(email) {
  let cred;
  try {
    cred = await navigator.credentials.create({
      publicKey: {
        challenge: random(32),
        rp: { name: 'Zone Sense', id: location.hostname },
        user: { id: random(16), name: email, displayName: email },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' },
        timeout: 60000,
        attestation: 'none',
      },
    });
  } catch (x) {
    throw failed(x);
  }
  save({ email: email.toLowerCase(), id: toB64(cred.rawId) });
}

export async function unlock() {
  const l = load();
  if (!l) return;
  try {
    await navigator.credentials.get({
      publicKey: {
        challenge: random(32),
        rpId: location.hostname,
        allowCredentials: [{ type: 'public-key', id: fromB64(l.id), transports: ['internal'] }],
        userVerification: 'required',
        timeout: 60000,
      },
    });
  } catch (x) {
    throw failed(x);
  }
}
