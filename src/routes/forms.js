import { Router } from 'express';
import { requireAuth } from '../auth/session.js';
import { hasFormsRole, requireFormsRole } from '../auth/guards.js';
import { webConfig } from '../config.js';
import {
  FIELD_TYPES,
  FIELD_TYPE_VALUES,
  FORM_STATUS,
  RESPONSE_STATUS,
  countResponsesByCreator,
  createForm,
  ensureFormsTables,
  findAcceptedResponse,
  findPendingResponse,
  getFormById,
  getPublishCooldownRemaining,
  getResponseById,
  listFormsByCreator,
  listPublishedForms,
  listResponsesByCreator,
  setFormStatus,
  submitResponse,
  updateForm,
  updateResponseStatus,
  deleteForm,
} from '../services/forms.js';
import {
  fetchGuildRoleNames,
  formatDate,
  grantGuildMemberRole,
  sendDirectMessage,
} from '../services/discord.js';
import { fetchSiteUser } from '../services/members.js';
import { createApplicationAcceptedEmbed } from '../services/embeds.js';

const MAX_QUESTIONS = 20;
const MAX_ANSWER_LENGTH = 4000;

/** The builder posts `move=up:<questionId>` / `move=down:<questionId>`. */
const MOVE_DIRECTIONS = Object.freeze({ up: -1, down: 1 });

const STRUCTURAL_NOTICES = Object.freeze({
  add_question: 'Question ajoutée.',
  remove_question: 'Question supprimée.',
  move: 'Ordre mis à jour.',
});

/** Decision slugs accepted on `POST /reponses/:responseId/:decision`. */
const DECISIONS = {
  accepter: RESPONSE_STATUS.ACCEPTED,
  accepted: RESPONSE_STATUS.ACCEPTED,
  refuser: RESPONSE_STATUS.REJECTED,
  rejeter: RESPONSE_STATUS.REJECTED,
  rejected: RESPONSE_STATUS.REJECTED,
};
const SNOWFLAKE_PATTERN = /^\d{17,20}$/;

const RESPONSE_STATUS_LABELS = Object.freeze({
  [RESPONSE_STATUS.PENDING]: 'En attente',
  [RESPONSE_STATUS.ACCEPTED]: 'Acceptée',
  [RESPONSE_STATUS.REJECTED]: 'Refusée',
});

const RESPONSE_STATUS_TONES = Object.freeze({
  [RESPONSE_STATUS.PENDING]: 'warning',
  [RESPONSE_STATUS.ACCEPTED]: 'success',
  [RESPONSE_STATUS.REJECTED]: 'danger',
});

const FORM_STATUS_LABELS = Object.freeze({
  [FORM_STATUS.DRAFT]: 'Brouillon',
  [FORM_STATUS.OPEN]: 'Ouvert',
  [FORM_STATUS.CLOSED]: 'Fermé',
});

function cleanText(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value.replace(/\r\n/g, '\n').trim().slice(0, maxLength);
}

function asStringArray(value) {
  if (Array.isArray(value)) return value.map((entry) => (typeof entry === 'string' ? entry : ''));
  if (typeof value === 'string' && value.length) return [value];
  return [];
}

function normalizeRoleId(value) {
  const roleId = cleanText(value, 20);
  return SNOWFLAKE_PATTERN.test(roleId) ? roleId : null;
}

/**
 * Reads the parallel question arrays posted by the builder. Row ids are kept so
 * the reorder/remove buttons can address a specific row.
 */
function parseQuestions(body) {
  const ids = asStringArray(body.question_id);
  const labels = asStringArray(body.question_label);
  const helps = asStringArray(body.question_help);
  const types = asStringArray(body.question_type);

  const count = Math.max(labels.length, ids.length, helps.length, types.length);
  const questions = [];
  for (let index = 0; index < count && questions.length < MAX_QUESTIONS; index += 1) {
    questions.push({
      id: ids[index] || null,
      label: cleanText(labels[index], 200),
      helpText: cleanText(helps[index], 500),
      fieldType: FIELD_TYPE_VALUES.includes(types[index]) ? types[index] : FIELD_TYPES.SHORT,
    });
  }
  return questions;
}

