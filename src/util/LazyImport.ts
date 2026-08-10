/**
 * Import an optional peer dependency, or fail with an error that names the
 * package and the command that installs it.
 *
 * The framework's brokers, caches and persistence backends all sit
 * behind optional peers (`mqtt`, `kafkajs`, `memjs`, …), and a
 * user-written integration is built the same way: the module must not
 * be a hard dependency, so the import has to be dynamic, so the
 * failure mode is a bare `Cannot find module` that says nothing about
 * which package is missing or what to do about it.  This helper owns
 * that one boundary, so every site words it the same way.
 *
 * Usage:
 *
 *   const mqttLazy = Lazy.of(() => lazyImportModule<MqttModule>('mqtt', { context: 'MqttActor' }));
 *
 * When the peer-dep is missing, the user sees:
 *
 *   Error: MqttActor requires the 'mqtt' package.  Install it with:
 *   npm install mqtt
 *   Original error: Cannot find module 'mqtt'
 *
 * **Why this isn't for every `await import(...)` site**: built-in
 * Node modules (`node:dns`, `node:fs`) never produce this error in
 * practice; wrapping them adds noise without benefit.  The helper is
 * intended for actual peer-deps where "module not found" is the
 * expected failure mode.
 *
 * **ESM default-export normalisation is intentionally NOT in this
 * helper**.  Some peer-deps ship CJS (`module.exports = fn`), others
 * ESM (`export default fn`), and some both — the right normalisation
 * varies per module.  Callers handle that explicitly at their site;
 * this helper only owns the "import it OR throw a helpful error"
 * boundary.
 */

export type LazyImportOptions = {
  /**
   * User-facing context that gets prefixed to the error message.
   * Typically the actor / extension that needs the module — gives
   * the user a hint about WHICH part of their code triggered the
   * import.  Default: derived from the module name.
   */
  readonly context?: string;
  /**
   * Override the suggested install command in the error message.
   * Default: `npm install <name>`.
   */
  readonly installHint?: string;
};

/**
 * Dynamic-import wrapper that produces a uniform "missing peer-dep"
 * error message.
 *
 * Type-parameter `T` lets the caller assert the shape of the imported
 * module — TypeScript can't infer the shape from a string-literal
 * module name.
 */
export async function lazyImportModule<T>(
  name: string,
  options: LazyImportOptions = {},
): Promise<T> {
  try {
    return (await import(name)) as unknown as T;
  } catch (e) {
    const context = options.context !== undefined ? `${options.context} requires` : `Required`;
    const install = options.installHint ?? `npm install ${name}`;
    throw new Error(
      `${context} the '${name}' package.  Install it with: ${install}\n` +
      `Original error: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
