import * as nodeFs from 'node:fs'
import { createRequire } from 'node:module'

// Update/backup code owns real disk files, including app.asar itself. Electron's default
// fs transparently treats ASARs as virtual directories; that is correct for module loading
// but would lose the raw package identity when hashing, copying or retiring an installation.
const runtimeRequire = createRequire(process.execPath)
const physical: typeof nodeFs = process.versions.electron ? runtimeRequire('original-fs') : nodeFs
export const physicalFs = physical.promises
export const physicalFsSync = physical
