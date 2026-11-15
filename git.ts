import { createHash } from 'node:crypto';
import { inflateSync, deflateSync } from 'node:zlib';

export interface GitRepo {
  owner: string;
  name: string;
  default_branch: string;
  objects: Map<string, { type: string; data: Buffer }>;
  refs: Map<string, string>;
  generation: number;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export interface CommitObject {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export interface TagObject {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export interface PktPacket {
  type: 'data' | 'flush' | 'delim' | 'response-end';
  data?: Buffer;
}

// Object Model
export function computeObjectId(type: string, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf-8');
  return createHash('sha1').update(Buffer.concat([header, data])).digest('hex');
}

export function storeObject(repo: GitRepo, type: string, data: Buffer): string {
  const id = computeObjectId(type, data);
  if (!repo.objects.has(id)) {
    repo.objects.set(id, { type, data });
  }
  return id;
}

export function parseCommit(data: Buffer): CommitObject {
  const text = data.toString('utf-8');
  const blankIdx = text.indexOf('\n\n');
  const headerText = blankIdx === -1 ? text : text.slice(0, blankIdx);
  const message = blankIdx === -1 ? '' : text.slice(blankIdx + 2);

  const lines = headerText.split('\n');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';

  for (const line of lines) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(commit: CommitObject): Buffer {
  const lines: string[] = [];
  lines.push(`tree ${commit.tree}`);
  for (const p of commit.parents) {
    lines.push(`parent ${p}`);
  }
  lines.push(`author ${commit.author}`);
  lines.push(`committer ${commit.committer}`);
  lines.push('');
  lines.push(commit.message);
  return Buffer.from(lines.join('\n'), 'utf-8');
}

function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const isDirA = a.mode.startsWith('4') || a.mode === '40000' || a.mode === '040000';
  const isDirB = b.mode.startsWith('4') || b.mode === '40000' || b.mode === '040000';
  const nameA = a.name + (isDirA ? '/' : '');
  const nameB = b.name + (isDirB ? '/' : '');
  if (nameA < nameB) return -1;
  if (nameA > nameB) return 1;
  return 0;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const spaceIdx = data.indexOf(32, offset);
    if (spaceIdx === -1) break;
    const mode = data.toString('utf-8', offset, spaceIdx);
    const nullIdx = data.indexOf(0, spaceIdx + 1);
    if (nullIdx === -1) break;
    const name = data.toString('utf-8', spaceIdx + 1, nullIdx);
    const shaStart = nullIdx + 1;
    const shaEnd = shaStart + 20;
    if (shaEnd > data.length) break;
    const oid = data.subarray(shaStart, shaEnd).toString('hex');
    entries.push({ mode, name, oid });
    offset = shaEnd;
  }
  return entries;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeEntries);
  const buffers: Buffer[] = [];
  for (const entry of sorted) {
    const header = Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf-8');
    const shaBin = Buffer.from(entry.oid, 'hex');
    buffers.push(header, shaBin);
  }
  return Buffer.concat(buffers);
}

export function parseTag(data: Buffer): TagObject {
  const text = data.toString('utf-8');
  const blankIdx = text.indexOf('\n\n');
  const headerText = blankIdx === -1 ? text : text.slice(0, blankIdx);
  const message = blankIdx === -1 ? '' : text.slice(blankIdx + 2);

  const lines = headerText.split('\n');
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';

  for (const line of lines) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

export function buildTag(t: TagObject): Buffer {
  const lines = [
    `object ${t.object}`,
    `type ${t.type}`,
    `tag ${t.tag}`,
    `tagger ${t.tagger}`,
    '',
    t.message,
  ];
  return Buffer.from(lines.join('\n'), 'utf-8');
}

export function getReachableObjects(repo: GitRepo, rootIds: string[]): Set<string> {
  const visited = new Set<string>();
  const queue = [...rootIds];

  while (queue.length > 0) {
    const id = queue.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);

    const obj = repo.objects.get(id);
    if (!obj) {
      throw new Error(`Missing object: ${id}`);
    }

    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      if (c.tree && !visited.has(c.tree)) queue.push(c.tree);
      for (const p of c.parents) {
        if (p && !visited.has(p)) queue.push(p);
      }
    } else if (obj.type === 'tree') {
      const entries = parseTree(obj.data);
      for (const entry of entries) {
        if (entry.mode === '160000') continue;
        if (entry.oid && !visited.has(entry.oid)) queue.push(entry.oid);
      }
    } else if (obj.type === 'tag') {
      const t = parseTag(obj.data);
      if (t.object && !visited.has(t.object)) queue.push(t.object);
    }
  }
  return visited;
}

export function walkTreePath(repo: GitRepo, treeId: string, path: string): TreeEntry | null {
  if (!path || path === '/') return null;
  const segments = path.split('/').filter(Boolean);
  let currentTreeId = treeId;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const obj = repo.objects.get(currentTreeId);
    if (!obj || obj.type !== 'tree') return null;
    const entries = parseTree(obj.data);
    const found = entries.find(e => e.name === seg);
    if (!found) return null;

    if (i === segments.length - 1) {
      return found;
    } else {
      const isDir = found.mode.startsWith('4') || found.mode === '40000' || found.mode === '040000';
      if (isDir) {
        currentTreeId = found.oid;
      } else {
        return null;
      }
    }
  }
  return null;
}

export function setPathInTree(repo: GitRepo, treeId: string | undefined, segments: string[], mode: string, blobId: string): string {
  const seg = segments[0];
  const entries = treeId ? parseTree(repo.objects.get(treeId)!.data) : [];

  if (segments.length === 1) {
    const existingIdx = entries.findIndex(e => e.name === seg);
    const newEntry: TreeEntry = { mode, name: seg, oid: blobId };
    if (existingIdx >= 0) {
      entries[existingIdx] = newEntry;
    } else {
      entries.push(newEntry);
    }
  } else {
    const existingIdx = entries.findIndex(e => e.name === seg);
    let subTreeId: string | undefined;
    if (existingIdx >= 0) {
      subTreeId = entries[existingIdx].oid;
    }
    const newSubTreeId = setPathInTree(repo, subTreeId, segments.slice(1), mode, blobId);
    const subEntry: TreeEntry = { mode: '40000', name: seg, oid: newSubTreeId };
    if (existingIdx >= 0) {
      entries[existingIdx] = subEntry;
    } else {
      entries.push(subEntry);
    }
  }

  const newTreeBuf = buildTree(entries);
  return storeObject(repo, 'tree', newTreeBuf);
}

