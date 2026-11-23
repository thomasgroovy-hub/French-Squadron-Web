import { Router } from 'express';
import crypto from 'node:crypto';
import { recordDeath } from '../services/deaths.js';
import { webConfig } from '../config.js';

const HEX_64 = /^[0-9a-f]{64}$/i;
const SNOWFLAKE = /^\d{17,20}$/;
const ROBLOX_ID = /^\d{1,20}$/;
const MAX_EVENT_ID_LENGTH = 64;
const MAX_CONTEXT_LENGTH = 1000;
/** Signed timestamps older than this are rejected (replay window). */
const TIMESTAMP_WINDOW_MS = 5 * 60 * 1000;
/** Exact-signature replay cache: covers payloads without an event id. */
const REPLAY_CACHE_TTL_MS = 10 * 60 * 1000;
const REPLAY_CACHE_MAX = 5000;

const seenSignatures = new Map();

function isDuplicateSignature(signature, now) {
  const key = crypto.createHash('sha256').update(signature).digest('hex');
  const expiry = seenSignatures.get(key);
  if (expiry !== undefined && expiry > now) return true;
  for (const [entry, until] of seenSignatures) {
    if (until <= now) seenSignatures.delete(entry);
  }
  if (seenSignatures.size >= REPLAY_CACHE_MAX) seenSignatures.clear();
  seenSignatures.set(key, now + REPLAY_CACHE_TTL_MS);
  return false;
}

