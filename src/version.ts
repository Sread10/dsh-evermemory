/**
 * Package identity, read once and shared by the prompt section, the routes and the UI.
 *
 * The version string is what the settings page shows and what a bug report quotes, so it
 * is worth carrying at runtime rather than only in package.json. Keep it in step with
 * `package.json` — the published tarball is the source of truth, and `assertVersionSynced()`
 * in the tests fails the build if the two drift apart.
 */
export const PACKAGE_NAME = 'dsh-evermemory'
export const VERSION = '0.1.0'