export function removePathFromTree(repo: GitRepo, treeId: string, segments: string[]): string | null {
  const seg = segments[0];
  const obj = repo.objects.get(treeId);
  if (!obj || obj.type !== 'tree') return treeId;
  const entries = parseTree(obj.data);
  const existingIdx = entries.findIndex(e => e.name === seg);
  if (existingIdx < 0) return treeId;

  if (segments.length === 1) {
    entries.splice(existingIdx, 1);
  } else {
    const subEntry = entries[existingIdx];
    const newSubTreeId = removePathFromTree(repo, subEntry.oid, segments.slice(1));
    if (!newSubTreeId) {
      entries.splice(existingIdx, 1);
    } else {
      entries[existingIdx] = { ...subEntry, oid: newSubTreeId };
    }
  }

  if (entries.length === 0) {
    return null;
  }
  const newTreeBuf = buildTree(entries);
  return storeObject(repo, 'tree', newTreeBuf);
}

// Packet Framing
export function decodePktLines(buf: Buffer): { packets: PktPacket[]; rest: Buffer } {
  const packets: PktPacket[] = [];
  let offset = 0;

  while (offset + 4 <= buf.length) {
    const headerStr = buf.toString('utf-8', offset, offset + 4);
    if (headerStr === '0000') {
      packets.push({ type: 'flush' });
      offset += 4;
      continue;
    }
    if (headerStr === '0001') {
      packets.push({ type: 'delim' });
      offset += 4;
      continue;
    }
    if (headerStr === '0002') {
      packets.push({ type: 'response-end' });
      offset += 4;
      continue;
    }

    const len = parseInt(headerStr, 16);
    if (isNaN(len) || len < 4) {
      break;
    }
    if (offset + len > buf.length) {
      break;
    }
    const payload = buf.subarray(offset + 4, offset + len);
    packets.push({ type: 'data', data: payload });
    offset += len;
  }

  return { packets, rest: buf.subarray(offset) };
}

export function encodePktLine(data: Buffer | string): Buffer {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;
  const len = buf.length + 4;
  const hex = len.toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(hex, 'utf-8'), buf]);
}

export function encodeFlush(): Buffer {
  return Buffer.from('0000', 'utf-8');
}

export function encodeDelim(): Buffer {
  return Buffer.from('0001', 'utf-8');
}

export function encodeResponseEnd(): Buffer {
  return Buffer.from('0002', 'utf-8');
}

// Packfile Reading & Writing
function findZlibLength(buf: Buffer): number {
  let low = 1;
  let high = buf.length;
  let best = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    try {
      inflateSync(buf.subarray(0, mid));
      best = mid;
      high = mid - 1;
    } catch (e) {
      low = mid + 1;
    }
  }
  return best;
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  let sourceSize = 0;
  let shift = 0;
  while (offset < delta.length) {
    const b = delta[offset++];
    sourceSize |= (b & 0x7f) << shift;
    shift += 7;
    if ((b & 0x80) === 0) break;
  }
  if (base.length !== sourceSize) {
    throw new Error(`Delta base size mismatch: expected ${sourceSize}, got ${base.length}`);
  }

  let targetSize = 0;
  shift = 0;
  while (offset < delta.length) {
    const b = delta[offset++];
    targetSize |= (b & 0x7f) << shift;
    shift += 7;
    if ((b & 0x80) === 0) break;
  }

  const out = Buffer.alloc(targetSize);
  let written = 0;

  while (offset < delta.length) {
    const op = delta[offset++];
    if ((op & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      if ((op & 0x01) !== 0) copyOffset = delta[offset++];
      if ((op & 0x02) !== 0) copyOffset |= delta[offset++] << 8;
      if ((op & 0x04) !== 0) copyOffset |= delta[offset++] << 16;
      if ((op & 0x08) !== 0) copyOffset |= delta[offset++] << 24;

      if ((op & 0x10) !== 0) copySize = delta[offset++];
      if ((op & 0x20) !== 0) copySize |= delta[offset++] << 8;
      if ((op & 0x40) !== 0) copySize |= delta[offset++] << 16;
      if (copySize === 0) copySize = 65536;

      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('Invalid delta opcode 0');
    }
  }

  if (written !== targetSize) {
    throw new Error(`Delta target size mismatch: written ${written}, expected ${targetSize}`);
  }
  return out;
}

