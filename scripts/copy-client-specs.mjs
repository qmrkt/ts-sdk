import { cpSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')
const sourceDir = path.join(projectRoot, 'src', 'clients', 'specs')
const targetDir = path.join(projectRoot, 'dist', 'clients', 'specs')

mkdirSync(targetDir, { recursive: true })
cpSync(sourceDir, targetDir, { recursive: true })
