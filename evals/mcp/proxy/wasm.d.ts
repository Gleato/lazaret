// Wrangler (and the Workers Vitest pool) import a .wasm file as a compiled module.
declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}