export function readPackfile(packBuf: Buffer): { objects: Map<string, { type: string; data: Buffer }>; deltaCount: number } {
  if (packBuf.length < 32) throw new Error('Packfile too short');
  if (packBuf.toString('utf-8', 0, 4) !== 'PACK') throw new Error('Invalid pack header');
  const version = packBuf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`Unsupported pack version: ${version}`);
  const numObjects = packBuf.readUInt32BE(8);

  const trailerOffset = packBuf.length - 20;
  const expectedSha = packBuf.subarray(trailerOffset).toString('hex');
  const actualSha = createHash('sha1').update(packBuf.subarray(0, trailerOffset)).digest('hex');
  if (expectedSha !== actualSha) throw new Error('Packfile checksum mismatch');

  let offset = 12;
  const entries: Array<{
    entryOffset: number;
    typeNum: number;
    baseOffset?: number;
    baseOid?: string;
    compressedData: Buffer;
    inflatedData?: Buffer;
  }> = [];

  for (let i = 0; i < numObjects; i++) {
    const entryOffset = offset;
    if (offset >= trailerOffset) break;

    let b = packBuf[offset++];
    const typeNum = (b >> 4) & 7;
    let size = b & 15;
    let shift = 4;
    while ((b & 0x80) !== 0) {
      if (offset >= trailerOffset) break;
      b = packBuf[offset++];
      size |= (b & 0x7f) << shift;
      shift += 7;
    }

    let baseOffset: number | undefined;
    let baseOid: string | undefined;

    if (typeNum === 6) {
      let c = packBuf[offset++];
      let val = c & 0x7f;
      while ((c & 0x80) !== 0) {
        val = (val + 1) << 7;
        c = packBuf[offset++];
        val += c & 0x7f;
      }
      baseOffset = entryOffset - val;
    } else if (typeNum === 7) {
      baseOid = packBuf.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }

    const compressedSlice = packBuf.subarray(offset, trailerOffset);
    const zlibLen = findZlibLength(compressedSlice);
    if (zlibLen < 0) throw new Error('Failed to find zlib stream length');
    const compressedData = compressedSlice.subarray(0, zlibLen);
    offset += zlibLen;

    const inflatedData = inflateSync(compressedData);
    if (inflatedData.length !== size) {
      throw new Error(`Inflated size mismatch: expected ${size}, got ${inflatedData.length}`);
    }

    entries.push({ entryOffset, typeNum, baseOffset, baseOid, compressedData, inflatedData });
  }

  const resolvedObjects = new Map<string, { type: string; data: Buffer }>();
  const offsetToId = new Map<number, string>();
  let deltaCount = 0;

  for (const entry of entries) {
    if (entry.typeNum >= 1 && entry.typeNum <= 4) {
      const typeName = ['_', 'commit', 'tree', 'blob', 'tag'][entry.typeNum];
      const id = computeObjectId(typeName, entry.inflatedData!);
      resolvedObjects.set(id, { type: typeName, data: entry.inflatedData! });
      offsetToId.set(entry.entryOffset, id);
    }
  }

  const unresolved = [...entries.filter(e => e.typeNum === 6 || e.typeNum === 7)];

  while (unresolved.length > 0) {
    let progress = false;
    for (let i = unresolved.length - 1; i >= 0; i--) {
      const entry = unresolved[i];
      let baseData: Buffer | null = null;

      if (entry.typeNum === 6 && entry.baseOffset !== undefined) {
        const baseId = offsetToId.get(entry.baseOffset);
        if (baseId && resolvedObjects.has(baseId)) {
          baseData = resolvedObjects.get(baseId)!.data;
        }
      } else if (entry.typeNum === 7 && entry.baseOid) {
        if (resolvedObjects.has(entry.baseOid)) {
          baseData = resolvedObjects.get(entry.baseOid)!.data;
        }
      }

      if (baseData) {
        const fullData = applyDelta(baseData, entry.inflatedData!);
        let baseType = '';
        if (entry.typeNum === 6 && entry.baseOffset !== undefined) {
          const baseId = offsetToId.get(entry.baseOffset)!;
          baseType = resolvedObjects.get(baseId)!.type;
        } else if (entry.typeNum === 7 && entry.baseOid) {
          baseType = resolvedObjects.get(entry.baseOid)!.type;
        }

        const id = computeObjectId(baseType, fullData);
        resolvedObjects.set(id, { type: baseType, data: fullData });
        offsetToId.set(entry.entryOffset, id);
        deltaCount++;
        unresolved.splice(i, 1);
        progress = true;
      }
    }
    if (!progress && unresolved.length > 0) {
      throw new Error('Could not resolve all packfile deltas (circular or missing base)');
    }
  }

  return { objects: resolvedObjects, deltaCount };
}

export function writePackfile(objects: Map<string, { type: string; data: Buffer }>): Buffer {
  const sortedIds = [...objects.keys()].sort();
  const sortedObjs = sortedIds.map(id => objects.get(id)!);

  const chunks: Buffer[] = [];
  chunks.push(Buffer.from('PACK', 'utf-8'));
  const verBuf = Buffer.alloc(4);
  verBuf.writeUInt32BE(2, 0);
  chunks.push(verBuf);

  const countBuf = Buffer.alloc(4);
  countBuf.writeUInt32BE(sortedObjs.length, 0);
  chunks.push(countBuf);

  for (let i = 0; i < sortedObjs.length; i++) {
    const obj = sortedObjs[i];
    const typeNum = obj.type === 'commit' ? 1 : obj.type === 'tree' ? 2 : obj.type === 'blob' ? 3 : 4;
    const deflated = deflateSync(obj.data, { level: 1 });

    let size = obj.data.length;
    let b = (typeNum << 4) | (size & 15);
    size >>= 4;
    const headerBytes: number[] = [];
    if (size > 0) {
      b |= 0x80;
      headerBytes.push(b);
      while (size > 0) {
        let nextB = size & 0x7f;
        size >>= 7;
        if (size > 0) nextB |= 0x80;
        headerBytes.push(nextB);
      }
    } else {
      headerBytes.push(b);
    }
    chunks.push(Buffer.from(headerBytes));
    chunks.push(deflated);
  }

  const preTrailer = Buffer.concat(chunks);
  const trailer = createHash('sha1').update(preTrailer).digest();
  return Buffer.concat([preTrailer, trailer]);
}

// Contents Helpers
const FIXED_AUTHOR = 'Ada Iversen <ada@example.com> 1770000000 +0000';
const FIXED_COMMITTER = 'Ada Iversen <ada@example.com> 1770000000 +0000';

export function commitFile(
  repo: GitRepo,
  branchName: string | undefined,
  path: string,
  contentBytes: Buffer,
  message: string,
  expectedBlobId?: string
): { blobId: string; commitId: string } {
  const branch = branchName || repo.default_branch || 'main';
  const refKey = `refs/heads/${branch}`;
  const currentTip = repo.refs.get(refKey) || repo.refs.get(branch) || repo.refs.get(`refs/heads/${branch}`);

  let currentTreeId: string | undefined;
  if (currentTip) {
    const tipObj = repo.objects.get(currentTip);
    if (tipObj && tipObj.type === 'commit') {
      const commit = parseCommit(tipObj.data);
      currentTreeId = commit.tree;
    }
  }

  if (expectedBlobId) {
    const existingEntry = currentTreeId ? walkTreePath(repo, currentTreeId, path) : null;
    const existingBlobId = existingEntry ? existingEntry.oid : undefined;
    if (existingBlobId !== expectedBlobId) {
      throw new Error('Conflict: expected blob id does not match current blob at path');
    }
  }

  const blobId = storeObject(repo, 'blob', contentBytes);
  const segments = path.split('/').filter(Boolean);
  const newTreeId = setPathInTree(repo, currentTreeId, segments, '100644', blobId);

  const parents = currentTip ? [currentTip] : [];
  const commitObj: CommitObject = {
    tree: newTreeId,
    parents,
    author: FIXED_AUTHOR,
    committer: FIXED_COMMITTER,
    message,
  };
  const commitBuf = buildCommit(commitObj);
  const commitId = storeObject(repo, 'commit', commitBuf);

  repo.refs.set(refKey, commitId);
  repo.generation++;
  clearPackCache(repo);

  return { blobId, commitId };
}

