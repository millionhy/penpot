// Independent JWE vectors for the `session` crate.
//
// Node/OpenSSL is a second implementation of the same pieces buddy uses:
// HKDF-HMAC-BLAKE2b-512, RFC 3394 AES-KW, and AES-256-GCM. If RustCrypto
// decrypts a token this script wrote, the format agreement does not depend on
// one library reading its own output.
//
// This is not a buddy vector. A buddy-captured token is still needed for the
// byte-level compatibility claim (backend-rust/PLAN.md §10, C1).
//
// Usage: node crates/session/fixtures/gen-jwe-vector.mjs

import crypto from "node:crypto";

const SECRET = "penpot-test-secret";
const HEADER = '{"alg":"A256KW","enc":"A256GCM","kid":1,"ver":1}';
const b64 = (bytes) => Buffer.from(bytes).toString("base64url");

// RFC 3394 §2.2.1 over node's ECB primitive, plus a self-check against the
// published 256-bit vector.
function aesKwWrap(kek, key) {
  const cipher = crypto.createCipheriv("aes-256-ecb", kek, null);
  cipher.setAutoPadding(false);
  const n = key.length / 8;
  let a = Buffer.from("A6A6A6A6A6A6A6A6", "hex");
  const r = Buffer.from(key);
  for (let j = 0; j < 6; j += 1) {
    for (let i = 1; i <= n; i += 1) {
      const block = Buffer.concat([a, r.subarray((i - 1) * 8, i * 8)]);
      const out = cipher.update(block);
      const t = Buffer.alloc(8);
      t.writeBigUInt64BE(BigInt(n * j + i));
      a = Buffer.alloc(8);
      for (let k = 0; k < 8; k += 1) a[k] = out[k] ^ t[k];
      out.copy(r, (i - 1) * 8, 8, 16);
    }
  }
  return Buffer.concat([a, r]);
}

function selfCheck() {
  const kek = Buffer.from(
    "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
    "hex",
  );
  const key = Buffer.from(
    "00112233445566778899aabbccddeeff000102030405060708090a0b0c0d0e0f",
    "hex",
  );
  const expected =
    "28c9f404c4b810f4cbccb35cfb87f8263f5786e2d80ed326cbc7f0e71a99f43bfb988b9b7a02dd21";
  const actual = aesKwWrap(kek, key).toString("hex");
  if (actual !== expected) {
    throw new Error(`AES-KW self-check failed: ${actual}`);
  }
}

function token(plaintext, cek, iv) {
  const key = Buffer.from(
    crypto.hkdfSync(
      "blake2b512",
      Buffer.from(SECRET),
      Buffer.from("tokens"),
      Buffer.alloc(0),
      32,
    ),
  );
  const protectedSegment = b64(Buffer.from(HEADER, "utf8"));
  const wrapped = aesKwWrap(key, cek);
  const cipher = crypto.createCipheriv("aes-256-gcm", cek, iv);
  cipher.setAAD(Buffer.from(protectedSegment, "ascii"));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return [
    protectedSegment,
    b64(wrapped),
    b64(iv),
    b64(body),
    b64(cipher.getAuthTag()),
  ].join(".");
}

selfCheck();

const claims =
  '["^ ","~:iss","authentication","~:aud","penpot","~:sid","~u00000000-0000-0000-0000-000000000000","~:iat","~m1700000000000","~:uid","~u00000000-0000-0000-0000-000000000000"]';

console.log(
  `derived=${Buffer.from(crypto.hkdfSync("blake2b512", Buffer.from(SECRET), Buffer.from("tokens"), Buffer.alloc(0), 32)).toString("hex")}`,
);
console.log(`hello=${token(Buffer.from("hello"), Buffer.alloc(32, 7), Buffer.alloc(12, 9))}`);
console.log(
  `claims=${token(Buffer.from(claims, "utf8"), Buffer.alloc(32, 3), Buffer.alloc(12, 4))}`,
);
console.log(`claims-plaintext=${claims}`);
