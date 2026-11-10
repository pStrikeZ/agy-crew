/**
 * The upstream Antigravity identity block, plus the exact omp block-0 rewrite
 * used by `agy-crew omp`.
 *
 * The text is the rendered form of agy's `identity.tmpl` (the Go-template
 * comments and the `{{if .IsAutonomous}}` branch are resolved here). Do not add
 * explanatory text: extra prose is itself an omp fingerprint.
 */

export const IDENTITY_SENTINEL = "You are Antigravity, a powerful agentic AI coding assistant";

const IDENTITY_HEAD =
  "You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding.";

/** Render `identity.tmpl` for the requested autonomy mode. */
export function identityText({ autonomous = false } = {}) {
  const who = autonomous ? "working for" : "pair programming with";
  const lines = [
    IDENTITY_HEAD,
    `You are ${who} a USER to solve their coding task. The task may require creating a new codebase, modifying or debugging an existing codebase, or simply answering a question.`,
    "The USER will send you requests, which you must always prioritize addressing. User requests are enclosed within <USER_REQUEST> tags.",
  ];
  if (autonomous) lines.push("The USER is not available to respond to questions or requests for approval. Work autonomously.");
  return lines.join("\n");
}

/** Remove a previously injected identity block, so the transform is idempotent. */
export function stripManagedIdentity(text) {
  const value = String(text ?? "");
  if (!value.startsWith(IDENTITY_SENTINEL)) return value;
  const boundary = value.indexOf("\n\n");
  return boundary === -1 ? "" : value.slice(boundary + 2);
}

/**
 * Remove only omp's role sentence (and its now-empty `§ Role` heading). Every
 * other block-0 instruction, including the tool policy, is left byte-identical.
 */
export function stripOmpRole(text) {
  let value = String(text ?? "");
  value = value.replace(/(?:^|\n)§ Role\nYou are omp's trusted coding assistant\.\n?/g, "\n");
  value = value.replace(/You are omp's trusted coding assistant\.\s*/g, "");
  // Drop the two branded internal-URL entries (`cfg://` settings, `omp://`
  // harness docs) from block 0. The schemes still work if called; they are
  // simply no longer advertised, so a plain grep of the prompt finds neither.
  value = value
    .split("\n")
    .filter((line) => !/`(?:cfg|omp):\/\//.test(line))
    .join("\n");
  // Inline tool descriptors (when enabled) can still contain omp:// examples.
  value = sanitizeOmpUrlText(value);
  return value.replace(/^\n+/, "");
}

/**
 * Remove omp:// URL examples from a prose string while keeping the remaining
 * schemes (`local://`, `skill://`, …). Used for block 0 and provider tool
 * declarations; it never changes omp as a word, only the URL scheme.
 */
export function sanitizeOmpUrlText(text) {
  let value = String(text ?? "");
  value = value.replace(/`omp:\/\/[^`]*`\s*,\s*/g, "");
  value = value.replace(/,\s*`omp:\/\/[^`]*`/g, "");
  value = value.replace(/`omp:\/\/[^`]*`/g, "");
  value = value.replace(/omp:\/\/[^\s,`)]*/g, "");
  value = value.replace(/\(\s*,\s*/g, "(").replace(/,\s*\)/g, ")");
  return value;
}

function sanitizeValue(value) {
  if (typeof value === "string") {
    const next = sanitizeOmpUrlText(value);
    return next === value ? value : next;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const cleaned = sanitizeValue(item);
      if (cleaned !== item) changed = true;
      return cleaned;
    });
    return changed ? next : value;
  }
  if (value && typeof value === "object") {
    let changed = false;
    const next = {};
    for (const [key, item] of Object.entries(value)) {
      const cleaned = sanitizeValue(item);
      if (cleaned !== item) changed = true;
      next[key] = cleaned;
    }
    return changed ? next : value;
  }
  return value;
}

/** Strip omp:// examples from every string in Antigravity function declarations. */
export function sanitizeTools(tools) {
  if (!Array.isArray(tools)) return tools;
  let changed = false;
  const next = tools.map((tool) => {
    if (!Array.isArray(tool?.functionDeclarations)) return tool;
    let declarationChanged = false;
    const functionDeclarations = tool.functionDeclarations.map((declaration) => {
      const cleaned = sanitizeValue(declaration);
      if (cleaned !== declaration) declarationChanged = true;
      return cleaned;
    });
    if (!declarationChanged) return tool;
    changed = true;
    return { ...tool, functionDeclarations };
  });
  return changed ? next : tools;
}

/**
 * Rewrite omp's first system-prompt block: identity first, then the original
 * block with only the omp role sentence removed. Tool descriptions and all
 * later blocks are untouched.
 */
export function transformBlock0(text, options = {}) {
  const base = stripOmpRole(stripManagedIdentity(text));
  const identity = identityText(options);
  return base ? `${identity}\n\n${base}` : identity;
}