export function deleteFile(
  repo: GitRepo,
  branchName: string | undefined,
  path: string,
  message: string
): string {
  const branch = branchName || repo.default_branch || 'main';
  const refKey = `refs/heads/${branch}`;
  const currentTip = repo.refs.get(refKey) || repo.refs.get(branch) || repo.refs.get(`refs/heads/${branch}`);

  if (!currentTip) {
    throw new Error('Missing tip for branch');
  }

  const tipObj = repo.objects.get(currentTip);
  if (!tipObj || tipObj.type !== 'commit') {
    throw new Error('Invalid commit tip');
  }

  const commit = parseCommit(tipObj.data);
  const segments = path.split('/').filter(Boolean);
  const newTreeId = removePathFromTree(repo, commit.tree, segments);
  if (newTreeId === commit.tree) {
    throw new Error('Path not found');
  }

  const finalTreeId = newTreeId || storeObject(repo, 'tree', Buffer.alloc(0));
  const commitObj: CommitObject = {
    tree: finalTreeId,
    parents: [currentTip],
    author: FIXED_AUTHOR,
    committer: FIXED_COMMITTER,
    message,
  };
  const commitBuf = buildCommit(commitObj);
  const commitId = storeObject(repo, 'commit', commitBuf);

  repo.refs.set(refKey, commitId);
  repo.generation++;
  clearPackCache(repo);

  return commitId;
}

export function readFileAtRef(
  repo: GitRepo,
  ref: string | undefined,
  path: string
): { type: 'file'; id: string; size: number; data: Buffer } | { type: 'dir'; entries: Array<{ name: string; fullPath: string; type: 'file' | 'dir'; id: string }> } {
  const refName = ref || repo.default_branch || 'main';
  const commitId = resolveRef(repo, refName) || refName;

  const commitObj = repo.objects.get(commitId);
  if (!commitObj || commitObj.type !== 'commit') {
    throw new Error('Ref or commit not found');
  }

  const commit = parseCommit(commitObj.data);
  if (!path || path === '/' || path === '.') {
    const treeObj = repo.objects.get(commit.tree);
    if (!treeObj || treeObj.type !== 'tree') {
      throw new Error('Root tree not found');
    }
    const treeEntries = parseTree(treeObj.data);
    const entries = treeEntries.map(e => {
      const isDir = e.mode.startsWith('4') || e.mode === '40000' || e.mode === '040000';
      return {
        name: e.name,
        fullPath: e.name,
        type: (isDir ? 'dir' : 'file') as 'file' | 'dir',
        id: e.oid,
      };
    });
    return { type: 'dir', entries };
  }

  const entry = walkTreePath(repo, commit.tree, path);
  if (!entry) {
    throw new Error('Path not found');
  }

  const isDir = entry.mode.startsWith('4') || entry.mode === '40000' || entry.mode === '040000';
  if (isDir) {
    const subTreeObj = repo.objects.get(entry.oid);
    if (!subTreeObj || subTreeObj.type !== 'tree') {
      throw new Error('Subtree not found');
    }
    const treeEntries = parseTree(subTreeObj.data);
    const cleanPath = path.replace(/\/+$/, '');
    const entries = treeEntries.map(e => {
      const subIsDir = e.mode.startsWith('4') || e.mode === '40000' || e.mode === '040000';
      return {
        name: e.name,
        fullPath: `${cleanPath}/${e.name}`,
        type: (subIsDir ? 'dir' : 'file') as 'file' | 'dir',
        id: e.oid,
      };
    });
    return { type: 'dir', entries };
  } else {
    const blobObj = repo.objects.get(entry.oid);
    if (!blobObj || blobObj.type !== 'blob') {
      throw new Error('Blob not found');
    }
    return {
      type: 'file',
      id: entry.oid,
      size: blobObj.data.length,
      data: blobObj.data,
    };
  }
}

// ---------------------------------------------------------
// EXPORTED REUSABLE HELPERS FOR PULLS, TREES & DIFFS
// ---------------------------------------------------------

export function resolveRef(repo: GitRepo, refName: string): string | undefined {
  if (repo.refs.has(refName)) return repo.refs.get(refName);
  if (repo.refs.has(`refs/heads/${refName}`)) return repo.refs.get(`refs/heads/${refName}`);
  if (repo.refs.has(`refs/tags/${refName}`)) return repo.refs.get(`refs/tags/${refName}`);
  if (repo.objects.has(refName)) return refName;
  return undefined;
}

export function flattenTree(repo: GitRepo, treeId: string, prefix = ''): Map<string, { mode: string; oid: string }> {
  const map = new Map<string, { mode: string; oid: string }>();
  if (!treeId) return map;
  const obj = repo.objects.get(treeId);
  if (!obj || obj.type !== 'tree') return map;
  const entries = parseTree(obj.data);
  for (const e of entries) {
    const fullPath = prefix ? `${prefix}/${e.name}` : e.name;
    const isDir = e.mode.startsWith('4') || e.mode === '40000' || e.mode === '040000';
    if (isDir) {
      const subMap = flattenTree(repo, e.oid, fullPath);
      for (const [k, v] of subMap.entries()) {
        map.set(k, v);
      }
    } else {
      map.set(fullPath, { mode: e.mode, oid: e.oid });
    }
  }
  return map;
}

