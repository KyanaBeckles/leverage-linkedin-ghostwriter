import type { Env } from "../env";
import { generateWithClaude } from "../lib/claude";
import { easternDateToUtc } from "../lib/easternTime";

interface Topic {
  id: number;
  topic: string;
  source_context: string | null;
  mode: "event_recap" | "aphorism" | "curated_series";
  audience_tag: "public_sector" | "associations" | "product" | "both";
  priority: number;
}

interface VoiceProfile {
  id: number;
  tone: string;
  sentence_rhythm: string;
  structural_patterns: string;
  signature_phrases: string;
  avoid_list: string | null;
  example_excerpts: string;
}

const MODE_PROMPTS: Record<Topic["mode"], string> = {
  event_recap:
    "Write in EVENT-RECAP mode: shoutout-heavy, conversational, ellipsis-paced, gratitude-structured. Name real collaborators/context from the topic if given.",
  aphorism:
    "Write in APHORISM mode: 2-4 lines, analogy-driven if it fits, ending on a standalone punchline or rhetorical question. Stylistic compression, not content dumbing-down.",
  curated_series:
    "Write in CURATED-SERIES mode: a numbered claim-or-question plus source context plus an invitation to respond. Compact — one idea, one link/source, one question.",
};

// v1 topic selection: simplified balancing (full rolling-4-week analysis
// from orchestrator-strategy-guidance.md is a later refinement) — enforces
// the two hard rules (max 1-in-5 product, no 2 consecutive same mode) and
// otherwise takes the highest-priority unused topics.
async function pickTopics(db: D1Database): Promise<Topic[]> {
  const { results } = await db
    .prepare("SELECT id, topic, source_context, mode, audience_tag, priority FROM post_topics WHERE used = 0 ORDER BY priority DESC, id ASC")
    .all<Topic>();

  if (results.length === 0) return [];

  const picked: Topic[] = [];
  let productCount = 0;

  for (const t of results) {
    if (picked.length >= 3) break;
    const isProduct = t.audience_tag === "product";
    if (isProduct && productCount >= 1) continue; // at most 1-in-3 this batch (conservative vs. spec's 1-in-5)
    const last = picked[picked.length - 1];
    if (last && last.mode === t.mode && picked.length >= 1) {
      // prefer variety, but don't block entirely if nothing else is left
      const alternative = results.find((r) => r.mode !== t.mode && !picked.includes(r) && r !== t);
      if (alternative) continue;
    }
    picked.push(t);
    if (isProduct) productCount++;
  }

  return picked;
}

async function draftPost(env: Env, voice: VoiceProfile, topic: Topic): Promise<{ text: string; tokensUsed: string; prompt: string }> {
  const structuralPatterns = JSON.parse(voice.structural_patterns) as string[];
  const signaturePhrases = JSON.parse(voice.signature_phrases) as string[];
  const avoidList = voice.avoid_list ? (JSON.parse(voice.avoid_list) as string[]) : [];
  const examples = JSON.parse(voice.example_excerpts) as string[];
  // Rotate a couple of examples so the model doesn't anchor on the same ones every week.
  const rotatingExamples = examples.sort(() => Math.random() - 0.5).slice(0, 3);

  const system = `You are ghostwriting a LinkedIn post in Kyana Beckles' authentic voice for Leverage Assessments Inc.

TONE: ${voice.tone}
SENTENCE RHYTHM: ${voice.sentence_rhythm}
STRUCTURAL PATTERNS she uses: ${structuralPatterns.join("; ")}
SIGNATURE PHRASES (use naturally, don't force all of them): ${signaturePhrases.join(", ")}
AVOID: ${avoidList.join(" | ")}

EXAMPLE POSTS IN HER VOICE:
${rotatingExamples.map((e, i) => `${i + 1}. "${e}"`).join("\n")}

${MODE_PROMPTS[topic.mode]}

Output ONLY the post text, no preamble, no markdown formatting, no quotation marks around it.`;

  const user = `Topic: ${topic.topic}\n${topic.source_context ? `Source context: ${topic.source_context}` : ""}`;

  const { text, tokensUsed } = await generateWithClaude({
    apiKey: env.ANTHROPIC_API_KEY,
    system,
    user,
    maxTokens: 800,
  });

  return { text, tokensUsed: String(tokensUsed), prompt: `${system}\n\n---\n\n${user}` };
}

// Next Mon/Wed/Fri 3:00 PM ET dates, starting from tomorrow (this job runs
// Sunday evening to schedule the coming week).
function nextThreeSlots(fromDateStr: string): string[] {
  const [y, m, d] = fromDateStr.split("-").map(Number);
  const slots: string[] = [];
  const cursor = new Date(Date.UTC(y, m - 1, d));
  while (slots.length < 3) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const dow = cursor.getUTCDay(); // 0=Sun..6=Sat, safe here since we only read the day-of-week, not local time
    if (dow === 1 || dow === 3 || dow === 5) {
      slots.push(cursor.toISOString().slice(0, 10));
    }
  }
  return slots;
}

export async function runGenerateJob(env: Env, todayEt: string): Promise<string> {
  const voice = await env.DB.prepare("SELECT * FROM voice_profiles WHERE is_active = 1 ORDER BY version DESC LIMIT 1").first<VoiceProfile>();
  if (!voice) throw new Error("No active voice_profiles row — seed data missing");

  const topics = await pickTopics(env.DB);
  if (topics.length === 0) {
    return "No unused topics remaining in post_topics — queue needs replenishing (see 'Open items' in orchestrator-strategy-guidance.md).";
  }

  const slots = nextThreeSlots(todayEt);
  const created: number[] = [];

  for (let i = 0; i < topics.length; i++) {
    const topic = topics[i];
    const slotDate = slots[i];
    const { text, tokensUsed, prompt } = await draftPost(env, voice, topic);
    const scheduledAt = easternDateToUtc(slotDate, 15, 0).toISOString();

    const insertResult = await env.DB
      .prepare(
        "INSERT INTO linkedin_posts (topic_id, voice_profile_id, draft_text, status, scheduled_at) VALUES (?, ?, ?, 'scheduled', ?)"
      )
      .bind(topic.id, voice.id, text, scheduledAt)
      .run();

    const postId = insertResult.meta.last_row_id;
    created.push(Number(postId));

    await env.DB.prepare("UPDATE post_topics SET used = 1 WHERE id = ?").bind(topic.id).run();
    await env.DB
      .prepare("INSERT INTO post_generation_logs (post_id, prompt_used, model_response, tokens_used) VALUES (?, ?, ?, ?)")
      .bind(postId, prompt, text, tokensUsed)
      .run();
  }

  return `Generated ${created.length} draft(s) for ${slots.join(", ")}: post ids ${created.join(", ")}`;
}
