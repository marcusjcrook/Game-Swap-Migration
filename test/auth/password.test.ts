import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../../src/auth/password';

describe('password hashing', () => {
    it('creates a verifiable scrypt hash', async () => {
        const storedValue = await hashPassword('correct horse battery');

        expect(storedValue).toMatch(/^scrypt\$[a-f\d]{32}\$[a-f\d]{128}$/i);
        await expect(verifyPassword('correct horse battery', storedValue))
            .resolves.toEqual({ valid: true, needsUpgrade: false });
    });

    it('rejects an incorrect password', async () => {
        const storedValue = await hashPassword('correct horse battery');

        await expect(verifyPassword('incorrect password', storedValue))
            .resolves.toEqual({ valid: false, needsUpgrade: false });
    });
    
    it('accepts legacy plaintext values and marks them for upgrade', async () => {
        await expect(verifyPassword('legacy-password', 'legacy-password'))
            .resolves.toEqual({ valid: true, needsUpgrade: true });
        await expect(verifyPassword('incorrect-password', 'legacy-password'))
            .resolves.toEqual({ valid: false, needsUpgrade: true });
    });

    
    it('rejects malformed scrypt values without treating them as legacy passwords', async () => {
        await expect(verifyPassword('password', 'scrypt$invalid$hash'))
            .resolves.toEqual({ valid: false, needsUpgrade: false });
    });
});
