/**
 * Non-TypeScript imports the bundler resolves.
 *
 * `import './styles/base.css'` is a side-effect import: Bun extracts
 * the stylesheet into its own artifact and `index.html` links it, so
 * there is no value to type — only a module for the compiler to accept.
 */
declare module '*.css';
