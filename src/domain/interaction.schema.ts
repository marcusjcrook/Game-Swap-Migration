import { z } from 'zod';
import { createPaginationQuerySchema } from './pagination.schema';

export const SwapSchema = z.object({
    proposed_item_number: z.number().int().positive(),
    desired_item_number: z.number().int().positive(),
    date_proposed: z.coerce.date()
});

export const SwapDecisionSchema = z.object({
    proposed_item_number: z.number().int().positive(),
    desired_item_number: z.number().int().positive(),
    accepted: z.boolean()
});

export const SwapRatingSchema = z.object({
    proposed_item_number: z.number().int().positive(),
    desired_item_number: z.number().int().positive(),
    role: z.enum(['proposer', 'counterparty']),
    rating: z.number().int().min(0).max(5)
});

export const PaginationQuerySchema = createPaginationQuerySchema(50);
