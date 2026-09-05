import fs from "node:fs";
import path from "node:path";
import { apiRequest } from "./client.ts";
import { requireAccessToken } from "../state/tokens.ts";

type InitializeUploadResponse = {
  value: {
    uploadUrl: string;
    image: string;
    uploadUrlExpiresAt?: number;
  };
};

const ALLOWED_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif"]);

/**
 * Two-step upload: register the image against an owner to get a signed URL,
 * then PUT the bytes there. The returned urn:li:image:... is what a post
 * references.
 */
export async function uploadImage(
  ownerUrn: string,
  filePath: string,
): Promise<string> {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Image not found: ${resolved}`);
  }

  const extension = path.extname(resolved).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    throw new Error(
      `Unsupported image type "${extension}". LinkedIn accepts PNG, JPG, and GIF.`,
    );
  }

  const bytes = fs.readFileSync(resolved);
  if (bytes.byteLength > 10 * 1024 * 1024) {
    throw new Error(
      `Image is ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB; keep uploads under 10 MB.`,
    );
  }

  const { data } = await apiRequest<InitializeUploadResponse>(
    "/rest/images?action=initializeUpload",
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
      `Image byte upload failed (${upload.status}): ${detail.slice(0, 400)}`,
    );
  }

  return data.value.image;
}
