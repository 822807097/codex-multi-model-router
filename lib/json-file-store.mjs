import crypto from 'node:crypto';
import fs from 'node:fs';

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const MAX_TEMP_NAME_ATTEMPTS = 10;

function issue(message, cause) {
  return new Error(message, cause === undefined ? undefined : { cause });
}

function maxBytesOption(options) {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new TypeError('maxBytes 必须是非负安全整数');
  }
  return maxBytes;
}

function assertRegularFile(stat) {
  if (typeof stat.isSymbolicLink === 'function' && stat.isSymbolicLink()) {
    throw issue('JSON 路径不得是符号链接');
  }
  if (typeof stat.isFile !== 'function' || !stat.isFile()) {
    throw issue('JSON 路径必须是普通文件');
  }
  return stat;
}

function lstatIfExists(fileSystem, filePath) {
  try {
    return assertRegularFile(fileSystem.lstatSync(filePath));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function sameFileIdentity(left, right) {
  if (left?.dev === undefined || left?.ino === undefined) return true;
  if (right?.dev === undefined || right?.ino === undefined) return true;
  return left.dev === right.dev && left.ino === right.ino;
}

function openReadFlags(fileSystem) {
  const constants = fileSystem.constants || fs.constants;
  // Windows 依靠 lstat/fstat 身份复核；POSIX 再用 O_NOFOLLOW 封住检查与 open 间的换链窗口。
  const noFollow = process.platform === 'win32' ? 0 : (constants.O_NOFOLLOW || 0);
  return constants.O_RDONLY | noFollow;
}

function withOpenDescriptor(fileSystem, filePath, flags, operation, mode) {
  const descriptor = mode === undefined
    ? fileSystem.openSync(filePath, flags)
    : fileSystem.openSync(filePath, flags, mode);
  let result;
  let operationError;
  try {
    result = operation(descriptor);
  } catch (error) {
    operationError = error;
  }
  let closeError;
  try {
    fileSystem.closeSync(descriptor);
  } catch (error) {
    closeError = error;
  }
  if (operationError) throw operationError;
  if (closeError) throw closeError;
  return result;
}

function hasStableIdentity(stat) {
  return stat?.dev !== undefined && stat?.ino !== undefined;
}

function sameOwnedTemp(expected, current, checkSize = true) {
  return hasStableIdentity(expected)
    && hasStableIdentity(current)
    && sameFileIdentity(expected, current)
    && (!checkSize || expected.size === current.size);
}

function ownedTempStat(fileSystem, tempPath, expected, checkSize = true) {
  let current;
  try {
    current = fileSystem.lstatSync(tempPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (
    (typeof current.isSymbolicLink === 'function' && current.isSymbolicLink())
    || typeof current.isFile !== 'function'
    || !current.isFile()
    || !sameOwnedTemp(expected, current, checkSize)
  ) {
    return null;
  }
  return current;
}

function removeOwnedTemp(fileSystem, tempPath, expected, checkSize = false) {
  if (!ownedTempStat(fileSystem, tempPath, expected, checkSize)) return false;
  fileSystem.unlinkSync(tempPath);
  return true;
}

function assertOwnedTemp(fileSystem, tempPath, expected) {
  let current;
  try {
    current = fileSystem.lstatSync(tempPath);
  } catch (error) {
    if (error?.code === 'ENOENT') throw issue('JSON 临时文件已更换');
    throw error;
  }
  if (typeof current.isSymbolicLink === 'function' && current.isSymbolicLink()) {
    throw issue('JSON 临时文件不得是符号链接');
  }
  if (
    typeof current.isFile !== 'function'
    || !current.isFile()
    || !sameOwnedTemp(expected, current, true)
  ) {
    throw issue('JSON 临时文件已更换');
  }
  return current;
}

function readBoundedBytes(filePath, options = {}) {
  const fileSystem = options.fileSystem || fs;
  const maxBytes = maxBytesOption(options);
  const pathStat = assertRegularFile(fileSystem.lstatSync(filePath));
  if (pathStat.size > maxBytes) throw issue('JSON 文件超过大小上限');

  return withOpenDescriptor(fileSystem, filePath, openReadFlags(fileSystem), (descriptor) => {
    const openedStat = assertRegularFile(fileSystem.fstatSync(descriptor));
    if (!sameFileIdentity(pathStat, openedStat)) throw issue('JSON 文件在读取期间已更换');
    if (openedStat.size > maxBytes) throw issue('JSON 文件超过大小上限');

    const chunks = [];
    let total = 0;
    while (total <= maxBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes - total + 1));
      const count = fileSystem.readSync(descriptor, chunk, 0, chunk.length, null);
      if (count === 0) break;
      total += count;
      if (total > maxBytes) throw issue('JSON 文件超过大小上限');
      chunks.push(chunk.subarray(0, count));
    }

    const finalStat = assertRegularFile(fileSystem.fstatSync(descriptor));
    const finalPathStat = assertRegularFile(fileSystem.lstatSync(filePath));
    if (
      !sameFileIdentity(openedStat, finalStat)
      || !sameFileIdentity(finalStat, finalPathStat)
    ) {
      throw issue('JSON 文件在读取期间已更换');
    }
    if (finalStat.size > maxBytes || total > maxBytes) throw issue('JSON 文件超过大小上限');
    if (Number.isSafeInteger(finalStat.size) && finalStat.size !== total) {
      throw issue('JSON 文件在读取期间发生变化');
    }
    return Buffer.concat(chunks, total);
  });
}

/** 按原始字节计算稳定 SHA-256 revision。 */
export function sha256Bytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/** 使用统一格式编码 JSON；返回值就是后续写盘和计算 revision 的精确字节。 */
export function encodeJson(value) {
  let text;
  try {
    text = JSON.stringify(value, null, 2);
  } catch (error) {
    throw issue('值无法编码为 JSON', error);
  }
  if (text === undefined) throw issue('值无法编码为 JSON');
  return Buffer.from(`${text}\n`, 'utf8');
}

/** 有界读取普通 JSON 文件，同时保留精确字节用于乐观并发控制。 */
export function readRevisionedJson(filePath, options = {}) {
  const bytes = readBoundedBytes(filePath, options);
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw issue('JSON 文件必须是有效 UTF-8', error);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw issue('JSON 文件内容不是有效 JSON', error);
  }
  return { bytes, value, revision: sha256Bytes(bytes) };
}

function uniqueTempPath(filePath, fileSystem, randomUUID) {
  for (let attempt = 0; attempt < MAX_TEMP_NAME_ATTEMPTS; attempt += 1) {
    const candidate = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
    if (!fileSystem.existsSync(candidate)) return candidate;
  }
  throw issue('无法分配唯一 JSON 临时文件');
}

/**
 * 将待写内容放入同目录唯一临时文件，并返回可分阶段同步、替换和清理的准备对象。
 * replace() 会在尚未同步时先调用 sync()，因此单文件调用方不会漏掉 fsync。
 */
export function prepareJsonWrite(filePath, value, options = {}) {
  const fileSystem = options.fileSystem || fs;
  const randomUUID = options.randomUUID || crypto.randomUUID;
  const initialTargetStat = lstatIfExists(fileSystem, filePath);
  const bytes = encodeJson(value);
  const revision = sha256Bytes(bytes);
  const tempPath = uniqueTempPath(filePath, fileSystem, randomUUID);
  const constants = fileSystem.constants || fs.constants;
  let creationIdentity;
  let tempIdentity;
  let active = true;
  let synced = false;
  let replaced = false;

  try {
    tempIdentity = withOpenDescriptor(
      fileSystem,
      tempPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      (descriptor) => {
        const created = assertRegularFile(fileSystem.fstatSync(descriptor));
        if (!hasStableIdentity(created)) throw issue('无法确认 JSON 临时文件身份');
        creationIdentity = created;
        let offset = 0;
        while (offset < bytes.length) {
          const count = fileSystem.writeSync(
            descriptor,
            bytes,
            offset,
            bytes.length - offset,
            null,
          );
          if (!Number.isSafeInteger(count) || count <= 0) throw issue('JSON 临时文件写入不完整');
          offset += count;
        }
        const written = assertRegularFile(fileSystem.fstatSync(descriptor));
        if (!sameOwnedTemp(created, written, false) || written.size !== bytes.length) {
          throw issue('JSON 临时文件写入期间已更换');
        }
        return written;
      },
      0o600,
    );
  } catch (error) {
    // 只有已从创建 fd 取得身份时才有资格清理；否则目录项可能属于竞态中的其他对象。
    if (creationIdentity) {
      try { removeOwnedTemp(fileSystem, tempPath, creationIdentity, false); } catch { /* 不掩盖原错误 */ }
    }
    throw error;
  }

  const cleanup = () => {
    if (!active || replaced) return false;
    const removed = removeOwnedTemp(fileSystem, tempPath, tempIdentity, false);
    active = false;
    return removed;
  };

  const cleanupAfterFailure = () => {
    try { cleanup(); } catch { /* 清理失败不掩盖原阶段错误 */ }
  };

  const sync = () => {
    if (replaced || synced) return revision;
    if (!active) throw issue('JSON 临时文件已清理');
    try {
      assertOwnedTemp(fileSystem, tempPath, tempIdentity);
      const noFollow = process.platform === 'win32' ? 0 : (constants.O_NOFOLLOW || 0);
      withOpenDescriptor(fileSystem, tempPath, constants.O_RDWR | noFollow, (descriptor) => {
        const opened = assertRegularFile(fileSystem.fstatSync(descriptor));
        if (!sameOwnedTemp(tempIdentity, opened, true)) throw issue('JSON 临时文件已更换');
        fileSystem.fsyncSync(descriptor);
      });
      assertOwnedTemp(fileSystem, tempPath, tempIdentity);
      synced = true;
      return revision;
    } catch (error) {
      cleanupAfterFailure();
      throw error;
    }
  };

  const replace = () => {
    if (replaced) return revision;
    if (!active) throw issue('JSON 临时文件已清理');
    if (!synced) sync();
    try {
      assertOwnedTemp(fileSystem, tempPath, tempIdentity);
      const currentTargetStat = lstatIfExists(fileSystem, filePath);
      if (
        (initialTargetStat === null) !== (currentTargetStat === null)
        || (initialTargetStat && !sameFileIdentity(initialTargetStat, currentTargetStat))
      ) {
        throw issue('JSON 目标文件在写入期间已更换');
      }
      fileSystem.renameSync(tempPath, filePath);
      replaced = true;
      active = false;
      return revision;
    } catch (error) {
      cleanupAfterFailure();
      throw error;
    }
  };

  return {
    filePath,
    tempPath,
    bytes,
    revision,
    sync,
    replace,
    cleanup,
  };
}

/** 复制原始字节后重新读取并核对 hash，供事务提交前创建可验证备份。 */
export function copyAndVerify(source, destination, expectedHash, options = {}) {
  const fileSystem = options.fileSystem || fs;
  // 先通过绑定 fd 的读取拒绝源符号链接；hash 仍以复制并同步后的目标重读结果为准。
  readBoundedBytes(source, options);
  if (lstatIfExists(fileSystem, destination) !== null) throw issue('JSON 备份目标已存在');

  const cleanupDestination = () => {
    try {
      fileSystem.unlinkSync(destination);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  };

  try {
    fileSystem.copyFileSync(
      source,
      destination,
      (fileSystem.constants || fs.constants).COPYFILE_EXCL,
    );
  } catch (error) {
    // EEXIST 表示竞态中出现的他人文件，不能清理；其他错误可能已留下本次部分副本。
    if (error?.code !== 'EEXIST') {
      try { cleanupDestination(); } catch { /* 清理失败不掩盖复制错误 */ }
    }
    throw error;
  }

  try {
    const copiedStat = assertRegularFile(fileSystem.lstatSync(destination));
    withOpenDescriptor(fileSystem, destination, 'r+', (descriptor) => {
      const openedStat = assertRegularFile(fileSystem.fstatSync(descriptor));
      if (!sameFileIdentity(copiedStat, openedStat)) throw issue('JSON 备份在同步期间已更换');
      fileSystem.fsyncSync(descriptor);
    });
    const verified = readRevisionedJson(destination, options);
    if (verified.revision !== expectedHash) throw issue('JSON 备份校验失败');
    return {
      bytes: verified.bytes,
      revision: verified.revision,
      source,
      destination,
    };
  } catch (error) {
    try { cleanupDestination(); } catch { /* 清理失败不掩盖同步或校验错误 */ }
    throw error;
  }
}
