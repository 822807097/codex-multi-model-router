/**
 * Publish the Windows NSIS installer to Cloudflare R2.
 *
 * Uploads three objects to the shared `api-for-composer-releases` bucket
 * (public domain https://api-for-composer.standardagents.ai):
 *   - releases/windows/API-for-Cursor-<VERSION>-x64-setup.exe   (versioned)
 *   - releases/windows/API-for-Cursor-latest-x64-setup.exe      (latest alias)
 *   - releases/windows/appcast.json                             (Tauri updater)
 *
 * VERSION comes from process.env.VERSION with a leading `v` and a trailing
 * `-win` stripped (e.g. `v0.1.0-win` -> `0.1.0`).
 *
 * Required env (the workflow only invokes this when all are present):
 *   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, VERSION
 * Optional env:
 *   R2_RELEASE_BUCKET (default `api-for-composer-releases`)
 *   R2_PUBLIC_BASE_URL (default https://api-for-composer.standardagents.ai)
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const RELEASE_BUCKET = process.env.R2_RELEASE_BUCKET || "api-for-composer-releases";
const PUBLIC_BASE_URL = (process.env.R2_PUBLIC_BASE_URL || "https://api-for-composer.standardagents.ai").replace(/\/+$/, "");
const WINDOWS_PREFIX = "releases/windows";
const NSIS_BUNDLE_DIR = "src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function resolveVersion(): string {
  const raw = requireEnv("VERSION").trim();
  return raw.replace(/^v/, "").replace(/-win$/, "");
}

function findNsisInstaller(): string {
  const entries = readdirSync(NSIS_BUNDLE_DIR);
  const exe = entries.find((name) => name.toLowerCase().endsWith(".exe"));
  if (!exe) {
    throw new Error(`No NSIS .exe found under ${NSIS_BUNDLE_DIR}`);
  }
  return join(NSIS_BUNDLE_DIR, exe);
}

function readSignature(installerPath: string): string {
  // Tauri writes the detached signature next to the bundle as `<installer>.sig`.
  try {
    return readFileSync(`${installerPath}.sig`, "utf8").trim();
  } catch {
    console.warn(`No .sig found next to ${installerPath}; appcast signature will be empty.`);
    return "";
  }
}

function buildAppcast(version: string, signature: string): string {
  const appcast = {
    version,
    notes: `API for Cursor ${version}`,
    pub_date: new Date().toISOString(),
    platforms: {
      "windows-x86_64": {
        signature,
        url: `${PUBLIC_BASE_URL}/${WINDOWS_PREFIX}/API-for-Cursor-${version}-x64-setup.exe`
      }
    }
  };
  return JSON.stringify(appcast, null, 2);
}

async function putObject(client: S3Client, key: string, body: Uint8Array | string, contentType: string): Promise<void> {
  await client.send(
    new PutObjectCommand({
      Bucket: RELEASE_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType
    })
  );
  console.log(`Uploaded ${key} (${contentType})`);
}

async function main(): Promise<void> {
  const accountId = requireEnv("R2_ACCOUNT_ID");
  const accessKeyId = requireEnv("R2_ACCESS_KEY_ID");
  const secretAccessKey = requireEnv("R2_SECRET_ACCESS_KEY");
  const version = resolveVersion();

  const installerPath = findNsisInstaller();
  const installerBytes = readFileSync(installerPath);
  const signature = readSignature(installerPath);
  const appcast = buildAppcast(version, signature);

  const client = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey }
  });

  const versionedKey = `${WINDOWS_PREFIX}/API-for-Cursor-${version}-x64-setup.exe`;
  const latestKey = `${WINDOWS_PREFIX}/API-for-Cursor-latest-x64-setup.exe`;
  const appcastKey = `${WINDOWS_PREFIX}/appcast.json`;

  await putObject(client, versionedKey, installerBytes, "application/octet-stream");
  await putObject(client, latestKey, installerBytes, "application/octet-stream");
  await putObject(client, appcastKey, appcast, "application/json; charset=utf-8");

  console.log(`Published API for Cursor ${version} to ${PUBLIC_BASE_URL}/${WINDOWS_PREFIX}/`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
