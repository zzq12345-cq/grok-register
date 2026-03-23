export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  KV_CACHE: KVNamespace;
  BUILD_SHA?: string;
  KV_CACHE_MAX_BYTES?: string;
  AUTH_USERNAME?: string;
  AUTH_PASSWORD?: string;
  VIDEO_POSTER_PREVIEW?: string;
}
