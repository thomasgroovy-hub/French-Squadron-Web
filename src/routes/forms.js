import { Router } from 'express';
import { requireAuth } from '../auth/session.js';
import {
  canManageForm,
  canManageForms,
  formsOwnerScope,
  hasFormsAdminRole,
  requireFormsAccess,
  requireFormsAdmin,
} from '../auth/guards.js';
import { webConfig } from '../config.js';
import {
  FIELD_TYPES,
  FIELD_TYPE_VALUES,
  groupQuestionsIntoPages,
  isChoiceFieldType,
  MAX_OPTIONS_PER_QUESTION,
  MAX_OPTION_LENGTH,
  MAX_PAGES_PER_FORM,
  MAX_PAGE_TITLE_LENGTH,
  normalizeImageUrl,
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
  listAllForms,
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
  FORBIDDEN_GRANTABLE_ROLE_IDS,
  fetchGrantableGuildRoles,
  fetchGuildRoleNames,
  formatDate,
  grantGuildMemberRole,
  sendDirectMessage,
} from '../services/discord.js';
import { fetchSiteUser, fetchSiteUsersByIds } from '../services/members.js';
import { createApplicationAcceptedPayload } from '../services/embeds.js';

const MAX_QUESTIONS = 20;
const MAX_ANSWER_LENGTH = 4000;

/** The builder posts `move=up:<questionId>` / `move=down:<questionId>`. */
const MOVE_DIRECTIONS = Object.freeze({ up: -1, down: 1 });

