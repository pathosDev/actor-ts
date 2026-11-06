/**
 * Smoke case: the layered config loader on this runtime (#1785, #1788).
 *
 * Runtime-sensitive in three places a Bun-only unit test cannot speak for.
 * The loader reads its files with `readFileSync` and decides "no such file"
 * from the error's `code`, which each runtime fills in itself; a `.env` file
 * is parsed by the loader on Node and Deno, where nothing loads one on its
 * own, while Bun preloads only `./.env` — so a file named in code is read by
 * the loader everywhere; and the environment is read variable by variable,
 * which Deno answers per name.  This case loads a project `reference.conf`,
 * an `application.conf` and a named `.env` from `dist/` on each runtime, and
 * checks the boot dump withholds what the `.env` supplied.
 *
 * Nothing is opened, so there is no handle to release: the case is a pure
 * load and a render.
 */
export const name = 'config layers';
export const description = 'a project reference.conf, application.conf and a named .env load the same on every runtime';

const VARIABLE = 'SMOKE_CONFIG_LAYERS_PASSWORD';

export async function run({ actorTs }) {
  const { Config, configDumpLines } = actorTs;
  const fixtures = new URL('../fixtures/config-layers/', import.meta.url);
  const pathOf = (name) => urlToPath(new URL(name, fixtures));

  // The real environment wins over the file, so a variable of the same name
  // in the shell running the suite would decide what the case sees.
  const previous = readVariable(VARIABLE);
  deleteVariable(VARIABLE);
  try {
    const config = Config.load({
      referenceConfPath: pathOf('reference.conf'),
      appConfPath: pathOf('application.conf'),
      secretsConfPath: false,
      environmentFilePath: pathOf('layers.env'),
    });

    expectEqual(config.getString('smoke.greeting'), 'from application.conf', 'application.conf overrides reference.conf');
    expectEqual(config.getInt('smoke.pool-size'), 4, 'a key with no value falls back to reference.conf');
    expectEqual(config.getString('smoke.db.dsn'), 's3cret-from-the-env-file', 'the .env file answers ${VAR}');
    expectEqual(
      config.getString('smoke.db.url'),
      'postgres://app:s3cret-from-the-env-file@localhost/app',
      'a concatenation reads the variable and the layer beneath',
    );

    const layers = config._sources();
    expectEqual(layers.environmentFileFound, true, 'the .env file was found');
    expectEqual(layers.projectReferenceFound, true, 'the project reference.conf was found');

    // A missing file is an empty layer on every runtime: the error code the
    // loader keys on is the runtime's own.
    const missing = Config.load({
      referenceConfPath: pathOf('no-such-reference.conf'),
      appConfPath: pathOf('no-such-application.conf'),
      secretsConfPath: false,
      environmentFilePath: pathOf('no-such.env'),
    });
    expectEqual(missing._sources().projectReferenceFound, false, 'a missing reference.conf is no layer');
    expectEqual(missing._sources().environmentFileFound, false, 'a missing .env is no file');

    // `dsn` names no credential and the value is no URL, so only the
    // variable it came from can withhold it — the rule this case is for.
    const dump = configDumpLines(config);
    if (dump.includes('s3cret-from-the-env-file')) throw new Error('the boot dump printed the value the .env file supplied');
    expectIncludes(dump, `smoke.db.dsn = <redacted>  [application, from $${VARIABLE}]`);
    expectIncludes(dump, 'smoke.pool-size = 4  [project-reference]');
  } finally {
    if (previous === undefined) deleteVariable(VARIABLE);
    else writeVariable(VARIABLE, previous);
  }
}

function expectEqual(actual, expected, what) {
  if (actual !== expected) throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function expectIncludes(text, line) {
  if (!text.includes(line)) throw new Error(`the boot dump has no line ${JSON.stringify(line)}`);
}

// `process.env` on all three, as the loader reads it; Deno's is the node
// compatibility object, which the smoke run grants `--allow-env`.
function readVariable(name) { return globalThis.process.env[name]; }
function writeVariable(name, value) { globalThis.process.env[name] = value; }
function deleteVariable(name) { delete globalThis.process.env[name]; }

/** `fileURLToPath` for the one shape we produce, without a `node:url` import. */
function urlToPath(url) {
  const path = decodeURIComponent(url.pathname);
  // Windows file URLs arrive as `/C:/…`; the leading slash is not part of it.
  return /^\/[A-Za-z]:/.test(path) ? path.slice(1) : path;
}
