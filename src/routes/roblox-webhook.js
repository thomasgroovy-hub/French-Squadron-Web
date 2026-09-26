import express from 'express';
import { Router } from 'express';
import { webConfig } from '../config.js';
import { recordDeath } from '../services/deaths.js';
import { sendDirectMessage } from '../services/discord.js';

const SNOWFLAKE_PATTERN = /^\d{17,20}$/;

function createPermadeathDeathEmbed({ robloxUsername, eventId, context }) {
  return {
    title: '💀 Mort permanente enregistrée',
    description: 'Votre personnage est décédé en jeu (permadeath).',
    color: 0x8b0000,
    fields: [
      { name: 'Compte Roblox', value: robloxUsername || 'Inconnu', inline: true },
      ...(eventId ? [{ name: 'ID événement', value: `\`${eventId}\``, inline: true }] : []),
      ...(context ? [{ name: 'Contexte', value: context.slice(0, 1024) }] : []),
    ],
    footer: { text: 'Site-66 · Système Permadeath' },
    timestamp: new Date().toISOString(),
  };
}

export function createRobloxWebhookRouter({ pool, fetchFn } = {}) {
  const router = Router();

  router.post('/v1/roblox/permadeath-death', express.json(), async (req, res) => {
    try {
      const { discordUserId, robloxUserId, robloxUsername, eventId, context } = req.body || {};

      if (!discordUserId || !robloxUserId) {
        return res.status(400).json({ ok: false, error: 'discordUserId et robloxUserId sont requis.' });
      }
      if (!SNOWFLAKE_PATTERN.test(discordUserId) || !SNOWFLAKE_PATTERN.test(robloxUserId)) {
        return res.status(400).json({ ok: false, error: 'Identifiants Discord/Roblox invalides.' });
      }

      const occurredAt = new Date();

      const [dbResult, dmResult] = await Promise.allSettled([
        recordDeath({
          discordUserId,
          robloxUserId,
          eventId: eventId || null,
          context: context || null,
          occurredAt,
          pool,
        }),
        sendDirectMessage({
          userId: discordUserId,
          embeds: [createPermadeathDeathEmbed({ robloxUsername, eventId, context })],
          fetchFn,
        }),
      ]);

      const dbOk = dbResult.status === 'fulfilled' && dbResult.value === true;
      const dmOk = dmResult.status === 'fulfilled' && dmResult.value?.ok === true;

      if (!dbOk) {
        console.error('[Webhook] Échec enregistrement mort permadeath:', dbResult.status === 'rejected' ? dbResult.reason : 'DB insert returned false');
      }
      if (!dmOk) {
        console.warn('[Webhook] Échec envoi DM mort permadeath:', dmResult.status === 'rejected' ? dmResult.reason : dmResult.value?.error);
      }

      return res.json({
        ok: true,
        recorded: dbOk,
        dmSent: dmOk,
      });
    } catch (error) {
      console.error('[Webhook] Erreur inattendue permadeath-death:', error);
      return res.status(500).json({ ok: false, error: 'Erreur interne du serveur.' });
    }
  });

  return router;
}