export function computeLineDiff(oldData: Buffer | undefined, newData: Buffer | undefined): { additions: number; deletions: number; changes: number } {
  const oldLines = oldData && oldData.length > 0 ? oldData.toString('utf-8').split(/\r?\n/) : [];
  const newLines = newData && newData.length > 0 ? newData.toString('utf-8').split(/\r?\n/) : [];

  if (!oldData || oldData.length === 0) {
    const additions = newLines.length;
    return { additions, deletions: 0, changes: additions };
  }
  if (!newData || newData.length === 0) {
    const deletions = oldLines.length;
    return { additions: 0, deletions, changes: deletions };
  }

  const m = oldLines.length;
  const n = newLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }
  const lcs = dp[m][n];
  const additions = n - lcs;
  const deletions = m - lcs;
  return { additions, deletions, changes: additions + deletions };
}

export function findMergeBase(repo: GitRepo, commitA: string, commitB: string): string | null {
  if (!commitA || !commitB) return null;
  const ancestorsA = new Set<string>();
  const queueA = [commitA];
  while (queueA.length > 0) {
    const id = queueA.pop()!;
    if (ancestorsA.has(id)) continue;
    ancestorsA.add(id);
    const obj = repo.objects.get(id);
    if (obj && obj.type === 'commit') {
      const c = parseCommit(obj.data);
      for (const p of c.parents) {
        if (p && !ancestorsA.has(p)) queueA.push(p);
      }
    }
  }

  const visitedB = new Set<string>();
  const queueB = [commitB];
  while (queueB.length > 0) {
    const id = queueB.shift()!;
    if (ancestorsA.has(id)) return id;
    if (visitedB.has(id)) continue;
    visitedB.add(id);
    const obj = repo.objects.get(id);
    if (obj && obj.type === 'commit') {
      const c = parseCommit(obj.data);
      for (const p of c.parents) {
        if (p && !visitedB.has(p)) queueB.push(p);
      }
    }
  }
  return null;
}

export function getPullFilesDiff(repo: GitRepo, baseTipCommit: string, headTipCommit: string): Array<{ filename: string; status: 'added' | 'modified' | 'removed'; additions: number; deletions: number; changes: number }> {
  const baseCommitObj = repo.objects.get(baseTipCommit);
  const headCommitObj = repo.objects.get(headTipCommit);
  if (!baseCommitObj || !headCommitObj) return [];

  const baseCommit = parseCommit(baseCommitObj.data);
  const headCommit = parseCommit(headCommitObj.data);

  const baseMap = flattenTree(repo, baseCommit.tree);
  const headMap = flattenTree(repo, headCommit.tree);

  const allPaths = new Set([...baseMap.keys(), ...headMap.keys()]);
  const results: Array<{ filename: string; status: 'added' | 'modified' | 'removed'; additions: number; deletions: number; changes: number }> = [];

  const sortedPaths = [...allPaths].sort();
  for (const path of sortedPaths) {
    const baseEntry = baseMap.get(path);
    const headEntry = headMap.get(path);

    if (!baseEntry && headEntry) {
      const blobObj = repo.objects.get(headEntry.oid);
      const diff = computeLineDiff(undefined, blobObj?.data);
      results.push({ filename: path, status: 'added', ...diff });
    } else if (baseEntry && !headEntry) {
      const blobObj = repo.objects.get(baseEntry.oid);
      const diff = computeLineDiff(blobObj?.data, undefined);
      results.push({ filename: path, status: 'removed', ...diff });
    } else if (baseEntry && headEntry) {
      if (baseEntry.oid !== headEntry.oid) {
        const baseBlob = repo.objects.get(baseEntry.oid)?.data;
        const headBlob = repo.objects.get(headEntry.oid)?.data;
        const diff = computeLineDiff(baseBlob, headBlob);
        results.push({ filename: path, status: 'modified', ...diff });
      }
    }
  }
  return results;
}

export function checkPullConflicts(repo: GitRepo, baseTipCommit: string, headTipCommit: string, mergeBaseCommit: string): boolean {
  const mbCommitObj = repo.objects.get(mergeBaseCommit);
  const baseCommitObj = repo.objects.get(baseTipCommit);
  const headCommitObj = repo.objects.get(headTipCommit);
  if (!mbCommitObj || !baseCommitObj || !headCommitObj) return false;

  const mbTree = parseCommit(mbCommitObj.data).tree;
  const baseTree = parseCommit(baseCommitObj.data).tree;
  const headTree = parseCommit(headCommitObj.data).tree;

  const mbMap = flattenTree(repo, mbTree);
  const baseMap = flattenTree(repo, baseTree);
  const headMap = flattenTree(repo, headTree);

  const headChanges = new Set<string>();
  const allHeadPaths = new Set([...mbMap.keys(), ...headMap.keys()]);
  for (const path of allHeadPaths) {
    const mbE = mbMap.get(path);
    const headE = headMap.get(path);
    if (!mbE && headE) {
      headChanges.add(path);
    } else if (mbE && !headE) {
      headChanges.add(path);
    } else if (mbE && headE && mbE.oid !== headE.oid) {
      headChanges.add(path);
    }
  }

  for (const path of headChanges) {
    const mbE = mbMap.get(path);
    const baseE = baseMap.get(path);
    const mbOid = mbE ? mbE.oid : undefined;
    const baseOid = baseE ? baseE.oid : undefined;
    if (mbOid !== baseOid) {
      return true;
    }
  }
  return false;
}

export function squashMergeCommit(
  repo: GitRepo,
  baseRef: string,
  headTipCommit: string,
  baseTipCommit: string,
  mergeBaseCommit: string,
  message: string
): { sha: string; message: string } {
  const baseCommitObj = repo.objects.get(baseTipCommit);
  const headCommitObj = repo.objects.get(headTipCommit);
  const mbCommitObj = repo.objects.get(mergeBaseCommit);
  if (!baseCommitObj || !headCommitObj || !mbCommitObj) {
    throw new Error('Commits not found for squash merge');
  }

  const baseTreeId = parseCommit(baseCommitObj.data).tree;
  const headTreeId = parseCommit(headCommitObj.data).tree;
  const mbTreeId = parseCommit(mbCommitObj.data).tree;

  const mbMap = flattenTree(repo, mbTreeId);
  const headMap = flattenTree(repo, headTreeId);

  const allPaths = new Set([...mbMap.keys(), ...headMap.keys()]);
  let currentTreeId = baseTreeId;

  for (const path of allPaths) {
    const mbE = mbMap.get(path);
    const headE = headMap.get(path);
    const segments = path.split('/').filter(Boolean);

    if (mbE && !headE) {
      const res = removePathFromTree(repo, currentTreeId, segments);
      currentTreeId = res || storeObject(repo, 'tree', Buffer.alloc(0));
    } else if ((!mbE && headE) || (mbE && headE && mbE.oid !== headE.oid)) {
      currentTreeId = setPathInTree(repo, currentTreeId, segments, headE.mode, headE.oid);
    }
  }

  const commitObj: CommitObject = {
    tree: currentTreeId,
    parents: [baseTipCommit],
    author: FIXED_AUTHOR,
    committer: FIXED_COMMITTER,
    message,
  };
  const commitBuf = buildCommit(commitObj);
  const commitId = storeObject(repo, 'commit', commitBuf);

  repo.refs.set(baseRef, commitId);
  repo.generation++;
  clearPackCache(repo);

  return { sha: commitId, message: 'Pull request successfully merged' };
}

