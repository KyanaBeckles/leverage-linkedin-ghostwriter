// Buffer GraphQL API — the last-mile LinkedIn publisher (Essentials plan,
// official LinkedIn API partner, no Partner Program application needed).
// Ported from the reference posting-layer.ts in the Drive spec folder;
// fetch-based already, so it needs no changes to run in a Worker.
//
// NOTE: Buffer's GraphQL API is in public beta. Known constraints:
// 1. No edit/delete of a created post via API — pull/fix via the Buffer dashboard.
// 2. Images must be PUBLIC URLs (no direct file upload) — hence Cloudinary.
// 3. assets is a flat AssetInput[] list, each entry exactly one of image/video/document/link
//    (breaking change May 25, 2026 — verify against developers.buffer.com at build time
//    if this stops working, the API is beta and may have shifted again).

const BUFFER_GRAPHQL_ENDPOINT = "https://api.buffer.com";

async function bufferGraphQL<T>(apiKey: string, query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(BUFFER_GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    throw new Error(`Buffer API HTTP ${res.status}: ${await res.text()}`);
  }

  const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (json.errors?.length) {
    throw new Error(`Buffer API error: ${json.errors.map((e) => e.message).join("; ")}`);
  }
  return json.data as T;
}

export interface SchedulePostArgs {
  apiKey: string;
  channelId: string;
  text: string;
  imageUrl?: string;
  dueAt: Date;
}

export async function schedulePostViaBuffer(args: SchedulePostArgs): Promise<string> {
  const mutation = `
    mutation CreatePost($input: CreatePostInput!) {
      createPost(input: $input) {
        ... on Post { id }
        ... on Error { message }
      }
    }
  `;

  const assets = args.imageUrl ? [{ image: { url: args.imageUrl } }] : [];

  const data = await bufferGraphQL<{ createPost: { id?: string; message?: string } }>(args.apiKey, mutation, {
    input: {
      channelId: args.channelId,
      text: args.text,
      assets,
      mode: "customScheduled",
      dueAt: args.dueAt.toISOString(),
    },
  });

  if (!data.createPost?.id) {
    throw new Error(`Buffer createPost failed: ${data.createPost?.message ?? "unknown error"}`);
  }
  return data.createPost.id;
}
