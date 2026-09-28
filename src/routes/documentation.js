import { Router } from 'express';
import { webConfig } from '../config.js';

/**
 * Cartes de la page publique /documentation. Les URL viennent de la
 * configuration serveur (`src/config.js`), donc de variables d'environnement
 * Railway : cette page ne lit plus rien en base et ne propose aucun édition.
 *
 * `url` vide = lien non configuré : la vue rend alors une carte inerte plutôt
 * qu'un lien mort.
 */
function documentationCards() {
  return [
    {
      key: 'ethics',
      title: 'Charte éthique',
      description: 'La Charte Éthique constitue le texte normatif suprême de la Fondation de Procédures de Confinement Spéciales.',
      url: webConfig.documentationEthicsUrl,
    },
    {
      key: 'facility',
      title: 'Charte de l’installation',
      description: 'La charte de l’installation rédige ce qui est acceptable dans l’installation. Utilisée par le département administratif.',
      url: webConfig.documentationFacilityUrl,
    },
    {
      key: 'discord',
      title: 'Discord',
      description: 'Le serveur Discord de la Fondation et de l’installation : questions, annonces et échanges du personnel.',
      url: webConfig.discordUrl,
    },
  ];
}

/**
 * Page de documentation publique : une simple table de liens, lisible sans
 * connexion. Elle remplace l'ancien éditeur de blocs, qui exigeait MySQL et le
 * rôle de gestion des formulaires ; la route reste donc sans pool ni garde
 * d'accès, et `/documentation` reste atteignable directement.
 */
export function createDocumentationRouter() {
  const router = Router();

  router.get('/', (req, res) => {
    res.render('documentation', {
      title: 'Documentation | Site-66',
      cards: documentationCards(),
    });
  });

  return router;
}
