import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

// scrypt is a password-based key-derivation function. 
// It takes a password and a salt and computes a derived value.

const SCRYPT_KEY_LENGTH = 64; // Derived key must contain 64 bytes.
const SCRYPT_PREFIX = 'scrypt'; // Used to identify the format of a stored password record.

/**
 * Derive a password key with Node's asynchronous scrypt implementation.
 *
 * scrypt is intentionally more expensive than a general-purpose hash so that
 * trying many password guesses is slower. It runs asynchronously to avoid
 * blocking Fastify's event loop while the key is calculated.
 */
function deriveKey(password: string, salt: Buffer): Promise<Buffer> { // A Buffer ia a sequence of bytes.
  return new Promise((resolve, reject) => {
    scrypt(password, salt, SCRYPT_KEY_LENGTH, (error, key) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(key as Buffer);
    });
  });
}


/**
 * Create the value stored in `users.password_hash`.
 *
 * The serialized representation is `scrypt$<salt hex>$<derived key hex>`.
 * The salt is random and stored alongside the derived key: it does not need to
 * be secret, and storing it allows the same key to be recalculated at login.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16); // Buffer of 16 random bytes, used to salt the password before hashing.
  const key = await deriveKey(password, salt);
  // Hexadecimal is used here because a raw byte sequence can contain arbitrary values, 
  // including bytes that are awkward to put into an ordinary text field.
  return `${SCRYPT_PREFIX}$${salt.toString('hex')}$${key.toString('hex')}`;
}

/**
 * Check a submitted password against a stored password value.
 *
 * `needsUpgrade` is true for legacy rows, including when the password does not
 * match. Callers must only replace the stored value when `valid` is also true.
 */
export async function verifyPassword(
  password: string,
  storedValue: string
): Promise<{ valid: boolean; needsUpgrade: boolean }> {
  const [prefix, saltHex, keyHex, ...extra] = storedValue.split('$');

  // Accept only the exact encoding this module writes. 
  // A mangled scrypt record means an invalid login. 
  // The system shouldn't try to guess if it's an older password type.
  if (prefix === SCRYPT_PREFIX) {
    if (
      extra.length > 0 ||
      !saltHex ||
      !keyHex ||
      !/^[\da-f]+$/i.test(saltHex) ||
      !/^[\da-f]+$/i.test(keyHex)
    ) {
      return { valid: false, needsUpgrade: false };
    }

    // Must convert salt and key back into bytes before passing it to scrypt.
    const salt = Buffer.from(saltHex, 'hex');
    const expectedKey = Buffer.from(keyHex, 'hex');
    if (salt.length !== 16 || expectedKey.length !== SCRYPT_KEY_LENGTH) {
      return { valid: false, needsUpgrade: false };
    }

    // Derive the key using the stored salt and compare it with the expected key
    // in constant time to reduce timing-based information leakage.
    const actualKey = await deriveKey(password, salt);
    return {
      valid: timingSafeEqual(actualKey, expectedKey),
      needsUpgrade: false
    };
  }

  // During migration, some rows still store passwords in plaintext. Hash both
  // values with SHA-256 to produce equal-length buffers for timingSafeEqual.

  // Creates a SHA-256 hash object, feeds the submitted password into the hash calculation,
  // and returns the resulting hash as a Buffer.
  const suppliedDigest = createHash('sha256').update(password).digest();
  const storedDigest = createHash('sha256').update(storedValue).digest();
  return {
    valid: timingSafeEqual(suppliedDigest, storedDigest),
    needsUpgrade: true
  };
}
