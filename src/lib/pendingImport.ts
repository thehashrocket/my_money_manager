import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

const PENDING_DIR = path.join(process.cwd(), "data", ".pending-imports");
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type PendingImport = {
  id: string;
  accountId: number;
  filename: string;
  csv: string;
  uploadedAt: number;
};

function ensureDir(): void {
  if (!existsSync(PENDING_DIR)) mkdirSync(PENDING_DIR, { recursive: true });
}

function filePath(id: string): string {
  return path.join(PENDING_DIR, `${id}.json`);
}

export function savePendingImport(
  input: Omit<PendingImport, "id" | "uploadedAt">,
): PendingImport {
  ensureDir();
  pruneExpired();
  const pending: PendingImport = {
    ...input,
    id: randomUUID(),
    uploadedAt: Date.now(),
  };
  writeFileSync(filePath(pending.id), JSON.stringify(pending), "utf8");
  return pending;
}

export function readPendingImport(id: string): PendingImport | null {
  if (!/^[a-f0-9-]{36}$/i.test(id)) return null;
  const p = filePath(id);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as PendingImport;
  } catch {
    return null;
  }
}

export function deletePendingImport(id: string): void {
  if (!/^[a-f0-9-]{36}$/i.test(id)) return;
  const p = filePath(id);
  if (existsSync(p)) unlinkSync(p);
}

export function pruneExpired(now: number = Date.now()): void {
  if (!existsSync(PENDING_DIR)) return;
  for (const name of readdirSync(PENDING_DIR)) {
    const p = path.join(PENDING_DIR, name);
    try {
      if (now - statSync(p).mtimeMs > MAX_AGE_MS) unlinkSync(p);
    } catch {
      // ignore
    }
  }
}
