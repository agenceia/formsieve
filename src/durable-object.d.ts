import { DurableObject } from 'cloudflare:workers';
export class FormSieveStore extends DurableObject {
  consume(limit: number, ttlMs: number): Promise<boolean>;
  alarm(): Promise<void>;
}
