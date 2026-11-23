import { deflateSync } from "zlib"
import { join } from "path"
import {
  decodeBase85Lines,
  decodeBinaryPatch,
  gitBlobHash,
  applyBinaryDelta,
} from "./binary"
import { parsePatchFile } from "./parse"

// generated with: git init && git add logo.bin && git commit &&
//   edit logo.bin && git diff --binary
const DELTA_PATCH = `diff --git a/logo.bin b/logo.bin
index 87daae723cf137874042899ba6a1b4f3ceb5c0c0..53a25ba97b17ff2a93277d3ba64f0fcb8f966bbe 100644
GIT binary patch
delta 21
acmcc3f17_o3fH~0\`\`&{vBh$vbTy_9\`KnmFa

delta 21
dcmcc3f17_o3RkpR&x?cyuNk(z-k6um4ghT*3MT*n
`

const BEFORE_BLOB_HASH = "87daae723cf137874042899ba6a1b4f3ceb5c0c0"
const AFTER_BLOB_HASH = "53a25ba97b17ff2a93277d3ba64f0fcb8f966bbe"

// git's base85 encoder, for building literal patch fixtures in these tests
const B85_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+-;<=>?@^_`{|}~"

function encodeBase85(buffer: Buffer): string[] {
  const encodeGroup = (n: number) => {
    const chars: string[] = []
    for (let i = 0; i < 5; i++) {
      chars.unshift(B85_ALPHABET[n % 85])
      n = Math.floor(n / 85)
    }
    return chars.join("")
  }
  const lines: string[] = []
  let i = 0
  while (i < buffer.length) {
    const chunk = buffer.slice(i, i + 52)
    const lengthChar = String.fromCharCode(
      chunk.length <= 26 ? 64 + chunk.length : 70 + chunk.length,
    )
    let encoded = ""
    for (let j = 0; j < chunk.length; j += 4) {
      const group = chunk.slice(j, j + 4)
      let acc = 0
      for (let k = 0; k < 4; k++) {
        // tslint:disable-next-line:no-bitwise
        acc = acc * 256 + (k < group.length ? group[k] : 0)
      }
      const groupStr = encodeGroup(acc)
      encoded += groupStr
    }
    lines.push(lengthChar + encoded)
    i += 52
  }
  return lines
}

describe("git binary patches", () => {
  it("applies a real git delta patch end-to-end", () => {
    const { execSync } = require("child_process")
    const { dirSync } = require("tmp")
    const repo = dirSync().name
    const run = (cmd: string) =>
      execSync(cmd, { cwd: repo, stdio: ["ignore", "pipe", "inherit"] })
    try {
      execSync("git init -q", { cwd: repo })
      execSync('git config user.email "t@t"', { cwd: repo })
      execSync('git config user.name "t"', { cwd: repo })
      const before = Buffer.alloc(4096)
      for (let i = 0; i < before.length; i++) {
        before[i] = i % 251
      }
      require("fs").writeFileSync(join(repo, "logo.bin"), before)
      run("git add -A && git commit -qm init")
      // make a small change so git produces a delta
      const after = Buffer.from(before)
      after.set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 100)
      require("fs").writeFileSync(join(repo, "logo.bin"), after)
      const diff: Buffer = run("git diff --binary")
      const patch = parsePatchFile(diff.toString())
      expect(patch).toHaveLength(1)
      const part = patch[0]
      if (part.type !== "binary patch") {
        throw new Error("expected a binary patch")
      }
      expect(part.binary.method).toBe("delta")
      const result = decodeBinaryPatch(part.binary, before)
      expect(result).toEqual(after)
      expect(gitBlobHash(before)).toBe(part.beforeHash)
      expect(gitBlobHash(after)).toBe(part.afterHash)
      // the reverse section must undo the change
      const reversed = decodeBinaryPatch(part.reverseBinary!, after)
      expect(reversed).toEqual(before)
    } finally {
      require("fs-extra").removeSync(repo)
    }
  })

  it("parses forward and reverse sections", () => {
    const patch = parsePatchFile(DELTA_PATCH)
    expect(patch).toHaveLength(1)
    const part: any = patch[0]
    expect(part.type).toBe("binary patch")
    expect(part.binary.method).toBe("delta")
    expect(part.binary.size).toBe(21)
    expect(part.reverseBinary.method).toBe("delta")
    expect(part.beforeHash).toBe(BEFORE_BLOB_HASH)
    expect(part.afterHash).toBe(AFTER_BLOB_HASH)
  })

  it("reverses a binary patch that has a reverse section", () => {
    const patch = parsePatchFile(DELTA_PATCH)
    const part: any = patch[0]
    const { reversePatch } = require("./reverse")
    const reversed: any = reversePatch(patch)[0]
    expect(reversed.type).toBe("binary patch")
    expect(reversed.binary.method).toBe(part.reverseBinary.method)
    expect(reversed.binary.size).toBe(part.reverseBinary.size)
    expect(reversed.beforeHash).toBe(AFTER_BLOB_HASH)
    expect(reversed.afterHash).toBe(BEFORE_BLOB_HASH)
  })

  it("decodes literal sections", () => {
    const contents = Buffer.from("hello binary world, ".repeat(3))
    const compressed = deflateSync(contents)
    const encoded = encodeBase85(compressed)
    const patchText = `diff --git a/data.bin b/data.bin