function moveQuestion(questions, questionId, direction) {
  const index = questions.findIndex((question) => String(question.id) === String(questionId));
  if (index === -1) return;
  const target = index + (MOVE_DIRECTIONS[String(direction)] ?? 1);
  if (target < 0 || target >= questions.length) return;
  [questions[index], questions[target]] = [questions[target], questions[index]];
}

/**
 * Applies the "Ajouter / Supprimer / Monter / Descendre" buttons. These are
 * structural actions: they must never be blocked by form validation, because the
 * creator still has to be able to add the very first question.
 *
 * Returns the mutated list plus the notice key so both the create and the
 * update route can share the exact same behaviour.
 */
function applyStructuralAction(action, move, questions) {
  if (action === 'add_question') {
    if (questions.length < MAX_QUESTIONS) {
      questions.push({ id: null, label: '', helpText: '', fieldType: FIELD_TYPES.SHORT });
      return { questions, notice: 'add_question' };
    }
    return { questions, notice: 'add_question' };
  }

  if (action.startsWith('remove_question:')) {
    const targetId = action.slice('remove_question:'.length);
    const index = questions.findIndex((question) => String(question.id) === targetId);
    if (index !== -1) questions.splice(index, 1);
    return { questions, notice: 'remove_question' };
  }

  if (move) {
    const [direction, questionId] = move.split(':');
    moveQuestion(questions, questionId, direction);
    return { questions, notice: 'move' };
  }

  return { questions, notice: null };
}

/**
 * The `id` must survive: `syncQuestions` relies on it to update a question in
 * place instead of deleting and re-inserting it. Responses are keyed by
 * question id, so dropping it here would silently detach every answer already
 * collected on the form.
 */
function toStoredQuestions(questions) {
  return questions.map((question) => ({
    id: question.id ?? null,
    label: question.label,
    helpText: question.helpText,
    fieldType: question.fieldType,
  }));
}

function describeForm(form) {
  return {
    ...form,
    statusLabel: FORM_STATUS_LABELS[form.status] || form.status,
  };
}

function describeResponse(response) {
  return {
    ...response,
    statusLabel: RESPONSE_STATUS_LABELS[response.status] || response.status,
    tone: RESPONSE_STATUS_TONES[response.status] || 'warning',
    createdLabel: formatDate(new Date(response.createdAt)),
  };
}

/**
 * « Candidatures » tab: readable by any connected member, writable only by the
 * forms role. Mounted at `/candidatures`, so every path below is relative.
 */
