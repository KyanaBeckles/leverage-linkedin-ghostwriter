// Cloudinary upload via plain REST + signed params — the `cloudinary` npm
// package uses Node stream/fs APIs that aren't available in the Workers
// runtime, so this hits the HTTP API directly instead.

export interface CloudinaryConfig {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
}

async function sha1Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-1", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Uploads an image already available at a public URL (Claude/image-gen output,
// or a pre-hosted text-card template render) into our Cloudinary folder and
// returns the resulting public URL, resized to LinkedIn-friendly dimensions.
export async function uploadImageFromUrl(
  config: CloudinaryConfig,
  sourceUrl: string,
  publicId: string
): Promise<string> {
  const timestamp = Math.floor(Date.now() / 1000);
  const paramsToSign = `folder=linkedin-ghostwriter&public_id=${publicId}&timestamp=${timestamp}&transformation=w_1200,h_1350,c_limit`;
  const signature = await sha1Hex(`${paramsToSign}${config.apiSecret}`);

  const form = new FormData();
  form.append("file", sourceUrl);
  form.append("api_key", config.apiKey);
  form.append("timestamp", String(timestamp));
  form.append("folder", "linkedin-ghostwriter");
  form.append("public_id", publicId);
  form.append("transformation", "w_1200,h_1350,c_limit");
  form.append("signature", signature);

  const res = await fetch(`https://api.cloudinary.com/v1_1/${config.cloudName}/image/upload`, {
    method: "POST",
    body: form,
  });

  if (!res.ok) {
    throw new Error(`Cloudinary upload HTTP ${res.status}: ${await res.text()}`);
  }

  const json = (await res.json()) as { secure_url?: string; error?: { message: string } };
  if (!json.secure_url) {
    throw new Error(`Cloudinary upload failed: ${json.error?.message ?? "unknown error"}`);
  }
  return json.secure_url;
}
