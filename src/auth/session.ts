import { createHmac, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE_NAME = 'gameswap_session';
export const SESSION_DURATION_SECONDS = 60 * 60 * 24;

/**
 * Return the secret used to sign and verify session tokens.
 *
 * The secret must remain stable across API restarts and be shared by all API
 * instances that handle the same sessions. Changing it invalidates existing
 * tokens because their signatures can no longer be verified.
 */
function getSessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  // Never use a predictable fallback: an attacker who knows the secret could
  // create tokens that the API accepts as authentic.
  if (!secret || secret.length < 32) {
    throw new Error('SESSION_SECRET must be configured with at least 32 characters.');
  }
  return secret;
}

/**
 * Create a signed session token for a user.
 *
 * The token contains a base64url-encoded JSON payload and an HMAC-SHA256
 * signature. The signature detects tampering but does not encrypt the payload,
 * so it must not contain information that needs to remain secret.
 */
export function createSessionToken(email: string, now = Date.now()): string {
  // Use Unix seconds for the expiry so validation does not depend on timezones or date formatting.
  // Creates a buffer containing the JSON string's bytes, using UTF-8 by default.
  // Encode the bytes using Base64URL to safely transmit binary data through text-based communication 
  // channels without data corruption or misinterpretation
  const payload = Buffer.from(JSON.stringify({
    email,
    // Converts the current timestamp to whole Unix seconds 
    // and adds session duration to calculate the expiry time.
    expiresAt: Math.floor(now / 1000) + SESSION_DURATION_SECONDS 
  })).toString('base64url');
  const signature = createHmac('sha256', getSessionSecret()).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

/**
 * Create the Set-Cookie value for a session token.
 *
 * HttpOnly prevents client-side JavaScript from reading the cookie. SameSite=Lax
 * restricts when browsers send it with cross-site requests. Secure requires
 * HTTPS in production. Max-Age sets the browser's cookie lifetime to match the
 * token's validity period.
 */
export function createSessionCookie(token: string): string {
  // The Secure cookie attribute tells the browser to send the cookie only over secure connections, 
  // normally HTTPS. Local development often uses plain HTTP on a local machine, 
  // so requiring a secure cookie during development can prevent the browser from sending it as expected. 
  // In production, HTTPS should be used and the attribute should be enabled.
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';

  // Lax allows the browser to send cookies only on same-site requests and safe, 
  // top-level cross-site navigation requests (e.g., navigating to another site),
  // while blocking them in many cross-site subrequest contexts.
  // This helps reduce some cross-site request forgery (CSRF) risks.
  return `${SESSION_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DURATION_SECONDS}${secure}`;
}

/**
 * Create a Set-Cookie value that expires the session cookie.
 *
 * Use the same cookie name and path as the original so the browser removes
 * the intended cookie. Preserve its security attributes as well.
 */
export function createClearedSessionCookie(): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  // The empty value removes the token from the cookie value, and Max-Age=0 
  // instructs the browser to expire the cookie immediately.
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

/**
 * Verify a request's session cookie and return the authenticated email.
 *
 * Return null if the request has no valid session. Callers should use the
 * returned email as the authenticated identity, not an email supplied by the
 * client. Because sessions are stateless, clearing the cookie does not revoke
 * a copied token; it remains usable until expiry unless the signing secret
 * changes.
 */
export function getSessionEmail(cookieHeader: string | undefined, now = Date.now()): string | null {
  if (!cookieHeader) return null;

  // Find this application's cookie without relying on its position in the
  // Cookie header, which may contain multiple cookies.
  const cookie = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE_NAME}=`));
  const token = cookie?.slice(SESSION_COOKIE_NAME.length + 1);
  if (!token) return null;

  const [payload, signature, ...extra] = token.split('.');
  if (!payload || !signature || extra.length > 0) return null;

  try {
    // Recompute the signature from the payload and reject mismatches before parsing or trusting 
    // any of the payload's contents. Check the length first because timingSafeEqual requires 
    // equal-length buffers.
    const expected = createHmac('sha256', getSessionSecret()).update(payload).digest();
    const actual = Buffer.from(signature, 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;

    // Decode and parse the payload. The unknown type tells TypeScript that the value exists, 
    // but its structure has not yet been established. This is safer than immediately asserting 
    // that the parsed value has the desired structure without checking it.
    const session: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    // A valid signature establishes authenticity, not that the payload has
    // the expected fields or that the session has not expired.
    if (
      typeof session !== 'object' ||
      session === null ||
      !('email' in session) ||
      typeof session.email !== 'string' ||
      !('expiresAt' in session) ||
      typeof session.expiresAt !== 'number' ||
      session.expiresAt <= Math.floor(now / 1000) // Converts the current timestamp to whole Unix seconds.
    ) {
      return null;
    }

    return session.email;
  } catch {
    // Malformed payloads or a missing/invalid signing configuration must not
    // result in an authenticated identity.
    return null;
  }
}