import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    createClearedSessionCookie,
    createSessionCookie,
    createSessionToken,
    getSessionEmail,
    SESSION_COOKIE_NAME,
    SESSION_DURATION_SECONDS
} from '../../src/auth/session';

const testSecret = 'vitest-session-secret-with-at-least-32-characters';

afterEach(() => {
    vi.unstubAllEnvs();
});

describe('session tokens', () => {
    it('round-trips an authenticated email from a cookie header', () => {
        vi.stubEnv('SESSION_SECRET', testSecret);
        const token = createSessionToken('user@example.test', 1_700_000_000_000);

        expect(getSessionEmail(`other=value; ${SESSION_COOKIE_NAME}=${token}`, 1_700_000_001_000))
            .toBe('user@example.test');
    });

    it('rejects expired or tampered tokens', () => {
        vi.stubEnv('SESSION_SECRET', testSecret);
        const now = 1_700_000_000_000;
        const token = createSessionToken('user@example.test', now);

        expect(getSessionEmail(`${SESSION_COOKIE_NAME}=${token}`, now + SESSION_DURATION_SECONDS * 1000))
            .toBeNull();
        expect(getSessionEmail(`${SESSION_COOKIE_NAME}=${token}x`, now)).toBeNull();
    });

    it('rejects token creation when the signing secret is missing or too short', () => {
        vi.stubEnv('SESSION_SECRET', '');
        expect(() => createSessionToken('user@example.test')).toThrow(/SESSION_SECRET/);

        vi.stubEnv('SESSION_SECRET', 'short');
        expect(() => createSessionToken('user@example.test')).toThrow(/SESSION_SECRET/);
    });
});

describe('session cookies', () => {
    it('sets the expected HttpOnly and SameSite attributes', () => {
        expect(createSessionCookie('token')).toContain(
            `${SESSION_COOKIE_NAME}=token; Path=/; HttpOnly; SameSite=Lax;`
        );
    });

    it('expires the session cookie on logout', () => {
        expect(createClearedSessionCookie()).toContain(`${SESSION_COOKIE_NAME}=;`);
        expect(createClearedSessionCookie()).toContain('Max-Age=0');
    });
});
