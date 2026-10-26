/**
 * Découpage d'un script SQL (MySQL / MariaDB) en instructions, comme le ferait le client `mysql` :
 * respecte les chaînes ('…', "…", `…`), les commentaires (-- , #, /* *\/) et la directive DELIMITER.
 * Les commentaires exécutables /*!40101 … *\/ des dumps sont conservés comme instructions.
 * La même logique existe côté serveur FiveM (fbm-updater) : mêmes cas de test.
 */
export interface SplitResult {
  statements: string[];
  /** La dernière instruction n'était pas terminée par un délimiteur. */
  trailing: boolean;
  /** Le script utilise DELIMITER (procédures, triggers). */
  usesDelimiter: boolean;
  /** Délimiteur en vigueur à la fin du script. */
  endDelimiter: string;
}

/** Contenu exécutable restant une fois les commentaires simples retirés (les /*! … *\/ comptent comme du code). */
function hasCode(s: string): boolean {
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) i++;
    else if (c === "#" || (c === "-" && s[i + 1] === "-" && (i + 2 >= s.length || /\s/.test(s[i + 2])))) {
      const nl = s.indexOf("\n", i);
      i = nl < 0 ? s.length : nl + 1;
    } else if (c === "/" && s[i + 1] === "*" && s[i + 2] !== "!") {
      const end = s.indexOf("*/", i + 2);
      i = end < 0 ? s.length : end + 2;
    } else return true;
  }
  return false;
}

export function splitSql(sql: string): SplitResult {
  const src = sql.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const statements: string[] = [];
  let delimiter = ";";
  let usesDelimiter = false;
  let buf = "";
  let i = 0;
  let lineStart = true;

  const flush = () => {
    if (hasCode(buf)) statements.push(buf.trim());
    buf = "";
  };

  while (i < src.length) {
    const c = src[i];

    // directive DELIMITER (en début de ligne, hors chaîne / commentaire)
    if (lineStart) {
      const m = /^[ \t]*delimiter[ \t]+(\S+)[ \t]*(?:\n|$)/i.exec(src.slice(i, i + 200));
      if (m) {
        if (hasCode(buf)) flush();
        else buf = "";
        delimiter = m[1];
        usesDelimiter = true;
        i += m[0].length;
        lineStart = true;
        continue;
      }
    }
    lineStart = false;

    if (c === "'" || c === '"' || c === "`") {
      // chaîne / identifiant : jusqu'au guillemet fermant (\ échappe sauf dans les `…`)
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === "\\" && c !== "`") j += 2;
        else if (src[j] === c) {
          if (src[j + 1] === c) j += 2; // guillemet doublé
          else break;
        } else j++;
      }
      buf += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === "#" || (c === "-" && src[i + 1] === "-" && (i + 2 >= src.length || /\s/.test(src[i + 2])))) {
      const nl = src.indexOf("\n", i);
      const end = nl < 0 ? src.length : nl + 1;
      buf += src.slice(i, end);
      i = end;
      lineStart = true;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const close = src.indexOf("*/", i + 2);
      const end = close < 0 ? src.length : close + 2;
      buf += src.slice(i, end);
      i = end;
      continue;
    }
    if (src.startsWith(delimiter, i)) {
      flush();
      i += delimiter.length;
      continue;
    }
    buf += c;
    if (c === "\n") lineStart = true;
    i++;
  }
  const trailing = hasCode(buf);
  flush();
  return { statements, trailing, usesDelimiter, endDelimiter: delimiter };
}
