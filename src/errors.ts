// Custom Error types
// import { BadMagicError, EOFError, InitializationError } from "src/errors.ts";
export class BadMagicError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadMagicError";
  }
}
export class EOFError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EOFError";
  }
}
export class InitializationError extends Error {
  constructor(message: string = "Handler not initialized.") {
    super(message);
    this.name = "InitializationError";
  }
}
/**
 * The chosen settings leave nothing to convert, such as a cut that starts past the end.
 * No other route can do better, so this ends the search instead of rerouting (src/main.ts).
 */
export class NothingToConvertError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NothingToConvertError";
  }
}
