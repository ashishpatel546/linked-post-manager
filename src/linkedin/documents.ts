import fs from "node:fs";
import path from "node:path";
import { apiRequest } from "./client.ts";
import { requireAccessToken } from "../state/tokens.ts";

type InitializeUploadResponse = {
  value: {
    uploadUrl: string;
    document: string;
    uploadUrlExpiresAt?: number;
  };
};

/**
 * LinkedIn accepts PPT, PPTX, DOC, DOCX and PDF here. We only ever generate
 * PDFs, and accepting the rest would mean claiming support for conversions this
 * repo does not do.
 */
const ALLOWED_EXTENSIONS = new Set([".pdf"]);

/** Documented ceilings for the Documents API. */
const MAX_BYTES = 100 * 1024 * 1024;
const MAX_PAGES = 300;

/**
 * Same shape as the image upload — register against an owner for a signed URL,
 * then PUT the bytes — but a different resource, and the response field is
 * `document` rather than `image`. The returned urn:li:document:... is what a
 * post references to render as a swipeable deck in the feed.
 *
 * Owner may be a person or an organization URN; person uploads require the
 * caller to be that person, which `w_member_social` covers.
 */
export async function uploadDocument(
  ownerUrn: string,
  filePath: string,
): Promise<string> {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Document not found: ${resolved}`);
  }

  const extension = path.extname(resolved).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    throw new Error(
      `Unsupported document type "${extension}". This agent uploads PDFs only.`,
    );
  }

  const bytes = fs.readFileSync(resolved);
  if (bytes.byteLength > MAX_BYTES) {
    throw new Error(
      `Document is ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB; LinkedIn's limit is 100 MB.`,
    );
  }

  const { data } = await apiRequest<InitializeUploadResponse>(
    "/rest/documents?action=initializeUpload",
    {
      method: "POST",
      body: { initializeUploadRequest: { owner: ownerUrn } },
    },
  );

  const token = await requireAccessToken();
  const upload = await fetch(data.value.uploadUrl, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}` },
    body: new Uint8Array(bytes),
  });

  if (!upload.ok) {
    const detail = await upload.text();
    throw new Error(
      `Document byte upload failed (${upload.status}): ${detail.slice(0, 400)}`,
    );
  }

  return data.value.document;
}

/**
 * LinkedIn rejects a deck over 300 pages. Counting page objects in the file we
 * just wrote is cheaper than a round trip that fails after the upload.
 */
export function assertPageCount(pages: number): void {
  if (pages > MAX_PAGES) {
    throw new Error(
      `Article renders to ${pages} pages; LinkedIn's limit is ${MAX_PAGES}. Shorten it.`,
    );
  }
}
