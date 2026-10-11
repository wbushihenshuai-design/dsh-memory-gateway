import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs'
import { constants as bufferConstants } from 'node:buffer'
import { TextDecoder } from 'node:util'

const DEFAULT_MAX_BYTES = 134217728
const CHUNK_BYTES = 64 * 1024
const MAX_DEPTH = 256
const ERROR_CODES = new Set([
  'private_json_failed',
  'private_json_unsupported',
  'private_json_path_invalid',
  'private_json_limit_invalid',
  'private_json_unavailable',
  'private_json_directory_unsafe',
  'private_json_file_unsafe',
  'private_json_too_large',
  'private_json_changed',
  'private_json_invalid',
  'private_json_duplicate_key',
  'private_json_too_deep',
  'private_json_close_failed',
])

/** Only fixed codes are public: never attach a path, JSON fragment, or raw cause. */
export class PrivateJsonError extends Error {
  constructor(code) {
    const safeCode = ERROR_CODES.has(code) ? code : 'private_json_failed'
    super(safeCode)
    this.name = 'PrivateJsonError'
    this.code = safeCode
  }
}

function fail(code) {
  throw new PrivateJsonError(code)
}

function pathParts(absolutePath) {
  // Do not normalize away '..' or a component that must receive O_NOFOLLOW.
  if (typeof absolutePath !== 'string' || !absolutePath.startsWith('/') || absolutePath.includes('\0')) {
    fail('private_json_path_invalid')
  }
  const parts = absolutePath.slice(1).split('/')
  if (parts.some(part => part === '' || part === '.' || part === '..')) fail('private_json_path_invalid')
  return parts
}

function readLimit(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) fail('private_json_limit_invalid')
  const maxBytes = options.maxBytes === undefined ? DEFAULT_MAX_BYTES : options.maxBytes
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > bufferConstants.MAX_LENGTH || maxBytes > bufferConstants.MAX_STRING_LENGTH) {
    fail('private_json_limit_invalid')
  }
  return maxBytes
}

function trustedOwner(stat, uid) {
  return stat.uid === 0n || stat.uid === uid
}

function checkDirectory(stat, uid, systemTmpAncestor) {
  if (!stat.isDirectory() || !trustedOwner(stat, uid)) fail('private_json_directory_unsafe')
  // The sole writable-ancestor exception is root-owned, sticky /tmp, never
  // the immediate parent. Arbitrary sticky directories are not trusted.
  if ((stat.mode & 0o022n) !== 0n && !(systemTmpAncestor && stat.uid === 0n && (stat.mode & 0o1000n) !== 0n)) {
    fail('private_json_directory_unsafe')
  }
}

function checkFile(stat, uid) {
  const permissions = stat.mode & 0o7777n
  if (!stat.isFile() || stat.nlink !== 1n || !trustedOwner(stat, uid) || (permissions !== 0o600n && permissions !== 0o400n)) {
    fail('private_json_file_unsafe')
  }
}

function unchanged(before, after) {
  // atime is deliberately excluded: our own reads may update it. Nanosecond
  // mtime/ctime catch same-size overwrites and permission/link-count changes.
  return ['dev', 'ino', 'mode', 'uid', 'gid', 'nlink', 'size', 'mtimeNs', 'ctimeNs']
    .every(key => before[key] === after[key])
}

function readBounded(fd, maxBytes) {
  const chunks = []
  const buffer = Buffer.alloc(Math.min(CHUNK_BYTES, maxBytes))
  let total = 0
  while (total < maxBytes) {
    const amount = readSync(fd, buffer, 0, Math.min(buffer.length, maxBytes - total), null)
    if (amount === 0) break
    chunks.push(Buffer.from(buffer.subarray(0, amount)))
    total += amount
  }
  // At most maxBytes + 1 bytes are ever read, even if the file grows forever.
  // The single excess byte detects over-limit data; it is never parsed.
  if (total === maxBytes && readSync(fd, buffer, 0, 1, null) !== 0) fail('private_json_too_large')
  return Buffer.concat(chunks, total)
}