export function createFormsRouter({ pool, fetchFn } = {}) {
  const router = Router();

  router.use(requireAuth);

  // ---------------------------------------------------------------- Candidatures

  router.get('/', async (req, res) => {
    try {
      const userId = req.session.user.id;
      const [forms, ownForms] = await Promise.all([
        listPublishedForms(pool),
        listFormsByCreator(userId, pool),
      ]);
      const statusByForm = await Promise.all(
        forms.map(async (form) => {
          const accepted = await findAcceptedResponse(form.id, userId, pool);
          const pending = accepted ? null : await findPendingResponse(form.id, userId, pool);
          return { formId: form.id, accepted, pending };
        }),
      );

      const statusMap = new Map(statusByForm.map((entry) => [entry.formId, entry]));
      const isFormManager = hasFormsRole(req.memberData);

      res.render('forms', {
        title: 'Candidatures | Site-66',
        forms,
        ownForms: isFormManager ? ownForms.map(describeForm) : [],
        isFormManager,
        justSubmitted: req.query.envoyee === '1',
        submittedFormIds: new Set(
          forms
            .filter((form) => statusMap.get(form.id)?.pending)
            .map((form) => form.id),
        ),
        acceptedFormIds: new Set(
          forms
            .filter((form) => statusMap.get(form.id)?.accepted)
            .map((form) => form.id),
        ),
      });
    } catch (error) {
      console.error('[WebRoutes] Error loading forms:', error);
      res.status(500).render('error', {
        title: 'Erreur lors du chargement des candidatures',
        message: 'Impossible de charger les formulaires. Veuillez réessayer plus tard.',
      });
    }
  });

  router.post('/:formId/reponses', async (req, res) => {
    const formId = Number.parseInt(req.params.formId, 10);
    try {
      const form = await getFormById(formId, pool);
      if (!form || form.status !== FORM_STATUS.OPEN) {
        return res.status(404).render('error', {
          title: 'Formulaire indisponible',
          message: 'Ce formulaire n’est pas ouvert aux candidatures.',
        });
      }

      const userId = req.session.user.id;

      // An accepted candidature is final: the member is already in and must
      // not answer the same form again, whatever they do with the form.
      const accepted = await findAcceptedResponse(formId, userId, pool);
      if (accepted) {
        return res.status(409).render('form-fill', {
          title: `${form.title} | Candidatures`,
          form: describeForm(form),
          alreadySubmitted: true,
          alreadyAccepted: true,
          error: 'Votre candidature a déjà été acceptée sur ce formulaire.',
        });
      }

      const existing = await findPendingResponse(formId, userId, pool);
      if (existing) {
        return res.status(409).render('form-fill', {
          title: `${form.title} | Candidatures`,
          form: describeForm(form),
          alreadySubmitted: true,
          error: 'Vous avez déjà une candidature en attente sur ce formulaire.',
        });
      }

      const answers = {};
      const missing = [];
      for (const question of form.questions) {
        const value = cleanText(req.body?.[`answer_${question.id}`], MAX_ANSWER_LENGTH);
        if (!value) missing.push(question.label);
        answers[String(question.id)] = value;
      }

      if (missing.length) {
        return res.status(400).render('form-fill', {
          title: `${form.title} | Candidatures`,
          form: describeForm(form),
          answers,
          error: `Merci de répondre à toutes les questions (${missing.slice(0, 3).join(', ')}${missing.length > 3 ? '…' : ''}).`,
        });
      }

      const result = await submitResponse({
        formId,
        applicantDiscordId: userId,
        answers,
        pool,
      });

      if (result?.error === 'accepted') {
        return res.status(409).render('form-fill', {
          title: `${form.title} | Candidatures`,
          form: describeForm(form),
          alreadySubmitted: true,
          alreadyAccepted: true,
          error: 'Votre candidature a déjà été acceptée sur ce formulaire.',
        });
      }

      if (result?.error === 'pending') {
        return res.status(409).render('form-fill', {
          title: `${form.title} | Candidatures`,
          form: describeForm(form),
          alreadySubmitted: true,
          error: 'Vous avez déjà une candidature en attente sur ce formulaire.',
        });
      }

      if (!result?.responseId) {
        throw new Error('Insertion de la candidature sans identifiant.');
      }

      return res.redirect('/candidatures?envoyee=1');
    } catch (error) {
      console.error('[WebRoutes] Error submitting form response:', error);
      return res.status(500).render('error', {
        title: 'Erreur lors de l’envoi',
        message: 'Impossible d’enregistrer votre candidature. Veuillez réessayer plus tard.',
      });
    }
  });

  // ------------------------------------------------------------------- Builder

  router.get('/nouveau', requireFormsRole, async (req, res) => {
    try {
      await ensureFormsTables(pool);
      res.render('form-builder', {
        title: 'Nouveau formulaire | Candidatures',
        form: {
          id: null,
          title: '',
          description: '',
          grantedRoleId: null,
          status: FORM_STATUS.DRAFT,
          statusLabel: FORM_STATUS_LABELS[FORM_STATUS.DRAFT],
          questions: [{ id: null, label: '', helpText: '', fieldType: FIELD_TYPES.SHORT }],
        },
        isNew: true,
        error: null,
        notice: null,
        cooldownMinutes: 0,
        publishBlock: null,
      });
    } catch (error) {
      console.error('[WebRoutes] Error loading form builder:', error);
      res.status(500).render('error', {
        title: 'Erreur',
        message: 'Le créateur de formulaires est momentanément indisponible.',
      });
    }
  });

  router.post('/', requireFormsRole, async (req, res) => {
    const creatorDiscordId = req.session.user.id;
    const action = cleanText(req.body?.action, 64) || 'save';
    const move = cleanText(req.body?.move, 64);
    const title = cleanText(req.body?.title, 120);
    const description = cleanText(req.body?.description, 2000);
    const grantedRoleId = normalizeRoleId(req.body?.granted_role_id);
    const { questions, notice } = applyStructuralAction(action, move, parseQuestions(req.body));

    const renderBuilder = (error) => res.status(error ? 400 : 200).render('form-builder', {
      title: 'Nouveau formulaire | Candidatures',
      form: {
        id: null,
        title,
        description,
        grantedRoleId,
        status: FORM_STATUS.DRAFT,
        statusLabel: FORM_STATUS_LABELS[FORM_STATUS.DRAFT],
        questions,
      },
      isNew: true,
      error,
      notice: STRUCTURAL_NOTICES[notice] || null,
      cooldownMinutes: 0,
      publishBlock: null,
    });

    // "Ajouter une question" must work before the form exists, otherwise the
    // creator can never reach a state that can be saved.
    if (notice) return renderBuilder(null);

    const filledQuestions = questions.filter((question) => question.label);
    if (!title) return renderBuilder('Le titre du formulaire est obligatoire.');
    if (!filledQuestions.length) {
      return renderBuilder('Ajoutez au moins une question au formulaire.');
    }

    try {
      const created = await createForm({
        creatorDiscordId,
        title,
        description,
        grantedRoleId,
        questions: toStoredQuestions(filledQuestions),
        pool,
      });
      return res.redirect(`/candidatures/${created.id}`);
    } catch (error) {
      console.error('[WebRoutes] Error creating form:', error);
      return res.status(500).render('error', {
        title: 'Erreur',
        message: 'Impossible de créer le formulaire. Veuillez réessayer plus tard.',
      });
    }
  });

  router.get('/:formId', async (req, res) => {
    const formId = Number.parseInt(req.params.formId, 10);
    try {
      const form = await getFormById(formId, pool);
      if (!form) {
        return res.status(404).render('error', {
          title: 'Formulaire introuvable',
          message: 'Ce formulaire n’existe pas ou a été supprimé.',
        });
      }

      const userId = req.session.user.id;
      const isOwner = form.creatorDiscordId === userId;
      const roleNames = await fetchGuildRoleNames({ fetchFn });
      const formView = {
        ...describeForm(form),
        grantedRoleName: form.grantedRoleId ? (roleNames.get(form.grantedRoleId) || null) : null,
      };

      if (isOwner) {
        const cooldown = await getPublishCooldownRemaining(userId, webConfig.formsPublishCooldownMinutes, pool);
        return res.render('form-builder', {
          title: `${form.title} | Candidatures`,
          form: formView,
          isNew: false,
          error: null,
          notice: cleanText(req.query.enregistre, 200) || null,
          cooldownMinutes: webConfig.formsPublishCooldownMinutes,
          publishBlock: form.status === FORM_STATUS.OPEN ? null : cooldown,
        });
      }

      if (form.status !== FORM_STATUS.OPEN) {
        return res.status(404).render('error', {
          title: 'Formulaire indisponible',
          message: 'Ce formulaire n’est pas ouvert aux candidatures.',
        });
      }

      const accepted = await findAcceptedResponse(formId, userId, pool);
      if (accepted) {
        return res.render('form-fill', {
          title: `${form.title} | Candidatures`,
          form: formView,
          answers: {},
          alreadySubmitted: true,
          alreadyAccepted: true,
          error: null,
        });
      }

      const pending = await findPendingResponse(formId, userId, pool);
      return res.render('form-fill', {
        title: `${form.title} | Candidatures`,
        form: formView,
        answers: {},
        alreadySubmitted: Boolean(pending),
        error: null,
      });
    } catch (error) {
      console.error('[WebRoutes] Error loading form:', error);
      return res.status(500).render('error', {
        title: 'Erreur',
        message: 'Impossible de charger ce formulaire. Veuillez réessayer plus tard.',
      });
    }
  });

  router.post('/:formId', requireFormsRole, async (req, res) => {
    const formId = Number.parseInt(req.params.formId, 10);
    const creatorDiscordId = req.session.user.id;
    try {
      const existing = await getFormById(formId, pool);
      if (!existing || existing.creatorDiscordId !== creatorDiscordId) {
        return res.status(403).render('error', {
          title: 'Accès réservé',
          message: 'Seul le créateur de ce formulaire peut le gérer.',
        });
      }

      const action = cleanText(req.body?.action, 64) || 'save';
      const move = cleanText(req.body?.move, 64);
      const title = cleanText(req.body?.title, 120);
      const description = cleanText(req.body?.description, 2000);
      const grantedRoleId = normalizeRoleId(req.body?.granted_role_id);

      const isStructuralAction = action === 'add_question'
        || action.startsWith('remove_question:')
        || Boolean(move);
      let { questions, notice } = applyStructuralAction(action, move, parseQuestions(req.body));

      // On a plain save, rows still carrying the blank placeholder added by
      // "Ajouter une question" are dropped rather than blocking the creator.
      if (!isStructuralAction) questions = questions.filter((question) => question.label);

      const error = validateBuilderInput(isStructuralAction, title, questions);
      if (error) {
        return res.status(400).render('form-builder', {
          title: `${existing.title} | Candidatures`,
          form: { ...describeForm(existing), title, description, grantedRoleId, questions },
          isNew: false,
          error,
          notice: null,
          cooldownMinutes: webConfig.formsPublishCooldownMinutes,
          publishBlock: null,
        });
      }

      await updateForm({
        formId,
        creatorDiscordId,
        title,
        description,
        grantedRoleId,
        questions: toStoredQuestions(questions),
        pool,
      });

      const notices = {
        save: 'Formulaire enregistré.',
        ...STRUCTURAL_NOTICES,
      };

      return res.redirect(`/candidatures/${formId}?enregistre=${encodeURIComponent(notices[notice] || 'Formulaire enregistré.')}`);
    } catch (error) {
      console.error('[WebRoutes] Error updating form:', error);
      return res.status(500).render('error', {
        title: 'Erreur',
        message: 'Impossible d’enregistrer le formulaire. Veuillez réessayer plus tard.',
      });
    }
  });

  function validateBuilderInput(isStructuralAction, title, questions) {
    if (!title) return 'Le titre du formulaire est obligatoire.';
    if (isStructuralAction) return null;
    if (!questions.length) return 'Ajoutez au moins une question au formulaire.';
    return null;
  }

  router.post('/:formId/publier', requireFormsRole, async (req, res) => {
    const formId = Number.parseInt(req.params.formId, 10);
    const creatorDiscordId = req.session.user.id;
    try {
      const form = await getFormById(formId, pool);
      if (!form || form.creatorDiscordId !== creatorDiscordId) {
        return res.status(403).render('error', {
          title: 'Accès réservé',
          message: 'Seul le créateur de ce formulaire peut le publier.',
        });
      }
      if (!form.questions.length) {
        return res.status(400).render('error', {
          title: 'Publication impossible',
          message: 'Ajoutez au moins une question avant de publier ce formulaire.',
        });
      }

      const cooldown = await getPublishCooldownRemaining(
        creatorDiscordId,
        webConfig.formsPublishCooldownMinutes,
        pool,
      );
      if (cooldown > 0) {
        return res.status(429).render('error', {
          title: 'Publication limitée',
          message: `Vous pouvez publier un nouveau formulaire dans ${cooldown} minute${cooldown > 1 ? 's' : ''}.`,
        });
      }

      await setFormStatus({ formId, creatorDiscordId, status: FORM_STATUS.OPEN, pool });
      return res.redirect(`/candidatures/${formId}?enregistre=${encodeURIComponent('Formulaire publié.')}`);
    } catch (error) {
      console.error('[WebRoutes] Error publishing form:', error);
      return res.status(500).render('error', {
        title: 'Erreur',
        message: 'Impossible de publier le formulaire. Veuillez réessayer plus tard.',
      });
    }
  });

  router.post('/:formId/fermer', requireFormsRole, async (req, res) => {
    const formId = Number.parseInt(req.params.formId, 10);
    const creatorDiscordId = req.session.user.id;
    try {
      const form = await getFormById(formId, pool);
      if (!form || form.creatorDiscordId !== creatorDiscordId) {
        return res.status(403).render('error', {
          title: 'Accès réservé',
          message: 'Seul le créateur de ce formulaire peut le fermer.',
        });
      }
      await setFormStatus({ formId, creatorDiscordId, status: FORM_STATUS.CLOSED, pool });
      return res.redirect(`/candidatures/${formId}?enregistre=${encodeURIComponent('Formulaire fermé.')}`);
    } catch (error) {
      console.error('[WebRoutes] Error closing form:', error);
      return res.status(500).render('error', {
        title: 'Erreur',
        message: 'Impossible de fermer le formulaire. Veuillez réessayer plus tard.',
      });
    }
  });

  router.post('/:formId/supprimer', requireFormsRole, async (req, res) => {
    const formId = Number.parseInt(req.params.formId, 10);
    const creatorDiscordId = req.session.user.id;
    try {
      const removed = await deleteForm(formId, creatorDiscordId, pool);
      if (!removed) {
        return res.status(403).render('error', {
          title: 'Accès réservé',
          message: 'Seul le créateur de ce formulaire peut le supprimer.',
        });
      }
      return res.redirect('/candidatures');
    } catch (error) {
      console.error('[WebRoutes] Error deleting form:', error);
      return res.status(500).render('error', {
        title: 'Erreur',
        message: 'Impossible de supprimer le formulaire. Veuillez réessayer plus tard.',
      });
    }
  });

  return router;
}

