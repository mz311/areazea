/** Appel d'API côté navigateur : JSON in/out, erreurs lisibles. */
export async function apiFetch<T = any>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, headers, ...rest } = init;
  const res = await fetch(path, {
    ...rest,
    headers: { ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  let data: any = null;
  try {
    data = await res.json();
  } catch {}
  if (!res.ok) throw new Error(data?.error ?? `Erreur HTTP ${res.status}`);
  return data as T;
}

/** Upload brut avec progression (XMLHttpRequest, seul moyen d'avoir la progression d'envoi). */
export function uploadRaw<T = any>(url: string, file: File, onProgress: (pct: number) => void, contentType = "application/zip"): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.setRequestHeader("Content-Type", contentType);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
    xhr.onload = () => {
      let data: any = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as T);
      else reject(new Error(data?.error ?? `Erreur HTTP ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error("Erreur réseau pendant l'envoi"));
    xhr.send(file);
  });
}