// ---------------------------------------------------------
// SMART-HTTP HANDLERS & PACK CACHE
// ---------------------------------------------------------

export interface HandlerResult {
  status: number;
  contentType: string;
  body: Buffer;
}

interface CacheEntry {
  generation: number;
  packBytes: Buffer;
}

const packCacheMap = new WeakMap<GitRepo, Map<string, CacheEntry>>();
const inFlightMap = new WeakMap<GitRepo, Map<string, Promise<Buffer>>>();

function getRepoCache(repo: GitRepo) {
  let m = packCacheMap.get(repo);
  if (!m) {
    m = new Map();
    packCacheMap.set(repo, m);
  }
  return m;
}

function getRepoInFlight(repo: GitRepo) {
  let m = inFlightMap.get(repo);
  if (!m) {
    m = new Map();
    inFlightMap.set(repo, m);
  }
  return m;
}

function clearPackCache(repo: GitRepo) {
  const m = packCacheMap.get(repo);
  if (m) m.clear();
  const inf = inFlightMap.get(repo);
  if (inf) inf.clear();
}

// 1. INFO/REFS
export function handleInfoRefs(repo: GitRepo, service: string, protocolVersion2: boolean, body: Buffer): HandlerResult {
  try {
    const contentType = `application/x-${service}-advertisement`;
    const preamble = `# service=${service}\n`;
    const chunks: Buffer[] = [];
    chunks.push(encodePktLine(preamble));
    chunks.push(encodeFlush());

    const defaultBranch = repo.default_branch || 'main';
    const headTip = resolveRef(repo, defaultBranch) || resolveRef(repo, 'HEAD') || '0000000000000000000000000000000000000000';

    if (service === 'git-upload-pack' && protocolVersion2) {
      chunks.push(encodePktLine('version 2\n'));
      chunks.push(encodePktLine('agent=git/makefun\n'));
      chunks.push(encodePktLine('ls-refs\n'));
      chunks.push(encodePktLine('fetch=shallow\n'));
      chunks.push(encodePktLine('server-option\n'));
      chunks.push(encodePktLine('object-format=sha1\n'));
      chunks.push(encodeFlush());
    } else {
      const capsUpload = 'side-band-64k multi_ack ofs-delta shallow symref=HEAD:refs/heads/' + defaultBranch + ' agent=git/makefun';
      const capsReceive = 'report-status side-band-64k delete-refs agent=git/makefun';
      const caps = service === 'git-upload-pack' ? capsUpload : capsReceive;

      const refEntries: Array<{ name: string; oid: string }> = [];
      let hasRefs = false;
      for (const [refName, oid] of repo.refs.entries()) {
        if (refName.startsWith('refs/')) {
          hasRefs = refEntries.some(e => e.name === refName) ? false : true;
          refEntries.push({ name: refName, oid });
        }
      }

      if (headTip !== '0000000000000000000000000000000000000000') {
        refEntries.unshift({ name: 'HEAD', oid: headTip });
      }

      if (refEntries.length === 0) {
        const line = `0000000000000000000000000000000000000000 capabilities^{}\0${caps}\n`;
        chunks.push(encodePktLine(line));
      } else {
        for (let i = 0; i < refEntries.length; i++) {
          const e = refEntries[i];
          let lineStr = `${e.oid} ${e.name}`;
          if (i === 0) {
            lineStr += `\0${caps}`;
          }
          lineStr += '\n';
          chunks.push(encodePktLine(lineStr));

          const obj = repo.objects.get(e.oid);
          if (obj && obj.type === 'tag') {
            const tagObj = parseTag(obj.data);
            if (tagObj.object) {
              chunks.push(encodePktLine(`${tagObj.object} ${e.name}^{}\n`));
            }
          }
        }
      }
      chunks.push(encodeFlush());
    }

    return { status: 200, contentType, body: Buffer.concat(chunks) };
  } catch (e) {
    return { status: 400, contentType: 'text/plain', body: Buffer.alloc(0) };
  }
}

// 2. LS-REFS (v2)
export function handleLsRefs(repo: GitRepo, body: Buffer): HandlerResult {
  try {
    const { packets } = decodePktLines(body);
    const prefixes: string[] = [];
    let peel = false;
    let symrefs = false;

    let inArgs = false;
    for (const pkt of packets) {
      if (pkt.type === 'delim') {
        inArgs = true;
        continue;
      }
      if (pkt.type === 'data' && pkt.data) {
        const line = pkt.data.toString('utf-8').trim();
        if (inArgs) {
          if (line.startsWith('ref-prefix ')) {
            prefixes.push(line.slice(11).trim());
          } else if (line === 'peel') {
            peel = true;
          } else if (line === 'symrefs') {
            symrefs = true;
          }
        }
      }
    }

    const defaultBranch = repo.default_branch || 'main';
    const headTip = resolveRef(repo, defaultBranch) || resolveRef(repo, 'HEAD');

    const allRefs: Array<{ name: string; oid: string }> = [];
    if (headTip) {
      allRefs.push({ name: 'HEAD', oid: headTip });
    }
    for (const [refName, oid] of repo.refs.entries()) {
      if (!allRefs.some(r => r.name === refName)) {
        allRefs.push({ name: refName, oid });
      }
    }

    const chunks: Buffer[] = [];
    const includeHead = prefixes.length === 0 || prefixes.some(p => 'HEAD'.startsWith(p));

    for (const r of allRefs) {
      if (r.name === 'HEAD') {
        if (!includeHead) continue;
      } else {
        if (prefixes.length > 0 && !prefixes.some(p => r.name.startsWith(p))) {
          continue;
        }
      }

      let line = `${r.oid} ${r.name}`;
      if (symrefs && r.name === 'HEAD') {
        line += ` symref-target:refs/heads/${defaultBranch}`;
      }
      if (peel) {
        const obj = repo.objects.get(r.oid);
        if (obj && obj.type === 'tag') {
          const t = parseTag(obj.data);
          if (t.object) {
            line += ` peeled:${t.object}`;
          }
        }
      }
      line += '\n';
      chunks.push(encodePktLine(line));
    }
    chunks.push(encodeFlush());

    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(chunks) };
  } catch (e) {
    return { status: 400, contentType: 'text/plain', body: Buffer.alloc(0) };
  }
}

