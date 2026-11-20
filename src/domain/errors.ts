// Charts's typed errors: each error has a code, and each code belongs to a
// category that sets the exit code. Callers branch on the code, never on the
// message (nautilus-bridge ADR 0017).

/** The kinds of failure. Each has its own exit code. */
export type ErrorCategory = "usage" | "not-found" | "refused" | "external";

export const ERROR_CATEGORIES: Record<ErrorCategory, { exitCode: 1 | 2 | 3 | 4; meaning: string }> = {
  usage: { exitCode: 1, meaning: "the command, an argument, or an option is invalid" },
  "not-found": { exitCode: 2, meaning: "an entry or other item does not exist" },
  refused: { exitCode: 3, meaning: "a rule of Charts refuses the command" },
  external: { exitCode: 4, meaning: "Git, a file, or the runtime failed" },
};

/**
 * Every error code with its category and meaning. A code that is not a
 * category's own code names a case that callers decide on.
 */
export const ERROR_CODES = {
  usage: { category: "usage", meaning: "the command, an argument, or an option is invalid" },
  "not-found": { category: "not-found", meaning: "an item that the command needs does not exist" },
  "entry-not-found": { category: "not-found", meaning: "no entry has this ID" },
  refused: { category: "refused", meaning: "a rule of Charts refuses the command" },
  "invalid-entry": { category: "refused", meaning: "the entry fails validation; nothing was changed" },
  external: { category: "external", meaning: "Git or a file failed, for example a catalog write" },
  "unsupported-runtime": { category: "external", meaning: "the running Node version is below the required one" },
} as const satisfies Record<string, { category: ErrorCategory; meaning: string }>;

export type ErrorCode = keyof typeof ERROR_CODES;
/** The values a caller needs to act on an error, such as `id`. */
export type ErrorDetails = Record<string, unknown>;

/** The exit code of an error code: its category's exit code. */
export function exitCodeOf(code: ErrorCode): number {
  return ERROR_CATEGORIES[ERROR_CODES[code].category].exitCode;
}

/** An error with a code, its category, and details. */
export class ChartsError extends Error {
  readonly code: ErrorCode;
  readonly category: ErrorCategory;
  readonly details: ErrorDetails;

  constructor(code: ErrorCode, message: string, details: ErrorDetails = {}) {
    super(message);
    this.code = code;
    this.category = ERROR_CODES[code].category;
    this.details = details;
  }
}

/** The error for an ID that no entry has. Its message is the one callers matched before typed errors. */
export function entryNotFound(id: string): ChartsError {
  return new ChartsError("entry-not-found", `unknown entry ID: ${id}`, { id });
}
