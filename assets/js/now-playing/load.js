/** Propagate ?v= cache-bust from the importing module's URL. */
export function bust(importMetaUrl, relPath) {
  const V = new URL(importMetaUrl).searchParams.get("v") || "0";
  const clean =
    relPath.startsWith("./") || relPath.startsWith("../")
      ? relPath
      : "./" + relPath;
  return clean.includes("?") ? clean : clean + "?v=" + encodeURIComponent(V);
}
