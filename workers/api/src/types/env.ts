// workers/api/src/types/env.ts 

export interface Env {
  SOLOSTORE_KV: KVNamespace;
  SOLOSTORE_R2: R2Bucket;
  ENVIRONMENT: string;
  SESSION_SECRET: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  STRIPE_CONNECT_WEBHOOK_SECRET: string;
  RESEND_API_KEY: string;
  RESEND_FROM: string;
  API_BASE_URL: string;
  R2_PUBLIC_URL: string;
  R2_DEV_URL: string;
}