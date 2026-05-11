/**
 * Storage abstraction. Three backends, picked by STORAGE_BACKEND env var:
 *   - "local"  (default): writes under LOCAL_STORAGE_DIR (default ./uploads).
 *                          Signed URLs hand out HMAC tokens routed through
 *                          /download/:token on the backend.
 *   - "azure":             Azure Blob Storage. Reads AZURE_STORAGE_CONNECTION_STRING
 *                          and AZURE_STORAGE_CONTAINER (default "mike").
 *                          Signed URLs are SAS URLs (browser-direct).
 *   - "r2":                legacy Cloudflare R2 / S3-compatible (kept for
 *                          deployments still pointed at R2).
 *
 * All three implement the same exported function set; existing callers use
 * uploadFile / downloadFile / deleteFile / getSignedUrl unchanged.
 */

import * as fs from "fs/promises";
import * as path from "path";
import {
  BlobServiceClient,
  generateBlobSASQueryParameters,
  BlobSASPermissions,
  StorageSharedKeyCredential,
} from "@azure/storage-blob";
import { buildDownloadUrl } from "./downloadTokens";

type Backend = "local" | "azure" | "r2";

function selectedBackend(): Backend {
  const v = (process.env.STORAGE_BACKEND ?? "local").toLowerCase();
  if (v === "azure" || v === "r2" || v === "local") return v;
  return "local";
}

const BACKEND: Backend = selectedBackend();

// ---------------------------------------------------------------------------
// Local filesystem backend
// ---------------------------------------------------------------------------

const LOCAL_ROOT = path.resolve(
  process.cwd(),
  process.env.LOCAL_STORAGE_DIR ?? "uploads",
);

function localFullPath(key: string): string {
  // Reject path traversal — keys are app-generated but be safe.
  const safe = key.split("/").filter((seg) => seg && seg !== ".." && seg !== ".");
  return path.join(LOCAL_ROOT, ...safe);
}

async function localUpload(
  key: string,
  content: ArrayBuffer,
): Promise<void> {
  const full = localFullPath(key);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, Buffer.from(content));
}

async function localDownload(key: string): Promise<ArrayBuffer | null> {
  try {
    const buf = await fs.readFile(localFullPath(key));
    return buf.buffer.slice(
      buf.byteOffset,
      buf.byteOffset + buf.byteLength,
    ) as ArrayBuffer;
  } catch {
    return null;
  }
}

async function localDelete(key: string): Promise<void> {
  await fs.unlink(localFullPath(key)).catch(() => undefined);
}

function localSignedUrl(key: string, downloadFilename?: string): string {
  // Re-use the existing HMAC-signed download token route. It handles auth
  // (the route is gated by requireAuth) and Content-Disposition.
  const filename = downloadFilename ?? path.basename(key);
  const apiBase =
    process.env.PUBLIC_BACKEND_URL ??
    process.env.BACKEND_URL ??
    "http://localhost:3001";
  return `${apiBase}${buildDownloadUrl(key, filename)}`;
}

// ---------------------------------------------------------------------------
// Azure Blob backend
// ---------------------------------------------------------------------------

let _azureService: BlobServiceClient | null = null;
let _azureKey: StorageSharedKeyCredential | null = null;

function azureService(): BlobServiceClient {
  if (_azureService) return _azureService;
  const conn = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!conn) throw new Error("AZURE_STORAGE_CONNECTION_STRING is not set");
  _azureService = BlobServiceClient.fromConnectionString(conn);
  // Pull out the shared-key credential so we can sign SAS URLs without an
  // additional network round-trip. fromConnectionString stashes a credential
  // we can reuse, but the public surface doesn't expose it — re-parse the
  // string ourselves.
  const m = /AccountName=([^;]+);AccountKey=([^;]+)/.exec(conn);
  if (m) {
    _azureKey = new StorageSharedKeyCredential(m[1], m[2]);
  }
  return _azureService;
}

