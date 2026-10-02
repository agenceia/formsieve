import type { FormOptions, Store, Verifier } from './index.js';
export interface CloudflareContext { ip: string | null; country: string | null; asn: number | null; botScore: number | null; verifiedBot: boolean }
export function cloudflareContext(request: Request): CloudflareContext;
export function turnstile(options: { secret: string; hostnames: string[]; action: string; fetch?: typeof fetch }): Verifier;
export function durableStore(binding: { getByName(key: string): { consume(limit: number, ttlMs: number): Promise<boolean> } }): Store;
export interface WorkerOptions extends Omit<FormOptions, 'getClientKey' | 'verify'> {
  verify: Verifier; countries?: string[]; blockedAsns?: number[]; minBotScore?: number; requireBotScore?: boolean;
}
export function createWorkerHandler(options: WorkerOptions): (request: Request) => Promise<Response>;