function hmacHex(secret, data) {
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

function signatureMatches(signature, candidates, secret) {
  if (typeof signature !== 'string' || !HEX_64.test(signature)) return false;
  const provided = Buffer.from(signature.toLowerCase(), 'hex');
  // Compare against every accepted scheme with a timing-safe equality: the
  // legacy bot signs the canonical JSON body, the hardened scheme signs
  // `timestamp.body` over the exact raw bytes.
  return candidates.some((candidate) => {
    const expected = Buffer.from(hmacHex(secret, candidate), 'hex');
    return expected.length === provided.length && crypto.timingSafeEqual(expected, provided);
  });
}

/**
 * Defense in depth on top of the HMAC: the staff id inside the payload is
 * client-supplied, so confirm it really holds the member-management role.
 * Returns 'forbidden' only on a definitive Discord answer (404, or a live
 * member without the role); transport failures return 'unknown' so a Discord
 * outage cannot wipe out recorded deaths.
 */
async function verifyStaffRole({ staffDiscordId, config, fetchFn }) {
  if (!staffDiscordId) return { status: 'absent' };
  if (!SNOWFLAKE.test(staffDiscordId)) return { status: 'invalid' };
  if (!config.discordToken || !config.guildId) return { status: 'unknown' };
  try {
    const response = await fetchFn(
      `https://discord.com/api/v10/guilds/${config.guildId}/members/${staffDiscordId}`,
      {
        headers: { Authorization: `Bot ${config.discordToken}` },
        signal: AbortSignal.timeout(8000),
      },
    );
    if (response.status === 404) return { status: 'forbidden', reason: 'not-in-guild' };
    if (!response.ok) return { status: 'unknown', reason: `discord-${response.status}` };
    const member = await response.json();
    const roles = Array.isArray(member.roles) ? member.roles : [];
    const allowedRoles = config.memberManagementRoleIds || [config.memberManagementRoleId];
    if (!roles.some((roleId) => allowedRoles.includes(roleId))) {
      return { status: 'forbidden', reason: 'no-role' };
    }
    return { status: 'ok' };
  } catch (error) {
    return { status: 'unknown', reason: error.message };
  }
}

export function createPermadeathRouter({ pool, config = webConfig, fetchFn = fetch } = {}) {
  const router = Router();

  router.post('/v1/roblox/permadeath-death', async (req, res) => {
    try {
      const secret = config.permadeathWebhookSecret || process.env.PERMADEATH_WEBHOOK_SECRET;
      if (!secret) {
        console.error('[PermadeathWebhook] PERMADEATH_WEBHOOK_SECRET not configured');
        return res.status(500).json({ ok: false, error: 'Webhook not configured' });
      }

      const signature = req.headers['x-signature'];
      if (!signature) {
        return res.status(401).json({ ok: false, error: 'Missing signature' });
      }

      const rawBody = typeof req.rawBody === 'string' && req.rawBody
        ? req.rawBody
        : JSON.stringify(req.body ?? {});
      const timestampHeader = req.headers['x-signature-timestamp'];
      const now = Date.now();

      const candidates = [rawBody, JSON.stringify(req.body ?? {})];
      if (timestampHeader !== undefined) {
        const ts = Number.parseInt(String(timestampHeader), 10);
        if (!Number.isFinite(ts) || Math.abs(now - ts * 1000) > TIMESTAMP_WINDOW_MS) {
          return res.status(401).json({ ok: false, error: 'Stale or invalid timestamp' });
        }
        // Signed material covers the timestamp: an attacker replaying a
        // captured request cannot refresh it without the secret.
        candidates.unshift(`${ts}.${rawBody}`);
      }

      if (!signatureMatches(signature, candidates, secret)) {
        return res.status(401).json({ ok: false, error: 'Invalid signature' });
      }

      const {
        discordUserId,
        robloxUserId,
        eventId,
        context,
        occurredAt,
        staffDiscordId, // The staff member who triggered the command via bot
      } = req.body ?? {};

      if (!SNOWFLAKE.test(String(discordUserId || '')) || !ROBLOX_ID.test(String(robloxUserId || ''))) {
        return res.status(400).json({ ok: false, error: 'discordUserId and robloxUserId are required' });
      }

      // Without a signed timestamp the only replay defense left is the
      // event-id dedupe: refuse deliveries that carry neither.
      if (timestampHeader === undefined && (typeof eventId !== 'string' || !eventId.trim())) {
        return res.status(400).json({
          ok: false,
          error: 'event_id or x-signature-timestamp required (replay protection)',
        });
      }
      if (eventId !== undefined && eventId !== null && (typeof eventId !== 'string' || eventId.length > MAX_EVENT_ID_LENGTH)) {
        return res.status(400).json({ ok: false, error: 'Invalid eventId' });
      }
      if (context !== undefined && context !== null && typeof context !== 'string') {
        return res.status(400).json({ ok: false, error: 'Invalid context' });
      }

      const staff = await verifyStaffRole({ staffDiscordId, config, fetchFn });
      if (staff.status === 'invalid') {
        return res.status(400).json({ ok: false, error: 'Invalid staffDiscordId' });
      }
      if (staff.status === 'forbidden') {
        return res.status(403).json({ ok: false, error: 'Staff member lacks member management role' });
      }
      if (staff.status === 'unknown' && staff.reason) {
        console.warn(`[PermadeathWebhook] Staff role check unavailable (${staff.reason}); accepting signed payload`);
      }

      const occurredAtDate = occurredAt ? new Date(occurredAt) : new Date();
      if (Number.isNaN(occurredAtDate.getTime())) {
        return res.status(400).json({ ok: false, error: 'Invalid occurredAt date' });
      }

      // Replay defense beyond the timestamp window: an identical, already
      // accepted delivery is refused. Placed after every validation so a
      // request rejected here (bad staff id, bad date) can be retried.
      if (isDuplicateSignature(String(signature), now)) {
        return res.status(409).json({ ok: false, error: 'Duplicate delivery' });
      }

      const outcome = await recordDeath({
        discordUserId: String(discordUserId),
        robloxUserId: String(robloxUserId),
        eventId: typeof eventId === 'string' ? eventId : null,
        context: typeof context === 'string' ? context.slice(0, MAX_CONTEXT_LENGTH) : null,
        occurredAt: occurredAtDate,
        pool,
      });

      if (!outcome) {
        return res.status(500).json({ ok: false, error: 'Failed to record death' });
      }

      return res.json({ ok: true, duplicate: outcome === 'duplicate' });
    } catch (error) {
      console.error('[PermadeathWebhook] Error:', error);
      return res.status(500).json({ ok: false, error: 'Internal server error' });
    }
  });

  return router;
}
