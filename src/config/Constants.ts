/**
 * Names `Config.load` reads its files and layers by (#1546, #1785).
 *
 * Kept internal: none of them is re-exported from a barrel, because each is
 * a spelling an operator types into a file or an environment, and the
 * documentation is where those are published.  Like every `Constants.ts`,
 * this file imports nothing from its own subsystem.
 */

/**
 * The environment variable naming the application file when the code did
 * not — `LoadOptions.appConfPath` and `withConfigFile` outrank it, and
 * {@link DEFAULT_APPLICATION_CONF_FILENAME} in the working directory applies
 * when neither is set.
 */
export const APPLICATION_CONF_ENVIRONMENT_VARIABLE = 'ACTOR_TS_CONFIG';

/** The application file `Config.load` looks for in the working directory when nothing names one. */
export const DEFAULT_APPLICATION_CONF_FILENAME = 'application.conf';

/**
 * The environment variable naming the project's own `reference.conf` when the
 * code did not (#1785) — `LoadOptions.referenceConfPath` and
 * `withReferenceConfigFile` outrank it.
 */
export const REFERENCE_CONF_ENVIRONMENT_VARIABLE = 'ACTOR_TS_REFERENCE_CONFIG';

/**
 * The project `reference.conf` `Config.load` looks for in the working
 * directory when nothing names one: the project's defaults, over the bundled
 * `reference.conf` and under `application.conf`.  Optional: no file is an
 * empty layer.
 */
export const DEFAULT_REFERENCE_CONF_FILENAME = 'reference.conf';

/**
 * The environment variable naming the `.env` file when the code did not —
 * `LoadOptions.environmentFilePath` and `withEnvironmentFile` outrank it.
 *
 * Read from the real environment only, never from a `.env` file: a file
 * cannot name itself.
 */
export const ENVIRONMENT_FILE_ENVIRONMENT_VARIABLE = 'ACTOR_TS_ENV_FILE';

/**
 * The `.env` file `Config.load` looks for in the working directory when
 * nothing names one.  Its variables answer substitutions behind the real
 * environment; `process.env` is never written.
 */
export const DEFAULT_ENVIRONMENT_FILENAME = '.env';

/**
 * The root key of an application or secrets file that holds its profiles —
 * `profiles.<name> { … }`, overlaid onto the root of the same file when
 * `<name>` is the active profile.
 *
 * Reserved at the root only, and stripped from every layer `Config.load`
 * merges, so an inactive profile never reaches the effective tree, the config
 * dump or the DevTools panel.  A key of an application's own subtree may
 * still be called `profiles`: `my-app.profiles` is an ordinary key.
 */
export const PROFILES_ROOT_KEY = 'profiles';

/**
 * The environment variable that selects the active profile when the code did
 * not — `LoadOptions.profile` and `ActorSystemOptionsBuilder.withProfile`
 * outrank it.
 *
 * An environment variable rather than a HOCON key: the profile decides which
 * HOCON is read, so a key naming it would be a file choosing its own overlay.
 */
export const PROFILE_ENVIRONMENT_VARIABLE = 'ACTOR_TS_PROFILE';

/**
 * The environment variable naming the secrets file when the code did not —
 * `LoadOptions.secretsConfPath` outranks it, and
 * {@link DEFAULT_SECRETS_CONF_FILENAME} in the working directory is what
 * applies when neither is set.
 */
export const SECRETS_CONF_ENVIRONMENT_VARIABLE = 'ACTOR_TS_SECRETS_CONF';

/**
 * The secrets file `Config.load` looks for in the working directory when
 * neither `LoadOptions.secretsConfPath` nor
 * {@link SECRETS_CONF_ENVIRONMENT_VARIABLE} names one.  Optional: a missing
 * file is an empty layer, so a deployment without secrets needs nothing.
 */
export const DEFAULT_SECRETS_CONF_FILENAME = 'secrets.conf';
