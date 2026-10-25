import type { Readable } from "node:stream";

export interface StoredObject {
  stream: Readable;
  size: number;
  contentType?: string;
}

export interface Storage {
  putFile(key: string, filePath: string, contentType?: string): Promise<void>;
  putBuffer(key: string, data: Buffer, contentType?: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
  get(key: string): Promise<StoredObject>;
  /** URL temporaire (S3 présignée ou lien HMAC local) permettant de télécharger l'objet. */
  signedUrl(key: string, opts: { expiresIn: number; filename?: string; contentType?: string }): Promise<string>;
}

export const blobKey = (sha256: string) => `blobs/${sha256.slice(0, 2)}/${sha256}`;
export const archiveKey = (version: string, nonce: string) => `archives/${version}-${nonce}.zip`;
export const mediaKey = (id: string) => `media/${id}`;
