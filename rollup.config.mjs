import resolve from '@rollup/plugin-node-resolve';
import { execSync } from 'node:child_process';
import commonjs from '@rollup/plugin-commonjs';
import typescript from '@rollup/plugin-typescript';
import replace from '@rollup/plugin-replace';
import terser from '@rollup/plugin-terser';
import postcss from 'rollup-plugin-postcss';

const isDemo = process.env.DEMO_MODE === '1' || process.env.DEMO_MODE === 'true';

// Short commit of the checkout being built; 'unknown' when git isn't available
// (e.g. building from an exported archive).
function buildCommit() {
  try {
    return execSync('git rev-parse --short HEAD').toString().trim();
  } catch {
    return 'unknown';
  }
}
// Branch being built. CI checkouts are often a detached HEAD, so prefer the
// GitHub Actions ref (PR head branch first) over asking git.
function buildBranch() {
  const ciBranch = process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME;
  if (ciBranch) return ciBranch;
  try {
    return execSync('git rev-parse --abbrev-ref HEAD').toString().trim();
  } catch {
    return 'unknown';
  }
}
// Builds from main are identified by version alone; the commit is only
// shown for other branches, to tell pre-release builds apart.
const commitHash = buildBranch() === 'main' ? '' : buildCommit();

const plugins = [
  postcss({ inject: true, minimize: true, config: false }),
  resolve(), // Resolves node_modules imports
  commonjs(), // Converts CommonJS modules to ES6
  typescript({ tsconfig: './tsconfig.json' }),
  replace({
    'process.env.NODE_ENV': JSON.stringify('production'), // Replace process.env.NODE_ENV
    'process.env.DEMO_MODE': JSON.stringify(isDemo ? 'true' : 'false'),
    __BUILD_COMMIT__: JSON.stringify(commitHash),
    preventAssignment: true,
  }),
  terser(), // Minify: the popup is parse-bound on first open (2.1MB unminified)
]

export default [
  {
    input: 'src/popover/index.tsx',
    output: {
      file: 'build/js/popover.js',
      format: 'iife',
      name: 'Popover',
      sourcemap: true,
    },
    plugins,
  },
  {
    input: 'src/content/content.ts',
    output: {
      file: 'build/js/content.js',
      format: 'iife',
      name: 'content',
      sourcemap: true,
    },
    plugins,
  },
  {
    input: 'src/background/background.ts',
    output: {
      file: 'build/js/background.js',
      format: 'iife',
      name: 'content',
      sourcemap: true,
    },
    plugins,
  },
  {
    input: 'src/options/index.tsx',
    output: {
      file: 'build/js/options.js',
      format: 'iife',
      name: 'Options',
      sourcemap: true,
    },
    plugins,
  }
]