const STRUCTURAL_NOTICES = Object.freeze({
  add_question: 'Question ajoutée.',
  add_page: 'Page ajoutée.',
  remove_page: 'Page supprimée, ses questions ont rejoint la page précédente.',
  remove_question: 'Question supprimée.',
  duplicate_question: 'Question dupliquée.',
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

/** Message unique affiché quand un rôle interdit est posté manuellement. */
const FORBIDDEN_ROLE_ERROR = 'Ce rôle ne peut pas être attribué automatiquement par un formulaire.';

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

/**
 * The builder posts one `question_option[][]` group per row, so the options of
 * question N live in `body.question_option[N]`. Rows that have no option group
 * yet (a question still typed as free text) must not shift the array, hence the
 * placeholder entry.
 */
function parseQuestionOptions(body, rowCount) {
  const groups = body?.question_option;
  const options = [];
  for (let index = 0; index < rowCount; index += 1) {
    const group = Array.isArray(groups?.[index]) ? groups[index] : [];
    const cleaned = group
      .map((entry) => cleanText(entry, 200))
      .filter(Boolean)
      .slice(0, 50);
    options.push([...new Set(cleaned)]);
  }
  return options;
}

function normalizeRoleId(value) {
  const roleId = cleanText(value, 20);
  if (!SNOWFLAKE_PATTERN.test(roleId)) return null;
  if (FORBIDDEN_GRANTABLE_ROLE_IDS.has(roleId)) return null;
  return roleId;
}

/**
 * Un rôle interdit est renvoyé tel quel par un POST manuel : le dire
 * explicitement vaut mieux qu'un silence, sinon le créateur croit avoir
 * enregistré un rôle alors que rien ne sera accordé à l'acceptation.
 */
function isForbiddenRoleId(value) {
  const roleId = cleanText(value, 20);
  return SNOWFLAKE_PATTERN.test(roleId) && FORBIDDEN_GRANTABLE_ROLE_IDS.has(roleId);
}

/**
 * Rôles proposables dans le select. Toujours appelé avant un rendu du builder.
 * Un échec Discord ne casse pas la page : la liste est simplement vide, et le
 * créateur est prévenu pour qu'il ne croie pas à une liste de rôles vide.
 */
async function loadGrantableRoles(fetchFn) {
  try {
    return { roles: await fetchGrantableGuildRoles({ fetchFn }), error: null };
  } catch (error) {
    console.error('[WebRoutes] Unable to load grantable roles:', error.message);
    return { roles: [], error: true };
  }
}

/**
 * Reads the parallel question arrays posted by the builder. Row ids are kept so
 * the reorder/remove buttons can address a specific row.
 *
 * `question_page[]` says which page each row belongs to, and `page_title[n]`
 * carries one title per page. The title is copied onto every question of the
 * page, which is the shape `resolveQuestionPages` expects.
 */
function parseQuestions(body) {
  const ids = asStringArray(body.question_id);
  const labels = asStringArray(body.question_label);
  const helps = asStringArray(body.question_help);
  const types = asStringArray(body.question_type);
  const images = asStringArray(body.question_image);
  const pages = asStringArray(body.question_page);
  const pageTitles = parsePageTitles(body.page_title);

  const count = Math.max(labels.length, ids.length, helps.length, types.length, images.length, pages.length);
  const optionGroups = parseQuestionOptions(body, count);
  const questions = [];
  for (let index = 0; index < count && questions.length < MAX_QUESTIONS; index += 1) {
    const fieldType = FIELD_TYPE_VALUES.includes(types[index]) ? types[index] : FIELD_TYPES.SHORT;
    const pagePosition = normalizePagePosition(pages[index]);
    questions.push({
      id: ids[index] || null,
      label: cleanText(labels[index], 200),
      helpText: cleanText(helps[index], 500),
      fieldType,
      options: optionGroups[index] || [],
      imageUrl: normalizeImageUrl(images[index]),
      pagePosition,
      pageTitle: pageTitles[pagePosition] || '',
    });
  }
  return questions;
}

/** `page_title[n]` arrive dans un objet indexé par des chaînes. */
function parsePageTitles(value) {
  if (!value || typeof value !== 'object') return [];
  const titles = [];
  for (const [key, entry] of Object.entries(value)) {
    const index = Number.parseInt(key, 10);
    if (!Number.isInteger(index) || index < 0) continue;
    titles[index] = cleanText(entry, MAX_PAGE_TITLE_LENGTH);
  }
  return titles;
}

/** Position de page normalisée : un index absent ou aberrant retombe sur 0. */
function normalizePagePosition(value) {
  const index = Number.parseInt(typeof value === 'string' ? value : '', 10);
  if (!Number.isInteger(index) || index < 0 || index >= MAX_PAGES_PER_FORM) return 0;
  return index;
}

/**
 * Reads one submitted answer in the shape its field type implies.
 *
 * A checkbox group posts an array, so a multiple choice is stored as a real
 * array in the `answers` JSON — no schema change needed. Returns `null` when
 * the question was left unanswered, which is what the "please answer
 * everything" check looks for.
 */
function readAnswer(raw, question) {
  if (question.fieldType === FIELD_TYPES.CHOICE_MULTIPLE) {
    const entries = asStringArray(raw)
      .map((entry) => cleanText(entry, MAX_ANSWER_LENGTH))
      .filter(Boolean);
    return entries.length ? entries : null;
  }
  // A single choice, a date and both free-text types all arrive as one string.
  // `express.urlencoded({ extended: true })` already turns `answer_7=1&answer_7=2`
  // into an array, which is coerced back to a single value here.
  const value = Array.isArray(raw) ? raw[0] : raw;
  const text = cleanText(value, MAX_ANSWER_LENGTH);
  return text || null;
}

/**
 * Cible d'une action de structure, telle que postée par le builder.
 *
 * Une question déjà enregistrée est visée par son id. Une question encore
 * nouvelle n'a pas d'id : le bouton envoie alors `row:<index>`, qui la désigne
 * sans ambiguïté puisque l'ordre du POST est celui affiché à l'écran.
 */
function resolveQuestionIndex(questions, target) {
  const raw = String(target ?? '').trim();
  if (raw.startsWith('row:')) {
    const index = Number.parseInt(raw.slice('row:'.length), 10);
    return Number.isInteger(index) && index >= 0 && index < questions.length ? index : -1;
  }
  return questions.findIndex((question) => question.id != null && String(question.id) === raw);
}

function moveQuestion(questions, questionTarget, direction) {
  const index = resolveQuestionIndex(questions, questionTarget);
  if (index === -1) return;
  const target = index + (MOVE_DIRECTIONS[String(direction)] ?? 1);
  if (target < 0 || target >= questions.length) return;
  // Un déplacement ne franchit pas une frontière de page : la question changerait
  // de page tout en gardant le titre de l'ancienne, et le formulaire se retrouverait
  // avec une page ne contenant qu'elle. Le builder désactive déjà ces boutons.
  if ((questions[target].pagePosition || 0) !== (questions[index].pagePosition || 0)) return;
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
/**
 * Une page est une portion de questions partageant `pagePosition`. Ajouter une
 * page revient donc à y placer une question neuve, et en supprimer une revient
 * à faire rejoindre la page précédente à ses questions : il n'y a pas de ligne
 * « page » à créer ou à retirer, seulement des questions à regrouper.
 */
function countPages(questions) {
  const positions = new Set(questions.map((question) => question.pagePosition || 0));
  return Math.max(positions.size, 1);
}

function removePage(questions, target) {
  const index = Number.parseInt(String(target ?? '').trim(), 10);
  if (!Number.isInteger(index) || index < 0) return questions;
  // Les pages sont identifiées par leur valeur, pas par leur rang : un
  // questionnaire dont les questions ne sont pas encore toutes remplies peut
  // avoir des positions non contiguës.
  const positions = [];
  for (const question of questions) {
    const position = question.pagePosition || 0;
    if (!positions.includes(position)) positions.push(position);
  }
  const removed = positions[index];
  if (removed === undefined) return questions;
  // La dernière page ne peut pas être supprimée : le formulaire en garderait
  // zéro, et il n'y aurait plus rien à afficher.
  const fallback = positions[index - 1] ?? 0;
  return questions.map((question) => (
    (question.pagePosition || 0) === removed ? { ...question, pagePosition: fallback } : question
  ));
}

/**
 * Insère une question neuve. `add_question:<pagePosition>` la place à la fin de
 * la page demandée, `add_question` la laisse à la fin du formulaire.
 */
function addQuestionTo(questions, pageTarget) {
  const question = {
    id: null,
    label: '',
    helpText: '',
    fieldType: FIELD_TYPES.SHORT,
    options: [],
    imageUrl: null,
    pagePosition: 0,
    pageTitle: '',
  };
  if (pageTarget === null) {
    questions.push(question);
    return;
  }
  // La liste est plate : insérer après la dernière question de la page suffit à
  // rattacher la nouvelle à cette page, l'ordre des pages étant celui du POST.
  let insertAt = -1;
  questions.forEach((existing, index) => {
    if ((existing.pagePosition || 0) === pageTarget) insertAt = index;
  });
  questions.splice(insertAt + 1, 0, { ...question, pagePosition: pageTarget });
}

function applyStructuralAction(action, move, questions) {
  if (action === 'add_question' || action.startsWith('add_question:')) {
    // Une page est délimitée par la valeur `pagePosition` des questions
    // voisines, pas par son rang : c'est cette valeur que le bouton envoie.
    const raw = action.slice('add_question'.length).replace(':', '');
    const pageTarget = raw ? Number.parseInt(raw, 10) : null;
    if (questions.length < MAX_QUESTIONS) {
      addQuestionTo(questions, Number.isInteger(pageTarget) ? pageTarget : null);
    }
    return { questions, notice: 'add_question' };
  }

  if (action === 'add_page') {
    if (questions.length < MAX_QUESTIONS && countPages(questions) < MAX_PAGES_PER_FORM) {
      const pagePosition = countPages(questions);
      questions.push({
        id: null,
        label: '',
        helpText: '',
        fieldType: FIELD_TYPES.SHORT,
        options: [],
        imageUrl: null,
        pagePosition,
        pageTitle: '',
      });
      return { questions, notice: 'add_page' };
    }
    return { questions, notice: 'add_page' };
  }

  if (action.startsWith('remove_page:')) {
    return { questions: removePage(questions, action.slice('remove_page:'.length)), notice: 'remove_page' };
  }

  if (action.startsWith('remove_question:')) {
    const index = resolveQuestionIndex(questions, action.slice('remove_question:'.length));
    if (index !== -1) questions.splice(index, 1);
    return { questions, notice: 'remove_question' };
  }

  // The copy is inserted with `id: null` so `syncQuestions` re-inserts it as a
  // brand new question: the original keeps its id, therefore the answers already
  // collected against it stay attached to the right question.
  if (action.startsWith('duplicate_question:')) {
    const index = resolveQuestionIndex(questions, action.slice('duplicate_question:'.length));
    if (index !== -1 && questions.length < MAX_QUESTIONS) {
      const source = questions[index];
      questions.splice(index + 1, 0, {
        id: null,
        label: source.label,
        helpText: source.helpText,
        fieldType: source.fieldType,
        options: [...(source.options || [])],
        imageUrl: source.imageUrl,
        pagePosition: source.pagePosition,
        pageTitle: source.pageTitle,
      });
    }
    return { questions, notice: 'duplicate_question' };
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
    options: isChoiceFieldType(question.fieldType) ? (question.options || []) : [],
    imageUrl: question.imageUrl || null,
    pagePosition: question.pagePosition || 0,
    pageTitle: question.pageTitle || '',
  }));
}

/** Squelette d'un formulaire vierge, partagé par le builder et l'import. */
function emptyDraftForm() {
  return {
    id: null,
    title: '',
    description: '',
    grantedRoleId: null,
    status: FORM_STATUS.DRAFT,
    statusLabel: FORM_STATUS_LABELS[FORM_STATUS.DRAFT],
    questions: [{
      id: null,
      label: '',
      helpText: '',
      fieldType: FIELD_TYPES.SHORT,
      options: [],
      imageUrl: null,
      pagePosition: 0,
      pageTitle: '',
    }],
  };
}

/**
 * Correspondance entre les types de questions Google et les nôtres.
 *
 * Ces codes sont ceux observés sur les pages `viewform` publiques. Un type sans
 * équivalent (échelle, grille, fichier, heure, étoiles) retombe sur `short` :
 * le libellé est conservé tel quel, donc rien n'est perdu, et le créateur
 * corrigera le type à la main.
 */
const GOOGLE_FORM_TYPE_MAP = Object.freeze({
  0: FIELD_TYPES.SHORT, // Réponse courte
  1: FIELD_TYPES.LONG, // Paragraphe
  2: FIELD_TYPES.CHOICE_SINGLE, // Choix multiple (boutons radio)
  3: FIELD_TYPES.CHOICE_SINGLE, // Liste déroulante
  4: FIELD_TYPES.CHOICE_MULTIPLE, // Cases à cocher
  9: FIELD_TYPES.DATE, // Date
});

/**
 * Codes de Google qui ne sont pas des questions.
 *
 * 6 (image) et 8 (titre de section) ne demandent pas de réponse mais ne sont pas
 * pour autant jetés : une image est rattachée à la question qui la suit, et un
 * titre de section ouvre une page — exactement la structure qu'un formulaire
 * Google utilise pour découper ses pages. 7 (vidéo) reste ignoré, faute de
 * champ vidéo côté candidat.
 */
const GOOGLE_FORM_IMAGE_TYPE = 6;
const GOOGLE_FORM_SECTION_TYPE = 8;

/** Extensions retenues pour une image : le CDN Google sert surtout du PNG/JPEG. */
const GOOGLE_FORM_IMAGE_PATTERN = /^https?:\/\/\S+\.(?:png|jpe?g|gif|webp)(?:\?\S*)?$/i;

const GOOGLE_FORM_IMPORT_WARNING = 'Import ponctuel : les futures modifications du Google Form ne seront pas répercutées ici.';

/**
 * Lit la structure d'un Google Form public depuis sa page HTML.
 *
 * Google expose ses données dans une variable JavaScript `FB_PUBLIC_LOAD_DATA_`
 *_assignée à un JSON. On l'extraît par regex puis on normalise : c'est le seul
 * point fragile de la fonctionnalité, d'où des messages d'erreur explicites
 * plutôt qu'une exception.
 */
export async function parseGoogleForm({ fetchFn = fetch, url } = {}) {
  const cleaned = cleanText(url, 500);
  let target;
  try {
    target = new URL(cleaned);
  } catch {
    return { error: 'Cette URL de Google Form est invalide.' };
  }
  // `forms.gle` et `docs.google.com/forms/...` sont les deux.point d'entrée.
  const isGoogleForm = /(^|\.)forms\.gle$/.test(target.hostname)
    || (target.hostname === 'docs.google.com' && target.pathname.includes('/forms/'));
  if (!isGoogleForm) {
    return { error: 'Seules les URL de Google Forms (forms.gle ou docs.google.com/forms) sont acceptées.' };
  }
  // L'URL d'édition n'est lisible qu_connecté : on renvoie une piste plutôt que
  // l'erreur « structure illisible » qui sortirait de la page de connexion.
  if (/\/edit(\.html)?$/.test(target.pathname)) {
    return {
      error: 'Cette URL est celle de l\'éditeur, lisible seulement par son auteur. Collez le lien de réponse (bouton « Publier », puis « Copier le lien »), qui ressemble à https://forms.gle/… ou se termine par /viewform.',
    };
  }

  let html;
  // `AbortSignal.timeout` laisserait un minuteur actif pendant dix secondes
  // après chaque import : on le coupe dès la réponse pour ne rien retenir.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetchFn(target.href, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FPCS-Site-66/1.0)' },
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        error: `Google a répondu ${response.status}. Vérifiez que le formulaire est bien public (accessible sans connexion).`,
      };
    }
    html = await response.text();
  } catch (error) {
    const reason = controller.signal.aborted ? 'délai dépassé' : error.message;
    return { error: `Impossible de joindre Google Forms (${reason}). Réessayez dans un instant.` };
  } finally {
    clearTimeout(timeout);
  }

  const loadData = extractGoogleFormLoadData(html);
  if (!loadData) {
    return {
      error: 'Structure du Google Form illisible. Google a probablement changé son format, ou le formulaire est privé.',
    };
  }

  const { title, description, questions } = normalizeGoogleFormQuestions(loadData);
  if (!questions.length) {
    return { error: 'Aucune question lisible dans ce Google Form. Le formulaire est peut-être vide.' };
  }

  return {
    title: title || 'Formulaire importé',
    description,
    questions,
    notice: `Import réussi : ${questions.length} question${questions.length > 1 ? 's' : ''} à relire avant d’enregistrer.`,
  };
}

