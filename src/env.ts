export interface Env {
  DB: D1Database;

  // Secrets — set via `wrangler secret put <NAME>`
  ANTHROPIC_API_KEY: string;
  SLACK_BOT_TOKEN: string;
  SLACK_CHANNEL_ID: string; // #digital-marketing channel ID
  BUFFER_API_KEY: string;
  BUFFER_CHANNEL_ID: string; // LinkedIn personal-profile channel in Buffer
  CLOUDINARY_CLOUD_NAME: string;
  CLOUDINARY_API_KEY: string;
  CLOUDINARY_API_SECRET: string;
}
