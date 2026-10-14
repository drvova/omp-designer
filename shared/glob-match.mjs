/**
 * Glob matching for created-file paths, kept beside the eval graders so the
 * `file_exists` grader does not need a dependency to answer "did the session
 * create anything matching this shape".
 *
 * Supports `*` (within a path segment), `**` (across segments) and `?`, which is
 * what the grader files actually use.
 */
export function globToRegExp(glob) {
  const pattern = String(glob).split("\\").join("/");
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        source += ".*";
        index += 1;
        if (pattern[index + 1] === "/") index += 1;
      } else {
        source += "[^/]*";
      }
      continue;
    }
    if (character === "?") {
      source += "[^/]";
      continue;
    }
    source += character.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}