/** Récupère le JSON assigné à `FB_PUBLIC_LOAD_DATA_` dans le HTML. */
function extractGoogleFormLoadData(html) {
  // Google a écrit `var FB_PUBLIC_LOAD_DATA_ =` puis
  // `window['FB_PUBLIC_LOAD_DATA_']=` : on accepte les deux écritures plutôt que
  // de dépendre des espaces autour du `=`.
  const assignment = /FB_PUBLIC_LOAD_DATA_\s*'?\]?\s*=\s*/.exec(html);
  if (!assignment) return null;
  const from = assignment.index + assignment[0].length;

  // La charge utile est un tableau imbriquant des objets. On parcourt le texte
  // en respectant les chaînes et les échappements plutôt qu'en cherchant un
  // `};`, qui peut apparaître dans une valeur.
  const OPENING = new Set(['{', '[']);
  const CLOSING = new Set(['}', ']']);
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = from; index < html.length; index += 1) {
    const char = html[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (OPENING.has(char)) {
      depth += 1;
    } else if (CLOSING.has(char)) {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(from, index + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Transforme la charge utile de Google en questions exploitables.
 *
 * Sur les pages `viewform` actuelles, tout est positionnel :
 * `loadData[1]` porte l'index `8` = titre, `0` = description, `1` = les items, et
 * chaque item est un tableau `[id, libellé, description, type, validation…]`. Les
 * pages plus anciennes servaient des objets à clés numériques, encore gérés ici
 * pour ne pas casser un formulaire déjà en cache.
 *
 * Les pages du Google Form sont reconstruites telles quelles : chaque titre de
 * section ouvre une page, et le contenu qui le précède forme la première. Un
 * Google Form sans section reste donc une page unique, comme avant.
 */
function normalizeGoogleFormQuestions(loadData) {
  const { title, description } = readGoogleFormMeta(loadData);
  const items = findGoogleFormItems(loadData);
  const questions = [];
  let pagePosition = 0;
  let pageTitle = '';
  // Une image Google est un objet à part entière : elle est conservée le temps de
  // rencontrer la question suivante, à laquelle elle sert d'illustration.
  let pendingImageUrl = null;

  for (const item of items) {
    if (!looksLikeGoogleFormItem(item)) continue;
    const itemType = googleItemType(item);

    if (itemType === GOOGLE_FORM_SECTION_TYPE) {
      if (pagePosition + 1 >= MAX_PAGES_PER_FORM) continue;
      const sectionTitle = cleanText(googleItemLabel(item), MAX_PAGE_TITLE_LENGTH);
      pagePosition += 1;
      pageTitle = sectionTitle;
      continue;
    }

    if (itemType === GOOGLE_FORM_IMAGE_TYPE) {
      if (!pendingImageUrl) pendingImageUrl = googleItemImageUrl(item);
      continue;
    }

    // Type 7 (vidéo) et tout code inconnu : rien à faire tant qu'aucun type
    // équivalent n'existe côté candidat.
    const fieldType = GOOGLE_FORM_TYPE_MAP[itemType] ?? FIELD_TYPES.SHORT;
    const isChoice = isChoiceFieldType(fieldType);
    const options = isChoice ? googleItemOptions(item) : [];
    const label = cleanText(googleItemLabel(item), 200);
    if (!label) continue;
    questions.push({
      id: null,
      label,
      helpText: cleanText(googleItemHelp(item), 500),
      // Un choix sans option n'est pas saisissable côté candidat : on retombe
      // sur un texte libre en gardant le libellé d'origine.
      fieldType: isChoice && !options.length ? FIELD_TYPES.SHORT : fieldType,
      options,
      imageUrl: pendingImageUrl,
      pagePosition,
      pageTitle,
    });
    pendingImageUrl = null;
    if (questions.length >= MAX_QUESTIONS) break;
  }

  return { title, description, questions };
}

/**
 * Cherche l'image d'un item Google.
 *
 * Google ne publie pas l'URL à une position fixe : elle est imbriquée selon la
 * version. On parcourt donc la structure et on retient la première URL qui
 * ressemble à une image, en bornant la profondeur pour ne pas descendre dans
 * une chaîne sans rapport.
 */
function googleItemImageUrl(item) {
  const found = findGoogleImageUrl(item, 0);
  return found ? normalizeImageUrl(found) : null;
}

function findGoogleImageUrl(node, depth) {
  if (node == null || depth > 6) return null;
  if (typeof node === 'string') {
    return GOOGLE_FORM_IMAGE_PATTERN.test(node.trim()) ? node.trim() : null;
  }
  const children = Array.isArray(node) ? node : (typeof node === 'object' ? Object.values(node) : []);
  for (const child of children) {
    const found = findGoogleImageUrl(child, depth + 1);
    if (found) return found;
  }
  return null;
}

/** Titre et description, lus à leur place puis repris depuis l'ancien format. */
function readGoogleFormMeta(loadData) {
  const root = Array.isArray(loadData?.[1]) ? loadData[1] : null;
  const formInfo = findGoogleFormFormInfo(loadData) || {};
  const rawTitle = root?.[8] ?? formInfo.formDescription?.[0] ?? formInfo.documentTitle?.[0];
  const rawDescription = root?.[0] ?? formInfo.formDescription?.[1];
  return {
    title: cleanText(firstGoogleText(rawTitle), 120),
    description: cleanText(firstGoogleText(rawDescription), 2000),
  };
}

/** Premier objet rencontré qui porte un `formInfo` (ancien format). */
function findGoogleFormFormInfo(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 4) return null;
  if (!Array.isArray(node) && node.formInfo) return node.formInfo;
  const children = Array.isArray(node) ? node : Object.values(node);
  for (const child of children) {
    const found = findGoogleFormFormInfo(child, depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * Un item de question, dans les deux formats rencontrés.
 *
 * Actuel : un tableau `[id, "Libellé", description, type, …]`.
 * Ancien : un objet `{ 1: [["Libellé"]], 3: type }`.
 * Dans les deux cas le type est un nombre en position 3 et le libellé est
 * imbriqué dans un nombre variable de tableaux.
 */
function looksLikeGoogleFormItem(value) {
  if (!value || typeof value !== 'object') return false;
  if (typeof value[3] !== 'number') return false;
  if (Array.isArray(value)) return typeof value[1] === 'string' || Array.isArray(value[1]);
  return Array.isArray(value[1]);
}

/** Premier tableau d'items de question. */
function findGoogleFormItems(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return [];
  if (Array.isArray(node) && node.length && node.some(looksLikeGoogleFormItem)) return node;
  const children = Array.isArray(node) ? node : Object.values(node);
  for (const child of children) {
    const found = findGoogleFormItems(child, depth + 1);
    if (found.length) return found;
  }
  return [];
}

/**
 * Google imbrique les textes un nombre variable de fois (`[["x"]]`, `["x"]`,
 * `"x"`). On descend jusqu'à la première chaîne.
 */
function firstGoogleText(value, depth = 0) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && depth < 4) {
    for (const entry of value) {
      const text = firstGoogleText(entry, depth + 1);
      if (text) return text;
    }
  }
  return '';
}

/** Code de type Google, identique dans les deux formats. */
function googleItemType(item) {
  return item?.[3];
}

/** Libellé : `item[1]`, une chaîne dans le format actuel, une imbrication sinon. */
function googleItemLabel(item) {
  return firstGoogleText(item?.[1]).trim();
}

/** Description d'une question : `item[2]` aujourd'hui, `item[1][2]` avant. */
function googleItemHelp(item) {
  if (typeof item?.[1] === 'string') return firstGoogleText(item[2]);
  return firstGoogleText(item?.[1]?.[2]);
}

/**
 * Options d'une question à choix.
 *
 * Aujourd'hui Google les range dans la validation : `item[4][0][1]`, chaque
 * option étant `["Texte", …, drapeau]`. L'ancien format les mettait
 * directement dans `item[4]`. On reconnaît la bonne liste par la présence
 * d'options lisibles, sinon un identifiant d'entrée (`[246314205, null, 1]`)
 * finirait importé comme une option.
 */
function googleItemOptions(item) {
  const validation = item?.[4];
  if (!Array.isArray(validation)) return [];
  const raw = isGoogleOptionList(validation[0]?.[1]) ? validation[0][1]
    : isGoogleOptionList(validation) ? validation
      : null;
  if (!raw) return [];

  const options = [];
  for (const entry of raw) {
    const option = googleOptionText(entry);
    if (!option || options.includes(option)) continue;
    options.push(option);
    if (options.length >= MAX_OPTIONS_PER_QUESTION) break;
  }
  return options;
}

/**
 * Texte d'une option, ou `null` si l'entrée n'en porte pas.
 *
 * `firstGoogleText` descend dans les tableaux imbriqués, ce qui couvre les
 * formats ancien et actuel d'un seul coup : une option dont le texte a gagné un
 * niveau d'imbrication est lue au lieu d'être rejetée — et c'est ce rejet, trop
 * strict, qui faisait retomber un QCM entier en texte libre. En revanche une
 * entrée d'identifiant numérique ne contient aucune chaîne, donc reste écartée.
 */
function googleOptionText(entry) {
  const text = firstGoogleText(Array.isArray(entry) ? entry[0] : entry).trim();
  if (text) return text.slice(0, MAX_OPTION_LENGTH);
  // Le drapeau final vaut 1 sur l'option « Autre », dont le libellé est vide
  // côté page : on la rebaptise pour ne pas la perdre.
  if (Array.isArray(entry) && entry[entry.length - 1] === 1) return 'Autre';
  return null;
}

/** Une liste d'options contient au moins un texte, jamais que des identifiants. */
function isGoogleOptionList(value) {
  return Array.isArray(value)
    && value.length > 0
    && value.some((entry) => googleOptionText(entry) !== null);
}

function describeForm(form) {
  return {
    ...form,
    statusLabel: FORM_STATUS_LABELS[form.status] || form.status,
    createdLabel: formatDate(new Date(form.createdAt)),
  };
}

/**
 * Ajoute le découpage en pages à un formulaire dont les questions sont en mémoire
 * (brouillon du builder, formulaire relu depuis la base).
 *
 * `groupQuestionsIntoPages` rend toujours au moins une page, y compris pour une
 * liste vide : le builder et l'aperçu ont ainsi la même coquille à afficher.
 */
function withPages(form) {
  return { ...form, pages: groupQuestionsIntoPages(form?.questions || []) };
}

/** Un formulaire chargé de la base, décrit et découpé en pages. */
function describeFormWithLayout(form) {
  return withPages(describeForm(form));
}

/**
 * Résout les identités Discord des créateurs en un seul aller-retour.
 *
 * Une candidature dont le candidat est inconnu de `site_users` doit rester
 * identifiable : on retombe alors sur l'identifiant brut.
 */
function describeIdentity(identity, discordId) {
  return {
    username: identity?.discord_username || discordId,
    displayName: identity?.global_name || null,
    avatarUrl: identity?.avatar_url || null,
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

  /**
   * Import ponctuel d'un Google Form.
   *
   * Ce n'est PAS une synchronisation : Google n'expose aucun webhook en lecture.
   * On récupère la structure une fois pour pré-remplir le créateur, et le
   * formulaire reste ensuite 100 % natif au site. Rien n'est écrit en base ici :
   * la sauvegarde passe par le flux `createForm` habituel, après relecture.
   */
  router.post('/importer-google-form', requireFormsAccess, async (req, res) => {
    const parsed = await parseGoogleForm({ fetchFn, url: req.body?.url });
    const { roles: grantableRoles, error: rolesLoadError } = await loadGrantableRoles(fetchFn);
    if (parsed.error) {
      return res.status(400).render('form-builder', {
        title: 'Nouveau formulaire | Candidatures',
        form: withPages(emptyDraftForm()),
        grantableRoles,
        rolesLoadError,
        isNew: true,
        error: parsed.error,
        notice: null,
        importWarning: null,
        cooldownMinutes: 0,
        publishBlock: null,
      });
    }

    return res.status(200).render('form-builder', {
      title: 'Nouveau formulaire | Candidatures',
      form: withPages({
        id: null,
        title: parsed.title,
        description: parsed.description,
        grantedRoleId: null,
        status: FORM_STATUS.DRAFT,
        statusLabel: FORM_STATUS_LABELS[FORM_STATUS.DRAFT],
        questions: parsed.questions,
      }),
      grantableRoles,
      rolesLoadError,
      isNew: true,
      error: null,
      notice: parsed.notice,
      // Rendus dans la même page : rien n'est encore enregistré, l'utilisateur
      // relit, ajuste, puis clique « Enregistrer » comme d'habitude.
      importWarning: GOOGLE_FORM_IMPORT_WARNING,
      cooldownMinutes: 0,
      publishBlock: null,
    });
  });

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
      const isFormManager = canManageForms(req.memberData);

      res.render('forms', {
        title: 'Candidatures | Site-66',
        forms,
        ownForms: isFormManager ? ownForms.map(describeForm) : [],
        isFormManager,
        // Only the administration roles get the transversal overview, so the
        // shortcut is rendered for them alone instead of for every manager.
        isFormsAdmin: hasFormsAdminRole(req.memberData),
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
        const answer = readAnswer(req.body?.[`answer_${question.id}`], question);
        if (answer === null) missing.push(question.label);
        answers[String(question.id)] = answer;
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

  router.get('/nouveau', requireFormsAccess, async (req, res) => {
    try {
      await ensureFormsTables(pool);
      const { roles: grantableRoles, error: rolesLoadError } = await loadGrantableRoles(fetchFn);
      res.render('form-builder', {
        title: 'Nouveau formulaire | Candidatures',
        form: withPages(emptyDraftForm()),
        grantableRoles,
        rolesLoadError,
        isNew: true,
        error: null,
        notice: null,
        importWarning: null,
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

  router.post('/', requireFormsAccess, async (req, res) => {
    const creatorDiscordId = req.session.user.id;
    const action = cleanText(req.body?.action, 64) || 'save';
    const move = cleanText(req.body?.move, 64);
    const title = cleanText(req.body?.title, 120);
    const description = cleanText(req.body?.description, 2000);
    const grantedRoleId = normalizeRoleId(req.body?.granted_role_id);
    const { questions, notice } = applyStructuralAction(action, move, parseQuestions(req.body));

    const renderBuilder = async (error) => {
      const { roles: grantableRoles, error: rolesLoadError } = await loadGrantableRoles(fetchFn);
      return res.status(error ? 400 : 200).render('form-builder', {
        title: 'Nouveau formulaire | Candidatures',
        form: withPages({
          id: null,
          title,
          description,
          grantedRoleId,
          status: FORM_STATUS.DRAFT,
          statusLabel: FORM_STATUS_LABELS[FORM_STATUS.DRAFT],
          questions,
        }),
        grantableRoles,
        rolesLoadError,
        isNew: true,
        error,
        notice: STRUCTURAL_NOTICES[notice] || null,
        // Un import n'est visible que le temps de l'écran de pré-remplissage :
        // dès que le formulaire est enregistré, il devient 100 % natif.
        importWarning: null,
        cooldownMinutes: 0,
        publishBlock: null,
      });
    };

    // Un rôle interdit posté à la main est refusé explicitement : l'ignorer
    // laisserait croire à un rôle enregistré alors que rien ne sera accordé.
    if (isForbiddenRoleId(req.body?.granted_role_id)) {
      return renderBuilder(FORBIDDEN_ROLE_ERROR);
    }

    // "Ajouter une question" must work before the form exists, otherwise the
    // creator can never reach a state that can be saved.
    if (notice) return renderBuilder(null);

    const filledQuestions = questions.filter((question) => question.label);
    if (!title) return renderBuilder('Le titre du formulaire est obligatoire.');
    if (!filledQuestions.length) {
      return renderBuilder('Ajoutez au moins une question au formulaire.');
    }
    const optionsError = validateQuestionOptions(filledQuestions);
    if (optionsError) return renderBuilder(optionsError);

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
      // An administration-role member is a manager of *every* form, not only of
      // the ones they created: they reach the builder whatever the status.
      const isAdmin = hasFormsAdminRole(req.memberData);
      const isAdminView = isAdmin && !isOwner;
      const [roleNames, creators] = await Promise.all([
        fetchGuildRoleNames({ fetchFn }),
        isAdminView ? fetchSiteUsersByIds([form.creatorDiscordId], pool) : Promise.resolve(new Map()),
      ]);
      const formView = describeFormWithLayout(form);
      formView.grantedRoleName = form.grantedRoleId ? (roleNames.get(form.grantedRoleId) || null) : null;

      if (canManageForm(req, form)) {
        // The publication cooldown is a per-creator anti-spam rule. It is
        // bypassed for the administration roles, in the builder as well as in
        // `POST /:formId/publier`, so the button is never shown disabled for a
        // publication the server would then accept.
        const [cooldown, roleLoad] = await Promise.all([
          isAdmin ? 0 : getPublishCooldownRemaining(userId, webConfig.formsPublishCooldownMinutes, pool),
          loadGrantableRoles(fetchFn),
        ]);
        return res.render('form-builder', {
          title: `${form.title} | Candidatures`,
          form: formView,
          grantableRoles: roleLoad.roles,
          rolesLoadError: roleLoad.error,
          isNew: false,
          isAdminView,
          // Un administrateur qui ouvre un formulaire d'autrui doit revenir à
          // l'onglet Administration, pas à la liste de ses propres candidatures.
          backTo: isAdminView ? '/administration/formulaires' : '/candidatures',
          formCreator: isAdminView ? describeIdentity(creators.get(form.creatorDiscordId), form.creatorDiscordId) : null,
          error: null,
          notice: cleanText(req.query.enregistre, 200) || null,
          importWarning: null,
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

  /**
   * Aperçu : exactement le rendu que verra le candidat, mais sans formulaire
   * postable et sans aucune écriture.
   *
   * Réservé à ceux qui peuvent gérer le formulaire (créateur ou rôle
   * d'administration) : c'est un outil de relecture, pas un canal de soumission.
   * Le gabarit rend un `<div>` au lieu d'un `<form>`, il n'y a donc aucun moyen de
   * poster depuis cette page, et aucune ligne n'est écrite quel que soit le
   * bouton pressé. Un brouillon reste consultable : c'est justement là que la
   * relecture est la plus utile.
   */
  router.get('/:formId/apercu', async (req, res) => {
    const formId = Number.parseInt(req.params.formId, 10);
    try {
      const form = await getFormById(formId, pool);
      if (!form) {
        return res.status(404).render('error', {
          title: 'Formulaire introuvable',
          message: 'Ce formulaire n’existe pas ou a été supprimé.',
        });
      }
      if (!canManageForm(req, form)) {
        return res.status(403).render('error', {
          title: 'Aperçu réservé',
          message: 'Seuls le créateur du formulaire et les rôles d’administration peuvent le prévisualiser.',
        });
      }

      const roleNames = await fetchGuildRoleNames({ fetchFn });
      return res.render('form-fill', {
        title: `Aperçu · ${form.title} | Candidatures`,
        form: {
          ...describeFormWithLayout(form),
          grantedRoleName: form.grantedRoleId ? (roleNames.get(form.grantedRoleId) || null) : null,
        },
        answers: {},
        alreadySubmitted: false,
        alreadyAccepted: false,
        isPreview: true,
        backUrl: `/candidatures/${form.id}`,
        error: null,
      });
    } catch (error) {
      console.error('[WebRoutes] Error loading the form preview:', error);
      return res.status(500).render('error', {
        title: 'Erreur',
        message: 'Impossible d’afficher l’aperçu de ce formulaire.',
      });
    }
  });

  router.post('/:formId', requireFormsAccess, async (req, res) => {
    const formId = Number.parseInt(req.params.formId, 10);
    const scope = formsOwnerScope(req);
    try {
      const existing = await getFormById(formId, pool);
      if (!existing || !canManageForm(req, existing)) {
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
        || action.startsWith('duplicate_question:')
        || Boolean(move);
      let { questions, notice } = applyStructuralAction(action, move, parseQuestions(req.body));

      // On a plain save, rows still carrying the blank placeholder added by
      // "Ajouter une question" are dropped rather than blocking the creator.
      if (!isStructuralAction) questions = questions.filter((question) => question.label);

      const forbiddenRole = isForbiddenRoleId(req.body?.granted_role_id);
      const error = forbiddenRole
        ? FORBIDDEN_ROLE_ERROR
        : validateBuilderInput(isStructuralAction, title, questions);
      if (error) {
        // The page is re-rendered for an administrator who is not the creator:
        // it must keep saying whose form it is, error or not.
        const isAdminView = scope.isAdmin && existing.creatorDiscordId !== scope.creatorDiscordId;
        const [roleLoad, creatorIdentity] = await Promise.all([
          loadGrantableRoles(fetchFn),
          isAdminView
            ? fetchSiteUsersByIds([existing.creatorDiscordId], pool)
            : Promise.resolve(new Map()),
        ]);
        return res.status(400).render('form-builder', {
          title: `${existing.title} | Candidatures`,
          form: withPages({
            ...describeForm(existing),
            title,
            description,
            grantedRoleId,
            grantedRoleName: existing.grantedRoleId ? (existing.grantedRoleName || null) : null,
            questions,
          }),
          grantableRoles: roleLoad.roles,
          rolesLoadError: roleLoad.error,
          isNew: false,
          isAdminView,
          backTo: isAdminView ? '/administration/formulaires' : '/candidatures',
          formCreator: isAdminView
            ? describeIdentity(creatorIdentity.get(existing.creatorDiscordId), existing.creatorDiscordId)
            : null,
          error,
          notice: null,
          importWarning: null,
          cooldownMinutes: webConfig.formsPublishCooldownMinutes,
          publishBlock: null,
        });
      }

      await updateForm({
        formId,
        creatorDiscordId: scope.creatorDiscordId,
        title,
        description,
        grantedRoleId,
        questions: toStoredQuestions(questions),
        // Dropping the creator predicate is what lets an admin edit somebody
        // else's form; it is derived from their Discord roles, never from the
        // request, so it cannot be asked for.
        includeAllForms: scope.includeAllForms,
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

  /**
   * Une question à choix sans option n'est pas saisissable côté candidat : le
   * select s'afficherait vide et personne ne pourrait répondre.
   */
  function validateQuestionOptions(questions) {
    const broken = questions.find((question) => (
      isChoiceFieldType(question.fieldType) && !(question.options || []).length
    ));
    if (!broken) return null;
    return `La question « ${broken.label} » doit proposer au moins une option.`;
  }

  function validateBuilderInput(isStructuralAction, title, questions) {
    if (!title) return 'Le titre du formulaire est obligatoire.';
    if (isStructuralAction) return null;
    if (!questions.length) return 'Ajoutez au moins une question au formulaire.';
    return validateQuestionOptions(questions);
  }

  router.post('/:formId/publier', requireFormsAccess, async (req, res) => {
    const formId = Number.parseInt(req.params.formId, 10);
    const scope = formsOwnerScope(req);
    try {
      const form = await getFormById(formId, pool);
      if (!form || !canManageForm(req, form)) {
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

      // Anti-spam on publication, per creator. Reopening someone else's form as
      // an admin does not spend the creator's quota, nor the admin's own.
      const cooldown = scope.isAdmin
        ? 0
        : await getPublishCooldownRemaining(
          scope.creatorDiscordId,
          webConfig.formsPublishCooldownMinutes,
          pool,
        );
      if (cooldown > 0) {
        return res.status(429).render('error', {
          title: 'Publication limitée',
          message: `Vous pouvez publier un nouveau formulaire dans ${cooldown} minute${cooldown > 1 ? 's' : ''}.`,
        });
      }

      await setFormStatus({
        formId,
        creatorDiscordId: scope.creatorDiscordId,
        status: FORM_STATUS.OPEN,
        includeAllForms: scope.includeAllForms,
        pool,
      });
      return res.redirect(`/candidatures/${formId}?enregistre=${encodeURIComponent('Formulaire publié.')}`);
    } catch (error) {
      console.error('[WebRoutes] Error publishing form:', error);
      return res.status(500).render('error', {
        title: 'Erreur',
        message: 'Impossible de publier le formulaire. Veuillez réessayer plus tard.',
      });
    }
  });

  router.post('/:formId/fermer', requireFormsAccess, async (req, res) => {
    const formId = Number.parseInt(req.params.formId, 10);
    const scope = formsOwnerScope(req);
    try {
      const form = await getFormById(formId, pool);
      if (!form || !canManageForm(req, form)) {
        return res.status(403).render('error', {
          title: 'Accès réservé',
          message: 'Seul le créateur de ce formulaire peut le fermer.',
        });
      }
      await setFormStatus({
        formId,
        creatorDiscordId: scope.creatorDiscordId,
        status: FORM_STATUS.CLOSED,
        includeAllForms: scope.includeAllForms,
        pool,
      });
      return res.redirect(`/candidatures/${formId}?enregistre=${encodeURIComponent('Formulaire fermé.')}`);
    } catch (error) {
      console.error('[WebRoutes] Error closing form:', error);
      return res.status(500).render('error', {
        title: 'Erreur',
        message: 'Impossible de fermer le formulaire. Veuillez réessayer plus tard.',
      });
    }
  });

  router.post('/:formId/supprimer', requireFormsAccess, async (req, res) => {
    const formId = Number.parseInt(req.params.formId, 10);
    const scope = formsOwnerScope(req);
    try {
      const form = await getFormById(formId, pool);
      if (!form || !canManageForm(req, form)) {
        return res.status(403).render('error', {
          title: 'Accès réservé',
          message: 'Seul le créateur de ce formulaire peut le supprimer.',
        });
      }
      const removed = await deleteForm(formId, scope.creatorDiscordId, pool, {
        includeAllForms: scope.includeAllForms,
      });
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
 * « Réponses » tab: the review inbox. A manager only ever sees the responses to
 * the forms they created — the ownership filter lives in the SQL. A member with
 * an administration role sees the whole site instead. Mounted at `/reponses`.
 */
export function createResponsesRouter({ pool, fetchFn } = {}) {
  const router = Router();

  router.use(requireFormsAccess);

  router.get('/', async (req, res) => {
    try {
      const scope = formsOwnerScope(req);
      const [forms, responses, pendingCount] = await Promise.all([
        listFormsByCreator(scope.creatorDiscordId, pool, { includeAllForms: scope.includeAllForms }),
        listResponsesByCreator(scope.creatorDiscordId, pool, { includeAllForms: scope.includeAllForms }),
        countResponsesByCreator(scope.creatorDiscordId, pool, { includeAllForms: scope.includeAllForms }),
      ]);
      const formMap = new Map(forms.map((form) => [form.id, form]));
      const filter = cleanText(req.query.statut, 20) || 'all';

      // `describeResponse` only decorates the status and the date, so the
      // Discord identity is resolved here in a single batch: the view reads
      // `username`, `displayName` and `avatarUrl`, which are never stored on
      // the response row itself.
      const identities = await fetchSiteUsersByIds(
        responses.map((response) => response.applicantDiscordId),
        pool,
      );

      // Responses are grouped per form so the reviewer sees a per-form summary.
      const responsesByForm = new Map();
      for (const response of responses) {
        if (!formMap.has(response.formId)) continue;
        if (!responsesByForm.has(response.formId)) responsesByForm.set(response.formId, []);
        responsesByForm.get(response.formId).push(response);
      }

      // On the global view the creator of each form is part of what the reviewer
      // is looking at: without it, an answer accepted from the wrong form would
      // be impossible to trace back.
      const creatorIdentities = scope.isAdmin
        ? await fetchSiteUsersByIds(forms.map((form) => form.creatorDiscordId), pool)
        : new Map();

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
          creator: scope.isAdmin
            ? describeIdentity(creatorIdentities.get(form.creatorDiscordId), form.creatorDiscordId)
            : null,
          stats,
          responses: visible.map((item) => {
            const identity = identities.get(item.applicantDiscordId);
            return {
              ...describeResponse(item),
              // A candidature whose applicant is unknown to `site_users` still
              // has to be identifiable, hence the raw id as last resort.
              username: identity?.discord_username || item.applicantDiscordId,
              displayName: identity?.global_name || null,
              avatarUrl: identity?.avatar_url || null,
            };
          }),
        };
      });

      res.render('responses', {
        title: 'Réponses | Site-66',
        entries,
        pendingCount,
        filter,
        isAdminView: scope.isAdmin,
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
      const scope = formsOwnerScope(req);
      const response = await getResponseById(
        Number.parseInt(req.params.responseId, 10),
        scope.creatorDiscordId,
        pool,
        { includeAllForms: scope.includeAllForms },
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
        formCreatorDiscordId: response.formCreatorId || null,
        isAdminView: scope.isAdmin && response.formCreatorId !== scope.creatorDiscordId,
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
    const scope = formsOwnerScope(req);
    // The reviewer recorded in the audit trail is always the connected user,
    // never the form's creator: an admin accepting on someone's behalf must be
    // traceable as themselves.
    const reviewerDiscordId = scope.creatorDiscordId;

    const response = await getResponseById(responseId, scope.creatorDiscordId, pool, {
      includeAllForms: scope.includeAllForms,
    });
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
          creatorDiscordId: scope.creatorDiscordId,
          status: RESPONSE_STATUS.ACCEPTED,
          reviewerDiscordId,
          includeAllForms: scope.includeAllForms,
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
        const payload = createApplicationAcceptedPayload({
          formTitle: response.formTitle,
          applicantName: applicant?.global_name || null,
          grantedRoleName: response.grantedRoleId
            ? (roleNames.get(response.grantedRoleId) || response.grantedRoleId)
            : null,
        });
        const dmResult = await sendDirectMessage({
          userId: response.applicantDiscordId,
          payload,
          fetchFn,
        });
        if (!dmResult.ok) warnings.push(dmResult.error);
      } else {
        updated = await updateResponseStatus({
          responseId,
          creatorDiscordId: scope.creatorDiscordId,
          status: RESPONSE_STATUS.REJECTED,
          reviewerDiscordId,
          includeAllForms: scope.includeAllForms,
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
        // The answer belongs to somebody else's form when an admin reviews it:
        // the page says so instead of implying the reader created the form.
        formCreatorDiscordId: updated.formCreatorId || null,
        isAdminView: scope.isAdmin && updated.formCreatorId !== reviewerDiscordId,
      });
    });

  return router;
}

/**
 * « Administration » des formulaires : the transversal overview, reserved to the
 * forms administration roles from the very first route. Mounted at
 * `/administration/formulaires`.
 *
 * Every row exposes what the owner of a form sees plus the creator and the
 * response counters, and reuses the very same action endpoints as the builder —
 * no admin-only write route, so there is a single server-side permission check
 * per action rather than two that could drift apart.
 */
export function createFormsAdminRouter({ pool, fetchFn } = {}) {
  const router = Router();

  router.use(requireAuth, requireFormsAdmin);

  router.get('/formulaires', async (req, res) => {
    try {
      const forms = await listAllForms(pool);
      const scope = formsOwnerScope(req);
      // One batched read for the whole page: the review inbox already does this
      // for applicants, and a form list without creator names would be unusable.
      const creators = await fetchSiteUsersByIds(forms.map((form) => form.creatorDiscordId), pool);
      const [roleNames, statusCounts] = await Promise.all([
        fetchGuildRoleNames({ fetchFn }),
        countFormsByStatus(pool),
      ]);

      res.render('forms-admin', {
        title: 'Administration des formulaires | Site-66',
        isAdminView: true,
        entries: forms.map((form) => ({
          form: describeForm(form),
          creator: describeIdentity(creators.get(form.creatorDiscordId), form.creatorDiscordId),
          isOwnForm: form.creatorDiscordId === scope.creatorDiscordId,
          grantedRoleName: form.grantedRoleId ? (roleNames.get(form.grantedRoleId) || null) : null,
        })),
        totals: {
          ...statusCounts,
          all: forms.length,
          responses: forms.reduce((total, form) => total + form.responseCount, 0),
          pending: forms.reduce((total, form) => total + form.pendingCount, 0),
        },
      });
    } catch (error) {
      console.error('[WebRoutes] Error loading the forms administration overview:', error);
      res.status(500).render('error', {
        title: 'Erreur lors du chargement des formulaires',
        message: 'Impossible de charger la vue d’administration. Veuillez réessayer plus tard.',
      });
    }
  });

  return router;
}

/**
 * Head counters for the administration overview. `FORM_SELECT` already carries
 * the response sub-counts, so this only needs the status breakdown; it degrades
 * to zeros rather than failing the whole page.
 */
async function countFormsByStatus(pool) {
  const counts = {
    open: 0,
    closed: 0,
    draft: 0,
  };
  if (!pool) return counts;
  try {
    await ensureFormsTables(pool);
    const [rows] = await pool.execute('SELECT status, COUNT(*) AS total FROM forms GROUP BY status');
    for (const row of rows || []) {
      if (row?.status in counts) counts[row.status] = Number(row.total || 0);
    }
  } catch (error) {
    console.error('[WebRoutes] Unable to count forms per status:', error.message);
  }
  return counts;
}
