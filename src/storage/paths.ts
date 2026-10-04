/**
 * Filesystem locations for the memory store.
 *
 * Everything lives under one DSH-home-relative directory so that a user can find, back up
 * or delete the whole store by hand, and so that no file is ever written into a user's
 * project. The project layer is isolated by a `project_key` column, not by a directory
 * next to the code: writing into someone's repository would make this plugin the only one
 * that dirties a checkout merely by being installed.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

import { DSH_HOME_ENV, STORAGE_DIR_NAME, STORAGE_FILE_NAME } from '../constants.js'

/**
 * Resolve the DSH home directory.
 *
 * {@link DSH_HOME_ENV} wins so that a test, a portable install or a second profile can
 * point the store somewhere else without touching the user's real memories.
 *
 * @returns absolute path to the DSH home directory.
 */
export function resolveDshHome(): string {
  const fromEnv = process.env[DSH_HOME_ENV]?.trim()
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  return join(homedir(), '.dsh')
}

/**
 * Directory holding the database and the identity file.
 *
 * @param dshHome - override for {@link resolveDshHome}, for tests.
 * @returns absolute path to the plugin's storage directory.
 */
export function storageDir(dshHome?: string): string {
  return join(dshHome ?? resolveDshHome(), STORAGE_DIR_NAME)
}

/**
 * Absolute path of the SQLite database.
 *
 * @param dshHome - override for {@link resolveDshHome}, for tests.
 * @returns absolute path to the database file.
 */
export function databasePath(dshHome?: string): string {
  return join(storageDir(dshHome), STORAGE_FILE_NAME)
}

/**
 * Path shown to the user when a tool reports where memory lives.
 *
 * Returns a `~`-abbreviated form when the path is under the user's home directory, because
 * an absolute `C:\Users\<name>\...` in tool output is noise the model pays tokens for and
 * cannot act on.
 *
 * @param absolute - the path to display.
 * @returns the path with a leading home directory replaced by `~`.
 */
export function displayPath(absolute: string): string {
  const home = homedir()
  if (absolute === home) return '~'
  if (absolute.startsWith(`${home}\\`) || absolute.startsWith(`${home}/`)) {
    return `~${absolute.slice(home.length)}`
  }
  return absolute
}
