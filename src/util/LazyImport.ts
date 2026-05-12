/**
 * Lazy-import helper for optional peer dependencies.
 *
 * Most of the framework's brokers + caches + persistence backends
 * depend on optional peer-deps (`mqtt`, `kafkajs`, `memjs`, …).
 * Before this helper existed, every site had its own try/catch around
 * `import(name)` with a bespoke error message:
 *
 *   try {
 *     const name = 'mqtt';
 *     return (await import(name)) as unknown as MqttModule;
 *   } catch (e) {
 *     throw new Error('MqttActor requires the "mqtt" package.  ' +
 *       'Install it with: npm install mqtt\nOriginal error: ' +
 *       (e instanceof Error ? e.message : String(e)));
 *   }
 *
 * ~7 lines per site, repeated ~10× across brokers + caches + journals,
 * with subtle differences in wording.  This helper collapses each
 * site to a single line.
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
 * **Why this isn't auto-applied to every `await import(...)` site**:
 * built-in Node modules (`node:dns`, `node:fs`) never produce this
 * error in practice; wrapping them adds noise without benefit.  The
 * helper is intended for actual peer-deps where "module not found"
 * is the expected failure mode.
 *
 * **ESM default-export normalisation is intentionally NOT in this
 * helper**.  Some peer-deps ship CJS (`module.exports = fn`), others
 * ESM (`export default fn`), and some both — the right normalisation
 * varies per module.  Callers handle that explicitly at their site;
 * this helper only owns the "import it OR throw a helpful error"
 * boundary.
 */

export interface LazyImportOptions {
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
}

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
