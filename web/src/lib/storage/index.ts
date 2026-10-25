import { env } from "../env";
import { LocalStorage } from "./local";
import { S3Storage } from "./s3";
import type { Storage } from "./types";

export * from "./types";

const g = globalThis as unknown as { storage?: Storage };

export function storage(): Storage {
  if (g.storage) return g.storage;
  const e = env();
  if (e.STORAGE_DRIVER === "s3") {
    if (!e.S3_BUCKET || !e.S3_ACCESS_KEY_ID || !e.S3_SECRET_ACCESS_KEY) {
      throw new Error("S3_BUCKET, S3_ACCESS_KEY_ID et S3_SECRET_ACCESS_KEY sont requis avec STORAGE_DRIVER=s3");
    }
    g.storage = new S3Storage({
      endpoint: e.S3_ENDPOINT,
      region: e.S3_REGION,
      bucket: e.S3_BUCKET,
      accessKeyId: e.S3_ACCESS_KEY_ID,
      secretAccessKey: e.S3_SECRET_ACCESS_KEY,
      forcePathStyle: e.S3_FORCE_PATH_STYLE,
      publicEndpoint: e.S3_PUBLIC_ENDPOINT,
    });
  } else {
    g.storage = new LocalStorage(e.STORAGE_LOCAL_DIR, e.APP_SECRET, e.APP_URL);
  }
  return g.storage;
}