const AZURE_CONTAINER = process.env.AZURE_STORAGE_CONTAINER ?? "mike";

async function azureContainer() {
  const svc = azureService();
  const c = svc.getContainerClient(AZURE_CONTAINER);
  await c.createIfNotExists();
  return c;
}

async function azureUpload(
  key: string,
  content: ArrayBuffer,
  contentType: string,
): Promise<void> {
  const c = await azureContainer();
  const blob = c.getBlockBlobClient(key);
  await blob.uploadData(Buffer.from(content), {
    blobHTTPHeaders: { blobContentType: contentType },
  });
}

async function azureDownload(key: string): Promise<ArrayBuffer | null> {
  try {
    const c = await azureContainer();
    const blob = c.getBlockBlobClient(key);
    const buf = await blob.downloadToBuffer();
    return buf.buffer.slice(
      buf.byteOffset,
      buf.byteOffset + buf.byteLength,
    ) as ArrayBuffer;
  } catch {
    return null;
  }
}

async function azureDelete(key: string): Promise<void> {
  try {
    const c = await azureContainer();
    await c.deleteBlob(key);
  } catch {
    // ignore
  }
}

function azureSignedUrl(
  key: string,
  expiresIn: number,
  downloadFilename?: string,
): string {
  if (!_azureKey) {
    // Force initialisation of azureService so _azureKey is populated.
    azureService();
  }
  if (!_azureKey) throw new Error("Azure shared-key credential unavailable");

  const expiresOn = new Date(Date.now() + expiresIn * 1000);
  const sas = generateBlobSASQueryParameters(
    {
      containerName: AZURE_CONTAINER,
      blobName: key,
      permissions: BlobSASPermissions.parse("r"),
      expiresOn,
      contentDisposition: downloadFilename
        ? buildContentDisposition("attachment", downloadFilename)
        : undefined,
    },
    _azureKey,
  ).toString();
  const accountName = _azureKey.accountName;
  return `https://${accountName}.blob.core.windows.net/${AZURE_CONTAINER}/${encodeURIComponent(
    key,
  )}?${sas}`;
}

// ---------------------------------------------------------------------------
// R2 (S3-compatible) backend — kept for backwards compatibility
// ---------------------------------------------------------------------------

const R2_BUCKET = process.env.R2_BUCKET_NAME ?? "mike";

async function r2Client() {
  const { S3Client } = await import("@aws-sdk/client-s3");
  return new S3Client({
    region: "auto",
    endpoint: process.env.R2_ENDPOINT_URL!,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
  });
}

async function r2Upload(
  key: string,
  content: ArrayBuffer,
  contentType: string,
): Promise<void> {
  const { PutObjectCommand } = await import("@aws-sdk/client-s3");
  const client = await r2Client();
  await client.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      Body: Buffer.from(content),
      ContentType: contentType,
    }),
  );
}

async function r2Download(key: string): Promise<ArrayBuffer | null> {
  try {
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    const client = await r2Client();
    const response = await client.send(
      new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }),
    );
    if (!response.Body) return null;
    const bytes = await response.Body.transformToByteArray();
    return bytes.buffer as ArrayBuffer;
  } catch {
    return null;
  }
}

async function r2Delete(key: string): Promise<void> {
  try {
    const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
    const client = await r2Client();
    await client.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key }));
  } catch {
    // ignore
  }
}

async function r2SignedUrl(
  key: string,
  expiresIn: number,
  downloadFilename?: string,
): Promise<string> {
  const { GetObjectCommand } = await import("@aws-sdk/client-s3");
  const { getSignedUrl: awsGetSignedUrl } = await import(
    "@aws-sdk/s3-request-presigner"
  );
  const client = await r2Client();
  const command = new GetObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
    ResponseContentDisposition: downloadFilename
      ? buildContentDisposition("attachment", downloadFilename)
      : undefined,
  });
  return awsGetSignedUrl(client, command, { expiresIn });
}

