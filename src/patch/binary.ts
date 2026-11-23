import { createHash } from "crypto"
import { inflateSync } from "zlib"

/**
 * A single git binary patch section: either the forward or the reverse
 * transformation of a file. Serialized as base85-encoded deflate data.
 */
export interface BinaryPatchData {
  method: "literal" | "delta"
  /** the size in bytes of the deflate-compressed payload */
  size: number
  /** the raw base85-encoded lines emitted by git */
  lines: string[]
}

// git's base85 alphabet, see en85[] in git's base85.c
const BASE85_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+-;<=>?@^_`{|}~"

const BASE85_VALUES: { [char: string]: number } = {}
for (let i = 0; i < BASE85_ALPHABET.length; i++) {
  BASE85_VALUES[BASE85_ALPHABET[i]] = i
}

function decodeBase85Char(c: string): number {
  const value = BASE85_VALUES[c]
  if (value === undefined) {
    throw new Error(`Invalid base85 character: '${c}'`)
  }
  return value
}

/**
 * Decode the base85-encoded data lines of a git binary patch section.
 *
 * Each line starts with a length character: 'A'-'Z' encodes 1-26 bytes,
 * 'a'-'z' encodes 27-52 bytes. The rest of the line consists of 5-character
 * base85 groups encoding 4 bytes each. The character 'z' can appear in place
 * of a 5-character group and expands to four zero bytes.
 */
export function decodeBase85Lines(lines: string[]): Buffer {
  const chunks: Buffer[] = []
  for (const line of lines) {
    const lengthChar = line[0]
    let numBytes: number
    if (lengthChar >= "A" && lengthChar <= "Z") {
      numBytes = lengthChar.charCodeAt(0) - 64 // 'A' (65) -> 1 ... 'Z' (90) -> 26
    } else if (lengthChar >= "a" && lengthChar <= "z") {
      numBytes = lengthChar.charCodeAt(0) - 96 + 26 // 'a' (97) -> 27 ... 'z' (122) -> 52
    } else {
      throw new Error(`Bad binary patch data line: '${line}'`)
    }

    const bytes: number[] = []
    let i = 1
    while (bytes.length < numBytes) {
      if (line[i] === "z") {
        bytes.push(0, 0, 0, 0)
        i += 1
        continue
      }
      let acc = 0
      for (let j = 0; j < 5; j++) {
        const c = line[i + j]
        if (c === undefined) {
          throw new Error(`Binary patch data line is too short: '${line}'`)
        }
        acc = acc * 85 + decodeBase85Char(c)
      }
      i += 5
      // tslint:disable-next-line:no-bitwise
      bytes.push(
        (acc >>> 24) & 0xff,
        (acc >>> 16) & 0xff,
        (acc >>> 8) & 0xff,
        acc & 0xff,
      )
    }
    if (bytes.length - numBytes > 3) {
      throw new Error(
        `Binary patch data line encodes ${bytes.length} bytes but declared ${numBytes}`,
      )
    }
    chunks.push(Buffer.from(bytes.slice(0, numBytes)))
  }
  return Buffer.concat(chunks)
}

/**
 * Decode a git binary patch section into its payload.
 * The size declared in the header line is the *inflated* payload size.
 */
export function inflateBinaryPatchData(data: BinaryPatchData): Buffer {
  const compressed = decodeBase85Lines(data.lines)
  const inflated = inflateSync(compressed)
  if (inflated.length !== data.size) {
    throw new Error(
      `Binary patch data size mismatch: expected ${data.size} bytes, got ${inflated.length}`,
    )
  }
  return inflated
}

function readVarint(buffer: Buffer, pos: { index: number }): number {
  let result = 0
  let shift = 0
  while (true) {
    const byte = buffer[pos.index++]
    // tslint:disable-next-line:no-bitwise
    result |= (byte & 0x7f) << shift
    // tslint:disable-next-line:no-bitwise
    if ((byte & 0x80) === 0) {
      break
    }
    shift += 7
  }
  return result
}

/**
 * Apply a git binary delta to the original file content.
 * See Documentation/technical/pack-format.txt in the git source tree for the
 * delta format specification.
 */
export function applyBinaryDelta(source: Buffer, delta: Buffer): Buffer {
  const pos = { index: 0 }
  const sourceSize = readVarint(delta, pos)
  const targetSize = readVarint(delta, pos)

  if (sourceSize !== source.length) {
    throw new Error(
      `Binary delta source size mismatch: expected ${sourceSize}, got ${source.length}`,
    )
  }

  const target = Buffer.alloc(targetSize)
  let targetPos = 0

  while (pos.index < delta.length) {
    const op = delta[pos.index++]
    // tslint:disable-next-line:no-bitwise
    if (op & 0x80) {
      // copy from source
      let offset = 0
      let size = 0
      // tslint:disable-next-line:no-bitwise
      for (let bit = 0; bit < 4; bit++) {
        // tslint:disable-next-line:no-bitwise
        if (op & (1 << bit)) {
          // tslint:disable-next-line:no-bitwise
          offset |= delta[pos.index++] << (8 * bit)
        }
      }
      // tslint:disable-next-line:no-bitwise
      for (let bit = 4; bit < 7; bit++) {
        // tslint:disable-next-line:no-bitwise
        if (op & (1 << bit)) {
          // tslint:disable-next-line:no-bitwise
          size |= delta[pos.index++] << (8 * (bit - 4))
        }
      }
      if (size === 0) {
        size = 0x10000
      }
      if (offset + size > source.length || targetPos + size > targetSize) {
        throw new Error("Binary delta copy instruction out of bounds")
      }
      source.copy(target, targetPos, offset, offset + size)
      targetPos += size
    } else if (op > 0) {
      // insert literal bytes from the delta
      if (targetPos + op > targetSize || pos.index + op > delta.length) {
        throw new Error("Binary delta insert instruction out of bounds")
      }
      delta.copy(target, targetPos, pos.index, pos.index + op)
      targetPos += op
      pos.index += op
    } else {
      throw new Error("Unexpected delta opcode 0")
    }
  }

  if (targetPos !== targetSize) {
    throw new Error(
      `Binary delta target size mismatch: expected ${targetSize}, got ${targetPos}`,
    )
  }

  return target
}

/**
 * Compute the git blob hash of a file's contents.
 * Used to verify that binary patches apply to the expected file state.
 */
export function gitBlobHash(contents: Buffer): string {
  const hash = createHash("sha1")
  hash.update(`blob ${contents.length}\0`)
  hash.update(contents)
  return hash.digest("hex")
}

/**
 * Apply a git binary patch section and return the resulting file contents.
 */
export function decodeBinaryPatch(
  data: BinaryPatchData,
  originalContents: Buffer | null,
): Buffer {
  const payload = inflateBinaryPatchData(data)
  switch (data.method) {
    case "literal":
      return payload
    case "delta":
      if (!originalContents) {
        throw new Error(
          "Binary delta patch requires the original file contents",
        )
      }
      return applyBinaryDelta(originalContents, payload)
    default:
      throw new Error("Unknown binary patch method: " + (data as any).method)
  }
}
