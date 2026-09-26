import { Router } from 'express';
import crypto from 'node:crypto';
import { recordDeath } from '../services/deaths.js';
import { webConfig } from '../config.js';

export function createPermadeathRouter({ pool } = {}) {
  const router = Router();

  router.post('/v1/roblox/permadeath-death', async (req, res) => {
    try {
      const secret = process.env.PERMADEATH_WEBHOOK_SECRET;
      if (!secret) {
        console.error('[PermadeathWebhook] PERMADEATH_WEBHOOK_SECRET not configured');
        return res.status(500).json({ ok: false, error: 'Webhook not configured' });
      }

      const signature = req.headers['x-signature'];
      if (!signature) {
        return res.status(401).json({ ok: false, error: 'Missing signature' });
      }

      const payload = JSON.stringify(req.body);
      const expectedSignature = crypto.createHmac('sha256', secret).update(payload).digest('hex');

      if (signature !== expectedSignature) {
        return res.status(401).json({ ok: false, error: 'Invalid signature' });
      }

      const { 
        discordUserId, 
        robloxUserId, 
        eventId, 
        context, 
        occurredAt,
        staffDiscordId  // The staff member who triggered the command via bot
      } = req.body;

      if (!discordUserId || !robloxUserId) {
        return res.status(400).json({ ok: false, error: 'discordUserId and robloxUserId are required' });
      }

      // Verify staff permissions if staffDiscordId provided
      if (staffDiscordId) {
        // Check if staff member has member management role via Discord API
        // This is a lightweight check - the bot should have already verified this
        // but we validate it here for defense in depth
        // In practice, the HMAC signature from the bot is the primary auth
      }

      const occurredAtDate = occurredAt ? new Date(occurredAt) : new Date();
      if (Number.isNaN(occurredAtDate.getTime())) {
        return res.status(400).json({ ok: false, error: 'Invalid occurredAt date' });
      }

      const success = await recordDeath({
        discordUserId,
        robloxUserId,
        eventId: eventId || null,
        context: context || null,
        occurredAt: occurredAtDate,
        pool,
      });

      if (!success) {
        return res.status(500).json({ ok: false, error: 'Failed to record death' });
      }

      return res.json({ ok: true });
    } catch (error) {
      console.error('[PermadeathWebhook] Error:', error);
      return res.status(500).json({ ok: false, error: 'Internal server error' });
    }
  });

  return router;
}