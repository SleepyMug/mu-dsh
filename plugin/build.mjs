// Build both halves into lib/, which is committed: mu-dsh installs the plugin
// without a build step, as it runs the gateway from its sources.
//
//   lib/index.js   the host half, an ES module dsh imports. It is installed
//                  outside dsh's own node_modules, so it can import nothing of
//                  dsh's at runtime: fflate is bundled in, dsh is only types.
//   lib/client.js  the browser half, as dsh's web client loads a plugin's
//                  ./client: one script registering a factory with the page's
//                  module loader, which runs it with the loader's `require`.
//                  What it requires is the shell's module table (React and
//                  dsh's static UI libraries); dsh-util-workspace-path, plain
//                  functions, is bundled in. Anything else fails the build.
//
// `node build.mjs --check` builds into memory and fails if lib/ differs.
import { readFileSync, writeFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { build } from 'esbuild'

const here = path => new URL(path, import.meta.url).pathname
const { name } = JSON.parse(readFileSync(here('package.json'), 'utf8'))
const check = process.argv.includes('--check')

const SHELL = new Set([
  'react',
  'react/jsx-runtime',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-slots',
])
const CLIENT_BUNDLED = new Set(['@deepseek-ai/dsh-util-workspace-path'])
const HOST_BUNDLED = new Set(['fflate'])
const NODE = new Set([...builtinModules, ...builtinModules.map(m => `node:${m}`)])

function only(allowed, external) {
  return {
    name: 'only',
    setup(b) {
      b.onResolve({ filter: /^[^./]/ }, ({ path, importer }) => {
        if (external.has(path)) return { path, external: true }
        if (allowed.has(path)) return undefined
        return { errors: [{ text: `${path}, which ${importer} imports, is neither bundled nor available at runtime` }] }
      })
    },
  }
}

const HEADER = '// Built by plugin/build.mjs from plugin/src; edit the sources, not this file.\n'

const host = await build({
  entryPoints: [here('src/index.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  legalComments: 'eof',
  write: false,
  plugins: [only(HOST_BUNDLED, NODE)],
})

const client = await build({
  entryPoints: [here('src/client/index.ts')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  legalComments: 'eof',
  write: false,
  plugins: [only(CLIENT_BUNDLED, SHELL)],
})

const outputs = {
  'lib/index.js': HEADER + host.outputFiles[0].text,
  'lib/client.js': `${HEADER}window.__ModuleLoader__.load({
\tid: ${JSON.stringify(name)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
${client.outputFiles[0].text}
\t\treturn module.exports;
\t}
});
`,
}

let stale = false
for (const [path, text] of Object.entries(outputs)) {
  if (!check) {
    writeFileSync(here(path), text)
    continue
  }
  let current = ''
  try { current = readFileSync(here(path), 'utf8') } catch {}
  if (current !== text) {
    console.error(`${path} is out of date; run: pnpm build`)
    stale = true
  }
}
if (stale) process.exit(1)
