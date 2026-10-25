import yazl from "yazl";
import { createWriteStream } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** Crée un ZIP de test. `raw` permet d'injecter des noms que yazl refuserait (avec forceNames). */
export async function makeZip(
  entries: Record<string, string | Buffer | { data: Buffer | string; mode?: number }>,
  name = "test.zip",
): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "fbm-test-"));
  const file = path.join(dir, name);
  const zip = new yazl.ZipFile();
  for (const [p, v] of Object.entries(entries)) {
    const o = typeof v === "string" || Buffer.isBuffer(v) ? { data: v } : v;
    const buf = Buffer.isBuffer(o.data) ? o.data : Buffer.from(o.data);
    zip.addBuffer(buf, p, { mode: o.mode, forceDosTimestamp: true });
  }
  zip.end();
  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(file);
    zip.outputStream.pipe(out).on("close", () => resolve()).on("error", reject);
  });
  return file;
}

import { readFile, writeFile } from "node:fs/promises";

/** ZIP valide dont on remplace ensuite les octets du nom (même longueur) pour simuler un zip-slip. */
export async function makeZipWithRawName(placeholder: string, evil: string): Promise<string> {
  if (placeholder.length !== evil.length) throw new Error("longueurs différentes");
  const file = await makeZip({ [placeholder]: "payload", "ok.lua": "1" });
  const buf = await readFile(file);
  const needle = Buffer.from(placeholder);
  const repl = Buffer.from(evil);
  let i = 0;
  let n = 0;
  while ((i = buf.indexOf(needle, i)) !== -1) {
    repl.copy(buf, i);
    i += needle.length;
    n++;
  }
  if (n < 2) throw new Error("nom non trouvé dans les en-têtes local + central");
  await writeFile(file, buf);
  return file;
}
