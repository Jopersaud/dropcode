// Loader for shared/pake.wasm: RustCrypto's spake2 crate (Ed25519, asymmetric
// roles) behind a tiny C ABI. The same binary is embedded in the Go CLI.
import wasmBytes from "../../shared/pake.wasm";

interface PakeExports {
  memory: WebAssembly.Memory;
  pake_alloc(len: number): number;
  pake_free(ptr: number, len: number): void;
  pake_start(side: number, pw: number, pwLen: number, idA: number, idALen: number, idB: number, idBLen: number, seed: number, out: number): number;
  pake_finish(handle: number, msg: number, msgLen: number, out: number): number;
  pake_drop(handle: number): void;
}

export const PAKE_MSG_LEN = 33;
export const PAKE_KEY_LEN = 32;

let exportsPromise: Promise<PakeExports> | null = null;

function load(): Promise<PakeExports> {
  exportsPromise ??= WebAssembly.instantiate(wasmBytes as BufferSource, {}).then(
    (r) => (r as unknown as WebAssembly.WebAssemblyInstantiatedSource).instance.exports as unknown as PakeExports,
  );
  return exportsPromise;
}

/** Copy inputs into wasm memory, run `fn`, copy `outLen` bytes back, wipe and free everything. */
function call(x: PakeExports, inputs: Uint8Array[], outLen: number, fn: (ptrs: number[], out: number) => number) {
  const ptrs = inputs.map((b) => {
    const p = x.pake_alloc(b.length);
    new Uint8Array(x.memory.buffer, p, b.length).set(b);
    return p;
  });
  const out = x.pake_alloc(outLen);
  try {
    const rc = fn(ptrs, out);
    return { rc, out: new Uint8Array(x.memory.buffer, out, outLen).slice() };
  } finally {
    inputs.forEach((b, i) => x.pake_free(ptrs[i]!, b.length));
    x.pake_free(out, outLen);
  }
}

export interface PakeState {
  /** Our outbound SPAKE2 message (33 bytes). */
  readonly message: Uint8Array;
  /** Combine with the peer's message; returns the 32-byte shared key or throws. */
  finish(peerMessage: Uint8Array): Uint8Array;
}

export async function pakeStart(side: "A" | "B", password: Uint8Array, idA: Uint8Array, idB: Uint8Array): Promise<PakeState> {
  const x = await load();
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const { rc: handle, out: message } = call(x, [password, idA, idB, seed], PAKE_MSG_LEN, ([pw, a, b, s], out) =>
    x.pake_start(side === "A" ? 0 : 1, pw!, password.length, a!, idA.length, b!, idB.length, s!, out),
  );
  seed.fill(0);
  if (handle < 0) throw new Error("pake_start failed");
  let used = false;
  return {
    message,
    finish(peer: Uint8Array) {
      if (used) throw new Error("PAKE state already used");
      used = true;
      if (peer.length !== PAKE_MSG_LEN) {
        x.pake_drop(handle);
        throw new Error("bad PAKE message length");
      }
      const { rc, out } = call(x, [peer], PAKE_KEY_LEN, ([m], o) => x.pake_finish(handle, m!, peer.length, o));
      if (rc !== 0) throw new Error("PAKE failed");
      return out;
    },
  };
}
