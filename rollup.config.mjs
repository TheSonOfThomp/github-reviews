import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import typescript from '@rollup/plugin-typescript';
import replace from '@rollup/plugin-replace';
import postcss from 'rollup-plugin-postcss';

const plugins = [
  postcss({ inject: true, minimize: true, config: false }),
  resolve(), // Resolves node_modules imports
  commonjs(), // Converts CommonJS modules to ES6
  typescript({ tsconfig: './tsconfig.json' }),
  replace({
    'process.env.NODE_ENV': JSON.stringify('production'), // Replace process.env.NODE_ENV
    preventAssignment: true,
  }), 
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
