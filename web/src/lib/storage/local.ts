import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { signPayload } from "../crypto";
import type { Storage } from "./types";

export class LocalStorage implements Storage {
  constructor(
    private root: string,
    private secret: string,
    private appUrl: string,
  ) {
    this.root = path.resolve(root);
  }

  private resolve(key: string) {
    const p = path.resolve(this.root, key);
    if (!p.startsWith(this.root + path.sep)) throw new Error("Clé de stockage invalide");
    return p;
  }

  private async prepare(key: string) {
    const dest = this.resolve(key);
    await mkdir(path.dirname(dest), { recursive: true });
    return dest;
  }

  async putFile(key: string, filePath: string) {
    const dest = await this.prepare(key);
    const tmp = `${dest}.${randomBytes(4).toString("hex")}.tmp`;
    await copyFile(filePath, tmp);
    await rename(tmp, dest);
  }

  async putBuffer(key: string, data: Buffer) {
    const dest = await this.prepare(key);
    const tmp = `${dest}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(tmp, data);
    await rename(tmp, dest);
  }

  async exists(key: string) {
    try {
      return (await stat(this.resolve(key))).isFile();
    } catch {
      return false;
    }
  }

  async delete(key: string) {
    await rm(this.resolve(key), { force: true });
  }

  async list(prefix: string) {
    const out: string[] = [];
    const walk = async (dir: string) => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else if (!e.name.endsWith(".tmp")) out.push(path.relative(this.root, full).split(path.sep).join("/"));
      }
    };
    await walk(this.resolve(prefix.replace(/\/$/, "")));
    return out;
  }

  async get(key: string) {
    const file = this.resolve(key);
    const s = await stat(file);
    return { stream: createReadStream(file), size: s.size };
  }

  async signedUrl(key: string, opts: { expiresIn: number; filename?: string; contentType?: string }) {
    const token = signPayload(this.secret, { k: key, f: opts.filename, t: opts.contentType }, opts.expiresIn);
    return `${this.appUrl.replace(/\/$/, "")}/api/files/${token}`;
  }
}

export { createWriteStream };
