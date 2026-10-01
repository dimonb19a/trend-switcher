// One execution owner per account and chain (R1-C / R1-14).
//
// Acquisition is atomic: the owner record is written to a private temporary
// file and hard-linked to the lock path. link(2) fails with EEXIST when the
// path exists, so two simultaneous starters can never both succeed, and a
// reader never sees a half-written record.
//
// Recovery of a stale lock (a recorded pid that is dead) is guarded by a
// second exclusive link, the CLAIM: only the starter holding the claim may
// unlink the dead record and link its own. While a record exists nobody can
// link over it, and without the claim nobody unlinks it, so the sequence
// "re-read dead → unlink → link" cannot displace a live owner. A claim that is
// found in place is never removed automatically (a recovery in flight, or a
// starter that crashed inside its millisecond-long recovery): the starter
// refuses and names the file, and the owner removes it by hand. Nothing here
// overwrites or renames anyone's record.
import { RecordableError } from './errors.mjs';
import { closeSync, linkSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const defaultFs = { closeSync, linkSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync };

export const claimPath = (path) => `${path}.recover`;

/** True when a process with this pid exists (EPERM means it exists but is not ours: still alive). */
export function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

const readRecord = (fsx, path) => { try { return JSON.parse(fsx.readFileSync(path, 'utf8')); } catch { return null; } };
const isLive = (record, self, isAlive) => Boolean(record) && Number.isInteger(record.pid) && record.pid !== self && isAlive(record.pid);
const unlinkQuiet = (fsx, path) => { try { fsx.unlinkSync(path); } catch { /* already gone */ } };

/**
 * Try to become the owner. Returns { ok: true }, or { ok: false, holder } when a live process holds
 * the lock, or { ok: false, reason } when the lock cannot be settled without the owner's hand.
 */
export function acquireLock({ path, owner, fsx = defaultFs, isAlive = processAlive, clock = () => Date.now() }) {
  if (!owner || !Number.isInteger(owner.pid)) throw new RecordableError('lock owner needs an integer pid');
  fsx.mkdirSync(dirname(path), { recursive: true });
  const claim = claimPath(path);
  const temp = `${path}.${owner.pid}.${clock()}.tmp`;
  const fd = fsx.openSync(temp, 'wx');
  fsx.writeSync(fd, JSON.stringify({ ...owner, since: new Date(clock()).toISOString() }));
  fsx.closeSync(fd);
  const link = (dst) => { try { fsx.linkSync(temp, dst); return true; } catch (error) { if (error.code === 'EEXIST') return false; throw error; } };
  try {
    if (link(path)) return { ok: true, path, owner };
    const holder = readRecord(fsx, path);
    if (isLive(holder, owner.pid, isAlive)) return { ok: false, holder };
    // the record is dead or unreadable: recover it under the claim
    if (!link(claim)) {
      const claimant = readRecord(fsx, claim);
      return { ok: false, holder: null, reason: `stale lock ${path} is being recovered (claim ${claim}${claimant?.pid ? ` by pid ${claimant.pid}` : ''}); if no such process runs, remove the claim file and start again` };
    }
    try {
      const again = readRecord(fsx, path);
      if (isLive(again, owner.pid, isAlive)) return { ok: false, holder: again };
      unlinkQuiet(fsx, path);
      if (link(path)) return { ok: true, path, owner, recovered: holder };
      const winner = readRecord(fsx, path);
      return { ok: false, holder: winner, reason: winner ? undefined : `lost the race for ${path}` };
    } finally { unlinkQuiet(fsx, claim); }
  } finally { unlinkQuiet(fsx, temp); }
}

/** Release only a lock we hold; someone else's record is left untouched. */
export function releaseLock({ path, pid, fsx = defaultFs }) {
  const holder = readRecord(fsx, path);
  if (holder && holder.pid === pid) unlinkQuiet(fsx, path);
}

/** The current holder record, or null. */
export function readLock({ path, fsx = defaultFs }) { return readRecord(fsx, path); }
