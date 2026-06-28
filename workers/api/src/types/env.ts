export interface Env {
  SOLOSTORE_KV: KVNamespace;
  R2: R2Bucket;
  ENVIRONMENT: string;
  SESSION_SECRET: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;           // already in webhooks worker, add here too
  STRIPE_CONNECT_WEBHOOK_SECRET: string;   // Phase 5 — Connect endpoint signing secret
  RESEND_API_KEY: string;
  RESEND_FROM: string;
}