// 3. FETCH (v2)
export function handleFetch(repo: GitRepo, body: Buffer): HandlerResult {
  try {
    const { packets } = decodePktLines(body);
    const wants: string[] = [];
    const haves: string[] = [];
    const shallows: string[] = [];
    let depth = 0;

    let inArgs = false;
    for (const pkt of packets) {
      if (pkt.type === 'delim') {
        inArgs = true;
        continue;
      }
      if (pkt.type === 'data' && pkt.data) {
        const line = pkt.data.toString('utf-8').trim();
        if (inArgs) {
          if (line.startsWith('want ')) {
            wants.push(line.slice(5).trim());
          } else if (line.startsWith('have ')) {
            haves.push(line.slice(5).trim());
          } else if (line.startsWith('deepen ')) {
            depth = parseInt(line.slice(7).trim(), 10) || 0;
          } else if (line.startsWith('shallow ')) {
            shallows.push(line.slice(8).trim());
          }
        }
      }
    }

    const sortedWants = [...wants].sort();
    const sortedHaves = [...haves].sort();
    const sortedShallows = [...shallows].sort();
    const cacheKey = `fetch:${sortedWants.join(',')}:${sortedHaves.join(',')}:${depth}:${sortedShallows.join(',')}`;
    const cache = getRepoCache(repo);
    const cached = cache.get(cacheKey);
    if (cached && cached.generation === repo.generation) {
      return { status: 200, contentType: 'application/x-git-upload-pack-result', body: cached.packBytes };
    }

    const packBytes = computeFetchPack(repo, sortedWants, sortedHaves, depth, sortedShallows);
    cache.set(cacheKey, { generation: repo.generation, packBytes });

    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: packBytes };
  } catch (e) {
    return { status: 400, contentType: 'text/plain', body: Buffer.alloc(0) };
  }
}

function getTreeReachableObjects(repo: GitRepo, rootTreeId: string): Set<string> {
  const visited = new Set<string>();
  const queue = [rootTreeId];
  while (queue.length > 0) {
    const id = queue.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const obj = repo.objects.get(id);
    if (!obj) continue;
    if (obj.type === 'tree') {
      const entries = parseTree(obj.data);
      for (const e of entries) {
        if (e.mode === '160000') continue;
        if (e.oid && !visited.has(e.oid)) queue.push(e.oid);
      }
    }
  }
  return visited;
}

function computeFetchPack(repo: GitRepo, wants: string[], haves: string[], depth: number, shallows: string[]): Buffer {
  const wantObjs = getReachableObjects(repo, wants);
  const haveObjs = haves.length > 0 ? getReachableObjects(repo, haves) : new Set<string>();

  const sendIds = new Set<string>();
  const commitIdsToKeep = new Set<string>();
  const newShallowCommits: string[] = [];
  const unshallowCommits: string[] = [];

  if (depth === 0) {
    for (const id of wantObjs) {
      if (!haveObjs.has(id)) {
        sendIds.add(id);
      }
    }
  } else {
    const shallowHaveObjs = new Set<string>();
    for (const h of haves) {
      shallowHaveObjs.add(h);
      const hObj = repo.objects.get(h);
      if (hObj && hObj.type === 'commit') {
        const c = parseCommit(hObj.data);
        if (c.tree) {
          for (const tid of getTreeReachableObjects(repo, c.tree)) {
            shallowHaveObjs.add(tid);
          }
        }
      }
    }

    const queue: Array<{ id: string; dist: number }> = wants.map(w => ({ id: w, dist: 1 }));
    while (queue.length > 0) {
      const { id, dist } = queue.pop()!;
      if (dist > depth) continue;
      if (commitIdsToKeep.has(id)) continue;
      const obj = repo.objects.get(id);
      if (!obj) continue;
      if (obj.type === 'commit') {
        commitIdsToKeep.add(id);
        const c = parseCommit(obj.data);
        for (const p of c.parents) {
          queue.push({ id: p, dist: dist + 1 });
        }
      }
    }

    for (const commitId of commitIdsToKeep) {
      if (!shallowHaveObjs.has(commitId)) {
        sendIds.add(commitId);
      }
      const commitObj = repo.objects.get(commitId);
      if (commitObj && commitObj.type === 'commit') {
        const c = parseCommit(commitObj.data);
        if (c.tree) {
          const treeReachable = getTreeReachableObjects(repo, c.tree);
          for (const tid of treeReachable) {
            if (!shallowHaveObjs.has(tid)) {
              sendIds.add(tid);
            }
          }
        }
      }
    }

    for (const commitId of commitIdsToKeep) {
      const commitObj = repo.objects.get(commitId);
      if (commitObj && commitObj.type === 'commit') {
        const c = parseCommit(commitObj.data);
        if (c.parents.length > 0) {
          const hasUnkeptParent = c.parents.some(p => !commitIdsToKeep.has(p));
          if (hasUnkeptParent) {
            newShallowCommits.push(commitId);
          }
        }

        if (shallows.includes(commitId)) {
          const allParentsKept = c.parents.length > 0 && c.parents.every(p => commitIdsToKeep.has(p));
          if (allParentsKept) {
            unshallowCommits.push(commitId);
          }
        }
      }
    }
  }

  const objectsToSend = new Map<string, { type: string; data: Buffer }>();
  for (const id of sendIds) {
    const obj = repo.objects.get(id);
    if (obj) {
      objectsToSend.set(id, obj);
    }
  }

  const packBuf = writePackfile(objectsToSend);

  const chunks: Buffer[] = [];
  chunks.push(encodePktLine('acknowledgments\n'));
  if (haves.length > 0) {
    let found = false;
    for (const h of haves) {
      if (wantObjs.has(h)) {
        chunks.push(encodePktLine(`ACK ${h}\n`));
        found = true;
        break;
      }
    }
    if (!found) {
      chunks.push(encodePktLine('NAK\n'));
    }
  } else {
    chunks.push(encodePktLine('NAK\n'));
  }
  chunks.push(encodeDelim());

  if (depth > 0 || shallows.length > 0) {
    chunks.push(encodePktLine('shallow-info\n'));
    for (const sc of newShallowCommits) {
      chunks.push(encodePktLine(`shallow ${sc}\n`));
    }
    for (const uc of unshallowCommits) {
      chunks.push(encodePktLine(`unshallow ${uc}\n`));
    }
    chunks.push(encodeDelim());
  }

  chunks.push(encodePktLine('packfile\n'));

  let offset = 0;
  const maxChunkSize = 65515;
  while (offset < packBuf.length) {
    const chunkSize = Math.min(maxChunkSize, packBuf.length - offset);
    const chunk = Buffer.alloc(1 + chunkSize);
    chunk[0] = 1;
    packBuf.copy(chunk, 1, offset, offset + chunkSize);
    chunks.push(encodePktLine(chunk));
    offset += chunkSize;
  }

  chunks.push(encodeFlush());
  return Buffer.concat(chunks);
}