/**
 * « Réponses » tab: the review inbox, reserved to the forms role from the very
 * first route. Mounted at `/reponses`. A manager only ever sees the responses
 * to the forms they created — the ownership filter lives in the SQL.
 */
export function createResponsesRouter({ pool, fetchFn } = {}) {
  const router = Router();

  router.use(requireFormsRole);

  router.get('/', async (req, res) => {
    try {
      const creatorDiscordId = req.session.user.id;
      const [forms, responses, pendingCount] = await Promise.all([
        listFormsByCreator(creatorDiscordId, pool),
        listResponsesByCreator(creatorDiscordId, pool),
        countResponsesByCreator(creatorDiscordId, pool),
      ]);
      const formMap = new Map(forms.map((form) => [form.id, form]));
      const filter = cleanText(req.query.statut, 20) || 'all';

      // Responses are grouped per form so the reviewer sees a per-form summary.
      const responsesByForm = new Map();
      for (const response of responses) {
        if (!formMap.has(response.formId)) continue;
        if (!responsesByForm.has(response.formId)) responsesByForm.set(response.formId, []);
        responsesByForm.get(response.formId).push(response);
      }

      const entries = forms.map((form) => {
        const all = responsesByForm.get(form.id) || [];
        const stats = {
          total: all.length,
          pending: all.filter((item) => item.status === RESPONSE_STATUS.PENDING).length,
          accepted: all.filter((item) => item.status === RESPONSE_STATUS.ACCEPTED).length,
          rejected: all.filter((item) => item.status === RESPONSE_STATUS.REJECTED).length,
        };
        const visible = filter === 'all' ? all : all.filter((item) => item.status === filter);
        return {
          form: describeForm(form),
          stats,
          responses: visible.map(describeResponse),
        };
      });

      res.render('responses', {
        title: 'Réponses | Site-66',
        entries,
        pendingCount,
        filter,
      });
    } catch (error) {
      console.error('[WebRoutes] Error loading responses:', error);
      res.status(500).render('error', {
        title: 'Erreur lors du chargement des réponses',
        message: 'Impossible de charger les candidatures reçues. Veuillez réessayer plus tard.',
      });
    }
  });

  router.get('/:responseId', async (req, res) => {
    try {
      const creatorDiscordId = req.session.user.id;
      const response = await getResponseById(
        Number.parseInt(req.params.responseId, 10),
        creatorDiscordId,
        pool,
      );
      if (!response) {
        return res.status(404).render('error', {
          title: 'Candidature introuvable',
          message: 'Cette candidature n’existe pas ou n’appartient pas à l’un de vos formulaires.',
        });
      }

      const [applicant, roleNames] = await Promise.all([
        fetchSiteUser(response.applicantDiscordId, pool),
        fetchGuildRoleNames({ fetchFn }),
      ]);

      return res.render('response-detail', {
        title: `Candidature · ${response.formTitle}`,
        response: {
          ...describeResponse(response),
          grantedRoleName: response.grantedRoleId ? (roleNames.get(response.grantedRoleId) || null) : null,
        },
        applicantName: applicant?.global_name || null,
        applicantUsername: applicant?.discord_username || null,
        applicantAvatarUrl: applicant?.avatar_url || null,
        notice: cleanText(req.query.info, 200) || null,
        warning: null,
      });
    } catch (error) {
      console.error('[WebRoutes] Error loading response detail:', error);
      return res.status(500).render('error', {
        title: 'Erreur',
        message: 'Impossible de charger cette candidature. Veuillez réessayer plus tard.',
      });
    }
  });

  router.post('/:responseId/:decision', async (req, res) => {
    const responseId = Number.parseInt(req.params.responseId, 10);
    const decision = DECISIONS[cleanText(req.params.decision, 20)];
    if (!decision) {
      return res.status(404).render('error', {
        title: 'Décision inconnue',
        message: 'Cette action de traitement est inconnue.',
      });
    }
    const creatorDiscordId = req.session.user.id;

    const response = await getResponseById(responseId, creatorDiscordId, pool);
    if (!response) {
      return res.status(404).render('error', {
        title: 'Candidature introuvable',
        message: 'Cette candidature n’existe pas ou n’appartient pas à l’un de vos formulaires.',
      });
    }
    if (response.status !== RESPONSE_STATUS.PENDING) {
      return res.status(409).render('error', {
        title: 'Candidature déjà traitée',
        message: `Cette candidature est déjà ${(RESPONSE_STATUS_LABELS[response.status] || '').toLowerCase()}.`,
      });
    }

    const warnings = [];
    let updated = null;

    try {
      if (decision === RESPONSE_STATUS.ACCEPTED) {
        // Claim the candidature first so a double click can never grant the
        // role or send the direct message twice.
        updated = await updateResponseStatus({
          responseId,
          creatorDiscordId,
          status: RESPONSE_STATUS.ACCEPTED,
          reviewerDiscordId: creatorDiscordId,
          pool,
        });
        if (!updated) {
          return res.redirect('/reponses');
        }

        if (response.grantedRoleId) {
          const roleResult = await grantGuildMemberRole({
            userId: response.applicantDiscordId,
            roleId: response.grantedRoleId,
            fetchFn,
          });
          if (!roleResult.ok) warnings.push(roleResult.error);
        }

        const applicant = await fetchSiteUser(response.applicantDiscordId, pool);
        const roleNames = await fetchGuildRoleNames({ fetchFn });
        const embed = createApplicationAcceptedEmbed({
          formTitle: response.formTitle,
          applicantName: applicant?.global_name || null,
          grantedRoleName: response.grantedRoleId
            ? (roleNames.get(response.grantedRoleId) || response.grantedRoleId)
            : null,
        });
        const dmResult = await sendDirectMessage({
          userId: response.applicantDiscordId,
          embeds: [embed],
          fetchFn,
        });
        if (!dmResult.ok) warnings.push(dmResult.error);
      } else {
        updated = await updateResponseStatus({
          responseId,
          creatorDiscordId,
          status: RESPONSE_STATUS.REJECTED,
          reviewerDiscordId: creatorDiscordId,
          pool,
        });
        if (!updated) {
          return res.redirect('/reponses');
        }
      }
    } catch (error) {
      console.error('[WebRoutes] Error processing response:', error);
      return res.status(500).render('error', {
        title: 'Erreur',
        message: 'Impossible de traiter cette candidature. Veuillez réessayer plus tard.',
      });
    }

    const [applicant, roleNames] = await Promise.all([
      fetchSiteUser(updated.applicantDiscordId, pool),
      fetchGuildRoleNames({ fetchFn }),
    ]);

    return res.render('response-detail', {
      title: `Candidature · ${updated.formTitle}`,
      response: {
        ...describeResponse(updated),
        grantedRoleName: updated.grantedRoleId ? (roleNames.get(updated.grantedRoleId) || null) : null,
      },
      applicantName: applicant?.global_name || null,
      applicantUsername: applicant?.discord_username || null,
      applicantAvatarUrl: applicant?.avatar_url || null,
      notice: decision === RESPONSE_STATUS.ACCEPTED
        ? 'Candidature acceptée.'
        : 'Candidature refusée.',
      warning: warnings.length
        ? `Décision enregistrée, mais : ${warnings.join(' ')}`
        : null,
    });
  });

  return router;
}
