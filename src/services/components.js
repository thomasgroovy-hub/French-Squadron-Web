/**
 * Constructeurs de messages Discord (Components V2).
 *
 * Copie de `src/components.js` du bot (French-Squadron-Utilities), allégée des
 * éléments propres au bot (`createPermadeathNotificationEmbed`,
 * `createV2EphemeralError`) : le portail n'a besoin que des briques de mise en
 * forme pour que le message direct envoyé depuis le site soit exactement le
 * même que ceux envoyés par le bot.
 *
 * ⚠️ Toute modification de `BOT_ACCENT_COLOR` ou de `createV2Message` doit être
 * répercutée dans le dépôt du bot, sinon les messages des deux côtés divergent.
 */
import {
  ContainerBuilder,
  MessageFlags,
  SectionBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
  ThumbnailBuilder,
} from 'discord.js';

/**
 * Accent unique du bot, réutilisé par tous les embeds afin de garder une
 * identité visuelle cohérente entre les messages du bot et ceux du portail web.
 */
export const BOT_ACCENT_COLOR = 0x475569;

export function createSeparator(spacing = SeparatorSpacingSize.Small, divider = true) {
  return new SeparatorBuilder().setDivider(divider).setSpacing(spacing);
}

/**
 * Assemble un message Components V2 dans un unique conteneur accentué.
 *
 * Le retour est directement exploitable par `sendDirectMessage` : il contient
 * déjà `components` et le drapeau `IS_COMPONENTS_V2` que l'API Discord exige.
 */
export function createV2Message({
  title,
  description,
  thumbnailUrl = null,
  sections = [],
  actionRow = null,
  footer = null,
  spacing = SeparatorSpacingSize.Small,
  accentColor = null,
  ephemeral = false,
} = {}) {
  const container = new ContainerBuilder();

  if (accentColor !== null && accentColor !== undefined) {
    container.setAccentColor(accentColor);
  }

  if (title) {
    const cleanTitle = title.replace(/^◆\s*/, '').trim();
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`## ${cleanTitle}`),
    );
  }

  if (thumbnailUrl && description) {
    const section = new SectionBuilder()
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(description))
      .setThumbnailAccessory(new ThumbnailBuilder().setURL(thumbnailUrl));
    container.addSectionComponents(section);
  } else if (description) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(description));
  }

  for (const sec of sections) {
    container.addSeparatorComponents(createSeparator(spacing, true));

    const content = typeof sec === 'string' ? sec : sec.content;
    const secThumbnail = typeof sec === 'object' && sec.thumbnailUrl ? sec.thumbnailUrl : null;

    if (secThumbnail && content) {
      const section = new SectionBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(content))
        .setThumbnailAccessory(new ThumbnailBuilder().setURL(secThumbnail));
      container.addSectionComponents(section);
    } else if (content) {
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(content));
    }
  }

  if (actionRow) {
    container.addSeparatorComponents(createSeparator(spacing, true));
    container.addActionRowComponents(actionRow);
  }

  if (footer) {
    container.addSeparatorComponents(createSeparator(SeparatorSpacingSize.Small, false));
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`*${footer}*`));
  }

  return {
    components: [container],
    flags: MessageFlags.IsComponentsV2 | (ephemeral ? MessageFlags.Ephemeral : 0),
  };
}
