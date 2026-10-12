import { z } from 'zod';

const DOMAIN = /^(?!-)[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})+$/;
const text = (max) => z.string().trim().max(max);
const list = (max, each = 80) => z.array(text(each).min(1)).max(max).default([]);

export const PLATFORMS = ['Instagram', 'X', 'Facebook', 'TikTok', 'LinkedIn', 'YouTube', 'Bluesky', 'Mastodon', 'Telegram', 'Threads', 'Reddit'];
export const FINDING_STATUSES = ['new', 'reviewing', 'confirmed', 'false_positive', 'official', 'resolved'];

const logoUrl = z.union([
  z.literal(''),
  z.string().trim().max(500).regex(/^\/seed-icons\/[\w.-]+\.png$/, 'Use an https URL'),
  z.url({ protocol: /^https$/ }).max(500),
]);

// Trust is decided by the server: a client may mark a new asset 'suggested' (guessed) or leave it 'unverified',
// but 'confirmed' only comes from the confirm endpoint, which needs evidence.
const trust = z.enum(['suggested', 'unverified', 'confirmed']).optional();

export const brandInput = z.object({
  name: text(120).min(2, 'Brand name is required'),
  domain: text(253).toLowerCase().regex(DOMAIN, 'Enter a valid domain such as brand.com'),
  domains: z.array(text(253).toLowerCase().regex(DOMAIN, 'Invalid domain')).max(20).default([]),
  description: text(2000).default(''),
  logoUrl: logoUrl.default(''),
  aliases: list(20),
  keywords: list(20),
  officialSocials: z.array(z.object({ platform: z.enum(PLATFORMS), handle: text(100).min(1), trust })).max(50).default([]),
  officialApps: z.array(z.object({
    store: z.enum(['App Store', 'Google Play']),
    name: text(200).default(''),
    appId: text(200).min(1),
    publisher: text(200).default(''),
    trust,
  })).max(50).default([]),
  sources: z.array(z.string().regex(/^[a-z_]{2,30}$/)).max(40).nullable().default(null),
  scanIntervalMinutes: z.number().int().min(60).max(10080).nullable().default(null),
}).strict();

export const assetTrust = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('social'), platform: z.enum(PLATFORMS), handle: text(100).min(1), trust: z.enum(['confirmed', 'unverified']), evidence: text(500).default('') }).strict(),
  z.object({ kind: z.literal('app'), store: z.enum(['App Store', 'Google Play']), appId: text(200).min(1), trust: z.enum(['confirmed', 'unverified']), evidence: text(500).default('') }).strict(),
]).refine((v) => v.trust !== 'confirmed' || v.evidence.length >= 8, { message: 'Say how you confirmed this asset (at least 8 characters).', path: ['evidence'] });

export const domainParam = z.string().trim().toLowerCase().regex(DOMAIN, 'Invalid domain');

export const login = z.object({ email: z.email().max(254), password: z.string().min(1).max(200) }).strict();

export const newUser = z.object({
  email: z.email().max(254),
  password: z.string().min(12, 'Use at least 12 characters').max(200),
  role: z.enum(['admin', 'analyst', 'viewer']).default('analyst'),
}).strict();

const password = z.string().min(12, 'Use at least 12 characters').max(200);
export const changePassword = z.object({ currentPassword: z.string().min(1).max(200), newPassword: password }).strict();
export const resetPassword = z.object({ newPassword: password }).strict();
export const userUpdate = z.object({ role: z.enum(['admin', 'analyst', 'viewer']).optional(), disabled: z.boolean().optional() }).strict()
  .refine((v) => v.role !== undefined || v.disabled !== undefined, 'Nothing to change');

export const findingUpdate = z.object({
  status: z.enum(FINDING_STATUSES),
  note: text(2000).optional(),
}).strict();

export const note = z.object({ note: text(2000).min(1) }).strict();

export const findingQuery = z.object({
  brandId: z.coerce.number().int().positive(),
  type: z.enum(['social', 'app', 'domain', 'web']).optional(),
  status: z.enum(FINDING_STATUSES).optional(),
  severity: z.enum(['Critical', 'High', 'Medium', 'Low']).optional(),
  platform: text(40).optional(),
  minScore: z.coerce.number().int().min(0).max(100).optional(),
  q: text(100).optional(),
  sort: z.enum(['score', 'last_seen', 'first_seen']).default('score'),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
});

export const lookalike = z.object({
  names: z.array(text(120).min(1)).min(1).max(50),
  type: z.enum(['social', 'app', 'domain']).default('social'),
}).strict();

export const suggest = z.object({ name: text(120).min(2) }).strict();

// Express 5 forwards thrown errors to the error handler; ZodError becomes a 400 there.
export const parse = (schema, value) => schema.parse(value);
