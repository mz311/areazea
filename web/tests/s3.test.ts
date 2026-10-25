import { describe, expect, it } from "vitest";
import { S3Storage } from "@/lib/storage/s3";

describe("S3Storage — liens présignés", () => {
  const opts = { region: "us-east-1", bucket: "b", accessKeyId: "k", secretAccessKey: "s", forcePathStyle: true };

  it("signe avec l'endpoint public quand il est fourni (l'hôte fait partie de la signature)", async () => {
    const st = new S3Storage({ ...opts, endpoint: "http://minio:9000", publicEndpoint: "https://files.example.com" });
    const url = new URL(await st.signedUrl("blobs/ab/abc", { expiresIn: 300, filename: "base v1.zip", contentType: "application/zip" }));
    expect(url.origin).toBe("https://files.example.com");
    expect(url.pathname).toBe("/b/blobs/ab/abc");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[a-f0-9]{64}$/);
    expect(url.searchParams.get("response-content-disposition")).toBe('attachment; filename="base_v1.zip"');
  });

  it("sans endpoint public, utilise l'endpoint normal", async () => {
    const st = new S3Storage({ ...opts, endpoint: "http://127.0.0.1:9000" });
    expect(new URL(await st.signedUrl("k", { expiresIn: 60 })).origin).toBe("http://127.0.0.1:9000");
  });
});
