/**
 * The ONE module that loads `@larksuiteoapi/node-sdk`'s values. handler.ts
 * `import()`s it on the first account connect, so a server with no Feishu
 * account never loads the SDK (~24 MB of heap).
 *
 * The npm bundle (packages/cli/scripts/build-bundle.mjs) bundles this file on
 * its own into `dist/feishu-sdk.cjs` and rewrites handler's import of it to
 * that file; only what is exported here ships, so a new SDK name handler.ts
 * needs goes in this list (tsc rejects the use otherwise).
 */
export { WSClient, EventDispatcher, LoggerLevel } from '@larksuiteoapi/node-sdk'