index 0000000000000000000000000000000000000000..1111111111111111111111111111111111111111 100644
GIT binary patch
literal ${contents.length}
${encoded.join("\n")}

`
    const patch = parsePatchFile(patchText)
    const part: any = patch[0]
    expect(part.type).toBe("binary patch")
    expect(part.binary.method).toBe("literal")
    const decoded = decodeBinaryPatch(part.binary, null)
    expect(decoded).toEqual(contents)
  })

  it("applies delta instructions", () => {
    const source = Buffer.from("the quick brown fox jumps over the lazy dog")
    // a delta that copies "the quick brown f" then inserts "cat"
    // and copies "ox jumps over the lazy dog"
    const sourceSizeVarint = Buffer.from([source.length])
    const target = Buffer.concat([
      source.slice(0, 17),
      Buffer.from("cat"),
      source.slice(17),
    ])
    const targetSizeVarint = Buffer.from([target.length])
    // copy instruction: op byte 0x80 | 0x01 (1 offset byte) | 0x10 (1 size byte)
    const copy = (offset: number, size: number) =>
      Buffer.from([0x80 | 0x01 | 0x10, offset, size])
    const delta = Buffer.concat([
      sourceSizeVarint,
      targetSizeVarint,
      copy(0, 17),
      Buffer.from([3, ...Buffer.from("cat")]),
      copy(17, source.length - 17),
    ])
    expect(applyBinaryDelta(source, delta)).toEqual(target)
  })

  it("rejects data lines that do not start with a length character", () => {
    const badPatch = `diff --git a/logo.bin b/logo.bin
index 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100644
GIT binary patch
delta 5
@@ bad line @@
`
    expect(() => parsePatchFile(badPatch)).toThrow("Bad binary patch data line")
  })

  it("treats 'z' as an ordinary base85 digit (git decode_85 semantics)", () => {
    // 'z' has value 61 in git's base85 alphabet; a group may START with it:
    // "z0000" = 0xbdcb9e2d. The old (incorrect) z-shorthand decoding turned
    // this into four zero bytes, corrupting real-world patches.
    expect(decodeBase85Lines(["Az0000"])).toEqual(Buffer.from([0xbd]))
    expect(decodeBase85Lines(["Dz0000"])).toEqual(
      Buffer.from([0xbd, 0xcb, 0x9e, 0x2d]),
    )
    // a group that overflows 32 bits is rejected, as in git's decode_85
    // ("|NsC1" = 4294967296 = 2^32)
    expect(() => decodeBase85Lines(["A|NsC1"])).toThrow("Invalid base85 sequence")
  })
})
