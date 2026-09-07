-- Distinguishes a generated text-card image (the card IS the caption, so the
-- caption is sent empty to avoid duplicating it - see publishGate.ts) from a
-- real photo attached to a post (image_url set but the caption is genuinely
-- separate content and must still be sent). Without this, any image_url -
-- including a real photo - silently blanked the caption.
ALTER TABLE linkedin_posts ADD COLUMN is_text_card INTEGER NOT NULL DEFAULT 0;
