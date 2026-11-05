import { describe, expect, it } from 'vitest';
import {
    ProfileUpdateSchema,
    UserLoginSchema,
    UserRegistrationSchema,
    UserResponseSchema
} from '../../src/domain/user.schema';

const validUser = {
    email: 'person@example.test',
    password: 'secure-password',
    first_name: 'Test',
    last_name: 'Person',
    nickname: 'Tester',
    postal_code: '12345'
};
const validPhone = {
    phone_number: '404-555-1212',
    type: 'Mobile' as const,
    shareable: true
};

describe('UserRegistrationSchema', () => {
    it('accepts a valid registration', () => {
        expect(UserRegistrationSchema.safeParse(validUser).success).toBe(true);
    });

    it('accepts optional phone details and rejects malformed phone data', () => {
        expect(UserRegistrationSchema.safeParse({ ...validUser, phone: validPhone }).success).toBe(true);
        expect(UserRegistrationSchema.safeParse({
            ...validUser,
            phone: { ...validPhone, phone_number: '4045551212' }
        }).success).toBe(false);
        expect(UserRegistrationSchema.safeParse({
            ...validUser,
            phone: { ...validPhone, type: 'Fax' }
        }).success).toBe(false);
    });

    it.each([
        { ...validUser, email: 'not-an-email' },
        { ...validUser, password: 'short' },
        { ...validUser, postal_code: '1234' },
        { ...validUser, nickname: 'n'.repeat(51) }
    ])('rejects invalid registration data: %o', (user) => {
        expect(UserRegistrationSchema.safeParse(user).success).toBe(false);
    });
});

describe('UserLoginSchema', () => {
    it('accepts valid login credentials', () => {
        expect(UserLoginSchema.safeParse({
            email: validUser.email,
            password: validUser.password
        }).success).toBe(true);
    });

    it('rejects invalid email or empty password', () => {
        expect(UserLoginSchema.safeParse({ email: 'invalid', password: 'x' }).success).toBe(false);
        expect(UserLoginSchema.safeParse({ email: validUser.email, password: '' }).success).toBe(false);
    });
});

describe('UserResponseSchema', () => {
    it('accepts a profile response without credentials', () => {
        expect(UserResponseSchema.safeParse({
            email: validUser.email,
            first_name: validUser.first_name,
            last_name: validUser.last_name,
            nickname: validUser.nickname,
            postal_code: validUser.postal_code,
            phone: validPhone
        }).success).toBe(true);
    });
});

describe('ProfileUpdateSchema', () => {
    it('accepts a partial profile update', () => {
        expect(ProfileUpdateSchema.parse({ nickname: 'New name' })).toEqual({
            nickname: 'New name'
        });
        expect(ProfileUpdateSchema.parse({ phone: validPhone })).toEqual({ phone: validPhone });
        expect(ProfileUpdateSchema.parse({ phone: null })).toEqual({ phone: null });
    });

    it('rejects empty updates and malformed postal codes', () => {
        expect(ProfileUpdateSchema.safeParse({}).success).toBe(false);
        expect(ProfileUpdateSchema.safeParse({ postal_code: 'abc' }).success).toBe(false);
    });
});
