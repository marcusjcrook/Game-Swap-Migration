import { z } from 'zod';

export function createPaginationQuerySchema(defaultLimit: number) {
    return z.object({
        limit: z.coerce.number().int().min(1).max(100).default(defaultLimit),
        offset: z.coerce.number().int().min(0).default(0)
    });
}
