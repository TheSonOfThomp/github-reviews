import { readFileSync, writeFileSync } from 'fs'

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const manifestPath = 'build/manifest.json'
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

manifest.version = pkg.version
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')

console.log(`Synced manifest.json version to ${pkg.version}`)
