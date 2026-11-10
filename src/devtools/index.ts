/**
 * `actor-ts/devtools` — the embeddable DevTools suite (#445).
 *
 * Deliberately NOT re-exported from the package root: DevTools carries
 * the embedded UI bundle, and an application that never opens it should
 * not pay to parse those bytes.
 *
 *     import { DevTools, DevToolsOptions } from 'actor-ts/devtools';
 *     await DevTools.attach(system, DevToolsOptions.create().withPort(9333));
 */
export { DevTools } from './DevTools.js';

export {
  DevToolsExtension,
  DevToolsExtensionId,
  devtoolsOf,
} from './DevToolsExtension.js';

export {
  DEVTOOLS_DEFAULTS,
  DevToolsOptions,
  DevToolsOptionsBuilder,
  DevToolsOptionsValidator,
  isLoopbackHost,
  mergeDevToolsOptions,
  readDevToolsOptionsFromConfig,
} from './DevToolsOptions.js';
export type {
  DevToolsExposure,
  DevToolsOptionsType,
  DevToolsPanelOptionsType,
} from './DevToolsOptions.js';

export { DevToolsServer } from './DevToolsServer.js';
export type {
  DevToolsBinding,
  DevToolsRequestHandler,
  DevToolsTap,
} from './DevToolsServer.js';

export { uiAssetRoutes } from './UiAssetRoutes.js';
export type { UiAsset } from './UiAssetRoutes.js';

// The wire contract, re-exported so a custom client can be written
// against the same types the bundled UI uses.
export * from './protocol/index.js';
