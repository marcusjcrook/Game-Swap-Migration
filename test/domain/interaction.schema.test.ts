import { describe, expect, it } from 'vitest';
import {
    PaginationQuerySchema,
    SwapDecisionSchema,
    SwapRatingSchema,
    SwapSchema
} from '../../src/domain/interaction.schema';

describe('PaginationQuerySchema', () => {
    it('applies the swap-list defaults', () => {
        expect(PaginationQuerySchema.parse({})).toEqual({ limit: 50, offset: 0 });
    });

    it('coerces valid query-string values', () => {
        expect(PaginationQuerySchema.parse({ limit: '25', offset: '10' })).toEqual({
            limit: 25,
            offset: 10
        });
    });

    it.each([
        { limit: '0' },
        { limit: '101' },
        { limit: '1.5' },
        { offset: '-1' }
    ])('rejects invalid pagination values: %o', (query) => {
        expect(PaginationQuerySchema.safeParse(query).success).toBe(false);
    });
});

describe('swap request schemas', () => {
    it('accepts a valid proposal', () => {
        expect(SwapSchema.safeParse({
            proposed_item_number: 1,
            desired_item_number: 2,
            date_proposed: '2026-01-15'
        }).success).toBe(true);
    });

    it('rejects invalid item numbers in a decision', () => {
        expect(SwapDecisionSchema.safeParse({
            proposed_item_number: 0,
            desired_item_number: 2,
            accepted: true
        }).success).toBe(false);
    });

    it('rejects ratings outside the supported range', () => {
        expect(SwapRatingSchema.safeParse({
            proposed_item_number: 1,
            desired_item_number: 2,
            role: 'proposer',
            rating: 6
        }).success).toBe(false);
    });
});
