import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Upload } from "@aws-sdk/lib-storage";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import type { Storage } from "./types";

export interface S3Options {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  /** Endpoint joignable par les navigateurs / launchers pour les liens présignés (si différent de `endpoint`). */
  publicEndpoint?: string;
}

export class S3Storage implements Storage {
  private client: S3Client;
  /** Client servant uniquement à signer : l'hôte fait partie de la signature, il doit être l'hôte public. */
  private signer: S3Client;
  constructor(private o: S3Options) {
    const make = (endpoint?: string) =>
      new S3Client({
        region: o.region,
        endpoint,
        forcePathStyle: o.forcePathStyle,
        credentials: { accessKeyId: o.accessKeyId, secretAccessKey: o.secretAccessKey },
      });
    this.client = make(o.endpoint);
    this.signer = o.publicEndpoint ? make(o.publicEndpoint) : this.client;
  }

  async putFile(key: string, filePath: string, contentType?: string) {
    // lib-storage gère le multipart pour les gros fichiers
    await new Upload({
      client: this.client,
      params: { Bucket: this.o.bucket, Key: key, Body: createReadStream(filePath), ContentType: contentType },
    }).done();
  }

  async putBuffer(key: string, data: Buffer, contentType?: string) {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.o.bucket, Key: key, Body: data, ContentType: contentType }),
    );
  }

  async exists(key: string) {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.o.bucket, Key: key }));
      return true;
    } catch (e) {
      const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404 || (e as Error).name === "NotFound") return false;
      throw e;
    }
  }

  async delete(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.o.bucket, Key: key }));
  }

  async list(prefix: string) {
    const out: string[] = [];
    let token: string | undefined;
    do {
      const res = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.o.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      for (const o of res.Contents ?? []) if (o.Key) out.push(o.Key);
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return out;
  }

  async get(key: string) {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.o.bucket, Key: key }));
    return {
      stream: res.Body as Readable,
      size: res.ContentLength ?? 0,
      contentType: res.ContentType,
    };
  }

  async signedUrl(key: string, opts: { expiresIn: number; filename?: string; contentType?: string }) {
    return getSignedUrl(
      this.signer,
      new GetObjectCommand({
        Bucket: this.o.bucket,
        Key: key,
        ResponseContentDisposition: opts.filename
          ? `attachment; filename="${opts.filename.replace(/[^\w.\-]/g, "_")}"`
          : undefined,
        ResponseContentType: opts.contentType,
      }),
      { expiresIn: opts.expiresIn },
    );
  }
}