/** Strict JSON grammar, with decoded-key uniqueness per object. */
function parseJson(text) {
  let position = 0
  function invalid() { fail('private_json_invalid') }
  function whitespace() {
    while (position < text.length && (text[position] === ' ' || text[position] === '\t' || text[position] === '\r' || text[position] === '\n')) position++
  }
  function string() {
    const start = position++
    while (position < text.length) {
      const code = text.charCodeAt(position++)
      if (code === 0x22) {
        // JSON.parse is used only for one validated string token, never an
        // object (which would silently discard duplicate keys).
        return JSON.parse(text.slice(start, position))
      }
      if (code < 0x20) invalid()
      if (code !== 0x5c) continue
      const escape = text[position++]
      if (escape === 'u') {
        for (let i = 0; i < 4; i++) {
          const hex = text.charCodeAt(position++)
          if (!((hex >= 0x30 && hex <= 0x39) || (hex >= 0x41 && hex <= 0x46) || (hex >= 0x61 && hex <= 0x66))) invalid()
        }
      } else if (!['"', '\\', '/', 'b', 'f', 'n', 'r', 't'].includes(escape)) invalid()
    }
    invalid()
  }
  function digit(code) { return code >= 0x30 && code <= 0x39 }
  function number() {
    const start = position
    if (text[position] === '-') position++
    if (text[position] === '0') position++
    else {
      const first = text.charCodeAt(position)
      if (first < 0x31 || first > 0x39 || !Number.isFinite(first)) invalid()
      while (digit(text.charCodeAt(position))) position++
    }
    if (text[position] === '.') {
      position++
      if (!digit(text.charCodeAt(position))) invalid()
      while (digit(text.charCodeAt(position))) position++
    }
    if (text[position] === 'e' || text[position] === 'E') {
      position++
      if (text[position] === '+' || text[position] === '-') position++
      if (!digit(text.charCodeAt(position))) invalid()
      while (digit(text.charCodeAt(position))) position++
    }
    const result = Number(text.slice(start, position))
    // Do not let an overflow become Infinity in a policy/credential document.
    if (!Number.isFinite(result)) invalid()
    return result
  }
  function value(depth) {
    whitespace()
    const token = text[position]
    if (token === '"') return string()
    if (token === '{' || token === '[') {
      if (depth >= MAX_DEPTH) fail('private_json_too_deep')
      position++
      const object = token === '{'
      // '__proto__', 'constructor', and 'prototype' are plain own keys, never
      // setters or inherited entries. Consumers must still validate schemas.
      const result = object ? Object.create(null) : []
      const end = object ? '}' : ']'
      whitespace()
      if (text[position] === end) { position++; return result }
      while (true) {
        if (object) {
          whitespace()
          if (text[position] !== '"') invalid()
          const key = string()
          if (Object.hasOwn(result, key)) fail('private_json_duplicate_key')
          whitespace()
          if (text[position++] !== ':') invalid()
          result[key] = value(depth + 1)
        } else result.push(value(depth + 1))
        whitespace()
        const next = text[position++]
        if (next === end) return result
        if (next !== ',') invalid()
      }
    }
    for (const [literal, result] of [['true', true], ['false', false], ['null', null]]) {
      if (text.startsWith(literal, position)) { position += literal.length; return result }
    }
    if (token === '-' || digit(text.charCodeAt(position))) return number()
    invalid()
  }
  const result = value(0)
  whitespace()
  if (position !== text.length) invalid()
  return result
}

/**
 * Read Linux private JSON synchronously; objects have a null prototype.
 *
 * Requires a trusted Linux /proc mount. Pin each directory fd, then use its
 * /proc/self/fd/<fd>/<component> alias with O_NOFOLLOW on the supplied component.
 * No supplied symlink (including ancestor symlinks) is ever followed. The proc
 * fd aliases themselves are intentional kernel-provided magic links.
 *
 * Trust boundary: root/current real UID and the running process are trusted.
 * This is NOT protection against root, hostile same-UID code, mount changes,
 * uncooperative/network filesystems, or writers able to evade stat timestamps.
 * fstat checks detect ordinary in-place races, not a transactional snapshot;
 * an ancestor rename may still yield the already-pinned original directory.
 * No schema validation, secure erasure, or process-wide memory cap is provided.
 * Input bytes are bounded; parsed objects/text use additional managed memory.
 */
export function readPrivateJson(absolutePath, options = {}) {
  const descriptors = []
  let result
  let failure
  try {
    if (process.platform !== 'linux' || typeof process.getuid !== 'function' || !constants.O_NOFOLLOW || !constants.O_DIRECTORY || !constants.O_NONBLOCK) {
      fail('private_json_unsupported')
    }
    const parts = pathParts(absolutePath)
    const maxBytes = readLimit(options)
    const uid = BigInt(process.getuid())
    const directoryFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY | constants.O_NONBLOCK
    function pin(path, flags) {
      const fd = openSync(path, flags)
      descriptors.push(fd)
      return fd
    }
    const directories = []
    let parent = pin('/', directoryFlags)
    checkDirectory(fstatSync(parent, { bigint: true }), uid, false)
    directories.push({ fd: parent, systemTmpAncestor: false })
    for (let i = 0; i < parts.length - 1; i++) {
      parent = pin(`/proc/self/fd/${parent}/${parts[i]}`, directoryFlags)
      const systemTmpAncestor = i === 0 && parts[i] === 'tmp' && i < parts.length - 2
      checkDirectory(fstatSync(parent, { bigint: true }), uid, systemTmpAncestor)
      directories.push({ fd: parent, systemTmpAncestor })
    }
    // O_NONBLOCK prevents a FIFO from hanging before fstat can reject it.
    const fd = pin(`/proc/self/fd/${parent}/${parts.at(-1)}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const before = fstatSync(fd, { bigint: true })
    checkFile(before, uid)
    if (before.size > BigInt(maxBytes)) fail('private_json_too_large')
    const bytes = readBounded(fd, maxBytes)
    const after = fstatSync(fd, { bigint: true })
    checkFile(after, uid)
    if (!unchanged(before, after) || after.size !== BigInt(bytes.length)) fail('private_json_changed')
    for (const directory of directories) {
      checkDirectory(fstatSync(directory.fd, { bigint: true }), uid, directory.systemTmpAncestor)
    }
    // fatal prevents invalid UTF-8 becoming replacement characters. Keep a BOM
    // visible to the strict grammar so it is rejected rather than stripped.
    result = parseJson(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes))
  } catch (error) {
    failure = error instanceof PrivateJsonError ? error : new PrivateJsonError(
      error instanceof SyntaxError || error?.code === 'ERR_ENCODING_INVALID_ENCODED_DATA'
        ? 'private_json_invalid' : 'private_json_unavailable',
    )
  } finally {
    for (let i = descriptors.length - 1; i >= 0; i--) {
      try { closeSync(descriptors[i]) } catch {
        // Do not retry close: Linux may already have released that fd. Still
        // attempt every other close, and never expose a native close error.
        failure ??= new PrivateJsonError('private_json_close_failed')
      }
    }
  }
  if (failure) throw failure
  return result
}
