import { describe, expect, it } from 'vitest';
import {
    ItemSchema,
    ItemSearchQuerySchema,
    ItemUpdateSchema
} from '../../src/domain/item.schema';

describe('ItemSearchQuerySchema', () => {
    it('applies the item-search pagination defaults', () => {
        expect(ItemSearchQuerySchema.parse({})).toMatchObject({
            limit: 20,
            offset: 0,
            my_postal: false
        });
    });

    it('rejects conflicting search terms', () => {
        expect(ItemSearchQuerySchema.safeParse({ q: 'cards', keyword: 'games' }).success).toBe(false);
    });

    it('rejects conflicting postal filters', () => {
        expect(ItemSearchQuerySchema.safeParse({
            postal_code: '12345',
            my_postal: 'true'
        }).success).toBe(false);
    });

    it('uses the shared pagination constraints', () => {
        expect(ItemSearchQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
        expect(ItemSearchQuerySchema.safeParse({ offset: '-1' }).success).toBe(false);
    });
});

describe('ItemSchema', () => {
    it('accepts subtype-specific required fields', () => {
        expect(ItemSchema.safeParse({
            type: 'jigsawPuzzle',
            title: 'Puzzle',
            condition: 'Mint',
            email: 'owner@example.test',
            pieces: 500
        }).success).toBe(true);
    });

    it('rejects a subtype without its required fields', () => {
        expect(ItemSchema.safeParse({
            type: 'jigsawPuzzle',
            title: 'Puzzle',
            condition: 'Mint',
            email: 'owner@example.test'
        }).success).toBe(false);
    });
});

describe('ItemUpdateSchema', () => {
    it('requires at least one update field', () => {
        expect(ItemUpdateSchema.safeParse({}).success).toBe(false);
    });

    it('accepts clearing an optional description', () => {
        expect(ItemUpdateSchema.safeParse({ description: null }).success).toBe(true);
    });
});
