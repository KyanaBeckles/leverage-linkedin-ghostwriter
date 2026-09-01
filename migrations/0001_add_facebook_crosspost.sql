-- Cross-post the same approved text to Facebook alongside LinkedIn. Kept as
-- extra columns on linkedin_posts rather than a new table: it's the same
-- post/review/veto lifecycle, just published to a second Buffer channel.
ALTER TABLE linkedin_posts ADD COLUMN facebook_status TEXT; -- NULL, 'posted', or 'failed'
ALTER TABLE linkedin_posts ADD COLUMN facebook_posted_at TEXT;
ALTER TABLE linkedin_posts ADD COLUMN facebook_external_post_id TEXT; -- Buffer post ID
ALTER TABLE linkedin_posts ADD COLUMN facebook_failure_reason TEXT;
