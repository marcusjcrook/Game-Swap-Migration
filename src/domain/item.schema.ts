import { z } from 'zod';
import { createPaginationQuerySchema } from './pagination.schema';

export const GameConditionEnum = z.enum([
    'Mint',
    'Like New',
    'Lightly Used',
    'Moderately Used',
    'Heavily Used',
    'Damaged/Missing parts'
]);
export const PcPlatformEnum = z.enum(['Linux', 'macOS', 'Windows']);
export const VideoMediaEnum = z.enum(['optical disc', 'game card', 'cartridge']);
export const ItemTypeSchema = z.enum([
    'boardGame',
    'cardGame',
    'jigsawPuzzle',
    'computerGame',
    'videoGame'
]);

export const ItemIdParamsSchema = z.object({
    itemId: z.coerce.number().int().positive()
});

export const ItemCountsQuerySchema = z.object({
    email: z.email()
});

export const ItemSearchQuerySchema = z.object({
    q: z.string().trim().min(1).max(100).optional(),
    keyword: z.string().trim().min(1).max(100).optional(),
    type: ItemTypeSchema.optional(),
    condition: GameConditionEnum.optional(),
    postal_code: z.string().regex(/^[0-9]{5}$/).optional(),
    my_postal: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
    miles: z.coerce.number().int().min(0).max(10000).optional(),
    platform: z.string().trim().min(1).max(50).optional()
}).extend(createPaginationQuerySchema(20).shape).refine((value) => !(value.q && value.keyword), {
    message: 'Use either q or keyword, not both.'
}).refine((value) => !(value.postal_code && value.my_postal), {
    message: 'Use either postal_code or my_postal, not both.'
});

const BaseItemProps = {
    item_id: z.number().int().positive().optional(),
    title: z.string().min(1).max(250),
    condition: GameConditionEnum,
    description: z.string().max(250).optional(),
    email: z.email()
};

export const ItemSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('boardGame'), ...BaseItemProps }),
    z.object({ type: z.literal('cardGame'), ...BaseItemProps }),
    z.object({ type: z.literal('jigsawPuzzle'), ...BaseItemProps, pieces: z.number().int().positive() }),
    z.object({ type: z.literal('computerGame'), ...BaseItemProps, platform: PcPlatformEnum }),
    z.object({ type: z.literal('videoGame'), ...BaseItemProps, media: VideoMediaEnum, platform: z.string().max(50) })
]);

export const ItemUpdateSchema = z.object({
    title: z.string().min(1).max(250).optional(),
    condition: GameConditionEnum.optional(),
    description: z.string().max(250).nullable().optional(),
    pieces: z.number().int().positive().optional(),
    platform: z.string().min(1).max(50).optional(),
    media: VideoMediaEnum.optional()
}).refine((value) => Object.keys(value).length > 0, {
    message: 'At least one item field must be provided.'
});
