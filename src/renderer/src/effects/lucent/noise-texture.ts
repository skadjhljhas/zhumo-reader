export const LUCENT_NOISE_SIZE = 256
let values: Uint8Array<ArrayBuffer> | undefined
/** One high-entropy lattice shared by the SDR and HDR engines in this reading session.
 * The same four interpolated noise octaves remain; cached GPU reads replace per-pixel sine hashing. */
export function lucentNoiseValues(): Uint8Array<ArrayBuffer> {
  values ??= crypto.getRandomValues(new Uint8Array(LUCENT_NOISE_SIZE * LUCENT_NOISE_SIZE))
  return values
}
