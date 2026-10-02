export interface Mail { from: string; to: string[]; subject: string; text?: string; html?: string; replyTo?: string }
export interface Provider { name?: string; send(mail: Mail): Promise<{ provider: string; id: string }> }
export interface ProviderOptions { apiKey: string; fetch?: typeof fetch; timeoutMs?: number }
export function brevo(options: ProviderOptions & { sandbox?: boolean }): Provider;
export function resend(options: ProviderOptions): Provider;
export function postmark(options: ProviderOptions): Provider;
export class DeliveryError extends Error { constructor(provider: string, status?: number); provider: string; status: number }
export class FormError extends Error { constructor(code: string, status?: number); code: string; status: number }
/** Both operations must be atomic across all application instances. */
export interface Store {
  consume(key: string, limit: number, windowMs: number): Promise<boolean>;
  claim(key: string, ttlMs: number): Promise<boolean>;
}
export interface Field { type?: 'text' | 'email'; required?: boolean; maxLength?: number; label?: string }
export interface VerificationContext { token: unknown; request: Request; data: Record<string, string> }
export type Verifier = (context: VerificationContext) => boolean | Promise<boolean>;
export interface FormOptions {
  provider: Provider; store: Store; allowedOrigins: string[];
  fields: Record<string, Field>; from: string; to: string[]; subject?: string;
  namespace?: string; getClientKey(request: Request): string | null | Promise<string | null>;
  verify?: Verifier; validate?(data: Record<string, string>): boolean | Promise<boolean>;
  honeypot?: string; maxBytes?: number; maxLinks?: number;
  rateLimit?: number; rateWindowMs?: number; duplicateTtlMs?: number;
}
export function createFormHandler(options: FormOptions): (request: Request) => Promise<Response>;
export function memoryStore(options?: { maxEntries?: number; now?: () => number }): Store;
export function readJson(request: Request | Response, maxBytes?: number): Promise<unknown>;
export function isEmail(value: unknown): value is string;
export function escapeHtml(value: unknown): string;