// 4. RECEIVE-PACK (push)
export function handleReceivePack(repo: GitRepo, body: Buffer): HandlerResult {
  try {
    const { packets, rest } = decodePktLines(body);
    const commands: Array<{ oldOid: string; newOid: string; refName: string }> = [];
    let capabilities: string[] = [];

    for (let i = 0; i < packets.length; i++) {
      const pkt = packets[i];
      if (pkt.type === 'flush') break;
      if (pkt.type === 'data' && pkt.data) {
        let line = pkt.data.toString('utf-8').trim();
        if (i === 0) {
          const nullIdx = line.indexOf('\0');
          if (nullIdx !== -1) {
            capabilities = line.slice(nullIdx + 1).split(' ');
            line = line.slice(0, nullIdx);
          }
        }
        const parts = line.split(' ');
        if (parts.length >= 3) {
          commands.push({ oldOid: parts[0], newOid: parts[1], refName: parts[2] });
        }
      }
    }

    let packReadRes: { objects: Map<string, { type: string; data: Buffer }>; deltaCount: number } | null = null;
    let unpackError = '';

    if (rest.length > 0) {
      try {
        packReadRes = readPackfile(rest);
      } catch (e: any) {
        unpackError = e?.message || 'invalid packfile';
      }
    }

    const reportLines: string[] = [];
    if (unpackError) {
      reportLines.push(`unpack ${unpackError}\n`);
      for (const cmd of commands) {
        reportLines.push(`ng ${cmd.refName} unapplied due to unpack error\n`);
      }
    } else {
      reportLines.push('unpack ok\n');
      if (packReadRes) {
        for (const [id, obj] of packReadRes.objects.entries()) {
          repo.objects.set(id, obj);
        }
      }

      for (const cmd of commands) {
        const isZeroNew = cmd.newOid === '0000000000000000000000000000000000000000';
        const isZeroOld = cmd.oldOid === '0000000000000000000000000000000000000000';
        const currentOid = repo.refs.get(cmd.refName);

        if (isZeroOld) {
          if (currentOid) {
            reportLines.push(`ng ${cmd.refName} already exists\n`);
          } else {
            repo.refs.set(cmd.refName, cmd.newOid);
            reportLines.push(`ok ${cmd.refName}\n`);
          }
        } else if (isZeroNew) {
          if (!currentOid || currentOid !== cmd.oldOid) {
            reportLines.push(`ng ${cmd.refName} invalid old id\n`);
          } else {
            repo.refs.delete(cmd.refName);
            reportLines.push(`ok ${cmd.refName}\n`);
          }
        } else {
          if (!currentOid || currentOid !== cmd.oldOid) {
            reportLines.push(`ng ${cmd.refName} invalid old id\n`);
          } else {
            if (isDescendant(repo, cmd.newOid, cmd.oldOid)) {
              repo.refs.set(cmd.refName, cmd.newOid);
              reportLines.push(`ok ${cmd.refName}\n`);
            } else {
              reportLines.push(`ng ${cmd.refName} non-fast-forward\n`);
            }
          }
        }
      }
      repo.generation++;
      clearPackCache(repo);
    }

    const chunks: Buffer[] = [];
    for (const rLine of reportLines) {
      const pktBuf = encodePktLine(rLine);
      const bandBuf = Buffer.alloc(1 + pktBuf.length);
      bandBuf[0] = 1;
      pktBuf.copy(bandBuf, 1);
      chunks.push(encodePktLine(bandBuf));
    }
    chunks.push(encodeFlush());

    return { status: 200, contentType: 'application/x-git-receive-pack-result', body: Buffer.concat(chunks) };
  } catch (e) {
    return { status: 400, contentType: 'text/plain', body: Buffer.alloc(0) };
  }
}

function isDescendant(repo: GitRepo, descendantId: string, ancestorId: string): boolean {
  if (descendantId === ancestorId) return true;
  const visited = new Set<string>();
  const queue = [descendantId];

  while (queue.length > 0) {
    const id = queue.pop()!;
    if (id === ancestorId) return true;
    if (visited.has(id)) continue;
    visited.add(id);

    const obj = repo.objects.get(id);
    if (obj && obj.type === 'commit') {
      const c = parseCommit(obj.data);
      for (const p of c.parents) {
        if (!visited.has(p)) queue.push(p);
      }
    }
  }
  return false;
}
