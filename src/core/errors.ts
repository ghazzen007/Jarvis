/** Thrown when the selected AI provider has no key configured. */
export class NoKeyError extends Error {
  constructor(message = "No API key yet. Open Profile → AI core and add a key.") {
    super(message);
    this.name = "NoKeyError";
  }
}
