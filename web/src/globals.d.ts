declare module "*.txt" {
  const text: string;
  export default text;
}
declare module "*.wasm" {
  const bytes: Uint8Array;
  export default bytes;
}
