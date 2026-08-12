/**
 * Persistence for the user dictionary (dictionary.json next to config.json).
 * Privacy contract: the dictionary NEVER leaves the machine except as the per-request
 * <=40-word ASR keyword list and rewrite-stage corrections. Best-effort I/O — a read-only
 * disk degrades to an in-memory dictionary for the session.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { UserDictionary } from '../../client/src/models/UserDictionary';

export function dictionaryFilePath(userDataDir: string): string {
  return path.join(userDataDir, 'dictionary.json');
}

export function loadDictionary(userDataDir: string): UserDictionary {
  try {
    return new UserDictionary(JSON.parse(fs.readFileSync(dictionaryFilePath(userDataDir), 'utf8')));
  } catch {
    return new UserDictionary(); // Missing or corrupted file — the model sanitizes anyway.
  }
}

export function saveDictionary(userDataDir: string, dictionary: UserDictionary): void {
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(dictionaryFilePath(userDataDir), JSON.stringify(dictionary.toJSON(), null, 2) + '\n', 'utf8');
  } catch {
    /* Best effort — the in-memory dictionary still serves this session. */
  }
}
