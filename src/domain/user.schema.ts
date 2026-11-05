import { z } from 'zod';

export const PhoneSchema = z.object({
  phone_number: z.string().regex(/^[0-9]{3}-[0-9]{3}-[0-9]{4}$/),
  type: z.enum(['Home', 'Mobile', 'Work']),
  shareable: z.boolean().default(false)
});

export const UserRegistrationSchema = z.object({
  email: z.email(),
  password: z.string().min(8, 'Password must be at least 8 characters long'),
  first_name: z.string().max(50),
  last_name: z.string().max(50),
  nickname: z.string().max(50),
  postal_code: z.string().regex(/^[0-9]{5}$/),
  phone: PhoneSchema.optional()
});

export const UserLoginSchema = z.object({
  email: z.email(),
  password: z.string().min(1, 'Password is required')
});

export const UserResponseSchema = z.object({
  email: z.email(),
  first_name: z.string(),
  last_name: z.string(),
  nickname: z.string(),
  postal_code: z.string(),
  phone: PhoneSchema.nullable()
});

export const ProfileUpdateSchema = z.object({
  first_name: z.string().max(50).optional(),
  last_name: z.string().max(50).optional(),
  nickname: z.string().max(50).optional(),
  postal_code: z.string().regex(/^[0-9]{5}$/).optional(),
  phone: PhoneSchema.nullable().optional()
}).refine((value) => Object.keys(value).length > 0, {
  message: 'At least one profile field must be provided.'
});
