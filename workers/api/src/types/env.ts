export interface Env {
  SOLOSTORE_KV: KVNamespace;
  R2: R2Bucket;
  ENVIRONMENT: string;
  SESSION_SECRET: string;
  STRIPE_SECRET_KEY: string;
  RESEND_API_KEY: string;
  RESEND_FROM: string;

}