// ---------------------------------------------------------------------------
// Public API — same shape as before
// ---------------------------------------------------------------------------

export const storageEnabled = (() => {
  if (BACKEND === "local") return true;
  if (BACKEND === "azure")
    return !!process.env.AZURE_STORAGE_CONNECTION_STRING;
  return Boolean(
    process.env.R2_ENDPOINT_URL &&
      process.env.R2_ACCESS_KEY_ID &&
      process.env.R2_SECRET_ACCESS_KEY,
  );
})();

export async function uploadFile(
  key: string,
  content: ArrayBuffer,
  contentType: string,
): Promise<void> {
  if (BACKEND === "local") return localUpload(key, content);
  if (BACKEND === "azure") return azureUpload(key, content, contentType);
  return r2Upload(key, content, contentType);
}

export async function downloadFile(key: string): Promise<ArrayBuffer | null> {
  if (!storageEnabled) return null;
  if (BACKEND === "local") return localDownload(key);
  if (BACKEND === "azure") return azureDownload(key);
  return r2Download(key);
}

export async function deleteFile(key: string): Promise<void> {
  if (!storageEnabled) return;
  if (BACKEND === "local") return localDelete(key);
  if (BACKEND === "azure") return azureDelete(key);
  return r2Delete(key);
}

export async function getSignedUrl(
  key: string,
  expiresIn = 3600,
  downloadFilename?: string,
): Promise<string | null> {
  if (!storageEnabled) return null;
  try {
    if (BACKEND === "local") return localSignedUrl(key, downloadFilename);
    if (BACKEND === "azure")
      return azureSignedUrl(key, expiresIn, downloadFilename);
    return await r2SignedUrl(key, expiresIn, downloadFilename);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Filename / content-disposition helpers (unchanged)
// ---------------------------------------------------------------------------

export function normalizeDownloadFilename(name: string): string {
  const trimmed = name.trim();
  const base = trimmed || "download";
  return base.replace(/[\x00-\x1F\x7F]/g, "_").replace(/[\\/]/g, "_");
}

export function sanitizeDispositionFilename(name: string): string {
  return normalizeDownloadFilename(name).replace(/["\\]/g, "_");
}

export function encodeRFC5987(str: string): string {
  return encodeURIComponent(str).replace(
    /['()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

export function buildContentDisposition(
  kind: "inline" | "attachment",
  filename: string,
): string {
  const normalized = normalizeDownloadFilename(filename);
  return `${kind}; filename="${sanitizeDispositionFilename(normalized)}"; filename*=UTF-8''${encodeRFC5987(normalized)}`;
}

// ---------------------------------------------------------------------------
// Storage key helpers (unchanged)
// ---------------------------------------------------------------------------

export function storageKey(
  userId: string,
  docId: string,
  filename: string,
): string {
  return `documents/${userId}/${docId}/source${storageExtension(filename, ".bin")}`;
}

export function pdfStorageKey(
  userId: string,
  docId: string,
  stem: string,
): string {
  return `documents/${userId}/${docId}/${stem}.pdf`;
}

export function generatedDocKey(
  userId: string,
  docId: string,
  filename: string,
): string {
  return `generated/${userId}/${docId}/generated${storageExtension(filename, ".docx")}`;
}

export function versionStorageKey(
  userId: string,
  docId: string,
  versionSlug: string,
  filename: string,
): string {
  return `documents/${userId}/${docId}/versions/${versionSlug}${storageExtension(filename, ".bin")}`;
}

function storageExtension(filename: string, fallback: string): string {
  const lastDot = filename.lastIndexOf(".");
  if (lastDot < 0) return fallback;
  const ext = filename.slice(lastDot).toLowerCase();
  return /^\.[a-z0-9]{1,16}$/.test(ext) ? ext : fallback;
}
